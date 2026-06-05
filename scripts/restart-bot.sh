#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session from the DB bot profile.
# Usage: ./scripts/restart-bot.sh <session-name-or-agent-id>
# Example: ./scripts/restart-bot.sh discord-haishin
# DB `agents` profile is the only source of truth. File registry/manual args are
# intentionally not accepted because they can drift from runtime identity.

set -euo pipefail

# Ensure PATH includes homebrew (cron/watchdog environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REQUESTED_SESSION="${1:?Usage: restart-bot.sh <session-name-or-agent-id>}"
SESSION="$REQUESTED_SESSION"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_CMD="claude --mcp-config .mcp.json --dangerously-skip-permissions"
DEFAULT_AUN_DATABASE_URL="postgresql:///agent_comms?host=/tmp"
PROFILE_SOURCE=""

# Load .mcp.json sync helper (ensures AGENT_ID/PORT/STATE_DIR match registry)
source "${SCRIPT_DIR}/sync-mcp-config.sh"

build_profile_command() {
  local agent_id="$1" session="$2" port="$3" runtime_engine="${4:-}"
  local database_url="${AGENT_COMMS_DATABASE_URL:-${DATABASE_URL:-$DEFAULT_AUN_DATABASE_URL}}"
  local state_dir="/Users/yuji/.claude/channels/${session}"
  local repo_root
  repo_root="$(cd "${SCRIPT_DIR}/.." && pwd)"
  local server_path="${AGENT_COMMS_SERVER_PATH:-${repo_root}/server.ts}"
  local bun_command="${AGENT_COMMS_BUN_COMMAND:-/Users/yuji/.bun/bin/bun}"
  case "$(printf '%s' "$runtime_engine" | tr '[:upper:]' '[:lower:]')" in
    codex)
      CLAUDE_CMD="codex --dangerously-bypass-approvals-and-sandbox"
      CLAUDE_CMD+=" -c 'mcp_servers.agent-comms.enabled=false'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.enabled=true'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.command=\"${bun_command}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.args=[\"run\",\"${server_path}\"]'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.AGENT_ID=\"${agent_id}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID=\"${agent_id}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.DATABASE_URL=\"${database_url}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.AGENT_COM_RUNTIME_HEARTBEAT_DISABLED=\"0\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.WEBHOOK_PORT=\"${port}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.DISCORD_STATE_DIR=\"${state_dir}\"'"
      ;;
    claude | claude-code)
      CLAUDE_CMD="$DEFAULT_CMD"
      ;;
    *)
      echo "[restart-bot] ERROR: unknown runtime_engine_preference '${runtime_engine}', refusing DB-profile restart" >&2
      exit 1
      ;;
  esac
}

load_db_profile() {
  if [ "${AGENT_COMMS_RESTART_DB:-1}" = "0" ]; then
    echo "[restart-bot] ERROR: DB profile lookup is required; AGENT_COMMS_RESTART_DB=0 is not supported" >&2
    exit 1
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "[restart-bot] ERROR: psql is required to read DB bot profiles" >&2
    exit 1
  fi

  local database_url="${AGENT_COMMS_DATABASE_URL:-${DATABASE_URL:-$DEFAULT_AUN_DATABASE_URL}}"
  local profile_line

  if ! profile_line="$(psql "$database_url" -X -q -t -A -F '|' -v ON_ERROR_STOP=1 -v requested="$REQUESTED_SESSION" <<'SQL'
SELECT
  COALESCE(metadata->>'tmux_session', '') AS session_name,
  COALESCE(home_directory, '') AS project_dir,
  agent_id,
  COALESCE(channel_port::text, '') AS port,
  COALESCE(runtime_engine_preference, '') AS runtime_engine
FROM agents
WHERE agent_type NOT IN ('human', 'system')
  AND COALESCE(profile_enabled, true) = true
  AND disabled_at IS NULL
  AND status IS DISTINCT FROM 'disabled'
  AND (agent_id = :'requested' OR metadata->>'tmux_session' = :'requested')
ORDER BY CASE WHEN metadata->>'tmux_session' = :'requested' THEN 0 ELSE 1 END,
         agent_id
LIMIT 1;
SQL
)"; then
    echo "[restart-bot] ERROR: DB profile query failed for '${REQUESTED_SESSION}'" >&2
    exit 1
  fi
  profile_line="${profile_line%%$'\n'*}"
  if [ -z "$profile_line" ]; then
    echo "[restart-bot] ERROR: no enabled DB bot profile found for '${REQUESTED_SESSION}'" >&2
    exit 1
  fi

  IFS='|' read -r SESSION PROJECT_DIR AGENT_ID PORT RUNTIME_ENGINE <<< "$profile_line"
  PROFILE_SOURCE="agents.profile"

  if [ -z "${SESSION:-}" ] || [ -z "${PROJECT_DIR:-}" ] || [ -z "${AGENT_ID:-}" ] || [ -z "${PORT:-}" ] || [ -z "${RUNTIME_ENGINE:-}" ]; then
    echo "[restart-bot] ERROR: DB profile for '${REQUESTED_SESSION}' is incomplete; refusing registry fallback to avoid drift" >&2
    echo "[restart-bot]        session='${SESSION:-}' project_dir='${PROJECT_DIR:-}' agent_id='${AGENT_ID:-}' port='${PORT:-}' runtime_engine='${RUNTIME_ENGINE:-}'" >&2
    exit 1
  fi

  build_profile_command "$AGENT_ID" "$SESSION" "$PORT" "${RUNTIME_ENGINE:-}"
}

load_db_profile

echo "[restart-bot] Restarting ${SESSION}..."
echo "[restart-bot] Profile source: ${PROFILE_SOURCE}"
echo "[restart-bot] Agent: ${AGENT_ID:-unknown}"
echo "[restart-bot] Port: ${PORT:-none}"
echo "[restart-bot] Command: ${CLAUDE_CMD}"

if [ "${AGENT_COMMS_RESTART_DRY_RUN:-0}" = "1" ]; then
  echo "[restart-bot] Dry run requested; no tmux or port changes made"
  exit 0
fi

# Step 1: Kill orphaned MCP process on port (canonical PPID==1 filter — Issue #248 cycle 3).
# Pre-cycle-3 inline lsof | kill killed live-parent processes too, which is
# the cascade-disconnect mechanism. Delegate to the canonical script so the
# PPID==1 contract is enforced uniformly across every cleanup site.
if [ -n "${PORT:-}" ]; then
  bash "$(dirname "$0")/cleanup-orphan-ports.sh" "$PORT"
fi

# Step 2: Kill tmux session
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 1

# Step 3: Sync .mcp.json with the DB profile (compat export, not SSOT)
PROJECT_DIR_EXPANDED="$PROJECT_DIR"
if [ -n "${AGENT_ID:-}" ] && [ -n "${PORT:-}" ]; then
  sync_mcp_config "$SESSION" "$PROJECT_DIR_EXPANDED" "$AGENT_ID" "$PORT" || true
fi

# Step 4: Create new session and start Claude Code
tmux new-session -d -s "$SESSION" -c "$PROJECT_DIR_EXPANDED"
tmux send-keys -t "$SESSION" "$CLAUDE_CMD" Enter

# Step 5: Wait for TUI prompt and auto-confirm
sleep 3
PANE_TEXT=$(tmux capture-pane -pt "$SESSION" -S -40 2>/dev/null || true)
if printf '%s\n' "$CLAUDE_CMD" | grep -qE '(^|[[:space:]])codex([[:space:]]|$)' \
  && printf '%s\n' "$PANE_TEXT" | grep -q "Update now"; then
  # Codex update prompts default to updating; choose the non-update option.
  tmux send-keys -t "$SESSION" 2 Enter
else
  tmux send-keys -t "$SESSION" Enter
fi

echo "[restart-bot] ${SESSION} started in ${PROJECT_DIR_EXPANDED}"
