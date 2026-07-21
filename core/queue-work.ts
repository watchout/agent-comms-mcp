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
  handoff_contract: QueueWorkHandoffContract
}

export type QueueWorkNextAction = 'reply' | 'close' | 'none' | 'retry'

export type QueueWorkHandoffKind = 'plain_queue_work' | 'github_backed_role_handoff'
export type QueueWorkWritebackMode = 'none' | 'mediated'

export interface QueueWorkHandoffContract {
  kind: QueueWorkHandoffKind
  github_backed: boolean
  required_writebacks: Array<'github_issue_comment'>
  posting_mode: QueueWorkWritebackMode
  detected_from: string[]
}

export interface QueueWorkGithubIssueCommentWriteback {
  mode: 'github_issue_comment'
  repo: string
  issue_number: number
  body: string
  evidence?: string[] | null
  idempotency_key?: string | null
  body_sha256?: string | null
}

export interface QueueWorkResult {
  schema_version: typeof QUEUE_WORK_RESULT_VERSION
  ok: boolean
  summary: string
  reply?: string | null
  evidence?: string[]
  writeback?: QueueWorkGithubIssueCommentWriteback | null
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
    idempotency_key?: string | null
  }): Promise<{ message_id?: string | null }>
}

export interface QueueWorkWritebackSender {
  sendWriteback(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    handoff_contract: QueueWorkHandoffContract
    writeback: QueueWorkGithubIssueCommentWriteback
    runtime_result_summary: QueueWorkRuntimeResultSummary
  }): Promise<{ posted_with?: string | null; body_sha256?: string | null }>
}

export interface QueueWorkRuntimeResultSummary {
  ok: boolean
  summary: string
  next_action: QueueWorkNextAction
  evidence: string[]
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
      code: 'REPLIED' | 'CLOSED' | 'WRITEBACK_POSTED' | 'ALREADY_REPLIED'
      queue_id: string
      replied_with: string | null
      writeback_posted_with?: string | null
    }
  | {
      ok: false
      code:
        | 'NO_DONE_ROW'
        | 'INVALID_STATE'
        | 'MESSAGE_FENCE_MISMATCH'
        | 'MISSING_RUNNER_RESULT'
        | 'TERMINAL_EVIDENCE_INVALID'
        | 'MISSING_REPLY'
        | 'MISSING_REPLY_SENDER'
        | 'MISSING_WRITEBACK'
        | 'MISSING_WRITEBACK_SENDER'
        | 'WRITEBACK_FAILED'
        | 'RETRY_NOT_IMPLEMENTED'
        | 'FINALIZE_RACE'
      queue_id?: string
      status?: string
      detail?: string
    }

export interface FinalizeDoneQueueWorkOptions {
  queueId: string | number
  messageId?: string | null
  replySender?: QueueReplySender
  writebackSender?: QueueWorkWritebackSender
  resultValidator?: (input: {
    row: QueueWorkRow
    payload: Record<string, any>
    result: QueueWorkResult
    handoffContract: QueueWorkHandoffContract
  }) => { ok: true } | { ok: false; detail: string }
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

function payloadMessageType(payload: Record<string, any>): string | null {
  const value = payload.message_type ?? payload.type ?? null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function containsGithubIssueOrPullUrl(content: string): boolean {
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+/i.test(content)
}

function looksLikeRoleHandoff(content: string, agentId: string): boolean {
  return (
    /(?:\bL1\b|\bL2\b|\bQA\b|\bcheck\b|\baudit\b|\bhandoff\b|\bverdict\b)/i.test(content) ||
    /^(?:l1auditor|l2auditor|audit|qa|check|cto|codex-cto)$/i.test(agentId)
  )
}

export function detectQueueWorkHandoffContract(input: {
  agentId: string
  payload: string
  postingMode?: QueueWorkWritebackMode
}): QueueWorkHandoffContract {
  const payload = parsePayload(input.payload)
  const content = typeof payload.content === 'string' ? payload.content : input.payload
  const messageType = payloadMessageType(payload)
  const detectedFrom: string[] = []
  if (messageType === 'phase_handoff') detectedFrom.push('message_type:phase_handoff')
  if (containsGithubIssueOrPullUrl(content)) detectedFrom.push('github_url')
  if (looksLikeRoleHandoff(content, input.agentId)) detectedFrom.push('role_handoff_text')

  const githubBacked = (
    (messageType === 'phase_handoff' && containsGithubIssueOrPullUrl(content)) ||
    (containsGithubIssueOrPullUrl(content) && looksLikeRoleHandoff(content, input.agentId))
  )
  return {
    kind: githubBacked ? 'github_backed_role_handoff' : 'plain_queue_work',
    github_backed: githubBacked,
    required_writebacks: githubBacked ? ['github_issue_comment'] : [],
    posting_mode: input.postingMode ?? 'none',
    detected_from: detectedFrom,
  }
}

export function writebackLooksValid(value: unknown): value is QueueWorkGithubIssueCommentWriteback {
  if (value === null || value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const writeback = value as QueueWorkGithubIssueCommentWriteback
  return (
    writeback.mode === 'github_issue_comment' &&
    typeof writeback.repo === 'string' &&
    /^[^/\s]+\/[^/\s]+$/.test(writeback.repo) &&
    Number.isInteger(writeback.issue_number) &&
    writeback.issue_number > 0 &&
    typeof writeback.body === 'string' &&
    writeback.body.trim().length > 0 &&
    (
      writeback.evidence === undefined ||
      writeback.evidence === null ||
      (Array.isArray(writeback.evidence) && writeback.evidence.every((item) => typeof item === 'string'))
    ) &&
    (writeback.idempotency_key === undefined || writeback.idempotency_key === null || (typeof writeback.idempotency_key === 'string' && writeback.idempotency_key.trim().length > 0)) &&
    (writeback.body_sha256 === undefined || writeback.body_sha256 === null || (typeof writeback.body_sha256 === 'string' && /^[a-f0-9]{64}$/.test(writeback.body_sha256)))
  )
}

function resultLooksValid(value: unknown): value is QueueWorkResult {
  return (
    value &&
    typeof value === 'object' &&
    (value as QueueWorkResult).schema_version === QUEUE_WORK_RESULT_VERSION &&
    typeof (value as QueueWorkResult).ok === 'boolean' &&
    typeof (value as QueueWorkResult).summary === 'string' &&
    writebackLooksValid((value as QueueWorkResult).writeback) &&
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
    handoff_contract: detectQueueWorkHandoffContract({
      agentId: row.agent_id,
      payload: row.payload,
    }),
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
    [row.id, payload, now.toISOString()],
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
      [row.id, now.toISOString()],
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
      [row.id, completedAt.toISOString(), payload],
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
  await db.query('BEGIN')
  let committed = false
  try {
    const selected = await db.query<QueueWorkRow>(
      `SELECT id, agent_id, message_id, payload, status, priority, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue
        WHERE id = $1
        FOR UPDATE`,
      [opts.queueId],
    )
    const row = selected.rows[0]
    if (!row) {
      await db.query('ROLLBACK')
      committed = true
      return { ok: false, code: 'NO_DONE_ROW', queue_id: String(opts.queueId) }
    }
    if (row.status === 'replied') {
      await db.query('ROLLBACK')
      committed = true
      return {
        ok: true,
        code: 'ALREADY_REPLIED',
        queue_id: queueIdOf(row),
        replied_with: null,
      }
    }
    if (row.status !== 'done') {
      await db.query('ROLLBACK')
      committed = true
      return {
        ok: false,
        code: 'INVALID_STATE',
        queue_id: queueIdOf(row),
        status: row.status,
      }
    }
    if (opts.messageId !== undefined && opts.messageId !== null && String(row.message_id ?? '') !== String(opts.messageId)) {
      await db.query('ROLLBACK')
      committed = true
      return {
        ok: false,
        code: 'MESSAGE_FENCE_MISMATCH',
        queue_id: queueIdOf(row),
        detail: `message_id=${row.message_id ?? 'null'} expected=${opts.messageId}`,
      }
    }

    const payload = parsePayload(row.payload)
    const result = payload.runner_result as QueueWorkResult | undefined
    if (!resultLooksValid(result)) {
      await db.query('ROLLBACK')
      committed = true
      return {
        ok: false,
        code: 'MISSING_RUNNER_RESULT',
        queue_id: queueIdOf(row),
      }
    }

    const closeDirectly = async (
      repliedWith: string | null,
      code: 'REPLIED' | 'CLOSED' | 'WRITEBACK_POSTED',
      writebackPostedWith?: string | null,
      writebackBodySha256?: string | null,
    ): Promise<QueueWorkFinalizeOutcome> => {
      const closedAt = opts.now?.() ?? new Date()
      const nextPayload = writebackPostedWith
        ? JSON.stringify({
            ...payload,
            writeback_result: {
              posted_with: writebackPostedWith,
              body_sha256: writebackBodySha256 ?? null,
              completed_at: closedAt.toISOString(),
            },
          })
        : row.payload
      const updated = await db.query<{ id: string | number }>(
        `UPDATE message_queue
            SET status = 'replied',
                replied_at = $2,
                replied_with = $3,
                payload = $4,
                claimed_by = NULL,
                claimed_at = NULL,
                claim_expires_at = NULL
          WHERE id = $1
            AND status = 'done'
          RETURNING id`,
        [row.id, closedAt.toISOString(), repliedWith, nextPayload],
      )
      if (rowCount(updated) === 0) {
        await db.query('ROLLBACK')
        committed = true
        return {
          ok: false,
          code: 'FINALIZE_RACE' as const,
          queue_id: queueIdOf(row),
        }
      }
      await db.query('COMMIT')
      committed = true
      return {
        ok: true,
        code,
        queue_id: queueIdOf(row),
        replied_with: repliedWith,
        writeback_posted_with: writebackPostedWith,
      }
    }

    const failClosed = async (
      code: Extract<QueueWorkFinalizeOutcome, { ok: false }>['code'],
      detail?: string,
    ): Promise<QueueWorkFinalizeOutcome> => {
      const failedAt = opts.now?.() ?? new Date()
      const nextPayload = JSON.stringify({
        ...payload,
        finalizer_error: {
          code,
          detail: detail ?? null,
          failed_at: failedAt.toISOString(),
        },
      })
      await db.query(
        `UPDATE message_queue
            SET payload = $2,
                last_heartbeat_at = $3
          WHERE id = $1
            AND status = 'done'`,
        [row.id, nextPayload, failedAt.toISOString()],
      )
      await db.query('COMMIT')
      committed = true
      return { ok: false, code, queue_id: queueIdOf(row), detail }
    }

    const handoffContract = detectQueueWorkHandoffContract({
      agentId: row.agent_id,
      payload: row.payload,
    })
    const validation = opts.resultValidator?.({
      row,
      payload,
      result,
      handoffContract,
    })
    if (validation && !validation.ok) {
      return failClosed('TERMINAL_EVIDENCE_INVALID', validation.detail)
    }

    let writebackPostedWith: string | null = null
    let writebackBodySha256: string | null = null
    if (handoffContract.github_backed) {
      if (!result.writeback) {
        return failClosed('MISSING_WRITEBACK')
      }
      if (!opts.writebackSender) {
        return failClosed('MISSING_WRITEBACK_SENDER')
      }
      const sent = await opts.writebackSender.sendWriteback({
        queue_id: queueIdOf(row),
        agent_id: row.agent_id,
        message_id: row.message_id,
        handoff_contract: handoffContract,
        writeback: result.writeback,
        runtime_result_summary: {
          ok: result.ok,
          summary: result.summary,
          next_action: result.next_action,
          evidence: result.evidence ?? [],
        },
      }).catch((err) => null)
      if (!sent) {
        return failClosed('WRITEBACK_FAILED', 'mediated writeback sender failed')
      }
      const postedWith = typeof sent.posted_with === 'string' && sent.posted_with.trim().length > 0
        ? sent.posted_with.trim()
        : null
      if (!postedWith) {
        return failClosed('WRITEBACK_FAILED', 'mediated writeback sender did not return posted_with')
      }
      writebackPostedWith = postedWith
      writebackBodySha256 = sent.body_sha256 ?? result.writeback.body_sha256 ?? null
    }

    if (result.next_action === 'reply') {
      if (!result.reply || result.reply.trim().length === 0) {
        await db.query('ROLLBACK')
        committed = true
        return { ok: false, code: 'MISSING_REPLY', queue_id: queueIdOf(row) }
      }
      if (!opts.replySender) {
        await db.query('ROLLBACK')
        committed = true
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
      return closeDirectly(sent.message_id ?? null, 'REPLIED', writebackPostedWith, writebackBodySha256)
    }

    if (result.next_action === 'retry') {
      await db.query('ROLLBACK')
      committed = true
      return {
        ok: false,
        code: 'RETRY_NOT_IMPLEMENTED',
        queue_id: queueIdOf(row),
        detail: 'next_action=retry is accepted by the result schema but retry finalization is not implemented',
      }
    }

    return closeDirectly(
      writebackPostedWith,
      writebackPostedWith ? 'WRITEBACK_POSTED' : 'CLOSED',
      writebackPostedWith,
      writebackBodySha256,
    )
  } catch (err) {
    if (!committed) await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}
