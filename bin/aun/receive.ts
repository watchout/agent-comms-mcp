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

export interface ReceivePlan {
  repoRoot: string
  argv: string[]
  env: Record<string, string>
  databaseUrlCandidates: string[]
}

export type CommandPlan = ReceivePlan

export interface ReceiveResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  plan: ReceivePlan
}

const DEFAULT_DB_URLS = [
  'postgresql:///agent_comms?host=/tmp',
  'postgresql:///agent_comms?host=/private/tmp',
]

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
