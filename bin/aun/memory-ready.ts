import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate,
  recordRuntimeMemoryReadyEvidence,
} from '../../core/runtime-memory-ready'

export interface MemoryReadyBootstrapOptions {
  agentId?: string
  project?: string
  runtimeInstanceId?: string
  sessionName?: string
  port?: string
  profileRevision?: string
  profileSource?: string
  checkoutPath?: string
  checkoutCommitSha?: string
  evidencePath?: string
  evidenceLogId?: string
  recoveryCommand?: string
  validForSeconds?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
}

export interface MemoryReadyBootstrapResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function resolveAgentId(opts: MemoryReadyBootstrapOptions, env: NodeJS.ProcessEnv): string {
  const agentId = opts.agentId?.trim() || env.AGENT_ID?.trim()
  if (!agentId) throw new Error('agent id required: pass --agent-id <id> or set AGENT_ID')
  const expected = env.AGENT_COM_EXPECTED_AGENT_ID?.trim()
  if (expected && expected !== agentId) {
    throw new Error(`AGENT_ID_MISMATCH: resolved agent_id=${agentId}, expected ${expected}`)
  }
  return agentId
}

function numberFlag(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
  return n
}

function optionalInteger(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

function dbKind(env: Record<string, string>): 'postgres' | 'sqlite' {
  const explicit = env.AGENT_COM_DB?.trim()
  if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres'
  if (explicit === 'sqlite') return 'sqlite'
  return env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite'
}

async function withDb<T>(env: Record<string, string>, fn: (db: DbAdapter) => Promise<T>): Promise<T> {
  if (dbKind(env) === 'sqlite') {
    const db = new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
    try {
      return await fn(db)
    } finally {
      await db.close()
    }
  }

  const { PgAdapter } = await import('../../core/db/pg-adapter')
  const db = new PgAdapter(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp')
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

export async function memoryReadyBootstrap(opts: MemoryReadyBootstrapOptions = {}): Promise<MemoryReadyBootstrapResult> {
  const env = cleanEnv(opts.env ?? process.env)
  try {
    const agentId = resolveAgentId(opts, env)
    const runtimeInstanceId = opts.runtimeInstanceId?.trim()
    const sessionName = opts.sessionName?.trim()
    if (!runtimeInstanceId) throw new Error('--runtime-instance-id is required')
    if (!sessionName) throw new Error('--session-name is required')
    const port = numberFlag(opts.port, '--port')
    const project = opts.project?.trim() || env.AGENT_COMMS_MEMORY_READY_PROJECT?.trim() || env.AGENT_MEMORY_PROJECT?.trim() || 'agent-comms-mcp'
    const validForSeconds = optionalInteger(opts.validForSeconds, '--valid-for-seconds') ?? 1800
    const profileRevision = optionalInteger(opts.profileRevision, '--profile-revision')
    const evidence = buildWasurezuBootstrapEvidence({
      agent_id: agentId,
      project,
      runtime_instance_id: runtimeInstanceId,
      profile_revision: profileRevision,
      profile_source: opts.profileSource?.trim() || null,
      session_name: sessionName,
      port,
      checkout_path: opts.checkoutPath?.trim() || null,
      checkout_commit_sha: opts.checkoutCommitSha?.trim() || null,
      valid_for_seconds: validForSeconds,
      evidence_path: opts.evidencePath?.trim() || null,
      evidence_log_id: opts.evidenceLogId?.trim() || null,
      recovery_command: opts.recoveryCommand?.trim() || null,
    })

    if (opts.dryRun) {
      return {
        ok: true,
        code: 0,
        stdout: `${JSON.stringify({
          ok: true,
          dry_run: true,
          mode: 'memory-ready-bootstrap',
          mutation_performed: false,
          live_discord_send: false,
          launchagent_mutation: false,
          queue_dependency: false,
          evidence,
        }, null, 2)}\n`,
        stderr: '',
      }
    }

    const result = await withDb(env, async (db) => {
      const recorded = await recordRuntimeMemoryReadyEvidence(db as any, evidence)
      const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
        agent_id: agentId,
        expected_agent_id: agentId,
        project,
      })
      return { recorded, gate }
    })
    return {
      ok: result.gate.ok,
      code: result.gate.ok ? 0 : 1,
      stdout: `${JSON.stringify({
        ok: result.gate.ok,
        dry_run: false,
        mode: 'memory-ready-bootstrap',
        mutation_performed: true,
        live_discord_send: false,
        launchagent_mutation: false,
        queue_dependency: false,
        evidence_id: result.recorded.evidence_id,
        evidence_log_id: result.recorded.evidence_log_id,
        memory_ready: result.gate,
      }, null, 2)}\n`,
      stderr: result.gate.ok ? '' : `Error [MEMORY_READY_BOOTSTRAP_FAILED]: memory_ready gate failed after record; reason=${result.gate.reason}\n`,
    }
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [MEMORY_READY_BOOTSTRAP_FAILED]: ${(err as Error).message}\n`,
    }
  }
}
