/**
 * Outbound queue consumer + PollingDriver (daemon-owns-outbound, FEAT-005).
 *
 * Extracted from server.ts during the FEAT-005 adapter rewrite so the
 * outbound consumer and PollingDriver (message_queue preview) share a
 * single home that the daemon entrypoint can start explicitly.
 *
 * SSOT: docs/agent-com-message-queue-spec.md §1 line 39 places the
 *       daemon in charge of PollingDriver + outbound_queue consumption.
 * Plan: docs/plans/outbound-forwarder-unification.md v5.
 *
 * Design invariants (see plan v5):
 *
 *   1. Atomic claim (§3.3): UPDATE flips `status='pending' → 'claimed'`
 *      + sets `claimed_at=now()` in one statement with
 *      FOR UPDATE SKIP LOCKED + agent_id filter. The pending→claimed
 *      transition (renamed from 'processing' in CP-3) is the single
 *      barrier that prevents two workers from observing the same row
 *      as pending.
 *
 *   2. 1 bot = 1 Discord client (§3.6): outbound send resolves the
 *      client strictly via `discordClients.get(AGENT_ID)`. No
 *      `?? discord` shared-fallback — silent substitution caused the
 *      2026-04-12 identity-misattribution incident. Rows whose bot
 *      has no client fail fast with `last_error='no_discord_client_for_agent'`.
 *
 *   3. Nonce dedup + 40062 idempotent collapse: every send carries
 *      `nonce: 'out-<row.id>'` + `enforceNonce: true` so retries of
 *      the same row collapse to one Discord post within Discord's
 *      ~5-minute nonce dedup window.
 *
 *   4. Orphan reclaim (§3.5): rows stuck at `status='claimed'` beyond
 *      OUTBOUND_ORPHAN_TIMEOUT_SEC (default 600s) are returned to
 *      `status='pending'` with `next_retry_at` scheduled via the same
 *      exponential backoff curve a transient-failure would use, so a
 *      crashed consumer's rows do not thundering-herd back.
 *
 *   5. Single-mode runtime: dual embedded/standalone mode was removed
 *      in Phase C I4. Every process is now daemon-mode; there is no
 *      `isDaemonRuntime()` gate.
 *
 * Dependency injection: `setDbGetter()` must be called once at
 * process startup to supply the `pg` client getter. Avoids an import
 * cycle with server.ts (which owns the `pg` Client).
 */
import { discordClients } from './discord-client'
import { isDuplicateNonceError } from '../core/outbound-delivery'

// ---- Dependency injection -------------------------------------------------

type DbLike = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>
}
type DbGetter = () => Promise<DbLike | null>

let getDb: DbGetter | null = null
let AGENT_ID = ''

/** Install the `pg` client getter + this process's agent id. */
export function setDbGetter(fn: DbGetter, agentId: string): void {
  getDb = fn
  AGENT_ID = agentId
}

// ---- Constants ------------------------------------------------------------

export const OUTBOUND_POLL_INTERVAL_MS = 1000
export const OUTBOUND_ORPHAN_TICK_MS = 60_000
export const OUTBOUND_BACKOFF_MAX_MS = 30_000

// Force-release the re-entrancy guard if a single tick runs longer than this.
// Observed 2026-04-13: CTO consumer wedged ~2h with rows stuck at
// `pending, attempts=0` because the guard was set and the awaited work
// never completed nor threw. Safety floor: 5s.
export const OUTBOUND_TICK_TIMEOUT_MS = Math.max(
  5_000,
  parseInt(process.env.OUTBOUND_TICK_TIMEOUT_MS ?? '60000', 10) || 60_000,
)

export const POLL_DRIVER_INTERVAL_MS = parseInt(process.env.AGENT_COM_POLL_INTERVAL_MS ?? '3000', 10)
export const POLL_DRIVER_HEARTBEAT_MS = 30_000

// Discord hard limit (platform-friendly truncation). Inlined so this
// module does not pull the full PLATFORM_LIMITS map from server.ts.
const DISCORD_CONTENT_LIMIT = 2000

function truncateForDiscord(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content
  return content.slice(0, DISCORD_CONTENT_LIMIT - 20) + '\n…(truncated)'
}

// ---- Retry / classifier ---------------------------------------------------

export function computeOutboundRetryDelayMs(attempt: number): number {
  const base = Math.min(OUTBOUND_BACKOFF_MAX_MS, 1_000 * Math.pow(2, Math.max(0, attempt - 1)))
  const jitter = Math.floor(Math.random() * 500)
  return base + jitter
}

// Pragmatic transient classifier: network / timeout / 5xx / 429 are
// retryable; everything else (4xx auth, validation, unknown channel)
// is permanent.
export function isTransientDeliveryError(err: string): boolean {
  return /timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|rate limit|\b429\b|\b5\d\d\b|HTTP 5/i.test(err)
}

// ---- PollingDriver (message_queue preview, daemon only) -------------------

export interface BufferedQueueRow {
  id: number | string
  message_id: string | null
  payload: string
  priority: number
  created_at: Date | string
}

// spec §13.5.1: MCP 標準 notification で pending 件数を client に通知。
// 本体は依然 `next` pull (spec §4.1)、件数シグナルのみ。
export type NotifyPendingFn = (waiting: number) => void | Promise<void>

export interface PollingDriverOptions {
  notifyPending?: NotifyPendingFn
}

export class PollingDriver {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private buffer: BufferedQueueRow[] = []
  private polling = false
  private notifyPending: NotifyPendingFn | null = null

  start(agentId: string, opts: PollingDriverOptions = {}): void {
    if (this.pollTimer) return
    this.notifyPending = opts.notifyPending ?? null

    this.heartbeatTimer = setInterval(async () => {
      const c = getDb ? await getDb() : null
      if (c) {
        await c.query(
          `UPDATE agents SET last_seen_at = now(),
           status = CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
           WHERE agent_id = $1`,
          [agentId],
        ).catch(() => {})
      }
    }, POLL_DRIVER_HEARTBEAT_MS)

    this.pollTimer = setInterval(() => {
      this.poll(agentId).catch(err => {
        process.stderr.write(`agent-comms: PollingDriver poll error: ${err}\n`)
      })
    }, POLL_DRIVER_INTERVAL_MS)
    process.stderr.write(
      `agent-comms: PollingDriver started (poll=${POLL_DRIVER_INTERVAL_MS}ms, heartbeat=${POLL_DRIVER_HEARTBEAT_MS}ms)\n`,
    )
  }

  stop(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    this.buffer = []
    this.notifyPending = null
  }

  shift(): BufferedQueueRow | null {
    return this.buffer.shift() ?? null
  }

  get buffered(): number {
    return this.buffer.length
  }

  private async poll(agentId: string): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const client = getDb ? await getDb() : null
      if (!client) return

      const r = await client.query(
        `SELECT id, message_id, payload, priority, created_at
         FROM message_queue
         WHERE status = 'pending' AND agent_id = $1
         ORDER BY priority DESC, created_at ASC
         LIMIT 10`,
        [agentId],
      )
      this.buffer = r.rows

      if (this.notifyPending && r.rows.length > 0) {
        // Fire-and-forget so a hung callback cannot pin `this.polling=true`
        // across ticks. The leading Promise.resolve().then() wraps sync
        // throws into rejections so .catch() handles both paths uniformly.
        // The tick returns immediately; the callback settles (or not) on
        // its own timeline.
        const cb = this.notifyPending
        Promise.resolve().then(() => cb(r.rows.length)).catch((err) => {
          process.stderr.write(`agent-comms: PollingDriver notifyPending error (non-fatal): ${err}\n`)
        })
      }
    } finally {
      this.polling = false
    }
  }
}

export const pollingDriver = new PollingDriver()

// ---- Outbound consumer ----------------------------------------------------

let outboundConsumerInterval: ReturnType<typeof setInterval> | null = null
let outboundOrphanInterval: ReturnType<typeof setInterval> | null = null
let outboundConsumerInFlight = false

export async function consumeOneOutboundRow(): Promise<void> {
  if (outboundConsumerInFlight) return
  outboundConsumerInFlight = true
  const guardTimeout = setTimeout(() => {
    outboundConsumerInFlight = false
    process.stderr.write(
      `agent-comms: outbound consumer tick exceeded ${OUTBOUND_TICK_TIMEOUT_MS}ms — force-released re-entrancy guard (hung tick still running; orphan reclaim will handle any stuck 'claimed' row)\n`,
    )
  }, OUTBOUND_TICK_TIMEOUT_MS)
  try {
    const client = getDb ? await getDb() : null
    if (!client) return

    // §3.3 Atomic claim: flip status 'pending' → 'claimed' + set claimed_at
    // + filter by agent_id so each bot only consumes rows tagged to itself.
    // FOR UPDATE SKIP LOCKED + single-statement UPDATE removes the race
    // that allowed multiple consumers to observe the same 'pending' row
    // between select and send (2026-04-12 duplicate-post incident).
    const claimed = await client.query(
      `UPDATE outbound_queue
          SET status = 'claimed', attempts = attempts + 1, claimed_at = now()
        WHERE id = (
          SELECT id FROM outbound_queue
           WHERE status = 'pending'
             AND agent_id = $1
             AND (next_retry_at IS NULL OR next_retry_at <= now())
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, message_id, channel_external_id, content,
                  mentions_display, attachments, reply_to_discord_id,
                  attempts, max_attempts, discord_message_id`,
      [AGENT_ID],
    ).catch(err => {
      process.stderr.write(`agent-comms: outbound consumer claim failed: ${err}\n`)
      return null
    })
    if (!claimed || claimed.rows.length === 0) return

    const row = claimed.rows[0]

    // `discord_message_id` is an observability column, not the front-line
    // dedup layer. Front-line dedup = (1) platform nonce + enforceNonce
    // and (2) the 40062 idempotent collapse below. This short-circuit is a
    // limited safeguard for the edge case where a row is manually moved
    // back to 'pending' after mark-sent. See spec §3.3 / §7.4.
    if (row.discord_message_id) {
      await client.query(
        `UPDATE outbound_queue SET status = 'sent', sent_at = COALESCE(sent_at, now()) WHERE id = $1`,
        [row.id],
      ).catch(() => {})
      process.stderr.write(
        `agent-comms: outbound row id=${row.id} short-circuited to sent (discord_message_id=${row.discord_message_id} already persisted)\n`,
      )
      return
    }

    // §3.6 Fallback removed: the row must be delivered by the bot whose
    // token is loaded (discordClients.get(AGENT_ID)). No shared-client
    // fallback — if the client is missing we fail the row explicitly so
    // another consumer doesn't silently re-post under the wrong identity.
    const clientForAgent = discordClients.get(AGENT_ID)
    if (!clientForAgent) {
      await client.query(
        `UPDATE outbound_queue SET status = 'failed', last_error = $1 WHERE id = $2`,
        ['no_discord_client_for_agent', row.id],
      ).catch(() => {})
      process.stderr.write(
        `agent-comms: outbound row id=${row.id} failed: no Discord client for agent ${AGENT_ID}\n`,
      )
      return
    }

    let deliveryError: string | null = null
    let discordMessageId: string | null = null
    let duplicateNonceIdempotent = false
    try {
      // nonce = "out-<row.id>" (<=25 chars). enforceNonce asks Discord to
      // dedupe posts with the same channel+nonce in the last ~5 minutes.
      // outbound_queue.id is BIGSERIAL so nonces are globally unique.
      const result = await clientForAgent.sendAdapterMessage({
        external_channel_id: row.channel_external_id,
        content: truncateForDiscord(row.content),
        nonce: `out-${row.id}`,
        enforceNonce: true,
      })
      discordMessageId = result.external_message_id ?? null
    } catch (err) {
      deliveryError = String(err).slice(0, 500)
      // 40062: Discord rejected the retry because the nonce was already
      // used. This is the exact condition nonce was added to catch: the
      // first attempt reached Discord, our HTTP response was lost, the
      // retry must NOT create a second post and MUST NOT mark the row
      // failed. We lose the Discord message_id (not returned for the
      // rejected retry) but flip to 'sent' so the consumer never re-posts.
      if (isDuplicateNonceError(err, deliveryError)) {
        duplicateNonceIdempotent = true
        deliveryError = null
        process.stderr.write(
          `agent-comms: outbound row id=${row.id} — Discord rejected duplicate nonce (code 40062), treating as idempotent success\n`,
        )
      }
    }

    if (deliveryError === null) {
      await client.query(
        `UPDATE outbound_queue SET status = 'sent', sent_at = now(), discord_message_id = $1 WHERE id = $2`,
        [discordMessageId, row.id],
      ).catch(err => {
        process.stderr.write(`agent-comms: outbound consumer mark-sent failed for id=${row.id}: ${err}\n`)
      })
      void duplicateNonceIdempotent
      return
    }

    const transient = isTransientDeliveryError(deliveryError)
    const exhausted = row.attempts >= row.max_attempts

    if (!transient || exhausted) {
      await client.query(
        `UPDATE outbound_queue SET status = 'failed', last_error = $1 WHERE id = $2`,
        [deliveryError, row.id],
      ).catch(err => {
        process.stderr.write(
          `agent-comms: outbound consumer mark-failed failed for id=${row.id}: ${err}\n`,
        )
      })
      process.stderr.write(
        `agent-comms: outbound delivery permanently failed (id=${row.id}, attempts=${row.attempts}/${row.max_attempts}, transient=${transient}): ${deliveryError}\n`,
      )
      return
    }

    // §3.4 Exponential backoff: return row to 'pending' with next_retry_at.
    const delayMs = computeOutboundRetryDelayMs(row.attempts)
    await client.query(
      `UPDATE outbound_queue
          SET status = 'pending', last_error = $1,
              next_retry_at = now() + ($2::int || ' ms')::interval,
              claimed_at = NULL
        WHERE id = $3`,
      [deliveryError, delayMs, row.id],
    ).catch(() => {})
    process.stderr.write(
      `agent-comms: outbound transient failure (id=${row.id}, attempts=${row.attempts}/${row.max_attempts}, retry in ${delayMs}ms): ${deliveryError}\n`,
    )
  } finally {
    clearTimeout(guardTimeout)
    outboundConsumerInFlight = false
  }
}

// §3.5 Orphan reclaim: rows stuck at 'claimed' beyond
// OUTBOUND_ORPHAN_TIMEOUT_SEC (default 600 — Discord nonce dedup 5 min +
// 5 min buffer) likely belong to a crashed consumer. Return them to
// 'pending' with next_retry_at honoring the regular backoff schedule.
export async function reclaimOrphanOutboundRows(): Promise<void> {
  const client = getDb ? await getDb() : null
  if (!client) return
  const timeoutSec = Math.max(30, parseInt(process.env.OUTBOUND_ORPHAN_TIMEOUT_SEC ?? '600', 10) || 600)
  try {
    // Inline SQL mirrors computeOutboundRetryDelayMs():
    //   delay = min(30s, 2^(attempts-1) s) + jitter(0..500ms).
    const res = await client.query(
      `UPDATE outbound_queue
          SET status = 'pending',
              last_error = 'orphan_reclaim',
              claimed_at = NULL,
              next_retry_at = now()
                            + LEAST(
                                interval '30 seconds',
                                (power(2, greatest(attempts - 1, 0)))::int * interval '1 second'
                              )
                            + ((random() * 500)::int || ' milliseconds')::interval
        WHERE status = 'claimed'
          AND agent_id = $1
          AND claimed_at < now() - ($2::int || ' seconds')::interval
        RETURNING id, attempts`,
      [AGENT_ID, timeoutSec],
    )
    if (res.rowCount && res.rowCount > 0) {
      process.stderr.write(
        `agent-comms: outbound orphan reclaim — ${res.rowCount} row(s) returned to pending (agent=${AGENT_ID}, timeout=${timeoutSec}s)\n`,
      )
    }
  } catch (err) {
    process.stderr.write(`agent-comms: outbound orphan reclaim failed: ${err}\n`)
  }
}

export function startOutboundConsumer(): void {
  if (process.env.OUTBOUND_QUEUE_CONSUMER === '0') {
    process.stderr.write('agent-comms: outbound queue consumer disabled via env\n')
    return
  }
  if (outboundConsumerInterval !== null) return
  outboundConsumerInterval = setInterval(() => {
    consumeOneOutboundRow().catch(err => {
      process.stderr.write(`agent-comms: outbound consumer tick error: ${err}\n`)
    })
  }, OUTBOUND_POLL_INTERVAL_MS)
  outboundOrphanInterval = setInterval(() => {
    reclaimOrphanOutboundRows().catch(err => {
      process.stderr.write(`agent-comms: outbound orphan tick error: ${err}\n`)
    })
  }, OUTBOUND_ORPHAN_TICK_MS)
  process.stderr.write(
    `agent-comms: outbound queue consumer started (tick=${OUTBOUND_POLL_INTERVAL_MS}ms, orphan_tick=${OUTBOUND_ORPHAN_TICK_MS}ms)\n`,
  )
}

export function stopOutboundConsumer(): void {
  if (outboundConsumerInterval !== null) {
    clearInterval(outboundConsumerInterval)
    outboundConsumerInterval = null
  }
  if (outboundOrphanInterval !== null) {
    clearInterval(outboundOrphanInterval)
    outboundOrphanInterval = null
  }
}
