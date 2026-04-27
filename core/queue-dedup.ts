import { createHash } from 'node:crypto'

// Issue #251 (a) — content-level dedup at enqueue.
//
// The existing `uq_mq_agent_message ON (agent_id, message_id)` UNIQUE
// constraint catches single-path duplicates, but dual-path delivery
// (Discord adapter inbound + agent-comms direct send) generates
// distinct UUIDs for the same conceptual message and slips past it.
// observed (2026-04-27 psql query): 9+ such pairs in agent-com-dev's
// pending alone, 1-3s apart, identical content. This helper checks
// for a matching `(agent_id, content)` within a configurable time
// window so the second-arriving path can short-circuit the INSERT.
//
// Window: default 30s per lead-ama dispatch v2 anchor. Tests may
// inject a smaller value to exercise window-boundary semantics.

export interface QueueDedupDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

/** SHA-256 prefix-16 hash, suitable for dedup logging (collision risk negligible). */
export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Returns true if message_queue already holds a row with the same
 * recipient `agentId` and the same `content` (extracted from the
 * stored payload's `content` field) created within the last
 * `windowSeconds` seconds.
 *
 * Source-agnostic on purpose: dual-path duplicates carry different
 * `source` values (`agent-comms` vs `discord`) but the same content
 * for the same recipient — those are exactly what we need to skip.
 */
export async function isQueueContentDup(
  db: QueueDedupDb,
  agentId: string,
  content: string,
  windowSeconds: number = 30,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM message_queue
     WHERE agent_id = $1
       AND created_at > now() - make_interval(secs => $2)
       AND (payload::jsonb->>'content') = $3
     LIMIT 1`,
    [agentId, windowSeconds, content],
  )
  return (result.rowCount ?? 0) > 0
}
