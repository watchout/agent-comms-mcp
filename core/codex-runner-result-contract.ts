export const CODEX_RUNNER_RESULT_CONTRACT_VERSION = 1 as const

export const CODEX_RUNNER_RESULT_STATUSES = [
  'completed_reply',
  'completed_no_reply',
  'needs_human',
  'runtime_failed',
  'unsupported_completion',
] as const

export type CodexRunnerResultStatus = typeof CODEX_RUNNER_RESULT_STATUSES[number]

export interface CodexRunnerTypedResultContract {
  contract_version: typeof CODEX_RUNNER_RESULT_CONTRACT_VERSION
  result_status: CodexRunnerResultStatus
  retained_count: number
  queue_ids: string[]
  terminal_queue_ids: string[]
  applied_count: number
  reason_code: string
  reason: string | null
  reply_message_id?: string | null
  fail_closed: boolean
}

export interface CodexRunnerContractParseFailure {
  ok: false
  result: CodexRunnerTypedResultContract
  raw_json?: unknown
  error: string
}

export interface CodexRunnerContractParseSuccess {
  ok: true
  result: CodexRunnerTypedResultContract
  raw_json: unknown
}

export type CodexRunnerContractParseResult =
  | CodexRunnerContractParseSuccess
  | CodexRunnerContractParseFailure

type JsonRecord = Record<string, unknown>

const RESULT_STATUS_SET = new Set<string>(CODEX_RUNNER_RESULT_STATUSES)

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item))
}

function retainedCountFrom(payload: JsonRecord): number {
  if (typeof payload.retained_count === 'number' && Number.isFinite(payload.retained_count) && payload.retained_count >= 0) {
    return Math.trunc(payload.retained_count)
  }
  return Array.isArray(payload.retained) ? payload.retained.length : 0
}

function queueIdsFrom(payload: JsonRecord): string[] {
  const retained = Array.isArray(payload.retained) ? payload.retained : []
  return retained
    .map((item) => isRecord(item) ? item.queue_id : null)
    .filter((queueId): queueId is string | number => typeof queueId === 'string' || typeof queueId === 'number')
    .map((queueId) => String(queueId))
}

function reasonFrom(completion: JsonRecord | null): string | null {
  return typeof completion?.reason === 'string' && completion.reason.trim()
    ? completion.reason
    : null
}

function replyMessageIdFrom(completion: JsonRecord | null): string | null | undefined {
  if (!completion || !('reply_message_id' in completion)) return undefined
  return typeof completion.reply_message_id === 'string' ? completion.reply_message_id : null
}

export function buildCodexRunnerTypedResultContract(payload: JsonRecord): CodexRunnerTypedResultContract {
  const retainedCount = retainedCountFrom(payload)
  const completion = isRecord(payload.completion) ? payload.completion : null
  const completionOutcome = typeof completion?.outcome === 'string' ? completion.outcome : null
  const appliedCount = typeof completion?.applied_count === 'number' && Number.isFinite(completion.applied_count)
    ? Math.trunc(completion.applied_count)
    : 0
  const terminalQueueIds = toStringArray(completion?.terminal_queue_ids)
  const reason = reasonFrom(completion)
  const replyMessageId = replyMessageIdFrom(completion)

  let resultStatus: CodexRunnerResultStatus
  let reasonCode: string
  let failClosed: boolean

  if (completionOutcome === 'completed_reply') {
    resultStatus = 'completed_reply'
    reasonCode = 'completed_reply'
    failClosed = false
  } else if (completionOutcome === 'completed_no_reply') {
    resultStatus = 'completed_no_reply'
    reasonCode = 'completed_no_reply'
    failClosed = false
  } else if (completionOutcome === 'completion_failed') {
    resultStatus = 'runtime_failed'
    reasonCode = 'completion_failed'
    failClosed = true
  } else if (completionOutcome === 'open') {
    resultStatus = 'needs_human'
    reasonCode = 'final_close_required'
    failClosed = true
  } else if (completionOutcome === 'none') {
    resultStatus = 'needs_human'
    reasonCode = retainedCount > 0 ? 'final_close_required' : 'no_actionable_work'
    failClosed = true
  } else if (completionOutcome) {
    resultStatus = 'unsupported_completion'
    reasonCode = 'unsupported_completion_outcome'
    failClosed = true
  } else if (payload.ok === false) {
    resultStatus = 'runtime_failed'
    reasonCode = 'runner_failed'
    failClosed = true
  } else {
    resultStatus = 'unsupported_completion'
    reasonCode = 'runner_result_missing'
    failClosed = true
  }

  return {
    contract_version: CODEX_RUNNER_RESULT_CONTRACT_VERSION,
    result_status: resultStatus,
    retained_count: retainedCount,
    queue_ids: queueIdsFrom(payload),
    terminal_queue_ids: terminalQueueIds,
    applied_count: appliedCount,
    reason_code: reasonCode,
    reason,
    ...(replyMessageId !== undefined ? { reply_message_id: replyMessageId } : {}),
    fail_closed: failClosed,
  }
}

export function attachCodexRunnerResultContract<T extends JsonRecord>(
  payload: T,
): T & {
  result_contract_version: typeof CODEX_RUNNER_RESULT_CONTRACT_VERSION
  runner_result: CodexRunnerTypedResultContract
} {
  return {
    ...payload,
    result_contract_version: CODEX_RUNNER_RESULT_CONTRACT_VERSION,
    runner_result: buildCodexRunnerTypedResultContract(payload),
  }
}

function fallbackResult(
  resultStatus: CodexRunnerResultStatus,
  reasonCode: string,
  error: string,
): CodexRunnerTypedResultContract {
  return {
    contract_version: CODEX_RUNNER_RESULT_CONTRACT_VERSION,
    result_status: resultStatus,
    retained_count: 0,
    queue_ids: [],
    terminal_queue_ids: [],
    applied_count: 0,
    reason_code: reasonCode,
    reason: error,
    fail_closed: true,
  }
}

function validateRunnerResult(candidate: unknown): { ok: true; result: CodexRunnerTypedResultContract } | { ok: false; error: string } {
  if (!isRecord(candidate)) return { ok: false, error: 'runner_result must be an object' }
  if (candidate.contract_version !== CODEX_RUNNER_RESULT_CONTRACT_VERSION) {
    return { ok: false, error: 'runner_result contract_version is unsupported or missing' }
  }
  if (typeof candidate.result_status !== 'string' || !RESULT_STATUS_SET.has(candidate.result_status)) {
    return { ok: false, error: 'runner_result result_status is unsupported or missing' }
  }
  if (typeof candidate.retained_count !== 'number' || !Number.isFinite(candidate.retained_count) || candidate.retained_count < 0) {
    return { ok: false, error: 'runner_result retained_count must be a non-negative number' }
  }
  if (!Array.isArray(candidate.queue_ids) || !Array.isArray(candidate.terminal_queue_ids)) {
    return { ok: false, error: 'runner_result queue_ids and terminal_queue_ids must be arrays' }
  }
  const queueIds = toStringArray(candidate.queue_ids)
  const terminalQueueIds = toStringArray(candidate.terminal_queue_ids)
  if (candidate.retained_count > 0 && queueIds.length === 0) {
    return { ok: false, error: 'runner_result queue_ids are required when retained_count is positive' }
  }
  if (typeof candidate.applied_count !== 'number' || !Number.isFinite(candidate.applied_count) || candidate.applied_count < 0) {
    return { ok: false, error: 'runner_result applied_count must be a non-negative number' }
  }
  if (
    (candidate.result_status === 'completed_reply' || candidate.result_status === 'completed_no_reply')
    && (candidate.applied_count <= 0 || terminalQueueIds.length === 0)
  ) {
    return { ok: false, error: 'runner_result completed status requires applied_count and terminal_queue_ids' }
  }
  if (typeof candidate.reason_code !== 'string' || !candidate.reason_code.trim()) {
    return { ok: false, error: 'runner_result reason_code is required' }
  }
  if (typeof candidate.fail_closed !== 'boolean') {
    return { ok: false, error: 'runner_result fail_closed must be boolean' }
  }
  return {
    ok: true,
    result: {
      contract_version: CODEX_RUNNER_RESULT_CONTRACT_VERSION,
      result_status: candidate.result_status as CodexRunnerResultStatus,
      retained_count: Math.trunc(candidate.retained_count),
      queue_ids: queueIds,
      terminal_queue_ids: terminalQueueIds,
      applied_count: Math.trunc(candidate.applied_count),
      reason_code: candidate.reason_code,
      reason: typeof candidate.reason === 'string' ? candidate.reason : null,
      ...(candidate.reply_message_id === undefined
        ? {}
        : { reply_message_id: typeof candidate.reply_message_id === 'string' ? candidate.reply_message_id : null }),
      fail_closed: candidate.fail_closed,
    },
  }
}

export function parseCodexRunnerResultContract(stdout: string | undefined): CodexRunnerContractParseResult {
  if (!stdout || stdout.trim() === '') {
    const error = 'stdout is empty'
    return {
      ok: false,
      result: fallbackResult('runtime_failed', 'stdout_missing', error),
      error,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (err) {
    const error = (err as Error).message
    return {
      ok: false,
      result: fallbackResult('runtime_failed', 'stdout_parse_failed', error),
      error,
    }
  }

  if (!isRecord(parsed)) {
    const error = 'stdout JSON must be an object'
    return {
      ok: false,
      raw_json: parsed,
      result: fallbackResult('unsupported_completion', 'stdout_schema_mismatch', error),
      error,
    }
  }

  const validated = validateRunnerResult(parsed.runner_result)
  if (!validated.ok) {
    return {
      ok: false,
      raw_json: parsed,
      result: fallbackResult('unsupported_completion', 'runner_result_malformed', validated.error),
      error: validated.error,
    }
  }

  return {
    ok: true,
    raw_json: parsed,
    result: validated.result,
  }
}
