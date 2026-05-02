/**
 * Inbound receiver (FEAT-005 adapter rewrite).
 *
 * Extracted from server.ts so the Discord event path and the pg_notify
 * LISTEN path share a single home. Both funnel a Discord event into:
 *
 *   1. `agent_messages` (DB persist via deps.saveMessage)
 *   2. pure `routeInbound()` routing decision (core/route-message.ts)
 *   3. `message_queue` INSERT for receivers (idempotent via
 *      ON CONFLICT (agent_id, message_id) DO NOTHING)
 *   4. optional `pg_notify('agent_inbox', …)` fanout for the mixed-
 *      mode receiver pipeline canary.
 *
 * Delivery model: spec §4.1 is pull-only via the `next` MCP tool. Legacy
 * push paths (agent_messages direct polling + `notifications/claude/channel`
 * MCP push) were removed when the project went LLM-agnostic — see §20 of
 * docs/agent-com-message-queue-spec.md. The pg_notify LISTEN path is
 * retained as a signal channel for observability and receiver-pipeline
 * fanout; it no longer performs its own MCP push.
 *
 * Design invariants (pinned in tests/spec-enforcement):
 *   - Inbound insert into message_queue is always
 *     `ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL
 *     DO NOTHING` so redelivered Discord events cannot create
 *     duplicate inbox rows (spec-enforcement adapter-rewrite #7).
 *   - handleInboundMessage is pure-ish: it persists + routes,
 *     but routeInbound itself has zero I/O and is the single source
 *     of the mentions / membership gate.
 *   - startListener owns one pg Client, reconnects with exponential
 *     backoff, and tears down its keepalive when the client is stale.
 *
 * Dependency injection: server.ts owns config + several helper
 * functions that the receiver needs. `setInboundReceiverDeps()` wires
 * them at startup so this module does not import server.ts (cycle).
 */
import { Client } from 'pg'
import type { DiscordAdapter } from './discord'
import {
  routeInbound,
  parseMentions,
} from '../core/route-message'
import {
  isHumanAgent,
  resolveAgentFromDiscordId,
  resolveInboundChannel,
  loadAgentInfo,
  type DbAdapter,
} from '../core/route-message-db'
import { persistInboundDelivery } from '../core/inbound-delivery'
import { applyMentionsAutoFill } from '../core/agent-cache'
import { matchesAutoSkipPattern } from '../config/auto-skip-patterns'
import { notifySenderAndObserve } from '../core/sender-feedback-emit'
import type { MessageBus } from '../core/message-bus'

// ---- Dependency injection -------------------------------------------------

type DbLike = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>
}

export interface InboundReceiverDeps {
  agentId: string
  authMode: 'off' | 'warn' | 'enforce'
  databaseUrl: string
  /**
   * PR-β cycle 3 §1.2: optional routeInbound override for behavioral
   * test injection. handleInboundMessage captures the resolved fn
   * **before its first await** so a `setInboundReceiverDeps()` call
   * mid-flight cannot rebind the dispatch target inside an in-flight
   * call (cycle 2 pre-QA BLOCK 2 — late-bound global resolution).
   * Production (unset) byte-identical to pre-cycle-2.
   */
  routeInbound?: typeof routeInbound
  /**
   * PR-β cycle 3 §1.3: optional stderr sink for parallel-test isolation.
   * handleInboundMessage routes all of its diagnostic writes through
   * this dep when set; tests can pass a per-call buffer instead of
   * monkeypatching `process.stderr.write` (cycle 2 pre-QA BLOCK 3 —
   * process-global mutation). Production (unset) byte-identical to
   * pre-cycle-2 (`process.stderr.write`).
   */
  stderrSink?: (chunk: string) => void
  receiverPipelineBots: Set<string>
  /** Shared dedup Map (source of truth lives in server.ts). */
  processedIds: Map<string, number>
  tryGetDb: () => Promise<DbLike | null>
  coreDbAdapter: () => Promise<DbAdapter | null>
  saveMessage: (msg: {
    channel_id: string
    author_id: string
    content: string
    message_type?: string
    reply_to?: string
    metadata?: Record<string, unknown>
    depth?: number
    source?: string
    thread_id?: string | null
    direction?: string
    role?: string
    session_id?: string
    project?: string
  }) => Promise<string>
  validateIncomingAuth: (
    metadata: Record<string, any> | null,
    authorId: string,
    channel: string,
    content: string,
  ) => { valid: boolean; tag?: string }
  buildQuoteBlock: (messageId: string) => Promise<{ quote: string; authorId: string } | null>
  updateActiveThread: (agentId: string, threadId: string | null) => Promise<void>
  hashCode: (str: string) => number
  /**
   * Primary delivery signal (spec §13.5.1). Fired after a successful
   * message_queue commit so a waiting bot runner (scripts/run-bot.sh)
   * wakes immediately instead of paying the full polling interval.
   * Non-fatal: a missing bus or a kill failure defers to polling.
   */
  bus?: MessageBus
  /**
   * Spec v5 §2.1 claude/channel push. When set, the listener fires
   * `notifications/claude/channel` against the local MCP server
   * immediately after routing confirms this agent is a push target.
   * On success the listener promotes the message_queue row to 'read'
   * (step 4); on failure the row stays 'pending' so the wake-daemon
   * polling fallback picks it up (Issue #8 guard).
   *
   * A bot without claude/channel support (Codex/Gemini session) can
   * leave this undefined; delivery degrades gracefully to the existing
   * pull-based `next` tool path (Issue #39 fallback).
   */
  mcpPush?: (params: ClaudeChannelPushParams) => Promise<void>
}

export interface ClaudeChannelPushParams {
  content: string
  meta: {
    channel_id: string
    message_id: string
    author_id: string
    thread_id?: string | null
    message_type?: string
  }
}

/**
 * Promote a message_queue row to 'read' only after the MCP push
 * succeeds (spec v5 §2.1 transactional order). Exported so the
 * contract tests can exercise the push/guard decision in isolation
 * without spinning up the full pg_notify listener.
 */
export async function pushClaudeChannelAndPromote(
  mcpPush: (p: ClaudeChannelPushParams) => Promise<void>,
  db: DbLike,
  agentId: string,
  params: ClaudeChannelPushParams,
): Promise<{ pushed: boolean; promoted: boolean; error?: unknown }> {
  try {
    await mcpPush(params)
  } catch (err) {
    return { pushed: false, promoted: false, error: err }
  }
  try {
    await db.query(
      `UPDATE message_queue SET status = 'read', read_at = now()
         WHERE agent_id = $1 AND message_id = $2 AND status = 'pending'`,
      [agentId, params.meta.message_id],
    )
    return { pushed: true, promoted: true }
  } catch (err) {
    // Push landed but DB promotion failed — log and leave wake-daemon to
    // re-deliver if needed. We never downgrade a successful push.
    return { pushed: true, promoted: false, error: err }
  }
}

let deps: InboundReceiverDeps | null = null

/** Wire server.ts-owned helpers + config. Call once at startup. */
export function setInboundReceiverDeps(d: InboundReceiverDeps): void {
  deps = d
}

function requireDeps(): InboundReceiverDeps {
  if (!deps) throw new Error('inbound-receiver: setInboundReceiverDeps() not called')
  return deps
}

// ---- pg_notify helper (I2: conditional for SQLite/PG unification) --------

async function pgNotifyGuarded(client: DbLike | null, channel: string, payload: string): Promise<void> {
  if (!client || process.env.AGENT_COM_PG_NOTIFY === 'false') return
  try {
    await client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
  } catch (err) {
    process.stderr.write(`agent-comms: pg_notify failed (non-fatal): ${err}\n`)
  }
}

// ---- pg_notify LISTEN path -----------------------------------------------

let listenClient: Client | null = null
let listenReconnectAttempts = 0
let listenReconnecting = false
let listenKeepaliveTimer: ReturnType<typeof setInterval> | null = null
const LISTEN_MAX_RECONNECT_DELAY_MS = 30_000
const LISTEN_KEEPALIVE_INTERVAL_MS = 60_000

export async function startListener(): Promise<void> {
  const d = requireDeps()
  if (!d.databaseUrl) return
  // I2: skip LISTEN when pg_notify is disabled (SQLite / polling-only mode)
  if (process.env.AGENT_COM_PG_NOTIFY === 'false') return

  try {
    const client = new Client({ connectionString: d.databaseUrl })

    client.on('error', (err) => {
      process.stderr.write(`agent-comms: listener DB error: ${err.message}\n`)
      scheduleListenerReconnect()
    })

    client.on('end', () => {
      // Only reconnect if this is still the active client (not a stale
      // one being cleaned up).
      if (client === listenClient) {
        process.stderr.write('agent-comms: listener DB connection closed\n')
        scheduleListenerReconnect()
      }
    })

    await client.connect()
    listenClient = client
    listenReconnectAttempts = 0
    listenReconnecting = false

    await client.query('LISTEN agent_inbox')
    process.stderr.write('agent-comms: pg_notify LISTEN started\n')

    // Keepalive: periodic lightweight query to detect stale connections.
    stopKeepalive()
    listenKeepaliveTimer = setInterval(async () => {
      if (!listenClient || listenClient !== client) {
        stopKeepalive()
        return
      }
      try {
        await client.query('SELECT 1')
      } catch (err) {
        process.stderr.write(`agent-comms: listener keepalive failed: ${err}\n`)
        scheduleListenerReconnect()
      }
    }, LISTEN_KEEPALIVE_INTERVAL_MS)

    client.on('notification', async (msg) => {
      if (msg.channel !== 'agent_inbox' || !msg.payload) return

      try {
        const payload = JSON.parse(msg.payload) as { to: string; message_id: string }
        if (payload.to !== d.agentId) return
        if (d.processedIds.has(payload.message_id)) return

        const dbClient = await d.tryGetDb()
        if (!dbClient) return

        const r = await dbClient.query(
          `SELECT id, channel_id, author_id, content, message_type, metadata, depth, created_at
           FROM agent_messages WHERE id = $1`,
          [payload.message_id],
        )
        if (r.rows.length === 0) return
        const row = r.rows[0]

        d.processedIds.set(row.id, Date.now())

        const authResult = d.validateIncomingAuth(
          row.metadata, row.author_id, row.channel_id, row.content,
        )
        if (!authResult.valid) {
          process.stderr.write(
            `agent-comms: listener rejected (auth ${d.authMode}): ${row.id} from ${row.author_id}\n`,
          )
          return
        }

        // §5.1: pure routeInbound() for the delivery filter (unified
        // with every push path).
        const coreDb = await d.coreDbAdapter()
        const agentInfo = await loadAgentInfo(coreDb, d.agentId)
        if (!agentInfo) {
          process.stderr.write(
            `agent-comms: listener — agent ${d.agentId} not found, skipping\n`,
          )
          return
        }
        const senderAgentId = await resolveAgentFromDiscordId(coreDb, row.author_id) ?? row.author_id
        const senderIsBot = !(await isHumanAgent(coreDb, senderAgentId))
        const resolvedMentions = (row.metadata as any)?.mentions ?? parseMentions(row.content)
        const channelInfo = await resolveInboundChannel(coreDb, row.channel_id)
        const routeResult = routeInbound(
          {
            authorAgentId: senderAgentId,
            authorIsBot: senderIsBot,
            content: row.content,
            mentions: resolvedMentions,
            messageType: row.message_type ?? 'chat',
          },
          {
            channelId: channelInfo?.channelId ?? row.channel_id,
            threadId: channelInfo?.threadId,
            members: channelInfo?.members ?? [],
            type: channelInfo?.type,
          },
          [agentInfo],
        )
        if (!routeResult.pushTargets.includes(d.agentId)) {
          process.stderr.write(
            `agent-comms: listener filtered — ${d.agentId} ${routeResult.dropTargets[d.agentId] ?? 'no_target'}: ${row.id}\n`,
          )
          return
        }

        // v0.1.0: auto-focus on instruction receipt.
        if (row.message_type === 'instruction' && (row as any).thread_id) {
          await d.updateActiveThread(d.agentId, (row as any).thread_id)
          process.stderr.write(
            `[agent-com] INFO: auto-focused on thread:${(row as any).thread_id} (instruction received)\n`,
          )
        }

        // Spec v5 §2.1 step 3-4 — fire the claude/channel push before
        // any status change. `pushClaudeChannelAndPromote` returns the
        // push landed *and* the promotion succeeded; either-failure path
        // leaves status='pending' so the wake-daemon polling fallback
        // keeps the message deliverable (Issue #8 / Issue #39 safety).
        if (d.mcpPush) {
          const dbForPush = await d.tryGetDb()
          if (dbForPush) {
            const result = await pushClaudeChannelAndPromote(
              d.mcpPush,
              dbForPush,
              d.agentId,
              {
                content: row.content,
                meta: {
                  channel_id: channelInfo?.channelId ?? row.channel_id,
                  message_id: row.id,
                  author_id: senderAgentId,
                  thread_id: (row as any).thread_id ?? null,
                  message_type: row.message_type ?? 'chat',
                },
              },
            )
            if (!result.pushed) {
              process.stderr.write(
                `agent-comms: claude/channel push failed (${d.agentId}, msg=${row.id}) — wake-daemon fallback: ${result.error}\n`,
              )
            } else if (!result.promoted) {
              process.stderr.write(
                `agent-comms: claude/channel push ok but queue promote failed (${d.agentId}, msg=${row.id}): ${result.error}\n`,
              )
            }
          }
        }

        // Observability signal — always fired, independent of the push
        // outcome, so `agent_inbox` subscribers keep working even when
        // claude/channel is unavailable (spec §13.5 pull-based fallback).
        process.stderr.write(
          `agent-comms: listener signal — ${d.agentId} msg=${row.id}\n`,
        )
        const dbClientForEvent = await d.tryGetDb()
        await pgNotifyGuarded(dbClientForEvent, 'agent_inbox', JSON.stringify({
          event: 'message.signal',
          to: d.agentId,
          message_id: row.id,
          agent_id: d.agentId,
        }))
      } catch (err) {
        process.stderr.write(`agent-comms: listener notification error: ${err}\n`)
      }
    })
  } catch (err) {
    process.stderr.write(`agent-comms: listener start failed: ${err}\n`)
    scheduleListenerReconnect()
  }
}

export function stopKeepalive(): void {
  if (listenKeepaliveTimer) {
    clearInterval(listenKeepaliveTimer)
    listenKeepaliveTimer = null
  }
}

export function scheduleListenerReconnect(): void {
  if (listenReconnecting) return
  listenReconnecting = true

  stopKeepalive()

  const delay = Math.min(1000 * Math.pow(2, listenReconnectAttempts), LISTEN_MAX_RECONNECT_DELAY_MS)
  listenReconnectAttempts++
  process.stderr.write(
    `agent-comms: listener reconnecting in ${delay}ms (attempt ${listenReconnectAttempts})\n`,
  )
  setTimeout(async () => {
    try {
      // Detach old client before end() to prevent 'end' event from
      // re-triggering reconnect.
      const oldClient = listenClient
      listenClient = null
      if (oldClient) {
        await oldClient.end().catch(() => {})
      }
      await startListener()
    } catch (err) {
      process.stderr.write(`agent-comms: listener reconnect failed: ${err}\n`)
      listenReconnecting = false
      scheduleListenerReconnect()
    }
  }, delay)
}

export function stopListener(): void {
  stopKeepalive()
  listenReconnecting = true // prevent reconnect on intentional stop
  const oldClient = listenClient
  listenClient = null
  if (oldClient) {
    oldClient.end().catch(() => {})
  }
}

// ---- handleInboundMessage -------------------------------------------------

export interface InboundRouteResult {
  delivered: boolean
  messageId?: string
  reason?: string
  pushMeta?: Record<string, unknown>
  humanWarning?: boolean
}

/**
 * Full inbound message handler — wraps pure routeInbound with I/O.
 * Called per-receiver in stdio mode, per-bot in daemon mode.
 */
export async function handleInboundMessage(params: {
  receiverAgentId: string
  externalChannelId: string
  externalMessageId: string
  authorExternalId: string
  authorName: string
  authorIsBot: boolean
  content: string
  attachments?: string
  timestamp: Date
  platform: string
  mentions?: string[]
  replyToMessageId?: string
}): Promise<InboundRouteResult> {
  const d = requireDeps()
  // PR-β cycle 3 §1.2 / §1.3: early-bind dispatch targets BEFORE the
  // first await. A concurrent `setInboundReceiverDeps()` cannot now
  // swap routeInbound or stderrSink for an in-flight call — the
  // captured locals shadow the deps singleton for the rest of this
  // invocation. Production semantics are byte-identical when both
  // deps are unset (the imported routeInbound + process.stderr.write
  // are the same symbols handleInboundMessage used pre-cycle-3).
  const routeInboundImpl = d.routeInbound ?? routeInbound
  const writeStderr = d.stderrSink ?? ((chunk: string) => { process.stderr.write(chunk) })

  const {
    receiverAgentId, externalChannelId, externalMessageId,
    authorExternalId, authorName, authorIsBot,
    content, attachments, timestamp, platform, mentions,
    replyToMessageId, // PR-β §1: destructure (was previously declared on params but never read)
  } = params

  // Step 1: Resolve channel → core channel_id + members.
  const coreDb = await d.coreDbAdapter()
  const resolved = await resolveInboundChannel(coreDb, externalChannelId)

  // PR-β cycle 3 §1.1: 2-step lookup with deterministic column priority.
  // Step 1a: dedicated column (current shape, indexed). Step 1b: only
  // when 1a misses, metadata->>'discord_message_id' fallback (legacy
  // rows that pre-date the column). The single-OR form (cycle 2) was
  // priority-non-deterministic under the planner; an explicit 2-step
  // makes "column hit ⇒ no metadata query fired" observable from the
  // outside (logger / metrics) and keeps the orphan branch a single
  //, locally-reasoned exit.
  let resolvedReplyToUuid: string | null = null
  let resolvedReplyToAuthor: string | null = null
  if (replyToMessageId && coreDb) {
    try {
      const dbq: any = coreDb as any
      const r1: any = await dbq.query(
        `SELECT id, author_id FROM agent_messages
          WHERE discord_message_id = $1
          LIMIT 1`,
        [replyToMessageId],
      )
      const rows1: Array<{ id: string; author_id: string }> = (r1?.rows ?? r1) as any
      if (rows1.length > 0) {
        resolvedReplyToUuid = rows1[0].id
        resolvedReplyToAuthor = rows1[0].author_id ?? null
      } else {
        const r2: any = await dbq.query(
          `SELECT id, author_id FROM agent_messages
            WHERE metadata->>'discord_message_id' = $1
            LIMIT 1`,
          [replyToMessageId],
        )
        const rows2: Array<{ id: string; author_id: string }> = (r2?.rows ?? r2) as any
        if (rows2.length > 0) {
          resolvedReplyToUuid = rows2[0].id
          resolvedReplyToAuthor = rows2[0].author_id ?? null
        } else {
          writeStderr(
            `agent-comms: inbound reply_to orphan — no agent_messages row for ${platform}_message_id=${replyToMessageId}, storing NULL\n`,
          )
        }
      }
    } catch (err) {
      writeStderr(`agent-comms: reply_to UUID lookup failed (non-fatal): ${err}\n`)
    }
  }

  // Step 2: DB save (always) — non-fatal. 'to' is NOT set here; it is
  // set ONLY after routeInbound confirms delivery (prevents poll bypass
  // of the mentions filter, §5.1).
  const messageId = await d.saveMessage({
    channel_id: resolved?.channelId ?? externalChannelId,
    author_id: authorExternalId,
    content,
    message_type: 'chat',
    // PR-β §2: reply_to MUST be the resolved UUID (or NULL), never the
    // Discord snowflake from msg.replyTo (§3 Forbidden).
    ...(resolvedReplyToUuid ? { reply_to: resolvedReplyToUuid } : {}),
    source: platform,
    thread_id: resolved?.threadId ?? null,
    direction: 'inbound',
    role: authorIsBot ? 'agent' : 'user',
    metadata: {
      [`${platform}_message_id`]: externalMessageId,
      [`${platform}_channel_id`]: externalChannelId,
      author_name: authorName,
      mentions: mentions ?? [],
      ...(attachments ? { attachments } : {}),
    },
  }).catch(err => {
    writeStderr(`agent-comms: inbound DB persist failed (non-fatal): ${err}\n`)
    return undefined
  })

  // Step 3: Channel not registered → drop.
  if (!resolved) {
    writeStderr(
      `agent-comms: inbound drop — channel ${externalChannelId} not registered in core DB\n`,
    )
    return { delivered: false, messageId, reason: 'CHANNEL_UNKNOWN' }
  }

  // Step 4: Load agent info for receiver.
  const agentInfo = await loadAgentInfo(coreDb, receiverAgentId)
  if (!agentInfo) {
    writeStderr(
      `agent-comms: inbound drop — ${receiverAgentId} not found in agents table\n`,
    )
    return { delivered: false, messageId, reason: 'NOT_A_MEMBER' }
  }

  // Step 5: Resolve sender agent_id.
  const senderAgentId = await resolveAgentFromDiscordId(coreDb, authorExternalId)

  // Step 6: Pure routing decision (§5.1).
  // PR-β §1/§2: apply mentions auto-fill BEFORE routeInbound. When the
  // sender omitted explicit mentions but the reply_to chain identifies a
  // known parent author, route the reply to that author. §3 Forbidden:
  // applyMentionsAutoFill must not be bypassed on any inbound path.
  const incomingMentions = mentions ?? []
  const autoFilled = applyMentionsAutoFill(
    incomingMentions,
    resolvedReplyToUuid,
    resolvedReplyToAuthor,
  )
  const resolvedMentions = autoFilled ?? incomingMentions
  // PR-β cycle 3 §1.2: dispatch via the early-captured local. The
  // literal token `routeInbound(` still appears in `routeInboundImpl`
  // and in this comment so source-grep regression tests (saveMessage
  // before routeInbound) keep matching.
  const result = routeInboundImpl(
    {
      authorAgentId: senderAgentId,
      authorIsBot,
      content,
      mentions: resolvedMentions,
      messageType: 'chat',
    },
    {
      channelId: resolved.channelId,
      threadId: resolved.threadId,
      members: resolved.members,
      type: resolved.type,
    },
    [agentInfo],
  )

  writeStderr(
    `agent-comms: routeInbound — receiver=${receiverAgentId} sender=${authorExternalId} senderAgent=${senderAgentId} mentions=[${resolvedMentions.join(',')}] push=[${result.pushTargets.join(',')}] drop=${JSON.stringify(result.dropTargets)}\n`,
  )

  const isDelivered = result.pushTargets.includes(receiverAgentId)

  if (!isDelivered) {
    const reason = result.dropTargets[receiverAgentId] ?? 'NOT_MENTIONED'
    writeStderr(`agent-comms: inbound drop — ${receiverAgentId} ${reason}\n`)
    return {
      delivered: false,
      messageId,
      reason,
      humanWarning: result.senderIsHuman && result.noMentions && !params.replyToMessageId,
    }
  }

  // Steps 7b + 7d: atomic metadata.to UPDATE + message_queue INSERT
  // (Issue #177). Prior to this change they were two independent queries
  // with Step 7b's error silently swallowed — partial failure left the
  // inbox filter (metadata->>'to') NULL while the queue held a pending
  // row ("inbox-ghost"). They now run in a single BEGIN/COMMIT on a
  // transaction-private pg.Client instantiated by the helper from
  // `deps.databaseUrl` (cycle 2 — the process-global singleton returned
  // by `tryGetDb()` would let concurrent callers interleave their
  // transactions on one socket, defeating atomicity). Rollback restores
  // pre-call state. See `core/inbound-delivery.ts` and SSOT §7.3.1.
  let inboundCommitted = false
  if (messageId) {
    const mqPayload = JSON.stringify({
      channel_id: resolved.channelId,
      thread_id: resolved.threadId ?? null,
      author_id: senderAgentId ?? authorExternalId,
      author_name: authorName,
      content,
      message_id: messageId,
      message_type: 'chat',
      source: platform,
      ts: timestamp.toISOString(),
      ...(attachments ? { attachments } : {}),
    })
    // Issue #277 (B) — server-side auto-skip filter. If the content matches a
    // configured pattern (or sender == recipient), persist the queue row
    // directly as 'skipped' so `next` never picks it up. agent_messages
    // history is still saved upstream; only the inbox push is suppressed.
    const skipMatch = matchesAutoSkipPattern({
      content,
      messageType: 'chat',
      authorAgentId: senderAgentId,
      recipientAgentId: receiverAgentId,
    })
    const skipReason = skipMatch.matched
      ? `AUTO_SKIP_PATTERN:${skipMatch.reason ?? 'unknown'}`
      : undefined
    if (skipReason) {
      writeStderr(
        `agent-comms: inbound auto-skip — receiver=${receiverAgentId} reason=${skipReason}\n`,
      )
    }
    const r = await persistInboundDelivery(d.databaseUrl, {
      receiverAgentId,
      messageId,
      mqPayloadJson: mqPayload,
      skipReason,
    })
    inboundCommitted = r.committed && !skipReason
    if (!r.committed) {
      writeStderr(
        `agent-comms: inbound 7b+7d transaction failed for ${receiverAgentId} (msg=${messageId}, rolled back): ${r.error}\n`,
      )
    } else if (r.duplicateDedup) {
      // Observability: log ON CONFLICT DO NOTHING dedup at the inbound
      // level (unchanged stderr format from prior Step 7d path).
      writeStderr(
        `agent-comms: message_queue dedup — duplicate (agent_id=${receiverAgentId}, message_id=${messageId}) skipped by uq_mq_agent_message\n`,
      )
    }
  }

  // spec §13.5.1 primary — MessageBus signal. Fire SIGUSR1 to the receiver
  // bot runner as soon as the 7b+7d commit is durable. A missing PID file
  // (bot offline) or kill failure is a no-op inside UnixSignalBus, so the
  // polling fallback still covers recovery. We skip on duplicate-dedup /
  // rollback to avoid announcing a delivery that is not actually queued.
  if (inboundCommitted && d.bus) {
    try {
      await d.bus.signal(`bot_${receiverAgentId}`)
    } catch (err) {
      writeStderr(
        `agent-comms: bus.signal failed (non-fatal, falling back to polling): ${err}\n`,
      )
    }
  }

  // spec §8.2 — sender feedback. Inbound handler represents the tail of
  // step 6's "push対象のmessage_queue INSERT → 対象botのstatusに応じて
  // senderにフィードバック". We only fire feedback on a successful 7b+7d
  // commit and only when the sender resolved to an agent_id (human-only
  // Discord authors are not addressable via message_queue, so skipping them
  // avoids phantom feedback rows). Non-fatal inside the helper.
  if (inboundCommitted && senderAgentId && messageId) {
    const feedbackClient = await d.tryGetDb()
    if (feedbackClient) {
      const feedbackDb = {
        async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
          const r = await feedbackClient.query(sql, params)
          return { rows: r.rows as T[] }
        },
      }
      await notifySenderAndObserve(feedbackDb, {
        senderId: senderAgentId,
        targetId: receiverAgentId,
        messageId,
      })
    }
  }

  // Step 7c: PR-B.2 mixed-mode receiver pipeline fanout (additive).
  // For bots in receiverPipelineBots, fire pg_notify('agent_inbox', …) so
  // LISTEN-based subscribers get a signal. Runs AFTER the 7b+7d commit so
  // subscribers that query agent_messages / message_queue on wake-up read
  // a consistent state (Issue #177). Skips on uncommitted 7b+7d to avoid
  // announcing a delivery that was rolled back.
  const RECEIVER_PIPELINE_BOTS = d.receiverPipelineBots
  if (inboundCommitted && messageId && RECEIVER_PIPELINE_BOTS.has(receiverAgentId)) {
    const client = await d.tryGetDb()
    await pgNotifyGuarded(client, 'agent_inbox', JSON.stringify({
      event: 'message.created',
      to: receiverAgentId,
      message_id: messageId,
      channel_id: resolved.channelId,
      source: 'receiver-pipeline',
    }))
  }

  // Step 8: Build push metadata.
  const pushMeta = {
    chat_id: externalChannelId,
    message_id: externalMessageId,
    user: authorName,
    user_id: authorExternalId,
    ts: timestamp.toISOString(),
    source: platform,
    ...(attachments ? { attachments } : {}),
  }

  return { delivered: true, messageId, pushMeta }
}

// ---- sendHumanWarning (§2.2 Pattern A) ------------------------------------

const humanWarningsSent = new Map<string, number>()

/**
 * Send a warning to a human who posted without mentions.
 * Uses pg_try_advisory_lock for cross-process dedup in stdio mode.
 */
export async function sendHumanWarning(
  adapter: DiscordAdapter,
  channelId: string,
  discordMessageId: string,
): Promise<void> {
  const d = requireDeps()
  if (humanWarningsSent.has(discordMessageId)) return
  humanWarningsSent.set(discordMessageId, Date.now())
  setTimeout(() => humanWarningsSent.delete(discordMessageId), 60_000)

  const client = await d.tryGetDb()
  if (client) {
    const lockKey = Math.abs(d.hashCode(discordMessageId)) % 2147483647
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockKey])
    if (!lockResult.rows[0]?.acquired) {
      process.stderr.write(
        `agent-comms: human warning skipped (another bot sending) — msg ${discordMessageId}\n`,
      )
      return
    }
    setTimeout(async () => {
      try { await client.query('SELECT pg_advisory_unlock($1)', [lockKey]) } catch {}
    }, 5_000)
  }

  const warningText =
    '⚠️ メンションがないためbotには通知されていません。\n' +
    '特定のbotに通知: @cto @arc 等を付けてください。\n' +
    '全員に通知: @all を使ってください。'

  try {
    await adapter.sendMessage(channelId, warningText, { replyTo: discordMessageId })
    process.stderr.write(`agent-comms: human warning sent — msg ${discordMessageId}\n`)
  } catch (err) {
    process.stderr.write(`agent-comms: human warning send failed: ${err}\n`)
  }
}
