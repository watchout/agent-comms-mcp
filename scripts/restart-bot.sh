#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session (kill orphan MCP processes first)
# Usage: ./scripts/restart-bot.sh <session-name> <project-dir> [port]
# Example: ./scripts/restart-bot.sh discord-haishin ~/Developer/haishin-puls-hub 8792

set -euo pipefail

SESSION="${1:?Usage: restart-bot.sh <session-name> <project-dir> [port]}"
PROJECT_DIR="${2:?Usage: restart-bot.sh <session-name> <project-dir> [port]}"
PORT="${3:-}"
CLAUDE_CMD="${CLAUDE_CMD:-claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions}"

echo "[restart-bot] Restarting ${SESSION}..."

# Step 1: Kill orphaned MCP process on port
if [ -n "$PORT" ]; then
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
