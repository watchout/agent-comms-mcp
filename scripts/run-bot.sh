#!/bin/bash
# run-bot.sh — LLM-agnostic event-driven bot runner (spec §5.3 / §13.5.1).
#
# Writes a PID file at /tmp/agent-com-${AGENT_ID}.pid, traps SIGUSR1, then
# loops calling the `next` CLI. Each iteration:
#   1. call `next` — if waiting > 0, emit the JSON to stdout (caller pipes
#      it into an LLM or consumer as needed)
#   2. block until SIGUSR1 arrives or the sleep timeout fires
# SIGUSR1 interrupts the sleep so a new message delivers immediately;
# the timeout acts as the polling fallback when the signal is lost.
#
# Usage: ./scripts/run-bot.sh <agent-id>
#
# Environment:
#   AGENT_COM_BUS_WAIT_SECONDS — fallback polling interval (default 30)
#
# Signals:
#   SIGUSR1 — wake up and pull via `next`
#   EXIT    — remove PID file
set -euo pipefail

AGENT_ID="${1:?Usage: run-bot.sh <agent-id>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="/tmp/agent-com-${AGENT_ID}.pid"
WAIT_SECONDS="${AGENT_COM_BUS_WAIT_SECONDS:-30}"

echo $$ > "$PID_FILE"
trap 'true' USR1
trap 'rm -f "$PID_FILE"' EXIT

echo "[run-bot] ${AGENT_ID} started (PID $$, event-driven, wait=${WAIT_SECONDS}s)"

while true; do
  msg=$(AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" next 2>/dev/null || echo '{"waiting":0}')
  waiting=$(echo "$msg" | (command -v jq >/dev/null && jq -r '.waiting // 0') 2>/dev/null || echo 0)

  if [ "${waiting:-0}" != "0" ]; then
    echo "[run-bot] message received (waiting=${waiting}), emitting to stdout"
    echo "$msg"
  fi

  # SIGUSR1 interrupts the sleep via the trap; fall-through timeout acts
  # as the polling fallback described in spec §13.5.1.
  sleep "$WAIT_SECONDS" &
  wait $! 2>/dev/null || true
done
