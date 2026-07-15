// AUN V2 exact-canary mechanism.
//
// One process handles one exact V1 tuple. It never imports a production
// runtime adapter, model SDK, outbox dispatcher, provider, or daemon loop.

import { PgAdapter } from '../../core/db/pg-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  closeExactAnsweredV1Row,
  ExactV1TupleMismatchError,
  importExactPendingV1Row,
  readExactPendingV1Row,
  type ExactV1QueueTuple,
} from '../../core/eventlog/v1-import'
import { claimExactTurn, recoverExactTurnClaim } from '../../core/eventlog/turns'
import { runExactTurnWorkerOnce, type TurnRuntime } from '../../core/eventlog/worker'

export const EXACT_CANARY_SCHEMA_VERSION = 'aun-v2-exact-canary/v1' as const
export const PLANNED_CRASH_EXIT_CODE = 86
export const ARGUMENT_ERROR_EXIT_CODE = 64

export type ExactCanaryPhase = 'negative' | 'crash-after-claim' | 'resume'

export interface ExactCanaryArgs extends ExactV1QueueTuple {
  phase: ExactCanaryPhase
  runtime: 'deterministic-no-reply'
  providerDispatch: 'disabled'
  maxTurns: 1
}

export class ExactCanaryArgumentError extends Error {
  readonly code = 'EXACT_CANARY_ARGUMENT_ERROR' as const
}

export class ExactCanaryNegativePhaseError extends Error {
  readonly code = 'EXACT_CANARY_NEGATIVE_PHASE' as const
  constructor(
    message: string,
    readonly result: { tupleMatched: boolean; mutations: 0; runtimeCalls: 0; providerEffects: 0 },
  ) {
    super(message)
  }
}

export class PlannedCrashAfterClaimError extends Error {
  readonly code = 'EXACT_CANARY_PLANNED_CRASH_AFTER_CLAIM' as const
  constructor(
    readonly result: {
      turnId: string
      claimEventId: string
      claimEpoch: number
      exitCode: typeof PLANNED_CRASH_EXIT_CODE
    },
  ) {
    super(`planned crash after durable exact claim ${result.claimEventId}`)
  }
}

const HELP = `Usage:
  DATABASE_URL=<postgres-url> bun bin/aun/v2-exact-canary.ts \\
    --seat aun \\
    --queue-id <decimal> \\
    --message-id <uuid> \\
    --created-after <RFC3339> \\
    --phase <negative|crash-after-claim|resume> \\
    --runtime deterministic-no-reply \\
    --provider-dispatch disabled \\
    --max-turns 1

One-shot exact-target mechanism. No polling, model, provider dispatch, or daemon reuse.
`

export function exactCanaryHelp(): string {
  return HELP
}

const REQUIRED_FLAGS = [
  '--seat',
  '--queue-id',
  '--message-id',
  '--created-after',
  '--phase',
  '--runtime',
  '--provider-dispatch',
  '--max-turns',
] as const

export function parseExactCanaryArgs(argv: string[]): { help: true } | { help: false; args: ExactCanaryArgs } {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true }
  if (argv.includes('--help') || argv.includes('-h')) {
    throw new ExactCanaryArgumentError('--help cannot be combined with execution arguments')
  }
  if (argv.length % 2 !== 0) throw new ExactCanaryArgumentError('every flag requires exactly one value')

  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!(REQUIRED_FLAGS as readonly string[]).includes(flag)) {
      throw new ExactCanaryArgumentError(`unknown argument: ${flag}`)
    }
    if (values.has(flag)) throw new ExactCanaryArgumentError(`duplicate argument: ${flag}`)
    if (!value || value.startsWith('--')) throw new ExactCanaryArgumentError(`missing value for ${flag}`)
    values.set(flag, value)
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!values.has(flag)) throw new ExactCanaryArgumentError(`missing required argument: ${flag}`)
  }

  const seat = values.get('--seat')!
  if (seat !== 'aun') throw new ExactCanaryArgumentError('--seat must be the literal aun')
  const queueText = values.get('--queue-id')!
  if (!/^[1-9][0-9]*$/.test(queueText)) throw new ExactCanaryArgumentError('--queue-id must be a positive decimal')
  const queueId = Number(queueText)
  if (!Number.isSafeInteger(queueId)) throw new ExactCanaryArgumentError('--queue-id exceeds safe integer range')
  const messageId = values.get('--message-id')!
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(messageId)) {
    throw new ExactCanaryArgumentError('--message-id must be a UUID')
  }
  const createdAfter = values.get('--created-after')!
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAfter) ||
    Number.isNaN(Date.parse(createdAfter))
  ) {
    throw new ExactCanaryArgumentError('--created-after must be RFC3339')
  }
  const phase = values.get('--phase')!
  if (phase !== 'negative' && phase !== 'crash-after-claim' && phase !== 'resume') {
    throw new ExactCanaryArgumentError('--phase must be negative, crash-after-claim, or resume')
  }
  if (values.get('--runtime') !== 'deterministic-no-reply') {
    throw new ExactCanaryArgumentError('--runtime must be deterministic-no-reply')
  }
  if (values.get('--provider-dispatch') !== 'disabled') {
    throw new ExactCanaryArgumentError('--provider-dispatch must be disabled')
  }
  if (values.get('--max-turns') !== '1') {
    throw new ExactCanaryArgumentError('--max-turns must be the literal 1')
  }

  return {
    help: false,
    args: {
      seatId: 'aun',
      queueId,
      messageId,
      createdAfter,
      phase,
      runtime: 'deterministic-no-reply',
      providerDispatch: 'disabled',
      maxTurns: 1,
    },
  }
}

export interface ExactCanaryResumeResult {
  schema_version: typeof EXACT_CANARY_SCHEMA_VERSION
  phase: 'resume'
  tuple: ExactV1QueueTuple
  turn_id: string
  imported: boolean
  recovered_claim_event_id: string
  recovery_release_event_id: string
  reclaimed_event_id: string
  completion_event_id: string
  v1_typed_close: 1
  runtime_calls: 1
  model_calls: 0
  reply_enqueued: 0
  external_send_attempts: 0
  provider_effects: 0
  max_turns: 1
}

function assertExactCanaryExecutionArgs(args: ExactCanaryArgs): void {
  if (args.seatId !== 'aun') throw new ExactCanaryArgumentError('execution seat must be aun')
  if (!Number.isSafeInteger(args.queueId) || args.queueId <= 0) {
    throw new ExactCanaryArgumentError('execution queueId must be a positive safe integer')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.messageId)) {
    throw new ExactCanaryArgumentError('execution messageId must be a UUID')
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(args.createdAfter) ||
    Number.isNaN(Date.parse(args.createdAfter))
  ) {
    throw new ExactCanaryArgumentError('execution createdAfter must be RFC3339')
  }
  if (args.phase !== 'negative' && args.phase !== 'crash-after-claim' && args.phase !== 'resume') {
    throw new ExactCanaryArgumentError('execution phase is invalid')
  }
  if (args.runtime !== 'deterministic-no-reply') {
    throw new ExactCanaryArgumentError('execution runtime must be deterministic-no-reply')
  }
  if (args.providerDispatch !== 'disabled') {
    throw new ExactCanaryArgumentError('execution provider dispatch must be disabled')
  }
  if (args.maxTurns !== 1) throw new ExactCanaryArgumentError('execution maxTurns must be 1')
}

async function exactEffectCount(db: DbAdapter, turnId: string, eventTypes: string[]): Promise<number> {
  const params = eventTypes.map((_, index) => `$${index + 2}`).join(', ')
  const row = await db.queryOne<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM event_log
     WHERE turn_id = $1 AND event_type IN (${params})`,
    [turnId, ...eventTypes],
  )
  return Number(row?.n ?? 0)
}

export async function runExactCanary(db: DbAdapter, args: ExactCanaryArgs): Promise<ExactCanaryResumeResult> {
  // Recheck literals at the execution seam. TypeScript types and CLI parsing
  // are not mutation authority; a forged programmatic call must fail before
  // its first database access too.
  assertExactCanaryExecutionArgs(args)
  const tuple: ExactV1QueueTuple = {
    seatId: args.seatId,
    queueId: args.queueId,
    messageId: args.messageId,
    createdAfter: args.createdAfter,
  }

  if (args.phase === 'negative') {
    try {
      await readExactPendingV1Row(db, tuple)
    } catch (error) {
      if (error instanceof ExactV1TupleMismatchError) {
        throw new ExactCanaryNegativePhaseError(error.message, {
          tupleMatched: false,
          mutations: 0,
          runtimeCalls: 0,
          providerEffects: 0,
        })
      }
      throw error
    }
    throw new ExactCanaryNegativePhaseError('negative phase tuple unexpectedly matched', {
      tupleMatched: true,
      mutations: 0,
      runtimeCalls: 0,
      providerEffects: 0,
    })
  }

  const imported = await importExactPendingV1Row(db, tuple)
  if (args.phase === 'crash-after-claim') {
    const instance = `ecan-crash-${args.queueId}`
    const claimed = await claimExactTurn(db, {
      ...tuple,
      turnId: imported.turnId,
      seatInstanceId: instance,
    })
    if (!claimed) throw new Error(`exact target ${imported.turnId} was not claimable`)
    throw new PlannedCrashAfterClaimError({
      turnId: imported.turnId,
      claimEventId: claimed.claimEventId,
      claimEpoch: claimed.claimEpoch,
      exitCode: PLANNED_CRASH_EXIT_CODE,
    })
  }

  const instance = `ecan-resume-${args.queueId}`
  const recovered = await recoverExactTurnClaim(db, {
    ...tuple,
    turnId: imported.turnId,
    activeInstanceId: instance,
  })
  if (!recovered) throw new Error(`resume requires one stale exact-target claim for ${imported.turnId}`)

  let runtimeCalls = 0
  const deterministicNoReply: TurnRuntime = {
    async runTurn() {
      runtimeCalls += 1
      return { outcome: 'no_reply', replies: [] }
    },
  }
  const worker = await runExactTurnWorkerOnce(db, {
    ...tuple,
    turnId: imported.turnId,
    seatInstanceId: instance,
    runtime: deterministicNoReply,
  })
  if (runtimeCalls !== 1 || worker.runtimeCalls !== 1) {
    throw new Error(`deterministic runtime call count was ${runtimeCalls}`)
  }

  const closed = await closeExactAnsweredV1Row(db, {
    ...tuple,
    turnId: imported.turnId,
    evidenceRef: `turn ${imported.turnId} completion ${worker.completionEventId}`,
  })
  if (!closed) throw new Error('exact V1 target was already closed')

  const replyEnqueued = await exactEffectCount(db, imported.turnId, ['reply.enqueued'])
  const externalAttempts = await exactEffectCount(db, imported.turnId, [
    'reply.delivery_claimed',
    'reply.provider_invocation_started',
  ])
  const providerEffects = await exactEffectCount(db, imported.turnId, [
    'reply.delivered',
    'reply.delivery_unknown',
    'reply.failed',
  ])
  if (replyEnqueued !== 0 || externalAttempts !== 0 || providerEffects !== 0) {
    throw new Error('zero-provider-effect invariant failed')
  }

  return {
    schema_version: EXACT_CANARY_SCHEMA_VERSION,
    phase: 'resume',
    tuple,
    turn_id: imported.turnId,
    imported: imported.inserted,
    recovered_claim_event_id: recovered.claimEventId,
    recovery_release_event_id: recovered.releaseEventId,
    reclaimed_event_id: worker.claimEventId,
    completion_event_id: worker.completionEventId,
    v1_typed_close: 1,
    runtime_calls: 1,
    model_calls: 0,
    reply_enqueued: 0,
    external_send_attempts: 0,
    provider_effects: 0,
    max_turns: 1,
  }
}

async function cliMain(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseExactCanaryArgs>
  try {
    parsed = parseExactCanaryArgs(argv)
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    return ARGUMENT_ERROR_EXIT_CODE
  }
  if (!('args' in parsed)) {
    process.stdout.write(exactCanaryHelp())
    return 0
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error(JSON.stringify({ ok: false, error: 'DATABASE_URL is required' }))
    return ARGUMENT_ERROR_EXIT_CODE
  }

  const db = new PgAdapter(databaseUrl)
  try {
    const result = await runExactCanary(db, parsed.args)
    console.log(JSON.stringify({ ok: true, ...result }))
    return 0
  } catch (error) {
    if (error instanceof PlannedCrashAfterClaimError) {
      console.error(JSON.stringify({ ok: false, code: error.code, ...error.result }))
      return PLANNED_CRASH_EXIT_CODE
    }
    if (error instanceof ExactCanaryNegativePhaseError) {
      console.error(JSON.stringify({ ok: false, code: error.code, message: error.message, ...error.result }))
      return 2
    }
    console.error(JSON.stringify({
      ok: false,
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'EXACT_CANARY_FAILED',
      error: error instanceof Error ? error.message : String(error),
    }))
    return 1
  } finally {
    await db.close()
  }
}

if (import.meta.main) process.exitCode = await cliMain(process.argv.slice(2))
