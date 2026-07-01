import {
  aunRuntimeV2PolicyMetadata,
  buildAunRuntimeV2ReadOnlyPlan,
  validateAunRuntimeV2ReadOnlyPlanArgs,
  type AunRuntimeV2ReadOnlyPlan,
  type AunRuntimeV2ReadOnlyPlanError,
  type AunRuntimeV2ReadOnlyPlanOptions,
  type AunRuntimeV2PlanReasonCode,
  type AunRuntimeV2PolicyMetadata,
} from './aun-runtime-v2-plan'
import type { QueueWorkDb } from './queue-work'

export const AUN_RUNTIME_V2_CLAIM_DRYRUN_SCHEMA_VERSION = 'aun-runtime-v2-claim-dryrun/v1' as const

export type AunRuntimeV2ClaimDryRunErrorCode =
  | AunRuntimeV2ReadOnlyPlanError['error']
  | 'live_claim_not_authorized_in_this_cell'

export interface AunRuntimeV2ClaimDryRunError {
  error: AunRuntimeV2ClaimDryRunErrorCode
  message: string
}

export interface AunRuntimeV2ClaimPlannedMutation {
  op: 'update_queue_row'
  table: 'message_queue'
  set: {
    status: 'received'
    owner: string
    claimed_by: string
    lease_state: 'claimed'
    claim_source: 'aun-runtime-v2'
  }
  where: {
    queue_id: string
    agent_id: string
    message_id: string
    created_after: string
    expected_status: 'pending'
  }
}

export interface AunRuntimeV2ClaimDryRun {
  schema_version: typeof AUN_RUNTIME_V2_CLAIM_DRYRUN_SCHEMA_VERSION
  agent_id: string
  policy_id: string
  policy_version: string
  policy_source: string
  policy_agent_mode: AunRuntimeV2PolicyMetadata['policy_agent_mode']
  allowed_agent_ids: string[]
  live_agent_ids: string[]
  generated_at: string
  target: AunRuntimeV2ReadOnlyPlan['target']
  evaluation: AunRuntimeV2ReadOnlyPlan['evaluation']
  claim_plan: {
    claimable: boolean
    planned_operation: 'claim' | 'none'
    planned_mutation: AunRuntimeV2ClaimPlannedMutation | null
    preconditions_checked: string[]
    reason_code?: AunRuntimeV2PlanReasonCode
    applied_mutations: []
  }
  evidence_refs: string[]
}

export interface AunRuntimeV2ClaimDryRunOptions extends AunRuntimeV2ReadOnlyPlanOptions {
  dryRun?: boolean
}

const PRECONDITIONS_CHECKED = [
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

export function validateAunRuntimeV2ClaimDryRunArgs(
  opts: AunRuntimeV2ClaimDryRunOptions,
): {
  ok: true
  agentId: string
  queueId: string
  messageId: string
  createdAfter: string
  policyMetadata: AunRuntimeV2PolicyMetadata
} | {
  ok: false
  error: AunRuntimeV2ClaimDryRunError
} {
  if (!opts.dryRun) {
    return {
      ok: false,
      error: {
        error: 'live_claim_not_authorized_in_this_cell',
        message: 'aun runtime-v2 claim is dry-run only in this Cell; pass --dry-run',
      },
    }
  }

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

  const queueId = queueIdString(opts.queueId)
  const messageId = cleanString(opts.messageId)
  const createdAfter = cleanString(opts.createdAfter)
  if (!queueId || !messageId || !createdAfter) {
    return {
      ok: false,
      error: {
        error: 'fence_required',
        message: 'aun runtime-v2 claim --dry-run requires --queue-id, --message-id, and --created-after',
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

  const policyArgs = validateAunRuntimeV2ReadOnlyPlanArgs({
    agentId,
    queueId,
    messageId,
    createdAfter,
    env: opts.env,
    now: opts.now,
  })
  if (!policyArgs.ok) {
    return {
      ok: false,
      error: policyArgs.error,
    }
  }

  return {
    ok: true,
    agentId,
    queueId,
    messageId,
    createdAfter,
    policyMetadata: aunRuntimeV2PolicyMetadata(policyArgs.policyPlan),
  }
}

function plannedMutation(input: {
  agentId: string
  queueId: string
  messageId: string
  createdAfter: string
}): AunRuntimeV2ClaimPlannedMutation {
  return {
    op: 'update_queue_row',
    table: 'message_queue',
    set: {
      status: 'received',
      owner: input.agentId,
      claimed_by: input.agentId,
      lease_state: 'claimed',
      claim_source: 'aun-runtime-v2',
    },
    where: {
      queue_id: input.queueId,
      agent_id: input.agentId,
      message_id: input.messageId,
      created_after: input.createdAfter,
      expected_status: 'pending',
    },
  }
}

export async function buildAunRuntimeV2ClaimDryRun(
  db: QueueWorkDb,
  opts: AunRuntimeV2ClaimDryRunOptions,
): Promise<AunRuntimeV2ClaimDryRun | AunRuntimeV2ClaimDryRunError> {
  const args = validateAunRuntimeV2ClaimDryRunArgs(opts)
  if (!args.ok) return args.error

  const plan = await buildAunRuntimeV2ReadOnlyPlan(db, {
    ...opts,
    agentId: args.agentId,
    queueId: args.queueId,
    messageId: args.messageId,
    createdAfter: args.createdAfter,
  })
  if ('error' in plan) return plan

  const claimable = plan.plan.action === 'claim'
  return {
    schema_version: AUN_RUNTIME_V2_CLAIM_DRYRUN_SCHEMA_VERSION,
    agent_id: args.agentId,
    ...args.policyMetadata,
    generated_at: plan.generated_at,
    target: plan.target,
    evaluation: plan.evaluation,
    claim_plan: {
      claimable,
      planned_operation: claimable ? 'claim' : 'none',
      planned_mutation: claimable
        ? plannedMutation({
          agentId: args.agentId,
          queueId: args.queueId,
          messageId: args.messageId,
          createdAfter: args.createdAfter,
        })
        : null,
      preconditions_checked: [...PRECONDITIONS_CHECKED],
      ...(claimable ? {} : { reason_code: plan.plan.reason_code }),
      applied_mutations: [],
    },
    evidence_refs: [],
  }
}
