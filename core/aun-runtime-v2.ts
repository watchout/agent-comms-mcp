import {
  finalizeDoneQueueWork,
  runReceivedQueueWork,
  type FinalizeDoneQueueWorkOptions,
  type LlmRuntimeAdapter,
  type QueueReplySender,
  type QueueWorkDb,
  type QueueWorkFinalizeOutcome,
  type QueueWorkRow,
  type QueueWorkRunOutcome,
  type QueueWorkWritebackSender,
} from './queue-work'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AUN_RUNTIME_V2_CLAIM_SOURCE = 'aun-runtime-v2' as const
export const AUN_RUNTIME_V2_DEFAULT_AGENT_ID = 'kodama' as const
export const AUN_RUNTIME_V2_POLICY_SOURCE = 'config/aun-runtime-v2-policy.json' as const

export interface AunRuntimeV2PolicyAgent {
  agent_id: string
  dry_run_allowed: boolean
  live_allowed: boolean
  notes?: string
}

export interface AunRuntimeV2Policy {
  schema_version: 'aun_runtime_v2_policy_v1'
  policy_id: string
  policy_version: string
  source: string
  agents: AunRuntimeV2PolicyAgent[]
}

export interface AunRuntimeV2Options {
  agentId?: string | null
  allowedAgentId?: string | null
  queueId?: string | number | null
  messageId?: string | null
  createdAfter?: string | null
  runtime?: string | null
  claimSource?: string | null
  invocationSource?: string | null
  expectedClaimSource?: string | null
  finalize?: boolean
  dryRun?: boolean
  claimTtlSeconds?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
  now?: () => Date
  adapter?: LlmRuntimeAdapter
  replySender?: QueueReplySender
  writebackSender?: QueueWorkWritebackSender
}

export interface AunRuntimeV2Plan {
  repoRoot: string | null
  agent_id: string | null
  allowed_agent_id: string
  policy_id: string
  policy_version: string
  policy_source: string
  policy_agent_mode: 'live' | 'dry_run' | 'not_allowed'
  allowed_agent_ids: string[]
  live_agent_ids: string[]
  queue_id: string | null
  message_id: string | null
  created_after: string | null
  runtime: string
  claim_source: string
  invocation_source: string
  expected_claim_source: string
  finalize: boolean
  claim_ttl_seconds: number
  live_activation: false
}

export interface AunRuntimeV2Candidate {
  queue_id: string
  agent_id: string
  message_id: string | null
  status: string
  priority: number | null
  created_at: string | null
  claimed_by: string | null
  claimed_at: string | null
  claim_expires_at: string | null
}

export type AunRuntimeV2FailureCode =
  | 'AGENT_ID_REQUIRED'
  | 'TARGET_AGENT_NOT_ALLOWED'
  | 'TARGET_AGENT_NOT_LIVE_CAPABLE'
  | 'INVALID_CREATED_AFTER'
  | 'INVALID_CLAIM_TTL'
  | 'ADAPTER_REQUIRED'
  | 'EXACT_FENCE_REQUIRED'
  | 'NO_PENDING_ROW'
  | 'TARGET_QUEUE_NOT_FOUND'
  | 'TARGET_QUEUE_AGENT_MISMATCH'
  | 'TARGET_QUEUE_NOT_PENDING'
  | 'TARGET_QUEUE_MESSAGE_MISMATCH'
  | 'TARGET_QUEUE_CREATED_AT_MISSING'
  | 'TARGET_QUEUE_CREATED_AT_BEFORE_FENCE'
  | 'CLAIM_RACE'
  | 'RUNNER_FAILED'
  | 'FINALIZER_FAILED'

export type AunRuntimeV2Outcome =
  | {
      ok: true
      dry_run: true
      code: 'DRY_RUN'
      plan: AunRuntimeV2Plan
      candidate: AunRuntimeV2Candidate
    }
  | {
      ok: true
      dry_run: false
      code: 'CLAIMED'
      plan: AunRuntimeV2Plan
      claimed: AunRuntimeV2Candidate
    }
  | {
      ok: true
      dry_run: false
      code: 'RUNNER_DONE' | 'E2E_DONE'
      plan: AunRuntimeV2Plan
      claimed: AunRuntimeV2Candidate
      runner: QueueWorkRunOutcome
      finalizer?: QueueWorkFinalizeOutcome
    }
  | {
      ok: false
      dry_run: boolean
      code: AunRuntimeV2FailureCode
      plan: AunRuntimeV2Plan
      candidate?: AunRuntimeV2Candidate | null
      claimed?: AunRuntimeV2Candidate | null
      runner?: QueueWorkRunOutcome
      finalizer?: QueueWorkFinalizeOutcome
      detail?: string
      status?: string
    }

function truthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 ? n : Number.NaN
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function queueIdString(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function rowCount(result: { rows: unknown[]; rowCount?: number | null }): number {
  return result.rowCount ?? result.rows.length
}

function policyPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), AUN_RUNTIME_V2_POLICY_SOURCE)
}

function assertStringArray(items: unknown, field: string): string[] {
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    items.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${field} must be a non-empty string array`)
  }
  return items.map((item) => item.trim())
}

let cachedRuntimeV2Policy: AunRuntimeV2Policy | null = null

export function loadAunRuntimeV2Policy(): AunRuntimeV2Policy {
  if (cachedRuntimeV2Policy) return cachedRuntimeV2Policy
  const parsed = JSON.parse(readFileSync(policyPath(), 'utf8')) as Record<string, unknown>
  const policyId = cleanString(parsed.policy_id)
  const policyVersion = cleanString(parsed.policy_version)
  const source = cleanString(parsed.source)
  const allowedAgentIds = assertStringArray(parsed.allowed_agent_ids, 'allowed_agent_ids')
  const liveAgentIds = assertStringArray(parsed.live_agent_ids, 'live_agent_ids')
  const liveSet = new Set(liveAgentIds)
  const unknownLiveAgents = liveAgentIds.filter((agentId) => !allowedAgentIds.includes(agentId))
  if (parsed.schema_version !== 'aun_runtime_v2_policy_v1') {
    throw new Error('aun-runtime-v2 policy schema_version must be aun_runtime_v2_policy_v1')
  }
  if (!policyId) throw new Error('aun-runtime-v2 policy_id is required')
  if (!policyVersion) throw new Error('aun-runtime-v2 policy_version is required')
  if (!source) throw new Error('aun-runtime-v2 policy source is required')
  if (unknownLiveAgents.length > 0) {
    throw new Error(`live_agent_ids must be a subset of allowed_agent_ids: ${unknownLiveAgents.join(', ')}`)
  }
  cachedRuntimeV2Policy = {
    schema_version: 'aun_runtime_v2_policy_v1',
    policy_id: policyId,
    policy_version: policyVersion,
    source,
    agents: allowedAgentIds.map((agentId) => ({
      agent_id: agentId,
      dry_run_allowed: true,
      live_allowed: liveSet.has(agentId),
    })),
  }
  return cachedRuntimeV2Policy
}

function policyAgent(policy: AunRuntimeV2Policy, agentId: string | null): AunRuntimeV2PolicyAgent | null {
  if (!agentId) return null
  return policy.agents.find((agent) => agent.agent_id === agentId) ?? null
}

function allowedAgentIds(policy: AunRuntimeV2Policy): string[] {
  return policy.agents
    .filter((agent) => agent.dry_run_allowed)
    .map((agent) => agent.agent_id)
}

function liveAgentIds(policy: AunRuntimeV2Policy): string[] {
  return policy.agents
    .filter((agent) => agent.live_allowed)
    .map((agent) => agent.agent_id)
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

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function normalizeCandidate(row: QueueWorkRow): AunRuntimeV2Candidate {
  return {
    queue_id: String(row.id),
    agent_id: row.agent_id,
    message_id: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
    status: row.status,
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
    created_at: normalizeDate(row.created_at),
    claimed_by: row.claimed_by ?? null,
    claimed_at: normalizeDate(row.claimed_at),
    claim_expires_at: normalizeDate(row.claim_expires_at),
  }
}

function failure(input: {
  dryRun: boolean
  plan: AunRuntimeV2Plan
  code: AunRuntimeV2FailureCode
  candidate?: AunRuntimeV2Candidate | null
  claimed?: AunRuntimeV2Candidate | null
  runner?: QueueWorkRunOutcome
  finalizer?: QueueWorkFinalizeOutcome
  detail?: string
  status?: string
}): AunRuntimeV2Outcome {
  return {
    ok: false,
    dry_run: input.dryRun,
    code: input.code,
    plan: input.plan,
    candidate: input.candidate,
    claimed: input.claimed,
    runner: input.runner,
    finalizer: input.finalizer,
    detail: input.detail,
    status: input.status,
  }
}

export function buildAunRuntimeV2Plan(opts: AunRuntimeV2Options = {}): AunRuntimeV2Plan {
  const env = opts.env ?? process.env
  const policy = loadAunRuntimeV2Policy()
  const claimSource = cleanString(opts.claimSource)
    ?? cleanString(env.AUN_RUNTIME_V2_CLAIM_SOURCE)
    ?? AUN_RUNTIME_V2_CLAIM_SOURCE
  const runtime = cleanString(opts.runtime)
    ?? cleanString(env.AUN_RUNTIME_V2_RUNTIME)
    ?? cleanString(env.AUN_QUEUE_WORK_RUNTIME)
    ?? cleanString(env.STATE_DAEMON_QUEUE_WORK_RUNTIME)
    ?? 'echo'
  const finalize = opts.finalize
    ?? truthy(env.AUN_RUNTIME_V2_FINALIZE ?? env.STATE_DAEMON_QUEUE_WORK_FINALIZE)
  const ttl = positiveInteger(opts.claimTtlSeconds ?? env.AUN_RUNTIME_V2_CLAIM_TTL_SECONDS ?? env.AGENT_COMMS_CLAIM_TTL_SEC, 30)
  const agentId = cleanString(opts.agentId) ?? cleanString(env.AGENT_ID)
  const targetPolicyAgent = policyAgent(policy, agentId)

  return {
    repoRoot: opts.cwd ?? null,
    agent_id: agentId,
    allowed_agent_id: AUN_RUNTIME_V2_DEFAULT_AGENT_ID,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    policy_source: policy.source,
    policy_agent_mode: targetPolicyAgent
      ? targetPolicyAgent.live_allowed
        ? 'live'
        : 'dry_run'
      : 'not_allowed',
    allowed_agent_ids: allowedAgentIds(policy),
    live_agent_ids: liveAgentIds(policy),
    queue_id: queueIdString(opts.queueId),
    message_id: cleanString(opts.messageId),
    created_after: cleanString(opts.createdAfter),
    runtime,
    claim_source: claimSource,
    invocation_source: cleanString(opts.invocationSource) ?? claimSource,
    expected_claim_source: cleanString(opts.expectedClaimSource) ?? claimSource,
    finalize,
    claim_ttl_seconds: ttl,
    live_activation: false,
  }
}

export function validateAunRuntimeV2Plan(plan: AunRuntimeV2Plan): { ok: true } | {
  ok: false
  code: AunRuntimeV2FailureCode
  detail?: string
} {
  if (!plan.agent_id) return { ok: false, code: 'AGENT_ID_REQUIRED' }
  if (!plan.allowed_agent_ids.includes(plan.agent_id)) {
    return {
      ok: false,
      code: 'TARGET_AGENT_NOT_ALLOWED',
      detail: `agent_id=${plan.agent_id} policy_id=${plan.policy_id} policy_version=${plan.policy_version}`,
    }
  }
  if (!Number.isInteger(plan.claim_ttl_seconds) || plan.claim_ttl_seconds <= 0) {
    return {
      ok: false,
      code: 'INVALID_CLAIM_TTL',
      detail: 'claim_ttl_seconds must be a positive integer',
    }
  }
  if (plan.created_after && Number.isNaN(Date.parse(plan.created_after))) {
    return {
      ok: false,
      code: 'INVALID_CREATED_AFTER',
      detail: `created_after is not parseable: ${plan.created_after}`,
    }
  }
  return { ok: true }
}

export function validateAunRuntimeV2LiveCapability(plan: AunRuntimeV2Plan): { ok: true } | {
  ok: false
  code: AunRuntimeV2FailureCode
  detail: string
} {
  if (plan.agent_id && plan.live_agent_ids.includes(plan.agent_id)) return { ok: true }
  return {
    ok: false,
    code: 'TARGET_AGENT_NOT_LIVE_CAPABLE',
    detail: `agent_id=${plan.agent_id ?? 'null'} is dry-run only under policy_id=${plan.policy_id} policy_version=${plan.policy_version}`,
  }
}

export function validateAunRuntimeV2ExecutionFence(plan: AunRuntimeV2Plan): { ok: true } | {
  ok: false
  code: AunRuntimeV2FailureCode
  detail: string
} {
  if (plan.queue_id && plan.message_id && plan.created_after) return { ok: true }
  return {
    ok: false,
    code: 'EXACT_FENCE_REQUIRED',
    detail: 'non-dry-run runtime-v2 requires queue_id, message_id, and created_after',
  }
}

async function selectPendingCandidate(
  db: QueueWorkDb,
  plan: AunRuntimeV2Plan,
  lock: boolean,
): Promise<QueueWorkRow | null> {
  if (plan.queue_id) {
    const selected = await db.query<QueueWorkRow>(
      `SELECT id, agent_id, message_id, payload, status, priority, created_at,
              claimed_by, claimed_at, claim_expires_at
         FROM message_queue
        WHERE id = $1
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}`,
      [plan.queue_id],
    )
    return selected.rows[0] ?? null
  }

  const params: unknown[] = [plan.agent_id]
  const filters = [
    'agent_id = $1',
    "status = 'pending'",
  ]
  if (plan.message_id) {
    params.push(plan.message_id)
    filters.push(`message_id = $${params.length}`)
  }
  if (plan.created_after) {
    params.push(plan.created_after)
    filters.push(`created_at >= $${params.length}`)
  }

  const selected = await db.query<QueueWorkRow>(
    `SELECT id, agent_id, message_id, payload, status, priority, created_at,
            claimed_by, claimed_at, claim_expires_at
       FROM message_queue
      WHERE ${filters.join('\n        AND ')}
      ORDER BY priority DESC NULLS LAST, created_at ASC
      LIMIT 1
      ${lock ? 'FOR UPDATE SKIP LOCKED' : ''}`,
    params,
  )
  return selected.rows[0] ?? null
}

function validateCandidate(
  plan: AunRuntimeV2Plan,
  row: QueueWorkRow | null,
): { ok: true; candidate: AunRuntimeV2Candidate } | {
  ok: false
  code: AunRuntimeV2FailureCode
  candidate: AunRuntimeV2Candidate | null
  detail?: string
  status?: string
} {
  if (!row) {
    return {
      ok: false,
      code: plan.queue_id ? 'TARGET_QUEUE_NOT_FOUND' : 'NO_PENDING_ROW',
      candidate: null,
    }
  }

  const candidate = normalizeCandidate(row)
  if (candidate.agent_id !== plan.agent_id) {
    return {
      ok: false,
      code: 'TARGET_QUEUE_AGENT_MISMATCH',
      candidate,
      detail: `queue agent_id=${candidate.agent_id} requested agent_id=${plan.agent_id}`,
      status: candidate.status,
    }
  }
  if (candidate.status !== 'pending') {
    return {
      ok: false,
      code: 'TARGET_QUEUE_NOT_PENDING',
      candidate,
      status: candidate.status,
    }
  }
  if (plan.message_id && candidate.message_id !== plan.message_id) {
    return {
      ok: false,
      code: 'TARGET_QUEUE_MESSAGE_MISMATCH',
      candidate,
      detail: `queue message_id=${candidate.message_id ?? 'null'} expected=${plan.message_id}`,
      status: candidate.status,
    }
  }
  if (plan.created_after) {
    if (!candidate.created_at) {
      return {
        ok: false,
        code: 'TARGET_QUEUE_CREATED_AT_MISSING',
        candidate,
        status: candidate.status,
      }
    }
    const candidateCreatedAt = Date.parse(candidate.created_at)
    if (Number.isNaN(candidateCreatedAt)) {
      return {
        ok: false,
        code: 'TARGET_QUEUE_CREATED_AT_MISSING',
        candidate,
        status: candidate.status,
      }
    }
    if (candidateCreatedAt < Date.parse(plan.created_after)) {
      return {
        ok: false,
        code: 'TARGET_QUEUE_CREATED_AT_BEFORE_FENCE',
        candidate,
        detail: `queue created_at=${candidate.created_at} created_after=${plan.created_after}`,
        status: candidate.status,
      }
    }
  }
  return { ok: true, candidate }
}

function payloadWithReceiveClaim(
  row: QueueWorkRow,
  plan: AunRuntimeV2Plan,
  claimedAt: Date,
  claimExpiresAt: Date,
): string {
  return JSON.stringify({
    ...parsePayload(row.payload),
    receive_claim: {
      mode: 'canonical-runtime-v2',
      source: plan.claim_source,
      runtime_version: 2,
      agent_id: plan.agent_id,
      queue_id: String(row.id),
      message_id: row.message_id === null || row.message_id === undefined ? null : String(row.message_id),
      created_at: normalizeDate(row.created_at),
      claimed_at: claimedAt.toISOString(),
      claim_expires_at: claimExpiresAt.toISOString(),
    },
  })
}

export async function inspectAunRuntimeV2Candidate(
  db: QueueWorkDb,
  opts: AunRuntimeV2Options = {},
): Promise<AunRuntimeV2Outcome> {
  const plan = buildAunRuntimeV2Plan(opts)
  const validPlan = validateAunRuntimeV2Plan(plan)
  if (!validPlan.ok) {
    return failure({
      dryRun: true,
      plan,
      code: validPlan.code,
      detail: validPlan.detail,
    })
  }
  const row = await selectPendingCandidate(db, plan, false)
  const candidate = validateCandidate(plan, row)
  if (!candidate.ok) {
    return failure({
      dryRun: true,
      plan,
      code: candidate.code,
      candidate: candidate.candidate,
      detail: candidate.detail,
      status: candidate.status,
    })
  }
  return {
    ok: true,
    dry_run: true,
    code: 'DRY_RUN',
    plan,
    candidate: candidate.candidate,
  }
}

export async function claimPendingQueueForAunRuntimeV2(
  db: QueueWorkDb,
  opts: AunRuntimeV2Options = {},
): Promise<AunRuntimeV2Outcome> {
  const plan = buildAunRuntimeV2Plan(opts)
  const validPlan = validateAunRuntimeV2Plan(plan)
  if (!validPlan.ok) {
    return failure({
      dryRun: false,
      plan,
      code: validPlan.code,
      detail: validPlan.detail,
    })
  }
  const validFence = validateAunRuntimeV2ExecutionFence(plan)
  if (!validFence.ok) {
    return failure({
      dryRun: false,
      plan,
      code: validFence.code,
      detail: validFence.detail,
    })
  }
  const validLiveAgent = validateAunRuntimeV2LiveCapability(plan)
  if (!validLiveAgent.ok) {
    return failure({
      dryRun: false,
      plan,
      code: validLiveAgent.code,
      detail: validLiveAgent.detail,
    })
  }

  const claimedAt = opts.now?.() ?? new Date()
  const claimExpiresAt = new Date(claimedAt.getTime() + plan.claim_ttl_seconds * 1000)
  await db.query('BEGIN')
  try {
    const row = await selectPendingCandidate(db, plan, true)
    const candidate = validateCandidate(plan, row)
    if (!candidate.ok || !row) {
      await db.query('ROLLBACK')
      return failure({
        dryRun: false,
        plan,
        code: candidate.code,
        candidate: candidate.candidate,
        detail: candidate.detail,
        status: candidate.status,
      })
    }

    const nextPayload = payloadWithReceiveClaim(row, plan, claimedAt, claimExpiresAt)
    const updated = await db.query<QueueWorkRow>(
      `UPDATE message_queue
          SET status = 'received',
              read_at = $2,
              claimed_by = $3,
              claimed_at = $2,
              claim_expires_at = $4,
              payload = $5
        WHERE id = $1
          AND agent_id = $3
          AND status = 'pending'
        RETURNING id, agent_id, message_id, payload, status, priority, created_at,
                  claimed_by, claimed_at, claim_expires_at`,
      [row.id, claimedAt, plan.agent_id, claimExpiresAt, nextPayload],
    )
    if (rowCount(updated) !== 1) {
      await db.query('ROLLBACK')
      return failure({
        dryRun: false,
        plan,
        code: 'CLAIM_RACE',
        candidate: candidate.candidate,
      })
    }
    await db.query('COMMIT')
    const claimed = normalizeCandidate(updated.rows[0] ?? {
      ...row,
      status: 'received',
      claimed_by: plan.agent_id,
      claimed_at: claimedAt,
      claim_expires_at: claimExpiresAt,
      payload: nextPayload,
    })
    return {
      ok: true,
      dry_run: false,
      code: 'CLAIMED',
      plan,
      claimed,
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export async function runAunRuntimeV2(
  db: QueueWorkDb,
  opts: AunRuntimeV2Options = {},
): Promise<AunRuntimeV2Outcome> {
  const plan = buildAunRuntimeV2Plan(opts)
  const validPlan = validateAunRuntimeV2Plan(plan)
  if (!validPlan.ok) {
    return failure({
      dryRun: !!opts.dryRun,
      plan,
      code: validPlan.code,
      detail: validPlan.detail,
    })
  }

  if (opts.dryRun) return inspectAunRuntimeV2Candidate(db, opts)

  const validFence = validateAunRuntimeV2ExecutionFence(plan)
  if (!validFence.ok) {
    return failure({
      dryRun: false,
      plan,
      code: validFence.code,
      detail: validFence.detail,
    })
  }
  const validLiveAgent = validateAunRuntimeV2LiveCapability(plan)
  if (!validLiveAgent.ok) {
    return failure({
      dryRun: false,
      plan,
      code: validLiveAgent.code,
      detail: validLiveAgent.detail,
    })
  }

  if (!opts.adapter) {
    return failure({
      dryRun: false,
      plan,
      code: 'ADAPTER_REQUIRED',
      detail: 'adapter is required when dry_run=false',
    })
  }

  const claimedOutcome = await claimPendingQueueForAunRuntimeV2(db, opts)
  if (!claimedOutcome.ok) return claimedOutcome
  const claimed = claimedOutcome.claimed

  const runner = await runReceivedQueueWork(db, {
    queueId: claimed.queue_id,
    agentId: plan.agent_id ?? undefined,
    adapter: opts.adapter,
    invocationSource: plan.invocation_source,
    expectedClaimSource: plan.expected_claim_source,
    now: opts.now,
  })
  if (!runner.ok) {
    return failure({
      dryRun: false,
      plan,
      code: 'RUNNER_FAILED',
      claimed,
      runner,
      detail: runner.detail,
      status: runner.status,
    })
  }

  let finalizer: QueueWorkFinalizeOutcome | undefined
  if (plan.finalize) {
    const finalizeOpts: FinalizeDoneQueueWorkOptions = {
      queueId: runner.queue_id,
      replySender: opts.replySender,
      writebackSender: opts.writebackSender,
      now: opts.now,
    }
    finalizer = await finalizeDoneQueueWork(db, finalizeOpts)
    if (!finalizer.ok) {
      return failure({
        dryRun: false,
        plan,
        code: 'FINALIZER_FAILED',
        claimed,
        runner,
        finalizer,
        detail: finalizer.detail,
        status: finalizer.status,
      })
    }
  }

  return {
    ok: true,
    dry_run: false,
    code: plan.finalize ? 'E2E_DONE' : 'RUNNER_DONE',
    plan,
    claimed,
    runner,
    finalizer,
  }
}
