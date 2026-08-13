/**
 * Stable receive wrapper for AUN operators and bot runners.
 *
 * Untargeted receive delegates claim semantics to `agent-com next`. Targeted
 * `--queue-id` receive claims the exact row through the same DB state model so
 * audit and recovery workflows do not drain unrelated FIFO work.
 */
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { decideQueueRouting, type QueueRoutingDecisionEvidence } from '../../core/routing-decision'
import {
  ACTIONABLE_MESSAGE_TYPES,
  NON_ACTIONABLE_MESSAGE_TYPES,
  classifyQueueMessageType,
} from '../../core/queue-message-classification'
import { evaluateRuntimeMemoryReadyGate, type RuntimeMemoryReadyGateResult } from '../../core/runtime-memory-ready'

export interface ReceiveOptions {
  agentId?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  dryRun?: boolean
  queueId?: string
}

export interface DrainOptions extends ReceiveOptions {
  limit?: number
}

export interface DiagnoseReceiveOptions extends ReceiveOptions {
  maxInspect?: number
}

export interface ActionableReceiveOptions extends ReceiveOptions {
  maxInspect?: number
  queueId?: string
}

export interface ReconcileOptions extends ReceiveOptions {
  limit?: number
  cursor?: string
}

export interface ReceivePlan {
  repoRoot: string
  argv: string[]
  env: Record<string, string>
  databaseUrlCandidates: string[]
}

export type CommandPlan = ReceivePlan

export interface ClaimedMessage {
  waiting: number
  mode?: string
  queue_id?: string | number
  message_id?: string | null
  channel_id?: string
  thread_id?: string | null
  from?: string
  from_name?: string | null
  content?: string
  message_type?: string
  source?: string | null
  created_at?: string
  claimed_by?: string
  claimed_at?: string
  claim_expires_at?: string
  reply_chain?: unknown[]
  presentation?: PresentationEvidence
  routing?: QueueRoutingDecisionEvidence
}

export interface PresentationEvidence {
  kind: 'unsplit' | 'canonical' | 'child_request'
  presentation_group_id: string | null
  fragment_count: number
  fragment_index: number
  is_claimable: boolean
  canonical_body_hash: string | null
  fragment_body_hash: string | null
  parent_message_id: string | null
  child_request_id: string | null
}

export interface ReceiveResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  plan: ReceivePlan
}

export interface TargetedReceiveSummary {
  ok: boolean
  dry_run: boolean
  mode: 'targeted-receive'
  agent_id: string
  expected_agent_id: string
  queue_id: string
  selected: DiagnosedQueueRow | null
  claimed: ClaimedMessage | null
  waiting: number
  blocked_reason: TargetedReceiveBlockedReason | null
  observed_status: string | null
}

export type TargetedReceiveBlockedReason =
  | 'target_queue_not_found'
  | 'target_queue_not_pending'
  | 'CANONICAL_MESSAGE_REQUIRED'
  | 'PRESENTATION_GROUP_INCOMPLETE'
  | 'PRESENTATION_GROUP_CONFLICT'
  | 'FRAGMENT_NOT_CLAIMABLE'

export interface TargetedReceiveResult extends ReceiveResult {
  summary?: TargetedReceiveSummary
}

export interface DrainResult extends ReceiveResult {
  claimed: ClaimedMessage[]
}

export interface DiagnosedQueueRow {
  queue_id: string | number
  message_id: string | null
  agent_id: string
  message_type: string
  author_id: string | null
  status: string
  priority: number
  created_at: string | null
  classification: 'actionable' | 'non_action' | 'unknown'
  routing_decision: QueueRoutingDecisionEvidence['routing_decision']
  route_reason: QueueRoutingDecisionEvidence['route_reason']
  routing: QueueRoutingDecisionEvidence
  presentation?: PresentationEvidence
}

export interface DiagnoseReceiveSummary {
  ok: boolean
  dry_run: true
  mode: 'diagnose-receive'
  agent_id: string
  expected_agent_id: string
  database: {
    kind: 'postgres' | 'sqlite'
    url_candidates?: string[]
    sqlite_path?: string
  }
  max_inspect: number
  inspected_count: number
  total_pending: number
  oldest_pending_age_seconds: number | null
  selected: DiagnosedQueueRow | null
  candidate: DiagnosedQueueRow | null
  selection_blocked_reason: 'active_claim' | 'none_found' | null
  skipped_non_action_count: number
  skipped_non_action_before_candidate: number
  unknown_type_count: number
  unknown_type_samples: DiagnosedQueueRow[]
  type_counts: Record<string, number>
  active_claim: {
    busy: boolean
    queue_id: string | number | null
    message_id: string | null
    status: string | null
    claimed_at: string | null
    claim_expires_at: string | null
    claimed?: ClaimedMessage | null
  }
  cto_identity_split: {
    checked_agent_ids: string[]
    split_detected: boolean
    pending: Record<string, { pending_count: number; active_count: number; oldest_pending_at: string | null }>
    note: string
  }
  next_action: string
}

export interface DiagnoseReceiveResult extends ReceiveResult {
  summary?: DiagnoseReceiveSummary
}

export interface ActionableReceiveSummary {
  ok: boolean
  dry_run: boolean
  mode: 'receive-actionable'
  agent_id: string
  expected_agent_id: string
  max_inspect: number
  inspected_count: number
  waiting: number
  selected: DiagnosedQueueRow | null
  claimed: ClaimedMessage | null
  blocked_reason: 'active_claim' | 'queue_not_claimable' | 'memory_not_ready' | null
  active_claim: {
    busy: boolean
    queue_id: string | number | null
    message_id: string | null
    status: string | null
    claimed_at: string | null
    claim_expires_at: string | null
  }
  skipped_non_action_count: number
  unknown_type_count: number
  selection_reason: string | null
  memory_ready: RuntimeMemoryReadyGateResult
}

export interface ActionableReceiveResult extends ReceiveResult {
  summary?: ActionableReceiveSummary
}

export type ReconcileClass =
  | 'actionable_current'
  | 'actionable_stale'
  | 'active_claim'
  | 'notify_fallback_result'
  | 'duplicate_result'
  | 'superseded_instruction'
  | 'obsolete_notice'
  | 'projection_only'
  | 'identity_split'
  | 'unknown_type'
  | 'terminal_legacy_invariant'
  | 'already_terminal'
  | 'needs_operator_decision'

export type ReconcileAction =
  | 'keep_pending'
  | 'claim_for_work'
  | 'mark_replied'
  | 'skip_obsolete'
  | 'supersede'
  | 'reroute'
  | 'request_human_review'
  | 'needs_info'
  | 'fail_with_reason'

export interface ReconcileFingerprint {
  version: 1
  algorithm: 'sha256'
  canonical_fields: Record<string, unknown>
  hash: string
}

export interface NotifyFallbackEvidence {
  found: true
  notify_message_id: string
  notify_author_id: string | null
  notify_created_at: string | null
  notify_content_hash: string | null
  source_queue_id: string
  source_message_id: string | null
  link_type: 'source_queue_id' | 'source_message_id'
  evidence_source: 'content_marker' | 'metadata_marker'
}

export interface ReconcileRow {
  queue_id: string | number
  message_id: string | null
  agent_id: string
  status: string
  message_type: string
  author_id: string | null
  source: string | null
  created_at: string | null
  claimed_by: string | null
  claimed_at: string | null
  claim_expires_at: string | null
  replied_at: string | null
  replied_with: string | null
  failed_reason: string | null
  done_at: string | null
  classification: ReconcileClass
  flags: string[]
  proposed_action: ReconcileAction
  required_authority: string
  required_evidence: string[]
  evidence: Record<string, unknown>
  fingerprint: ReconcileFingerprint
  content_preview: string
  content_hash: string | null
}

export interface ReconcileSummary {
  ok: boolean
  dry_run: true
  mode: 'reconcile'
  agent_id: string
  expected_agent_id: string
  database: DiagnoseReceiveSummary['database']
  limit: number
  cursor: string | null
  cursor_next: string | null
  truncated: boolean
  inspected_count: number
  counts_by_class: Record<string, number>
  counts_by_action: Record<string, number>
  warnings: string[]
  rows: ReconcileRow[]
}

export interface ReconcileResult extends ReceiveResult {
  summary?: ReconcileSummary
}

const DEFAULT_DB_URLS = [
  'postgresql:///agent_comms?host=/tmp',
  'postgresql:///agent_comms?host=/private/tmp',
]

const DEFAULT_DRAIN_LIMIT = 20
const DEFAULT_MAX_INSPECT = 50
const MAX_INSPECT_CAP = 200
const DEFAULT_RECONCILE_LIMIT = 50
const MAX_RECONCILE_LIMIT = 200
const TERMINAL_STATUSES = new Set(['done', 'replied', 'skipped', 'failed'])
const ACTIVE_STATUSES = new Set(['read', 'received', 'in_progress'])

export function repoRoot(): string {
  return resolve(import.meta.dir, '..', '..')
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

function resolveAgentId(opts: ReceiveOptions, env: NodeJS.ProcessEnv = process.env): string {
  const raw = opts.agentId ?? env.AGENT_ID
  const agentId = raw?.trim()
  if (!agentId) {
    throw new Error('agent id required: pass --agent-id <id> or set AGENT_ID')
  }
  return agentId
}

function assertExpectedAgentId(env: Record<string, string>, agentId: string): void {
  const expected = env.AGENT_COM_EXPECTED_AGENT_ID?.trim()
  if (expected && expected !== agentId) {
    throw new Error(
      `AGENT_ID_MISMATCH: resolved agent_id=${agentId}, expected ${expected}. ` +
      `Set AGENT_ID=${expected} or remove AGENT_COM_EXPECTED_AGENT_ID for this process.`,
    )
  }
}

function databaseCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.DATABASE_URL?.trim()
  if (!explicit) return DEFAULT_DB_URLS
  if (explicit.includes('host=/tmp')) {
    return [explicit, explicit.replace('host=/tmp', 'host=/private/tmp')]
  }
  return [explicit]
}

export function buildCommandPlan(
  opts: ReceiveOptions,
  argv: string[],
): CommandPlan {
  const envIn = opts.env ?? process.env
  const agentId = resolveAgentId(opts, envIn)
  const env = cleanEnv(envIn)
  env.AGENT_ID = agentId
  assertExpectedAgentId(env, agentId)
  env.AGENT_COM_EXPECTED_AGENT_ID = env.AGENT_COM_EXPECTED_AGENT_ID || agentId

  const candidates = databaseCandidates(env)
  env.DATABASE_URL = candidates[0]

  return {
    repoRoot: opts.cwd ?? repoRoot(),
    argv,
    env,
    databaseUrlCandidates: candidates,
  }
}

export function buildReceivePlan(opts: ReceiveOptions = {}): ReceivePlan {
  const envIn = opts.env ?? process.env
  const agentId = resolveAgentId(opts, envIn)
  const env = cleanEnv(envIn)
  env.AGENT_ID = agentId
  assertExpectedAgentId(env, agentId)
  env.AGENT_COM_EXPECTED_AGENT_ID = env.AGENT_COM_EXPECTED_AGENT_ID || agentId

  const candidates = databaseCandidates(env)
  env.DATABASE_URL = candidates[0]

  return {
    repoRoot: opts.cwd ?? repoRoot(),
    argv: ['bun', 'cli/index.ts', 'next'],
    env,
    databaseUrlCandidates: candidates,
  }
}

function shouldTryNextSocket(stderr: string): boolean {
  return (
    stderr.includes('/tmp/.s.PGSQL.5432') ||
    stderr.includes('host=/tmp') ||
    stderr.includes('ECONNREFUSED') ||
    stderr.includes('ENOENT')
  )
}

export function receive(opts: ReceiveOptions = {}): ReceiveResult {
  const plan = buildReceivePlan(opts)
  if (opts.dryRun) {
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        dry_run: true,
        cwd: plan.repoRoot,
        argv: plan.argv,
        agent_id: plan.env.AGENT_ID,
        expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
        database_url_candidates: plan.databaseUrlCandidates,
      }) + '\n',
      stderr: '',
      plan,
    }
  }

  const result = runCommandPlan(plan)
  return { ...result, plan }
}

export async function receiveTargeted(opts: ReceiveOptions = {}): Promise<TargetedReceiveResult> {
  const targetQueueId = opts.queueId?.trim()
  let plan: ReceivePlan
  if (!targetQueueId || !/^\d+$/.test(targetQueueId)) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [TARGETED_RECEIVE_INVALID_QUEUE_ID]: --queue-id must be a positive integer\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts', 'receive', '--queue-id', targetQueueId ?? ''],
        env: cleanEnv(opts.env ?? process.env),
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    plan = buildCommandPlan(opts, ['bun', 'bin/aun.ts', 'receive', '--queue-id', targetQueueId])
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [TARGETED_RECEIVE_FAILED]: ${(err as Error).message}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts', 'receive', '--queue-id', targetQueueId],
        env: cleanEnv(opts.env ?? process.env),
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      return db.transaction<TargetedReceiveSummary>(async (tx) => {
        const row = await tx.queryOne<Record<string, unknown>>(
          `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                  mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  am.content AS stored_content,
                  am.message_type AS stored_message_type,
                  am.author_id AS stored_author_id,
                  am.source AS stored_source,
                  am.metadata AS stored_metadata,
                  am.input_mentions AS stored_input_mentions,
                  a.runtime AS target_runtime,
                  a.status AS target_status,
                  a.metadata AS target_metadata,
                  a.profile_enabled AS target_profile_enabled,
                  a.disabled_at AS target_disabled_at,
                  a.expected_provider_identity AS target_expected_provider_identity,
                  crp.policy_source AS channel_policy_source,
                  crp.primary_agent_id AS channel_policy_primary_agent_id,
                  crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
             LEFT JOIN agents a ON a.agent_id = mq.agent_id
             LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
            WHERE mq.id::text = $1 AND mq.agent_id = $2
            LIMIT 1
            FOR UPDATE OF mq`,
          [targetQueueId, plan.env.AGENT_ID],
        )

        const payload = parsePayload(row?.payload)
        const presentation = row ? evaluatePresentationClaimability(row, payload) : null
        const selected = row ? {
          ...normalizeQueueRow(row),
          ...(presentation ? { presentation: presentation.evidence } : {}),
        } : null
        const observedStatus = selected?.status ?? null
        const blockedReason = !selected
          ? 'target_queue_not_found'
          : selected.status !== 'pending' ? 'target_queue_not_pending' : presentation?.blocked_reason ?? null
        let claimed: ClaimedMessage | null = null
        let claimIdentity: {
          claimed_by: string
          claimed_at: string
          claim_expires_at: string
        } | null = null

        if (selected && !blockedReason && !opts.dryRun) {
          const claimTtlSec = parseInt(plan.env.AGENT_COMMS_CLAIM_TTL_SEC ?? '30', 10)
          const claimExpiresAt = new Date(Date.now() + claimTtlSec * 1000).toISOString()
          const claimSource = plan.env.AUN_RECEIVE_CLAIM_SOURCE?.trim() || null
          const claimPayload = queuePayloadWithReceiveClaim(payload, {
            source: claimSource,
            agentId: plan.env.AGENT_ID,
            queueId: targetQueueId,
          })
          const update = await tx.execute(
            `UPDATE message_queue
                SET status = 'received',
                    read_at = now(),
                    claimed_by = $1,
                    claimed_at = now(),
                    claim_expires_at = $2,
                    payload = COALESCE($5, payload)
              WHERE id = $3 AND agent_id = $4 AND status = 'pending'`,
            [plan.env.AGENT_ID, claimExpiresAt, selected.queue_id, plan.env.AGENT_ID, claimPayload],
          )
          if (update.rowCount !== 1) {
            throw new Error(`target queue row changed before claim: queue_id=${selected.queue_id}`)
          }
          const claimedRow = await tx.queryOne<Record<string, unknown>>(
            `SELECT claimed_by, claimed_at::text AS claimed_at,
                    claim_expires_at::text AS claim_expires_at
               FROM message_queue
              WHERE id = $1 AND agent_id = $2 AND status = 'received'`,
            [selected.queue_id, plan.env.AGENT_ID],
          )
          const claimedAt = normalizeDate(claimedRow?.claimed_at)
          const persistedClaimExpiresAt = normalizeDate(claimedRow?.claim_expires_at)
          if (
            claimedRow?.claimed_by !== plan.env.AGENT_ID
            || !claimedAt
            || !persistedClaimExpiresAt
          ) {
            throw new Error(`target queue claim identity readback failed: queue_id=${selected.queue_id}`)
          }
          claimIdentity = {
            claimed_by: plan.env.AGENT_ID,
            claimed_at: claimedAt,
            claim_expires_at: persistedClaimExpiresAt,
          }
          await tx.execute(
            `UPDATE agents SET
               status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
               status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
               status_updated_at = now()
             WHERE agent_id = $1`,
            [plan.env.AGENT_ID],
          )
        }

        const waitingRow = await tx.queryOne<{ n: number | string }>(
          `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
          [plan.env.AGENT_ID],
        )
        const waiting = Number(waitingRow?.n ?? 0)
        if (selected && !blockedReason) {
          claimed = opts.dryRun ? null : claimedMessageFromRow(selected, payload, waiting, claimIdentity)
        }

        return {
          ok: !blockedReason,
          dry_run: !!opts.dryRun,
          mode: 'targeted-receive',
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          queue_id: targetQueueId,
          selected,
          claimed,
          waiting,
          blocked_reason: blockedReason,
          observed_status: observedStatus,
        }
      })
    })
    const blocked = !!summary.blocked_reason && !opts.dryRun
    return {
      ok: !blocked,
      code: blocked ? 1 : 0,
      stdout: JSON.stringify(opts.dryRun || blocked ? summary : (summary.claimed ?? { waiting: summary.waiting })) + '\n',
      stderr: blocked
        ? `Error [TARGETED_RECEIVE_BLOCKED]: queue_id=${targetQueueId} is not claimable for ${plan.env.AGENT_ID}; reason=${summary.blocked_reason}; status=${summary.observed_status ?? 'missing'}\n`
        : '',
      plan,
      summary,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [TARGETED_RECEIVE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}

export function parseDrainLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_DRAIN_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer')
  }
  return limit
}

export function parseMaxInspect(maxInspect: number | undefined): number {
  if (maxInspect === undefined) return DEFAULT_MAX_INSPECT
  if (!Number.isInteger(maxInspect) || maxInspect < 1) {
    throw new Error('--max-inspect must be a positive integer')
  }
  return Math.min(maxInspect, MAX_INSPECT_CAP)
}

export function parseReconcileLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RECONCILE_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer')
  }
  return Math.min(limit, MAX_RECONCILE_LIMIT)
}

function parseClaim(stdout: string): ClaimedMessage {
  try {
    return JSON.parse(stdout) as ClaimedMessage
  } catch (err) {
    throw new Error(`failed to parse agent-com next JSON: ${(err as Error).message}`)
  }
}

export function drain(opts: DrainOptions = {}): DrainResult {
  const limit = parseDrainLimit(opts.limit)
  const plan = buildReceivePlan(opts)
  if (opts.dryRun) {
    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        dry_run: true,
        cwd: plan.repoRoot,
        argv: plan.argv,
        agent_id: plan.env.AGENT_ID,
        expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
        database_url_candidates: plan.databaseUrlCandidates,
        limit,
      }) + '\n',
      stderr: '',
      plan,
      claimed: [],
    }
  }

  const claimed: ClaimedMessage[] = []
  let waiting = 0
  for (let i = 0; i < limit; i++) {
    const result = runCommandPlan(plan)
    if (!result.ok) {
      return {
        ...result,
        stdout: JSON.stringify({ ok: false, claimed, waiting }) + '\n',
        plan,
        claimed,
      }
    }

    let body: ClaimedMessage
    try {
      body = parseClaim(result.stdout)
    } catch (err) {
      return {
        ok: false,
        code: 1,
        stdout: JSON.stringify({ ok: false, claimed, waiting }) + '\n',
        stderr: `Error [DRAIN_PARSE_FAILED]: ${(err as Error).message}\n`,
        plan,
        claimed,
      }
    }

    waiting = body.waiting ?? 0
    if (body.queue_id === undefined) break
    claimed.push(body)
    if (waiting <= 0) break
  }

  const capped = claimed.length >= limit && waiting > 0
  return {
    ok: true,
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      claimed,
      claimed_count: claimed.length,
      waiting,
      limit,
      capped,
    }) + '\n',
    stderr: '',
    plan,
    claimed,
  }
}

function dbKind(env: Record<string, string>): 'postgres' | 'sqlite' {
  const explicit = env.AGENT_COM_DB?.trim()
  if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres'
  if (explicit === 'sqlite') return 'sqlite'
  return env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite'
}

function normalizeDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.trim()) return value
  return null
}

function ageSeconds(value: unknown, now = Date.now()): number | null {
  const normalized = normalizeDate(value)
  if (!normalized) return null
  const millis = Date.parse(normalized)
  if (Number.isNaN(millis)) return null
  return Math.max(0, Math.floor((now - millis) / 1000))
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'string') return {}
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function queuePayloadWithReceiveClaim(
  payload: Record<string, unknown>,
  input: { source: string | null; agentId: string; queueId: string },
): string | null {
  if (!input.source) return null
  return JSON.stringify({
    ...payload,
    receive_claim: {
      mode: 'targeted-receive',
      source: input.source,
      agent_id: input.agentId,
      queue_id: input.queueId,
    },
  })
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function booleanFromUnknown(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1') return true
    if (normalized === 'false' || normalized === '0') return false
  }
  return null
}

function stringsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return stringsFromUnknown(parsed)
  } catch {}
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function targetDiscordIdFromRow(row: Record<string, unknown>): string | null {
  const metadata = parseObject(row.target_metadata)
  const expected = parseObject(row.target_expected_provider_identity)
  const candidates = [
    metadata.discord_id,
    metadata.discord_user_id,
    expected.subject,
    expected.discord_id,
    expected.discord_user_id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function mentionsForRouting(row: Record<string, unknown>, payload: Record<string, unknown>): string[] {
  const storedMetadata = parseObject(row.stored_metadata)
  return [
    ...stringsFromUnknown(payload.mentions),
    ...stringsFromUnknown(payload.input_mentions),
    ...stringsFromUnknown(storedMetadata.mentions),
    ...stringsFromUnknown(row.stored_input_mentions),
  ]
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function contentPreview(value: unknown): string {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact
}

function resolveMessageType(row: Record<string, unknown>, payload: Record<string, unknown>): string {
  const payloadType = payload.message_type
  if (typeof payloadType === 'string' && payloadType.trim()) return payloadType.trim()
  const storedType = row.stored_message_type
  if (typeof storedType === 'string' && storedType.trim()) return storedType.trim()
  return 'unknown'
}

function classifyMessageType(messageType: string): DiagnosedQueueRow['classification'] {
  return classifyQueueMessageType(messageType)
}

function normalizeQueueRow(row: Record<string, unknown>): DiagnosedQueueRow {
  const payload = parsePayload(row.payload)
  const messageType = resolveMessageType(row, payload)
  const payloadAuthor = payload.author_id
  const storedAuthor = row.stored_author_id
  const authorId = typeof payloadAuthor === 'string'
    ? payloadAuthor
    : typeof storedAuthor === 'string' ? storedAuthor : null
  const source = typeof payload.source === 'string'
    ? payload.source
    : typeof row.stored_source === 'string' ? row.stored_source : null
  const routing = decideQueueRouting({
    target_agent_id: String(row.agent_id ?? ''),
    target_runtime: typeof row.target_runtime === 'string' ? row.target_runtime : null,
    target_status: typeof row.target_status === 'string' ? row.target_status : null,
    target_profile_enabled: booleanFromUnknown(row.target_profile_enabled),
    target_disabled_at: normalizeDate(row.target_disabled_at),
    target_discord_id: targetDiscordIdFromRow(row),
    message_type: messageType,
    source,
    content: typeof payload.content === 'string'
      ? payload.content
      : typeof row.stored_content === 'string' ? row.stored_content : null,
    author_id: authorId,
    mentions: mentionsForRouting(row, payload),
    channel_policy: {
      policy_source: typeof row.channel_policy_source === 'string' ? row.channel_policy_source : null,
      primary_agent_id: typeof row.channel_policy_primary_agent_id === 'string' ? row.channel_policy_primary_agent_id : null,
      adapter_owner_agent_id: typeof row.channel_policy_adapter_owner_agent_id === 'string' ? row.channel_policy_adapter_owner_agent_id : null,
    },
  })
  return {
    queue_id: row.id as string | number,
    message_id: (row.message_id as string | null | undefined) ?? null,
    agent_id: String(row.agent_id ?? ''),
    message_type: messageType,
    author_id: authorId,
    status: String(row.status ?? ''),
    priority: Number(row.priority ?? 0),
    created_at: normalizeDate(row.created_at),
    classification: classifyMessageType(messageType),
    routing_decision: routing.routing_decision,
    route_reason: routing.route_reason,
    routing,
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanField(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key]
  return typeof value === 'boolean' ? value : null
}

function presentationInput(payload: Record<string, unknown>): { source: Record<string, unknown>; hasMetadata: boolean } {
  const nested = objectValue(payload.canonical_presentation) ?? objectValue(payload.presentation)
  const source = nested ? { ...payload, ...nested } : payload
  const keys = [
    'presentation_group_id',
    'fragment_count',
    'fragment_index',
    'is_claimable',
    'canonical_body_hash',
    'fragment_body_hash',
    'parent_message_id',
    'child_request_id',
  ]
  return { source, hasMetadata: keys.some((key) => source[key] !== undefined) }
}

function contentForPresentation(row: Record<string, unknown>, payload: Record<string, unknown>): string {
  const payloadContent = payload.content
  if (typeof payloadContent === 'string') return payloadContent
  const storedContent = row.stored_content
  return typeof storedContent === 'string' ? storedContent : ''
}

function validFragmentIndex(index: number, count: number): boolean {
  return Number.isInteger(index) && (
    (index >= 0 && index < count) ||
    (index >= 1 && index <= count)
  )
}

function evaluatePresentationClaimability(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
): { evidence: PresentationEvidence; blocked_reason: TargetedReceiveBlockedReason | null } {
  const { source, hasMetadata } = presentationInput(payload)
  const groupId = stringField(source, 'presentation_group_id')
  const rawCount = numberField(source, 'fragment_count')
  const rawIndex = numberField(source, 'fragment_index')
  const isClaimable = booleanField(source, 'is_claimable')
  const canonicalBodyHash = stringField(source, 'canonical_body_hash')
  const fragmentBodyHash = stringField(source, 'fragment_body_hash')
  const parentMessageId = stringField(source, 'parent_message_id')
  const childRequestId = stringField(source, 'child_request_id')
  const content = contentForPresentation(row, payload)

  const count = rawCount ?? 1
  const index = rawIndex ?? 0
  const explicitChildRequest = !!childRequestId
  const claimable = isClaimable ?? (!hasMetadata || count <= 1 || explicitChildRequest)
  const evidence: PresentationEvidence = {
    kind: explicitChildRequest ? 'child_request' : (hasMetadata ? 'canonical' : 'unsplit'),
    presentation_group_id: groupId,
    fragment_count: count,
    fragment_index: index,
    is_claimable: claimable,
    canonical_body_hash: canonicalBodyHash ?? (content ? sha256(content) : null),
    fragment_body_hash: fragmentBodyHash,
    parent_message_id: parentMessageId,
    child_request_id: childRequestId,
  }

  if (!Number.isInteger(count) || count < 1) {
    return { evidence, blocked_reason: 'PRESENTATION_GROUP_CONFLICT' }
  }
  if (count > 1 && rawIndex === null && !explicitChildRequest) {
    return { evidence, blocked_reason: 'PRESENTATION_GROUP_INCOMPLETE' }
  }
  if (!validFragmentIndex(index, count)) {
    return { evidence, blocked_reason: 'PRESENTATION_GROUP_CONFLICT' }
  }
  if (isClaimable === false) {
    return { evidence: { ...evidence, is_claimable: false }, blocked_reason: 'FRAGMENT_NOT_CLAIMABLE' }
  }
  if (count > 1 && !groupId && !explicitChildRequest) {
    return { evidence, blocked_reason: 'PRESENTATION_GROUP_INCOMPLETE' }
  }
  if (count > 1 && isClaimable !== true && !explicitChildRequest) {
    return { evidence: { ...evidence, is_claimable: false }, blocked_reason: 'CANONICAL_MESSAGE_REQUIRED' }
  }
  if (count > 1 && !canonicalBodyHash && !explicitChildRequest) {
    return { evidence, blocked_reason: 'CANONICAL_MESSAGE_REQUIRED' }
  }
  if (canonicalBodyHash && content && canonicalBodyHash !== sha256(content)) {
    return { evidence, blocked_reason: 'PRESENTATION_GROUP_CONFLICT' }
  }

  return { evidence, blocked_reason: null }
}

function selectActionableRow(rows: DiagnosedQueueRow[]): { row: DiagnosedQueueRow | null; reason: string | null } {
  const actionable = rows.filter((row) => row.routing_decision === 'wake_agent')
  if (actionable.length === 0) return { row: null, reason: null }

  const instructions = actionable.filter((row) => row.message_type === 'instruction')
  if (instructions.length > 0) {
    return {
      row: instructions[instructions.length - 1],
      reason: 'newest_explicit_instruction',
    }
  }

  return {
    row: actionable[0],
    reason: 'oldest_actionable_fifo',
  }
}

function claimedMessageFromRow(
  row: DiagnosedQueueRow,
  payload: Record<string, unknown>,
  waiting: number,
  claimIdentity?: {
    claimed_by: string
    claimed_at: string
    claim_expires_at: string
  } | null,
): ClaimedMessage {
  return {
    waiting,
    mode: 'queue',
    queue_id: row.queue_id,
    message_id: row.message_id,
    channel_id: typeof payload.channel_id === 'string' ? payload.channel_id : undefined,
    thread_id: typeof payload.thread_id === 'string' ? payload.thread_id : null,
    from: row.author_id ?? undefined,
    content: typeof payload.content === 'string' ? payload.content : undefined,
    message_type: row.message_type,
    source: typeof payload.source === 'string' ? payload.source : null,
    created_at: row.created_at ?? undefined,
    ...(claimIdentity ?? {}),
    ...(row.presentation ? { presentation: row.presentation } : {}),
    routing: row.routing,
  }
}

function parseCursor(cursor?: string): { created_at: string; id: string } | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.created_at === 'string' &&
      typeof parsed.id === 'string'
    ) {
      return { created_at: parsed.created_at, id: parsed.id }
    }
  } catch {}
  throw new Error('--cursor must be an aun reconcile cursor')
}

function encodeCursor(row: ReconcileRow): string {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at ?? '',
    id: String(row.queue_id),
  }), 'utf8').toString('base64url')
}

function terminalInvariantWarnings(row: Record<string, unknown>): string[] {
  const status = String(row.status ?? '')
  const warnings: string[] = []
  if (status === 'replied') {
    if (!row.replied_at) warnings.push('missing_replied_at')
    if (!row.replied_with) warnings.push('missing_replied_with')
  }
  if (status === 'done' && !row.done_at) warnings.push('missing_done_at')
  if ((status === 'skipped' || status === 'failed') && !row.failed_reason) warnings.push('missing_failed_reason')
  if ((status === 'skipped' || status === 'failed') && !row.done_at) warnings.push('missing_done_at')
  return warnings
}

function reconcileClassification(
  row: Record<string, unknown>,
  messageType: string,
  payload: Record<string, unknown>,
  terminalWarnings: string[],
  ageDays: number | null,
  notifyFallbackEvidence?: NotifyFallbackEvidence | null,
): ReconcileClass {
  const status = String(row.status ?? '')
  const agentId = String(row.agent_id ?? '')
  const source = typeof payload.source === 'string'
    ? payload.source
    : typeof row.stored_source === 'string' ? row.stored_source : ''

  if (terminalWarnings.length > 0) return 'terminal_legacy_invariant'
  if (TERMINAL_STATUSES.has(status)) return 'already_terminal'
  if (ACTIVE_STATUSES.has(status)) return 'active_claim'
  if (status === 'pending' && notifyFallbackEvidence?.found) return 'notify_fallback_result'
  if ((agentId === 'cto' || agentId === 'codex-cto') && status === 'pending') return 'identity_split'
  if (messageType === 'projection' || source.includes('projection') || source.includes('relay')) return 'projection_only'
  if (source === 'cli-notify' || source === 'notify' || String(payload.content ?? '').includes('fallback: notify')) {
    return 'notify_fallback_result'
  }
  if (ACTIONABLE_MESSAGE_TYPES.has(messageType)) return ageDays !== null && ageDays >= 7 ? 'actionable_stale' : 'actionable_current'
  if (NON_ACTIONABLE_MESSAGE_TYPES.has(messageType)) return 'obsolete_notice'
  return 'unknown_type'
}

function proposedActionForClass(klass: ReconcileClass): {
  action: ReconcileAction
  authority: string
  requiredEvidence: string[]
} {
  switch (klass) {
    case 'actionable_current':
    case 'actionable_stale':
      return {
        action: 'claim_for_work',
        authority: 'routed_agent',
        requiredEvidence: ['queue_id', 'message_id', 'message_type', 'author_id', 'created_at'],
      }
    case 'active_claim':
      return {
        action: 'keep_pending',
        authority: 'any_reviewer',
        requiredEvidence: ['claimed_by', 'claimed_at', 'claim_expires_at', 'status'],
      }
    case 'obsolete_notice':
    case 'projection_only':
      return {
        action: 'request_human_review',
        authority: 'cto_approved_reconciliation',
        requiredEvidence: ['classification_reason', 'plan_hash', 'reviewer_approval'],
      }
    case 'identity_split':
      return {
        action: 'request_human_review',
        authority: 'cto_or_alias_policy',
        requiredEvidence: ['alias_rule_id', 'canonical_agent_id', 'reviewer_approval'],
      }
    case 'notify_fallback_result':
      return {
        action: 'request_human_review',
        authority: 'cto_approved_reconciliation',
        requiredEvidence: ['notify_message_id', 'source_queue_id', 'content_hash', 'reviewer_approval'],
      }
    case 'terminal_legacy_invariant':
      return {
        action: 'request_human_review',
        authority: 'cto_approved_reconciliation',
        requiredEvidence: ['observed_status', 'missing_terminal_fields', 'reviewer_approval'],
      }
    case 'already_terminal':
      return {
        action: 'keep_pending',
        authority: 'any_reviewer',
        requiredEvidence: ['terminal_status', 'terminal_evidence'],
      }
    case 'unknown_type':
    default:
      return {
        action: 'request_human_review',
        authority: 'any_reviewer',
        requiredEvidence: ['raw_message_type', 'payload_keys', 'parser_warning'],
      }
  }
}

function normalizeReconcileRow(row: Record<string, unknown>): ReconcileRow {
  const notifyFallbackEvidence = isNotifyFallbackEvidence(row.notify_fallback_evidence)
    ? row.notify_fallback_evidence
    : null
  const payload = parsePayload(row.payload)
  const messageType = resolveMessageType(row, payload)
  const payloadAuthor = payload.author_id
  const storedAuthor = row.stored_author_id
  const payloadContent = typeof payload.content === 'string' ? payload.content : ''
  const storedContent = typeof row.stored_content === 'string' ? row.stored_content : ''
  const content = payloadContent || storedContent
  const source = typeof payload.source === 'string'
    ? payload.source
    : typeof row.stored_source === 'string' ? row.stored_source : null
  const createdAt = normalizeDate(row.created_at)
  const age = ageSeconds(row.created_at)
  const ageDays = age === null ? null : Math.floor(age / 86_400)
  const terminalWarnings = terminalInvariantWarnings(row)
  const klass = reconcileClassification(row, messageType, payload, terminalWarnings, ageDays, notifyFallbackEvidence)
  const proposal = proposedActionForClass(klass)
  const flags = [
    ...(terminalWarnings.length > 0 ? terminalWarnings : []),
    ...(row.message_id ? [] : ['message_row_missing']),
    ...(typeof row.payload === 'string' ? [] : ['payload_parse_error']),
    ...(notifyFallbackEvidence?.found ? ['notify_fallback_result_found'] : []),
    ...(agentAliasFlag(String(row.agent_id ?? ''), String(payloadAuthor ?? storedAuthor ?? ''))),
  ]
  const canonicalFields = {
    queue_id: String(row.id ?? ''),
    message_id: (row.message_id as string | null | undefined) ?? null,
    agent_id: String(row.agent_id ?? ''),
    status: String(row.status ?? ''),
    created_at: createdAt,
    claimed_by: (row.claimed_by as string | null | undefined) ?? null,
    claimed_at: normalizeDate(row.claimed_at),
    claim_expires_at: normalizeDate(row.claim_expires_at),
    replied_with: (row.replied_with as string | null | undefined) ?? null,
    replied_at: normalizeDate(row.replied_at),
    failed_reason: (row.failed_reason as string | null | undefined) ?? null,
    done_at: normalizeDate(row.done_at),
    payload_hash: typeof row.payload === 'string' ? sha256(row.payload) : null,
    message_type: messageType,
    author_id: typeof payloadAuthor === 'string'
      ? payloadAuthor
      : typeof storedAuthor === 'string' ? storedAuthor : null,
    source,
    content_hash: content ? sha256(content) : null,
  }
  return {
    queue_id: row.id as string | number,
    message_id: (row.message_id as string | null | undefined) ?? null,
    agent_id: String(row.agent_id ?? ''),
    status: String(row.status ?? ''),
    message_type: messageType,
    author_id: canonicalFields.author_id,
    source,
    created_at: createdAt,
    claimed_by: (row.claimed_by as string | null | undefined) ?? null,
    claimed_at: normalizeDate(row.claimed_at),
    claim_expires_at: normalizeDate(row.claim_expires_at),
    replied_at: normalizeDate(row.replied_at),
    replied_with: (row.replied_with as string | null | undefined) ?? null,
    failed_reason: (row.failed_reason as string | null | undefined) ?? null,
    done_at: normalizeDate(row.done_at),
    classification: klass,
    flags,
    proposed_action: proposal.action,
    required_authority: proposal.authority,
    required_evidence: proposal.requiredEvidence,
    evidence: {
      status: String(row.status ?? ''),
      age_days: ageDays,
      terminal_warnings: terminalWarnings,
      payload_keys: Object.keys(payload).sort(),
      notify_fallback_result: notifyFallbackEvidence ?? null,
      note: 'dry-run only; no queue row was mutated',
    },
    fingerprint: {
      version: 1,
      algorithm: 'sha256',
      canonical_fields: canonicalFields,
      hash: sha256(stableJson(canonicalFields)),
    },
    content_preview: contentPreview(content),
    content_hash: content ? sha256(content) : null,
  }
}

function isNotifyFallbackEvidence(value: unknown): value is NotifyFallbackEvidence {
  return typeof value === 'object' && value !== null && (value as { found?: unknown }).found === true
}

function markerPatternsForRow(row: Record<string, unknown>): Array<{ pattern: string; linkType: NotifyFallbackEvidence['link_type'] }> {
  const queueId = String(row.id ?? '')
  const messageId = typeof row.message_id === 'string' && row.message_id.length > 0 ? row.message_id : null
  return [
    { pattern: `%source_queue_id=${queueId}%`, linkType: 'source_queue_id' },
    ...(messageId ? [{ pattern: `%source_message_id=${messageId}%`, linkType: 'source_message_id' as const }] : []),
  ]
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>
  if (typeof value !== 'string' || value.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function fallbackNotifyMetadata(candidate: Record<string, unknown>): Record<string, unknown> {
  const metadata = metadataObject(candidate.metadata)
  const fallback = metadata.fallback_notify
  return typeof fallback === 'object' && fallback !== null ? fallback as Record<string, unknown> : {}
}

async function loadNotifyFallbackEvidence(
  db: DbAdapter,
  rows: Array<Record<string, unknown>>,
): Promise<Map<string, NotifyFallbackEvidence>> {
  const targets = rows.filter((row) => String(row.status ?? '') === 'pending')
  if (targets.length === 0) return new Map()

  const conditions: string[] = []
  const params: unknown[] = []
  const patternOwners: Array<{ queueId: string; sourceMessageId: string | null; linkType: NotifyFallbackEvidence['link_type'] }> = []
  for (const row of targets) {
    const queueId = String(row.id ?? '')
    const sourceMessageId = typeof row.message_id === 'string' ? row.message_id : null
    for (const marker of markerPatternsForRow(row)) {
      params.push(marker.pattern)
      conditions.push(`am.content LIKE $${params.length}`)
      patternOwners.push({ queueId, sourceMessageId, linkType: marker.linkType })
    }
    if (sourceMessageId) {
      params.push(sourceMessageId)
      conditions.push(`am.reply_to = $${params.length}`)
      params.push(`%"source_message_id":"${sourceMessageId}"%`)
      conditions.push(`am.metadata::text LIKE $${params.length}`)
    }
    params.push(`%"source_queue_id":"${queueId}"%`)
    conditions.push(`am.metadata::text LIKE $${params.length}`)
  }
  if (conditions.length === 0) return new Map()

  const candidates = await db.query<Record<string, unknown>>(
    `SELECT am.id, am.author_id, am.content, am.created_at, am.reply_to, am.metadata
       FROM agent_messages am
      WHERE (${conditions.join(' OR ')})
      ORDER BY am.created_at ASC, am.id ASC
      LIMIT 100`,
    params,
  )

  const evidence = new Map<string, NotifyFallbackEvidence>()
  for (const candidate of candidates) {
    const content = typeof candidate.content === 'string' ? candidate.content : ''
    for (const owner of patternOwners) {
      if (evidence.has(owner.queueId)) continue
      const metadata = fallbackNotifyMetadata(candidate)
      const metadataQueueId = typeof metadata.source_queue_id === 'string' ? metadata.source_queue_id : null
      const metadataMessageId = typeof metadata.source_message_id === 'string' ? metadata.source_message_id : null
      const metadataMatchesQueue = metadataQueueId === owner.queueId
      const metadataMatchesMessage = !!owner.sourceMessageId && metadataMessageId === owner.sourceMessageId
      if (metadataMatchesQueue || metadataMatchesMessage) {
        evidence.set(owner.queueId, {
          found: true,
          notify_message_id: String(candidate.id ?? ''),
          notify_author_id: typeof candidate.author_id === 'string' ? candidate.author_id : null,
          notify_created_at: normalizeDate(candidate.created_at),
          notify_content_hash: content ? sha256(content) : null,
          source_queue_id: owner.queueId,
          source_message_id: owner.sourceMessageId,
          link_type: metadataMatchesQueue ? 'source_queue_id' : 'source_message_id',
          evidence_source: 'metadata_marker',
        })
        continue
      }
      const exactMarker = owner.linkType === 'source_queue_id'
        ? `source_queue_id=${owner.queueId}`
        : owner.sourceMessageId ? `source_message_id=${owner.sourceMessageId}` : ''
      if (!exactMarker || !content.includes(exactMarker)) continue
      evidence.set(owner.queueId, {
        found: true,
        notify_message_id: String(candidate.id ?? ''),
        notify_author_id: typeof candidate.author_id === 'string' ? candidate.author_id : null,
        notify_created_at: normalizeDate(candidate.created_at),
        notify_content_hash: content ? sha256(content) : null,
        source_queue_id: owner.queueId,
        source_message_id: owner.sourceMessageId,
        link_type: owner.linkType,
        evidence_source: 'content_marker',
      })
    }
  }
  return evidence
}

function agentAliasFlag(agentId: string, authorId: string): string[] {
  const pair = new Set([agentId, authorId])
  return pair.has('cto') && pair.has('codex-cto') ? ['author_alias_mismatch'] : []
}

async function withDb<T>(
  env: Record<string, string>,
  candidates: string[],
  fn: (db: DbAdapter, databaseUrl?: string) => Promise<T>,
): Promise<T> {
  if (dbKind(env) === 'sqlite') {
    const db = new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
    try {
      return await fn(db)
    } finally {
      await db.close()
    }
  }

  let lastErr: unknown
  for (const candidate of candidates) {
    const { PgAdapter } = await import('../../core/db/pg-adapter')
    const db = new PgAdapter(candidate)
    try {
      return await fn(db, candidate)
    } catch (err) {
      lastErr = err
      if (!shouldTryNextSocket(String((err as Error).message ?? err))) throw err
    } finally {
      await db.close().catch(() => {})
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function memoryReadyProject(env: Record<string, string>): string {
  const configured = env.AGENT_COMMS_MEMORY_READY_PROJECT?.trim()
    || env.AGENT_MEMORY_PROJECT?.trim()
  if (configured) return configured
  if (env.AUN_RECEIVE_CLAIM_SOURCE?.trim() === 'state-daemon-queue-work-scheduler') {
    throw new Error('STATE_DAEMON_TARGET_MEMORY_READY_PROJECT_REQUIRED')
  }
  return 'agent-comms-mcp'
}

export async function diagnoseReceive(opts: DiagnoseReceiveOptions = {}): Promise<DiagnoseReceiveResult> {
  let plan: ReceivePlan
  let maxInspect: number
  try {
    plan = buildReceivePlan(opts)
    maxInspect = parseMaxInspect(opts.maxInspect)
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [DIAGNOSE_RECEIVE_FAILED]: ${(err as Error).message}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'cli/index.ts', 'next'],
        env: cleanEnv(opts.env ?? process.env),
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      const pendingRows = await db.query<Record<string, unknown>>(
        `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                am.content AS stored_content,
                am.message_type AS stored_message_type,
                am.author_id AS stored_author_id,
                am.source AS stored_source,
                am.metadata AS stored_metadata,
                am.input_mentions AS stored_input_mentions,
                a.runtime AS target_runtime,
                a.status AS target_status,
                a.metadata AS target_metadata,
                a.profile_enabled AS target_profile_enabled,
                a.disabled_at AS target_disabled_at,
                a.expected_provider_identity AS target_expected_provider_identity,
                crp.policy_source AS channel_policy_source,
                crp.primary_agent_id AS channel_policy_primary_agent_id,
                crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
           FROM message_queue mq
           LEFT JOIN agent_messages am ON am.id::text = mq.message_id
           LEFT JOIN agents a ON a.agent_id = mq.agent_id
           LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
          WHERE mq.agent_id = $1 AND mq.status = 'pending'
          ORDER BY mq.priority DESC, mq.created_at ASC
          LIMIT $2`,
        [plan.env.AGENT_ID, maxInspect],
      )
      const totalPendingRow = await db.queryOne<{ n: number | string }>(
        `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
        [plan.env.AGENT_ID],
      )
      const oldestPendingRow = await db.queryOne<{ created_at: unknown }>(
        `SELECT created_at FROM message_queue
          WHERE agent_id = $1 AND status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1`,
        [plan.env.AGENT_ID],
      )
      const activeClaimRow = await db.queryOne<Record<string, unknown>>(
        `SELECT id, message_id, status, claimed_at, claim_expires_at
           FROM message_queue
          WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
          ORDER BY claimed_at DESC
          LIMIT 1`,
        [plan.env.AGENT_ID],
      )
      const splitRows = await db.query<{
        agent_id: string
        pending_count: number | string
        active_count: number | string
        oldest_pending_at: unknown
      }>(
        `SELECT agent_id,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::int AS pending_count,
                SUM(CASE WHEN status IN ('received', 'in_progress') THEN 1 ELSE 0 END)::int AS active_count,
                MIN(CASE WHEN status = 'pending' THEN created_at ELSE NULL END) AS oldest_pending_at
           FROM message_queue
          WHERE agent_id IN ('cto', 'codex-cto')
          GROUP BY agent_id
          ORDER BY agent_id ASC`,
      )

      const inspected = pendingRows.map(normalizeQueueRow)
      const typeCounts: Record<string, number> = {}
      for (const row of inspected) {
        typeCounts[row.message_type] = (typeCounts[row.message_type] ?? 0) + 1
      }

      const candidateIndex = inspected.findIndex((row) => row.classification === 'actionable')
      const candidate = candidateIndex >= 0 ? inspected[candidateIndex] : null
      const busy = !!activeClaimRow
      const pending: DiagnoseReceiveSummary['cto_identity_split']['pending'] = {
        cto: { pending_count: 0, active_count: 0, oldest_pending_at: null },
        'codex-cto': { pending_count: 0, active_count: 0, oldest_pending_at: null },
      }
      for (const row of splitRows) {
        pending[row.agent_id] = {
          pending_count: Number(row.pending_count ?? 0),
          active_count: Number(row.active_count ?? 0),
          oldest_pending_at: normalizeDate(row.oldest_pending_at),
        }
      }

      const summary: DiagnoseReceiveSummary = {
        ok: true,
        dry_run: true,
        mode: 'diagnose-receive',
        agent_id: plan.env.AGENT_ID,
        expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
        database: dbKind(plan.env) === 'sqlite'
          ? { kind: 'sqlite', sqlite_path: plan.env.AGENT_COM_SQLITE_PATH ?? './agent-com.db' }
          : { kind: 'postgres', url_candidates: plan.databaseUrlCandidates },
        max_inspect: maxInspect,
        inspected_count: inspected.length,
        total_pending: Number(totalPendingRow?.n ?? 0),
        oldest_pending_age_seconds: ageSeconds(oldestPendingRow?.created_at),
        selected: busy ? null : candidate,
        candidate,
        selection_blocked_reason: busy ? 'active_claim' : candidate ? null : 'none_found',
        skipped_non_action_count: inspected.filter((row) => row.classification === 'non_action').length,
        skipped_non_action_before_candidate: candidateIndex >= 0
          ? inspected.slice(0, candidateIndex).filter((row) => row.classification === 'non_action').length
          : inspected.filter((row) => row.classification === 'non_action').length,
        unknown_type_count: inspected.filter((row) => row.classification === 'unknown').length,
        unknown_type_samples: inspected.filter((row) => row.classification === 'unknown').slice(0, 5),
        type_counts: typeCounts,
        active_claim: {
          busy,
          queue_id: activeClaimRow ? activeClaimRow.id as string | number : null,
          message_id: (activeClaimRow?.message_id as string | null | undefined) ?? null,
          status: (activeClaimRow?.status as string | null | undefined) ?? null,
          claimed_at: normalizeDate(activeClaimRow?.claimed_at),
          claim_expires_at: normalizeDate(activeClaimRow?.claim_expires_at),
        },
        cto_identity_split: {
          checked_agent_ids: ['cto', 'codex-cto'],
          split_detected: pending.cto.pending_count + pending.cto.active_count > 0
            && pending['codex-cto'].pending_count + pending['codex-cto'].active_count > 0,
          pending,
          note: 'diagnostic only; no identity rows, registry entries, or runtime config were mutated',
        },
        next_action: busy
          ? 'finish or expire the active claim before receiving another message'
          : candidate
            ? 'claim the selected actionable queue row with aun receive/next when ready'
            : 'no actionable instruction/request/question found within the inspected window',
      }
      return summary
    })

    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(summary) + '\n',
      stderr: '',
      plan,
      summary,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [DIAGNOSE_RECEIVE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}

export async function receiveActionable(opts: ActionableReceiveOptions = {}): Promise<ActionableReceiveResult> {
  let plan: ReceivePlan
  let maxInspect: number
  const targetQueueId = opts.queueId?.trim()
  try {
    plan = buildCommandPlan(opts, ['bun', 'bin/aun.ts', 'receive-actionable'])
    maxInspect = parseMaxInspect(opts.maxInspect)
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [RECEIVE_ACTIONABLE_FAILED]: ${(err as Error).message}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts', 'receive-actionable'],
        env: cleanEnv(opts.env ?? process.env),
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      return db.transaction<ActionableReceiveSummary>(async (tx) => {
        const memoryReady = await evaluateRuntimeMemoryReadyGate(tx as any, {
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          project: memoryReadyProject(plan.env),
        })
        if (!memoryReady.ok) {
          const waitingRow = await tx.queryOne<{ n: number | string }>(
            `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
            [plan.env.AGENT_ID],
          ).catch(() => ({ n: 0 }))
          return {
            ok: false,
            dry_run: !!opts.dryRun,
            mode: 'receive-actionable',
            agent_id: plan.env.AGENT_ID,
            expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
            max_inspect: maxInspect,
            inspected_count: 0,
            waiting: Number(waitingRow?.n ?? 0),
            selected: null,
            claimed: null,
            blocked_reason: 'memory_not_ready',
            active_claim: {
              busy: false,
              queue_id: null,
              message_id: null,
              status: null,
              claimed_at: null,
              claim_expires_at: null,
            },
            skipped_non_action_count: 0,
            unknown_type_count: 0,
            selection_reason: `memory_ready_${memoryReady.reason}`,
            memory_ready: memoryReady,
          }
        }
        const rowsSql = targetQueueId
          ? `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                  mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  am.content AS stored_content,
                  am.message_type AS stored_message_type,
                  am.author_id AS stored_author_id,
                  am.source AS stored_source,
                  am.metadata AS stored_metadata,
                  am.input_mentions AS stored_input_mentions,
                  a.runtime AS target_runtime,
                  a.status AS target_status,
                  a.metadata AS target_metadata,
                  a.profile_enabled AS target_profile_enabled,
                  a.disabled_at AS target_disabled_at,
                  a.expected_provider_identity AS target_expected_provider_identity,
                  crp.policy_source AS channel_policy_source,
                  crp.primary_agent_id AS channel_policy_primary_agent_id,
                  crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
             LEFT JOIN agents a ON a.agent_id = mq.agent_id
             LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
            WHERE mq.agent_id = $1 AND mq.id::text = $2
            LIMIT 1`
          : `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                  mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  am.content AS stored_content,
                  am.message_type AS stored_message_type,
                  am.author_id AS stored_author_id,
                  am.source AS stored_source,
                  am.metadata AS stored_metadata,
                  am.input_mentions AS stored_input_mentions,
                  a.runtime AS target_runtime,
                  a.status AS target_status,
                  a.metadata AS target_metadata,
                  a.profile_enabled AS target_profile_enabled,
                  a.disabled_at AS target_disabled_at,
                  a.expected_provider_identity AS target_expected_provider_identity,
                  crp.policy_source AS channel_policy_source,
                  crp.primary_agent_id AS channel_policy_primary_agent_id,
                  crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
             LEFT JOIN agents a ON a.agent_id = mq.agent_id
             LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
            WHERE mq.agent_id = $1 AND mq.status = 'pending'
            ORDER BY mq.priority DESC, mq.created_at ASC
            LIMIT $2`
        const pendingRows = await tx.query<Record<string, unknown>>(
          rowsSql,
          targetQueueId ? [plan.env.AGENT_ID, targetQueueId] : [plan.env.AGENT_ID, maxInspect],
        )
        const activeClaimRow = await tx.queryOne<Record<string, unknown>>(
          `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                  mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  am.content AS stored_content,
                  am.message_type AS stored_message_type,
                  am.author_id AS stored_author_id,
                  am.source AS stored_source,
                  am.metadata AS stored_metadata,
                  am.input_mentions AS stored_input_mentions,
                  a.runtime AS target_runtime,
                  a.status AS target_status,
                  a.metadata AS target_metadata,
                  a.profile_enabled AS target_profile_enabled,
                  a.disabled_at AS target_disabled_at,
                  a.expected_provider_identity AS target_expected_provider_identity,
                  crp.policy_source AS channel_policy_source,
                  crp.primary_agent_id AS channel_policy_primary_agent_id,
                  crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
             LEFT JOIN agents a ON a.agent_id = mq.agent_id
             LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
            WHERE mq.claimed_by = $1 AND mq.status IN ('received', 'in_progress')
            ORDER BY claimed_at DESC
            LIMIT 1`,
          [plan.env.AGENT_ID],
        )
        const presentationByQueueId = new Map<string, ReturnType<typeof evaluatePresentationClaimability>>()
        const inspected = pendingRows.map((row) => {
          const payload = parsePayload(row.payload)
          const presentation = evaluatePresentationClaimability(row, payload)
          const normalized = normalizeQueueRow(row)
          presentationByQueueId.set(String(normalized.queue_id), presentation)
          return { ...normalized, presentation: presentation.evidence }
        })
        const claimableInspected = inspected.filter((row) => {
          const presentation = presentationByQueueId.get(String(row.queue_id))
          return !presentation?.blocked_reason
        })
        const targetRow = targetQueueId ? inspected[0] ?? null : null
        const targetPresentation = targetRow
          ? presentationByQueueId.get(String(targetRow.queue_id)) ?? null
          : null
        const selected = activeClaimRow
          ? { row: null, reason: 'active_claim' }
          : targetQueueId
            ? targetRow?.status !== 'pending'
              ? { row: null, reason: targetRow ? 'target_queue_not_pending' : 'target_queue_not_found' }
              : targetPresentation?.blocked_reason
                ? { row: null, reason: targetPresentation.blocked_reason }
              : targetRow.routing_decision !== 'wake_agent'
                ? { row: null, reason: targetRow.route_reason }
                : { row: targetRow, reason: 'target_queue_id' }
            : selectActionableRow(claimableInspected)
        const selectedRaw = selected.row
          ? pendingRows.find((row) => String(row.id) === String(selected.row?.queue_id)) ?? null
          : null
        let claimed: ClaimedMessage | null = null
        const activeClaim = {
          busy: !!activeClaimRow,
          queue_id: activeClaimRow ? activeClaimRow.id as string | number : null,
          message_id: (activeClaimRow?.message_id as string | null | undefined) ?? null,
          status: (activeClaimRow?.status as string | null | undefined) ?? null,
          claimed_at: normalizeDate(activeClaimRow?.claimed_at),
          claim_expires_at: normalizeDate(activeClaimRow?.claim_expires_at),
        }

        if (selected.row && selectedRaw && !activeClaim.busy && !opts.dryRun) {
          const claimTtlSec = parseInt(plan.env.AGENT_COMMS_CLAIM_TTL_SEC ?? '30', 10)
          const claimExpiresAt = new Date(Date.now() + claimTtlSec * 1000).toISOString()
          const update = await tx.execute(
            `UPDATE message_queue
                SET status = 'received',
                    read_at = now(),
                    claimed_by = $1,
                    claimed_at = now(),
                    claim_expires_at = $2
              WHERE id = $3 AND agent_id = $4 AND status = 'pending'`,
            [plan.env.AGENT_ID, claimExpiresAt, selected.row.queue_id, plan.env.AGENT_ID],
          )
          if (update.rowCount !== 1) {
            throw new Error(`selected queue row changed before claim: queue_id=${selected.row.queue_id}`)
          }
          await tx.execute(
            `UPDATE agents SET
               status = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'busy' ELSE 'idle' END,
               status_detail = CASE WHEN EXISTS(SELECT 1 FROM message_queue WHERE claimed_by = $1 AND status = 'received') THEN 'メッセージ処理中' ELSE NULL END,
               status_updated_at = now()
             WHERE agent_id = $1`,
            [plan.env.AGENT_ID],
          )
        }

        const waitingRow = await tx.queryOne<{ n: number | string }>(
          `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
          [plan.env.AGENT_ID],
        )
        const waiting = Number(waitingRow?.n ?? 0)
        const activeClaimPayload = parsePayload(activeClaimRow?.payload)
        const activeClaimSelected = activeClaimRow
          ? normalizeQueueRow(activeClaimRow)
          : null
        const activeClaimPresentation = activeClaimRow
          ? evaluatePresentationClaimability(activeClaimRow, activeClaimPayload)
          : null
        const activeClaimClaimed = activeClaimSelected && activeClaim.busy && (
          !targetQueueId || String(activeClaimSelected.queue_id) === targetQueueId
        )
          ? claimedMessageFromRow({
              ...activeClaimSelected,
              ...(activeClaimPresentation ? { presentation: activeClaimPresentation.evidence } : {}),
            }, activeClaimPayload, waiting)
          : null
        if (selected.row && !activeClaim.busy) {
          const payload = selectedRaw ? parsePayload(selectedRaw.payload) : {}
          claimed = opts.dryRun ? null : claimedMessageFromRow(selected.row, payload, waiting)
        }

        return {
          ok: !((activeClaim.busy || (targetQueueId && !selected.row)) && !opts.dryRun),
          dry_run: !!opts.dryRun,
          mode: 'receive-actionable',
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          max_inspect: maxInspect,
          inspected_count: inspected.length,
          waiting,
          selected: selected.row,
          claimed,
          blocked_reason: activeClaim.busy ? 'active_claim' : targetQueueId && !selected.row ? 'queue_not_claimable' : null,
          active_claim: {
            ...activeClaim,
            ...(activeClaimClaimed ? { claimed: activeClaimClaimed } : {}),
          },
          skipped_non_action_count: inspected.filter((row) => row.classification === 'non_action').length,
          unknown_type_count: inspected.filter((row) => row.classification === 'unknown').length,
          selection_reason: activeClaim.busy ? 'blocked_by_active_claim' : selected.reason,
          memory_ready: memoryReady,
        }
      })
    })
    const blockedByActiveClaim = summary.blocked_reason === 'active_claim' && !opts.dryRun
    const blockedByTargetQueue = summary.blocked_reason === 'queue_not_claimable' && !opts.dryRun
    const blockedByMemoryReady = summary.blocked_reason === 'memory_not_ready'

    return {
      ok: !(blockedByActiveClaim || blockedByTargetQueue || blockedByMemoryReady),
      code: blockedByActiveClaim || blockedByTargetQueue || blockedByMemoryReady ? 1 : 0,
      stdout: JSON.stringify(opts.dryRun || blockedByActiveClaim || blockedByTargetQueue || blockedByMemoryReady ? summary : (summary.claimed ?? { waiting: summary.waiting })) + '\n',
      stderr: blockedByMemoryReady
        ? `Error [RECEIVE_ACTIONABLE_BLOCKED]: memory_ready gate failed for ${plan.env.AGENT_ID}; reason=${summary.memory_ready.reason}; runtime_instance_id=${summary.memory_ready.runtime_instance_id ?? 'none'}\n`
        : blockedByActiveClaim
        ? `Error [RECEIVE_ACTIONABLE_BLOCKED]: active claim exists for ${plan.env.AGENT_ID}; finish or expire queue_id=${summary.active_claim.queue_id}\n`
        : blockedByTargetQueue
          ? `Error [RECEIVE_ACTIONABLE_BLOCKED]: queue_id=${targetQueueId} is not claimable for ${plan.env.AGENT_ID}; reason=${summary.selection_reason}\n`
        : '',
      plan,
      summary,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [RECEIVE_ACTIONABLE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}

export async function reconcile(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  let plan: ReceivePlan
  let limit: number
  let cursor: { created_at: string; id: string } | null
  try {
    plan = buildCommandPlan(opts, ['bun', 'bin/aun.ts', 'reconcile'])
    limit = parseReconcileLimit(opts.limit)
    cursor = parseCursor(opts.cursor)
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [RECONCILE_FAILED]: ${(err as Error).message}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts', 'reconcile'],
        env: cleanEnv(opts.env ?? process.env),
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      const params: unknown[] = [plan.env.AGENT_ID]
      let cursorWhere = ''
      if (cursor) {
        params.push(cursor.created_at, cursor.id)
        cursorWhere = `AND (mq.created_at > $2 OR (mq.created_at = $2 AND mq.id > $3))`
      }
      params.push(limit + 1)
      const rows = await db.query<Record<string, unknown>>(
        `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                mq.replied_at, mq.replied_with, mq.failed_reason, mq.done_at,
                am.message_type AS stored_message_type,
                am.author_id AS stored_author_id,
                am.content AS stored_content,
                am.source AS stored_source,
                am.metadata AS stored_metadata,
                am.input_mentions AS stored_input_mentions,
                a.runtime AS target_runtime,
                a.status AS target_status,
                a.metadata AS target_metadata,
                a.profile_enabled AS target_profile_enabled,
                a.disabled_at AS target_disabled_at,
                a.expected_provider_identity AS target_expected_provider_identity,
                crp.policy_source AS channel_policy_source,
                crp.primary_agent_id AS channel_policy_primary_agent_id,
                crp.adapter_owner_agent_id AS channel_policy_adapter_owner_agent_id
           FROM message_queue mq
           LEFT JOIN agent_messages am ON am.id::text = mq.message_id
           LEFT JOIN agents a ON a.agent_id = mq.agent_id
           LEFT JOIN channel_routing_policy crp ON crp.channel_id = am.channel_id
          WHERE mq.agent_id = $1
            ${cursorWhere}
          ORDER BY mq.created_at ASC, mq.id ASC
          LIMIT $${params.length}`,
        params,
      )

      const sourceRows = rows.slice(0, limit)
      const fallbackEvidence = await loadNotifyFallbackEvidence(db, sourceRows)
      const pageRows = sourceRows.map((row) => normalizeReconcileRow({
        ...row,
        notify_fallback_evidence: fallbackEvidence.get(String(row.id ?? '')) ?? null,
      }))
      const countsByClass: Record<string, number> = {}
      const countsByAction: Record<string, number> = {}
      const warnings = new Set<string>()
      for (const row of pageRows) {
        countsByClass[row.classification] = (countsByClass[row.classification] ?? 0) + 1
        countsByAction[row.proposed_action] = (countsByAction[row.proposed_action] ?? 0) + 1
        for (const flag of row.flags) warnings.add(flag)
      }
      if (rows.length > limit) warnings.add('batch_limit_truncated')

      const last = pageRows[pageRows.length - 1] ?? null
      const summary: ReconcileSummary = {
        ok: true,
        dry_run: true,
        mode: 'reconcile',
        agent_id: plan.env.AGENT_ID,
        expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
        database: dbKind(plan.env) === 'sqlite'
          ? { kind: 'sqlite', sqlite_path: plan.env.AGENT_COM_SQLITE_PATH ?? './agent-com.db' }
          : { kind: 'postgres', url_candidates: plan.databaseUrlCandidates },
        limit,
        cursor: opts.cursor ?? null,
        cursor_next: rows.length > limit && last ? encodeCursor(last) : null,
        truncated: rows.length > limit,
        inspected_count: pageRows.length,
        counts_by_class: countsByClass,
        counts_by_action: countsByAction,
        warnings: Array.from(warnings).sort(),
        rows: pageRows,
      }
      return summary
    })

    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(summary) + '\n',
      stderr: '',
      plan,
      summary,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [RECONCILE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}

export function runCommandPlan(plan: CommandPlan): Omit<ReceiveResult, 'plan'> {
  let last = { status: 1, stdout: '', stderr: '' }
  for (let i = 0; i < plan.databaseUrlCandidates.length; i++) {
    const env = { ...plan.env, DATABASE_URL: plan.databaseUrlCandidates[i] }
    const r = spawnSync(plan.argv[0], plan.argv.slice(1), {
      cwd: plan.repoRoot,
      env,
      encoding: 'utf-8',
    })
    last = {
      status: r.status ?? 1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    }
    if (last.status === 0) {
      return { ok: true, code: 0, stdout: last.stdout, stderr: last.stderr }
    }
    if (i + 1 >= plan.databaseUrlCandidates.length || !shouldTryNextSocket(last.stderr)) {
      break
    }
  }

  return {
    ok: false,
    code: last.status,
    stdout: last.stdout,
    stderr: last.stderr,
  }
}
