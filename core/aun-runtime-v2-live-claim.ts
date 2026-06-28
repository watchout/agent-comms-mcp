import {
  AUN_RUNTIME_V2_CLAIM_SOURCE,
  AUN_RUNTIME_V2_DEFAULT_AGENT_ID,
} from './aun-runtime-v2'
import {
  buildAunRuntimeV2ReadOnlyPlan,
  type AunRuntimeV2PlanReasonCode,
  type AunRuntimeV2ReadOnlyPlan,
  type AunRuntimeV2ReadOnlyPlanError,
  type AunRuntimeV2ReadOnlyPlanOptions,
} from './aun-runtime-v2-plan'
import type { QueueWorkDb, QueueWorkRow } from './queue-work'

export const AUN_RUNTIME_V2_LIVE_CLAIM_SCHEMA_VERSION = 'aun-runtime-v2-live-claim/v1' as const

export type AunRuntimeV2LiveClaimErrorCode =
  | AunRuntimeV2ReadOnlyPlanError['error']
  | 'target_agent_not_allowed'
  | 'live_canary_not_authorized'
  | 'invalid_claim_ttl'

export interface AunRuntimeV2LiveClaimError {
  error: AunRuntimeV2LiveClaimErrorCode
  message: string
}

export interface AunRuntimeV2LiveClaimAppliedMutation {
  op: 'update_queue_row'
  table: 'message_queue'
  queue_id: string
  agent_id: typeof AUN_RUNTIME_V2_DEFAULT_AGENT_ID
  message_id: string
  status: 'received'
  claimed_by: typeof AUN_RUNTIME_V2_DEFAULT_AGENT_ID
  claim_source: typeof AUN_RUNTIME_V2_CLAIM_SOURCE
}

export interface AunRuntimeV2LiveClaimRow {
  queue_id: string
  agent_id: string
  message_id: string | null
  status: string
  claimed_by: string | null
  claimed_at: string | null
  claim_expires_at: string | null
}

export interface AunRuntimeV2LiveClaim {
  schema_version: typeof AUN_RUNTIME_V2_LIVE_CLAIM_SCHEMA_VERSION
  agent_id: typeof AUN_RUNTIME_V2_DEFAULT_AGENT_ID
  generated_at: string
  target: AunRuntimeV2ReadOnlyPlan['target']
  evaluation: AunRuntimeV2ReadOnlyPlan['evaluation']
  claim: {
    claimed: boolean
    reason_code: 'claimed' | 'claim_race' | AunRuntimeV2PlanReasonCode
    claim_source: typeof AUN_RUNTIME_V2_CLAIM_SOURCE
    preconditions_checked: string[]
    applied_mutations: AunRuntimeV2LiveClaimAppliedMutation[]
    claimed_row: AunRuntimeV2LiveClaimRow | null
  }
  evidence_refs: string[]
}

export interface AunRuntimeV2LiveClaimOptions extends AunRuntimeV2ReadOnlyPlanOptions {
  liveCanary?: boolean
  claimTtlSeconds?: number
}

const PRECONDITIONS_CHECKED = [
  'kodama_only',
  'live_canary_authorized',
  'row_pending',
  'identity_match',
  'runtime_alive',
  'no_conflicting_claim',
  'exact_fence',
]

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

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : Number.NaN
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { content: raw }
  } catch {
    return { content: raw }
  }
}

function normalizeClaimedRow(row: QueueWorkRow): AunRuntimeV2LiveClaimRow {
  return {
    queue_id: String(row.id),
    agent_id: row.agent_id,
    message_id: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    status: row.status,
    claimed_by: row.claimed_by ?? null,
    claimed_at: normalizeDate(row.claimed_at),
    claim_expires_at: normalizeDate(row.claim_expires_at),
  }
}

export function validateAunRuntimeV2LiveClaimArgs(
  opts: AunRuntimeV2LiveClaimOptions,
): { ok: true; agentId: typeof AUN_RUNTIME_V2_DEFAULT_AGENT_ID; queueId: string; messageId: string; createdAfter: string; claimTtlSeconds: number } | {
  ok: false
  error: AunRuntimeV2LiveClaimError
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
  if (agentId !== AUN_RUNTIME_V2_DEFAULT_AGENT_ID) {
    return {
      ok: false,
      error: {
        error: 'target_agent_not_allowed',
        message: `runtime-v2 live canary is kodama-only; received agent_id=${agentId}`,
      },
    }
  }
  if (!opts.liveCanary) {
    return {
      ok: false,
      error: {
        error: 'live_canary_not_authorized',
        message: 'aun runtime-v2 claim live canary requires --live-canary',
      },
    }
  }

  const queueId = queueIdString(opts.queueId)
  const messageId = cleanString(opts.messageId)
  const createdAfter = cleanString(opts.createdAfter)
  if (!queueId || !messageId || !createdAfter) {
    return {
      ok: false,
      error: {
        error: 'fence_required',
        message: 'aun runtime-v2 claim --live-canary requires --queue-id, --message-id, and --created-after',
      },
    }
  }
  if (Number.isNaN(Date.parse(createdAfter))) {
    return {
      ok: false,
      error: {
        error: 'invalid_arguments',
        message: `--created-after is not parseable: ${createdAfter}`,
      },
    }
  }

  const claimTtlSeconds = positiveInteger(opts.claimTtlSeconds ?? opts.env?.AUN_RUNTIME_V2_CLAIM_TTL_SECONDS, 30)
  if (!Number.isInteger(claimTtlSeconds) || claimTtlSeconds <= 0) {
    return {
      ok: false,
      error: {
        error: 'invalid_claim_ttl',
        message: '--claim-ttl-seconds must be a positive integer',
      },
    }
  }

  return {
    ok: true,
    agentId,
    queueId,
    messageId,
    createdAfter,
    claimTtlSeconds,
  }
}

function payloadWithReceiveClaim(input: {
  row: QueueWorkRow
  agentId: typeof AUN_RUNTIME_V2_DEFAULT_AGENT_ID
  claimedAt: Date
  claimExpiresAt: Date
}): string {
  return JSON.stringify({
    ...parsePayload(input.row.payload),
    receive_claim: {
      mode: 'canonical-runtime-v2',
      source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      runtime_version: 2,
      agent_id: input.agentId,
      queue_id: String(input.row.id),
      message_id: input.row.message_id === null || input.row.message_id === undefined
        ? null
        : String(input.row.message_id),
      created_at: normalizeDate(input.row.created_at),
      claimed_at: input.claimedAt.toISOString(),
      claim_expires_at: input.claimExpiresAt.toISOString(),
      live_canary: true,
    },
  })
}

function notClaimed(plan: AunRuntimeV2ReadOnlyPlan, reasonCode: AunRuntimeV2PlanReasonCode): AunRuntimeV2LiveClaim {
  return {
    schema_version: AUN_RUNTIME_V2_LIVE_CLAIM_SCHEMA_VERSION,
    agent_id: AUN_RUNTIME_V2_DEFAULT_AGENT_ID,
    generated_at: plan.generated_at,
    target: plan.target,
    evaluation: plan.evaluation,
    claim: {
      claimed: false,
      reason_code: reasonCode,
      claim_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
      preconditions_checked: [...PRECONDITIONS_CHECKED],
      applied_mutations: [],
      claimed_row: null,
    },
    evidence_refs: [],
  }
}

function claimRace(plan: AunRuntimeV2ReadOnlyPlan): AunRuntimeV2LiveClaim {
  const result = notClaimed(plan, 'claimable')
  result.claim.reason_code = 'claim_race'
  return result
}

export async function buildAunRuntimeV2LiveClaim(
  db: QueueWorkDb,
  opts: AunRuntimeV2LiveClaimOptions,
): Promise<AunRuntimeV2LiveClaim | AunRuntimeV2LiveClaimError> {
  const args = validateAunRuntimeV2LiveClaimArgs(opts)
  if (!args.ok) return args.error

  const plan = await buildAunRuntimeV2ReadOnlyPlan(db, {
    ...opts,
    agentId: args.agentId,
    queueId: args.queueId,
    messageId: args.messageId,
    createdAfter: args.createdAfter,
  })
  if ('error' in plan) return plan
  if (plan.plan.action !== 'claim') return notClaimed(plan, plan.plan.reason_code)

  const claimedAt = opts.now?.() ?? new Date()
  const claimExpiresAt = new Date(claimedAt.getTime() + args.claimTtlSeconds * 1000)
  await db.query('BEGIN')
  try {
    const selected = await db.query<QueueWorkRow>(
      `SELECT id, agent_id, message_id, payload, status, priority, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue
        WHERE id = $1
          AND agent_id = $2
          AND message_id = $3
          AND created_at >= $4
        LIMIT 1
        FOR UPDATE`,
      [args.queueId, args.agentId, args.messageId, args.createdAfter],
    )
    const row = selected.rows[0] ?? null
    if (!row || row.status !== 'pending') {
      await db.query('ROLLBACK')
      return claimRace(plan)
    }

    const nextPayload = payloadWithReceiveClaim({
      row,
      agentId: args.agentId,
      claimedAt,
      claimExpiresAt,
    })
    const updated = await db.query<QueueWorkRow>(
      `UPDATE message_queue
          SET status = 'received',
              read_at = $5,
              claimed_by = $2,
              claimed_at = $5,
              claim_expires_at = $6,
              payload = $7
        WHERE id = $1
          AND agent_id = $2
          AND message_id = $3
          AND created_at >= $4
          AND status = 'pending'
        RETURNING id, agent_id, message_id, payload, status, priority, created_at,
                  claimed_by, claimed_at, claim_expires_at`,
      [
        args.queueId,
        args.agentId,
        args.messageId,
        args.createdAfter,
        claimedAt.toISOString(),
        claimExpiresAt.toISOString(),
        nextPayload,
      ],
    )
    if ((updated.rowCount ?? updated.rows.length) !== 1) {
      await db.query('ROLLBACK')
      return claimRace(plan)
    }

    await db.query('COMMIT')
    const claimedRow = normalizeClaimedRow(updated.rows[0] ?? {
      ...row,
      status: 'received',
      claimed_by: args.agentId,
      claimed_at: claimedAt,
      claim_expires_at: claimExpiresAt,
      payload: nextPayload,
    })
    return {
      schema_version: AUN_RUNTIME_V2_LIVE_CLAIM_SCHEMA_VERSION,
      agent_id: args.agentId,
      generated_at: plan.generated_at,
      target: plan.target,
      evaluation: plan.evaluation,
      claim: {
        claimed: true,
        reason_code: 'claimed',
        claim_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
        preconditions_checked: [...PRECONDITIONS_CHECKED],
        applied_mutations: [{
          op: 'update_queue_row',
          table: 'message_queue',
          queue_id: args.queueId,
          agent_id: args.agentId,
          message_id: args.messageId,
          status: 'received',
          claimed_by: args.agentId,
          claim_source: AUN_RUNTIME_V2_CLAIM_SOURCE,
        }],
        claimed_row: claimedRow,
      },
      evidence_refs: [],
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}
