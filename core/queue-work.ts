import { createHash } from 'node:crypto'

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
  /** Finite wall-clock bound used by both the D1 owner and the adapter. */
  execution_timeout_ms?: number
  /** Production process adapters set this when AbortSignal terminates the child. */
  supportsAbort?: boolean
  invoke(envelope: QueueWorkEnvelope, opts?: { signal?: AbortSignal }): Promise<QueueWorkResult>
}

export interface QueueReplySender {
  /**
   * Some production senders own both the outbound reply and the queue close
   * in one durable transaction. The finalizer releases its row lock before
   * invoking these senders and verifies their exact close by readback.
   */
  queue_close_mode?: 'finalizer' | 'sender'
  sendReply(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    content: string
    mention: string | null
    idempotency_key?: string | null
  }): Promise<{ message_id?: string | null; queue_closed?: boolean }>
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
  readWriteback?(input: {
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
  /** SQL dialect hint for lease-fence comparisons against the database clock. */
  dialect?: 'sqlite' | 'postgres'
  query<T = any>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export function databaseClockSql(db: QueueWorkDb): string {
  return db.dialect === 'sqlite'
    ? "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    : 'clock_timestamp()'
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
  done_at?: Date | string | null
  database_now?: Date | string | null
}

export interface QueueWorkClaimFence {
  claimedBy: string
  claimedAt: string
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
        | 'CLAIM_OWNERSHIP_LOST'
        | 'TRANSITION_RACE'
        | 'EXECUTION_ABORTED'
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
  /** Exact receive-claim incarnation. When present every durable runner write is fenced by it. */
  claimFence?: QueueWorkClaimFence
  /** Fail closed unless an exact live claim can be captured before invocation. */
  requireClaimFence?: boolean
  signal?: AbortSignal
  /** Lets the execution owner stop renewal before terminal/error persistence. */
  onInvocationSettled?: () => Promise<void> | void
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
        | 'D1_COMPLETION_RECEIPT_REQUIRED'
        | 'MISSING_RUNNER_RESULT'
        | 'TERMINAL_EVIDENCE_INVALID'
        | 'MISSING_REPLY'
        | 'MISSING_REPLY_SENDER'
        | 'REPLY_SEND_FAILED'
        | 'REPLY_CLOSE_READBACK_FAILED'
        | 'MISSING_WRITEBACK'
        | 'MISSING_WRITEBACK_SENDER'
        | 'WRITEBACK_FAILED'
        | 'RETRY_NOT_IMPLEMENTED'
        | 'FINALIZE_RACE'
      queue_id?: string
      status?: string
      detail?: string
    }

export interface QueueWorkD1CompletionFence {
  invocation_key: string
  claim_key: string
  authorization_digest: string
  effect: 'internal_reply' | 'github_writeback' | 'external_send'
  receipt: string
}

export function computeQueueWorkD1ClaimKey(authorizationDigest: string, queueId: string | number): string {
  return `d1:claim:${authorizationDigest}:${String(queueId)}`
}

export function computeQueueWorkD1InvocationKey(input: {
  authorizationDigest: string
  queueId: string | number
  effect: QueueWorkD1CompletionFence['effect']
  repository: string
  controlSource: string
  adapterHeadSha: string
}): string {
  const canaryIssue = input.controlSource.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)$/)?.[1]
  if (input.effect === 'github_writeback' && canaryIssue) {
    const repositoryName = input.repository.split('/')[1]
    if (!repositoryName) throw new Error('D1_TARGET_REPOSITORY_INVALID')
    return `d1-canary:${repositoryName}:${canaryIssue}:${input.adapterHeadSha}`
  }
  return `d1:invoke:${createHash('sha256').update(
    `${input.authorizationDigest}\n${String(input.queueId)}\n${input.effect}`,
    'utf8',
  ).digest('hex')}`
}

export interface FinalizeDoneQueueWorkOptions {
  queueId: string | number
  messageId?: string | null
  d1CompletionFence?: QueueWorkD1CompletionFence
  replySender?: QueueReplySender
  writebackSender?: QueueWorkWritebackSender
  resultValidator?: (input: {
    row: QueueWorkRow
    payload: Record<string, any>
    result: QueueWorkResult
    handoffContract: QueueWorkHandoffContract
  }) => { ok: true } | { ok: false; detail: string }
  claimResultFence?: {
    expectedClaimSource: string
    expectedRuntimeId: string
  }
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function instantMs(value: unknown): number | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function exactInstantText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (value instanceof Date) return value.toISOString()
  return null
}

/**
 * Shared authorization readback for the trusted core finalizer and the CLI
 * sender.  The runner result is not authority by itself: it must match the
 * receive identity, the pre-invocation execution record, the current exact
 * claim incarnation, the durable done timestamp, and a live database lease.
 */
export function queueWorkClaimResultFenceMismatches(input: {
  row: Pick<QueueWorkRow,
    | 'id'
    | 'agent_id'
    | 'claimed_by'
    | 'claimed_at'
    | 'claim_expires_at'
    | 'done_at'
    | 'database_now'
  >
  payload: Record<string, unknown>
  expectedClaimSource: string
  expectedRuntimeId?: string
}): string[] {
  const { row, payload } = input
  const receiveClaim = recordValue(payload.receive_claim)
  const execution = recordValue(payload.queue_work_execution)
  const runnerResult = recordValue(payload.runner_result)
  const resultFence = recordValue(runnerResult.claim_fence)
  const mismatches: string[] = []
  const queueId = String(row.id)
  const claimedAtText = exactInstantText(row.claimed_at)
  const claimedAtMs = instantMs(row.claimed_at)
  const leaseMs = instantMs(row.claim_expires_at)
  const databaseNowMs = instantMs(row.database_now)
  const doneAtMs = instantMs(row.done_at)
  const completedAtMs = instantMs(runnerResult.completed_at)
  const startedAtMs = instantMs(execution.started_at)

  if (row.claimed_by !== row.agent_id) mismatches.push('claimed_by')
  if (claimedAtMs === null) mismatches.push('claimed_at')
  if (leaseMs === null || databaseNowMs === null || leaseMs <= databaseNowMs) {
    mismatches.push('claim_expires_at')
  }
  if (receiveClaim.source !== input.expectedClaimSource) mismatches.push('receive_claim.source')
  if (receiveClaim.agent_id !== row.agent_id) mismatches.push('receive_claim.agent_id')
  if (String(receiveClaim.queue_id ?? '') !== queueId) mismatches.push('receive_claim.queue_id')

  if (execution.source !== input.expectedClaimSource) mismatches.push('queue_work_execution.source')
  if (execution.agent_id !== row.agent_id) mismatches.push('queue_work_execution.agent_id')
  if (String(execution.queue_id ?? '') !== queueId) mismatches.push('queue_work_execution.queue_id')
  if (execution.claimed_by !== row.claimed_by) mismatches.push('queue_work_execution.claimed_by')
  if (exactInstantText(execution.claimed_at) !== claimedAtText) mismatches.push('queue_work_execution.claimed_at')
  if (startedAtMs === null || claimedAtMs === null || startedAtMs < claimedAtMs) {
    mismatches.push('queue_work_execution.started_at')
  }

  const expectedRuntimeId = input.expectedRuntimeId ?? (
    typeof execution.runtime_id === 'string' && execution.runtime_id.trim()
      ? execution.runtime_id
      : null
  )
  if (!expectedRuntimeId || execution.runtime_id !== expectedRuntimeId) {
    mismatches.push('queue_work_execution.runtime_id')
  }
  if (!expectedRuntimeId || runnerResult.runtime_id !== expectedRuntimeId) {
    mismatches.push('runner_result.runtime_id')
  }
  if (runnerResult.invocation_source !== input.expectedClaimSource) {
    mismatches.push('runner_result.invocation_source')
  }
  if (resultFence.claimed_by !== row.claimed_by) mismatches.push('runner_result.claim_fence.claimed_by')
  if (exactInstantText(resultFence.claimed_at) !== claimedAtText) mismatches.push('runner_result.claim_fence.claimed_at')
  if (
    completedAtMs === null
    || doneAtMs === null
    || completedAtMs !== doneAtMs
    || claimedAtMs === null
    || completedAtMs < claimedAtMs
    || startedAtMs === null
    || completedAtMs < startedAtMs
  ) {
    mismatches.push('runner_result.completed_at')
  }
  return Array.from(new Set(mismatches))
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
              claimed_by, claimed_at::text AS claimed_at, claim_expires_at
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
            claimed_by, claimed_at::text AS claimed_at, claim_expires_at
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

async function lockExactClaimRow(
  db: QueueWorkDb,
  queueId: string | number,
  claimFence: NonNullable<RunReceivedQueueWorkOptions['claimFence']>,
): Promise<boolean> {
  // PostgreSQL can evaluate a clock_timestamp() fence before waiting on the
  // UPDATE row lock. Acquire ownership first so the following statement's
  // lease check is necessarily evaluated after the wait.
  const locked = await db.query<{ id: string | number }>(
    `SELECT id
       FROM message_queue
      WHERE id = $1
        AND claimed_by = $2
        AND claimed_at = $3
      FOR UPDATE`,
    [queueId, claimFence.claimedBy, claimFence.claimedAt],
  )
  return rowCount(locked) === 1
}

async function persistRunnerError(
  db: QueueWorkDb,
  row: QueueWorkRow,
  adapter: LlmRuntimeAdapter,
  now: Date,
  code: string,
  detail: string,
  invocationSource?: string,
  claimFence?: RunReceivedQueueWorkOptions['claimFence'],
): Promise<boolean> {
  const payload = mergePayload(row, 'runner_error', {
    code,
    detail,
    runtime_id: adapter.runtime_id,
    invocation_source: invocationSource ?? null,
    failed_at: now.toISOString(),
    ...(claimFence ? {
      claim_fence: {
        claimed_by: claimFence.claimedBy,
        claimed_at: claimFence.claimedAt,
      },
    } : {}),
  })
  const params: unknown[] = [row.id, payload, now.toISOString()]
  let sql = `UPDATE message_queue
        SET payload = $2,
            last_heartbeat_at = $3
      WHERE id = $1
        AND status = 'in_progress'`
  if (claimFence) {
    params.push(claimFence.claimedBy, claimFence.claimedAt)
    sql += `
        AND claimed_by = $4
        AND claimed_at = $5
        AND claim_expires_at > ${databaseClockSql(db)}`
  }
  sql += '\n        RETURNING id'
  if (!claimFence) {
    const persisted = await db.query(sql, params).catch(() => ({ rows: [], rowCount: 0 }))
    return rowCount(persisted) === 1
  }

  let transactionOpen = false
  try {
    await db.query('BEGIN')
    transactionOpen = true
    if (!await lockExactClaimRow(db, row.id, claimFence)) {
      await db.query('ROLLBACK')
      transactionOpen = false
      return false
    }
    const persisted = await db.query(sql, params)
    if (rowCount(persisted) !== 1) {
      await db.query('ROLLBACK')
      transactionOpen = false
      return false
    }
    await db.query('COMMIT')
    transactionOpen = false
    return true
  } catch {
    if (transactionOpen) await db.query('ROLLBACK').catch(() => {})
    return false
  }
}

function executionAbortDetail(signal: AbortSignal): string {
  const reason = signal.reason
  if (reason instanceof Error) return reason.message
  return reason === undefined ? 'runtime execution aborted' : String(reason)
}

async function invokeRuntimeAdapter(
  adapter: LlmRuntimeAdapter,
  envelope: QueueWorkEnvelope,
  signal?: AbortSignal,
): Promise<QueueWorkResult> {
  if (!signal) return adapter.invoke(envelope)
  if (signal.aborted) throw new DOMException(executionAbortDetail(signal), 'AbortError')

  let removeAbortListener = () => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException(executionAbortDetail(signal), 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([adapter.invoke(envelope, { signal }), aborted])
  } finally {
    removeAbortListener()
  }
}

export async function runReceivedQueueWork(
  db: QueueWorkDb,
  opts: RunReceivedQueueWorkOptions,
): Promise<QueueWorkRunOutcome> {
  if (opts.signal?.aborted) {
    return {
      ok: false,
      code: 'EXECUTION_ABORTED',
      queue_id: opts.queueId === undefined ? undefined : String(opts.queueId),
      detail: executionAbortDetail(opts.signal),
    }
  }
  const now = opts.now?.() ?? new Date()
  await db.query('BEGIN')
  let row: QueueWorkRow | null = null
  let claimFence = opts.claimFence
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
      const receiveClaim = recordValue(parsePayload(row.payload).receive_claim)
      const claimSource = receiveClaim.source ?? null
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
      if (
        receiveClaim.agent_id !== row.agent_id
        || String(receiveClaim.queue_id ?? '') !== queueIdOf(row)
      ) {
        await db.query('ROLLBACK')
        return {
          ok: false,
          code: 'CLAIM_NOT_OWNED',
          queue_id: queueIdOf(row),
          status: row.status,
          detail: 'receive_claim agent_id/queue_id does not match selected row',
        }
      }
    }

    if (!claimFence && opts.requireClaimFence) {
      const claimedBy = typeof row.claimed_by === 'string' ? row.claimed_by : ''
      const claimedAtMs = instantMs(row.claimed_at)
      if (!claimedBy || claimedAtMs === null) {
        await db.query('ROLLBACK')
        return {
          ok: false,
          code: 'CLAIM_NOT_OWNED',
          queue_id: queueIdOf(row),
          status: row.status,
          detail: 'exact claim fence is required but the row has no claim incarnation',
        }
      }
      claimFence = {
        claimedBy,
        claimedAt: exactInstantText(row.claimed_at)!,
      }
    }
    if (claimFence && claimFence.claimedBy !== row.agent_id) {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: 'CLAIM_NOT_OWNED',
        queue_id: queueIdOf(row),
        status: row.status,
        detail: `claim fence owner=${claimFence.claimedBy} expected=${row.agent_id}`,
      }
    }

    if (opts.signal?.aborted) {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: 'EXECUTION_ABORTED',
        queue_id: queueIdOf(row),
        detail: executionAbortDetail(opts.signal),
      }
    }

    const priorPayload = parsePayload(row.payload)
    const priorRunnerError = recordValue(priorPayload.runner_error)
    const priorRunnerErrorHistory = Array.isArray(priorPayload.queue_work_runner_error_history)
      ? priorPayload.queue_work_runner_error_history.filter((entry) => (
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ))
      : []
    const executionBasePayload = { ...priorPayload }
    delete executionBasePayload.runner_error
    const runnerErrorHistory = Object.keys(priorRunnerError).length > 0
      ? [
          ...priorRunnerErrorHistory,
          {
            ...priorRunnerError,
            archived_at: now.toISOString(),
            replaced_by_claim_fence: claimFence ? {
              claimed_by: claimFence.claimedBy,
              claimed_at: claimFence.claimedAt,
            } : null,
          },
        ].slice(-16)
      : priorRunnerErrorHistory
    const executionPayload = claimFence
      ? JSON.stringify({
          ...executionBasePayload,
          ...(runnerErrorHistory.length > 0
            ? { queue_work_runner_error_history: runnerErrorHistory }
            : {}),
          queue_work_execution: {
            source: opts.invocationSource ?? null,
            agent_id: row.agent_id,
            queue_id: queueIdOf(row),
            runtime_id: opts.adapter.runtime_id,
            claimed_by: claimFence.claimedBy,
            claimed_at: claimFence.claimedAt,
            started_at: now.toISOString(),
          },
        })
      : row.payload
    const advanceParams: unknown[] = [row.id, now.toISOString(), executionPayload]
    let advanceSql = `UPDATE message_queue
          SET status = 'in_progress',
              last_heartbeat_at = $2,
              payload = $3
        WHERE id = $1
          AND status = 'received'`
    if (claimFence) {
      advanceParams.push(claimFence.claimedBy, claimFence.claimedAt)
      advanceSql += `
          AND claimed_by = $4
          AND claimed_at = $5
          AND claim_expires_at > ${databaseClockSql(db)}`
    }
    advanceSql += '\n        RETURNING id'
    const advanced = await db.query<{ id: string | number }>(advanceSql, advanceParams)
    if (rowCount(advanced) === 0) {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: claimFence ? 'CLAIM_OWNERSHIP_LOST' : 'TRANSITION_RACE',
        queue_id: queueIdOf(row),
      }
    }
    row.payload = executionPayload
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }

  const envelope = buildQueueWorkEnvelope(row)
  let result: QueueWorkResult
  try {
    result = await invokeRuntimeAdapter(opts.adapter, envelope, opts.signal)
  } catch (err) {
    await opts.onInvocationSettled?.()
    if (opts.signal?.aborted) {
      return {
        ok: false,
        code: 'EXECUTION_ABORTED',
        queue_id: queueIdOf(row),
        detail: executionAbortDetail(opts.signal),
      }
    }
    const persisted = await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_ERROR',
      (err as Error).message ?? String(err),
      opts.invocationSource,
      claimFence,
    )
    if (!persisted && claimFence) {
      return {
        ok: false,
        code: 'CLAIM_OWNERSHIP_LOST',
        queue_id: queueIdOf(row),
        detail: 'claim ownership was lost before runner error persistence',
      }
    }
    return {
      ok: false,
      code: 'ADAPTER_ERROR',
      queue_id: queueIdOf(row),
      detail: (err as Error).message ?? String(err),
    }
  }
  await opts.onInvocationSettled?.()
  if (opts.signal?.aborted) {
    return {
      ok: false,
      code: 'EXECUTION_ABORTED',
      queue_id: queueIdOf(row),
      detail: executionAbortDetail(opts.signal),
    }
  }

  if (!resultLooksValid(result)) {
    const persisted = await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_RESULT_INVALID',
      'adapter returned a malformed queue_work_result_v1 object',
      opts.invocationSource,
      claimFence,
    )
    if (!persisted && claimFence) {
      return {
        ok: false,
        code: 'CLAIM_OWNERSHIP_LOST',
        queue_id: queueIdOf(row),
        detail: 'claim ownership was lost before invalid-result persistence',
      }
    }
    return {
      ok: false,
      code: 'ADAPTER_ERROR',
      queue_id: queueIdOf(row),
      detail: 'adapter returned a malformed queue_work_result_v1 object',
    }
  }

  if (!result.ok) {
    const persisted = await persistRunnerError(
      db,
      row,
      opts.adapter,
      opts.now?.() ?? new Date(),
      'ADAPTER_RESULT_NOT_OK',
      result.summary,
      opts.invocationSource,
      claimFence,
    )
    if (!persisted && claimFence) {
      return {
        ok: false,
        code: 'CLAIM_OWNERSHIP_LOST',
        queue_id: queueIdOf(row),
        detail: 'claim ownership was lost before non-ok result persistence',
      }
    }
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
    ...(claimFence ? {
      claim_fence: {
        claimed_by: claimFence.claimedBy,
        claimed_at: claimFence.claimedAt,
      },
    } : {}),
  })
  await db.query('BEGIN')
  try {
    if (claimFence && !await lockExactClaimRow(db, row.id, claimFence)) {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: 'CLAIM_OWNERSHIP_LOST',
        queue_id: queueIdOf(row),
      }
    }
    const doneParams: unknown[] = [row.id, completedAt.toISOString(), payload]
    let doneSql = `UPDATE message_queue
          SET status = 'done',
              done_at = $2,
              payload = $3
        WHERE id = $1
          AND status = 'in_progress'`
    if (claimFence) {
      doneParams.push(claimFence.claimedBy, claimFence.claimedAt)
      doneSql += `
          AND claimed_by = $4
          AND claimed_at = $5
          AND claim_expires_at > ${databaseClockSql(db)}`
    }
    doneSql += '\n        RETURNING id'
    const done = await db.query<{ id: string | number }>(doneSql, doneParams)
    if (rowCount(done) === 0) {
      await db.query('ROLLBACK')
      return {
        ok: false,
        code: claimFence ? 'CLAIM_OWNERSHIP_LOST' : 'DONE_RACE',
        queue_id: queueIdOf(row),
      }
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
              claimed_by, claimed_at::text AS claimed_at, claim_expires_at, done_at,
              CURRENT_TIMESTAMP AS database_now
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
      const closeFence = opts.d1CompletionFence
      const closeParams: unknown[] = [
        row.id,
        closedAt.toISOString(),
        repliedWith,
        nextPayload,
        ...(closeFence ? [
          closeFence.invocation_key,
          closeFence.claim_key,
          closeFence.authorization_digest,
          closeFence.receipt,
          closeFence.effect,
        ] : []),
      ]
      let claimGuard = ''
      if (opts.claimResultFence) {
        const resultClaimFence = recordValue(result.claim_fence)
        const ownerParam = closeParams.push(resultClaimFence.claimed_by)
        const claimedAtParam = closeParams.push(resultClaimFence.claimed_at)
        claimGuard = `AND claimed_by = $${ownerParam}
            AND claimed_at = $${claimedAtParam}
            AND claim_expires_at > ${databaseClockSql(db)}`
      }
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
            ${closeFence ? `AND EXISTS (
              SELECT 1
                FROM shirube_d1_invocations i
                JOIN shirube_d1_effect_deliveries d ON d.invocation_key = i.invocation_key
               WHERE i.invocation_key = $5
                 AND i.claim_key = $6
                 AND i.authorization_digest = $7
                 AND i.effect = $9
                 AND i.status = 'completed'
                 AND d.effect = $9
                 AND d.status = 'completed'
                 AND d.receipt = $8
                 AND CASE i.effect
                       WHEN 'internal_reply' THEN i.internal_reply_receipt
                       WHEN 'github_writeback' THEN i.github_writeback_receipt
                       WHEN 'external_send' THEN i.external_send_receipt
                     END = $8
            )` : ''}
            ${claimGuard}
          RETURNING id`,
        closeParams,
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

    if (opts.claimResultFence) {
      const mismatches = queueWorkClaimResultFenceMismatches({
        row,
        payload,
        expectedClaimSource: opts.claimResultFence.expectedClaimSource,
        expectedRuntimeId: opts.claimResultFence.expectedRuntimeId,
      })
      if (mismatches.length > 0) {
        return failClosed(
          'TERMINAL_EVIDENCE_INVALID',
          `claim/result fence mismatch: ${mismatches.join(', ')}`,
        )
      }
    }

    const handoffContract = detectQueueWorkHandoffContract({
      agentId: row.agent_id,
      payload: row.payload,
    })
    let d1CompletedReceipt: string | null = null
    const d1Binding = payload.shirube_v4_d1
    if (d1Binding && typeof d1Binding === 'object' && !Array.isArray(d1Binding)) {
      const fence = opts.d1CompletionFence
      const bindingDigest = typeof d1Binding.authorization?.authorization_digest === 'string'
        ? d1Binding.authorization.authorization_digest
        : null
      const expectedEffects: QueueWorkD1CompletionFence['effect'][] = []
      if (handoffContract.github_backed && result.writeback) expectedEffects.push('github_writeback')
      if (result.next_action === 'reply' && typeof result.reply === 'string' && result.reply.trim()) {
        expectedEffects.push(d1Binding.external_event ? 'external_send' : 'internal_reply')
      }
      const expectedEffect = expectedEffects.length === 1 ? expectedEffects[0]! : null
      const targetRepository = typeof d1Binding.target?.repository === 'string'
        ? d1Binding.target.repository
        : null
      const targetControlSource = typeof d1Binding.target?.control_source === 'string'
        ? d1Binding.target.control_source
        : null
      const adapterHeadSha = typeof d1Binding.activation_evidence?.adapter_head_sha === 'string'
        ? d1Binding.activation_evidence.adapter_head_sha
        : null
      const expectedClaimKey = bindingDigest
        ? computeQueueWorkD1ClaimKey(bindingDigest, row.id)
        : null
      const expectedInvocationKey = bindingDigest && expectedEffect && targetRepository && targetControlSource && adapterHeadSha
        ? computeQueueWorkD1InvocationKey({
            authorizationDigest: bindingDigest,
            queueId: row.id,
            effect: expectedEffect,
            repository: targetRepository,
            controlSource: targetControlSource,
            adapterHeadSha,
          })
        : null
      if (
        !fence
        || !fence.invocation_key
        || !fence.claim_key
        || !fence.authorization_digest
        || !fence.receipt
        || fence.authorization_digest !== bindingDigest
        || fence.claim_key !== expectedClaimKey
        || fence.effect !== expectedEffect
        || fence.invocation_key !== expectedInvocationKey
        || !Array.isArray(d1Binding.allowed_effects)
        || !d1Binding.allowed_effects.includes(expectedEffect)
      ) {
        return failClosed(
          'D1_COMPLETION_RECEIPT_REQUIRED',
          'D1 queue work requires the current queue claim, selected effect, invocation, and completed receipt before final close',
        )
      }
      const completed = await db.query<{
        invocation_key: string
        claim_key: string
        authorization_digest: string
        invocation_effect: QueueWorkD1CompletionFence['effect']
        invocation_status: string
        internal_reply_receipt: string | null
        github_writeback_receipt: string | null
        external_send_receipt: string | null
        delivery_effect: QueueWorkD1CompletionFence['effect']
        delivery_status: string
        delivery_receipt: string | null
      }>(
        `SELECT i.invocation_key, i.claim_key, i.authorization_digest,
                i.effect AS invocation_effect, i.status AS invocation_status,
                i.internal_reply_receipt, i.github_writeback_receipt, i.external_send_receipt,
                d.effect AS delivery_effect, d.status AS delivery_status,
                d.receipt AS delivery_receipt
           FROM shirube_d1_invocations i
           JOIN shirube_d1_effect_deliveries d ON d.invocation_key = i.invocation_key
          WHERE i.invocation_key = $1
            AND i.claim_key = $2
            AND i.authorization_digest = $3
            AND i.effect = $4
            AND d.effect = $4`,
        [fence.invocation_key, fence.claim_key, fence.authorization_digest, fence.effect],
      )
      const receiptRow = completed.rows[0]
      const invocationReceipt = fence.effect === 'internal_reply'
        ? receiptRow?.internal_reply_receipt
        : fence.effect === 'github_writeback'
          ? receiptRow?.github_writeback_receipt
          : receiptRow?.external_send_receipt
      if (
        completed.rows.length !== 1
        || receiptRow?.invocation_status !== 'completed'
        || receiptRow?.delivery_status !== 'completed'
        || receiptRow?.invocation_effect !== fence.effect
        || receiptRow?.delivery_effect !== fence.effect
        || invocationReceipt !== fence.receipt
        || receiptRow?.delivery_receipt !== fence.receipt
      ) {
        return failClosed(
          'D1_COMPLETION_RECEIPT_REQUIRED',
          'D1 invocation and effect delivery must both contain the same completed receipt before final close',
        )
      }
      d1CompletedReceipt = fence.receipt
    }

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
      if (d1CompletedReceipt) {
        // D1 already performed and durably recorded the selected effect before
        // this row lock was acquired. Final close consumes only that DB receipt
        // and must never call a network-capable sender under the transaction.
        writebackPostedWith = d1CompletedReceipt
        writebackBodySha256 = result.writeback.body_sha256 ?? null
      } else {
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
    }

    if (result.next_action === 'reply') {
      if (!result.reply || result.reply.trim().length === 0) {
        await db.query('ROLLBACK')
        committed = true
        return { ok: false, code: 'MISSING_REPLY', queue_id: queueIdOf(row) }
      }
      if (!d1CompletedReceipt && !opts.replySender) {
        await db.query('ROLLBACK')
        committed = true
        return { ok: false, code: 'MISSING_REPLY_SENDER', queue_id: queueIdOf(row) }
      }
      if (d1CompletedReceipt) {
        return closeDirectly(d1CompletedReceipt, 'REPLIED', writebackPostedWith, writebackBodySha256)
      }
      if (opts.replySender!.queue_close_mode === 'sender') {
        // The production CLI sender closes the exact queue row atomically with
        // its reply. Release this transaction's FOR UPDATE lock first; keeping
        // it while spawning the CLI would deadlock the second connection.
        await db.query('COMMIT')
        committed = true
        let sent: { message_id?: string | null; queue_closed?: boolean }
        try {
          sent = await opts.replySender!.sendReply({
            queue_id: queueIdOf(row),
            agent_id: row.agent_id,
            message_id: row.message_id,
            content: result.reply,
            mention: buildQueueWorkEnvelope(row).reply_contract.mention,
          })
        } catch (err) {
          await db.query('BEGIN')
          committed = false
          return failClosed('REPLY_SEND_FAILED', (err as Error).message ?? String(err))
        }

        await db.query('BEGIN')
        committed = false
        const readback = await db.query<Pick<QueueWorkRow, 'id' | 'status'> & { replied_with?: string | null }>(
          `SELECT id, agent_id, message_id, payload, status, priority, created_at,
                  claimed_by, claimed_at, claim_expires_at, replied_with
             FROM message_queue
            WHERE id = $1
            FOR UPDATE`,
          [row.id],
        )
        const closed = readback.rows[0]
        const sentMessageId = sent.message_id ?? null
        if (
          sent.queue_closed !== true
          || !closed
          || closed.status !== 'replied'
          || !sentMessageId
          || closed.replied_with !== sentMessageId
        ) {
          if (closed?.status === 'done') {
            return failClosed(
              'REPLY_CLOSE_READBACK_FAILED',
              `sender close readback mismatch: status=${closed.status} replied_with=${closed.replied_with ?? 'null'} sent=${sentMessageId ?? 'null'}`,
            )
          }
          await db.query('ROLLBACK')
          committed = true
          return {
            ok: false,
            code: 'REPLY_CLOSE_READBACK_FAILED',
            queue_id: queueIdOf(row),
            detail: `sender close readback mismatch: status=${closed?.status ?? 'missing'} replied_with=${closed?.replied_with ?? 'null'} sent=${sentMessageId ?? 'null'}`,
          }
        }
        await db.query('COMMIT')
        committed = true
        return {
          ok: true,
          code: 'REPLIED',
          queue_id: queueIdOf(row),
          replied_with: sentMessageId,
          writeback_posted_with: writebackPostedWith,
        }
      }
      const envelope = buildQueueWorkEnvelope(row)
      const sent = await opts.replySender!.sendReply({
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
