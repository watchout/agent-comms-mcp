#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session from the DB bot profile.
# Usage: ./scripts/restart-bot.sh <session-name-or-agent-id>
# Example: ./scripts/restart-bot.sh discord-haishin
# If the DB profile cannot be read, falls back to bot-registry.txt.
# If session not found in DB or registry, falls back to manual args:
#   ./scripts/restart-bot.sh <session-name> <project-dir> [port] [command]

set -euo pipefail

# Ensure PATH includes homebrew (cron/watchdog environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REQUESTED_SESSION="${1:?Usage: restart-bot.sh <session-name-or-agent-id> [project-dir] [port] [command]}"
SESSION="$REQUESTED_SESSION"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
DEFAULT_CMD="claude --mcp-config .mcp.json --dangerously-skip-permissions"
DEFAULT_AUN_DATABASE_URL="postgresql:///agent_comms?host=/tmp"
PROFILE_SOURCE=""

# Load .mcp.json sync helper (ensures AGENT_ID/PORT/STATE_DIR match registry)
source "${SCRIPT_DIR}/sync-mcp-config.sh"

build_profile_command() {
  local agent_id="$1" session="$2" port="$3" runtime_engine="${4:-}"
  local database_url="${AGENT_COMMS_DATABASE_URL:-${DATABASE_URL:-$DEFAULT_AUN_DATABASE_URL}}"
  local state_dir="/Users/yuji/.claude/channels/${session}"
  case "$(printf '%s' "$runtime_engine" | tr '[:upper:]' '[:lower:]')" in
    codex)
      CLAUDE_CMD="codex --dangerously-bypass-approvals-and-sandbox"
      CLAUDE_CMD+=" -c 'mcp_servers.agent-comms.enabled=false'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.AGENT_ID=\"${agent_id}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID=\"${agent_id}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.DATABASE_URL=\"${database_url}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.WEBHOOK_PORT=\"${port}\"'"
      CLAUDE_CMD+=" -c 'mcp_servers.aun.env.DISCORD_STATE_DIR=\"${state_dir}\"'"
      ;;
    claude | claude-code | "")
      CLAUDE_CMD="$DEFAULT_CMD"
      ;;
    *)
      echo "[restart-bot] WARNING: unknown runtime_engine_preference '${runtime_engine}', using default Claude command" >&2
      CLAUDE_CMD="$DEFAULT_CMD"
      ;;
  esac
}

load_db_profile() {
  [ "${AGENT_COMMS_RESTART_DB:-1}" != "0" ] || return 1
  command -v psql >/dev/null 2>&1 || return 1

  local database_url="${AGENT_COMMS_DATABASE_URL:-${DATABASE_URL:-$DEFAULT_AUN_DATABASE_URL}}"
  local profile_line

  profile_line="$(psql "$database_url" -X -q -t -A -F $'\t' -v ON_ERROR_STOP=1 -v requested="$REQUESTED_SESSION" 2>/dev/null <<'SQL' || true
SELECT
  COALESCE(NULLIF(metadata->>'tmux_session', ''), agent_id) AS session_name,
  COALESCE(home_directory, '') AS project_dir,
  agent_id,
  COALESCE(channel_port::text, '') AS port,
  COALESCE(NULLIF(runtime_engine_preference, ''), runtime, '') AS runtime_engine
FROM agents
WHERE agent_type <> 'human'
  AND COALESCE(profile_enabled, true) = true
  AND (agent_id = :'requested' OR metadata->>'tmux_session' = :'requested')
ORDER BY CASE WHEN metadata->>'tmux_session' = :'requested' THEN 0 ELSE 1 END,
         agent_id
LIMIT 1;
SQL
)"
  profile_line="${profile_line%%$'\n'*}"
  [ -n "$profile_line" ] || return 1

  IFS=$'\t' read -r SESSION PROJECT_DIR AGENT_ID PORT RUNTIME_ENGINE <<< "$profile_line"
  PROFILE_SOURCE="agents.profile"

  if [ -z "${SESSION:-}" ] || [ -z "${PROJECT_DIR:-}" ] || [ -z "${AGENT_ID:-}" ] || [ -z "${PORT:-}" ]; then
    echo "[restart-bot] ERROR: DB profile for '${REQUESTED_SESSION}' is incomplete; refusing registry fallback to avoid drift" >&2
    echo "[restart-bot]        session='${SESSION:-}' project_dir='${PROJECT_DIR:-}' agent_id='${AGENT_ID:-}' port='${PORT:-}'" >&2
    exit 1
  fi

  build_profile_command "$AGENT_ID" "$SESSION" "$PORT" "${RUNTIME_ENGINE:-}"
  return 0
}

# Prefer the DB bot profile. bot-registry.txt is a compatibility fallback,
# not the identity/profile source of truth.
load_db_profile || true

# Try to resolve from registry
if [ -z "$PROFILE_SOURCE" ] && [ -f "$REGISTRY" ]; then
  REGISTRY_LINE=$(grep "^${SESSION}|" "$REGISTRY" 2>/dev/null || true)
fi

if [ -n "$PROFILE_SOURCE" ]; then
  :
elif [ -n "${REGISTRY_LINE:-}" ]; then
  IFS='|' read -r _SESSION PROJECT_DIR AGENT_ID PORT CLAUDE_CMD <<< "$REGISTRY_LINE"
  PROFILE_SOURCE="bot-registry.compat"
  CLAUDE_CMD="${CLAUDE_CMD:-$DEFAULT_CMD}"
else
  # Fallback to positional args
  PROJECT_DIR="${2:?Session not in registry. Usage: restart-bot.sh <session> <project-dir> [port] [command]}"
  PORT="${3:-}"
  CLAUDE_CMD="${4:-$DEFAULT_CMD}"
  PROFILE_SOURCE="manual-args"
fi

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
PANE_TEXT=$(tmux capture-pane -pt "$SESSION" -S -40 2>/dev/null || true)
if printf '%s\n' "$CLAUDE_CMD" | grep -qE '(^|[[:space:]])codex([[:space:]]|$)' \
  && printf '%s\n' "$PANE_TEXT" | grep -q "Update now"; then
  # Codex update prompts default to updating; choose the non-update option.
  tmux send-keys -t "$SESSION" 2 Enter
else
  tmux send-keys -t "$SESSION" Enter
fi

echo "[restart-bot] ${SESSION} started in ${PROJECT_DIR_EXPANDED}"
