#!/usr/bin/env bash
# PR-0 (Issue #287) §2 effective verification protocol — pre/post snapshot.
#
# Usage:
#   bash scripts/pr0-fleet-pending-snapshot.sh > /tmp/pr0-pre.log    # before merge
#   # … apply migration + restart fleet …
#   bash scripts/pr0-fleet-pending-snapshot.sh > /tmp/pr0-post.log   # after restart
#   diff /tmp/pr0-pre.log /tmp/pr0-post.log
#
# Output: per-agent pending count + cursor state, in a deterministic shape
# that's easy to diff. Spec §2 effective gate: post-restart pending = 0 for
# every active agent.
#
# Idempotent + read-only: only SELECT statements, never mutates state.

set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://localhost/agent_comms}"

echo "# PR-0 (#287) fleet pending snapshot — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

psql -d "$DB_URL" -At <<'SQL'
SELECT
  a.agent_id,
  COALESCE(p.pending_count, 0)               AS pending_count,
  COALESCE(p.oldest_pending_age_seconds, 0)  AS oldest_pending_age_seconds,
  a.inbox_cursor_at,
  a.inbox_cursor_id
FROM agents a
LEFT JOIN (
  SELECT
    agent_id,
    count(*)                                                            AS pending_count,
    EXTRACT(EPOCH FROM (now() - min(created_at)))::int                  AS oldest_pending_age_seconds
  FROM message_queue
  WHERE status = 'pending'
  GROUP BY agent_id
) p ON p.agent_id = a.agent_id
WHERE a.status IS NOT NULL
ORDER BY a.agent_id;
SQL
