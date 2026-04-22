#!/bin/bash
# rollback-bot.sh — Revert a bot from hybrid runtime to the legacy
# Claude Code tmux session, per iyasaka-arc spec §2.5.
#
# Usage:
#   ./scripts/rollback-bot.sh <bot-id>
#
# Effect:
#   - Kill both hybrid sessions (discord-<bot>-gw, discord-<bot>-runbot)
#   - Recreate the single legacy session (SESSION from bot-registry.txt,
#     e.g. discord-webb) with the canonical `claude --mcp-config .mcp.json`
#     command from restart-bot.sh DEFAULT_CMD.
set -euo pipefail

BOT_ID="${1:?Usage: rollback-bot.sh <bot-id>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
[ -f "$REGISTRY" ] || { echo "ERROR: $REGISTRY not found" >&2; exit 1; }

REGISTRY_LINE=$(awk -F'|' -v id="$BOT_ID" '!/^#/ && $3==id {print; exit}' "$REGISTRY")
[ -n "$REGISTRY_LINE" ] || { echo "ERROR: bot '$BOT_ID' not in $REGISTRY" >&2; exit 1; }

IFS='|' read -r SESSION PROJECT_DIR _AGENT_ID PORT CLAUDE_CMD <<< "$REGISTRY_LINE"
BOT_DIR="${PROJECT_DIR/#\~/$HOME}"
[ -d "$BOT_DIR" ] || { echo "ERROR: PROJECT_DIR '$BOT_DIR' does not exist" >&2; exit 1; }

LEGACY_SESSION="$SESSION"
GW_SESSION="discord-${BOT_ID}-gw"
RUNBOT_SESSION="discord-${BOT_ID}-runbot"

echo "[rollback-bot] $BOT_ID: killing hybrid sessions"
tmux kill-session -t "$GW_SESSION"     2>/dev/null || true
tmux kill-session -t "$RUNBOT_SESSION" 2>/dev/null || true

# also drop any orphan MCP server process still listening on the port
if [ -n "$PORT" ]; then
  OLD_PID=$(lsof -i :"$PORT" -t 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    echo "[rollback-bot] $BOT_ID: killing orphan on port $PORT (PID $OLD_PID)"
    kill "$OLD_PID" 2>/dev/null || true
  fi
fi

sleep 2

# also clear the legacy session name in case it survived
tmux kill-session -t "$LEGACY_SESSION" 2>/dev/null || true

# Use the registry-provided COMMAND if present, else fall back to the
# restart-bot.sh default (post-PR #227: no phantom `server:agent-comms`).
CMD="${CLAUDE_CMD:-claude --mcp-config .mcp.json --dangerously-skip-permissions}"

echo "[rollback-bot] $BOT_ID: launching legacy session '$LEGACY_SESSION'"
tmux new-session -d -s "$LEGACY_SESSION" -c "$BOT_DIR"
tmux send-keys -t "$LEGACY_SESSION" "$CMD" Enter

# wait for the TUI to boot and auto-confirm any initial prompt
sleep 3
tmux send-keys -t "$LEGACY_SESSION" Enter

echo "[rollback-bot] $BOT_ID: rolled back to legacy session '$LEGACY_SESSION' in $BOT_DIR"
