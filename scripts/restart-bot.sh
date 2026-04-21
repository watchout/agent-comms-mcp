#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session using bot-registry.txt
# Usage: ./scripts/restart-bot.sh <session-name>
# Example: ./scripts/restart-bot.sh discord-haishin
# If session not found in registry, falls back to manual args:
#   ./scripts/restart-bot.sh <session-name> <project-dir> [port] [command]

set -euo pipefail

# Ensure PATH includes homebrew (cron/watchdog environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SESSION="${1:?Usage: restart-bot.sh <session-name> [project-dir] [port] [command]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
DEFAULT_CMD="claude --mcp-config .mcp.json --dangerously-skip-permissions"

# Load .mcp.json sync helper (ensures AGENT_ID/PORT/STATE_DIR match registry)
source "${SCRIPT_DIR}/sync-mcp-config.sh"

# Try to resolve from registry
if [ -f "$REGISTRY" ]; then
  REGISTRY_LINE=$(grep "^${SESSION}|" "$REGISTRY" 2>/dev/null || true)
fi

if [ -n "${REGISTRY_LINE:-}" ]; then
  IFS='|' read -r _SESSION PROJECT_DIR AGENT_ID PORT CLAUDE_CMD <<< "$REGISTRY_LINE"
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

# Step 3: Sync .mcp.json with registry (SSOT enforcement)
PROJECT_DIR_EXPANDED=$(eval echo "$PROJECT_DIR")
if [ -n "${AGENT_ID:-}" ] && [ -n "${PORT:-}" ]; then
  sync_mcp_config "$SESSION" "$PROJECT_DIR_EXPANDED" "$AGENT_ID" "$PORT" || true
fi

# Step 4: Create new session and start Claude Code
tmux new-session -d -s "$SESSION" -c "$PROJECT_DIR_EXPANDED"
tmux send-keys -t "$SESSION" "$CLAUDE_CMD" Enter

# Step 5: Wait for TUI prompt and auto-confirm
sleep 3
tmux send-keys -t "$SESSION" Enter

echo "[restart-bot] ${SESSION} started in ${PROJECT_DIR_EXPANDED}"
