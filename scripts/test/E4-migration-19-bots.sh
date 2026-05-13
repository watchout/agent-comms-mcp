#!/usr/bin/env bash
# PR #338 sub-PR 1 — E4 behavioral smoke: 19-bot fleet migration.
#
# Spec ref: docs/spec/agentcom-state-daemon-v0.9-impl.md §4.2 E4:
#   "bot 19 体に対して migration 実施、`next` 呼出が 'received' claim
#    取得確認、data 損失 0"
#
# What this fixture exercises (sub-PR 1 scope only):
#   1. Seed 19 fictional bots × mixed legacy-status rows into message_queue
#   2. Run the paired up.sql (destructive enum migration)
#   3. Assert per-bot data preservation:
#        - row count per bot is preserved (count_after == count_before)
#        - no legacy-vocab status survives
#        - the new CHECK constraint accepts a simulated `next` UPDATE
#          (status='pending' -> 'received'), one row per bot
#   4. Run the paired down.sql (rollback) and assert legacy vocab restored
#   5. Clean up all fixture rows (sentinel agent_id prefix)
#
# Note on "next 呼出":
#   The actual `next` tool semantic change (write 'received' instead of
#   'read') is sub-PR 3 scope and not yet implemented. Per PR #347
#   "Out of scope" §, sub-PR 1 ships the schema only. This script therefore
#   simulates the `next` claim transition via a single UPDATE
#   (status='pending' -> 'received' + claim_expires_at stamp) and asserts
#   the new CHECK constraint accepts it. That is the DB-contract end of
#   the claim semantic; sub-PR 3 will land the matching code path.
#
# Requirements:
#   - DATABASE_URL set (e.g. postgresql://localhost/agent_comms)
#   - AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 (incident #339 env gate)
#   - psql in PATH
#
# Exit codes:
#   0 — all assertions passed
#   1 — assertion failed
#   2 — preflight failed (env / connectivity)

set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://localhost/agent_comms}"
GATE="${AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED:-}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UP_SQL="$REPO_ROOT/db/migrations/2026-05-13-status-enum-v0.9-destructive.up.sql"
DOWN_SQL="$REPO_ROOT/db/migrations/2026-05-13-status-enum-v0.9-destructive.down.sql"

FIXTURE_PREFIX="__pr338_e4_bot_"
NUM_BOTS=19
ROWS_PER_BOT=3   # pending + read + replied — covers M1 rename + claim simulation + terminal preservation

log() { printf '[E4] %s\n' "$*"; }
err() { printf '[E4][ERR] %s\n' "$*" >&2; }

preflight() {
  if [[ -z "${DB_URL}" ]]; then
    err "DATABASE_URL not set"; exit 2
  fi
  if [[ "${GATE}" != "1" ]]; then
    err "AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED must be 1 for this fixture (incident #339)"
    exit 2
  fi
  command -v psql >/dev/null || { err "psql not in PATH"; exit 2; }
  [[ -r "$UP_SQL" ]]   || { err "up.sql not readable: $UP_SQL"; exit 2; }
  [[ -r "$DOWN_SQL" ]] || { err "down.sql not readable: $DOWN_SQL"; exit 2; }
  psql -d "$DB_URL" -tAc 'SELECT 1' >/dev/null || { err "DB connect failed"; exit 2; }
}

psql_q() { psql -d "$DB_URL" -tAc "$1"; }
psql_x() { psql -d "$DB_URL" -v ON_ERROR_STOP=1 -qc "$1" >/dev/null; }
psql_f() { psql -d "$DB_URL" -v ON_ERROR_STOP=1 -qf "$1" >/dev/null; }

assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    err "$label: expected '$expected' got '$actual'"
    cleanup || true
    exit 1
  fi
  log "ok: $label = $actual"
}

reset_to_v08() {
  # Reset schema to v0.8 legacy: drop new CHECK if present, restore old.
  # Idempotent — safe to run regardless of current state.
  psql_x "ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT"
  psql_x "ALTER TABLE message_queue DROP COLUMN IF EXISTS done_at"
  psql_x "
    DO \$\$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'message_queue_status_check'
                    AND conrelid = 'message_queue'::regclass) THEN
        ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
      END IF;
      ALTER TABLE message_queue
        ADD CONSTRAINT message_queue_status_check
        CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed'));
    END \$\$;
  "
}

cleanup() {
  # Order matters: the audit subquery joins back to message_queue by
  # queue_id, so we must delete the audit rows FIRST (while their target
  # queue rows still exist) and only then delete the queue rows.
  # Deleting queue rows first leaves orphan audit residue in the shared
  # dev DB (auditor cycle 2 Finding 2).
  psql_x "DELETE FROM message_queue_status_migration_audit
            WHERE queue_id IN (SELECT id FROM message_queue
                                WHERE agent_id LIKE '${FIXTURE_PREFIX}%')" 2>/dev/null || true
  psql_x "DELETE FROM message_queue WHERE agent_id LIKE '${FIXTURE_PREFIX}%'" || true
}

seed_fleet() {
  # 19 bots × 3 rows: pending / read / replied.
  # pending  -> simulated `next` claim post-migration (-> received)
  # read     -> M1 rename verification (-> received via up.sql)
  # replied  -> terminal status preservation across migration
  local i
  for ((i=1; i<=NUM_BOTS; i++)); do
    local bot="${FIXTURE_PREFIX}$(printf '%02d' "$i")"
    psql_x "INSERT INTO message_queue (agent_id, status, payload, created_at)
              VALUES ('$bot', 'pending', '{\"e4\":true,\"k\":\"p\"}'::jsonb, now())"
    psql_x "INSERT INTO message_queue (agent_id, status, payload, created_at)
              VALUES ('$bot', 'read',    '{\"e4\":true,\"k\":\"r\"}'::jsonb, now())"
    psql_x "INSERT INTO message_queue (agent_id, status, payload, created_at)
              VALUES ('$bot', 'replied', '{\"e4\":true,\"k\":\"d\"}'::jsonb, now())"
  done
}

snapshot_counts() {
  psql_q "SELECT agent_id, count(*)
            FROM message_queue
            WHERE agent_id LIKE '${FIXTURE_PREFIX}%'
            GROUP BY agent_id
            ORDER BY agent_id"
}

main() {
  preflight
  log "preflight ok (DB=$DB_URL, gate=$GATE)"

  log "phase 0: reset to v0.8 + clean any prior fixture residue"
  cleanup
  reset_to_v08

  log "phase 1: seed 19 bots × $ROWS_PER_BOT rows"
  seed_fleet
  local total_before per_bot_before
  total_before=$(psql_q "SELECT count(*) FROM message_queue WHERE agent_id LIKE '${FIXTURE_PREFIX}%'")
  per_bot_before=$(snapshot_counts)
  assert_eq "$total_before" "$((NUM_BOTS * ROWS_PER_BOT))" "seed total count"

  log "phase 2: apply up.sql (destructive enum migration)"
  psql_f "$UP_SQL"

  log "phase 3: assert post-migration invariants"
  local total_after per_bot_after legacy_count received_count
  total_after=$(psql_q "SELECT count(*) FROM message_queue WHERE agent_id LIKE '${FIXTURE_PREFIX}%'")
  per_bot_after=$(snapshot_counts)
  legacy_count=$(psql_q "SELECT count(*) FROM message_queue
                          WHERE agent_id LIKE '${FIXTURE_PREFIX}%'
                            AND status IN ('read','skipped','failed')")
  received_count=$(psql_q "SELECT count(*) FROM message_queue
                            WHERE agent_id LIKE '${FIXTURE_PREFIX}%'
                              AND status = 'received'")
  assert_eq "$total_after"    "$total_before"   "data 損失 0 — total row count preserved"
  assert_eq "$per_bot_after"  "$per_bot_before" "per-bot row count preserved across all 19 bots"
  assert_eq "$legacy_count"   "0"               "no legacy-vocab status survives"
  assert_eq "$received_count" "$NUM_BOTS"       "M1 rename: read→received, one per bot"

  log "phase 4: simulate next-claim on each bot's pending row"
  # next tool semantic change is sub-PR 3 scope; here we exercise the
  # DB contract: the new CHECK constraint must accept pending → received.
  local i
  for ((i=1; i<=NUM_BOTS; i++)); do
    local bot="${FIXTURE_PREFIX}$(printf '%02d' "$i")"
    psql_x "UPDATE message_queue
              SET status = 'received',
                  claim_expires_at = now() + interval '30 seconds'
              WHERE agent_id = '$bot' AND status = 'pending'"
  done
  local pending_left
  pending_left=$(psql_q "SELECT count(*) FROM message_queue
                          WHERE agent_id LIKE '${FIXTURE_PREFIX}%'
                            AND status = 'pending'")
  assert_eq "$pending_left" "0" "all 19 pending rows claimed by simulated next"

  log "phase 5: apply down.sql (rollback dry-run)"
  psql_f "$DOWN_SQL"
  local v08_check_present new_vocab_left
  v08_check_present=$(psql_q "SELECT count(*) FROM pg_constraint
                                WHERE conname='message_queue_status_check'
                                  AND conrelid='message_queue'::regclass
                                  AND pg_get_constraintdef(oid) LIKE '%read%'
                                  AND pg_get_constraintdef(oid) NOT LIKE '%received%'")
  new_vocab_left=$(psql_q "SELECT count(*) FROM message_queue
                            WHERE agent_id LIKE '${FIXTURE_PREFIX}%'
                              AND status IN ('received','in_progress','done')")
  assert_eq "$v08_check_present" "1" "rollback restored v0.8 CHECK constraint"
  assert_eq "$new_vocab_left"    "0" "rollback removed all new-vocab status from fixture rows"

  log "phase 6: cleanup fixture rows"
  cleanup
  log "E4: PASS — 19-bot fleet migration verified (forward + rollback + data preservation)"
}

trap 'rc=$?; if [[ $rc -ne 0 ]]; then err "fixture aborted (rc=$rc), running cleanup"; cleanup || true; fi' EXIT

main "$@"
