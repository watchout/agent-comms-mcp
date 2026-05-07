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
  local total
  total=$(timeout 3 psql "$DATABASE_URL" -tAX -v ON_ERROR_STOP=1 \
    -c "SELECT (SELECT COUNT(*) FROM message_queue WHERE agent_id='${agent_id}' AND status='pending') + (SELECT COUNT(*) FROM outbound_queue WHERE agent_id='${agent_id}' AND status IN ('pending','claimed')) AS total;" 2>/dev/null || echo "")
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
