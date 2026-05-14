/**
 * Send-side fanout: per-recipient `message_queue` INSERT.
 *
 * Phase 2 F cycle 2 — the CLI used to delegate fanout to the daemon via
 * `SELECT pg_notify('agent_inbox', …)`; in SQLite mode there is no daemon
 * LISTEN-ing on `agent_inbox`, so the notify payload was dropped and
 * recipients never saw the message (auditor BLOCKER on PR #224). This
 * helper replaces the pg_notify delegation with a direct INSERT so the
 * CLI is self-sufficient on either backend.
 *
 * ADR-050 (2026-05-05): legacy in-process signaling removed — wake-daemon
 * (tmux send-keys, see bin/wake-daemon.ts) is the de jure primary delivery
 * mechanism. Fanout no longer signals recipients; wake-daemon polls
 * message_queue and injects prompts to the recipient bot's LLM session.
 *
 * Matches the server.ts send-tool shape: build one canonical JSON
 * payload, insert one `message_queue` row per recipient. The ON CONFLICT
 * clause is idempotent against the partial UNIQUE index
 * `uq_mq_agent_message` so a retried fanout does not double-enqueue.
 */
export interface FanoutDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

export interface FanoutParams {
  /** agent_messages.id (UUID) of the already-persisted message. */
  messageId: string
  channelId: string
  threadId?: string | null
  authorId: string
  authorName?: string | null
  content: string
  /** Resolved `agent_id` list that the message is being delivered to. */
  recipients: string[]
  messageType?: string
  source?: string
  intent?: string
  expectResponse?: boolean
  context?: Record<string, unknown>
  /** Optional pre-rendered timestamp; defaults to `new Date().toISOString()`. */
  ts?: string
}

export interface FanoutResult {
  /** Recipients that successfully got a new `message_queue` row. */
  inserted: string[]
  /** Recipients whose INSERT was a no-op via the partial UNIQUE idempotency guard. */
  deduped: string[]
  /** Recipients whose INSERT threw (logged to stderr, non-fatal). */
  failed: string[]
}

/**
 * Insert one `message_queue` row per recipient. Errors on individual
 * recipients are logged to stderr but never throw — partial-success is
 * preferred over losing the whole fanout. wake-daemon (ADR-050 primary)
 * picks up newly-inserted rows by polling and wakes the recipient bot.
 */
export async function fanoutToRecipients(
  db: FanoutDb,
  params: FanoutParams,
): Promise<FanoutResult> {
  const mqPayload = JSON.stringify({
    channel_id: params.channelId,
    thread_id: params.threadId ?? null,
    author_id: params.authorId,
    author_name: params.authorName ?? null,
    content: params.content,
    message_id: params.messageId,
    message_type: params.messageType ?? 'chat',
    source: params.source ?? 'agent-comms',
    ts: params.ts ?? new Date().toISOString(),
  })

  const inserted: string[] = []
  const deduped: string[] = []
  const failed: string[] = []

  for (const recipient of params.recipients) {
    try {
      // `ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL`
      // targets the partial UNIQUE index `uq_mq_agent_message`. PG requires
      // the WHERE predicate match the index. SQLite (bun:sqlite) also
      // accepts this exact shape (verified), so no per-backend branching.
      const hasDisposition = params.intent !== undefined
        || params.expectResponse !== undefined
        || params.context !== undefined
      const r = hasDisposition
        ? await db.query<{ id: number | string }>(
            `INSERT INTO message_queue (agent_id, message_id, payload, intent, expect_response, context)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [
              recipient,
              params.messageId,
              mqPayload,
              params.intent ?? 'request',
              params.expectResponse ?? true,
              JSON.stringify(params.context ?? {}),
            ],
          )
        : await db.query<{ id: number | string }>(
            `INSERT INTO message_queue (agent_id, message_id, payload)
             VALUES ($1, $2, $3)
             ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [recipient, params.messageId, mqPayload],
          )
      if (r.rows.length > 0) {
        inserted.push(recipient)
      } else {
        deduped.push(recipient)
      }
    } catch (err) {
      process.stderr.write(
        `fanoutToRecipients: message_queue INSERT failed for ${recipient} (non-fatal): ${err}\n`,
      )
      failed.push(recipient)
    }
  }

  return { inserted, deduped, failed }
}
