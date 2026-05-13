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
  /**
   * PR-0 cycle 16 axis 1+3+4+5 BLOCK fix — multi-bot fleet support.
   * In factory mode (`createBotServer(botId)` / `EXPECTED_BOTS`) one
   * process hosts many bots; the single-process claim-TTL sweeper
   * must exclude *all* of them from the IMPLICIT_ABANDON predicate,
   * not just the primary `AGENT_ID`. When provided, this list takes
   * precedence over `selfAgentId` (which remains for legacy
   * single-agent callers).
   */
  selfAgentIds?: string[]
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
  // PR-0 cycle 16 — prefer the multi-bot list when provided. The
  // `selfAgentIds` array is funneled into a single SQL `<> ALL($2)`
  // predicate so all hosted bots are excluded in one pass without
  // serialising per-bot sweeps.
  if (opts.selfAgentIds && opts.selfAgentIds.length > 0) {
    // PR-0 cycle 16 — generate `NOT IN ($2, $3, ...)` dynamically so
    // both pg and SQLite accept the predicate (`<> ALL($2)` is a
    // PG-only array form). The placeholder offset starts at $2 since
    // $1 holds the failure reason.
    const placeholders = opts.selfAgentIds.map((_, i) => `$${i + 1}`).join(', ')
    const result: any = await db.query(
      `UPDATE message_queue
       SET status = 'pending'
       WHERE status = 'received'
         AND claimed_by IS NOT NULL
         AND claimed_by NOT IN (${placeholders})
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < now()
       RETURNING id`,
      [...opts.selfAgentIds],
    )
    const rc = result?.rowCount
    if (typeof rc === 'number') return rc
    return Array.isArray(result?.rows) ? result.rows.length : 0
  }
  if (opts.selfAgentId) {
    const result = await db.query(
      `UPDATE message_queue
       SET status = 'pending'
       WHERE status = 'received'
         AND claimed_by IS NOT NULL
         AND claimed_by <> $1
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < now()`,
      [opts.selfAgentId],
    )
    return result.rowCount ?? 0
  }
  const result = await db.query(
    `UPDATE message_queue
     SET status = 'pending'
     WHERE status = 'received'
       AND claimed_by IS NOT NULL
       AND claim_expires_at IS NOT NULL
       AND claim_expires_at < now()`,
    [],
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
      // PR-0 cycle 14 axis 2/3/4/5/6 BLOCK fix — fail-closed instead
      // of log-and-continue. A continuously-failing claim-TTL sweep
      // lets other agents' truly-abandoned claims pile up in
      // `status='read'`, which is the very stuck-read regression
      // this PR is supposed to prevent. Tests inject `onError` to
      // inspect; production exits with code 1 so the supervisor
      // restarts into a clean state.
      const e = err instanceof Error ? err : new Error(String(err))
      process.stderr.write(`agent-comms: claim ttl sweep FAILED: ${e.message}\n`)
      if (opts.onError) {
        opts.onError(e)
      } else {
        process.exit(1)
      }
    }
  }
  const timer = setInterval(fire, intervalMs)
  // Kick off the first sweep on the next tick so orphaned claims from
  // the previous bot incarnation are cleared before normal traffic.
  setTimeout(fire, 0).unref()
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}
