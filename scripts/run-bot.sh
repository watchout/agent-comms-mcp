#!/bin/bash
# run-bot.sh — LLM-agnostic event-driven bot runner (spec §5.3 / §13.5.1).
#
# End-to-end flow (spec §5.3, PR #218):
#   1. Write PID file, install SIGUSR1 trap (flag-tracked), install EXIT trap
#   2. Wait for SIGUSR1 (or the polling timeout, whichever fires first)
#   3. Call `agent-com next` → if waiting > 0 extract content / reply_chain /
#      message_id / from from the JSON
#   4. Feed the context into $LLM_CMD (default: `claude --print`)
#   5. If the LLM produced any output, reply via `agent-com send` with
#      --reply-to + --mentions (reply_to is also carried implicitly via
#      agents.current_message_id, but we pass it explicitly per spec §5.3)
#   6. Loop back to 2
#
# Error handling (spec §5.3):
#   - next 失敗          → treat as `{"waiting":0}`, continue loop
#   - LLM 失敗           → skip send; next iteration's `next` implicit-skips
#                           the unreplied row (§4.1 step 1)
#   - send 失敗          → non-fatal, loop continues
#   - signal 不達        → polling fallback (AGENT_COM_BUS_WAIT_SECONDS, 30s)
#
# The trap flag is the structural fix for the lost-wake-up window the
# auditor flagged in PR #217 cycle 1: a SIGUSR1 that arrives while `next`
# / LLM / send is running is now remembered and consumed on the next
# check instead of being silently dropped.
#
# Usage:
#   LLM_CMD="claude --print" ./scripts/run-bot.sh <agent-id>
#   LLM_CMD="codex --quiet"  ./scripts/run-bot.sh <agent-id>
#   LLM_CMD="echo test"      ./scripts/run-bot.sh <agent-id>   # smoke-test
#
# Environment:
#   LLM_CMD                    — LLM CLI command (default: claude --print)
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
LLM_CMD="${LLM_CMD:-claude --print}"

echo $$ > "$PID_FILE"

# Flag-tracked SIGUSR1 (PR #217 cycle 2 BLOCKER fix). Without the flag, a
# signal that arrives while `next` / LLM / send is in flight (or between
# iterations) would fire the trap body and be forgotten — the loop would
# then block on sleep for the full polling interval even though a message
# was already waiting.
SIGNAL_RECEIVED=0
trap 'SIGNAL_RECEIVED=1' USR1
trap 'rm -f "$PID_FILE"' EXIT

echo "[run-bot] ${AGENT_ID} started (PID $$, LLM=${LLM_CMD}, wait=${WAIT_SECONDS}s)"

while true; do
  msg=$(AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" next 2>/dev/null || echo '{"waiting":0}')
  waiting=$(echo "$msg" | (command -v jq >/dev/null && jq -r '.waiting // 0') 2>/dev/null || echo 0)

  if [ "${waiting:-0}" != "0" ]; then
    content=$(echo "$msg" | jq -r '.content // ""')
    reply_chain=$(echo "$msg" | jq -r '.reply_chain // "[]"')
    message_id=$(echo "$msg" | jq -r '.message_id // ""')
    from=$(echo "$msg" | jq -r '.from // ""')

    echo "[run-bot] message from ${from} (waiting=${waiting})"

    # Step 4: LLM invocation. `$LLM_CMD` is deliberately unquoted so it
    # expands into argv tokens (so `claude --print` works without `sh -c`).
    context="From: ${from}\nReply chain: ${reply_chain}\n\nMessage: ${content}"
    response=$(echo -e "$context" | $LLM_CMD 2>/dev/null || echo "")

    # Step 5: reply via `agent-com send`. reply_to is also auto-picked up
    # from agents.current_message_id, but passing it explicitly keeps the
    # shell invocation self-documenting per spec §5.3.
    if [ -n "$response" ]; then
      AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" send \
        --content "$response" \
        --reply-to "$message_id" \
        --mentions "$from" 2>/dev/null || true
      echo "[run-bot] replied to ${from}"
    else
      echo "[run-bot] LLM failed, skipping (next call will implicit-skip)"
    fi
  fi

  # If SIGUSR1 fired during the fetch / LLM / send above, skip the sleep
  # entirely and go straight to another `next` tick. This closes the
  # lost-wake-up window the auditor flagged in PR #217 cycle 1.
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
    # alive because `wait` returned early) and reset the flag.
    kill "$SLEEP_PID" 2>/dev/null || true
    wait "$SLEEP_PID" 2>/dev/null || true
    SIGNAL_RECEIVED=0
  fi
done
