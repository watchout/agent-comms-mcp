// Issue #251 (c) — auto-skip pending rows older than TTL.
//
// Pending rows that linger past the TTL are almost always stale: the
// recipient bot was offline, the sender retried, or the conversation
// has moved on. Auto-skipping them keeps `/next` from popping ancient
// messages and keeps the queue length bounded.
//
// observed (2026-04-27 psql query): 43 of 200 pending rows (21.5%)
// are over 24h old, oldest from 2026-04-24.
//
// Mechanism: a small in-process setInterval that runs the sweep
// query. Lives inside `server.ts` so it shares the bot's PG pool
// and lifecycle (no separate cron / DB extension required, no SPOF
// added beyond the bot itself). The query is a single UPDATE with
// the existing `idx_mq_agent_pending` partial index covering the
// pending status, so even on a queue with millions of rows the cost
// stays bounded.

export interface QueueTtlDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface QueueTtlOptions {
  ttlHours?: number
  reason?: string
}

/**
 * One-shot sweep — moves every pending row older than `ttlHours`
 * (default 24) to status='skipped' with `failed_reason` (default
 * 'ttl_24h'). Idempotent: subsequent calls only touch rows that
 * have aged past the cutoff since the previous sweep, so running it
 * on a tight schedule is safe.
 *
 * Returns the number of rows updated, useful for observability /
 * test assertions.
 */
export async function sweepExpiredPending(
  _db: QueueTtlDb,
  _opts: QueueTtlOptions = {},
): Promise<number> {
  // v0.9: 'skipped' / failed_reason removed from schema (sub-PR 1 + 3).
  // TTL sweeper no-op until Issue #349 redesign (= audit log table).
  return 0
}

/**
 * Install a periodic sweep — call once at server start. Returns the
 * timer handle so the caller can `clearInterval` on shutdown (tests
 * use this to avoid hanging timers).
 */
export function startQueueTtlSweeper(
  db: QueueTtlDb,
  opts: QueueTtlOptions & { intervalMs?: number; onError?: (err: Error) => void } = {},
): NodeJS.Timer {
  const intervalMs = opts.intervalMs ?? 5 * 60_000  // 5 minutes
  const fire = async () => {
    try {
      const skipped = await sweepExpiredPending(db, opts)
      if (skipped > 0) {
        process.stderr.write(`agent-comms: queue ttl sweep — ${skipped} pending rows aged out (reason=${opts.reason ?? 'ttl_24h'})\n`)
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      opts.onError ? opts.onError(e) : process.stderr.write(`agent-comms: queue ttl sweep failed: ${e.message}\n`)
    }
  }
  const timer = setInterval(fire, intervalMs)
  // Kick off the first sweep on the next tick so the queue isn't
  // left holding stale rows for the first interval after boot.
  setTimeout(fire, 0).unref()
  // Unref the periodic timer too — tests / one-shot CLIs should be
  // free to exit without an explicit clearInterval.
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}
