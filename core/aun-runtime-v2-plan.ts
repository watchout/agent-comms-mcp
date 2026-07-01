import {
  buildAunRuntimeV2Plan,
  selectAunRuntimeV2CandidateRow,
  validateAunRuntimeV2Plan,
  type AunRuntimeV2Options,
  type AunRuntimeV2Plan,
} from './aun-runtime-v2'
import type { QueueWorkDb, QueueWorkRow } from './queue-work'

export const AUN_RUNTIME_V2_PLAN_SCHEMA_VERSION = 'aun-runtime-v2-plan/v1' as const

export type AunRuntimeV2PlanAction = 'claim' | 'skip' | 'blocked'
export type AunRuntimeV2PlanReasonCode =
  | 'claimable'
  | 'row_not_found'
  | 'not_pending'
  | 'identity_mismatch'
  | 'runtime_not_alive'
  | 'conflicting_active_claim'
  | 'fence_mismatch'

export type AunRuntimeV2PlanErrorCode = 'invalid_arguments' | 'db_unreachable' | 'fence_required'
  | 'target_agent_not_allowed'

export interface AunRuntimeV2PolicyMetadata {
  policy_id: string
  policy_version: string
  policy_source: string
  policy_agent_mode: AunRuntimeV2Plan['policy_agent_mode']
  allowed_agent_ids: string[]
  live_agent_ids: string[]
}

export interface AunRuntimeV2ReadOnlyPlanOptions extends Pick<
  AunRuntimeV2Options,
  'agentId' | 'queueId' | 'messageId' | 'createdAfter' | 'env' | 'now'
> {
  runtimeStaleSeconds?: number
}

export interface AunRuntimeV2ReadOnlyPlan {
  schema_version: typeof AUN_RUNTIME_V2_PLAN_SCHEMA_VERSION
  agent_id: string
  policy_id: string
  policy_version: string
  policy_source: string
  policy_agent_mode: AunRuntimeV2Plan['policy_agent_mode']
  allowed_agent_ids: string[]
  live_agent_ids: string[]
  generated_at: string
  target: {
    queue_id: string | null
    message_id: string | null
    created_after: string | null
  }
  evaluation: {
    row_found: boolean
    row_status: string | null
    owned_by_expected_agent: boolean
    runtime_alive: boolean
    conflicting_active_claim: boolean
    exact_fence_satisfied: boolean
  }
  plan: {
    action: AunRuntimeV2PlanAction
    reason_code: AunRuntimeV2PlanReasonCode
    would_claim: boolean
    mutations: []
  }
  evidence_refs: string[]
}

export interface AunRuntimeV2ReadOnlyPlanError {
  error: AunRuntimeV2PlanErrorCode
  message: string
  policy_id?: string
  policy_version?: string
  policy_source?: string
  policy_agent_mode?: AunRuntimeV2Plan['policy_agent_mode']
  allowed_agent_ids?: string[]
  live_agent_ids?: string[]
}

interface RuntimeLivenessRow {
  runtime_instance_id?: string | null
  status?: string | null
  last_seen_at?: string | Date | null
  stopped_at?: string | Date | null
}

const ACTIVE_QUEUE_STATUSES = new Set(['received', 'in_progress'])
const STOPPED_RUNTIME_STATUSES = new Set(['stopped', 'disabled', 'offline', 'disconnected', 'failed'])
const DEFAULT_RUNTIME_STALE_SECONDS = 15 * 60

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function queueIdString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function dateMs(value: Date | string | null | undefined): number | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  const ms = parsed.getTime()
  return Number.isFinite(ms) ? ms : null
}

function runtimeStaleSeconds(opts: AunRuntimeV2ReadOnlyPlanOptions): number {
  const raw = opts.runtimeStaleSeconds
    ?? Number(opts.env?.AUN_RUNTIME_V2_PLAN_RUNTIME_STALE_SECONDS ?? opts.env?.AUN_RUNTIME_V2_RUNTIME_STALE_SECONDS)
  return Number.isFinite(raw) && raw > 0 ? Number(raw) : DEFAULT_RUNTIME_STALE_SECONDS
}

export function aunRuntimeV2PolicyMetadata(plan: AunRuntimeV2Plan): AunRuntimeV2PolicyMetadata {
  return {
    policy_id: plan.policy_id,
    policy_version: plan.policy_version,
    policy_source: plan.policy_source,
    policy_agent_mode: plan.policy_agent_mode,
    allowed_agent_ids: [...plan.allowed_agent_ids],
    live_agent_ids: [...plan.live_agent_ids],
  }
}

export function validateAunRuntimeV2ReadOnlyPlanArgs(
  opts: AunRuntimeV2ReadOnlyPlanOptions,
): {
  ok: true
  agentId: string
  queueId: string | null
  messageId: string | null
  createdAfter: string | null
  policyPlan: AunRuntimeV2Plan
} | {
  ok: false
  error: AunRuntimeV2ReadOnlyPlanError
} {
  const agentId = cleanString(opts.agentId)
  if (!agentId) {
    return {
      ok: false,
      error: {
        error: 'invalid_arguments',
        message: '--agent-id is required',
      },
    }
  }

  const createdAfter = cleanString(opts.createdAfter)
  if (createdAfter && Number.isNaN(Date.parse(createdAfter))) {
    return {
      ok: false,
      error: {
        error: 'invalid_arguments',
        message: `--created-after is not parseable: ${createdAfter}`,
      },
    }
  }

  const queueId = queueIdString(opts.queueId)
  const messageId = cleanString(opts.messageId)
  if ((opts.env?.AUN_RUNTIME_V2_PLAN_REQUIRE_EXACT_FENCE === '1'
    || opts.env?.AUN_RUNTIME_V2_PLAN_REQUIRE_EXACT_FENCE?.toLowerCase() === 'true')
    && !queueId) {
    return {
      ok: false,
      error: {
        error: 'fence_required',
        message: 'policy requires --queue-id for runtime-v2 plan',
      },
    }
  }

  const policyPlan = buildAunRuntimeV2Plan({
    agentId,
    queueId,
    messageId,
    createdAfter,
    env: opts.env,
  })
  const validPolicy = validateAunRuntimeV2Plan(policyPlan)
  if (!validPolicy.ok) {
    return {
      ok: false,
      error: {
        error: 'target_agent_not_allowed',
        message: validPolicy.detail ?? validPolicy.code,
        ...aunRuntimeV2PolicyMetadata(policyPlan),
      },
    }
  }

  return {
    ok: true,
    agentId,
    queueId,
    messageId,
    createdAfter,
    policyPlan,
  }
}

function activeClaimIsLive(row: QueueWorkRow | null, now: Date): boolean {
  if (!row) return false
  if (!ACTIVE_QUEUE_STATUSES.has(row.status)) return false
  const expiresMs = dateMs(row.claim_expires_at)
  return expiresMs === null || expiresMs >= now.getTime()
}

async function hasConflictingActiveClaim(
  db: QueueWorkDb,
  agentId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db.query<QueueWorkRow>(
    `SELECT id, agent_id, message_id, payload, status, priority, created_at,
            claimed_by, claimed_at, claim_expires_at
       FROM message_queue
      WHERE agent_id = $1
        AND status IN ('received', 'in_progress')
        AND (claim_expires_at IS NULL OR claim_expires_at >= $2)
      ORDER BY claimed_at ASC NULLS LAST, created_at ASC
      LIMIT 1`,
    [agentId, now.toISOString()],
  )
  return activeClaimIsLive(rows.rows[0] ?? null, now)
}

async function runtimeAlive(
  db: QueueWorkDb,
  agentId: string,
  now: Date,
  staleSeconds: number,
): Promise<boolean> {
  const rows = await db.query<RuntimeLivenessRow>(
    `SELECT runtime_instance_id, status, last_seen_at, stopped_at
       FROM agent_runtime_instances
      WHERE agent_id = $1
      ORDER BY last_seen_at DESC NULLS LAST, started_at DESC
      LIMIT 1`,
    [agentId],
  )
  const row = rows.rows[0]
  if (!row) return false
  const status = cleanString(row.status)?.toLowerCase() ?? null
  if (status && STOPPED_RUNTIME_STATUSES.has(status)) return false
  if (row.stopped_at) return false
  const lastSeenMs = dateMs(row.last_seen_at)
  if (lastSeenMs === null) return false
  return now.getTime() - lastSeenMs <= staleSeconds * 1000
}

function exactFenceSatisfied(row: QueueWorkRow | null, messageId: string | null, createdAfter: string | null): boolean {
  if (!row) return false
  if (messageId && String(row.message_id ?? '') !== messageId) return false
  if (createdAfter) {
    const rowCreated = dateMs(row.created_at)
    const fence = dateMs(createdAfter)
    if (rowCreated === null || fence === null) return false
    if (rowCreated < fence) return false
  }
  return true
}

function classifyPlan(input: {
  row: QueueWorkRow | null
  agentId: string
  runtimeAlive: boolean
  conflictingActiveClaim: boolean
  exactFenceSatisfied: boolean
}): { action: AunRuntimeV2PlanAction; reason_code: AunRuntimeV2PlanReasonCode; would_claim: boolean } {
  const row = input.row
  if (!row) return { action: 'skip', reason_code: 'row_not_found', would_claim: false }
  if (row.status !== 'pending') return { action: 'skip', reason_code: 'not_pending', would_claim: false }
  if (row.agent_id !== input.agentId) return { action: 'skip', reason_code: 'identity_mismatch', would_claim: false }
  if (!input.exactFenceSatisfied) return { action: 'blocked', reason_code: 'fence_mismatch', would_claim: false }
  if (!input.runtimeAlive) return { action: 'blocked', reason_code: 'runtime_not_alive', would_claim: false }
  if (input.conflictingActiveClaim) {
    return { action: 'blocked', reason_code: 'conflicting_active_claim', would_claim: false }
  }
  return { action: 'claim', reason_code: 'claimable', would_claim: true }
}

export async function buildAunRuntimeV2ReadOnlyPlan(
  db: QueueWorkDb,
  opts: AunRuntimeV2ReadOnlyPlanOptions,
): Promise<AunRuntimeV2ReadOnlyPlan | AunRuntimeV2ReadOnlyPlanError> {
  const args = validateAunRuntimeV2ReadOnlyPlanArgs(opts)
  if (!args.ok) return args.error

  const now = opts.now?.() ?? new Date()
  const policyMetadata = aunRuntimeV2PolicyMetadata(args.policyPlan)
  try {
    const row = await selectAunRuntimeV2CandidateRow(db, args.policyPlan, false)
    const runtimeIsAlive = await runtimeAlive(db, args.agentId, now, runtimeStaleSeconds(opts))
    const hasConflict = await hasConflictingActiveClaim(db, args.agentId, now)
    const fenceOk = exactFenceSatisfied(row, args.messageId, args.createdAfter)
    const classified = classifyPlan({
      row,
      agentId: args.agentId,
      runtimeAlive: runtimeIsAlive,
      conflictingActiveClaim: hasConflict,
      exactFenceSatisfied: fenceOk,
    })

    return {
      schema_version: AUN_RUNTIME_V2_PLAN_SCHEMA_VERSION,
      agent_id: args.agentId,
      ...policyMetadata,
      generated_at: now.toISOString(),
      target: {
        queue_id: row ? String(row.id) : args.queueId,
        message_id: row?.message_id === null || row?.message_id === undefined
          ? args.messageId
          : String(row.message_id),
        created_after: args.createdAfter,
      },
      evaluation: {
        row_found: !!row,
        row_status: row?.status ?? null,
        owned_by_expected_agent: !!row && row.agent_id === args.agentId,
        runtime_alive: runtimeIsAlive,
        conflicting_active_claim: hasConflict,
        exact_fence_satisfied: fenceOk,
      },
      plan: {
        action: classified.action,
        reason_code: classified.reason_code,
        would_claim: classified.would_claim,
        mutations: [],
      },
      evidence_refs: [],
    }
  } catch (err) {
    return {
      error: 'db_unreachable',
      message: (err as Error).message ?? String(err),
    }
  }
}
