/**
 * Stable receive wrapper for AUN operators and bot runners.
 *
 * This intentionally delegates the actual claim semantics to `agent-com next`.
 * The wrapper only stabilizes cwd/env/socket handling so sessions do not
 * hand-type fragile raw CLI invocations.
 */
import { spawnSync } from 'node:child_process'
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

const DEFAULT_DB_URLS = [
  'postgresql:///agent_comms?host=/tmp',
  'postgresql:///agent_comms?host=/private/tmp',
]

const DEFAULT_DRAIN_LIMIT = 20
const DEFAULT_MAX_INSPECT = 50
const MAX_INSPECT_CAP = 200
const ACTIONABLE_TYPES = new Set(['instruction', 'request', 'question'])
const NON_ACTION_TYPES = new Set(['chat', 'notice', 'projection'])

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
           LEFT JOIN agent_messages am ON am.id = mq.message_id
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
