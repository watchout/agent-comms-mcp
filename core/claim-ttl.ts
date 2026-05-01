// Issue #278 (A) segment 3b — expired-claim sweeper.
//
// Per-row claim semantics (segment 3a) attach a TTL (default 30s,
// `AGENT_COMMS_CLAIM_TTL_SEC`) to each `message_queue` row when `next`
// hands it to a bot. If the bot crashes mid-turn — or the LLM exits
// without calling `send` / `skip` / `fail` — the claim is orphaned and
// the row stays in `status='read'` forever, blocking re-delivery.
//
// This sweeper is the structured replacement for the legacy priorId
// IMPLICIT_ABANDON pattern in the `next` handler (still in place, will
// be removed in segment 3c once the sweeper is verified live). Every
// 5 min (env `AGENT_COMMS_CLAIM_SWEEP_INTERVAL_MS`) it flips any
// `status='read'` row whose `claim_expires_at` is in the past to
// `status='failed', failed_reason='IMPLICIT_ABANDON'`. The partial
// index `idx_mq_expired_claims` (db/migrate.ts, segment 1) already
// covers `(claim_expires_at) WHERE claimed_by IS NOT NULL AND
// claim_expires_at IS NOT NULL AND status = 'read'`, so the sweep is
// O(expired) regardless of total queue size.
//
// Lives in-process inside `server.ts` for the same reasons as
// `core/queue-ttl.ts`: shares the bot's PG pool + lifecycle, no
// separate cron / DB extension, no SPOF beyond the bot itself.

export interface ClaimTtlDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface ClaimTtlOptions {
  reason?: string
  /**
   * PR-0 (Issue #287) cycle 7 axis 1 BLOCK fix: when set, the sweeper
   * excludes this agent's own claims from the IMPLICIT_ABANDON predicate.
   * Self-owned expired claims are reclaimed (read → pending) by
   * `core/inbox-cursor.ts:startSelfReclaimSweeper` instead, which is the
   * authoritative path for own-orphan recovery after Issue #287.
   * Without this exclusion the claim-ttl sweep races the self-reclaim
   * path on startup (claim-ttl `setTimeout(fire, 0)` fires before
   * self-reclaim) and own claims land in `failed/IMPLICIT_ABANDON`
   * instead of `pending`, defeating the restart-recovery contract.
   */
  selfAgentId?: string
}

/**
 * One-shot sweep — flips every `status='read'` row whose
 * `claim_expires_at` is in the past to `status='failed'` with
 * `failed_reason` (default 'IMPLICIT_ABANDON'). Idempotent: rows that
 * have already been flipped no longer match the predicate.
 *
 * When `opts.selfAgentId` is set, rows owned by that agent are
 * excluded (handled by self-reclaim, see Issue #287 cycle 7).
 *
 * Returns the number of rows updated, useful for observability /
 * test assertions.
 */
export async function sweepExpiredClaims(
  db: ClaimTtlDb,
  opts: ClaimTtlOptions = {},
): Promise<number> {
  const reason = opts.reason ?? 'IMPLICIT_ABANDON'
  if (opts.selfAgentId) {
    const result = await db.query(
      `UPDATE message_queue
       SET status = 'failed', failed_reason = $1
       WHERE status = 'read'
         AND claimed_by IS NOT NULL
         AND claimed_by <> $2
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < now()`,
      [reason, opts.selfAgentId],
    )
    return result.rowCount ?? 0
  }
  const result = await db.query(
    `UPDATE message_queue
     SET status = 'failed', failed_reason = $1
     WHERE status = 'read'
       AND claimed_by IS NOT NULL
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at < now()`,
    [reason],
  )
  return result.rowCount ?? 0
}

/**
 * Install a periodic claim-expiry sweep — call once at server start.
 * Returns the timer handle so the caller can `clearInterval` on
 * shutdown (tests use this to avoid hanging timers).
 */
export function startClaimTtlSweeper(
  db: ClaimTtlDb,
  opts: ClaimTtlOptions & { intervalMs?: number; onError?: (err: Error) => void } = {},
): NodeJS.Timer {
  const intervalMs = opts.intervalMs ?? 5 * 60_000  // 5 minutes
  const fire = async () => {
    try {
      const failed = await sweepExpiredClaims(db, opts)
      if (failed > 0) {
        process.stderr.write(`agent-comms: claim ttl sweep — ${failed} expired claims flipped to IMPLICIT_ABANDON\n`)
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      opts.onError ? opts.onError(e) : process.stderr.write(`agent-comms: claim ttl sweep failed: ${e.message}\n`)
    }
  }
  const timer = setInterval(fire, intervalMs)
  // Kick off the first sweep on the next tick so orphaned claims from
  // the previous bot incarnation are cleared before normal traffic.
  setTimeout(fire, 0).unref()
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}
