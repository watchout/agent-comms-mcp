import { Client } from 'pg'
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

// Issue #251 cycle 3 (CTO `bd9b1a9b` + auditor `1e388095`) —
// per-call dedicated `pg.Client` for the dedup transaction.
//
// cycle 2 wrapped (SELECT-dedup, INSERT) in `BEGIN`/`COMMIT` on the
// shared singleton returned by `tryGetDb()` / `getDb()`. The
// auditor flagged this as a hidden-impact 🔴: transaction semantics
// on a single `pg.Client` are connection-wide, so two concurrent
// callers sharing the singleton would interleave their `BEGIN` /
// `COMMIT` pairs on one socket — the per-message atomic boundary
// would be a lie. `core/inbound-delivery.ts` already documents and
// avoids this exact pattern. cycle 3 brings the queue dedup path
// into line with the same convention.
//
// `enqueueWithDedup()` opens a fresh `pg.Client` from the URL,
// runs the (SELECT-dedup, INSERT) atomically inside `BEGIN` /
// `COMMIT`, and `end()`s in `finally`. Concurrent callers cannot
// interleave because each owns its own connection.

export interface EnqueueWithDedupParams {
  databaseUrl: string
  agentId: string
  content: string
  source: string
  windowSeconds?: number
  /** Pre-built `INSERT INTO message_queue ...` SQL. Caller owns
   * shape (RETURNING / ON CONFLICT / etc) so the helper stays
   * thin. */
  insertSql: string
  /** Params for `insertSql`. */
  insertParams: unknown[]
  /** Max retry attempts on tx error (default 3). */
  maxAttempts?: number
}

export interface EnqueueWithDedupResult {
  /** True iff INSERT actually wrote a row. */
  inserted: boolean
  /** `message_queue.id` returned by the caller's INSERT, when INSERT wrote and returned one. */
  queueId?: string
  /** True iff dedup short-circuited the INSERT. */
  dedupSkipped: boolean
  /** Hash of the content (for log lines). */
  contentHash: string
  /** Number of attempts taken to commit. */
  attempts: number
}

/**
 * Open a fresh `pg.Client`, run the dedup SELECT and the caller's
 * INSERT atomically inside a transaction, retry up to
 * `maxAttempts` times on `BEGIN` / `COMMIT` failures, then close
 * the client. Caller passes the INSERT SQL so the helper does not
 * encode an opinion on the column shape.
 */
export async function enqueueWithDedup(
  params: EnqueueWithDedupParams,
): Promise<EnqueueWithDedupResult> {
  const {
    databaseUrl, agentId, content, source,
    windowSeconds = 30,
    insertSql, insertParams,
    maxAttempts = 3,
  } = params
  const hash = contentHash(content)

  let attempts = 0
  let lastErr: unknown = null
  while (attempts < maxAttempts) {
    attempts += 1
    const client = new Client({ connectionString: databaseUrl })
    try {
      await client.connect()
    } catch (err) {
      lastErr = err
      // Connection failed — retry only if attempts remain.
      if (attempts >= maxAttempts) break
      continue
    }
    try {
      await client.query('BEGIN')
      // Issue #251 cycle 3 — serialize concurrent dedup attempts
      // for the same (agent_id, content_hash, source) tuple via a
      // PG advisory transaction-scoped lock. READ COMMITTED alone
      // does not protect us: two writers' SELECTs both observe
      // "no dup" before either INSERT commits, then both INSERT
      // succeed (each gets a fresh `message_id`, so the existing
      // `uq_mq_agent_message` UNIQUE doesn't help). The advisory
      // lock forces the second writer to block on `pg_advisory_xact_lock`
      // until the first writer's tx commits, after which the
      // second writer's SELECT sees the row and dedup-skips.
      // Lock auto-releases on COMMIT/ROLLBACK; no manual unlock.
      // Key derivation: hash the (agent, hash, source) triple to
      // a single bigint with `hashtext()` (low collision risk at
      // realistic concurrency) — `pg_advisory_xact_lock(bigint)`.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1 || '::' || $2 || '::' || $3))`,
        [agentId, hash, source],
      )
      const isDup = await isQueueContentDup(client, agentId, content, source, windowSeconds)
      if (isDup) {
        await client.query('COMMIT')
        return { inserted: false, dedupSkipped: true, contentHash: hash, attempts }
      }
      const r = await client.query<{ id: number | string }>(insertSql, insertParams)
      await client.query('COMMIT')
      const inserted = (r.rowCount ?? 0) > 0
      return {
        inserted,
        queueId: inserted && r.rows[0]?.id != null ? String(r.rows[0].id) : undefined,
        dedupSkipped: !inserted,
        contentHash: hash,
        attempts,
      }
    } catch (err) {
      lastErr = err
      await client.query('ROLLBACK').catch(() => {})
      // Retry the whole dance on any tx error; the next attempt
      // gets a brand-new client. Don't sleep — the dedup window is
      // short enough that the contended row likely committed in
      // the contender's tx already.
    } finally {
      await client.end().catch((err) => {
        process.stderr.write(
          `agent-comms: enqueueWithDedup client.end() failed (non-fatal): ${err}\n`,
        )
      })
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`enqueueWithDedup: ${String(lastErr)}`)
}
