#!/usr/bin/env bash
# on-demand-launcher.sh — Check for unread messages and start a bot if needed
# Usage: BOT_NAME=discord-wbs BOT_DIR=~/Developer/wbs AGENT_ID=wbs-dev ./on-demand-launcher.sh
# Cron: * * * * * BOT_NAME=discord-wbs BOT_DIR=~/Developer/wbs AGENT_ID=wbs-dev /path/to/on-demand-launcher.sh

set -euo pipefail

# --- Configuration ---
BOT_NAME="${BOT_NAME:?BOT_NAME is required (tmux session name)}"
BOT_DIR="${BOT_DIR:?BOT_DIR is required (project directory)}"
AGENT_ID="${AGENT_ID:?AGENT_ID is required}"
DATABASE_URL="${DATABASE_URL:-postgresql://localhost/agent_comms}"
CLAUDE_CMD="${CLAUDE_CMD:-claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions}"

LOG_TAG="[on-demand-launcher:${BOT_NAME}]"

# --- Step 1: Check if tmux session already exists ---
if tmux has-session -t "${BOT_NAME}" 2>/dev/null; then
  exit 0  # Already running, nothing to do
fi

# --- Step 2: Check for unread messages ---
UNREAD_COUNT=$(psql "${DATABASE_URL}" -tAc \
  "SELECT count(*) FROM agent_messages
   WHERE metadata->>'to' = '${AGENT_ID}'
     AND author_id != '${AGENT_ID}'
     AND created_at > now() - interval '10 minutes'" 2>/dev/null || echo "0")

# Trim whitespace
UNREAD_COUNT=$(echo "${UNREAD_COUNT}" | tr -d '[:space:]')

if [ "${UNREAD_COUNT}" = "0" ] || [ -z "${UNREAD_COUNT}" ]; then
  exit 0  # No unread messages
fi

echo "${LOG_TAG} ${UNREAD_COUNT} unread message(s) found. Starting ${BOT_NAME}..." >&2

# --- Step 3: Create tmux session and start Claude Code ---
BOT_DIR_EXPANDED=$(eval echo "${BOT_DIR}")
tmux new-session -d -s "${BOT_NAME}" -c "${BOT_DIR_EXPANDED}"

# Wait for shell to initialize
sleep 1

# Send Claude Code command (echo 1 to auto-select "local development")
tmux send-keys -t "${BOT_NAME}" "echo 1 | ${CLAUDE_CMD}" Enter

echo "${LOG_TAG} Started ${BOT_NAME} in tmux session." >&2
