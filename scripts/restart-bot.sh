#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session using bot-registry.txt
# Usage: ./scripts/restart-bot.sh <session-name>
# Example: ./scripts/restart-bot.sh discord-haishin
# If session not found in registry, falls back to manual args:
#   ./scripts/restart-bot.sh <session-name> <project-dir> [port] [command]

set -euo pipefail

SESSION="${1:?Usage: restart-bot.sh <session-name> [project-dir] [port] [command]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
DEFAULT_CMD="claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions"

# Try to resolve from registry
if [ -f "$REGISTRY" ]; then
  REGISTRY_LINE=$(grep "^${SESSION}|" "$REGISTRY" 2>/dev/null || true)
fi

if [ -n "${REGISTRY_LINE:-}" ]; then
  IFS='|' read -r _SESSION PROJECT_DIR _AGENT_ID PORT CLAUDE_CMD <<< "$REGISTRY_LINE"
  CLAUDE_CMD="${CLAUDE_CMD:-$DEFAULT_CMD}"
else
  # Fallback to positional args
  PROJECT_DIR="${2:?Session not in registry. Usage: restart-bot.sh <session> <project-dir> [port] [command]}"
  PORT="${3:-}"
  CLAUDE_CMD="${4:-$DEFAULT_CMD}"
fi

echo "[restart-bot] Restarting ${SESSION}..."
echo "[restart-bot] Command: ${CLAUDE_CMD}"

# Step 1: Kill orphaned MCP process on port
if [ -n "${PORT:-}" ]; then
  OLD_PID=$(lsof -i :"$PORT" -t 2>/dev/null || true)
  if [ -n "$OLD_PID" ]; then
    echo "[restart-bot] Killing orphaned MCP process PID ${OLD_PID} on port ${PORT}"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
fi

# Step 2: Kill tmux session
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 1

# Step 3: Create new session and start Claude Code
PROJECT_DIR_EXPANDED=$(eval echo "$PROJECT_DIR")
tmux new-session -d -s "$SESSION" -c "$PROJECT_DIR_EXPANDED"
tmux send-keys -t "$SESSION" "$CLAUDE_CMD" Enter

# Step 4: Wait for TUI prompt and auto-confirm (option 1)
sleep 3
tmux send-keys -t "$SESSION" Enter

echo "[restart-bot] ${SESSION} started in ${PROJECT_DIR_EXPANDED}"
