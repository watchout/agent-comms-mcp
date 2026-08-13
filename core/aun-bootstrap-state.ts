import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
  acquireLock(agentId: string, runId: string, options?: { reclaimStaleSameRun?: boolean }): void
  releaseLock(agentId: string, runId: string, recordReleased?: (releasedAt: string, ownerNonce: string) => void): void
  load(agentId: string, runId: string): BootstrapRunState | null
  save(state: BootstrapRunState): void
  findLatestReady(agentId: string, inputDigest: string): BootstrapRunState | null
}

type BootstrapLockRecord = {
  schema_version: 'aun-bootstrap-lock/v1'
  agent_id: string
  run_id: string
  pid: number
  process_start_identity: string
  created_at: string
  nonce: string
}
type ProcessIdentityState =
  | { status: 'alive'; identity: string }
  | { status: 'dead' }
  | { status: 'unknown' }

const LOCK_RECORD_FILE = 'owner.json'
const LOCK_RECLAIM_PREFIX = '.lock.reclaim-'
const LOCK_RELEASE_PREFIX = '.lock.release-'
const LOCK_COMPLETED_RELEASE_PREFIX = '.lock.completed-release-'
const LOCK_STAGE_PREFIX = '.lock.stage-'
const LOCK_COMPLETED_STAGE_PREFIX = '.lock.completed-stage-'
const LOCK_RECLAIM_COMPLETE_FILE = 'reclaim.complete'
const CANONICAL_LOCK_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type BootstrapLockTestHooks = {
  beforeReclaimRename?: () => void
  afterCompletedReleaseRename?: () => void
  completedReleaseObserverDurability?: (event:
    | 'after-archive-fsync'
    | 'after-agent-fsync'
    | 'after-strict-reread', path: string) => void
  afterStageMkdir?: () => void
  afterStagePartialOwnerWrite?: () => void
  afterStageOwnerFsync?: () => void
  afterStageFsync?: () => void
  reclaimDurability?: (event:
    | 'after-marker-mkdir'
    | 'before-marker-fsync'
    | 'after-marker-fsync'
    | 'before-tomb-fsync'
    | 'after-tomb-fsync'
    | 'after-strict-reread', path: string) => void
}

function fsyncBootstrapDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function writeBootstrapBytes(fd: number, body: Uint8Array, offset: number, length: number): void {
  let written = 0
  while (written < length) {
    const count = writeSync(fd, body, offset + written, length - written)
    if (count <= 0) throw new Error('bootstrap lock owner write made no progress')
    written += count
  }
}

function ensureDurableBootstrapDirectory(path: string): void {
  const parent = dirname(path)
  if (existsSync(path)) {
    const identity = lstatSync(path)
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('bootstrap directory identity invalid')
    fsyncBootstrapDirectory(path)
    if (parent !== path) fsyncBootstrapDirectory(parent)
    return
  }
  if (parent === path) throw new Error('bootstrap directory has no existing ancestor')
  ensureDurableBootstrapDirectory(parent)
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const identity = lstatSync(path)
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error('bootstrap directory identity invalid')
  fsyncBootstrapDirectory(path)
  if (parent !== path) fsyncBootstrapDirectory(parent)
}

function processIdentityState(pid: number): ProcessIdentityState {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { status: 'unknown' }
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
      ? { status: 'dead' }
      : { status: 'unknown' }
  }
  const ps = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
  })
  const started = ps.status === 0 ? String(ps.stdout ?? '').trim().replace(/\s+/g, ' ') : ''
  return started
    ? { status: 'alive', identity: bootstrapDigest({ pid, started }) }
    : { status: 'unknown' }
}

function validateBootstrapLockRecord(value: unknown, agentId: string): BootstrapLockRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.schema_version !== 'aun-bootstrap-lock/v1'
    || Object.keys(row).sort().join(',') !== 'agent_id,created_at,nonce,pid,process_start_identity,run_id,schema_version'
    || row.agent_id !== agentId
    || typeof row.run_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(row.run_id)
    || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 1
    || typeof row.process_start_identity !== 'string' || !/^[0-9a-f]{64}$/.test(row.process_start_identity)
    || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
    || new Date(row.created_at).toISOString() !== row.created_at
    || typeof row.nonce !== 'string'
    || !CANONICAL_LOCK_NONCE.test(row.nonce)) return null
  return row as BootstrapLockRecord
}

function readBootstrapLockRecord(path: string, agentId: string): BootstrapLockRecord | null {
  try {
    const identity = lstatSync(path)
    if (!identity.isDirectory() || identity.isSymbolicLink()) return null
    const ownerPath = join(path, LOCK_RECORD_FILE)
    const ownerIdentity = lstatSync(ownerPath)
    if (!ownerIdentity.isFile() || ownerIdentity.isSymbolicLink() || ownerIdentity.nlink !== 1) return null
    const names = readdirSync(path).sort()
    const record = validateBootstrapLockRecord(JSON.parse(readFileSync(ownerPath, 'utf8')), agentId)
    if (!record) return null
    const base = basename(path)
    const layout = names.join(',')
    const ownerOnly = layout === LOCK_RECORD_FILE
    const reclaimComplete = layout === [LOCK_RECORD_FILE, LOCK_RECLAIM_COMPLETE_FILE].sort().join(',')
      && validEmptyDirectory(join(path, LOCK_RECLAIM_COMPLETE_FILE))
    if (base === '.lock' || base.startsWith(LOCK_RELEASE_PREFIX)
      || base.startsWith(LOCK_COMPLETED_RELEASE_PREFIX)) return ownerOnly ? record : null
    if (base === `${LOCK_RECLAIM_PREFIX}${record.nonce}`) return ownerOnly || reclaimComplete ? record : null
    return null
  } catch {
    return null
  }
}

function sameLockRecord(left: BootstrapLockRecord, right: BootstrapLockRecord): boolean {
  return bootstrapDigest(left) === bootstrapDigest(right)
}

function validEmptyDirectory(path: string): boolean {
  try {
    const identity = lstatSync(path)
    return identity.isDirectory() && !identity.isSymbolicLink() && readdirSync(path).length === 0
  } catch {
    return false
  }
}

function validCompletedReclaim(path: string, owner: BootstrapLockRecord): boolean {
  return basename(path) === `${LOCK_RECLAIM_PREFIX}${owner.nonce}`
    && validEmptyDirectory(join(path, LOCK_RECLAIM_COMPLETE_FILE))
}

function archiveCompletedRelease(
  dir: string,
  releasePath: string,
  owner: BootstrapLockRecord,
  afterRename?: () => void,
): void {
  const archived = join(dir, `${LOCK_COMPLETED_RELEASE_PREFIX}${owner.nonce}`)
  if (existsSync(archived)) throw new Error('completed release archive target exists')
  renameSync(releasePath, archived)
  afterRename?.()
  fsyncBootstrapDirectory(dir)
}

export class FileBootstrapStateStore implements BootstrapStateStore {
  private readonly acquiredLocks = new Map<string, BootstrapLockRecord>()

  constructor(
    readonly root: string,
    private readonly testHooks: BootstrapLockTestHooks = {},
  ) {}

  private agentDir(agentId: string): string {
    return join(this.root, validateBootstrapAgentId(agentId))
  }

  private runPath(agentId: string, runId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(runId)) throw new Error('invalid bootstrap run_id')
    return join(this.agentDir(agentId), `${runId}.json`)
  }

  private lockPath(agentId: string): string {
    return join(this.agentDir(agentId), '.lock')
  }

  private writeStagedLock(dir: string, record: BootstrapLockRecord): string {
    const staged = join(dir, `${LOCK_STAGE_PREFIX}${record.nonce}`)
    mkdirSync(staged, { mode: 0o700 })
    this.testHooks.afterStageMkdir?.()
    const ownerPath = join(staged, LOCK_RECORD_FILE)
    const fd = openSync(ownerPath, 'wx', 0o600)
    try {
      const body = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
      const split = Math.max(1, Math.floor(body.length / 2))
      writeBootstrapBytes(fd, body, 0, split)
      this.testHooks.afterStagePartialOwnerWrite?.()
      writeBootstrapBytes(fd, body, split, body.length - split)
      fsyncSync(fd)
      this.testHooks.afterStageOwnerFsync?.()
    } finally {
      closeSync(fd)
    }
    chmodSync(ownerPath, 0o600)
    fsyncBootstrapDirectory(staged)
    this.testHooks.afterStageFsync?.()
    return staged
  }

  private quarantineStagedLock(dir: string, stagedPath: string, name: string): void {
    const nonce = name.slice(LOCK_STAGE_PREFIX.length)
    if (!CANONICAL_LOCK_NONCE.test(nonce)) throw new Error('staged lock artifact name is not canonical')
    const identity = lstatSync(stagedPath)
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error('staged lock artifact identity is invalid')
    }
    const archived = join(dir, `${LOCK_COMPLETED_STAGE_PREFIX}${nonce}`)
    if (existsSync(archived)) throw new Error('completed stage archive target exists')

    // A stage is never authoritative until its directory rename to `.lock`. Its
    // contents may therefore be empty or only partly written after a crash. Make
    // that inert residue durable before and after moving it to permanent quarantine.
    fsyncBootstrapDirectory(stagedPath)
    fsyncBootstrapDirectory(dir)
    renameSync(stagedPath, archived)
    fsyncBootstrapDirectory(dir)
    const archivedIdentity = lstatSync(archived)
    if (!archivedIdentity.isDirectory() || archivedIdentity.isSymbolicLink()
      || basename(archived) !== `${LOCK_COMPLETED_STAGE_PREFIX}${nonce}`) {
      throw new Error('completed stage quarantine readback mismatch')
    }
    fsyncBootstrapDirectory(archived)
    fsyncBootstrapDirectory(dir)
  }

  private validCompletedStageQuarantine(path: string, name: string): boolean {
    const nonce = name.slice(LOCK_COMPLETED_STAGE_PREFIX.length)
    if (!CANONICAL_LOCK_NONCE.test(nonce)) return false
    try {
      const identity = lstatSync(path)
      return identity.isDirectory() && !identity.isSymbolicLink()
        && basename(path) === `${LOCK_COMPLETED_STAGE_PREFIX}${nonce}`
    } catch {
      return false
    }
  }

  private completeAndVerifyReclaim(path: string, owner: BootstrapLockRecord): void {
    const marker = join(path, LOCK_RECLAIM_COMPLETE_FILE)
    if (!existsSync(marker)) {
      mkdirSync(marker, { mode: 0o700 })
      this.testHooks.reclaimDurability?.('after-marker-mkdir', path)
    }
    if (!validEmptyDirectory(marker)) throw new Error('lock transition completion marker is corrupt')
    this.testHooks.reclaimDurability?.('before-marker-fsync', path)
    fsyncBootstrapDirectory(marker)
    this.testHooks.reclaimDurability?.('after-marker-fsync', path)
    this.testHooks.reclaimDurability?.('before-tomb-fsync', path)
    fsyncBootstrapDirectory(path)
    this.testHooks.reclaimDurability?.('after-tomb-fsync', path)
    const reread = readBootstrapLockRecord(path, owner.agent_id)
    if (!reread || !sameLockRecord(reread, owner) || !validCompletedReclaim(path, reread)) {
      throw new Error('reclaim generation completion readback mismatch')
    }
    this.testHooks.reclaimDurability?.('after-strict-reread', path)
  }

  private closeObservedCompletedRelease(
    dir: string,
    path: string,
    name: string,
    owner: BootstrapLockRecord,
  ): void {
    if (name !== `${LOCK_COMPLETED_RELEASE_PREFIX}${owner.nonce}`) {
      throw new Error('completed release archive is corrupt')
    }
    fsyncBootstrapDirectory(path)
    this.testHooks.completedReleaseObserverDurability?.('after-archive-fsync', path)
    fsyncBootstrapDirectory(dir)
    this.testHooks.completedReleaseObserverDurability?.('after-agent-fsync', path)
    const reread = readBootstrapLockRecord(path, owner.agent_id)
    if (!reread || basename(path) !== name || !sameLockRecord(reread, owner)) {
      throw new Error('completed release archive durability readback mismatch')
    }
    this.testHooks.completedReleaseObserverDurability?.('after-strict-reread', path)
  }

  private exactSameRunStale(record: BootstrapLockRecord, agentId: string, runId: string): boolean {
    if (record.agent_id !== agentId || record.run_id !== runId) return false
    const observed = processIdentityState(record.pid)
    return observed.status === 'dead'
      || (observed.status === 'alive' && observed.identity !== record.process_start_identity)
  }

  acquireLock(agentId: string, runId: string, options: { reclaimStaleSameRun?: boolean } = {}): void {
    const dir = this.agentDir(agentId)
    ensureDurableBootstrapDirectory(this.root)
    ensureDurableBootstrapDirectory(dir)
    const path = this.lockPath(agentId)
    const currentIdentity = processIdentityState(process.pid)
    if (currentIdentity.status !== 'alive') {
      throw new Error('NO_GO_BOOTSTRAP_BUSY: current process start identity is unavailable')
    }
    const record: BootstrapLockRecord = {
      schema_version: 'aun-bootstrap-lock/v1',
      agent_id: agentId,
      run_id: runId,
      pid: process.pid,
      process_start_identity: currentIdentity.identity,
      created_at: new Date().toISOString(),
      nonce: randomUUID(),
    }
    let staged: string | null = null
    try {
      for (const name of readdirSync(dir).filter((entry) => entry.startsWith('.lock.')).sort()) {
        const candidatePath = join(dir, name)
        if (name.startsWith(LOCK_RECLAIM_PREFIX) || name.startsWith(LOCK_RELEASE_PREFIX)) continue
        if (name.startsWith(LOCK_COMPLETED_RELEASE_PREFIX)) {
          const archived = readBootstrapLockRecord(candidatePath, agentId)
          if (!archived || name !== `${LOCK_COMPLETED_RELEASE_PREFIX}${archived.nonce}`) {
            throw new Error('completed release archive is corrupt')
          }
          this.closeObservedCompletedRelease(dir, candidatePath, name, archived)
          continue
        }
        if (name.startsWith(LOCK_COMPLETED_STAGE_PREFIX)) {
          if (!this.validCompletedStageQuarantine(candidatePath, name)) {
            throw new Error('completed stage archive is corrupt')
          }
          continue
        }
        if (name.startsWith(LOCK_STAGE_PREFIX)) {
          this.quarantineStagedLock(dir, candidatePath, name)
          continue
        }
        throw new Error('unknown reserved lock artifact')
      }
      const reclaimNames = readdirSync(dir).filter((name) => name.startsWith(LOCK_RECLAIM_PREFIX)).sort()
      const releaseNames = readdirSync(dir).filter((name) => name.startsWith(LOCK_RELEASE_PREFIX)).sort()
      for (const name of releaseNames) {
        const releasePath = join(dir, name)
        const released = readBootstrapLockRecord(releasePath, agentId)
        const releaseState = options.reclaimStaleSameRun ? this.load(agentId, runId) : null
        if (!options.reclaimStaleSameRun || !released
          || name !== `${LOCK_RELEASE_PREFIX}${released.nonce}`
          || !this.exactSameRunStale(released, agentId, runId)
          || !releaseState || releaseState.agent_id !== agentId || releaseState.run_id !== runId
          || !releaseState.lock_release_authorized_at
          || !Number.isFinite(Date.parse(releaseState.lock_release_authorized_at))
          || new Date(releaseState.lock_release_authorized_at).toISOString() !== releaseState.lock_release_authorized_at) {
          throw new Error('release marker is live, foreign, corrupt, or unauthorized')
        }
        const authorizedAt = Date.parse(releaseState.lock_release_authorized_at)
        if (!releaseState.lock_released_at) {
          if (releaseState.lock_release_owner_nonce != null
            && releaseState.lock_release_owner_nonce !== released.nonce) {
            throw new Error('release marker journal owner receipt is corrupt')
          }
          releaseState.lock_released_at = new Date().toISOString()
          releaseState.lock_release_owner_nonce = released.nonce
          releaseState.updated_at = releaseState.lock_released_at
          this.save(releaseState)
        } else if (!Number.isFinite(Date.parse(releaseState.lock_released_at))
          || new Date(releaseState.lock_released_at).toISOString() !== releaseState.lock_released_at) {
          throw new Error('release marker journal receipt is corrupt')
        }
        const releasedAt = Date.parse(releaseState.lock_released_at)
        if (releasedAt < authorizedAt) throw new Error('release marker journal receipt precedes authorization')

        const legacyNonceMissing = !Object.prototype.hasOwnProperty.call(releaseState, 'lock_release_owner_nonce')
        if (legacyNonceMissing) {
          const beforeBind = readBootstrapLockRecord(releasePath, agentId)
          if (!beforeBind || !sameLockRecord(beforeBind, released)) {
            throw new Error('release marker changed before legacy receipt binding')
          }
          releaseState.lock_release_owner_nonce = released.nonce
          this.save(releaseState)
          const persisted = this.load(agentId, runId)
          if (!persisted || persisted.agent_id !== agentId || persisted.run_id !== runId
            || persisted.lock_release_authorized_at !== releaseState.lock_release_authorized_at
            || persisted.lock_released_at !== releaseState.lock_released_at
            || persisted.lock_release_owner_nonce !== released.nonce) {
            throw new Error('legacy release marker journal receipt binding readback mismatch')
          }
        } else if (releaseState.lock_release_owner_nonce !== released.nonce) {
          throw new Error('release marker journal owner receipt is corrupt')
        }
        const reread = readBootstrapLockRecord(releasePath, agentId)
        if (!reread || !sameLockRecord(reread, released)) {
          throw new Error('release marker changed before recovery cleanup')
        }
        archiveCompletedRelease(dir, releasePath, released, this.testHooks.afterCompletedReleaseRename)
      }
      const recoverableReclaims: string[] = []
      for (const name of reclaimNames) {
        const reclaimPath = join(dir, name)
        const reclaimed = readBootstrapLockRecord(reclaimPath, agentId)
        if (reclaimed && name === `${LOCK_RECLAIM_PREFIX}${reclaimed.nonce}`
          && validCompletedReclaim(reclaimPath, reclaimed)) {
          continue
        }
        if (!options.reclaimStaleSameRun || !reclaimed
          || name !== `${LOCK_RECLAIM_PREFIX}${reclaimed.nonce}`
          || !this.exactSameRunStale(reclaimed, agentId, runId)) {
          throw new Error('reclaim marker is live, foreign, or corrupt')
        }
        recoverableReclaims.push(reclaimPath)
      }

      if (existsSync(path)) {
        const owner = readBootstrapLockRecord(path, agentId)
        if (!options.reclaimStaleSameRun || !owner || !this.exactSameRunStale(owner, agentId, runId)) {
          throw new Error(`agent lock is ${owner ? `owned by run ${owner.run_id}` : 'corrupt'}`)
        }
        const reclaimedPath = join(dir, `${LOCK_RECLAIM_PREFIX}${owner.nonce}`)
        this.testHooks.beforeReclaimRename?.()
        renameSync(path, reclaimedPath)
        fsyncBootstrapDirectory(dir)
        recoverableReclaims.push(reclaimedPath)
      }

      staged = this.writeStagedLock(dir, record)
      renameSync(staged, path)
      staged = null
      fsyncBootstrapDirectory(dir)
      const installed = readBootstrapLockRecord(path, agentId)
      if (!installed || !sameLockRecord(installed, record)) {
        throw new Error('installed lock readback mismatch')
      }
      this.acquiredLocks.set(agentId, record)
    } catch (err) {
      if (staged && existsSync(staged)) {
        try { this.quarantineStagedLock(dir, staged, basename(staged)) } catch { /* preserve residue for recovery */ }
      }
      throw new Error(`NO_GO_BOOTSTRAP_BUSY: agent ${agentId} lock unavailable: ${(err as Error).message}`)
    }
  }

  releaseLock(agentId: string, runId: string, recordReleased?: (releasedAt: string, ownerNonce: string) => void): void {
    const dir = this.agentDir(agentId)
    const path = this.lockPath(agentId)
    if (!existsSync(path)) {
      if (this.acquiredLocks.has(agentId)) throw new Error('bootstrap lock disappeared before exact release')
      return
    }
    const owner = readBootstrapLockRecord(path, agentId)
    const acquired = this.acquiredLocks.get(agentId)
    if (!owner || !acquired || owner.run_id !== runId || !sameLockRecord(owner, acquired)) {
      throw new Error('refusing to release bootstrap lock without exact process ownership')
    }
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith(LOCK_RECLAIM_PREFIX)).sort()) {
      const reclaimPath = join(dir, name)
      const reclaimed = readBootstrapLockRecord(reclaimPath, agentId)
      if (!reclaimed || name !== `${LOCK_RECLAIM_PREFIX}${reclaimed.nonce}`) {
        throw new Error('refusing release with corrupt reclaim generation')
      }
      if (!validCompletedReclaim(reclaimPath, reclaimed)) {
        if (!this.exactSameRunStale(reclaimed, agentId, runId)) {
          throw new Error('refusing release with foreign pending reclaim generation')
        }
      }
      // Visibility of an existing marker is not a durability receipt. Re-fsync
      // every exact generation marker and its parent tomb before releasing `.lock`.
      this.completeAndVerifyReclaim(reclaimPath, reclaimed)
    }
    const releasePath = join(dir, `${LOCK_RELEASE_PREFIX}${owner.nonce}`)
    if (existsSync(releasePath)) throw new Error('refusing to replace an existing bootstrap lock release record')
    renameSync(path, releasePath)
    fsyncBootstrapDirectory(dir)
    const releasedAt = new Date().toISOString()
    recordReleased?.(releasedAt, owner.nonce)
    const released = readBootstrapLockRecord(releasePath, agentId)
    if (!released || !sameLockRecord(released, owner)) {
      throw new Error('bootstrap release marker changed before exact cleanup')
    }
    archiveCompletedRelease(dir, releasePath, owner, this.testHooks.afterCompletedReleaseRename)
    this.acquiredLocks.delete(agentId)
  }

  load(agentId: string, runId: string): BootstrapRunState | null {
    const path = this.runPath(agentId, runId)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as BootstrapRunState
  }

  save(state: BootstrapRunState): void {
    state.mutation_manifest_digest = bootstrapDigest(state.mutations)
    const path = this.runPath(state.agent_id, state.run_id)
    ensureDurableBootstrapDirectory(dirname(path))
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
    const redacted = redactBootstrapValue(state) as BootstrapRunState
    let fd: number | null = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify(redacted, null, 2)}\n`, { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      chmodSync(temp, 0o600)
      renameSync(temp, path)
      chmodSync(path, 0o600)
      fsyncBootstrapDirectory(dirname(path))
    } finally {
      if (fd !== null) closeSync(fd)
      if (existsSync(temp)) rmSync(temp, { force: true })
    }
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
  readonly lockNonces = new Map<string, string>()

  acquireLock(agentId: string, runId: string, _options: { reclaimStaleSameRun?: boolean } = {}): void {
    const owner = this.locks.get(agentId)
    if (owner) throw new Error(`NO_GO_BOOTSTRAP_BUSY: agent ${agentId} is locked by run ${owner}`)
    this.locks.set(agentId, runId)
    this.lockNonces.set(agentId, randomUUID())
  }

  releaseLock(agentId: string, runId: string, recordReleased?: (releasedAt: string, ownerNonce: string) => void): void {
    if (this.locks.get(agentId) === runId) {
      const nonce = this.lockNonces.get(agentId)
      if (!nonce) throw new Error('bootstrap in-memory lock owner nonce disappeared')
      this.locks.delete(agentId)
      this.lockNonces.delete(agentId)
      recordReleased?.(new Date().toISOString(), nonce)
    }
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
