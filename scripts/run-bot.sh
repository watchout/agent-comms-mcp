#!/bin/bash
# run-bot.sh — LLM-agnostic event-driven bot runner (spec §5.3 / §13.5.1).
#
# Writes a PID file at /tmp/agent-com-${AGENT_ID}.pid, traps SIGUSR1, then
# loops calling the `next` CLI. Each iteration:
#   1. call `next` — if waiting > 0, emit the JSON to stdout (caller pipes
#      it into an LLM or consumer as needed)
#   2. if a signal arrived during the fetch/emit, skip the sleep
#   3. otherwise start a background `sleep` and `wait` on it. When SIGUSR1
#      fires, the trap sets SIGNAL_RECEIVED=1 and `wait` returns
#      (interrupted). The fall-through timeout acts as the polling
#      fallback described in spec §13.5.1.
#
# The trap flag is the structural fix for the lost-wake-up window the
# auditor flagged in PR #217 cycle 1: a SIGUSR1 that arrives while `next`
# is running (or between iterations) is now remembered and consumed on
# the next check instead of being silently dropped.
#
# Usage: ./scripts/run-bot.sh <agent-id>
#
# Environment:
#   AGENT_COM_BUS_WAIT_SECONDS — fallback polling interval (default 30)
#
# Signals:
#   SIGUSR1 — wake up and pull via `next` (flag-tracked, no lost wake-up)
#   EXIT    — remove PID file
set -euo pipefail

AGENT_ID="${1:?Usage: run-bot.sh <agent-id>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="/tmp/agent-com-${AGENT_ID}.pid"
WAIT_SECONDS="${AGENT_COM_BUS_WAIT_SECONDS:-30}"

echo $$ > "$PID_FILE"

# Flag-tracked SIGUSR1. Without the flag, a signal that arrives while
# `next` is in flight (or after `echo` but before `sleep`) would fire the
# trap body and be forgotten — the loop would then block on sleep for the
# full polling interval even though a message was already waiting.
SIGNAL_RECEIVED=0
trap 'SIGNAL_RECEIVED=1' USR1
trap 'rm -f "$PID_FILE"' EXIT

echo "[run-bot] ${AGENT_ID} started (PID $$, event-driven, wait=${WAIT_SECONDS}s)"

while true; do
  msg=$(AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" next 2>/dev/null || echo '{"waiting":0}')
  waiting=$(echo "$msg" | (command -v jq >/dev/null && jq -r '.waiting // 0') 2>/dev/null || echo 0)

  if [ "${waiting:-0}" != "0" ]; then
    echo "[run-bot] message received (waiting=${waiting}), emitting to stdout"
    echo "$msg"
  fi

  # If SIGUSR1 fired during the fetch/emit above, skip the sleep entirely
  # and go straight to another `next` tick. This closes the lost-wake-up
  # window the auditor flagged in cycle 1.
  if [ "$SIGNAL_RECEIVED" = "1" ]; then
    SIGNAL_RECEIVED=0
    continue
  fi

  # Background sleep so SIGUSR1 can interrupt `wait` (a foreground `sleep`
  # is not interrupted by trapped signals in bash). On timeout the wait
  # returns 0; on signal the trap sets SIGNAL_RECEIVED=1 and the wait
  # returns non-zero (interrupted). Either way we loop back.
  sleep "$WAIT_SECONDS" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true

  if [ "$SIGNAL_RECEIVED" = "1" ]; then
    # Wait was interrupted by SIGUSR1. Kill the pending sleep (it's still
    # alive because `wait` returned early) and reset the flag for the
    # next iteration.
    kill "$SLEEP_PID" 2>/dev/null || true
    wait "$SLEEP_PID" 2>/dev/null || true
    SIGNAL_RECEIVED=0
  fi
done
