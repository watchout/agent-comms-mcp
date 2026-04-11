#!/bin/bash
# scripts/polling-driver.sh
# message-queue-spec v1.0.2 §6.5.2 — Non-push CLI Polling Driver
#
# Monitors message_queue for non-push CLIs (Codex / Gemini) running in
# interactive mode inside a tmux session. When pending messages are found,
# sends a tmux send-keys instruction telling the LLM to call next.
#
# Usage:
#   ./scripts/polling-driver.sh <agent_id> <tmux_session_name> [interval_sec]
#
# Claude Code does NOT need this — it receives push signals natively.

set -euo pipefail

AGENT_ID="${1:?Usage: polling-driver.sh <agent_id> <tmux_session> [interval]}"
TMUX_SESSION="${2:?Usage: polling-driver.sh <agent_id> <tmux_session> [interval]}"
INTERVAL="${3:-30}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
if [ -f "$REPO_ROOT/cli/index.ts" ]; then
  AGENT_COM="bun $REPO_ROOT/cli/index.ts"
else
  AGENT_COM="agent-com"
fi

echo "[polling-driver] Started for ${AGENT_ID}, session=${TMUX_SESSION}, interval=${INTERVAL}s"

while true; do
  AGENT_ID="$AGENT_ID" $AGENT_COM heartbeat 2>/dev/null || true

  PENDING=$(AGENT_ID="$AGENT_ID" $AGENT_COM status --format json 2>/dev/null \
    | grep -o '"pending":[0-9]*' | grep -o '[0-9]*') || PENDING=0

  if [ "$PENDING" != "0" ] && [ "$PENDING" != "" ]; then
    echo "[polling-driver] ${AGENT_ID}: ${PENDING} pending messages, sending instruction"
    tmux send-keys -t "$TMUX_SESSION" \
      "メッセージが${PENDING}件届いています。mcp__agent_comms__next を実行して確認・対応してください。" Enter
    sleep "$((INTERVAL * 2))"
  else
    sleep "$INTERVAL"
  fi
done
