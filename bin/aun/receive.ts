/**
 * Stable receive wrapper for AUN operators and bot runners.
 *
 * This intentionally delegates the actual claim semantics to `agent-com next`.
 * The wrapper only stabilizes cwd/env/socket handling so sessions do not
 * hand-type fragile raw CLI invocations.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export interface ReceiveOptions {
  agentId?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
  dryRun?: boolean
}

export interface DrainOptions extends ReceiveOptions {
  limit?: number
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

const DEFAULT_DB_URLS = [
  'postgresql:///agent_comms?host=/tmp',
  'postgresql:///agent_comms?host=/private/tmp',
]

const DEFAULT_DRAIN_LIMIT = 20

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
