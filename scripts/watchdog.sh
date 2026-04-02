#!/usr/bin/env bash
# watchdog.sh — Health check + auto-restart for bot tmux sessions
# Usage: ./scripts/watchdog.sh
# Cron:  */5 * * * * /path/to/agent-comms-mcp/scripts/watchdog.sh 2>> /tmp/watchdog.log
#
# Reads BOT_REGISTRY (one bot per line): SESSION_NAME|PROJECT_DIR|AGENT_ID|PORT
# Default registry: /Users/yuji/Developer/agent-comms-mcp/scripts/bot-registry.txt

set -euo pipefail

BOT_REGISTRY="${BOT_REGISTRY:-$(dirname "$0")/bot-registry.txt}"
CLAUDE_CMD="${CLAUDE_CMD:-claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions}"
LOG_TAG="[watchdog]"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-/tmp/watchdog-state}"

mkdir -p "$WATCHDOG_STATE_DIR"

if [ ! -f "$BOT_REGISTRY" ]; then
  echo "${LOG_TAG} Registry not found: ${BOT_REGISTRY}" >&2
  exit 1
fi

# --- Restart function ---
restart_session() {
  local session="$1" project_dir="$2" port="$3" reason="$4"

  tmux kill-session -t "$session" 2>/dev/null || true
  sleep 1

  # Kill orphaned MCP process on port
  if [ -n "$port" ]; then
    local old_pid
    old_pid=$(lsof -i :"$port" -t 2>/dev/null || true)
    if [ -n "$old_pid" ]; then
      echo "${LOG_TAG} ${session}: killing orphaned process PID ${old_pid} on port ${port}" >&2
      kill "$old_pid" 2>/dev/null || true
      sleep 1
    fi
  fi

  local dir_expanded
  dir_expanded=$(eval echo "$project_dir")
  tmux new-session -d -s "$session" -c "$dir_expanded"
  sleep 1
  tmux send-keys -t "$session" "${CLAUDE_CMD}" Enter
  # Wait for TUI prompt and auto-confirm (option 1)
  sleep 3
  tmux send-keys -t "$session" Enter

  echo "${LOG_TAG} ${session}: restarted (${reason})" >&2
  echo "$(date -Iseconds) restarted (${reason})" >> "${WATCHDOG_STATE_DIR}/${session}.log"
}

RESTARTED=0
ALIVE=0
TOTAL=0

while IFS='|' read -r SESSION PROJECT_DIR AGENT_ID PORT; do
  # Skip comments and empty lines
  [[ -z "$SESSION" || "$SESSION" =~ ^# ]] && continue
  TOTAL=$((TOTAL + 1))

  # --- Check 1: tmux session exists ---
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "${LOG_TAG} ${SESSION}: tmux session not found" >&2
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "session missing"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  # Capture pane output for checks
  PANE_OUTPUT=$(tmux capture-pane -t "$SESSION" -p -S -30 2>/dev/null || echo "")

  # --- Check 2: crash pattern detection ---
  if echo "$PANE_OUTPUT" | grep -qiE '(panic|fatal|SIGKILL|segmentation fault|killed|out of memory)'; then
    echo "${LOG_TAG} ${SESSION}: crash detected in output" >&2
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "crash detected"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  # --- Check 3: channel plugin mode verification ---
  # Claude Code must be running with --dangerously-load-development-channels
  # If "Listening for channel messages" is NOT in output, and the session has
  # been up long enough (has ❯ prompt), it was started with bare `claude`
  if echo "$PANE_OUTPUT" | grep -q '❯'; then
    if ! echo "$PANE_OUTPUT" | grep -q 'Listening for channel messages'; then
      # Session is running but not in channel mode — check if it's still initializing
      # by looking for the startup command in the output
      if ! echo "$PANE_OUTPUT" | grep -q 'dangerously-load-development-channels'; then
        echo "${LOG_TAG} ${SESSION}: not in channel plugin mode (bare claude)" >&2
        restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "missing channel plugin flags"
        RESTARTED=$((RESTARTED + 1))
        continue
      fi
    fi
  fi

  # --- Check 4: shell prompt without Claude Code (session exited to shell) ---
  # If the last non-empty line is a shell prompt (% or $) without Claude's ❯, Claude Code has exited
  LAST_LINE=$(echo "$PANE_OUTPUT" | grep -v '^$' | tail -1)
  if echo "$LAST_LINE" | grep -qE '^\S+@\S+ .+ % $|^\$ $'; then
    echo "${LOG_TAG} ${SESSION}: Claude Code exited, at shell prompt" >&2
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "claude exited to shell"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  ALIVE=$((ALIVE + 1))

done < "$BOT_REGISTRY"

echo "${LOG_TAG} Check complete: ${ALIVE}/${TOTAL} alive, ${RESTARTED} restarted" >&2
