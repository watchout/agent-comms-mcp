#!/usr/bin/env bash
# CTO P0 cold-start kick helper functions (PR #321 cycle 3, axis 5
# adapter port 分離).
#
# 3 adapter ports — each independently mockable for unit test:
#
#   - aun_self_kick_db_query(agent_id)
#       DB query port. stdout = pending-count integer (or empty on
#       error). stderr = warning line on DB unreachable. Always exits 0.
#
#   - aun_self_kick_resolve_session()
#       Session resolution port. stdout = tmux session name (or empty
#       when not running under tmux / display-message fails).
#
#   - aun_self_kick_check_lock(lock_path)
#       Lock store port. exit 0 = caller MAY proceed (lock absent or
#       stale). exit 1 = caller MUST NOT proceed (lock fresh, <5 min).
#
# This file is sourced by `hooks/aun-session-start-self-kick.sh`. It is
# also unit-tested directly by `tests/contract/test_aun_self_kick_helpers.test.ts`
# (U-1 / U-2 / U-3) where each port is exercised against PATH-prefix
# stubs (psql / tmux) and an isolated tmpdir for the lock fs.

# Adapter 1 — DB query.
# Reads $DATABASE_URL from env (caller's responsibility). Fail-tolerant:
# missing URL or psql failure prints a single stderr warning and emits
# empty stdout. Always returns 0 so the orchestrator sees a graceful
# "skip" rather than a hard error.
aun_self_kick_db_query() {
  local agent_id="${1:-}"
  if [ -z "$agent_id" ]; then
    return 0
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "aun-self-kick: DATABASE_URL unset, skipping" >&2
    return 0
  fi
  local project="${AGENT_COMMS_MEMORY_READY_PROJECT:-${AGENT_MEMORY_PROJECT:-agent-comms-mcp}}"
  local total
  total=$(timeout 3 psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -v agent_id="$agent_id" \
    -v project="$project" <<'SQL' 2>/dev/null || echo ""
WITH current_runtime AS (
  SELECT ari.runtime_instance_id::text AS runtime_instance_id,
         ari.session_name,
         ari.port,
         ari.started_at,
         COALESCE(a.profile_revision, 1) AS profile_revision,
         COALESCE(a.profile_source, 'legacy') AS profile_source
    FROM agent_runtime_instances ari
    JOIN agents a ON a.agent_id = ari.agent_id
   WHERE ari.agent_id = :'agent_id'
     AND ari.status IN ('running', 'active')
   ORDER BY COALESCE(ari.last_seen_at, ari.started_at) DESC, ari.started_at DESC
   LIMIT 1
),
memory_ready AS (
  SELECT 1
    FROM current_runtime cr
    JOIN runtime_memory_ready_evidence e
      ON e.agent_id = :'agent_id'
     AND e.project = :'project'
     AND e.runtime_instance_id = cr.runtime_instance_id
     AND e.expected_agent_id = :'agent_id'
     AND e.result_status IN ('ready', 'bypassed')
     AND e.valid_until > now()
     AND e.completed_at >= cr.started_at
     AND (cr.session_name IS NULL OR e.session_name = cr.session_name)
     AND (cr.port IS NULL OR e.port = cr.port)
     AND (e.profile_revision IS NULL OR e.profile_revision = cr.profile_revision)
     AND (e.profile_source IS NULL OR e.profile_source = cr.profile_source)
   LIMIT 1
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM memory_ready)
  THEN
    (SELECT COUNT(*) FROM message_queue WHERE agent_id = :'agent_id' AND status = 'pending')
    + (SELECT COUNT(*) FROM outbound_queue WHERE agent_id = :'agent_id' AND status IN ('pending','claimed'))
  ELSE 0
END AS total;
SQL
)
  if [ -z "$total" ] || ! [[ "$total" =~ ^[0-9]+$ ]]; then
    echo "aun-self-kick: DB unreachable or query failed, skipping" >&2
    return 0
  fi
  echo "$total"
}

# Adapter 2 — session resolution.
# Returns the tmux session name on stdout, or empty when $TMUX is unset
# or `tmux display-message` fails.
aun_self_kick_resolve_session() {
  if [ -z "${TMUX:-}" ]; then
    return 0
  fi
  tmux display-message -p '#S' 2>/dev/null || true
}

# Adapter 3 — lock store.
# Returns 0 if the caller may proceed (lock absent or older than 5 min),
# 1 if a fresh lock is in place. The 5 min TTL absorbs rapid restart
# loops on a single tmux session; cross-session scoping is the caller's
# responsibility (it composes the lock path).
aun_self_kick_check_lock() {
  local lock="${1:-}"
  if [ -z "$lock" ] || [ ! -f "$lock" ]; then
    return 0
  fi
  local age
  # GNU-first ordering — `stat -c %Y` works on Linux (CI) and silently
  # fails on macOS, where the BSD `stat -f %m` fallback then resolves.
  # Reverse order would have `-f %m` fire on Linux against a `%m`
  # format token that has a different meaning under GNU coreutils.
  age=$(( $(date +%s) - $(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null || echo 0) ))
  if [ "$age" -ge 0 ] && [ "$age" -lt 300 ]; then
    return 1
  fi
  return 0
}
