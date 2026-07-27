import { createHash } from 'node:crypto'
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
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

function fileArtifactIdentity(path: string): ProviderArtifactIdentity {
  const link = lstatSync(path)
  if (link.isSymbolicLink() || !link.isFile() || Number(link.nlink) !== 1 || realpathSync(path) !== path) {
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

function atomicRestoreProviderArtifact(artifact: LegacyRollbackArtifact, context: BootstrapStageContext): ProviderArtifactIdentity {
  const configPath = artifact.config_path
  const parent = dirname(configPath)
  const temp = join(parent, `.config.toml.aun-restore-${context.runId}`)
  if (existsSync(temp)) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  const bytes = Buffer.from(artifact.config_bytes_base64, 'base64')
  if (sha256Bytes(bytes) !== artifact.prestate.byte_sha256) throw new Error('NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS')
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(temp, artifact.prestate.mode)
  chownSync(temp, artifact.prestate.uid, artifact.prestate.gid)
  renameSync(temp, configPath)
  fsyncDirectory(parent)
  return providerArtifactIdentity(dirname(configPath))
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

        const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], { ...options, timeoutMs: 120_000 })
        const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactAbsenceReadback(recoveryContext, deps))
        if (removed.exitCode !== 0 && !absence.ok) {
          const legacyStillExact = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
            exactLegacyReadback(recoveryContext, deps, bootstrapDigest(parsedBefore)))
          let current: ProviderArtifactIdentity | null = null
          try { current = providerArtifactIdentity(root) } catch {}
          if (legacyStillExact.ok && current && sameProviderArtifact(current, prestate)) {
            cleanupLegacyRollbackArtifact({
              private_backup_directory: backup.directory,
              private_backup_path: backup.path,
              private_backup_identity: backup.identity,
              private_backup_directory_identity: backup.directoryIdentity,
            })
            return { ok: false, reasonCodes: ['NO_GO_MCP_REGISTRATION'], evidenceRefs: legacyStillExact.evidenceRefs }
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
      const applied = await deps.run('codex', args, { ...options, timeoutMs: 120_000 })
      const mutation = {
        kind: 'mcp_registration' as const,
        owner_key: `codex:aun:${context.runId}`,
        before_digest: bootstrapDigest({ absent: true }),
        intended_after_digest: bootstrapDigest(tuple),
        actual_after_digest: null,
        rollback_action: 'codex mcp remove aun; verify native get absence and list absence',
        rollback_payload: { created_by_run: true, tuple_digest: bootstrapDigest(tuple) },
      }
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
        if (!sameProviderArtifact(current, payload.post_state)) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`codex-mcp-rollback-foreign-artifact:${bootstrapDigest(current)}`],
          }
        }
        const intended = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactReadback(recoveryContext, deps))
        if (!intended.ok || intended.readbackDigest !== mutation.actual_after_digest) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: intended.evidenceRefs }
        }
        const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], commandOptions(context, 120_000))
        if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        const absence = await withFreshBootstrapRecoverySignal(context, (recoveryContext) =>
          exactAbsenceReadback(recoveryContext, deps))
        if (!absence.ok) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: absence.evidenceRefs }
        let restored: ProviderArtifactIdentity
        try { restored = atomicRestoreProviderArtifact(artifact, context) } catch {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
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

      const options = commandOptions(context)
      const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], options)
      if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      const [getResult, listResult] = await Promise.all([
        deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
        deps.run('codex', ['mcp', 'list', '--json'], options),
      ])
      const listState = codexListState(parseJson(listResult))
      const readbackDigest = bootstrapDigest({
        absent: true,
        get_exit: getResult.exitCode,
        list_exit: listResult.exitCode,
        list_count: listState.count,
      })
      return nativeAbsence(getResult) && listResult.exitCode === 0 && listState.count === 0
        ? {
            ok: true,
            readinessPredicates: { rollback_verified: true },
            evidenceRefs: [`codex-mcp-native-absence:${readbackDigest}`],
            readbackDigest,
          }
        : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
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
