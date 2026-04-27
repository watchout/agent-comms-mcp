import { createHash } from 'node:crypto'

// Issue #251 (a) — content-level dedup at enqueue.
//
// The existing `uq_mq_agent_message ON (agent_id, message_id)` UNIQUE
// constraint catches single-path duplicates, but dual-path delivery
// (Discord adapter inbound + agent-comms direct send) generates
// distinct UUIDs for the same conceptual message and slips past it.
// observed (2026-04-27 psql query): 9+ such pairs in agent-com-dev's
// pending alone, 1-3s apart, identical content. This helper checks
// for a matching `(agent_id, content_hash, source)` within a
// configurable time window so the second-arriving path can
// short-circuit the INSERT.
//
// Window: default 30s per lead-ama dispatch v2 anchor. Tests may
// inject a smaller value to exercise window-boundary semantics.
//
// cycle 2 (lead-ama dispatch v3 final): the dedup key is
// **(agent_id, content_hash, source)** per Issue #251 §1 verbatim
// ("hash + source/timestamp window"). Hash + source are both
// queried in SELECT WHERE; source-agnostic content-only dedup
// (cycle 1) was rejected by auditor.

export interface QueueDedupDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

/** SHA-256 prefix-16 hash. Used as the dedup key (small enough to
 * index, wide enough to make accidental collision negligible at
 * fleet scale). */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Returns true if message_queue already holds a row with the same
 * recipient `agentId`, the same `source`, and the same content
 * (compared via `content_hash` stamped into the payload) created
 * within the last `windowSeconds` seconds.
 *
 * Issue #251 cycle 2 v3 final: the dedup key is `(agent_id,
 * content_hash, source)`, matching the §1 verbatim ("hash +
 * source/timestamp window"). Callers compute the hash once via
 * `contentHash()` and stamp it into the `payload.content_hash`
 * field before INSERT. The SELECT here re-checks against that
 * field, so:
 *   - the hash is the durable dedup key (not a re-derivation)
 *   - log lines and DB queries see the same value
 *   - no pgcrypto extension is required (no DB-side hashing)
 *
 * Falls back to comparing `payload->>'content'` when an older
 * row lacks `content_hash` (graceful degradation during the
 * cycle 2 rollout window before all queued rows carry the hash).
 */
export async function isQueueContentDup(
  db: QueueDedupDb,
  agentId: string,
  content: string,
  source: string,
  windowSeconds: number = 30,
): Promise<boolean> {
  const hash = contentHash(content)
  const result = await db.query(
    `SELECT 1 FROM message_queue
     WHERE agent_id = $1
       AND created_at > now() - make_interval(secs => $2)
       AND (payload::jsonb->>'source') = $4
       AND (
         (payload::jsonb->>'content_hash') = $3
         OR (
           (payload::jsonb->>'content_hash') IS NULL
           AND (payload::jsonb->>'content') = $5
         )
       )
     LIMIT 1`,
    [agentId, windowSeconds, hash, source, content],
  )
  return (result.rowCount ?? 0) > 0
}
