import {
  finalizeDoneQueueWork,
  QUEUE_WORK_RESULT_VERSION,
  type QueueReplySender,
  type QueueWorkD1CompletionFence,
  type QueueWorkDb,
  type QueueWorkFinalizeOutcome,
  type QueueWorkResult,
  type QueueWorkWritebackSender,
} from './queue-work'

export const AUN_RUNTIME_V2_FINALIZATION_SCHEMA_VERSION = 'aun-runtime-v2-mediated-finalization/v1' as const

export const AUN_RUNTIME_V2_TERMINAL_OUTCOMES = [
  'reply',
  'handoff',
  'no_reply',
  'close',
  'fail',
] as const

export type AunRuntimeV2TerminalOutcome = typeof AUN_RUNTIME_V2_TERMINAL_OUTCOMES[number]

export interface AunRuntimeV2TerminalEvidence {
  semantic_outcome: AunRuntimeV2TerminalOutcome
  outcome_reason: string
  evidence_refs: string[]
}

export interface AunRuntimeV2FinalizationOptions {
  queueId?: string | number | null
  messageId?: string | null
  replySender?: QueueReplySender
  writebackSender?: QueueWorkWritebackSender
  d1CompletionFence?: QueueWorkD1CompletionFence
  now?: () => Date
}

export type AunRuntimeV2FinalizationErrorCode =
  | 'fence_required'
  | 'terminal_evidence_invalid'

export interface AunRuntimeV2FinalizationError {
  error: AunRuntimeV2FinalizationErrorCode
  message: string
}

export interface AunRuntimeV2FinalizationResult {
  schema_version: typeof AUN_RUNTIME_V2_FINALIZATION_SCHEMA_VERSION
  target: {
    queue_id: string
    message_id: string
  }
  terminal_evidence: AunRuntimeV2TerminalEvidence | null
  finalization: {
    finalized: boolean
    reason_code: QueueWorkFinalizeOutcome['code'] | AunRuntimeV2FinalizationErrorCode
    outcome: QueueWorkFinalizeOutcome | null
  }
  evidence_refs: string[]
}

const OUTCOME_SET = new Set<string>(AUN_RUNTIME_V2_TERMINAL_OUTCOMES)

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function queueIdString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function parseKeyValueEvidence(value: string): Partial<AunRuntimeV2TerminalEvidence> {
  const match = value.match(/^\s*(semantic_outcome|outcome_reason)\s*[:=]\s*(.+?)\s*$/u)
  if (!match) return {}
  const [, key, raw] = match
  return { [key]: raw.trim() }
}

function parseJsonEvidence(value: string): Partial<AunRuntimeV2TerminalEvidence> {
  const direct = value.trim()
  const prefixed = direct.match(/^terminal_evidence\s*[:=]\s*(\{.*\})\s*$/u)?.[1]
  const candidate = prefixed ?? (direct.startsWith('{') ? direct : null)
  if (!candidate) return {}
  try {
    const parsed = JSON.parse(candidate)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Partial<AunRuntimeV2TerminalEvidence>
  } catch {
    return {}
  }
}

export function parseAunRuntimeV2TerminalEvidence(result: QueueWorkResult): AunRuntimeV2TerminalEvidence | null {
  if (result.schema_version !== QUEUE_WORK_RESULT_VERSION) return null
  const evidence = Array.isArray(result.evidence) ? result.evidence : []
  let semanticOutcome: string | null = null
  let outcomeReason: string | null = null
  const evidenceRefs: string[] = []

  for (const item of evidence) {
    if (typeof item !== 'string' || item.trim().length === 0) continue
    const parsed = {
      ...parseKeyValueEvidence(item),
      ...parseJsonEvidence(item),
    }
    if (typeof parsed.semantic_outcome === 'string') semanticOutcome = parsed.semantic_outcome.trim()
    if (typeof parsed.outcome_reason === 'string') outcomeReason = parsed.outcome_reason.trim()
    if (Array.isArray(parsed.evidence_refs)) {
      for (const ref of parsed.evidence_refs) {
        if (typeof ref === 'string' && ref.trim().length > 0) evidenceRefs.push(ref.trim())
      }
    } else if (!('semantic_outcome' in parsed) && !('outcome_reason' in parsed)) {
      evidenceRefs.push(item.trim())
    }
  }

  if (!semanticOutcome || !OUTCOME_SET.has(semanticOutcome)) return null
  if (!outcomeReason) return null
  return {
    semantic_outcome: semanticOutcome as AunRuntimeV2TerminalOutcome,
    outcome_reason: outcomeReason,
    evidence_refs: evidenceRefs,
  }
}

export function validateAunRuntimeV2FinalizationArgs(
  opts: AunRuntimeV2FinalizationOptions,
): { ok: true; queueId: string; messageId: string } | { ok: false; error: AunRuntimeV2FinalizationError } {
  const queueId = queueIdString(opts.queueId)
  const messageId = cleanString(opts.messageId)
  if (!queueId || !messageId) {
    return {
      ok: false,
      error: {
        error: 'fence_required',
        message: 'runtime-v2 mediated finalization requires queue_id and message_id exact fence',
      },
    }
  }
  return { ok: true, queueId, messageId }
}

function errorResult(
  queueId: string,
  messageId: string,
  error: AunRuntimeV2FinalizationError,
): AunRuntimeV2FinalizationResult {
  return {
    schema_version: AUN_RUNTIME_V2_FINALIZATION_SCHEMA_VERSION,
    target: {
      queue_id: queueId,
      message_id: messageId,
    },
    terminal_evidence: null,
    finalization: {
      finalized: false,
      reason_code: error.error,
      outcome: null,
    },
    evidence_refs: [],
  }
}

export async function finalizeAunRuntimeV2MediatedQueueWork(
  db: QueueWorkDb,
  opts: AunRuntimeV2FinalizationOptions,
): Promise<AunRuntimeV2FinalizationResult | AunRuntimeV2FinalizationError> {
  const args = validateAunRuntimeV2FinalizationArgs(opts)
  if (!args.ok) return args.error

  let terminalEvidence: AunRuntimeV2TerminalEvidence | null = null
  const outcome = await finalizeDoneQueueWork(db, {
    queueId: args.queueId,
    messageId: args.messageId,
    replySender: opts.replySender,
    writebackSender: opts.writebackSender,
    d1CompletionFence: opts.d1CompletionFence,
    now: opts.now,
    resultValidator: ({ result }) => {
      terminalEvidence = parseAunRuntimeV2TerminalEvidence(result)
      if (!terminalEvidence) {
        return {
          ok: false,
          detail: 'runtime-v2 finalization requires evidence entries for semantic_outcome and outcome_reason',
        }
      }
      return { ok: true }
    },
  })

  if (outcome.code === 'MISSING_RUNNER_RESULT') {
    return errorResult(args.queueId, args.messageId, {
      error: 'terminal_evidence_invalid',
      message: 'runtime-v2 finalization requires a valid queue_work_result_v1 runner_result before terminal close',
    })
  }

  return {
    schema_version: AUN_RUNTIME_V2_FINALIZATION_SCHEMA_VERSION,
    target: {
      queue_id: args.queueId,
      message_id: args.messageId,
    },
    terminal_evidence: terminalEvidence,
    finalization: {
      finalized: outcome.ok,
      reason_code: outcome.code,
      outcome,
    },
    evidence_refs: terminalEvidence?.evidence_refs ?? [],
  }
}
