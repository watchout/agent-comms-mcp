import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import { PgAdapter } from '../../core/db/pg-adapter'
import type {
  BootstrapCommandResult,
  BootstrapMutation,
  BootstrapRuntimeAdapter,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from './bootstrap-types'

export type BootstrapAdapterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<BootstrapCommandResult>

export type BootstrapAdapterDependencies = {
  run: BootstrapAdapterCommandRunner
  bunPath: string
  serverEntry: string
  /** Deterministic fault-injection seam immediately before the no-clobber provider commit. */
  beforeProviderArtifactNoClobberCommit?: (configPath: string) => void
  /** Deterministic fault-injection seam after owned-tuple readback and before conditional removal. */
  beforeOwnedTupleConditionalRemove?: (configPath: string) => void
  /** Deterministic hard-crash seam after the live owned artifact is durably displaced. */
  afterOwnedTupleArtifactDisplaced?: (configPath: string) => void
  /** Deterministic hard-crash seam after private native removal is durably verified. */
  afterOwnedTuplePrivateRemove?: (configPath: string) => void
  /** Deterministic hard-crash seam after the no-clobber live commit and before residue cleanup. */
  afterOwnedTupleLiveCommit?: (configPath: string) => void
}

export type BootstrapMcpTuple = {
  name: 'aun'
  enabled: true
  transport: 'stdio'
  command: string
  argv: string[]
  environment: Record<string, string>
  scope: 'user'
}

type ProviderArtifactIdentity = {
  path_digest: string
  realpath_digest: string
  device: number
  inode: number
  uid: number
  gid: number
  mode: number
  byte_length: number
  byte_sha256: string
  link_count: number
}

type LegacyRollbackArtifact = {
  schema_version: 'aun-bootstrap-codex-rollback/v1'
  run_id: string
  config_path: string
  config_bytes_base64: string
  legacy_tuple: unknown
  legacy_tuple_digest: string
  prestate: ProviderArtifactIdentity
}

type ConditionalRemoveJournal = {
  schema_version: 'aun-bootstrap-codex-conditional-remove/v1'
  run_id: string
  provider_root_digest: string
  provider_root_identity: ReturnType<typeof directoryIdentity>
  admitted_authority_digest: string | null
  expected_current: ProviderArtifactIdentity | null
  transaction_root_identity: ReturnType<typeof directoryIdentity>
  transaction_config_initial: ProviderArtifactIdentity
  sentinel_initial: ProviderArtifactIdentity | null
}

const LEGACY_BUN = '/Users/yuji/.bun/bin/bun'
const LEGACY_SERVER = '/Users/yuji/.agent-comms/state-daemon/current/server.ts'

function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function providerRoot(context: BootstrapStageContext): string | null {
  const root = context.providerRootAuthority?.canonicalRoot ?? context.env.CODEX_HOME
  return typeof root === 'string' && root.length > 0 ? root : null
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function providerAuthorityTupleDigest(agentId: string, row: Record<string, unknown>): string {
  const metadata = objectRecord(row.metadata)
  const projection = objectRecord(row.ordinary_projection)
  return bootstrapDigest({
    agent_id: String(row.agent_id ?? agentId),
    repo_url: typeof row.repo_url === 'string' ? row.repo_url : null,
    workspace_path: typeof row.workspace_path === 'string'
      ? row.workspace_path
      : typeof row.canonical_workspace === 'string'
        ? row.canonical_workspace
        : typeof row.home_directory === 'string'
          ? row.home_directory
          : null,
    config_profile: {
      runtime_engine_preference: String(row.runtime_engine_preference ?? '').toLowerCase() || null,
      metadata_codex_home: typeof metadata.codex_home === 'string' ? metadata.codex_home : null,
    },
    provider_binding: {
      expected_provider_identity_ref: typeof row.expected_provider_identity_ref === 'string'
        ? row.expected_provider_identity_ref
        : null,
      provider_token_source_ref: typeof row.provider_token_source_ref === 'string'
        ? row.provider_token_source_ref
        : null,
      projection_provider_config_root: typeof projection.provider_config_root === 'string'
        ? projection.provider_config_root
        : null,
    },
    projection_digest: bootstrapDigest(projection),
  })
}

async function liveProviderAuthorityDigest(context: BootstrapStageContext): Promise<string | null> {
  const recorded = context.providerRootAuthority?.authorityTupleDigest ?? null
  const runtimeState = context.priorState?.schema_version === 'shirube-v3/aun-bootstrap-run/v1'
  const explicit = context.env.AGENT_COM_DB?.trim().toLowerCase()
  const databaseUrl = context.env.DATABASE_URL?.trim()
  const postgres = explicit === 'postgres'
    || explicit === 'postgresql'
    || (!explicit && Boolean(databaseUrl))
  if (!runtimeState) return recorded
  if (!postgres) return explicit === 'sqlite' ? recorded : null
  if (!databaseUrl) return null
  const db = new PgAdapter(databaseUrl)
  try {
    const result = await db.queryOne<{ row: Record<string, unknown>; repo_url: string | null; workspace_path: string | null }>(
      `SELECT to_jsonb(a) AS row, workspace.repo_url, workspace.local_path AS workspace_path
         FROM agents a
         LEFT JOIN LATERAL (
           SELECT w.repo_url, w.local_path
             FROM agent_workspace_bindings b
             JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
            WHERE b.agent_id = a.agent_id AND b.active = true
            ORDER BY CASE WHEN b.binding_role = 'primary' THEN 0 ELSE 1 END, b.workspace_id
            LIMIT 1
         ) workspace ON true
        WHERE a.agent_id = $1`,
      [context.agentId],
    )
    if (!result?.row) return null
    const row = { ...result.row, repo_url: result.repo_url, workspace_path: result.workspace_path }
    const metadata = objectRecord(row.metadata)
    const projection = objectRecord(row.ordinary_projection)
    const root = providerRoot(context)
    if (!root || metadata.codex_home !== root || projection.provider_config_root !== root) return null
    return providerAuthorityTupleDigest(context.agentId, row)
  } catch {
    return null
  } finally {
    await db.close().catch(() => {})
  }
}

function commandOptions(
  context: BootstrapStageContext,
  timeoutMs = 30_000,
): { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal } {
  const root = providerRoot(context)
  return {
    cwd: context.repoRoot,
    env: root ? { ...context.env, CODEX_HOME: root } : { ...context.env },
    timeoutMs,
    signal: context.abortSignal,
  }
}

function directoryIdentity(path: string): { realpath: string; device: number; inode: number; uid: number; gid: number; mode: number } {
  const lexical = resolve(path)
  const link = lstatSync(lexical)
  if (link.isSymbolicLink() || !link.isDirectory() || realpathSync(lexical) !== lexical) {
    throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  }
  return {
    realpath: lexical,
    device: Number(link.dev),
    inode: Number(link.ino),
    uid: Number(link.uid),
    gid: Number(link.gid),
    mode: link.mode & 0o777,
  }
}

function providerArtifactIdentity(root: string): ProviderArtifactIdentity {
  const lexicalRoot = resolve(root)
  const parent = dirname(lexicalRoot)
  const rootIdentity = directoryIdentity(lexicalRoot)
  const parentIdentity = directoryIdentity(parent)
  if (rootIdentity.device !== parentIdentity.device) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  const path = join(lexicalRoot, 'config.toml')
  return fileArtifactIdentity(path)
}

function fileArtifactIdentityWithLinks(path: string): ProviderArtifactIdentity {
  const link = lstatSync(path)
  if (link.isSymbolicLink() || !link.isFile() || realpathSync(path) !== path) {
    throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  }
  const bytes = readFileSync(path)
  return {
    path_digest: bootstrapDigest(path),
    realpath_digest: bootstrapDigest(realpathSync(path)),
    device: Number(link.dev),
    inode: Number(link.ino),
    uid: Number(link.uid),
    gid: Number(link.gid),
    mode: link.mode & 0o777,
    byte_length: bytes.byteLength,
    byte_sha256: sha256Bytes(bytes),
    link_count: Number(link.nlink),
  }
}

function fileArtifactIdentity(path: string): ProviderArtifactIdentity {
  const identity = fileArtifactIdentityWithLinks(path)
  if (identity.link_count !== 1) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  return identity
}

function sameProviderArtifact(actual: ProviderArtifactIdentity, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return false
  const value = expected as Record<string, unknown>
  return actual.path_digest === value.path_digest
    && actual.realpath_digest === value.realpath_digest
    && actual.device === Number(value.device)
    && actual.inode === Number(value.inode)
    && actual.uid === Number(value.uid)
    && actual.gid === Number(value.gid)
    && actual.mode === Number(value.mode)
    && actual.byte_length === Number(value.byte_length)
    && actual.byte_sha256 === value.byte_sha256
    && actual.link_count === 1
}

function sameProviderArtifactObjectWithLinks(actual: ProviderArtifactIdentity, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return false
  const value = expected as Record<string, unknown>
  return actual.device === Number(value.device)
    && actual.inode === Number(value.inode)
    && actual.uid === Number(value.uid)
    && actual.gid === Number(value.gid)
    && actual.mode === Number(value.mode)
    && actual.byte_length === Number(value.byte_length)
    && actual.byte_sha256 === value.byte_sha256
}

function sameProviderArtifactObject(actual: ProviderArtifactIdentity, expected: unknown): boolean {
  return sameProviderArtifactObjectWithLinks(actual, expected)
    && actual.link_count === 1
}

function writeConditionalRemoveJournal(
  context: BootstrapStageContext,
  root: string,
  transactionRoot: string,
  transactionConfig: string,
  sentinel: string,
  expectedCurrent: ProviderArtifactIdentity | null,
  admittedAuthorityDigest: string,
): ConditionalRemoveJournal {
  const journal: ConditionalRemoveJournal = {
    schema_version: 'aun-bootstrap-codex-conditional-remove/v1',
    run_id: context.runId,
    provider_root_digest: bootstrapDigest(root),
    provider_root_identity: directoryIdentity(root),
    admitted_authority_digest: admittedAuthorityDigest,
    expected_current: expectedCurrent,
    transaction_root_identity: directoryIdentity(transactionRoot),
    transaction_config_initial: fileArtifactIdentity(transactionConfig),
    sentinel_initial: existsSync(sentinel) ? fileArtifactIdentity(sentinel) : null,
  }
  const path = join(transactionRoot, 'remove-state.json')
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(journal)}\n`, { encoding: 'utf8' })
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600)
  fsyncDirectory(transactionRoot)
  return journal
}

function readConditionalRemoveJournal(
  context: BootstrapStageContext,
  root: string,
  transactionRoot: string,
): ConditionalRemoveJournal | null {
  const path = join(transactionRoot, 'remove-state.json')
  if (!existsSync(path)) return null
  try {
    const link = lstatSync(path)
    if (link.isSymbolicLink() || !link.isFile() || (link.mode & 0o777) !== 0o600 || Number(link.nlink) !== 1) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConditionalRemoveJournal
    if (parsed.schema_version !== 'aun-bootstrap-codex-conditional-remove/v1'
      || parsed.run_id !== context.runId
      || parsed.provider_root_digest !== bootstrapDigest(root)
      || bootstrapDigest(parsed.provider_root_identity) !== bootstrapDigest(directoryIdentity(root))
      || bootstrapDigest(parsed.transaction_root_identity) !== bootstrapDigest(directoryIdentity(transactionRoot))) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function cleanupConditionalRemoveTransaction(transactionRoot: string): boolean {
  try {
    const allowed = new Set(['config.toml', 'live-absence-sentinel', 'remove-state.json'])
    const entries = readdirSync(transactionRoot)
    if (entries.some((entry) => !allowed.has(entry))) return false
    for (const entry of entries) {
      const path = join(transactionRoot, entry)
      const link = lstatSync(path)
      if (link.isSymbolicLink() || !link.isFile()) return false
      unlinkSync(path)
    }
    fsyncDirectory(transactionRoot)
    rmdirSync(transactionRoot)
    fsyncDirectory(dirname(transactionRoot))
    return !existsSync(transactionRoot)
  } catch {
    return false
  }
}

function restoreClaimedForeignArtifact(
  root: string,
  transactionRoot: string,
  configPath: string,
  claimedPath: string,
): boolean {
  try {
    if (existsSync(configPath)) return false
    linkSync(claimedPath, configPath)
    fsyncDirectory(root)
    if (!sameProviderArtifactObjectWithLinks(
      fileArtifactIdentityWithLinks(configPath),
      fileArtifactIdentityWithLinks(claimedPath),
    )) return false
    unlinkSync(claimedPath)
    fsyncDirectory(transactionRoot)
    return true
  } catch {
    return false
  }
}

function atomicClaimAndRemoveOwnedSentinel(
  root: string,
  transactionRoot: string,
  configPath: string,
  sentinelIdentity: ProviderArtifactIdentity | null,
): { ok: true } | { ok: false; reason: 'foreign-live-won' | 'sentinel-claim-unverified' } {
  if (!sentinelIdentity) return { ok: false, reason: 'sentinel-claim-unverified' }
  const claimedPath = join(transactionRoot, 'live-absence-claimed')
  try {
    if (!existsSync(claimedPath)) {
      if (!existsSync(configPath)) return { ok: true }
      renameSync(configPath, claimedPath)
      fsyncDirectory(root)
      fsyncDirectory(transactionRoot)
    }

    const claimedOwned = sameProviderArtifactObjectWithLinks(
      fileArtifactIdentityWithLinks(claimedPath),
      sentinelIdentity,
    )
    if (!claimedOwned) {
      return restoreClaimedForeignArtifact(root, transactionRoot, configPath, claimedPath)
        ? { ok: false, reason: 'foreign-live-won' }
        : { ok: false, reason: 'sentinel-claim-unverified' }
    }

    unlinkSync(claimedPath)
    fsyncDirectory(transactionRoot)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'sentinel-claim-unverified' }
  }
}

function writeLegacyRollbackArtifact(
  context: BootstrapStageContext,
  root: string,
  legacyTuple: unknown,
  prestate: ProviderArtifactIdentity,
): {
  directory: string
  path: string
  digest: string
  identity: ProviderArtifactIdentity
  directoryIdentity: ReturnType<typeof directoryIdentity>
} {
  const directory = join(root, `.aun-bootstrap-rollback-${context.runId}`)
  if (existsSync(directory)) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  if (statSync(directory).dev !== statSync(root).dev) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  const path = join(directory, 'provider-prestate.json')
  const artifact: LegacyRollbackArtifact = {
    schema_version: 'aun-bootstrap-codex-rollback/v1',
    run_id: context.runId,
    config_path: join(root, 'config.toml'),
    config_bytes_base64: readFileSync(join(root, 'config.toml')).toString('base64'),
    legacy_tuple: legacyTuple,
    legacy_tuple_digest: bootstrapDigest(legacyTuple),
    prestate,
  }
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(artifact)}\n`, { encoding: 'utf8' })
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600)
  fsyncDirectory(directory)
  const readback = readFileSync(path)
  if ((lstatSync(path).mode & 0o777) !== 0o600 || sha256Bytes(readback) !== sha256Bytes(`${JSON.stringify(artifact)}\n`)) {
    throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  }
  return {
    directory,
    path,
    digest: sha256Bytes(readback),
    identity: fileArtifactIdentity(path),
    directoryIdentity: directoryIdentity(directory),
  }
}

function readLegacyRollbackArtifact(context: BootstrapStageContext, payload: Record<string, unknown>): LegacyRollbackArtifact | null {
  const path = typeof payload.private_backup_path === 'string' ? payload.private_backup_path : ''
  const expectedDigest = typeof payload.private_backup_sha256 === 'string' ? payload.private_backup_sha256 : ''
  if (!path || !expectedDigest || !existsSync(path)) return null
  const link = lstatSync(path)
  if (link.isSymbolicLink() || !link.isFile() || (link.mode & 0o777) !== 0o600 || Number(link.nlink) !== 1) return null
  let identity: ProviderArtifactIdentity
  try { identity = fileArtifactIdentity(path) } catch { return null }
  if (!sameProviderArtifact(identity, payload.private_backup_identity)) return null
  try {
    const directory = String(payload.private_backup_directory ?? '')
    const actualDirectory = directoryIdentity(directory)
    if (bootstrapDigest(actualDirectory) !== bootstrapDigest(payload.private_backup_directory_identity)) return null
  } catch { return null }
  const bytes = readFileSync(path)
  if (sha256Bytes(bytes) !== expectedDigest) return null
  try {
    const artifact = JSON.parse(bytes.toString('utf8')) as LegacyRollbackArtifact
    return artifact.schema_version === 'aun-bootstrap-codex-rollback/v1'
      && artifact.run_id === context.runId
      && artifact.legacy_tuple_digest === bootstrapDigest(artifact.legacy_tuple)
      ? artifact
      : null
  } catch {
    return null
  }
}

function cleanupLegacyRollbackArtifact(payload: Record<string, unknown>): boolean {
  const directory = typeof payload.private_backup_directory === 'string' ? payload.private_backup_directory : ''
  const path = typeof payload.private_backup_path === 'string' ? payload.private_backup_path : ''
  if (!directory || !path || dirname(path) !== directory || !existsSync(path)) return false
  let identity: ProviderArtifactIdentity
  try { identity = fileArtifactIdentity(path) } catch { return false }
  if (!sameProviderArtifact(identity, payload.private_backup_identity)) return false
  try {
    if (bootstrapDigest(directoryIdentity(directory)) !== bootstrapDigest(payload.private_backup_directory_identity)) return false
  } catch { return false }
  rmSync(path)
  fsyncDirectory(directory)
  rmdirSync(directory)
  fsyncDirectory(dirname(directory))
  return !existsSync(path) && !existsSync(directory)
}

function atomicRestoreProviderArtifact(
  artifact: LegacyRollbackArtifact,
  context: BootstrapStageContext,
  expectedCurrent: ProviderArtifactIdentity,
  beforeNoClobberCommit?: (configPath: string) => void,
): ProviderArtifactIdentity {
  const configPath = artifact.config_path
  const parent = dirname(configPath)
  const temp = join(parent, `.config.toml.aun-restore-${context.runId}`)
  const displaced = join(parent, `.config.toml.aun-displaced-${context.runId}`)
  if (existsSync(temp) || existsSync(displaced)) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  const bytes = Buffer.from(artifact.config_bytes_base64, 'base64')
  if (sha256Bytes(bytes) !== artifact.prestate.byte_sha256) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  let displacedOwned = false
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, artifact.prestate.mode)
    chownSync(temp, artifact.prestate.uid, artifact.prestate.gid)
    const immediatelyBeforeReplace = fileArtifactIdentity(configPath)
    if (!sameProviderArtifact(immediatelyBeforeReplace, expectedCurrent)) {
      throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
    }

    // Move the expected run-owned current artifact aside atomically, then
    // revalidate the moved inode. The final hard-link commit is no-clobber: a
    // foreign writer that recreates configPath wins and is never overwritten.
    renameSync(configPath, displaced)
    fsyncDirectory(parent)
    const displacedIdentity = fileArtifactIdentity(displaced)
    if (!sameProviderArtifactObject(displacedIdentity, expectedCurrent)) {
      throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
    }
    displacedOwned = true
    beforeNoClobberCommit?.(configPath)
    linkSync(temp, configPath)
    unlinkSync(temp)
    fsyncDirectory(parent)
    unlinkSync(displaced)
    displacedOwned = false
    fsyncDirectory(parent)
    return providerArtifactIdentity(dirname(configPath))
  } catch (error) {
    if (existsSync(displaced)) {
      if (!existsSync(configPath)) {
        try {
          linkSync(displaced, configPath)
          unlinkSync(displaced)
          fsyncDirectory(parent)
        } catch {}
      } else if (displacedOwned) {
        try {
          unlinkSync(displaced)
          fsyncDirectory(parent)
        } catch {}
      }
    }
    if (existsSync(temp)) unlinkSync(temp)
    throw error
  }
}

function conditionalRemoveContext(
  context: BootstrapStageContext,
  transactionRoot: string,
): BootstrapStageContext {
  return {
    ...context,
    providerRootAuthority: context.providerRootAuthority
      ? { ...context.providerRootAuthority, canonicalRoot: transactionRoot }
      : undefined,
    env: { ...context.env, CODEX_HOME: transactionRoot },
  }
}

async function conditionalRemoveSuccess(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
  root: string,
  expectedCurrent: ProviderArtifactIdentity | null,
): Promise<BootstrapStageOutcome> {
  const absence = await withFreshBootstrapRecoverySignal(
    context,
    (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
  )
  return absence.ok
    ? {
        ...absence,
        readinessPredicates: {
          ...(absence.readinessPredicates ?? {}),
          rollback_verified: true,
          provider_owned_tuple_conditional_remove_verified: true,
          provider_owned_tuple_crash_recovery_verified: true,
        },
        evidenceRefs: [
          ...(absence.evidenceRefs ?? []),
          `codex-mcp-conditional-remove:${bootstrapDigest({
            provider_root: root,
            expected_artifact: expectedCurrent,
            authority_tuple_digest: context.providerRootAuthority?.authorityTupleDigest ?? null,
          })}`,
        ],
      }
    : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: absence.evidenceRefs }
}

async function recoverConditionalRemoveTransaction(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
  root: string,
  tupleDigest: string,
  admittedAuthorityDigest: string,
): Promise<BootstrapStageOutcome | null> {
  const configPath = join(root, 'config.toml')
  const transactionRoot = join(root, `.aun-bootstrap-remove-${context.runId}`)
  const transactionConfig = join(transactionRoot, 'config.toml')
  const sentinel = join(transactionRoot, 'live-absence-sentinel')
  const displaced = join(root, `.config.toml.aun-remove-owned-${context.runId}`)
  if (!existsSync(transactionRoot) && !existsSync(displaced)) return null
  if (!existsSync(transactionRoot)) {
    return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:journal-missing'] }
  }
  const journal = readConditionalRemoveJournal(context, root, transactionRoot)
  if (!journal || journal.admitted_authority_digest !== admittedAuthorityDigest) {
    return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:journal-invalid'] }
  }

  const expectedCurrent = journal.expected_current
  const transactionContext = conditionalRemoveContext(context, transactionRoot)
  const privateIntended = await withFreshBootstrapRecoverySignal(
    transactionContext,
    (recoveryContext) => exactOwnedTupleDigestReadback(recoveryContext, deps, tupleDigest),
  )
  let privateAbsence = await withFreshBootstrapRecoverySignal(
    transactionContext,
    (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
  )

  if (expectedCurrent && !existsSync(displaced)) {
    let liveStillExpected = false
    try { liveStillExpected = sameProviderArtifact(providerArtifactIdentity(root), expectedCurrent) } catch {}
    if (liveStillExpected
      && privateIntended.ok
      && existsSync(transactionConfig)
      && sameProviderArtifact(fileArtifactIdentity(transactionConfig), journal.transaction_config_initial)) {
      if (!cleanupConditionalRemoveTransaction(transactionRoot)) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      return atomicRemoveOwnedMcpTuple(context, deps, expectedCurrent, admittedAuthorityDigest)
    }
    const liveAbsence = await withFreshBootstrapRecoverySignal(
      context,
      (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
    )
    if (!liveAbsence.ok || !cleanupConditionalRemoveTransaction(transactionRoot)) {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: liveAbsence.evidenceRefs }
    }
    return conditionalRemoveSuccess(context, deps, root, expectedCurrent)
  }

  if (expectedCurrent) {
    let displacedExact = false
    try { displacedExact = sameProviderArtifactObject(fileArtifactIdentity(displaced), expectedCurrent) } catch {}
    if (!displacedExact) {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:displaced-identity'] }
    }
  } else {
    let sentinelExact = false
    try {
      sentinelExact = Boolean(journal.sentinel_initial)
        && sameProviderArtifactObjectWithLinks(fileArtifactIdentityWithLinks(sentinel), journal.sentinel_initial)
    } catch {}
    if (!sentinelExact) {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:sentinel-identity'] }
    }
  }

  if (!privateAbsence.ok) {
    if (!privateIntended.ok) {
      if (expectedCurrent && !existsSync(configPath)) {
        try {
          linkSync(displaced, configPath)
          fsyncDirectory(root)
        } catch {}
      }
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:private-state-unresolved'] }
    }
    const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], commandOptions(transactionContext, 120_000))
    if (removed.exitCode !== 0) {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: [`codex-mcp-conditional-remove-recovery:remove-${removed.exitCode}`] }
    }
    privateAbsence = await withFreshBootstrapRecoverySignal(
      transactionContext,
      (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
    )
    if (!privateAbsence.ok) {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: privateAbsence.evidenceRefs }
    }
  }

  if (expectedCurrent) {
    if (existsSync(configPath)) {
      let committedLink = false
      try {
        committedLink = existsSync(transactionConfig)
          && sameProviderArtifactObjectWithLinks(
            fileArtifactIdentityWithLinks(configPath),
            fileArtifactIdentityWithLinks(transactionConfig),
          )
      } catch {}
      if (committedLink) {
        unlinkSync(transactionConfig)
        fsyncDirectory(transactionRoot)
      } else {
        const liveAbsence = await withFreshBootstrapRecoverySignal(
          context,
          (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
        )
        if (!liveAbsence.ok) {
          if (!cleanupConditionalRemoveTransaction(transactionRoot)) {
            return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
          unlinkSync(displaced)
          fsyncDirectory(root)
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:foreign-live-won'] }
        }
      }
    } else if (existsSync(transactionConfig)) {
      fileArtifactIdentity(transactionConfig)
      linkSync(transactionConfig, configPath)
      unlinkSync(transactionConfig)
      fsyncDirectory(root)
    }
    unlinkSync(displaced)
    fsyncDirectory(root)
  } else {
    const sentinelRemoval = atomicClaimAndRemoveOwnedSentinel(
      root,
      transactionRoot,
      configPath,
      journal.sentinel_initial,
    )
    if (!sentinelRemoval.ok) {
      if (sentinelRemoval.reason === 'foreign-live-won'
        && cleanupConditionalRemoveTransaction(transactionRoot)) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:foreign-live-won'] }
      }
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:sentinel-claim-unverified'] }
    }
  }
  if (!cleanupConditionalRemoveTransaction(transactionRoot)) {
    return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: ['codex-mcp-conditional-remove-recovery:cleanup'] }
  }
  return conditionalRemoveSuccess(context, deps, root, expectedCurrent)
}

async function atomicRemoveOwnedMcpTuple(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
  expectedCurrent: ProviderArtifactIdentity | null,
  admittedAuthorityDigest: string,
): Promise<BootstrapStageOutcome> {
  const configuredRoot = providerRoot(context)
  if (!configuredRoot) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
  let root = configuredRoot
  if (!existsSync(root) && expectedCurrent === null) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      chmodSync(root, 0o700)
      fsyncDirectory(dirname(root))
    } catch {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    }
  }
  if (context.providerRootAuthority?.existingTarget === false
    && context.providerRootAuthority.canonicalSourceField === 'clean_host_default') {
    try { root = realpathSync(root) } catch {
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    }
  }
  try { directoryIdentity(root) } catch {
    return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
  }

  const configPath = join(root, 'config.toml')
  const transactionRoot = join(root, `.aun-bootstrap-remove-${context.runId}`)
  const transactionConfig = join(transactionRoot, 'config.toml')
  const sentinel = join(transactionRoot, 'live-absence-sentinel')
  const displaced = join(root, `.config.toml.aun-remove-owned-${context.runId}`)
  if (existsSync(transactionRoot) || existsSync(displaced)) {
    return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
  }

  let displacedOwned = false
  let sentinelOwned = false
  let sentinelIdentity: ProviderArtifactIdentity | null = null
  try {
    mkdirSync(transactionRoot, { mode: 0o700 })
    chmodSync(transactionRoot, 0o700)
    if (statSync(transactionRoot).dev !== statSync(root).dev) {
      throw new Error('conditional remove transaction crosses devices')
    }
    const sourceBytes = expectedCurrent ? readFileSync(configPath) : Buffer.from('')
    const sourceMode = expectedCurrent ? expectedCurrent.mode : 0o600
    const sourceUid = expectedCurrent ? expectedCurrent.uid : statSync(root).uid
    const sourceGid = expectedCurrent ? expectedCurrent.gid : statSync(root).gid
    const transactionFd = openSync(transactionConfig, 'wx', 0o600)
    try {
      writeFileSync(transactionFd, sourceBytes)
      fsyncSync(transactionFd)
    } finally {
      closeSync(transactionFd)
    }
    chmodSync(transactionConfig, sourceMode)
    chownSync(transactionConfig, sourceUid, sourceGid)
    if (!expectedCurrent) {
      const sentinelFd = openSync(sentinel, 'wx', 0o600)
      try { fsyncSync(sentinelFd) } finally { closeSync(sentinelFd) }
      sentinelIdentity = fileArtifactIdentity(sentinel)
    }
    writeConditionalRemoveJournal(
      context,
      root,
      transactionRoot,
      transactionConfig,
      sentinel,
      expectedCurrent,
      admittedAuthorityDigest,
    )

    if (expectedCurrent) {
      const immediatelyBeforeClaim = providerArtifactIdentity(root)
      if (!sameProviderArtifact(immediatelyBeforeClaim, expectedCurrent)) {
        throw new Error('owned provider artifact changed before conditional remove')
      }
      renameSync(configPath, displaced)
      fsyncDirectory(root)
      const displacedIdentity = fileArtifactIdentity(displaced)
      if (!sameProviderArtifactObject(displacedIdentity, expectedCurrent)) {
        throw new Error('conditional remove claimed a foreign provider artifact')
      }
      displacedOwned = true
    } else {
      if (!sentinelIdentity) throw new Error('conditional remove sentinel identity missing')
      linkSync(sentinel, configPath)
      fsyncDirectory(root)
      if (!sameProviderArtifactObjectWithLinks(fileArtifactIdentityWithLinks(configPath), sentinelIdentity)) {
        throw new Error('conditional remove sentinel claim failed')
      }
      sentinelOwned = true
    }
    deps.afterOwnedTupleArtifactDisplaced?.(configPath)

    const transactionContext = conditionalRemoveContext(context, transactionRoot)
    const removed = await deps.run(
      'codex',
      ['mcp', 'remove', 'aun'],
      commandOptions(transactionContext, 120_000),
    )
    if (removed.exitCode !== 0) throw new Error(`conditional native remove failed:${removed.exitCode}`)
    const transactionAbsence = await withFreshBootstrapRecoverySignal(
      transactionContext,
      (recoveryContext) => exactAbsenceReadback(recoveryContext, deps),
    )
    if (!transactionAbsence.ok) throw new Error('conditional native remove absence readback failed')
    deps.afterOwnedTuplePrivateRemove?.(configPath)

    if (expectedCurrent) {
      if (existsSync(transactionConfig)) {
        fileArtifactIdentity(transactionConfig)
        linkSync(transactionConfig, configPath)
        unlinkSync(transactionConfig)
      } else if (existsSync(configPath)) {
        throw new Error('foreign provider artifact won empty-result commit')
      }
      fsyncDirectory(root)
      deps.afterOwnedTupleLiveCommit?.(configPath)
      unlinkSync(displaced)
      displacedOwned = false
      fsyncDirectory(root)
    } else {
      const sentinelRemoval = atomicClaimAndRemoveOwnedSentinel(
        root,
        transactionRoot,
        configPath,
        sentinelIdentity,
      )
      if (!sentinelRemoval.ok) throw new Error(`absent provider artifact ${sentinelRemoval.reason}`)
      sentinelOwned = false
      deps.afterOwnedTupleLiveCommit?.(configPath)
    }

    if (!cleanupConditionalRemoveTransaction(transactionRoot)) {
      throw new Error('conditional remove transaction cleanup failed')
    }
    return conditionalRemoveSuccess(context, deps, root, expectedCurrent)
  } catch (error) {
    if (displacedOwned && existsSync(displaced)) {
      if (!existsSync(configPath)) {
        try {
          linkSync(displaced, configPath)
          unlinkSync(displaced)
          displacedOwned = false
          fsyncDirectory(root)
        } catch {}
      } else {
        try {
          unlinkSync(displaced)
          displacedOwned = false
          fsyncDirectory(root)
        } catch {}
      }
    }
    if (sentinelOwned && sentinelIdentity && existsSync(configPath)) {
      try {
        if (sameProviderArtifactObjectWithLinks(fileArtifactIdentityWithLinks(configPath), sentinelIdentity)) {
          unlinkSync(configPath)
          sentinelOwned = false
          fsyncDirectory(root)
        }
      } catch {}
    }
    if (existsSync(transactionRoot)) {
      try {
        cleanupConditionalRemoveTransaction(transactionRoot)
      } catch {}
    }
    return {
      ok: false,
      reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
      evidenceRefs: [`codex-mcp-conditional-remove-failed:${bootstrapDigest(String(error))}`],
    }
  }
}

function realpathOrResolve(path: string): string {
  if (path && !path.includes('/')) return Bun.which(path) ?? path
  try { return realpathSync(path) } catch { return resolve(path) }
}

export function expectedBootstrapMcpTuple(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): BootstrapMcpTuple {
  const sqlite = context.env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite'
  const databaseEnvironment = sqlite
    ? {
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: realpathOrResolve(context.env.AGENT_COM_SQLITE_PATH || `${context.repoRoot}/agent-com.db`),
      }
    : { DATABASE_URL: context.env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp' }
  const port = context.env.AUN_BOOTSTRAP_CHANNEL_PORT
  return {
    name: 'aun',
    enabled: true,
    transport: 'stdio',
    command: realpathOrResolve(deps.bunPath),
    argv: ['run', '--cwd', realpathOrResolve(context.repoRoot), deps.serverEntry],
    environment: {
      AGENT_ID: context.agentId,
      AGENT_COM_EXPECTED_AGENT_ID: context.agentId,
      ...databaseEnvironment,
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      ...(port ? { AUN_WEBHOOK_PORT: port } : {}),
    },
    scope: 'user',
  }
}

function registrationArgs(tuple: BootstrapMcpTuple): string[] {
  return [
    'mcp', 'add', 'aun',
    ...Object.entries(tuple.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--', tuple.command, ...tuple.argv,
  ]
}

function parseJson(result: BootstrapCommandResult): any | null {
  if (result.exitCode !== 0) return null
  try { return JSON.parse(result.stdout) } catch { return null }
}

function nativeAbsence(result: BootstrapCommandResult): boolean {
  return result.exitCode !== 0 && /(?:not found|no mcp server named)/i.test(result.stderr)
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, item]) => typeof item !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

export function codexTupleMatches(value: any, expected: BootstrapMcpTuple): boolean {
  const transport = value?.transport
  const environment = stringRecord(transport?.env)
  return value?.name === expected.name
    && value?.enabled === true
    && transport?.type === expected.transport
    && realpathOrResolve(String(transport?.command ?? '')) === expected.command
    && Array.isArray(transport?.args)
    && bootstrapDigest(transport.args) === bootstrapDigest(expected.argv)
    && environment !== null
    && bootstrapDigest(environment) === bootstrapDigest(expected.environment)
}

function codexListState(value: any): { count: number; enabled: boolean; entries: any[] } {
  if (!Array.isArray(value)) return { count: -1, enabled: false, entries: [] }
  const entries = value.filter((item) => item?.name === 'aun')
  return { count: entries.length, enabled: entries.length === 1 && entries[0]?.enabled === true, entries }
}

function hasExactObjectKeys(value: unknown, keys: string[]): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && bootstrapDigest(Object.keys(value as Record<string, unknown>).sort()) === bootstrapDigest([...keys].sort())
}

function recognizedDisabledLegacyTuple(value: any): boolean {
  const transport = value?.transport
  return hasExactObjectKeys(value, ['name', 'enabled', 'scope', 'transport'])
    && hasExactObjectKeys(transport, ['type', 'command', 'args', 'env'])
    && value?.name === 'aun'
    && value?.enabled === false
    && value?.scope === 'user'
    && transport?.type === 'stdio'
    && String(transport?.command ?? '') === LEGACY_BUN
    && Array.isArray(transport?.args)
    && bootstrapDigest(transport.args) === bootstrapDigest(['run', LEGACY_SERVER])
    && transport?.env === null
}

const POST_EXIT_RECOVERY_DEADLINE_MS = 30_000

export async function withFreshBootstrapRecoverySignal(
  context: BootstrapStageContext,
  task: (recoveryContext: BootstrapStageContext) => Promise<BootstrapStageOutcome>,
): Promise<BootstrapStageOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error('bootstrap post-exit recovery deadline exceeded'))
  }, POST_EXIT_RECOVERY_DEADLINE_MS)
  try {
    return await task({ ...context, abortSignal: controller.signal })
  } catch (err) {
    return {
      ok: false,
      reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
      evidenceRefs: [`bootstrap-post-exit-recovery-error:${bootstrapDigest(String(err))}`],
    }
  } finally {
    clearTimeout(timer)
  }
}

async function exactReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = commandOptions(context)
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const get = parseJson(getResult)
  const list = codexListState(parseJson(listResult))
  const expected = expectedBootstrapMcpTuple(context, deps)
  const ok = getResult.exitCode === 0
    && listResult.exitCode === 0
    && list.count === 1
    && list.enabled
    && codexTupleMatches(get, expected)
  return ok
    ? {
        ok: true,
        evidenceRefs: [`codex-mcp-exact-tuple:${bootstrapDigest(expected)}`],
        readinessPredicates: { mcp_registered: true, mcp_native_get_exact: true, mcp_native_list_exact: true },
        readbackDigest: bootstrapDigest(expected),
      }
    : {
        ok: false,
        reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'],
        evidenceRefs: [`codex-mcp-mismatch:${bootstrapDigest({ get_exit: getResult.exitCode, list_exit: listResult.exitCode, list })}`],
        readinessPredicates: { mcp_registered: false, mcp_native_get_exact: false, mcp_native_list_exact: false },
      }
}

async function exactOwnedTupleDigestReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
  expectedDigest: string,
): Promise<BootstrapStageOutcome> {
  const options = commandOptions(context)
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const get = parseJson(getResult)
  const list = codexListState(parseJson(listResult))
  const environment = stringRecord(get?.transport?.env)
  const argv = get?.transport?.args
  const projection: BootstrapMcpTuple | null = get?.name === 'aun'
    && get?.enabled === true
    && get?.transport?.type === 'stdio'
    && typeof get?.transport?.command === 'string'
    && Array.isArray(argv)
    && argv.every((item: unknown) => typeof item === 'string')
    && environment !== null
    ? {
        name: 'aun',
        enabled: true,
        transport: 'stdio',
        command: realpathOrResolve(get.transport.command),
        argv: [...argv],
        environment,
        scope: 'user',
      }
    : null
  const actualDigest = projection ? bootstrapDigest(projection) : null
  const ok = getResult.exitCode === 0
    && listResult.exitCode === 0
    && list.count === 1
    && list.enabled
    && actualDigest === expectedDigest
  return ok
    ? {
        ok: true,
        evidenceRefs: [`codex-mcp-exact-owned-tuple:${expectedDigest}`],
        readinessPredicates: { mcp_registered: true, mcp_native_get_exact: true, mcp_native_list_exact: true },
        readbackDigest: expectedDigest,
      }
    : {
        ok: false,
        reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
        evidenceRefs: [`codex-mcp-owned-tuple-mismatch:${bootstrapDigest({
          get_exit: getResult.exitCode,
          list_exit: listResult.exitCode,
          list_count: list.count,
          actual_digest: actualDigest,
          expected_digest: expectedDigest,
        })}`],
      }
}

async function exactAbsenceReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = commandOptions(context)
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const list = codexListState(parseJson(listResult))
  const digest = bootstrapDigest({ absent: true, get_exit: getResult.exitCode, list_exit: listResult.exitCode, list_count: list.count })
  return nativeAbsence(getResult) && listResult.exitCode === 0 && list.count === 0
    ? { ok: true, evidenceRefs: [`codex-mcp-native-absence:${digest}`], readbackDigest: digest }
    : { ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'], evidenceRefs: [`codex-mcp-native-absence-unresolved:${digest}`] }
}

async function exactLegacyReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
  expectedLegacyDigest: string,
): Promise<BootstrapStageOutcome> {
  const options = commandOptions(context)
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const get = parseJson(getResult)
  const list = codexListState(parseJson(listResult))
  const ok = getResult.exitCode === 0
    && listResult.exitCode === 0
    && list.count === 1
    && !list.enabled
    && recognizedDisabledLegacyTuple(get)
    && bootstrapDigest(get) === expectedLegacyDigest
  return ok
    ? {
        ok: true,
        evidenceRefs: [`codex-mcp-legacy-restored:${expectedLegacyDigest}`],
        readinessPredicates: { rollback_verified: true, legacy_tuple_restored: true },
        readbackDigest: expectedLegacyDigest,
      }
    : {
        ok: false,
        reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
        evidenceRefs: [`codex-mcp-legacy-restore-mismatch:${bootstrapDigest({
          get_exit: getResult.exitCode,
          list_exit: listResult.exitCode,
          list_count: list.count,
        })}`],
      }
}

export function createCodexBootstrapAdapter(deps: BootstrapAdapterDependencies): BootstrapRuntimeAdapter {
  return {
    runtime: 'codex',

    async dependencyPreflight(context): Promise<BootstrapStageOutcome> {
      const result = await deps.run('codex', ['--version'], commandOptions(context))
      return result.exitCode === 0
        ? {
            ok: true,
            evidenceRefs: [`codex-cli:${bootstrapDigest(result.stdout.trim())}`],
            readinessPredicates: { codex_cli_available: true },
            readbackDigest: bootstrapDigest({ executable: realpathOrResolve('codex'), version: result.stdout.trim(), config_scope: 'native-default' }),
          }
        : { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'], readinessPredicates: { codex_cli_available: false } }
    },

    async planMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const tuple = expectedBootstrapMcpTuple(context, deps)
      return {
        ok: true,
        evidenceRefs: [`codex-mcp-plan:${bootstrapDigest(tuple)}`],
        readinessPredicates: { provider_cli_owns_config: true, secrets_excluded_from_state: true },
      }
    },

    async applyMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const options = commandOptions(context)
      const beforeGet = await deps.run('codex', ['mcp', 'get', 'aun', '--json'], options)
      const beforeList = await deps.run('codex', ['mcp', 'list', '--json'], options)
      const parsedBefore = parseJson(beforeGet)
      const listState = codexListState(parseJson(beforeList))
      if (beforeGet.exitCode === 0) {
        const expected = expectedBootstrapMcpTuple(context, deps)
        if (beforeList.exitCode === 0 && listState.count === 1 && listState.enabled && codexTupleMatches(parsedBefore, expected)) {
          return exactReadback(context, deps)
        }
        if (beforeList.exitCode !== 0 || listState.count !== 1 || listState.enabled || !recognizedDisabledLegacyTuple(parsedBefore)) {
          return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'] }
        }

        const root = providerRoot(context)
        if (!root || context.providerRootAuthority?.canonicalSourceField !== 'metadata.codex_home') {
          return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'] }
        }
        let prestate: ProviderArtifactIdentity
        let backup: ReturnType<typeof writeLegacyRollbackArtifact>
        try {
          prestate = providerArtifactIdentity(root)
          backup = writeLegacyRollbackArtifact(context, root, parsedBefore, prestate)
        } catch {
          const partialDirectory = join(root, `.aun-bootstrap-rollback-${context.runId}`)
          if (existsSync(partialDirectory)) rmSync(partialDirectory, { recursive: true, force: true })
          return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'] }
        }

        const tuple = expectedBootstrapMcpTuple(context, deps)
        const legacyMutation = (poststate: ProviderArtifactIdentity | null, actualAfterDigest: string | null) => ({
          kind: 'mcp_registration' as const,
          owner_key: `codex:aun:${context.runId}`,
          before_digest: bootstrapDigest(parsedBefore),
          intended_after_digest: bootstrapDigest(tuple),
          actual_after_digest: actualAfterDigest,
          rollback_action: 'fenced native removal followed by atomic exact config.toml legacy restore',
          rollback_payload: {
            created_by_run: true,
            replaced_recognized_disabled_legacy: true,
            legacy_tuple_digest: bootstrapDigest(parsedBefore),
            private_backup_directory: backup.directory,
            private_backup_path: backup.path,
            private_backup_sha256: backup.digest,
            private_backup_identity: backup.identity,
            private_backup_directory_identity: backup.directoryIdentity,
            pre_state: prestate,
            post_state: poststate,
            target_artifact_path_digest: bootstrapDigest(join(root, 'config.toml')),
            backup_fsync_verified: true,
            backup_retained: true,
          },
        })

        context.admitRecoveryMutation?.({
          ...legacyMutation(null, null),
          rollback_payload: {
            ...legacyMutation(null, null).rollback_payload,
            recovery_admission_phase: 'B4_PRE_PROVIDER_REMOVE',
          },
        })

        const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], { ...options, timeoutMs: 120_000 })
        let postRemoveState: ProviderArtifactIdentity | null = null
        try { postRemoveState = providerArtifactIdentity(root) } catch {}
        context.admitRecoveryMutation?.({
          ...legacyMutation(postRemoveState, null),
          rollback_payload: {
            ...legacyMutation(postRemoveState, null).rollback_payload,
            post_remove_state: postRemoveState,
            recovery_admission_phase: 'B4_POST_PROVIDER_REMOVE',
          },
        })
        const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactAbsenceReadback(recoveryContext, deps))
        if (removed.exitCode !== 0 && !absence.ok) {
          const legacyStillExact = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
            exactLegacyReadback(recoveryContext, deps, bootstrapDigest(parsedBefore)))
          let current: ProviderArtifactIdentity | null = null
          try { current = providerArtifactIdentity(root) } catch {}
          if (legacyStillExact.ok && current && sameProviderArtifact(current, prestate)) {
            const cleaned = cleanupLegacyRollbackArtifact({
              private_backup_directory: backup.directory,
              private_backup_path: backup.path,
              private_backup_identity: backup.identity,
              private_backup_directory_identity: backup.directoryIdentity,
            })
            if (cleaned) {
              context.cancelRecoveryAdmission?.(`codex:aun:${context.runId}`)
              return { ok: false, reasonCodes: ['NO_GO_MCP_REGISTRATION'], evidenceRefs: legacyStillExact.evidenceRefs }
            }
          }
          return {
            ok: false,
            reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
            evidenceRefs: [...(absence.evidenceRefs ?? []), `codex-mcp-remove-nonzero:${removed.exitCode}`],
            mutation: legacyMutation(current, null),
          }
        }
        if (!absence.ok) {
          let current: ProviderArtifactIdentity | null = null
          try { current = providerArtifactIdentity(root) } catch {}
          return { ...absence, mutation: legacyMutation(current, null) }
        }

        const applied = await deps.run('codex', registrationArgs(tuple), { ...options, timeoutMs: 120_000 })
        const readback = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactReadback(recoveryContext, deps))
        let poststate: ProviderArtifactIdentity | null = null
        try { poststate = providerArtifactIdentity(root) } catch {}
        const mutation = legacyMutation(poststate, readback.ok && poststate ? bootstrapDigest(tuple) : null)
        if (readback.ok && poststate) {
          return applied.exitCode === 0
            ? {
                ...readback,
                evidenceRefs: [
                  ...(readback.evidenceRefs ?? []),
                  `codex-mcp-legacy-upgrade:${bootstrapDigest({
                    legacy_tuple_digest: bootstrapDigest(parsedBefore),
                    prestate_digest: bootstrapDigest(prestate),
                    poststate_digest: bootstrapDigest(poststate),
                    backup_digest: backup.digest,
                  })}`,
                ],
                readinessPredicates: {
                  ...(readback.readinessPredicates ?? {}),
                  provider_artifact_identity_verified: true,
                  private_backup_fsync_verified: true,
                  private_backup_retained: true,
                  secrets_excluded_from_state: true,
                },
                mutation,
              }
            : {
                ...readback,
                ok: false,
                reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
                evidenceRefs: [...(readback.evidenceRefs ?? []), `codex-mcp-add-nonzero-after-legacy-upgrade:${applied.exitCode}`],
                mutation,
              }
        }
        return {
          ...readback,
          ok: false,
          reasonCodes: poststate ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'],
          evidenceRefs: [
            ...(readback.evidenceRefs ?? []),
            `codex-mcp-legacy-upgrade-recovery-required:${bootstrapDigest({ add_exit: applied.exitCode })}`,
          ],
          mutation,
        }
      }
      if (!nativeAbsence(beforeGet)) return { ok: false, reasonCodes: ['NO_GO_MCP_READBACK'] }
      if (beforeList.exitCode !== 0 || listState.count !== 0) {
        return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'] }
      }
      if (context.providerRootAuthority?.existingTarget === true) {
        const root = providerRoot(context)
        try {
          if (!root || context.providerRootAuthority.canonicalSourceField !== 'metadata.codex_home') {
            throw new Error('canonical provider root unavailable')
          }
          providerArtifactIdentity(root)
        } catch {
          return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'] }
        }
      }

      const tuple = expectedBootstrapMcpTuple(context, deps)
      const args = registrationArgs(tuple)
      const admittedProviderAuthorityDigest = await liveProviderAuthorityDigest(context)
      if (context.priorState?.schema_version === 'shirube-v3/aun-bootstrap-run/v1'
        && !admittedProviderAuthorityDigest) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const mutation = {
        kind: 'mcp_registration' as const,
        owner_key: `codex:aun:${context.runId}`,
        before_digest: bootstrapDigest({ absent: true }),
        intended_after_digest: bootstrapDigest(tuple),
        actual_after_digest: null,
        rollback_action: 'codex mcp remove aun; verify native get absence and list absence',
        rollback_payload: {
          created_by_run: true,
          tuple_digest: bootstrapDigest(tuple),
          admitted_run_id: context.runId,
          admitted_repo_head: context.repoHead,
          admitted_provider_root_digest: bootstrapDigest(providerRoot(context)),
          admitted_provider_authority_digest: admittedProviderAuthorityDigest,
        },
      }
      context.admitRecoveryMutation?.({
        ...mutation,
        rollback_payload: {
          ...mutation.rollback_payload,
          recovery_admission_phase: 'B4_PRE_PROVIDER_ADD',
        },
      })
      const applied = await deps.run('codex', args, { ...options, timeoutMs: 120_000 })
      const readback = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
        exactReadback(recoveryContext, deps))
      if (readback.ok) {
        const observed = { ...mutation, actual_after_digest: bootstrapDigest(tuple) }
        return applied.exitCode === 0
          ? { ...readback, mutation: observed }
          : {
              ...readback,
              ok: false,
              reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
              evidenceRefs: [...(readback.evidenceRefs ?? []), `codex-mcp-add-nonzero-after-mutation:${applied.exitCode}`],
              mutation: observed,
            }
      }
      const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
        exactAbsenceReadback(recoveryContext, deps))
      if (absence.ok) {
        context.cancelRecoveryAdmission?.(`codex:aun:${context.runId}`)
        return {
          ...absence,
          ok: false,
          reasonCodes: [applied.exitCode === 0 ? 'NO_GO_MCP_READBACK' : 'NO_GO_MCP_REGISTRATION'],
        }
      }
      return {
        ...readback,
        ok: false,
        reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
        evidenceRefs: [
          ...(readback.evidenceRefs ?? []),
          ...(absence.evidenceRefs ?? []),
          `codex-mcp-post-exit-recovery-required:${bootstrapDigest({
            run_id: context.runId,
            intended_after_digest: mutation.intended_after_digest,
            add_exit: applied.exitCode,
          })}`,
        ],
        mutation: {
          ...mutation,
          rollback_payload: {
            ...mutation.rollback_payload,
            post_exit_readback_signal: 'fresh_bounded',
            recovery_required: true,
            target_readback_unresolved: true,
          },
        },
      }
    },

    readbackMcpRegistration(context): Promise<BootstrapStageOutcome> {
      return exactReadback(context, deps)
    },

    async planRuntimeStart(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'codex'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_RUNTIME_RECEIPT'], readinessPredicates: { current_runtime_verified: ok } }
    },

    async verifyRuntimeIdentity(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'codex'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_IDENTITY_MISMATCH'], readinessPredicates: { runtime_identity_matches: ok } }
    },

    async rollbackRuntimeRegistration(context, mutation: BootstrapMutation): Promise<BootstrapStageOutcome> {
      if (mutation.kind !== 'mcp_registration'
        || mutation.owner_key !== `codex:aun:${context.runId}`
        || mutation.rollback_payload?.created_by_run !== true) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const payload = mutation.rollback_payload ?? {}
      if (payload.replaced_recognized_disabled_legacy === true) {
        const root = providerRoot(context)
        const artifact = readLegacyRollbackArtifact(context, payload)
        if (!root || !artifact || artifact.config_path !== join(root, 'config.toml')) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        let current: ProviderArtifactIdentity
        try { current = providerArtifactIdentity(root) } catch {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const admissionOpen = payload.recovery_admission === true && mutation.actual_after_digest === null
        if (admissionOpen) {
          const legacyUnchanged = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
            exactLegacyReadback(recoveryContext, deps, artifact.legacy_tuple_digest))
          if (legacyUnchanged.ok && sameProviderArtifact(current, artifact.prestate)) {
            if (!cleanupLegacyRollbackArtifact(payload)) {
              return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
            }
            mutation.rollback_payload = {
              ...payload,
              backup_retained: false,
              backup_deleted: true,
              recovery_admission_no_effect: true,
            }
            return {
              ok: true,
              readinessPredicates: { rollback_verified: true, recovery_admission_no_effect: true },
              evidenceRefs: [`codex-mcp-recovery-admission-no-effect:${bootstrapDigest(current)}`],
              readbackDigest: bootstrapDigest({ legacy_tuple_digest: artifact.legacy_tuple_digest, no_effect: true }),
            }
          }
        } else if (!sameProviderArtifact(current, payload.post_state)) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`codex-mcp-rollback-foreign-artifact:${bootstrapDigest(current)}`],
          }
        }

        const intended = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactReadback(recoveryContext, deps))
        let postRemoveFence: ProviderArtifactIdentity | null = null
        if (intended.ok && (admissionOpen || intended.readbackDigest === mutation.actual_after_digest)) {
          const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], commandOptions(context, 120_000))
          if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          try { postRemoveFence = providerArtifactIdentity(root) } catch {
            return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
        } else if (admissionOpen && sameProviderArtifact(current, payload.post_remove_state)) {
          postRemoveFence = current
        } else {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: intended.evidenceRefs }
        }
        const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactAbsenceReadback(recoveryContext, deps))
        if (!absence.ok) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: absence.evidenceRefs }
        if (!postRemoveFence) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        let restored: ProviderArtifactIdentity
        try {
          restored = atomicRestoreProviderArtifact(
            artifact,
            context,
            postRemoveFence,
            deps.beforeProviderArtifactNoClobberCommit,
          )
        } catch {
          return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`codex-mcp-rollback-post-remove-foreign-artifact:${bootstrapDigest(postRemoveFence)}`],
          }
        }
        const restoredIdentity = restored.byte_sha256 === artifact.prestate.byte_sha256
          && restored.byte_length === artifact.prestate.byte_length
          && restored.uid === artifact.prestate.uid
          && restored.gid === artifact.prestate.gid
          && restored.mode === artifact.prestate.mode
          && restored.path_digest === artifact.prestate.path_digest
          && restored.realpath_digest === artifact.prestate.realpath_digest
          && restored.link_count === 1
        const legacy = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactLegacyReadback(recoveryContext, deps, artifact.legacy_tuple_digest))
        if (!restoredIdentity || !legacy.ok || !cleanupLegacyRollbackArtifact(payload)) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: legacy.evidenceRefs }
        }
        mutation.rollback_payload = {
          ...payload,
          backup_retained: false,
          backup_deleted: true,
          backup_directory_fsync_verified: true,
          restored_identity_digest: bootstrapDigest(restored),
        }
        return {
          ok: true,
          readinessPredicates: {
            rollback_verified: true,
            provider_artifact_atomic_restore_verified: true,
            provider_legacy_tuple_restored: true,
            private_backup_deleted: true,
            secrets_excluded_from_state: true,
          },
          evidenceRefs: [
            ...(legacy.evidenceRefs ?? []),
            `codex-provider-artifact-restored:${bootstrapDigest({
              restored_identity: restored,
              backup_deleted: true,
            })}`,
          ],
          readbackDigest: bootstrapDigest({
            legacy_tuple_digest: artifact.legacy_tuple_digest,
            restored_identity: restored,
            backup_deleted: true,
          }),
        }
      }

      const tupleDigest = typeof payload.tuple_digest === 'string' ? payload.tuple_digest : null
      const admissionOpen = payload.recovery_admission === true && mutation.actual_after_digest === null
      const admittedAuthorityDigest = typeof payload.admitted_provider_authority_digest === 'string'
        ? payload.admitted_provider_authority_digest
        : null
      const liveAuthorityDigest = await liveProviderAuthorityDigest(context)
      const ownershipFences = {
        absent_prestate: mutation.before_digest === bootstrapDigest({ absent: true }),
        tuple_digest_present: tupleDigest !== null,
        intended_digest: tupleDigest === mutation.intended_after_digest,
        run_id: payload.admitted_run_id === context.runId,
        repo_head: payload.admitted_repo_head === context.repoHead,
        provider_root: payload.admitted_provider_root_digest === bootstrapDigest(providerRoot(context)),
        provider_authority_digest_present: admittedAuthorityDigest !== null,
        provider_authority_digest: admittedAuthorityDigest === liveAuthorityDigest,
      }
      const failedOwnershipFences = Object.entries(ownershipFences)
        .filter(([, matches]) => !matches)
        .map(([name]) => name)
      if (failedOwnershipFences.length > 0) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
          evidenceRefs: [`codex-mcp-rollback-ownership-fence-failed:${failedOwnershipFences.join(',')}`],
        }
      }
      const configuredRoot = providerRoot(context)
      let root = configuredRoot
      let providerArtifactBeforeReadback: ProviderArtifactIdentity | null = null
      try {
        if (!root) throw new Error('provider root unavailable')
        if (context.providerRootAuthority?.existingTarget === false
          && context.providerRootAuthority.canonicalSourceField === 'clean_host_default'
          && existsSync(root)) {
          root = realpathSync(root)
        }
        const recovered = await recoverConditionalRemoveTransaction(
          context,
          deps,
          root,
          tupleDigest,
          admittedAuthorityDigest,
        )
        if (recovered) return recovered
        providerArtifactBeforeReadback = existsSync(join(root, 'config.toml'))
          ? providerArtifactIdentity(root)
          : null
      } catch {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const intended = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
        exactOwnedTupleDigestReadback(recoveryContext, deps, tupleDigest))
      if (!intended.ok || intended.readbackDigest !== tupleDigest) {
        const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactAbsenceReadback(recoveryContext, deps))
        if (admissionOpen && absence.ok) {
          return {
            ok: true,
            readinessPredicates: { rollback_verified: true, recovery_admission_no_effect: true },
            evidenceRefs: absence.evidenceRefs,
            readbackDigest: absence.readbackDigest,
          }
        }
        return {
          ok: false,
          reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
          evidenceRefs: [...(intended.evidenceRefs ?? []), ...(absence.evidenceRefs ?? [])],
        }
      }
      deps.beforeOwnedTupleConditionalRemove?.(join(root, 'config.toml'))
      if (admittedAuthorityDigest !== await liveProviderAuthorityDigest(context)) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
          evidenceRefs: ['codex-mcp-rollback-ownership-fence-failed:provider_authority_digest'],
        }
      }
      return atomicRemoveOwnedMcpTuple(
        context,
        deps,
        providerArtifactBeforeReadback,
        admittedAuthorityDigest,
      )
    },

    async finalizeRuntimeRegistration(context, mutation): Promise<BootstrapStageOutcome> {
      if (mutation.kind !== 'mcp_registration'
        || mutation.owner_key !== `codex:aun:${context.runId}`
        || mutation.rollback_payload?.replaced_recognized_disabled_legacy !== true) {
        return { ok: true, readinessPredicates: { provider_backup_not_required: true }, readbackDigest: mutation.actual_after_digest ?? undefined }
      }
      const payload = mutation.rollback_payload
      const root = providerRoot(context)
      if (!root) return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'] }
      const readback = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
        exactReadback(recoveryContext, deps))
      let current: ProviderArtifactIdentity | null = null
      try { current = providerArtifactIdentity(root) } catch {}
      if (!readback.ok || readback.readbackDigest !== mutation.actual_after_digest
        || !current || !sameProviderArtifact(current, payload.post_state)
        || !readLegacyRollbackArtifact(context, payload)) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
          evidenceRefs: [`codex-provider-backup-retention-fence:${bootstrapDigest({
            native_exact: readback.ok,
            artifact_exact: Boolean(current && sameProviderArtifact(current, payload.post_state)),
          })}`],
        }
      }
      if (!cleanupLegacyRollbackArtifact(payload)) {
        return { ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'] }
      }
      mutation.rollback_payload = {
        ...payload,
        backup_retained: false,
        backup_deleted: true,
        backup_directory_fsync_verified: true,
      }
      return {
        ok: true,
        readinessPredicates: {
          provider_terminal_readback_verified: true,
          private_backup_deleted: true,
          backup_directory_fsync_verified: true,
          secrets_excluded_from_state: true,
        },
        evidenceRefs: [`codex-provider-backup-deleted:${bootstrapDigest({
          tuple_digest: mutation.actual_after_digest,
          poststate_digest: bootstrapDigest(current),
        })}`],
        readbackDigest: bootstrapDigest({
          tuple_digest: mutation.actual_after_digest,
          poststate_digest: bootstrapDigest(current),
          backup_deleted: true,
        }),
      }
    },
  }
}
