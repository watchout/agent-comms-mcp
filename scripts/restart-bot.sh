#!/usr/bin/env bash
# restart-bot.sh — Safely restart a bot session from the DB bot profile.
# Usage: ./scripts/restart-bot.sh <session-name-or-agent-id>
# Example: ./scripts/restart-bot.sh discord-haishin
# Stable identity comes from the enabled seat profile; actual provider history
# selects the host runtime and the OS allocates its held bridge endpoint.

set -euo pipefail

# Ensure PATH includes homebrew (cron/watchdog environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REQUESTED_SESSION="${1:?Usage: restart-bot.sh <session-name-or-agent-id>}"
SESSION="$REQUESTED_SESSION"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_CMD="claude --mcp-config .mcp.json --dangerously-skip-permissions"
DEFAULT_AUN_DATABASE_URL="postgresql:///agent_comms?host=/tmp"
BUN_BIN="${AGENT_COMMS_BUN_COMMAND:-/Users/yuji/.bun/bin/bun}"
PROFILE_SOURCE=""
RUNTIME_INTENT="${2:---runtime=auto}"
RUNTIME_INTENT="${RUNTIME_INTENT#--runtime=}"



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
  '0' AS port,
  'observed' AS runtime_engine
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

  local runtime_binding
  runtime_binding=$("$BUN_BIN" -e '
    const {Client}=await import("pg");
    const {resolveSeatProvider}=await import(process.argv[1]+"/core/seat-runtime-selection.ts");
    const db=new Client({connectionString:process.argv[3]}); await db.connect();
    try { const r=await resolveSeatProvider(db,{agentId:process.argv[2],allowHistory:true,intent:process.argv[4]==="auto"?null:process.argv[4]});
      if(!r.ok) throw new Error(r.code);
      const values=[r.provider,r.observation?.session_name||"",r.observation?.workspace||""];
      if(values.some(value=>/[|\n\r]/.test(value))) throw new Error("invalid runtime binding");
      process.stdout.write(values.join("|")); }
    finally {await db.end();}
  ' "$REPO_ROOT" "$AGENT_ID" "$database_url" "$RUNTIME_INTENT")
  local observed_session observed_workspace
  IFS='|' read -r RUNTIME_ENGINE observed_session observed_workspace <<< "$runtime_binding"
  if [ -n "$observed_session" ]; then SESSION="$observed_session"; fi
  if [ -n "$observed_workspace" ]; then PROJECT_DIR="$observed_workspace"; fi
  CLAUDE_CMD=$("$BUN_BIN" -e '
    const {start}=await import(process.argv[1]+"/bin/aun/start.ts");
    const result=await start({agentId:process.argv[2],runtime:process.argv[3],cwd:process.argv[4],spawn:false,checkSignatures:false,
      env:{...process.env,DATABASE_URL:process.argv[5],AGENT_COM_RUNTIME_SESSION:process.argv[6]}});
    if(!result.ok) throw new Error(result.errors.join(","));
    const quote=s=>String.fromCharCode(39)+s.replaceAll(String.fromCharCode(39),String.fromCharCode(39,34,39,34,39))+String.fromCharCode(39);
    process.stdout.write(result.argv.map(quote).join(" "));
  ' "$REPO_ROOT" "$AGENT_ID" "$RUNTIME_ENGINE" "$PROJECT_DIR" "$database_url" "$SESSION")

}

load_db_profile

echo "[restart-bot] Restarting ${SESSION}..."
echo "[restart-bot] Profile source: ${PROFILE_SOURCE}"
echo "[restart-bot] Agent: ${AGENT_ID:-unknown}"
echo "[restart-bot] Port: ${PORT:-none}"
echo "[restart-bot] Provider: ${RUNTIME_ENGINE}; invocation-scoped MCP configuration"

"$BUN_BIN" "${SCRIPT_DIR}/startup-safety-preflight.ts" \
  --agent-id "${AGENT_ID:-}" \
  --expected-agent-id "${AGENT_ID:-}" \
  --session "${SESSION:-}" \
  --port "${PORT:-}" \
  --command "$CLAUDE_CMD" \
  --launcher-root "$REPO_ROOT" \
  --codex-post-start-enter-policy update_prompt_only

if [ "${AGENT_COMMS_RESTART_DRY_RUN:-0}" = "1" ]; then
  echo "[restart-bot] Dry run requested; no tmux or port changes made"
  exit 0
fi

# The replacement owns a new OS socket; no profile-port cleanup is performed.
# Step 2: Kill tmux session
tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 1

# The argv already contains an isolated MCP projection; no account/project file writes.
PROJECT_DIR_EXPANDED="$PROJECT_DIR"

# Step 4: Create new session and start Claude Code
tmux new-session -d -s "$SESSION" -c "$PROJECT_DIR_EXPANDED"
TMUX_TARGET="${SESSION}:0.0"
tmux send-keys -t "$TMUX_TARGET" -l "$CLAUDE_CMD"
tmux send-keys -t "$TMUX_TARGET" Enter

# Step 5: Wait for a Codex update prompt and explicitly skip it.
# Do not send an extra Enter on the normal Codex start screen: in Codex 0.139
# that can submit the highlighted suggestion and end the just-started session.
sleep 3
PANE_TEXT=$(tmux capture-pane -pt "$TMUX_TARGET" -S -40 2>/dev/null || true)
if [ "$RUNTIME_ENGINE" = "codex" ] \
  && printf '%s\n' "$PANE_TEXT" | grep -q "Update now"; then
  # Codex update prompts default to updating; choose the non-update option.
  tmux send-keys -t "$TMUX_TARGET" 2 Enter
fi

echo "[restart-bot] ${SESSION} started in ${PROJECT_DIR_EXPANDED}"
