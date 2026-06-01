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

export interface RuntimeRunnerTypedResult {
  outcome: RuntimeRunnerOutcome
  retained_count: number | null
  queue_ids: string[]
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
  if (!stdout || stdout.trim() === '') {
    return {
      outcome: 'runtime_error',
      retained_count: null,
      queue_ids: [],
    }
  }
  try {
    const parsed = JSON.parse(stdout)
    const retained = Array.isArray(parsed?.retained) ? parsed.retained : []
    const retainedCount = typeof parsed?.retained_count === 'number'
      ? parsed.retained_count
      : retained.length
    const queueIds = retained
      .map((item: Record<string, unknown>) => item?.queue_id)
      .filter((queueId: unknown): queueId is string | number => typeof queueId === 'string' || typeof queueId === 'number')
      .map((queueId: string | number) => String(queueId))
    return {
      outcome: retainedCount > 0 ? 'claimed_work' : 'no_work',
      retained_count: retainedCount,
      queue_ids: queueIds,
      raw_json: parsed,
    }
  } catch (err) {
    return {
      outcome: 'parse_error',
      retained_count: null,
      queue_ids: [],
      parse_error: (err as Error).message,
    }
  }
}
