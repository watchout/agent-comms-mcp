export const QUEUE_WORK_ENVELOPE_VERSION = 'queue_work_envelope_v1' as const
export const QUEUE_WORK_RESULT_VERSION = 'queue_work_result_v1' as const

export type LlmRuntimeInput =
  | 'stdin_prompt'
  | 'stdin_context'
  | 'sdk_messages'
  | 'jsonl_messages'

export type LlmRuntimeOutput =
  | 'text'
  | 'json'
  | 'jsonl_events'
  | 'schema_json'

export interface LlmRuntimeCapability {
  input: LlmRuntimeInput
  output: LlmRuntimeOutput
  supportsBareMode: boolean
  supportsResume: boolean
  supportsToolAllowlist: boolean
  supportsSandbox: boolean
  supportsUsageMetadata: boolean
}

export interface QueueWorkEnvelope {
  schema_version: typeof QUEUE_WORK_ENVELOPE_VERSION
  queue_id: string
  message_id: string | null
  agent_id: string
  channel: string | null
  thread_id: string | null
  requester: string | null
  content: string
  reply_contract: {
    required: boolean
    reply_to: string | null
    mention: string | null
  }
  runtime_contract: {
    do_not_call_next: true
    do_not_call_inbox: true
    return_schema: typeof QUEUE_WORK_RESULT_VERSION
  }
}

export type QueueWorkNextAction = 'reply' | 'close' | 'none' | 'retry'

export interface QueueWorkResult {
  schema_version: typeof QUEUE_WORK_RESULT_VERSION
  ok: boolean
  summary: string
  reply?: string | null
  evidence?: string[]
  next_action: QueueWorkNextAction
}

export interface LlmRuntimeAdapter {
  runtime_id: string
  capabilities: LlmRuntimeCapability
  invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult>
}

export interface QueueReplySender {
  sendReply(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    content: string
    mention: string | null
  }): Promise<{ message_id?: string | null }>
}

export interface QueueWorkDb {
  query<T = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export interface QueueWorkRow {
  id: string | number
  agent_id: string
  message_id: string | null
  payload: string
  status: string
  priority?: number | null
  created_at?: Date | string | null
  claimed_by?: string | null
  claimed_at?: Date | string | null
  claim_expires_at?: Date | string | null
}

export type QueueWorkRunOutcome =
  | {
      ok: true
      code: 'DONE'
      queue_id: string
      final_status: 'done'
      result: QueueWorkResult
    }
  | {
      ok: false
      code:
        | 'NO_RECEIVED_ROW'
        | 'INVALID_STATE'
        | 'CLAIM_NOT_OWNED'
        | 'TRANSITION_RACE'
        | 'ADAPTER_ERROR'
        | 'ADAPTER_RESULT_NOT_OK'
        | 'DONE_RACE'
      queue_id?: string
      status?: string
      detail?: string
    }

export interface RunReceivedQueueWorkOptions {
  queueId?: string | number
  agentId?: string
  adapter: LlmRuntimeAdapter
  invocationSource?: string
  /**
   * When set, only rows whose payload.receive_claim.source matches are
   * processed. Rows claimed by another path (e.g. a live TUI session calling
   * `next`) are left untouched with CLAIM_NOT_OWNED instead of being advanced.
   */
  expectedClaimSource?: string
  now?: () => Date
}

export type QueueWorkFinalizeOutcome =
  | {
      ok: true
      code: 'REPLIED' | 'CLOSED' | 'ALREADY_REPLIED'
      queue_id: string
      replied_with: string | null
    }
  | {
      ok: false
      code:
        | 'NO_DONE_ROW'
        | 'INVALID_STATE'
        | 'MISSING_RUNNER_RESULT'
        | 'MISSING_REPLY'
        | 'MISSING_REPLY_SENDER'
        | 'FINALIZE_RACE'
      queue_id?: string
      status?: string
      detail?: string
    }

export interface FinalizeDoneQueueWorkOptions {
  queueId: string | number
  replySender?: QueueReplySender
  now?: () => Date
}

function rowCount(result: { rows: unknown[]; rowCount?: number | null }): number {
  return result.rowCount ?? result.rows.length
}

function queueIdOf(row: Pick<QueueWorkRow, 'id'>): string {
  return String(row.id)
}

function parsePayload(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function resultLooksValid(value: unknown): value is QueueWorkResult {
  return (
    value &&
    typeof value === 'object' &&
    (value as QueueWorkResult).schema_version === QUEUE_WORK_RESULT_VERSION &&
    typeof (value as QueueWorkResult).ok === 'boolean' &&
    typeof (value as QueueWorkResult).summary === 'string' &&
    ['reply', 'close', 'none', 'retry'].includes((value as QueueWorkResult).next_action)
  )
}

function mergePayload(
  row: QueueWorkRow,
  key: 'runner_result' | 'runner_error',
  value: Record<string, unknown>,
): string {
  const payload = parsePayload(row.payload)
  return JSON.stringify({
    ...payload,
    [key]: value,
  })
}

export function buildQueueWorkEnvelope(row: QueueWorkRow): QueueWorkEnvelope {
  const payload = parsePayload(row.payload)
  const messageId = row.message_id ?? payload.message_id ?? null
  const requester = payload.author_id ?? payload.from ?? null
  return {
    schema_version: QUEUE_WORK_ENVELOPE_VERSION,
    queue_id: queueIdOf(row),
    message_id: messageId === null ? null : String(messageId),
    agent_id: row.agent_id,
    channel: payload.channel_id ? String(payload.channel_id) : null,
    thread_id: payload.thread_id ? String(payload.thread_id) : null,
    requester: requester === null ? null : String(requester),
    content: typeof payload.content === 'string' ? payload.content : row.payload,
    reply_contract: {
      required: payload.reply_contract?.required === false ? false : true,
      reply_to: messageId === null ? null : String(messageId),
      mention: requester === null ? null : String(requester),
    },
    runtime_contract: {
      do_not_call_next: true,
      do_not_call_inbox: true,
      return_schema: QUEUE_WORK_RESULT_VERSION,
    },
  }
}

async function selectReceivedRow(
  db: QueueWorkDb,
  opts: Pick<RunReceivedQueueWorkOptions, 'queueId' | 'agentId'>,
): Promise<QueueWorkRow | null> {
  if (opts.queueId !== undefined) {
    const selected = await db.query<QueueWorkRow>(
      `SELECT id, agent_id, message_id, payload, status, priority, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue
        WHERE id = $1
        FOR UPDATE`,
      [opts.queueId],
    )
    return selected.rows[0] ?? null
  }

  if (!opts.agentId) {
    throw new Error('runReceivedQueueWork requires queueId or agentId')
  }

  const selected = await db.query<QueueWorkRow>(
    `SELECT id, agent_id, message_id, payload, status, priority, created_at,
            claimed_by, claimed_at, claim_expires_at
       FROM message_queue
      WHERE agent_id = $1
        AND status = 'received'
      ORDER BY claimed_at ASC NULLS FIRST, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [opts.agentId],
  )
  return selected.rows[0] ?? null
}

async function persistRunnerError(
  db: QueueWorkDb,
  row: QueueWorkRow,
  adapter: LlmRuntimeAdapter,
  now: Date,
  code: string,
  detail: string,
  invocationSource?: string,
): Promise<void> {
  const payload = mergePayload(row, 'runner_error', {
    code,
    detail,
    runtime_id: adapter.runtime_id,
    invocation_source: invocationSource ?? null,
    failed_at: now.toISOString(),
  })
  await db.query(
    `UPDATE message_queue
        SET payload = $2,
            last_heartbeat_at = $3
      WHERE id = $1
        AND status = 'in_progress'`,
    [row.id, payload, now],
  ).catch(() => {})
}

export async function runReceivedQueueWork(
  db: QueueWorkDb,
  opts: RunReceivedQueueWorkOptions,
): Promise<QueueWorkRunOutcome> {
  const now = opts.now?.() ?? new Date()
  await db.query('BEGIN')
  let row: QueueWorkRow | null = null
  try {
    row = await selectReceivedRow(db, opts)
    if (!row) {
      await db.query('ROLLBACK')
      return { ok: false, code: 'NO_RECEIVED_ROW' }
    }
    if (row.status !== 'received') {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: 'INVALID_STATE',
        queue_id: queueIdOf(row),
        status: row.status,
      }
    }

    if (opts.expectedClaimSource) {
      const claimSource = parsePayload(row.payload).receive_claim?.source ?? null
      if (claimSource !== opts.expectedClaimSource) {
        await db.query('ROLLBACK')
        return {
          ok: false,
          code: 'CLAIM_NOT_OWNED',
          queue_id: queueIdOf(row),
          status: row.status,
          detail: `receive_claim.source=${claimSource ?? 'null'} expected=${opts.expectedClaimSource}`,
        }
      }
    }

    const advanced = await db.query<{ id: string | number }>(
      `UPDATE message_queue
          SET status = 'in_progress',
              last_heartbeat_at = $2
        WHERE id = $1
          AND status = 'received'
        RETURNING id`,
      [row.id, now],
    )
    if (rowCount(advanced) === 0) {
      await db.query('ROLLBACK')
      return { ok: false, code: 'TRANSITION_RACE', queue_id: queueIdOf(row) }
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }

  const envelope = buildQueueWorkEnvelope(row)
  let result: QueueWorkResult
  try {
    result = await opts.adapter.invoke(envelope)
  } catch (err) {
    await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_ERROR',
      (err as Error).message ?? String(err),
      opts.invocationSource,
    )
    return {
      ok: false,
      code: 'ADAPTER_ERROR',
      queue_id: queueIdOf(row),
      detail: (err as Error).message ?? String(err),
    }
  }

  if (!resultLooksValid(result)) {
    await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_RESULT_INVALID',
      'adapter returned a malformed queue_work_result_v1 object',
      opts.invocationSource,
    )
    return {
      ok: false,
      code: 'ADAPTER_ERROR',
      queue_id: queueIdOf(row),
      detail: 'adapter returned a malformed queue_work_result_v1 object',
    }
  }

  if (!result.ok) {
    await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_RESULT_NOT_OK',
      result.summary,
      opts.invocationSource,
    )
    return {
      ok: false,
      code: 'ADAPTER_RESULT_NOT_OK',
      queue_id: queueIdOf(row),
      detail: result.summary,
    }
  }

  const completedAt = opts.now?.() ?? new Date()
  const payload = mergePayload(row, 'runner_result', {
    ...result,
    runtime_id: opts.adapter.runtime_id,
    invocation_source: opts.invocationSource ?? null,
    completed_at: completedAt.toISOString(),
  })
  await db.query('BEGIN')
  try {
    const done = await db.query<{ id: string | number }>(
      `UPDATE message_queue
          SET status = 'done',
              done_at = $2,
              payload = $3
        WHERE id = $1
          AND status = 'in_progress'
        RETURNING id`,
      [row.id, completedAt, payload],
    )
    if (rowCount(done) === 0) {
      await db.query('ROLLBACK')
      return { ok: false, code: 'DONE_RACE', queue_id: queueIdOf(row) }
    }
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }

  return {
    ok: true,
    code: 'DONE',
    queue_id: queueIdOf(row),
    final_status: 'done',
    result,
  }
}

export async function finalizeDoneQueueWork(
  db: QueueWorkDb,
  opts: FinalizeDoneQueueWorkOptions,
): Promise<QueueWorkFinalizeOutcome> {
  const selected = await db.query<QueueWorkRow>(
    `SELECT id, agent_id, message_id, payload, status, priority, created_at,
            claimed_by, claimed_at, claim_expires_at
       FROM message_queue
      WHERE id = $1
      FOR UPDATE`,
    [opts.queueId],
  )
  const row = selected.rows[0]
  if (!row) return { ok: false, code: 'NO_DONE_ROW', queue_id: String(opts.queueId) }
  if (row.status === 'replied') {
    return {
      ok: true,
      code: 'ALREADY_REPLIED',
      queue_id: queueIdOf(row),
      replied_with: null,
    }
  }
  if (row.status !== 'done') {
    return {
      ok: false,
      code: 'INVALID_STATE',
      queue_id: queueIdOf(row),
      status: row.status,
    }
  }

  const payload = parsePayload(row.payload)
  const result = payload.runner_result as QueueWorkResult | undefined
  if (!resultLooksValid(result)) {
    return {
      ok: false,
      code: 'MISSING_RUNNER_RESULT',
      queue_id: queueIdOf(row),
    }
  }

  const closeDirectly = async (
    repliedWith: string | null,
    code: 'REPLIED' | 'CLOSED',
  ): Promise<QueueWorkFinalizeOutcome> => {
    const closedAt = opts.now?.() ?? new Date()
    const updated = await db.query<{ id: string | number }>(
      `UPDATE message_queue
          SET status = 'replied',
              replied_at = $2,
              replied_with = $3,
              claimed_by = NULL,
              claimed_at = NULL,
              claim_expires_at = NULL
        WHERE id = $1
          AND status = 'done'
        RETURNING id`,
      [row.id, closedAt, repliedWith],
    )
    if (rowCount(updated) === 0) {
      return {
        ok: false,
        code: 'FINALIZE_RACE' as const,
        queue_id: queueIdOf(row),
      }
    }
    return {
      ok: true,
      code,
      queue_id: queueIdOf(row),
      replied_with: repliedWith,
    }
  }

  if (result.next_action === 'reply') {
    if (!result.reply || result.reply.trim().length === 0) {
      return { ok: false, code: 'MISSING_REPLY', queue_id: queueIdOf(row) }
    }
    if (!opts.replySender) {
      return { ok: false, code: 'MISSING_REPLY_SENDER', queue_id: queueIdOf(row) }
    }
    const envelope = buildQueueWorkEnvelope(row)
    const sent = await opts.replySender.sendReply({
      queue_id: queueIdOf(row),
      agent_id: row.agent_id,
      message_id: row.message_id,
      content: result.reply,
      mention: envelope.reply_contract.mention,
    })
    return closeDirectly(sent.message_id ?? null, 'REPLIED')
  }

  return closeDirectly(null, 'CLOSED')
}
