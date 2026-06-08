import {
  parseCodexRunnerResultContract,
  type CodexRunnerResultStatus,
} from '../codex-runner-result-contract'

export const RUNTIME_RUNNER_CONTRACT_VERSION = 1 as const

export type RuntimeRunnerKind = 'codex' | 'claude'

export interface RuntimeQueueContext {
  queue_id: string
  message_id: string | null
  agent_id: string
  payload: unknown
}

export interface RuntimeBatonContext {
  conversation_id: string | null
  baton_id: string | null
  owner_agent_id: string | null
  state: string | null
}

export interface RuntimeRunnerInvocation {
  contract_version: typeof RUNTIME_RUNNER_CONTRACT_VERSION
  runtime_kind: RuntimeRunnerKind
  agent_id: string
  queue_id: string
  message_id: string | null
  requester: string | null
  database_url: string
  ack_content: string
  queue_context: RuntimeQueueContext
  baton_context: RuntimeBatonContext | null
}

export type RuntimeRunnerOutcome =
  | 'claimed_work'
  | 'no_work'
  | 'runtime_error'
  | 'parse_error'
  | 'unknown'

export type RuntimeRunnerCompletionOutcome =
  | CodexRunnerResultStatus
  | 'none'
  | 'open'
  | 'completion_failed'
  | 'unknown'

export interface RuntimeRunnerTypedResult {
  outcome: RuntimeRunnerOutcome
  retained_count: number | null
  queue_ids: string[]
  completion_outcome?: RuntimeRunnerCompletionOutcome
  terminal_queue_ids?: string[]
  completion_reason?: string | null
  raw_json?: unknown
  parse_error?: string
}

export interface RuntimeRunnerResult {
  ok: boolean
  code: number
  stdout?: string
  stderr?: string
  typed_result?: RuntimeRunnerTypedResult
}

export interface RuntimeRunnerCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface RuntimeRunnerAdapter {
  runtime_kind: RuntimeRunnerKind
  buildCommand(input: RuntimeRunnerInvocation): RuntimeRunnerCommand
  invoke(input: RuntimeRunnerInvocation): Promise<RuntimeRunnerResult>
}

export function buildRuntimeRunnerInvocation(input: {
  runtimeKind: RuntimeRunnerKind
  agentId: string
  queueId: string | number
  messageId: string | null
  requester: string | null
  databaseUrl: string
  ackContent: string
  payload?: unknown
  batonContext?: RuntimeBatonContext | null
}): RuntimeRunnerInvocation {
  const queueId = String(input.queueId)
  return {
    contract_version: RUNTIME_RUNNER_CONTRACT_VERSION,
    runtime_kind: input.runtimeKind,
    agent_id: input.agentId,
    queue_id: queueId,
    message_id: input.messageId,
    requester: input.requester,
    database_url: input.databaseUrl,
    ack_content: input.ackContent,
    queue_context: {
      queue_id: queueId,
      message_id: input.messageId,
      agent_id: input.agentId,
      payload: input.payload ?? null,
    },
    baton_context: input.batonContext ?? null,
  }
}

export function parseRuntimeRunnerStdout(stdout: string | undefined): RuntimeRunnerTypedResult {
  try {
    const parsed = parseCodexRunnerResultContract(stdout)
    if (!parsed.ok) {
      return {
        outcome: parsed.result.reason_code === 'stdout_parse_failed' ? 'parse_error' : 'runtime_error',
        retained_count: parsed.result.retained_count > 0 ? parsed.result.retained_count : null,
        queue_ids: [],
        completion_outcome: parsed.result.result_status,
        terminal_queue_ids: [],
        completion_reason: parsed.result.reason,
        raw_json: parsed.raw_json,
        parse_error: parsed.error,
      }
    }

    const result = parsed.result
    return {
      outcome: result.retained_count > 0 ? 'claimed_work' : 'no_work',
      retained_count: result.retained_count,
      queue_ids: result.queue_ids,
      completion_outcome: result.result_status,
      terminal_queue_ids: result.terminal_queue_ids,
      completion_reason: result.reason ?? result.reason_code,
      raw_json: parsed.raw_json,
    }
  } catch (err) {
    return {
      outcome: 'parse_error',
      retained_count: null,
      queue_ids: [],
      completion_outcome: 'runtime_failed',
      terminal_queue_ids: [],
      parse_error: (err as Error).message,
    }
  }
}
