#!/usr/bin/env bash
# watchdog.sh — one-shot DB-profile health check + restart helper.
# DB `agents` profiles are the only source of truth for session, agent_id, and
# port. This script intentionally does not read bot-registry.txt.

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATABASE_URL="${DATABASE_URL:-${AGENT_COMMS_DATABASE_URL:-postgresql:///agent_comms?host=/tmp}}"
LOG_TAG="[watchdog]"
WATCHDOG_STATE_DIR="${WATCHDOG_STATE_DIR:-/tmp/watchdog-state}"
DISCONNECT_LOG="/tmp/bot-disconnect.log"

mkdir -p "$WATCHDOG_STATE_DIR"

log_disconnect() {
  local session="$1" reason="$2" action="$3"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ${session}: ${reason} (action: ${action})" >> "$DISCONNECT_LOG"
}

restart_session() {
  local session="$1" agent_id="$2" reason="$3"

  tmux kill-session -t "$session" 2>/dev/null || true
  sleep 1

  bash "${SCRIPT_DIR}/restart-bot.sh" "$agent_id"

  date +%s > "${WATCHDOG_STATE_DIR}/${session}.grace"
  echo "${LOG_TAG} ${session}: restarted (${reason}) via DB profile ${agent_id}" >&2
  echo "$(date -Iseconds) restarted (${reason})" >> "${WATCHDOG_STATE_DIR}/${session}.log"
}

if ! command -v psql >/dev/null 2>&1; then
  echo "${LOG_TAG} psql is required to read DB bot profiles" >&2
  exit 1
fi

RESTARTED=0
ALIVE=0
TOTAL=0

while IFS='|' read -r SESSION PROJECT_DIR AGENT_ID PORT RUNTIME_ENGINE; do
  [ -n "${AGENT_ID:-}" ] || continue
  TOTAL=$((TOTAL + 1))

  if [ -z "${SESSION:-}" ]; then
    echo "${LOG_TAG} ${AGENT_ID}: missing tmux_session in DB profile" >&2
    continue
  fi

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "${LOG_TAG} ${SESSION}: tmux session not found" >&2
    log_disconnect "$SESSION" "crash: session missing" "restarted"
    restart_session "$SESSION" "$AGENT_ID" "session missing"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  PANE_OUTPUT=$(tmux capture-pane -t "$SESSION" -p -S -30 2>/dev/null || echo "")
  LAST_LINE=$(echo "$PANE_OUTPUT" | grep -v '^$' | tail -1)
  if echo "$LAST_LINE" | grep -qE '^\S+@\S+ .+ % $|^\$ $'; then
    echo "${LOG_TAG} ${SESSION}: Codex/Claude exited, at shell prompt" >&2
    log_disconnect "$SESSION" "exited: at shell prompt" "restarted"
    restart_session "$SESSION" "$AGENT_ID" "runtime exited to shell"
    RESTARTED=$((RESTARTED + 1))
    continue
  fi

  if [ -n "${PORT:-}" ]; then
    GRACE_FILE="${WATCHDOG_STATE_DIR}/${SESSION}.grace"
    if [ -f "$GRACE_FILE" ]; then
      grace_time=$(cat "$GRACE_FILE")
      now=$(date +%s)
      if [ $((now - grace_time)) -lt 60 ]; then
        echo "${LOG_TAG} ${SESSION}: grace period active ($((60 - (now - grace_time)))s remaining), skipping port check" >&2
        ALIVE=$((ALIVE + 1))
        continue
      fi
      rm -f "$GRACE_FILE"
    fi
    if ! lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "${LOG_TAG} ${SESSION}: port ${PORT} not listening (MCP server down)" >&2
      log_disconnect "$SESSION" "port_dead: ${PORT} not listening" "restarted"
      restart_session "$SESSION" "$AGENT_ID" "port ${PORT} not listening"
      RESTARTED=$((RESTARTED + 1))
      continue
    fi
  fi

  ALIVE=$((ALIVE + 1))
done < <(
  psql "$DATABASE_URL" -X -q -t -A -F '|' -v ON_ERROR_STOP=1 <<'SQL'
SELECT
  COALESCE(metadata->>'tmux_session', '') AS session_name,
  COALESCE(home_directory, '') AS project_dir,
  agent_id,
  COALESCE(channel_port::text, '') AS port,
  COALESCE(runtime_engine_preference, runtime, '') AS runtime_engine
FROM agents
WHERE agent_type NOT IN ('human', 'system')
  AND COALESCE(profile_enabled, true) = true
  AND disabled_at IS NULL
  AND status IS DISTINCT FROM 'disabled'
ORDER BY agent_id;
SQL
)

echo "${LOG_TAG} Check complete: ${ALIVE}/${TOTAL} alive, ${RESTARTED} restarted" >&2
