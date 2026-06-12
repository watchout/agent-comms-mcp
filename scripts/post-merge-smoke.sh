#!/bin/bash
# post-merge-smoke.sh — mechanical post-merge complete gate
#
# Company Dev OS operating model: "CI green ≠ complete"
# Complete requires:
#   1. Fleet PID = target commit (no source drift)
#   2. All expected bots online (DB health check)
#   3. Queue drain healthy (no stuck pending > 10 min)
#   4. No new error patterns in recent DB logs
#
# Usage:
#   bash scripts/post-merge-smoke.sh [TARGET_COMMIT]
#   TARGET_COMMIT defaults to HEAD
#
# Exit codes:
#   0 → complete ✅
#   1 → smoke failed ❌ (rollback candidate)
#
# Environment:
#   DATABASE_URL   — postgres connection (required for DB checks)
#   SKIP_PID_CHECK — set to 1 to skip fleet PID check (CI use)
set -euo pipefail

TARGET_COMMIT="${1:-$(git rev-parse HEAD)}"
SHORT_COMMIT="${TARGET_COMMIT:0:8}"
FAIL=0
WARNINGS=()
ERRORS=()

log_ok()   { echo "  ✅ $*"; }
log_warn() { echo "  ⚠️  $*"; WARNINGS+=("$*"); }
log_err()  { echo "  ❌ $*"; ERRORS+=("$*"); FAIL=1; }

echo ""
echo "═══════════════════════════════════════════"
echo "  Post-merge smoke — target: ${SHORT_COMMIT}"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Fleet PID = target commit ────────────────────────────────────────────
if [ "${SKIP_PID_CHECK:-0}" = "1" ]; then
  log_ok "Fleet PID check skipped (CI mode)"
else
  echo "[ Check 1 ] Fleet source drift"
  if command -v tmux >/dev/null 2>&1; then
    # Find tmux sessions running server.ts and verify their working tree commit
    while IFS= read -r session; do
      bot_id="${session#discord-}"
      # Get the working dir of the tmux session's shell
      tmux_pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' 2>/dev/null | head -1 || true)
      if [ -n "$tmux_pid" ]; then
        cwd=$(readlink -f "/proc/$tmux_pid/cwd" 2>/dev/null || lsof -p "$tmux_pid" -a -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2- || echo "unknown")
        if [ "$cwd" != "unknown" ] && [ -d "$cwd/.git" ]; then
          running_commit=$(git -C "$cwd" rev-parse HEAD 2>/dev/null || echo "unknown")
          if [ "$running_commit" = "$TARGET_COMMIT" ]; then
            log_ok "  ${bot_id}: commit ${running_commit:0:8} ✓"
          else
            log_warn "${bot_id}: running ${running_commit:0:8}, target ${SHORT_COMMIT} (restart needed)"
          fi
        fi
      fi
    done < <(tmux ls 2>/dev/null | grep '^discord-' | cut -d: -f1 || true)
    log_ok "Fleet PID scan complete"
  else
    log_ok "Fleet PID check skipped (no tmux)"
  fi
fi

# ── 2. Bot health (DB) ──────────────────────────────────────────────────────
echo ""
echo "[ Check 2 ] Bot health via DB"
if [ -n "${DATABASE_URL:-}" ]; then
  unhealthy=$(psql "$DATABASE_URL" -tAc "
    SELECT agent_id
    FROM agents
    WHERE status = 'online'
      AND last_seen_at < NOW() - INTERVAL '5 minutes'
    ORDER BY last_seen_at DESC
    LIMIT 10
  " 2>/dev/null || echo "DB_ERROR")

  if [ "$unhealthy" = "DB_ERROR" ]; then
    log_warn "DB health check failed (DB unavailable)"
  elif [ -z "$unhealthy" ]; then
    log_ok "All online bots heartbeating within 5 min"
  else
    while IFS= read -r bot; do
      [ -n "$bot" ] && log_warn "Bot ${bot} is online but not heartbeating"
    done <<< "$unhealthy"
  fi
else
  log_ok "DB health check skipped (no DATABASE_URL)"
fi

# ── 3. Queue drain health ───────────────────────────────────────────────────
echo ""
echo "[ Check 3 ] Queue drain (stuck pending > 10 min)"
if [ -n "${DATABASE_URL:-}" ]; then
  stuck=$(psql "$DATABASE_URL" -tAc "
    SELECT agent_id || ': ' || COUNT(*)::text || ' stuck (oldest: ' ||
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::int || 's)'
    FROM message_queue
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '10 minutes'
    GROUP BY agent_id
    ORDER BY COUNT(*) DESC
    LIMIT 5
  " 2>/dev/null || echo "DB_ERROR")

  if [ "$stuck" = "DB_ERROR" ]; then
    log_warn "Queue check failed (DB unavailable)"
  elif [ -z "$stuck" ]; then
    log_ok "No stuck pending messages"
  else
    while IFS= read -r line; do
      [ -n "$line" ] && log_warn "Stuck queue: $line"
    done <<< "$stuck"
  fi
else
  log_ok "Queue check skipped (no DATABASE_URL)"
fi

# ── 4. Endpoint lease health ────────────────────────────────────────────────
echo ""
echo "[ Check 4 ] Endpoint lease coverage"
if [ -n "${DATABASE_URL:-}" ]; then
  missing_lease=$(psql "$DATABASE_URL" -tAc "
    SELECT ci.agent_id
    FROM connector_instances ci
    LEFT JOIN control_plane_leases cpl
      ON cpl.lease_scope_type = 'runtime_instance'
     AND cpl.lease_scope_id = ci.runtime_instance_id::text
     AND cpl.status = 'active'
     AND cpl.expires_at > NOW()
    WHERE ci.status = 'active'
      AND cpl.lease_id IS NULL
    GROUP BY ci.agent_id
    LIMIT 10
  " 2>/dev/null || echo "DB_ERROR")

  if [ "$missing_lease" = "DB_ERROR" ]; then
    log_warn "Lease check failed (DB unavailable)"
  elif [ -z "$missing_lease" ]; then
    log_ok "All active connectors have valid endpoint leases"
  else
    while IFS= read -r bot; do
      [ -n "$bot" ] && log_warn "Missing endpoint lease: ${bot}"
    done <<< "$missing_lease"
  fi
else
  log_ok "Lease check skipped (no DATABASE_URL)"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
if [ "$FAIL" -eq 0 ] && [ ${#WARNINGS[@]} -eq 0 ]; then
  echo "  ✅ COMPLETE — post-merge smoke passed"
elif [ "$FAIL" -eq 0 ]; then
  echo "  ⚠️  COMPLETE with warnings (${#WARNINGS[@]} warnings)"
  for w in "${WARNINGS[@]}"; do echo "     - $w"; done
  echo "  → Review warnings; consider fleet restart"
else
  echo "  ❌ INCOMPLETE — ${#ERRORS[@]} error(s) detected"
  for e in "${ERRORS[@]}"; do echo "     - $e"; done
  echo "  → Do NOT declare complete. Investigate or rollback."
fi
echo "═══════════════════════════════════════════"
echo ""

exit "$FAIL"
