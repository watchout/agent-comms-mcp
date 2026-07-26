import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type {
  BootstrapRunState,
  BootstrapSafeD1Readback,
  BootstrapTerminalStatus,
} from '../bin/aun/bootstrap-types'

const SECRET_KEY = /(token|secret|password|credential|authorization|cookie)/i

export const BOOTSTRAP_SAFE_D1_DEFAULTS: BootstrapSafeD1Readback = Object.freeze({
  SHIRUBE_D1_ENABLED: '0',
  SHIRUBE_D1_KILL_SWITCH: '1',
  SHIRUBE_D1_TARGET_ALLOWLIST: '[]',
  STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
})

export function validateBootstrapAgentId(agentId: string): string {
  const normalized = agentId.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error('agent_id must be 1-128 characters using letters, numbers, dot, underscore, or dash')
  }
  return normalized
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function bootstrapDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function redactBootstrapValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value.replace(/\b(token|secret|password|credential|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item) => redactBootstrapValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, redactBootstrapValue(childValue, childKey)]),
    )
  }
  return value
}

export function bootstrapStateRoot(home?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AUN_HOME?.trim()
  const aunHome = configured
    ? resolve(configured.replace(/^~(?=\/|$)/, home ?? env.HOME ?? homedir()))
    : join(home ?? env.HOME ?? homedir(), '.aun')
  return join(aunHome, 'bootstrap')
}

export interface BootstrapStateStore {
  acquireLock(agentId: string, runId: string): void
  releaseLock(agentId: string, runId: string): void
  load(agentId: string, runId: string): BootstrapRunState | null
  save(state: BootstrapRunState): void
  findLatestReady(agentId: string, inputDigest: string): BootstrapRunState | null
}

export class FileBootstrapStateStore implements BootstrapStateStore {
  constructor(readonly root: string) {}

  private agentDir(agentId: string): string {
    return join(this.root, validateBootstrapAgentId(agentId))
  }

  private runPath(agentId: string, runId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(runId)) throw new Error('invalid bootstrap run_id')
    return join(this.agentDir(agentId), `${runId}.json`)
  }

  acquireLock(agentId: string, runId: string): void {
    const dir = this.agentDir(agentId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, '.lock')
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeFileSync(fd, `${runId}\n`, { encoding: 'utf8' })
      closeSync(fd)
    } catch (err) {
      const owner = existsSync(path) ? readFileSync(path, 'utf8').trim() : 'unknown'
      throw new Error(`NO_GO_BOOTSTRAP_BUSY: agent ${agentId} is locked by run ${owner}: ${(err as Error).message}`)
    }
  }

  releaseLock(agentId: string, runId: string): void {
    const path = join(this.agentDir(agentId), '.lock')
    if (!existsSync(path)) return
    const owner = readFileSync(path, 'utf8').trim()
    if (owner !== runId) throw new Error(`refusing to release bootstrap lock owned by ${owner}`)
    rmSync(path)
  }

  load(agentId: string, runId: string): BootstrapRunState | null {
    const path = this.runPath(agentId, runId)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as BootstrapRunState
  }

  save(state: BootstrapRunState): void {
    state.mutation_manifest_digest = bootstrapDigest(state.mutations)
    const path = this.runPath(state.agent_id, state.run_id)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    const redacted = redactBootstrapValue(state) as BootstrapRunState
    writeFileSync(temp, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, path)
    chmodSync(path, 0o600)
  }

  findLatestReady(agentId: string, inputDigest: string): BootstrapRunState | null {
    const dir = this.agentDir(agentId)
    if (!existsSync(dir)) return null
    const candidates = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const candidate of candidates) {
      const state = this.load(agentId, candidate.name.slice(0, -5))
      if (state?.input_digest === inputDigest && state.terminal_status === 'READY') return state
      if (state?.input_digest === inputDigest && state.terminal_status === 'IDEMPOTENT_READY') return state
    }
    return null
  }
}

export class MemoryBootstrapStateStore implements BootstrapStateStore {
  readonly states = new Map<string, BootstrapRunState>()
  readonly locks = new Map<string, string>()

  acquireLock(agentId: string, runId: string): void {
    const owner = this.locks.get(agentId)
    if (owner) throw new Error(`NO_GO_BOOTSTRAP_BUSY: agent ${agentId} is locked by run ${owner}`)
    this.locks.set(agentId, runId)
  }

  releaseLock(agentId: string, runId: string): void {
    if (this.locks.get(agentId) === runId) this.locks.delete(agentId)
  }

  load(agentId: string, runId: string): BootstrapRunState | null {
    const value = this.states.get(`${agentId}/${runId}`)
    return value ? structuredClone(value) : null
  }

  save(state: BootstrapRunState): void {
    state.mutation_manifest_digest = bootstrapDigest(state.mutations)
    this.states.set(`${state.agent_id}/${state.run_id}`, structuredClone(redactBootstrapValue(state) as BootstrapRunState))
  }

  findLatestReady(agentId: string, inputDigest: string): BootstrapRunState | null {
    return [...this.states.values()].reverse().find((state) =>
      state.agent_id === agentId
      && state.input_digest === inputDigest
      && (state.terminal_status === 'READY' || state.terminal_status === 'IDEMPOTENT_READY')) ?? null
  }
}

export function terminalStatusIsReady(status: BootstrapTerminalStatus | null): boolean {
  return status === 'READY' || status === 'IDEMPOTENT_READY'
}
