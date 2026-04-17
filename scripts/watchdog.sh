#!/usr/bin/env bash
# watchdog.sh — Health check + auto-restart for bot tmux sessions
# Usage: ./scripts/watchdog.sh
# Cron:  */5 * * * * /path/to/agent-comms-mcp/scripts/watchdog.sh 2>> /tmp/watchdog.log
#
# Reads BOT_REGISTRY (one bot per line): SESSION_NAME|PROJECT_DIR|AGENT_ID|PORT|COMMAND
# COMMAND column specifies the exact startup command per bot.
# Default registry: /Users/yuji/Developer/agent-comms-mcp/scripts/bot-registry.txt

set -euo pipefail

# Ensure PATH includes homebrew (cron environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
DEFAULT_CMD="claude server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions"
LOG_TAG="[watchdog]"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-/tmp/watchdog-state}"
DISCONNECT_LOG="/tmp/bot-disconnect.log"

# Load .mcp.json sync helper (ensures AGENT_ID/PORT/STATE_DIR match registry)
source "${SCRIPT_DIR}/sync-mcp-config.sh"

mkdir -p "$WATCHDOG_STATE_DIR"

# --- Log rotation: remove entries older than 7 days ---
if [ -f "$DISCONNECT_LOG" ]; then
  CUTOFF=$(date -v-7d '+%Y-%m-%d' 2>/dev/null || date -d '7 days ago' '+%Y-%m-%d' 2>/dev/null || echo "")
  if [ -n "$CUTOFF" ]; then
    awk -v cutoff="$CUTOFF" '/^\[/ { d=substr($0,2,10); if (d >= cutoff) print; next } { print }' "$DISCONNECT_LOG" > "${DISCONNECT_LOG}.tmp" && mv "${DISCONNECT_LOG}.tmp" "$DISCONNECT_LOG"
  fi
fi

# --- Disconnect event logger ---
log_disconnect() {
  local session="$1" reason="$2" action="$3"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${session}: ${reason} (action: ${action})" >> "$DISCONNECT_LOG"
}

if [ ! -f "$BOT_REGISTRY" ]; then
  echo "${LOG_TAG} Registry not found: ${BOT_REGISTRY}" >&2
  exit 1
fi

# --- Restart function ---
restart_session() {
  local session="$1" project_dir="$2" port="$3" cmd="$4" reason="$5" agent_id="$6"

  # Sync .mcp.json with registry before restart (SSOT enforcement)
  local dir_exp
  dir_exp=$(eval echo "$project_dir")
  if [ -n "${agent_id:-}" ] && [ -n "${port:-}" ]; then
    sync_mcp_config "$session" "$dir_exp" "$agent_id" "$port" || true
  fi

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
  tmux send-keys -t "$session" "${cmd}" Enter
  # Wait for TUI prompt and auto-confirm (option 1)
  sleep 3
  tmux send-keys -t "$session" Enter

  # Write grace file to skip port check for 60 seconds after restart
  date +%s > "${WATCHDOG_STATE_DIR}/${session}.grace"

  echo "${LOG_TAG} ${session}: restarted (${reason}) cmd: ${cmd}" >&2
  echo "$(date -Iseconds) restarted (${reason})" >> "${WATCHDOG_STATE_DIR}/${session}.log"
}

RESTARTED=0
ALIVE=0
TOTAL=0

while IFS='|' read -r SESSION PROJECT_DIR AGENT_ID PORT CMD; do
  # Skip comments and empty lines
  [[ -z "$SESSION" || "$SESSION" =~ ^# ]] && continue
  TOTAL=$((TOTAL + 1))

  # Use registry command or fall back to default
  CMD="${CMD:-$DEFAULT_CMD}"

  # --- Check 1: tmux session exists ---
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "${LOG_TAG} ${SESSION}: tmux session not found" >&2
    log_disconnect "$SESSION" "crash: session missing" "restarted"
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "$CMD" "session missing" "$AGENT_ID"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  # Capture pane output for checks
  PANE_OUTPUT=$(tmux capture-pane -t "$SESSION" -p -S -30 2>/dev/null || echo "")

  # --- Check 2: crash pattern detection (DISABLED — false positives from npm/build output) ---
  # if echo "$PANE_OUTPUT" | grep -qiE '(panic|fatal|SIGKILL|segmentation fault|killed|out of memory)'; then
  #   CRASH_PATTERN=$(echo "$PANE_OUTPUT" | grep -oiE '(panic|fatal|SIGKILL|segmentation fault|killed|out of memory)' | head -1)
  #   echo "${LOG_TAG} ${SESSION}: crash detected in output" >&2
  #   log_disconnect "$SESSION" "crash: ${CRASH_PATTERN}" "restarted"
  #   restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "$CMD" "crash detected" "$AGENT_ID"
  #   RESTARTED=$((RESTARTED + 1))
  #   continue
  # fi

  # --- Check 3: channel plugin mode verification ---
  # Verify registry CMD has channel plugin flags (catches misconfiguration).
  if ! echo "$CMD" | grep -q 'dangerously-load-development-channels'; then
    echo "${LOG_TAG} ${SESSION}: registry CMD missing channel plugin flags" >&2
    log_disconnect "$SESSION" "bare_claude: Listening but no channel plugin" "restarted"
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "$CMD" "missing channel plugin flags" "$AGENT_ID"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  # --- Check 3b: port liveness verification (with grace period) ---
  # If a port is assigned, verify it is actually listening. A running tmux session
  # with no port listener means the MCP server crashed or failed to start.
  # Grace period: skip check for 60 seconds after a restart to allow startup completion.
  if [ -n "$PORT" ]; then
    GRACE_FILE="${WATCHDOG_STATE_DIR}/${SESSION}.grace"
    if [ -f "$GRACE_FILE" ]; then
      grace_time=$(cat "$GRACE_FILE")
      now=$(date +%s)
      if [ $((now - grace_time)) -lt 60 ]; then
        echo "${LOG_TAG} ${SESSION}: grace period active ($(( 60 - (now - grace_time) ))s remaining), skipping port check" >&2
        ALIVE=$((ALIVE + 1))
        continue
      fi
      rm -f "$GRACE_FILE"
    fi
    if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "${LOG_TAG} ${SESSION}: port ${PORT} not listening (MCP server down)" >&2
      log_disconnect "$SESSION" "port_dead: ${PORT} not listening" "restarted"
      restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "$CMD" "port ${PORT} not listening" "$AGENT_ID"
      RESTARTED=$((RESTARTED + 1))
      continue
    fi
  fi

  # --- Check 4: shell prompt without Claude Code (session exited to shell) ---
  LAST_LINE=$(echo "$PANE_OUTPUT" | grep -v '^$' | tail -1)
  if echo "$LAST_LINE" | grep -qE '^\S+@\S+ .+ % $|^\$ $'; then
    echo "${LOG_TAG} ${SESSION}: Claude Code exited, at shell prompt" >&2
    log_disconnect "$SESSION" "exited: at shell prompt" "restarted"
    restart_session "$SESSION" "$PROJECT_DIR" "$PORT" "$CMD" "claude exited to shell" "$AGENT_ID"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  ALIVE=$((ALIVE + 1))

done < "$BOT_REGISTRY"

echo "${LOG_TAG} Check complete: ${ALIVE}/${TOTAL} alive, ${RESTARTED} restarted" >&2
