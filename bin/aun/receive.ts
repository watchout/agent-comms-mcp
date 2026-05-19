/**
 * Stable receive wrapper for AUN operators and bot runners.
 *
 * This intentionally delegates the actual claim semantics to `agent-com next`.
 * The wrapper only stabilizes cwd/env/socket handling so sessions do not
 * hand-type fragile raw CLI invocations.
 */
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'

export interface ReceiveOptions {
  agentId?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  dryRun?: boolean
}

export interface DrainOptions extends ReceiveOptions {
  limit?: number
}

export interface DiagnoseReceiveOptions extends ReceiveOptions {
  maxInspect?: number
}

export interface ActionableReceiveOptions extends ReceiveOptions {
  maxInspect?: number
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
  reply_chain?: unknown[]
}

export interface ReceiveResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  plan: ReceivePlan
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
  blocked_reason: 'active_claim' | null
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
const ACTIONABLE_TYPES = new Set(['instruction', 'request', 'question'])
const NON_ACTION_TYPES = new Set(['chat', 'notice', 'projection'])
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
  if (ACTIONABLE_TYPES.has(messageType)) return 'actionable'
  if (NON_ACTION_TYPES.has(messageType)) return 'non_action'
  return 'unknown'
}

function normalizeQueueRow(row: Record<string, unknown>): DiagnosedQueueRow {
  const payload = parsePayload(row.payload)
  const messageType = resolveMessageType(row, payload)
  const payloadAuthor = payload.author_id
  const storedAuthor = row.stored_author_id
  return {
    queue_id: row.id as string | number,
    message_id: (row.message_id as string | null | undefined) ?? null,
    agent_id: String(row.agent_id ?? ''),
    message_type: messageType,
    author_id: typeof payloadAuthor === 'string'
      ? payloadAuthor
      : typeof storedAuthor === 'string' ? storedAuthor : null,
    status: String(row.status ?? ''),
    priority: Number(row.priority ?? 0),
    created_at: normalizeDate(row.created_at),
    classification: classifyMessageType(messageType),
  }
}

function selectActionableRow(rows: DiagnosedQueueRow[]): { row: DiagnosedQueueRow | null; reason: string | null } {
  const actionable = rows.filter((row) => row.classification === 'actionable')
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

function claimedMessageFromRow(row: DiagnosedQueueRow, payload: Record<string, unknown>, waiting: number): ClaimedMessage {
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
): ReconcileClass {
  const status = String(row.status ?? '')
  const agentId = String(row.agent_id ?? '')
  const source = typeof payload.source === 'string'
    ? payload.source
    : typeof row.stored_source === 'string' ? row.stored_source : ''

  if (terminalWarnings.length > 0) return 'terminal_legacy_invariant'
  if (TERMINAL_STATUSES.has(status)) return 'already_terminal'
  if (ACTIVE_STATUSES.has(status)) return 'active_claim'
  if ((agentId === 'cto' || agentId === 'codex-cto') && status === 'pending') return 'identity_split'
  if (messageType === 'projection' || source.includes('projection') || source.includes('relay')) return 'projection_only'
  if (source === 'cli-notify' || source === 'notify' || String(payload.content ?? '').includes('fallback: notify')) {
    return 'notify_fallback_result'
  }
  if (ACTIONABLE_TYPES.has(messageType)) return ageDays !== null && ageDays >= 7 ? 'actionable_stale' : 'actionable_current'
  if (NON_ACTION_TYPES.has(messageType)) return 'obsolete_notice'
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
  const klass = reconcileClassification(row, messageType, payload, terminalWarnings, ageDays)
  const proposal = proposedActionForClass(klass)
  const flags = [
    ...(terminalWarnings.length > 0 ? terminalWarnings : []),
    ...(row.message_id ? [] : ['message_row_missing']),
    ...(typeof row.payload === 'string' ? [] : ['payload_parse_error']),
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
                am.message_type AS stored_message_type,
                am.author_id AS stored_author_id
           FROM message_queue mq
           LEFT JOIN agent_messages am ON am.id::text = mq.message_id
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
        const activeClaimRow = await tx.queryOne<Record<string, unknown>>(
          `SELECT id, message_id, status, claimed_at, claim_expires_at
             FROM message_queue
            WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
            ORDER BY claimed_at DESC
            LIMIT 1`,
          [plan.env.AGENT_ID],
        )
        const pendingRows = await tx.query<Record<string, unknown>>(
          `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.priority,
                  mq.created_at, mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  am.message_type AS stored_message_type,
                  am.author_id AS stored_author_id
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
            WHERE mq.agent_id = $1 AND mq.status = 'pending'
            ORDER BY mq.priority DESC, mq.created_at ASC
            LIMIT $2`,
          [plan.env.AGENT_ID, maxInspect],
        )
        const inspected = pendingRows.map(normalizeQueueRow)
        const selected = selectActionableRow(inspected)
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
        if (selected.row && !activeClaim.busy) {
          const payload = selectedRaw ? parsePayload(selectedRaw.payload) : {}
          claimed = opts.dryRun ? null : claimedMessageFromRow(selected.row, payload, waiting)
        }

        return {
          ok: !(activeClaim.busy && !opts.dryRun),
          dry_run: !!opts.dryRun,
          mode: 'receive-actionable',
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          max_inspect: maxInspect,
          inspected_count: inspected.length,
          waiting,
          selected: selected.row,
          claimed,
          blocked_reason: activeClaim.busy ? 'active_claim' : null,
          active_claim: activeClaim,
          skipped_non_action_count: inspected.filter((row) => row.classification === 'non_action').length,
          unknown_type_count: inspected.filter((row) => row.classification === 'unknown').length,
          selection_reason: activeClaim.busy ? 'blocked_by_active_claim' : selected.reason,
        }
      })
    })
    const blockedByActiveClaim = summary.blocked_reason === 'active_claim' && !opts.dryRun

    return {
      ok: !blockedByActiveClaim,
      code: blockedByActiveClaim ? 1 : 0,
      stdout: JSON.stringify(opts.dryRun || blockedByActiveClaim ? summary : (summary.claimed ?? { waiting: summary.waiting })) + '\n',
      stderr: blockedByActiveClaim
        ? `Error [RECEIVE_ACTIONABLE_BLOCKED]: active claim exists for ${plan.env.AGENT_ID}; finish or expire queue_id=${summary.active_claim.queue_id}\n`
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
                am.source AS stored_source
           FROM message_queue mq
           LEFT JOIN agent_messages am ON am.id::text = mq.message_id
          WHERE mq.agent_id = $1
            ${cursorWhere}
          ORDER BY mq.created_at ASC, mq.id ASC
          LIMIT $${params.length}`,
        params,
      )

      const pageRows = rows.slice(0, limit).map(normalizeReconcileRow)
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
