import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  acquireControlPlaneLease,
  releaseControlPlaneLease,
} from '../../core/control-plane-leases'
import {
  markConfigurationEventDelivered,
  readConfigurationDesiredState,
  recordConfigurationObservedState,
} from '../../core/aun-configuration-desired-state'
import { buildDefaultAunConfigurationCandidate } from '../../core/aun-configuration-candidate'
import {
  BOOTSTRAP_SAFE_D1_DEFAULTS,
  FileBootstrapStateStore,
  bootstrapDigest,
  bootstrapStateRoot,
  validateBootstrapAgentId,
  type BootstrapStateStore,
} from '../../core/aun-bootstrap-state'
import {
  DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID,
  defaultStateDaemonRestoreRoot,
  parseStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
} from '../../core/state-daemon/launchagent'
import {
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate,
  recordRuntimeMemoryReadyEvidence,
} from '../../core/runtime-memory-ready'
import {
  selectBootstrapRuntime,
  type BootstrapRuntimeSignal,
} from '../../core/runtime-inventory'
import {
  enqueueBootstrapQueueSmoke,
  observeBootstrapQueueSmoke,
  type BootstrapQueueSmokeConsumerEvidence,
} from '../../core/queue-runtime'
import { createCodexBootstrapAdapter, type BootstrapAdapterCommandRunner } from './bootstrap-adapter-codex'
import { createClaudeBootstrapAdapter, parseClaudeMcpGet } from './bootstrap-adapter-claude'
import {
  BOOTSTRAP_STAGES,
  type BootstrapCommandResult,
  type BootstrapExecutionPorts,
  type BootstrapMutation,
  type BootstrapOptions,
  type BootstrapReasonCode,
  type BootstrapResolvedRuntime,
  type BootstrapResult,
  type BootstrapRunState,
  type BootstrapRuntimeAdapter,
  type BootstrapStage,
  type BootstrapStageContext,
  type BootstrapStageOutcome,
} from './bootstrap-types'

const STAGE_DEADLINE_MS: Record<BootstrapStage, number> = {
  B0_LOCK_AND_SNAPSHOT: 30_000,
  B1_DEPENDENCY_PREFLIGHT: 30_000,
  B2_DB_MIGRATION: 120_000,
  B3_AGENT_PROFILE: 120_000,
  B4_MCP_REGISTRATION: 120_000,
  B5_MEMORY_READINESS: 120_000,
  B6_ORDINARY_DAEMON_INSTALL_START: 120_000,
  B7_QUEUE_SMOKE: 120_000,
  B8_READY_READBACK: 120_000,
}

const STAGE_METHOD: Record<BootstrapStage, keyof Pick<BootstrapExecutionPorts,
  'lockAndSnapshot' | 'dependencyPreflight' | 'migrateDatabase' | 'ensureAgentProfile'
  | 'ensureMcpRegistration' | 'ensureMemoryReadiness' | 'installAndStartDaemon'
  | 'runQueueSmoke' | 'readbackReady'>> = {
  B0_LOCK_AND_SNAPSHOT: 'lockAndSnapshot',
  B1_DEPENDENCY_PREFLIGHT: 'dependencyPreflight',
  B2_DB_MIGRATION: 'migrateDatabase',
  B3_AGENT_PROFILE: 'ensureAgentProfile',
  B4_MCP_REGISTRATION: 'ensureMcpRegistration',
  B5_MEMORY_READINESS: 'ensureMemoryReadiness',
  B6_ORDINARY_DAEMON_INSTALL_START: 'installAndStartDaemon',
  B7_QUEUE_SMOKE: 'runQueueSmoke',
  B8_READY_READBACK: 'readbackReady',
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function nowIso(): string {
  return new Date().toISOString()
}

function stateDaemonReadinessArgs(): string[] {
  return [
    'cli/index.ts', 'state-daemon', 'readiness', '--require-running',
    '--expected-agent-id', DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID, '--format', 'json',
  ]
}

function sqliteFileDigest(path: string): string {
  return bootstrapDigest(readFileSync(path))
}

function sqliteFileIdentity(path: string): { realpath: string; device: number; inode: number; mode: number } {
  const stat = statSync(path)
  return { realpath: realpathSync(path), device: Number(stat.dev), inode: Number(stat.ino), mode: stat.mode & 0o777 }
}

function sqliteIdentityMatches(path: string, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || !existsSync(path)) return false
  const actual = sqliteFileIdentity(path)
  const value = expected as Record<string, unknown>
  return actual.realpath === value.realpath
    && actual.device === Number(value.device)
    && actual.inode === Number(value.inode)
}

function sqliteHasSidecars(path: string): boolean {
  return existsSync(`${path}-wal`) || existsSync(`${path}-shm`)
}

function sqliteArtifactDigest(path: string): string | null {
  if (!existsSync(path)) return null
  return bootstrapDigest([path, `${path}-wal`, `${path}-shm`].map((candidate) => ({
    suffix: candidate.slice(path.length),
    exists: existsSync(candidate),
    digest: existsSync(candidate) ? bootstrapDigest(readFileSync(candidate)) : null,
  })))
}

function removeSqliteArtifacts(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) rmSync(candidate, { force: true })
}

type DurableArtifactIdentity = {
  path: string
  realpath: string
  device: number
  inode: number
  uid: number
  gid: number
  mode: number
  size: number
  nlink: number
  sha256: string
}

type ConfigurationDesiredRollbackArtifact = {
  schema_version: 'aun-bootstrap-configuration-desired-rollback/v1'
  run_id: string
  agent_id: string
  pre_agent_row: Record<string, unknown>
  post_agent_row: Record<string, unknown>
  pre_outbox_rows: Array<Record<string, unknown>>
  post_outbox_rows: Array<Record<string, unknown>>
  new_event_ids: string[]
}

function configurationDesiredControlledRow(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = jsonRecord(row.metadata)
  return {
    profile_enabled: row.profile_enabled,
    runtime_engine_preference: row.runtime_engine_preference,
    home_directory: row.home_directory,
    canonical_workspace: row.canonical_workspace,
    canonical_home: row.canonical_home,
    channel_port: row.channel_port,
    supervisor_identity: row.supervisor_identity,
    expected_provider_identity: row.expected_provider_identity,
    expected_provider_identity_ref: row.expected_provider_identity_ref,
    provider_token_source_ref: row.provider_token_source_ref,
    ordinary_communication_enrollment: row.ordinary_communication_enrollment,
    ordinary_projection: row.ordinary_projection,
    desired_release_commit: row.desired_release_commit,
    desired_release_tree: row.desired_release_tree,
    desired_control_refs: row.desired_control_refs,
    desired_revision: row.desired_revision,
    desired_digest: row.desired_digest,
    desired_updated_at: row.desired_updated_at,
    desired_updated_by: row.desired_updated_by,
    metadata_codex_home: metadata.codex_home ?? null,
  }
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function durableArtifactIdentity(path: string): DurableArtifactIdentity {
  const link = lstatSync(path)
  if (link.isSymbolicLink() || !link.isFile()) throw new Error('rollback artifact identity invalid')
  const actual = statSync(path)
  if ((actual.mode & 0o777) !== 0o600 || actual.nlink !== 1) throw new Error('rollback artifact permissions invalid')
  return {
    path,
    realpath: realpathSync(path),
    device: Number(actual.dev),
    inode: Number(actual.ino),
    uid: Number(actual.uid),
    gid: Number(actual.gid),
    mode: actual.mode & 0o777,
    size: actual.size,
    nlink: actual.nlink,
    sha256: sha256Bytes(readFileSync(path)),
  }
}

function sameDurableArtifactIdentity(actual: DurableArtifactIdentity, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return false
  const value = expected as Record<string, unknown>
  return actual.path === value.path
    && actual.realpath === value.realpath
    && actual.device === Number(value.device)
    && actual.inode === Number(value.inode)
    && actual.uid === Number(value.uid)
    && actual.gid === Number(value.gid)
    && actual.mode === Number(value.mode)
    && actual.size === Number(value.size)
    && actual.nlink === Number(value.nlink)
    && actual.sha256 === value.sha256
}

function configurationDesiredArtifactPath(home: string, env: Record<string, string>, agentId: string, runId: string): string {
  return join(bootstrapStateRoot(home, env), validateBootstrapAgentId(agentId), `${runId}.configuration-desired.rollback.json`)
}

function writeConfigurationDesiredArtifact(
  home: string,
  env: Record<string, string>,
  artifact: ConfigurationDesiredRollbackArtifact,
): DurableArtifactIdentity {
  const path = configurationDesiredArtifactPath(home, env, artifact.agent_id, artifact.run_id)
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const dirIdentity = lstatSync(dir)
  if (dirIdentity.isSymbolicLink() || !dirIdentity.isDirectory()) throw new Error('rollback artifact directory invalid')
  const body = Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8')
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, body)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, 0o600)
  fsyncDirectory(dir)
  return durableArtifactIdentity(path)
}

function readConfigurationDesiredArtifact(
  identity: unknown,
  digest: unknown,
): { artifact: ConfigurationDesiredRollbackArtifact; identity: DurableArtifactIdentity } {
  if (!identity || typeof identity !== 'object') throw new Error('rollback artifact identity absent')
  const path = String((identity as Record<string, unknown>).path ?? '')
  if (!isAbsolute(path) || !existsSync(path)) throw new Error('rollback artifact absent')
  const actualIdentity = durableArtifactIdentity(path)
  if (!sameDurableArtifactIdentity(actualIdentity, identity)) throw new Error('rollback artifact identity drift')
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as ConfigurationDesiredRollbackArtifact
  if (artifact.schema_version !== 'aun-bootstrap-configuration-desired-rollback/v1'
    || bootstrapDigest(artifact) !== digest) throw new Error('rollback artifact digest mismatch')
  return { artifact, identity: actualIdentity }
}

function removeConfigurationDesiredArtifact(identity: DurableArtifactIdentity): void {
  const actual = durableArtifactIdentity(identity.path)
  if (!sameDurableArtifactIdentity(actual, identity)) throw new Error('rollback artifact removal fence mismatch')
  rmSync(identity.path)
  fsyncDirectory(dirname(identity.path))
}

function initialState(input: {
  runId: string
  agentId: string
  runtime: BootstrapOptions['runtime']
  inputDigest: string
  repoRoot: string
  workspaceRoot: string
  repoHead: string | null
}): BootstrapRunState {
  const timestamp = nowIso()
  return {
    schema_version: 'shirube-v3/aun-bootstrap-run/v1',
    run_id: input.runId,
    agent_id: input.agentId,
    requested_runtime: input.runtime,
    resolved_runtime: null,
    input_digest: input.inputDigest,
    repo_root: input.repoRoot,
    workspace_root: input.workspaceRoot,
    repo_head: input.repoHead,
    created_at: timestamp,
    updated_at: timestamp,
    terminal_status: null,
    lock_release_authorized_at: null,
    lock_released_at: null,
    stages: BOOTSTRAP_STAGES.map((stage) => ({
      stage,
      status: 'pending',
      started_at: null,
      completed_at: null,
      reason_codes: [],
      evidence_refs: [],
      readiness_predicates: {},
      readback_digest: null,
      seal_digest: null,
    })),
    mutations: [],
    mutation_manifest_digest: bootstrapDigest([]),
    readback_bindings: null,
    evidence_refs: [],
    safe_D1_readback: { ...BOOTSTRAP_SAFE_D1_DEFAULTS },
  }
}

function stageSealDigest(state: BootstrapRunState, stage: BootstrapStage): string {
  const record = state.stages.find((candidate) => candidate.stage === stage)
  if (!record) return bootstrapDigest({ missing_stage: stage })
  return bootstrapDigest({
    stage: record.stage,
    status: record.status,
    started_at: record.started_at,
    completed_at: record.completed_at,
    reason_codes: record.reason_codes,
    evidence_refs: record.evidence_refs,
    readiness_predicates: record.readiness_predicates,
    readback_digest: record.readback_digest,
    mutations: state.mutations
      .filter((mutation) => mutation.stage === stage)
      .map((mutation) => ({
        mutation_id: mutation.mutation_id,
        kind: mutation.kind,
        owner_key: mutation.owner_key,
        before_digest: mutation.before_digest,
        intended_after_digest: mutation.intended_after_digest,
        actual_after_digest: mutation.actual_after_digest,
        rollback_action: mutation.rollback_action,
        rollback_status: mutation.rollback_status,
        rollback_payload: mutation.rollback_payload ?? null,
      })),
  })
}

function passedStageSealsAreValid(state: BootstrapRunState): boolean {
  return state.stages.every((record) => record.status !== 'passed'
    || (typeof record.readback_digest === 'string'
      && record.readback_digest.length > 0
      && typeof record.seal_digest === 'string'
      && record.seal_digest === stageSealDigest(state, record.stage)))
}

function outcomeReadbackDigest(outcome: BootstrapStageOutcome): string {
  return outcome.readbackDigest ?? bootstrapDigest({
    ok: outcome.ok,
    reason_codes: outcome.reasonCodes ?? [],
    evidence_refs: outcome.evidenceRefs ?? [],
    readiness_predicates: outcome.readinessPredicates ?? {},
    resolved_runtime: outcome.resolvedRuntime ?? null,
    mutation_actual_after_digest: outcome.mutation?.actual_after_digest ?? null,
    mutation_actual_after_digests: outcome.mutations?.map((mutation) => mutation.actual_after_digest) ?? [],
  })
}

function resultFromState(
  state: BootstrapRunState,
  stage: BootstrapStage,
  status: BootstrapResult['status'],
  reasonCodes: BootstrapReasonCode[],
): BootstrapResult {
  const readinessPredicates = Object.assign({}, ...state.stages.map((record) => record.readiness_predicates))
  const blocking = status === 'NO_GO' || status === 'PARTIAL_ROLLBACK_NO_GO'
  return {
    schema_version: 'shirube-v3/aun-bootstrap-result/v1',
    run_id: state.run_id,
    agent_id: state.agent_id,
    requested_runtime: state.requested_runtime,
    resolved_runtime: state.resolved_runtime,
    stage,
    status,
    reason_codes: reasonCodes,
    mutation_manifest_sha256: bootstrapDigest(state.mutations),
    rollback_manifest_sha256: bootstrapDigest(state.mutations.map((mutation) => ({
      mutation_id: mutation.mutation_id,
      rollback_action: mutation.rollback_action,
      rollback_status: mutation.rollback_status,
    }))),
    readiness_predicates: readinessPredicates,
    evidence_refs: [...new Set([...state.evidence_refs, ...state.stages.flatMap((record) => record.evidence_refs)])],
    safe_D1_readback: state.safe_D1_readback,
    next_action: blocking
      ? {
          blocking: true,
          actor_agent_id: state.agent_id,
          action: `Resolve ${reasonCodes.join(', ') || 'the failed bootstrap predicate'}; this failed run is terminal, so start one new bootstrap run only after rollback is verified.`,
          deliver_via: `aun bootstrap --agent-id ${state.agent_id} --runtime ${state.resolved_runtime ?? state.requested_runtime} --json`,
          exact_input_refs: [state.run_id, state.input_digest],
        }
      : {
          blocking: false,
          actor_agent_id: null,
          action: status === 'PLANNED' ? 'Review the plan, then run the same command without --dry-run.' : 'none',
          deliver_via: 'none',
          exact_input_refs: [state.run_id, state.input_digest],
        },
  }
}

async function withDeadline(
  stage: BootstrapStage,
  task: (signal: AbortSignal) => Promise<BootstrapStageOutcome>,
  remainingTotalMs = Number.POSITIVE_INFINITY,
  stageDeadlineMs = STAGE_DEADLINE_MS[stage],
): Promise<BootstrapStageOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`bootstrap stage deadline exceeded: ${stage}`))
  }, Math.max(1, Math.min(stageDeadlineMs, remainingTotalMs)))
  try {
    const outcome = await task(controller.signal)
    return timedOut
      ? {
          ...outcome,
          ok: false,
          reasonCodes: [outcome.mutation || (outcome.mutations?.length ?? 0) > 0
            ? 'NO_GO_POST_MUTATION_READBACK'
            : 'NO_GO_STAGE_TIMEOUT'],
          evidenceRefs: [...(outcome.evidenceRefs ?? []), `stage-timeout-after-close:${stage}`],
        }
      : outcome
  } catch (err) {
    return timedOut
      ? { ok: false, reasonCodes: ['NO_GO_STAGE_TIMEOUT'] }
      : { ok: false, reasonCodes: ['NO_GO_CHILD_EXIT_UNCONFIRMED'], evidenceRefs: [`stage-error:${bootstrapDigest(String(err))}`] }
  } finally {
    clearTimeout(timer)
  }
}

function findRepoHead(repoRoot: string, run: BootstrapAdapterCommandRunner, env: Record<string, string>): Promise<string | null> {
  return run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, env, timeoutMs: 10_000 })
    .then((result) => result.exitCode === 0 ? result.stdout.trim() || null : null)
}

function defaultCommandRunner(): BootstrapAdapterCommandRunner {
  return (command, args, options) => new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    let finished = false
    let requestedExitCode: number | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: BootstrapCommandResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const terminate = (reason: string) => {
      if (finished || requestedExitCode !== null) return
      requestedExitCode = 124
      child.kill('SIGTERM')
      stderr += `\n${reason}`
      killTimer = setTimeout(() => { if (!finished) child.kill('SIGKILL') }, 5_000)
    }
    const abort = () => terminate('command aborted by bootstrap stage deadline')
    const timer = setTimeout(() => terminate('command timed out'), options.timeoutMs)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', (err) => finish({ exitCode: 127, stdout, stderr: err.message, pid: child.pid }))
    child.on('close', (code) => finish({ exitCode: requestedExitCode ?? code ?? 1, stdout, stderr, pid: child.pid }))
  })
}

function realpathOrResolve(path: string): string {
  if (path && !path.includes('/')) return Bun.which(path) ?? path
  try { return realpathSync(path) } catch { return resolve(path) }
}

async function providerInputSnapshot(input: {
  requestedRuntime: BootstrapOptions['runtime']
  repoRoot: string
  home: string
  env: Record<string, string>
  run: BootstrapAdapterCommandRunner
}): Promise<Record<string, unknown>> {
  const runtimes: BootstrapResolvedRuntime[] = input.requestedRuntime === 'auto'
    ? ['codex', 'claude']
    : [input.requestedRuntime]
  const entries = await Promise.all(runtimes.map(async (runtime) => {
    const executable = realpathOrResolve(Bun.which(runtime) ?? runtime)
    const version = await input.run(runtime, ['--version'], {
      cwd: input.repoRoot, env: input.env, timeoutMs: 10_000,
    })
    const wasurezu = await input.run(runtime, runtime === 'codex'
      ? ['mcp', 'get', 'wasurezu', '--json']
      : ['mcp', 'get', 'wasurezu'], {
      cwd: input.repoRoot, env: input.env, timeoutMs: 30_000,
    })
    let wasurezuReadback: unknown = { exit_code: wasurezu.exitCode }
    if (wasurezu.exitCode === 0) {
      try {
        wasurezuReadback = JSON.parse(wasurezu.stdout)
      } catch {
        throw new Error('NO_GO_PROVIDER_NATIVE_JSON_INVALID')
      }
    }
    return {
      runtime,
      executable,
      version_exit: version.exitCode,
      version_digest: bootstrapDigest({ stdout: version.stdout.trim(), stderr: version.stderr.trim() }),
      config_scope: runtime === 'claude' ? 'user' : 'native-default',
      config_root_digest: bootstrapDigest(runtime === 'codex'
        ? input.env.CODEX_HOME || join(input.home, '.codex')
        : input.env.CLAUDE_CONFIG_DIR || join(input.home, '.claude')),
      wasurezu_native_exit: wasurezu.exitCode,
      wasurezu_native_readback_digest: bootstrapDigest(wasurezuReadback),
    }
  }))
  return Object.fromEntries(entries.map((entry) => [entry.runtime, entry]))
}

function bootstrapInputDigest(input: {
  agentId: string
  requestedRuntime: BootstrapOptions['runtime']
  repoRoot: string
  workspaceRoot: string
  repoHead: string | null
  home: string
  env: Record<string, string>
  providerSnapshot: Record<string, unknown>
}): string {
  const databaseBackend = input.env.AGENT_COM_DB?.trim().toLowerCase()
    || (input.env.DATABASE_URL ? 'postgres' : 'sqlite')
  return bootstrapDigest({
    agent_id: input.agentId,
    requested_runtime: input.requestedRuntime,
    repo_root: realpathOrResolve(input.repoRoot),
    workspace_root: realpathOrResolve(input.workspaceRoot),
    repo_head: input.repoHead,
    home: realpathOrResolve(input.home),
    aun_state_root: bootstrapStateRoot(input.home, input.env),
    database_backend: databaseBackend,
    database_endpoint_digest: bootstrapDigest(input.env.DATABASE_URL || input.env.AGENT_COM_SQLITE_PATH || join(input.repoRoot, 'agent-com.db')),
    requested_port: input.env.AUN_WEBHOOK_PORT || input.env.AUN_BOOTSTRAP_CHANNEL_PORT || null,
    tmux_authority: Object.prototype.hasOwnProperty.call(input.env, 'AUN_BOOTSTRAP_TMUX_SESSION')
      || Object.prototype.hasOwnProperty.call(input.env, 'AUN_BOOTSTRAP_TMUX_PANE')
      ? {
          source: 'explicit-target',
          session: input.env.AUN_BOOTSTRAP_TMUX_SESSION || null,
          pane: input.env.AUN_BOOTSTRAP_TMUX_PANE || null,
        }
      : {
          source: 'caller-context',
          tmux: input.env.TMUX || null,
          pane: input.env.TMUX_PANE || null,
        },
    memory_project: input.env.AGENT_MEMORY_PROJECT || input.env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(input.workspaceRoot),
    provider_snapshot: input.providerSnapshot,
    intended_aun_tuple_template_digest: bootstrapDigest({
      command: realpathOrResolve(process.execPath),
      argv: ['run', '--cwd', realpathOrResolve(input.repoRoot), 'server.ts'],
      agent_id: input.agentId,
      database_backend: databaseBackend,
      database_endpoint_digest: bootstrapDigest(input.env.DATABASE_URL || input.env.AGENT_COM_SQLITE_PATH || join(input.repoRoot, 'agent-com.db')),
      requested_port: input.env.AUN_WEBHOOK_PORT || input.env.AUN_BOOTSTRAP_CHANNEL_PORT || '<B3-selected>',
      config_scope: 'user',
    }),
    safe_d1: BOOTSTRAP_SAFE_D1_DEFAULTS,
  })
}

async function withBootstrapDb<T>(
  env: Record<string, string>,
  fn: (db: DbAdapter) => Promise<T>,
  options: { readonly?: boolean } = {},
): Promise<T> {
  const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
  const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
  const db: DbAdapter = postgres
    ? new PgAdapter(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp')
    : new SqliteAdapter(env.AGENT_COM_SQLITE_PATH, options.readonly ? { readonly: true, create: false } : {})
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

type ProviderRootAuthority = NonNullable<BootstrapStageContext['providerRootAuthority']>

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function providerRootAuthorityTupleDigest(agentId: string, row: Record<string, unknown>): string {
  const metadata = jsonRecord(row.metadata)
  const projection = jsonRecord(row.ordinary_projection)
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

async function resolveProviderRootAuthority(input: {
  agentId: string
  requestedRuntime: BootstrapOptions['runtime']
  env: Record<string, string>
  home: string
  repoRoot: string
}): Promise<{
  ok: true
  authority: ProviderRootAuthority | null
} | {
  ok: false
  reasonCode: BootstrapReasonCode
  evidenceRef: string
}> {
  const canonicalHome = existsSync(input.home) ? realpathSync(input.home) : resolve(input.home)
  const cleanRoot = join(canonicalHome, '.codex')
  const cleanAuthority = (): ProviderRootAuthority => ({
    existingTarget: false,
    canonicalSourceField: 'clean_host_default',
    canonicalRoot: cleanRoot,
    canonicalRootDigest: bootstrapDigest(cleanRoot),
    canonicalRealpathDigest: bootstrapDigest(existsSync(cleanRoot) ? realpathSync(cleanRoot) : cleanRoot),
    projectionMatches: true,
    callerMismatch: Boolean(input.env.CODEX_HOME && resolve(input.env.CODEX_HOME) !== cleanRoot),
    authorityTupleDigest: bootstrapDigest({
      agent_id: input.agentId,
      repo_url: null,
      workspace_path: null,
      config_profile: { runtime_engine_preference: null, metadata_codex_home: null },
      provider_binding: {
        expected_provider_identity_ref: null,
        provider_token_source_ref: null,
        projection_provider_config_root: null,
      },
      projection_digest: bootstrapDigest({}),
    }),
  })
  if (input.requestedRuntime === 'claude') return { ok: true, authority: null }

  const explicit = input.env.AGENT_COM_DB?.trim().toLowerCase()
  const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(input.env.DATABASE_URL))
  // Generation-2 desired-state root authority is a PostgreSQL SSOT surface.
  // SQLite bootstrap remains clean-host/local mode and cannot emulate the
  // ordinary_projection equality fence.
  if (!postgres) return { ok: true, authority: cleanAuthority() }

  let row: Record<string, unknown> | null
  try {
    row = await withBootstrapDb(input.env, (db) => db.queryOne<Record<string, unknown>>(
      `SELECT a.agent_id, a.metadata, a.runtime_engine_preference, a.home_directory,
              a.provider_token_source_ref,
              to_jsonb(a)->'canonical_workspace' AS canonical_workspace,
              to_jsonb(a)->'expected_provider_identity_ref' AS expected_provider_identity_ref,
              to_jsonb(a)->'ordinary_projection' AS ordinary_projection,
              workspace.repo_url, workspace.local_path AS workspace_path
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
      [input.agentId],
    ), { readonly: true })
  } catch {
    return {
      ok: false,
      reasonCode: 'NO_GO_DB_CONNECT',
      evidenceRef: `provider-root-db-readback:${bootstrapDigest({ agent_id: input.agentId, database: 'unavailable' })}`,
    }
  }
  if (!row) return { ok: true, authority: cleanAuthority() }
  const runtime = String(row.runtime_engine_preference ?? '').toLowerCase()
  if (input.requestedRuntime === 'auto' && runtime !== 'codex') return { ok: true, authority: null }

  const metadata = jsonRecord(row.metadata)
  const projection = jsonRecord(row.ordinary_projection)
  const rawRoot = typeof metadata.codex_home === 'string' ? metadata.codex_home : ''
  if (!rawRoot || !isAbsolute(rawRoot) || normalize(rawRoot) !== rawRoot || resolve(rawRoot) !== rawRoot) {
    return {
      ok: false,
      reasonCode: 'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING',
      evidenceRef: `provider-root-authority:${bootstrapDigest({
        source: 'metadata.codex_home', present: Boolean(rawRoot), absolute: isAbsolute(rawRoot || '.'), normalized: false,
      })}`,
    }
  }
  let canonicalRealpath = ''
  try {
    const link = lstatSync(rawRoot)
    canonicalRealpath = realpathSync(rawRoot)
    if (link.isSymbolicLink() || !link.isDirectory() || canonicalRealpath !== rawRoot) throw new Error('invalid root')
  } catch {
    return {
      ok: false,
      reasonCode: 'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING',
      evidenceRef: `provider-root-authority:${bootstrapDigest({ source: 'metadata.codex_home', valid_identity: false })}`,
    }
  }
  const projectedRoot = typeof projection.provider_config_root === 'string'
    ? projection.provider_config_root
    : ''
  if (!projectedRoot || projectedRoot !== rawRoot) {
    return {
      ok: false,
      reasonCode: 'NO_GO_PROVIDER_ROOT_CONFLICT',
      evidenceRef: `provider-root-conflict:${bootstrapDigest({
        canonical_root_digest: bootstrapDigest(rawRoot),
        projection_present: Boolean(projectedRoot),
        projection_matches: false,
      })}`,
    }
  }
  return {
    ok: true,
    authority: {
      existingTarget: true,
      canonicalSourceField: 'metadata.codex_home',
      canonicalRoot: rawRoot,
      canonicalRootDigest: bootstrapDigest(rawRoot),
      canonicalRealpathDigest: bootstrapDigest(canonicalRealpath),
      projectionMatches: true,
      callerMismatch: Boolean(input.env.CODEX_HOME && resolve(input.env.CODEX_HOME) !== rawRoot),
      authorityTupleDigest: providerRootAuthorityTupleDigest(input.agentId, row),
    },
  }
}

function profileRuntimeSignal(profile: any): BootstrapRuntimeSignal | null {
  const raw = String(profile?.runtime_engine_preference ?? '').toLowerCase()
  const fallback = String(profile?.runtime ?? '').toLowerCase()
  const runtime = raw.includes('codex') || fallback.includes('codex')
    ? 'codex'
    : raw.includes('claude') || fallback.includes('claude')
      ? 'claude'
      : null
  return runtime ? { source: 'agent_profile', runtime, verified: true, evidence: `profile_revision:${profile.profile_revision ?? 'unknown'}` } : null
}

async function processRuntimeSignals(
  run: BootstrapAdapterCommandRunner,
  repoRoot: string,
  env: Record<string, string>,
  assignProviderPid = true,
): Promise<BootstrapRuntimeSignal[]> {
  const signals: BootstrapRuntimeSignal[] = []
  let pid = process.ppid
  const seen = new Set<number>()
  for (let depth = 0; depth < 8 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid)
    const result = await run('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], { cwd: repoRoot, env, timeoutMs: 5_000 })
    if (result.exitCode !== 0) break
    const line = result.stdout.trim()
    const match = line.match(/^(\d+)\s+([\s\S]+)$/)
    if (!match) break
    const runtime = commandRuntime(match[2])
    if (runtime) {
      signals.push({ source: 'process_identity', runtime, verified: true, evidence: `ancestor_pid:${pid}` })
      if (assignProviderPid) env.AUN_BOOTSTRAP_PROVIDER_PID = String(pid)
    }
    pid = Number(match[1])
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
    signals.push({ source: 'process_identity', runtime: 'codex', verified: true, evidence: 'codex_runtime_env' })
    if (assignProviderPid) env.AUN_BOOTSTRAP_PROVIDER_PID ||= String(process.ppid)
  }
  if (env.CLAUDECODE === '1') {
    signals.push({ source: 'process_identity', runtime: 'claude', verified: true, evidence: 'claude_runtime_env' })
    if (assignProviderPid) env.AUN_BOOTSTRAP_PROVIDER_PID ||= String(process.ppid)
  }
  return signals.filter((signal, index, all) => all.findIndex((candidate) => candidate.source === signal.source && candidate.runtime === signal.runtime) === index)
}

type TargetRuntimeAuthority = {
  ok: true
  signals: BootstrapRuntimeSignal[]
  providerPids: Partial<Record<BootstrapResolvedRuntime, number>>
  evidenceRef: string
} | {
  ok: false
  discriminator: 'target_identity_mismatch' | 'target_process_read_failure' | 'target_process_unresolved' | 'target_process_ambiguous'
  evidenceRef: string
}

function commandRuntime(command: string): BootstrapResolvedRuntime | null {
  const executableMatch = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const executable = executableMatch?.[1] ?? executableMatch?.[2] ?? executableMatch?.[3]
  const basename = executable?.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  if (basename === 'codex' || basename === 'codex.exe') return 'codex'
  if (basename === 'claude' || basename === 'claude.exe') return 'claude'
  return null
}

async function resolveExplicitTargetRuntimeAuthority(input: {
  run: BootstrapAdapterCommandRunner
  context: BootstrapStageContext
  repoRoot: string
  env: Record<string, string>
  session: string
  pane: string
}): Promise<TargetRuntimeAuthority> {
  const validSession = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.session)
  const validPane = /^%[0-9]+$/.test(input.pane)
  if (!validSession || !validPane) {
    return {
      ok: false,
      discriminator: 'target_identity_mismatch',
      evidenceRef: `runtime-authority:target_identity_mismatch:${bootstrapDigest({ valid_session: validSession, valid_pane: validPane })}`,
    }
  }
  const options = { cwd: input.repoRoot, env: input.env, timeoutMs: 10_000, signal: input.context.abortSignal }
  const sessionExists = await input.run('tmux', ['has-session', '-t', `=${input.session}`], options)
  const paneSession = await input.run('tmux', ['display-message', '-p', '-t', input.pane, '#S'], options)
  const paneIdentity = await input.run('tmux', ['display-message', '-p', '-t', input.pane, '#{pane_id}'], options)
  const panePidResult = await input.run('tmux', ['display-message', '-p', '-t', input.pane, '#{pane_pid}'], options)
  const panePid = Number(panePidResult.stdout.trim())
  const identityEvidence = {
    session_digest: bootstrapDigest(input.session),
    pane_digest: bootstrapDigest(input.pane),
    session_exists_exit: sessionExists.exitCode,
    pane_session_exit: paneSession.exitCode,
    pane_session_match: paneSession.stdout.trim() === input.session,
    pane_identity_exit: paneIdentity.exitCode,
    pane_identity_match: paneIdentity.stdout.trim() === input.pane,
    pane_pid_exit: panePidResult.exitCode,
    pane_pid_valid: Number.isInteger(panePid) && panePid > 1,
  }
  if (sessionExists.exitCode !== 0 || paneSession.exitCode !== 0 || !identityEvidence.pane_session_match
    || paneIdentity.exitCode !== 0 || !identityEvidence.pane_identity_match
    || panePidResult.exitCode !== 0 || !identityEvidence.pane_pid_valid) {
    return {
      ok: false,
      discriminator: 'target_identity_mismatch',
      evidenceRef: `runtime-authority:target_identity_mismatch:${bootstrapDigest(identityEvidence)}`,
    }
  }

  const processTable = await input.run('ps', ['-axo', 'pid=,ppid=,command='], options)
  if (processTable.exitCode !== 0) {
    return {
      ok: false,
      discriminator: 'target_process_read_failure',
      evidenceRef: `runtime-authority:target_process_read_failure:${bootstrapDigest({ ...identityEvidence, process_exit: processTable.exitCode })}`,
    }
  }
  const rows = processTable.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\s\S]+?)\s*$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
  const depths = new Map<number, number>([[panePid, 0]])
  for (let depth = 1; depth < 32; depth++) {
    let added = false
    for (const row of rows) {
      if (depths.has(row.pid)) continue
      const parentDepth = depths.get(row.ppid)
      if (parentDepth === undefined) continue
      depths.set(row.pid, parentDepth + 1)
      added = true
    }
    if (!added) break
  }
  if (!depths.has(panePid) || !rows.some((row) => row.pid === panePid)) {
    return {
      ok: false,
      discriminator: 'target_process_unresolved',
      evidenceRef: `runtime-authority:target_process_unresolved:${bootstrapDigest({ ...identityEvidence, process_table_digest: bootstrapDigest(processTable.stdout) })}`,
    }
  }
  const candidates = rows.flatMap((row) => {
    const depth = depths.get(row.pid)
    const runtime = depth === undefined ? null : commandRuntime(row.command)
    return runtime ? [{ pid: row.pid, depth, runtime }] : []
  })
  const providerPids: Partial<Record<BootstrapResolvedRuntime, number>> = {}
  const signals: BootstrapRuntimeSignal[] = []
  for (const runtime of ['codex', 'claude'] as const) {
    const runtimeCandidates = candidates.filter((candidate) => candidate.runtime === runtime)
    if (runtimeCandidates.length === 0) continue
    const minimumDepth = Math.min(...runtimeCandidates.map((candidate) => candidate.depth))
    const nearest = runtimeCandidates.filter((candidate) => candidate.depth === minimumDepth)
    if (nearest.length !== 1) {
      return {
        ok: false,
        discriminator: 'target_process_ambiguous',
        evidenceRef: `runtime-authority:target_process_ambiguous:${bootstrapDigest({
          ...identityEvidence,
          runtime,
          candidate_count: runtimeCandidates.length,
          nearest_count: nearest.length,
          process_table_digest: bootstrapDigest(processTable.stdout),
        })}`,
      }
    }
    providerPids[runtime] = nearest[0].pid
    signals.push({
      source: 'process_identity',
      runtime,
      verified: true,
      evidence: `target_process_tree:${bootstrapDigest({ pane_pid: panePid, provider_pid: nearest[0].pid, depth: minimumDepth })}`,
    })
  }
  if (signals.length === 0) {
    return {
      ok: false,
      discriminator: 'target_process_unresolved',
      evidenceRef: `runtime-authority:target_process_unresolved:${bootstrapDigest({
        ...identityEvidence,
        descendant_count: depths.size,
        process_table_digest: bootstrapDigest(processTable.stdout),
      })}`,
    }
  }
  return {
    ok: true,
    signals,
    providerPids,
    evidenceRef: `runtime-authority:target_process_verified:${bootstrapDigest({
      ...identityEvidence,
      runtime_count: signals.length,
      authority_digest: bootstrapDigest(providerPids),
      process_table_digest: bootstrapDigest(processTable.stdout),
    })}`,
  }
}

type RuntimeReceiptTuple = {
  agent_id: string
  runtime_engine: BootstrapResolvedRuntime
  session_name: string
  process_id: number
  port: number
  checkout_path: string
  commit_sha: string
}

function expectedRuntimeReceiptTuple(
  context: BootstrapStageContext,
  env: Record<string, string>,
  profile: any,
): RuntimeReceiptTuple | null {
  const sessionName = String(env.AUN_BOOTSTRAP_TMUX_SESSION || profile?.tmux_session || '').trim()
  const port = Number(env.AUN_BOOTSTRAP_CHANNEL_PORT || profile?.channel_port)
  const providerPid = Number(env.AUN_BOOTSTRAP_PROVIDER_PID)
  const runtime = context.resolvedRuntime
  if (!profile || !sessionName || !Number.isInteger(port) || port <= 0
    || !Number.isInteger(providerPid) || providerPid <= 1
    || (runtime !== 'codex' && runtime !== 'claude') || !context.repoHead) return null
  return {
    agent_id: context.agentId,
    runtime_engine: runtime,
    session_name: sessionName,
    process_id: providerPid,
    port,
    checkout_path: realpathOrResolve(context.repoRoot),
    commit_sha: context.repoHead,
  }
}

type RuntimeReceiptDecision = {
  ok: true
  action: 'create' | 'reuse'
  runtimeInstanceId: string | null
  ordinaryActiveCount: number
  bootstrapActiveCount: number
  evidenceDigest: string
} | {
  ok: false
  discriminator: 'runtime_receipt_incompatible' | 'runtime_receipt_ambiguous'
  ordinaryActiveCount: number
  bootstrapActiveCount: number
  evidenceDigest: string
}

function classifyRuntimeReceiptRows(active: any[], tuple: RuntimeReceiptTuple): RuntimeReceiptDecision {
  const bootstrapRows = active.filter((row) => row.runtime_kind === 'bootstrap_bound_provider')
  const ordinaryActiveCount = active.length - bootstrapRows.length
  const matches = bootstrapRows.filter((row) => row.agent_id === tuple.agent_id
    && row.runtime_engine === tuple.runtime_engine
    && row.session_name === tuple.session_name
    && Number(row.process_id) === tuple.process_id
    && Number(row.port) === tuple.port
    && realpathOrResolve(String(row.checkout_path ?? '')) === tuple.checkout_path
    && row.commit_sha === tuple.commit_sha)
  const evidenceDigest = bootstrapDigest({
    tuple_digest: bootstrapDigest(tuple),
    ordinary_active_count: ordinaryActiveCount,
    bootstrap_active_count: bootstrapRows.length,
    compatible_bootstrap_count: matches.length,
    active_rows_digest: bootstrapDigest(active),
  })
  // A memory-ready authority is exactly one active runtime. Creating a
  // bootstrap receipt beside an ordinary active row makes the later gate
  // ambiguous and is therefore rejected before mutation.
  if (ordinaryActiveCount > 0) {
    return {
      ok: false,
      discriminator: active.length > 1 ? 'runtime_receipt_ambiguous' : 'runtime_receipt_incompatible',
      ordinaryActiveCount,
      bootstrapActiveCount: bootstrapRows.length,
      evidenceDigest,
    }
  }
  if (bootstrapRows.length === 0) {
    return { ok: true, action: 'create', runtimeInstanceId: null, ordinaryActiveCount, bootstrapActiveCount: 0, evidenceDigest }
  }
  if (bootstrapRows.length > 1) {
    return {
      ok: false,
      discriminator: 'runtime_receipt_ambiguous',
      ordinaryActiveCount,
      bootstrapActiveCount: bootstrapRows.length,
      evidenceDigest,
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      discriminator: 'runtime_receipt_incompatible',
      ordinaryActiveCount,
      bootstrapActiveCount: bootstrapRows.length,
      evidenceDigest,
    }
  }
  return {
    ok: true,
    action: 'reuse',
    runtimeInstanceId: String(matches[0].runtime_instance_id),
    ordinaryActiveCount,
    bootstrapActiveCount: 1,
    evidenceDigest,
  }
}

type RuntimeMemoryReadyGateInput = Parameters<typeof evaluateRuntimeMemoryReadyGate>[1]

type SelectedMemoryReadySubject = {
  runtimeInstanceId: string
  evidenceId?: string | number | null
}

function isCurrentRuntimeSelection(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim()
  return normalized.includes('FROM agent_runtime_instances')
    && normalized.includes('WHERE agent_id = $1')
    && normalized.includes("status IN ('running', 'active')")
    && normalized.includes('ORDER BY COALESCE(last_seen_at, started_at) DESC, started_at DESC')
    && normalized.endsWith('LIMIT 1')
}

function isCurrentMemoryEvidenceSelection(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim()
  return normalized.includes('FROM runtime_memory_ready_evidence')
    && normalized.includes('WHERE agent_id = $1')
    && normalized.includes('AND project = $2')
    && normalized.includes('ORDER BY completed_at DESC, id DESC')
    && normalized.endsWith('LIMIT 1')
}

async function evaluateSelectedRuntimeMemoryReadyGate(
  db: DbAdapter,
  input: RuntimeMemoryReadyGateInput,
  subject?: SelectedMemoryReadySubject | null,
  expectedTuple?: RuntimeReceiptTuple,
) {
  if (!subject?.runtimeInstanceId) return evaluateRuntimeMemoryReadyGate(db as any, input)

  if (expectedTuple) {
    const selectedRows = await db.query<any>(
      `SELECT runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id,
              port, checkout_path, commit_sha, status, metadata
         FROM agent_runtime_instances
        WHERE runtime_instance_id = $1
          AND agent_id = $2
          AND status IN ('running', 'active')
        LIMIT 1`,
      [subject.runtimeInstanceId, input.agent_id],
    )
    const selection = classifyRuntimeReceiptRows(selectedRows, expectedTuple)
    if (!selection.ok || selection.action !== 'reuse'
      || selection.runtimeInstanceId !== subject.runtimeInstanceId) {
      throw new RuntimeReceiptSelectionError(
        'runtime_receipt_post_evidence_readback',
        selection.evidenceDigest,
      )
    }
  }

  const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
    ...input,
    evidence_id: subject.evidenceId,
  })
  if (gate.runtime_instance_id !== subject.runtimeInstanceId
    || (subject.evidenceId !== undefined && subject.evidenceId !== null
      && String(gate.evidence_id) !== String(subject.evidenceId))) {
    return {
      ...gate,
      ok: false,
      reason: 'runtime_instance_mismatch' as const,
      details: {
        ...gate.details,
        selected_runtime_instance_id: subject.runtimeInstanceId,
        observed_runtime_instance_id: gate.runtime_instance_id,
        selected_evidence_id: subject.evidenceId ?? null,
        observed_evidence_id: gate.evidence_id,
      },
    }
  }
  return gate
}

class RuntimeReceiptSelectionError extends Error {
  constructor(
    readonly discriminator: 'runtime_receipt_incompatible' | 'runtime_receipt_ambiguous'
      | 'runtime_receipt_post_insert_readback' | 'runtime_receipt_post_evidence_readback',
    readonly evidenceDigest: string,
  ) {
    super(discriminator)
    this.name = 'RuntimeReceiptSelectionError'
  }
}

function parseJsonOutput(result: BootstrapCommandResult): any | null {
  if (result.exitCode !== 0) return null
  try { return JSON.parse(result.stdout) } catch { return null }
}

function parseJsonRecord(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  try {
    const parsed = JSON.parse(String(value ?? '{}'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function bootstrapRunIdFromQueuePayload(value: unknown): string | null {
  const parsed = parseJsonRecord(value)
  return typeof parsed.bootstrap_run_id === 'string' ? parsed.bootstrap_run_id : null
}

function executableVersionOk(output: string, minimumMajor: number): boolean {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  return Boolean(match && Number(match[1]) >= minimumMajor)
}

function profilePort(profile: any): number | null {
  const port = Number(profile?.channel_port)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

function managedProfile(profile: any): Record<string, unknown> | null {
  if (!profile) return null
  return {
    runtime: profile.runtime,
    runtime_engine_preference: profile.runtime_engine_preference,
    home_directory: profile.home_directory ? resolve(profile.home_directory) : null,
    channel_port: Number(profile.channel_port),
    tmux_session: profile.tmux_session,
    profile_enabled: profile.profile_enabled,
    profile_revision: profile.profile_revision ?? null,
  }
}

async function choosePort(
  run: BootstrapAdapterCommandRunner,
  context: BootstrapStageContext,
  existing: any,
): Promise<number | null> {
  const explicit = Number(context.env.AUN_WEBHOOK_PORT || context.env.AUN_BOOTSTRAP_CHANNEL_PORT)
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 65535) return explicit
  const prior = profilePort(existing)
  if (prior) return prior
  for (let port = 8801; port <= 8900; port++) {
    const probe = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { cwd: context.repoRoot, env: context.env, timeoutMs: 2_000 })
    if (probe.exitCode !== 0 || probe.stdout.trim() === '') return port
  }
  return null
}

function safeD1FromPlist(home: string): typeof BOOTSTRAP_SAFE_D1_DEFAULTS | null {
  const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
  if (!existsSync(plistPath)) return null
  try {
    const config = parseStateDaemonLaunchAgentPlist(readFileSync(plistPath, 'utf8'))
    const env = config.environmentVariables
    const readback = {
      SHIRUBE_D1_ENABLED: env.SHIRUBE_D1_ENABLED,
      SHIRUBE_D1_KILL_SWITCH: env.SHIRUBE_D1_KILL_SWITCH,
      SHIRUBE_D1_TARGET_ALLOWLIST: env.SHIRUBE_D1_TARGET_ALLOWLIST,
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: env.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED,
    }
    return bootstrapDigest(readback) === bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)
      ? { ...BOOTSTRAP_SAFE_D1_DEFAULTS }
      : null
  } catch {
    return null
  }
}

type ConfiguredMcpTransport = {
  command: string
  args: string[]
  env: Record<string, string>
  tupleDigest: string
}

function stringEnvironment(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, item]) => typeof item !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

async function readConfiguredWasurezuTransport(
  context: BootstrapStageContext,
  run: BootstrapAdapterCommandRunner,
): Promise<ConfiguredMcpTransport | null> {
  if (context.resolvedRuntime === 'codex') {
    const result = await run('codex', ['mcp', 'get', 'wasurezu', '--json'], {
      cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal,
    })
    const parsed = parseJsonOutput(result)
    const transport = parsed?.transport
    const environment = stringEnvironment(transport?.env) ?? {}
    if (result.exitCode !== 0 || parsed?.enabled !== true || transport?.type !== 'stdio'
      || typeof transport?.command !== 'string' || !Array.isArray(transport?.args)
      || transport.args.some((item: unknown) => typeof item !== 'string')) return null
    const tuple = { command: realpathOrResolve(transport.command), args: transport.args, env: environment }
    return { ...tuple, tupleDigest: bootstrapDigest(tuple) }
  }
  if (context.resolvedRuntime === 'claude') {
    const result = await run('claude', ['mcp', 'get', 'wasurezu'], {
      cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal,
    })
    const parsed = parseClaudeMcpGet(result.stdout)
    if (result.exitCode !== 0 || !parsed || parsed.type.toLowerCase() !== 'stdio'
      || !/(?:connected|✔\s*connected|✓\s*connected)/i.test(parsed.status)) return null
    const tuple = { command: realpathOrResolve(parsed.command), args: parsed.args, env: parsed.environment }
    return { ...tuple, tupleDigest: bootstrapDigest(tuple) }
  }
  return null
}

type McpRecoveryReceipt = {
  responseDigest: string
  toolCount: number
  contentCount: number
  startedAt: string
  completedAt: string
}

async function runStdioMcpRecovery(
  transport: ConfiguredMcpTransport,
  project: string,
  context: BootstrapStageContext,
): Promise<McpRecoveryReceipt> {
  const startedAt = nowIso()
  return new Promise((resolveReceipt, rejectReceipt) => {
    const child = spawn(transport.command, transport.args, {
      cwd: context.repoRoot,
      env: { ...context.env, ...transport.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let toolCount = 0
    let phase: 0 | 1 | 2 = 0
    let settled = false
    let closing = false
    let receipt: McpRecoveryReceipt | null = null
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const shutdown = () => {
      if (closing) return
      closing = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 5_000)
    }
    const fail = (err: Error) => {
      if (settled) return
      receipt = null
      stderr = `${stderr}\n${err.message}`
      shutdown()
    }
    const configuredDeadline = Number(context.env.AUN_BOOTSTRAP_MCP_RECOVERY_TIMEOUT_MS)
    const deadlineMs = Number.isFinite(configuredDeadline) && configuredDeadline > 0
      ? Math.min(configuredDeadline, 30_000)
      : 30_000
    const timer = setTimeout(() => fail(new Error('Wasurezu MCP recovery timed out')), deadlineMs)
    const abort = () => fail(new Error('Wasurezu MCP recovery aborted'))
    context.abortSignal?.addEventListener('abort', abort, { once: true })
    if (context.abortSignal?.aborted) abort()
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message: any
        try { message = JSON.parse(line) } catch { fail(new Error('Wasurezu MCP emitted non-JSON stdout')); return }
        if (message.id === 1) {
          if (phase !== 0 || message.error || !message.result) { fail(new Error('Wasurezu MCP initialize failed')); return }
          phase = 1
          write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        } else if (message.id === 2) {
          const tools = message.result?.tools
          if (phase !== 1 || message.error || !Array.isArray(tools)) { fail(new Error('Wasurezu MCP tools/list failed')); return }
          phase = 2
          toolCount = tools.length
          const recover = tools.find((tool: any) => tool?.name === 'recover_context')
          if (!recover) { fail(new Error('Wasurezu MCP recover_context tool missing')); return }
          write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recover_context', arguments: { project } } })
        } else if (message.id === 3) {
          const content = message.result?.content
          const serialized = JSON.stringify(content ?? [])
          if (phase !== 2 || message.error || message.result?.isError === true || !Array.isArray(content) || content.length === 0
            || !serialized.includes(project)) {
            fail(new Error('Wasurezu MCP recover_context evidence mismatch'))
            return
          }
          receipt = {
            responseDigest: bootstrapDigest(message.result),
            toolCount,
            contentCount: content.length,
            startedAt,
            completedAt: nowIso(),
          }
          shutdown()
        }
      }
    })
    write({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'aun-bootstrap', version: '1' } },
    })
    child.on('error', (err) => fail(err))
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      context.abortSignal?.removeEventListener('abort', abort)
      if (receipt) resolveReceipt(receipt)
      else rejectReceipt(new Error(`Wasurezu MCP recovery failed:${bootstrapDigest(stderr)}`))
    })
  })
}

type DefaultPortsOptions = {
  run: BootstrapAdapterCommandRunner
  env: Record<string, string>
  home: string
  repoRoot: string
}

function createDefaultPorts(options: DefaultPortsOptions): BootstrapExecutionPorts {
  const { run, env, home, repoRoot } = options
  const explicitTmuxSessionProvided = Object.prototype.hasOwnProperty.call(env, 'AUN_BOOTSTRAP_TMUX_SESSION')
  const explicitTmuxPaneProvided = Object.prototype.hasOwnProperty.call(env, 'AUN_BOOTSTRAP_TMUX_PANE')
  const explicitTmuxSession = env.AUN_BOOTSTRAP_TMUX_SESSION?.trim() ?? ''
  const explicitTmuxPane = env.AUN_BOOTSTRAP_TMUX_PANE?.trim() ?? ''
  const bunPath = process.execPath
  const adapterDeps = { run, bunPath, serverEntry: 'server.ts' }
  const adapters: Record<BootstrapResolvedRuntime, BootstrapRuntimeAdapter> = {
    codex: createCodexBootstrapAdapter(adapterDeps),
    claude: createClaudeBootstrapAdapter(adapterDeps),
  }
  let profileBefore: any = null
  let queueSmokeEvidence: Awaited<ReturnType<typeof observeBootstrapQueueSmoke>> | null = null
  const commandOptions = (context: BootstrapStageContext, timeoutMs: number) => ({
    cwd: repoRoot, env, timeoutMs, signal: context.abortSignal,
  })
  const daemonLabel = STATE_DAEMON_PLIST_NAME.replace(/\.plist$/, '')
  const daemonDomain = `gui/${process.getuid?.() ?? ''}`
  type DaemonNativeState = {
    plist_exists: boolean
    plist_digest: string | null
    plist_mode: number | null
    launch_domain: string
    launch_label: string
    launch_loaded: boolean
    launch_pid: number | null
    safe_d1_digest: string | null
    launch_safe_d1_digest: string | null
  }
  const readDaemonNativeState = async (context: BootstrapStageContext): Promise<DaemonNativeState> => {
    const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    const launch = await run('launchctl', ['print', `${daemonDomain}/${daemonLabel}`], commandOptions(context, 30_000))
    const pidMatch = launch.stdout.match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/i)
    const launchSafeEntries = Object.keys(BOOTSTRAP_SAFE_D1_DEFAULTS).map((key) => {
      const match = launch.stdout.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*(?:=>|=)\\s*"?([^"\\n]+?)"?\\s*(?:\\n|$)`))
      return [key, match?.[1]?.trim() ?? null] as const
    })
    const launchSafe = launchSafeEntries.every(([, value]) => value !== null)
      ? Object.fromEntries(launchSafeEntries) as Record<string, string>
      : null
    return {
      plist_exists: existsSync(plistPath),
      plist_digest: existsSync(plistPath) ? bootstrapDigest(readFileSync(plistPath)) : null,
      plist_mode: existsSync(plistPath) ? statSync(plistPath).mode & 0o777 : null,
      launch_domain: daemonDomain,
      launch_label: daemonLabel,
      launch_loaded: launch.exitCode === 0,
      launch_pid: launch.exitCode === 0 && pidMatch ? Number(pidMatch[1]) : null,
      safe_d1_digest: safeD1FromPlist(home) ? bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS) : null,
      launch_safe_d1_digest: launch.exitCode === 0 && bootstrapDigest(launchSafe) === bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)
        ? bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)
        : null,
    }
  }

  const databaseAlreadyExists = (): boolean => {
    const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
    if (explicit === 'postgres' || explicit === 'postgresql' || (!explicit && env.DATABASE_URL)) return true
    return existsSync(resolve(env.AGENT_COM_SQLITE_PATH || join(repoRoot, 'agent-com.db')))
  }

  const adapterFor = (context: BootstrapStageContext): BootstrapRuntimeAdapter | null =>
    context.resolvedRuntime ? adapters[context.resolvedRuntime] : null

  const profileGet = async (agentId: string): Promise<any | null> => {
    const result = await run(bunPath, ['cli/index.ts', 'agent', 'profile', 'get', agentId], { cwd: repoRoot, env, timeoutMs: 30_000 })
    return parseJsonOutput(result)?.profile ?? null
  }

  type WorkspaceAuthorityRuntimeLink = {
    runtime_instance_id: string
    agent_id: string
    workspace_id: string | null
  }
  type WorkspaceAuthorityBinding = {
    agent_id: string
    workspace_id: string
    binding_role: string
    active: boolean
    created_at: string | null
    updated_at: string | null
  }
  const normalizedTimestamp = (value: unknown): string | null => {
    if (value === null || value === undefined) return null
    if (value instanceof Date) return value.toISOString()
    return String(value)
  }
  const normalizedWorkspaceRow = (row: any): Record<string, unknown> | null => row ? {
    workspace_id: String(row.workspace_id),
    org_id: String(row.org_id),
    name: String(row.name),
    workspace_type: String(row.workspace_type),
    local_path: row.local_path === null ? null : String(row.local_path),
    repo_url: row.repo_url === null ? null : String(row.repo_url),
    default_branch: row.default_branch === null ? null : String(row.default_branch),
    metadata: parseJsonRecord(row.metadata),
    created_at: normalizedTimestamp(row.created_at),
    updated_at: normalizedTimestamp(row.updated_at),
  } : null
  const normalizedWorkspaceBinding = (row: any): WorkspaceAuthorityBinding | null => row ? {
    agent_id: String(row.agent_id),
    workspace_id: String(row.workspace_id),
    binding_role: String(row.binding_role),
    active: row.active === true || row.active === 1 || row.active === '1',
    created_at: normalizedTimestamp(row.created_at),
    updated_at: normalizedTimestamp(row.updated_at),
  } : null
  const normalizedRuntimeLink = (row: any): WorkspaceAuthorityRuntimeLink => ({
    runtime_instance_id: String(row.runtime_instance_id),
    agent_id: String(row.agent_id),
    workspace_id: row.workspace_id === null || row.workspace_id === undefined ? null : String(row.workspace_id),
  })
  const workspaceAuthorityProjection = (input: {
    workspaceId: string
    canonicalPath: string
    workspaceCreated: boolean
    workspaceRowDigest: string | null
    binding: Pick<WorkspaceAuthorityBinding, 'agent_id' | 'workspace_id' | 'binding_role' | 'active'> | null
    runtimeLinks: WorkspaceAuthorityRuntimeLink[]
    preservedReferenceDigest: string
    bootstrapRunId: string
    project: string
  }) => ({
    workspace: input.workspaceCreated ? {
      workspace_id: input.workspaceId,
      org_id: 'default',
      name: input.project,
      workspace_type: 'local_path',
      local_path: input.canonicalPath,
      bootstrap_run_id: input.bootstrapRunId,
    } : {
      workspace_id: input.workspaceId,
      row_digest: input.workspaceRowDigest,
    },
    binding: input.binding ? {
      agent_id: input.binding.agent_id,
      workspace_id: input.binding.workspace_id,
      binding_role: input.binding.binding_role,
      active: input.binding.active,
    } : null,
    runtime_links: [...input.runtimeLinks].sort((a, b) => a.runtime_instance_id.localeCompare(b.runtime_instance_id)),
    preserved_reference_digest: input.preservedReferenceDigest,
  })

  const ensureActivePrimaryWorkspace = async (context: BootstrapStageContext): Promise<{
    workspace_id: string
    canonical_path: string
    mutation?: Omit<BootstrapMutation, 'mutation_id' | 'stage' | 'rollback_status'>
  }> => {
    const canonicalPath = realpathOrResolve(context.workspaceRoot)
    const project = env.AGENT_MEMORY_PROJECT || env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(canonicalPath)
    return withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
      const agent = await tx.queryOne<{ agent_id: string }>(
        'SELECT agent_id FROM agents WHERE agent_id = $1 FOR UPDATE',
        [context.agentId],
      )
      if (!agent) throw new Error('workspace authority agent unavailable')
      const active = await tx.query<{ workspace_id: string; local_path: string | null }>(
        `SELECT w.workspace_id, w.local_path
           FROM agent_workspace_bindings b
           JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
          WHERE b.agent_id = $1
            AND b.active = true
            AND b.binding_role = 'primary'
          ORDER BY w.workspace_id`,
        [context.agentId],
      )
      if (active.length > 1) throw new Error('active primary workspace is ambiguous')
      if (active.length === 1) {
        const boundPath = String(active[0]!.local_path ?? '')
        if (!boundPath || realpathOrResolve(boundPath) !== canonicalPath) {
          throw new Error('active primary workspace conflicts with bootstrap target')
        }
      }

      const existing = await tx.query<any>(
        `SELECT workspace_id, org_id, name, workspace_type, local_path, repo_url,
                default_branch, metadata, created_at, updated_at
           FROM agent_workspaces
          WHERE org_id = 'default' AND local_path = $1
          ORDER BY workspace_id
          LIMIT 2`,
        [canonicalPath],
      )
      if (existing.length > 1) throw new Error('bootstrap target workspace row is ambiguous')
      const activeWorkspaceId = active.length === 1 ? String(active[0]!.workspace_id) : null
      const existingWorkspaceId = existing[0]?.workspace_id ? String(existing[0].workspace_id) : null
      if (activeWorkspaceId && existingWorkspaceId && activeWorkspaceId !== existingWorkspaceId) {
        throw new Error('active primary workspace identity conflicts with canonical target')
      }
      const workspaceId = activeWorkspaceId ?? existingWorkspaceId
        ?? `aun-bootstrap-${bootstrapDigest({ org_id: 'default', local_path: canonicalPath }).slice(0, 32)}`
      const workspaceBefore = normalizedWorkspaceRow(existing[0] ?? null)
      const bindingBefore = normalizedWorkspaceBinding(await tx.queryOne<any>(
        `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
           FROM agent_workspace_bindings
          WHERE agent_id = $1 AND workspace_id = $2 AND binding_role = 'primary'
          FOR UPDATE`,
        [context.agentId, workspaceId],
      ))
      const activeRuntimes = (await tx.query<any>(
        `SELECT runtime_instance_id, agent_id, workspace_id
           FROM agent_runtime_instances
          WHERE agent_id = $1 AND status IN ('running', 'active')
          ORDER BY runtime_instance_id
          FOR UPDATE`,
        [context.agentId],
      )).map(normalizedRuntimeLink)
      const conflictingRuntime = activeRuntimes.find((row) => row.workspace_id !== null && row.workspace_id !== workspaceId)
      if (conflictingRuntime) throw new Error('active runtime workspace conflicts with bootstrap target')
      const runtimePreimages = activeRuntimes.filter((row) => row.workspace_id === null)
      const preservedBindingsBefore = (await tx.query<any>(
        `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
           FROM agent_workspace_bindings
          WHERE workspace_id = $1
            AND NOT (agent_id = $2 AND binding_role = 'primary')
          ORDER BY agent_id, binding_role`,
        [workspaceId, context.agentId],
      )).map(normalizedWorkspaceBinding)
      const runtimePreimageIds = new Set(runtimePreimages.map((row) => row.runtime_instance_id))
      const preservedRuntimesBefore = (await tx.query<any>(
        `SELECT runtime_instance_id, agent_id, workspace_id
           FROM agent_runtime_instances
          WHERE workspace_id = $1
          ORDER BY runtime_instance_id`,
        [workspaceId],
      )).map(normalizedRuntimeLink).filter((row) =>
        row.agent_id !== context.agentId || !runtimePreimageIds.has(row.runtime_instance_id))
      const preservedReferenceDigest = bootstrapDigest({
        bindings: preservedBindingsBefore,
        runtimes: preservedRuntimesBefore,
      })
      const workspaceCreated = workspaceBefore === null
      const needsMutation = workspaceCreated || !bindingBefore?.active || runtimePreimages.length > 0
      if (!needsMutation) return { workspace_id: workspaceId, canonical_path: canonicalPath }

      const intendedBinding = {
        agent_id: context.agentId,
        workspace_id: workspaceId,
        binding_role: 'primary',
        active: true,
      }
      const intendedRuntimeLinks = runtimePreimages.map((row) => ({ ...row, workspace_id: workspaceId }))
      const workspaceBeforeDigest = workspaceBefore ? bootstrapDigest(workspaceBefore) : null
      const beforeProjection = workspaceAuthorityProjection({
        workspaceId, canonicalPath, workspaceCreated: false,
        workspaceRowDigest: workspaceBeforeDigest,
        binding: bindingBefore,
        runtimeLinks: runtimePreimages,
        preservedReferenceDigest,
        bootstrapRunId: context.runId,
        project,
      })
      const intendedProjection = workspaceAuthorityProjection({
        workspaceId, canonicalPath, workspaceCreated,
        workspaceRowDigest: workspaceBeforeDigest,
        binding: intendedBinding,
        runtimeLinks: intendedRuntimeLinks,
        preservedReferenceDigest,
        bootstrapRunId: context.runId,
        project,
      })
      const ownerKey = `workspace-authority:${context.runId}:${context.agentId}:${workspaceId}`
      const rollbackPayload = {
        schema_version: 'aun-bootstrap-workspace-authority-rollback/v1',
        bootstrap_run_id: context.runId,
        agent_id: context.agentId,
        workspace_id: workspaceId,
        canonical_path: canonicalPath,
        project,
        workspace_created: workspaceCreated,
        workspace_preimage_digest: workspaceBeforeDigest,
        binding_preimage: bindingBefore ? {
          existed: true,
          active: bindingBefore.active,
          row_digest: bootstrapDigest(bindingBefore),
        } : { existed: false, active: null, row_digest: null },
        runtime_preimages: runtimePreimages,
        preserved_bindings_preimage: preservedBindingsBefore,
        preserved_runtimes_preimage: preservedRuntimesBefore,
        preserved_reference_digest: preservedReferenceDigest,
        before_projection_digest: bootstrapDigest(beforeProjection),
        intended_projection_digest: bootstrapDigest(intendedProjection),
      }
      const admission = {
        kind: 'workspace_authority' as const,
        owner_key: ownerKey,
        before_digest: bootstrapDigest(beforeProjection),
        intended_after_digest: bootstrapDigest(intendedProjection),
        actual_after_digest: null,
        rollback_action: 'restore exact workspace, primary binding, and runtime-link preimages without mutating shared references',
        rollback_payload: {
          ...rollbackPayload,
          recovery_admission: true,
          recovery_admission_phase: 'B3_WORKSPACE_PRE_COMMIT',
        },
      }
      context.admitRecoveryMutation?.(admission)

      if (workspaceCreated) {
        await tx.execute(
          `INSERT INTO agent_workspaces
             (workspace_id, org_id, name, workspace_type, local_path, metadata)
           VALUES ($1, 'default', $2, 'local_path', $3, COALESCE($4::jsonb, '{}'::jsonb))`,
          [workspaceId, project, canonicalPath, JSON.stringify({
            source: 'aun-bootstrap',
            agent_id: context.agentId,
            bootstrap_run_id: context.runId,
          })],
        )
      }
      await tx.execute(
        `INSERT INTO agent_workspace_bindings
           (agent_id, workspace_id, binding_role, active)
         VALUES ($1, $2, 'primary', true)
         ON CONFLICT (agent_id, workspace_id, binding_role) DO UPDATE SET active = true`,
        [context.agentId, workspaceId],
      )
      for (const runtime of runtimePreimages) {
        const linked = await tx.execute(
          `UPDATE agent_runtime_instances SET workspace_id = $3
            WHERE runtime_instance_id = $1 AND agent_id = $2 AND workspace_id IS NULL`,
          [runtime.runtime_instance_id, context.agentId, workspaceId],
        )
        if (linked.rowCount !== 1) throw new Error('active runtime workspace link lost its exact preimage')
      }
      const workspaceAfter = normalizedWorkspaceRow(await tx.queryOne<any>(
        `SELECT workspace_id, org_id, name, workspace_type, local_path, repo_url,
                default_branch, metadata, created_at, updated_at
           FROM agent_workspaces WHERE workspace_id = $1`,
        [workspaceId],
      ))
      const bindingAfter = normalizedWorkspaceBinding(await tx.queryOne<any>(
        `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
           FROM agent_workspace_bindings
          WHERE agent_id = $1 AND workspace_id = $2 AND binding_role = 'primary'`,
        [context.agentId, workspaceId],
      ))
      const runtimeAfter = runtimePreimages.length === 0 ? [] : (await tx.query<any>(
        `SELECT runtime_instance_id, agent_id, workspace_id
           FROM agent_runtime_instances
          WHERE agent_id = $1
          ORDER BY runtime_instance_id`,
        [context.agentId],
      )).map(normalizedRuntimeLink).filter((row) => runtimePreimageIds.has(row.runtime_instance_id))
      const preservedBindingsAfter = (await tx.query<any>(
        `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
           FROM agent_workspace_bindings
          WHERE workspace_id = $1
            AND NOT (agent_id = $2 AND binding_role = 'primary')
          ORDER BY agent_id, binding_role`,
        [workspaceId, context.agentId],
      )).map(normalizedWorkspaceBinding)
      const preservedRuntimesAfter = (await tx.query<any>(
        `SELECT runtime_instance_id, agent_id, workspace_id
           FROM agent_runtime_instances
          WHERE workspace_id = $1
          ORDER BY runtime_instance_id`,
        [workspaceId],
      )).map(normalizedRuntimeLink).filter((row) =>
        row.agent_id !== context.agentId || !runtimePreimageIds.has(row.runtime_instance_id))
      if (!workspaceAfter || realpathOrResolve(String(workspaceAfter.local_path ?? '')) !== canonicalPath
        || !bindingAfter?.active
        || bootstrapDigest(runtimeAfter) !== bootstrapDigest(intendedRuntimeLinks)
        || bootstrapDigest({ bindings: preservedBindingsAfter, runtimes: preservedRuntimesAfter }) !== preservedReferenceDigest) {
        throw new Error('workspace authority post-mutation readback mismatch')
      }
      if (workspaceCreated) {
        const metadata = parseJsonRecord(workspaceAfter.metadata)
        if (metadata.bootstrap_run_id !== context.runId || metadata.agent_id !== context.agentId) {
          throw new Error('workspace authority ownership readback mismatch')
        }
      } else if (bootstrapDigest(workspaceAfter) !== workspaceBeforeDigest) {
        throw new Error('preexisting workspace changed during authority binding')
      }
      const mutation = {
        ...admission,
        actual_after_digest: bootstrapDigest(intendedProjection),
        rollback_payload: {
          ...rollbackPayload,
          workspace_postimage_digest: bootstrapDigest(workspaceAfter),
          binding_postimage_digest: bootstrapDigest(bindingAfter),
          runtime_postimages: runtimeAfter,
          post_projection_digest: bootstrapDigest(intendedProjection),
        },
      }
      return { workspace_id: workspaceId, canonical_path: canonicalPath, mutation }
    }))
  }

  const readActivePrimaryWorkspaceAuthority = async (context: BootstrapStageContext): Promise<{
    workspace_id: string
    canonical_path: string
  } | null> => withBootstrapDb(env, async (db) => {
    const canonicalPath = realpathOrResolve(context.workspaceRoot)
    const active = await db.query<{ workspace_id: string; local_path: string | null }>(
      `SELECT w.workspace_id, w.local_path
         FROM agent_workspace_bindings b
         JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
        WHERE b.agent_id = $1 AND b.active = true AND b.binding_role = 'primary'
        ORDER BY w.workspace_id`,
      [context.agentId],
    )
    if (active.length !== 1 || !active[0]!.local_path
      || realpathOrResolve(String(active[0]!.local_path)) !== canonicalPath) return null
    const runtimeConflicts = await db.query<{ runtime_instance_id: string }>(
      `SELECT runtime_instance_id
         FROM agent_runtime_instances
        WHERE agent_id = $1 AND status IN ('running', 'active')
          AND (workspace_id IS NULL OR workspace_id <> $2)
        ORDER BY runtime_instance_id
        LIMIT 1`,
      [context.agentId, String(active[0]!.workspace_id)],
    )
    return runtimeConflicts.length === 0
      ? { workspace_id: String(active[0]!.workspace_id), canonical_path: canonicalPath }
      : null
  }, { readonly: true }).catch(() => null)

  const profileGetReadOnly = async (agentId: string): Promise<any | null> => {
    if (!databaseAlreadyExists()) return null
    return withBootstrapDb(env, async (db) => {
      const row = await db.queryOne<any>(
        `SELECT agent_id, display_name, agent_type, runtime, status, metadata, ui_id, ui_handle,
                channel_port, home_directory, runtime_engine_preference, provider_token_source_ref,
                expected_provider_identity, profile_enabled, profile_revision, profile_source, profile_updated_at
           FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      if (!row) return null
      const metadata = parseJsonRecord(row.metadata)
      return {
        ...row,
        tmux_session: typeof metadata.tmux_session === 'string' ? metadata.tmux_session : null,
        profile_enabled: row.profile_enabled === true || row.profile_enabled === 1 || row.profile_enabled === '1',
        profile_revision: Number(row.profile_revision ?? 1),
      }
    }, { readonly: true }).catch(() => null)
  }

  const resolveTmuxAuthority = async (
    context: BootstrapStageContext,
    existingSession: unknown,
  ): Promise<{ ok: true; session: string; evidenceRef: string } | { ok: false; evidenceRef: string }> => {
    const validSession = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    const validPane = (value: string): boolean => /^%[0-9]+$/.test(value)

    if (explicitTmuxSessionProvided || explicitTmuxPaneProvided) {
      if (!explicitTmuxSessionProvided || !explicitTmuxPaneProvided
        || !validSession(explicitTmuxSession) || !validPane(explicitTmuxPane)) {
        return {
          ok: false,
          evidenceRef: `tmux-explicit-target-invalid:${bootstrapDigest({
            has_session: explicitTmuxSessionProvided,
            has_pane: explicitTmuxPaneProvided,
            session_valid: validSession(explicitTmuxSession),
            pane_valid: validPane(explicitTmuxPane),
          })}`,
        }
      }
      const sessionExists = await run(
        'tmux', ['has-session', '-t', `=${explicitTmuxSession}`], commandOptions(context, 10_000),
      )
      const paneSession = await run(
        'tmux', ['display-message', '-p', '-t', explicitTmuxPane, '#S'], commandOptions(context, 10_000),
      )
      const paneIdentity = await run(
        'tmux', ['display-message', '-p', '-t', explicitTmuxPane, '#{pane_id}'], commandOptions(context, 10_000),
      )
      const valid = sessionExists.exitCode === 0
        && paneSession.exitCode === 0 && paneSession.stdout.trim() === explicitTmuxSession
        && paneIdentity.exitCode === 0 && paneIdentity.stdout.trim() === explicitTmuxPane
      const evidenceRef = `tmux-explicit-target:${bootstrapDigest({
        session: explicitTmuxSession,
        pane: explicitTmuxPane,
        session_exists_exit: sessionExists.exitCode,
        pane_session_exit: paneSession.exitCode,
        pane_session: paneSession.stdout.trim(),
        pane_identity_exit: paneIdentity.exitCode,
        pane_identity: paneIdentity.stdout.trim(),
      })}`
      return valid ? { ok: true, session: explicitTmuxSession, evidenceRef } : { ok: false, evidenceRef }
    }

    const callerSession = await run(
      'tmux', ['display-message', '-p', '#S'], commandOptions(context, 10_000),
    )
    const callerSessionName = callerSession.stdout.trim()
    if (callerSession.exitCode === 0 && validSession(callerSessionName)) {
      return {
        ok: true,
        session: callerSessionName,
        evidenceRef: `tmux-caller-session:${bootstrapDigest({ session: callerSessionName })}`,
      }
    }
    const fallbackSession = typeof existingSession === 'string' ? existingSession.trim() : ''
    if (!validSession(fallbackSession)) {
      return { ok: false, evidenceRef: `tmux-authority-unresolved:${bootstrapDigest({ caller_exit: callerSession.exitCode })}` }
    }
    const existingSessionReadback = await run(
      'tmux', ['has-session', '-t', `=${fallbackSession}`], commandOptions(context, 10_000),
    )
    const evidenceRef = `tmux-existing-session:${bootstrapDigest({
      session: fallbackSession,
      session_exists_exit: existingSessionReadback.exitCode,
    })}`
    return existingSessionReadback.exitCode === 0
      ? { ok: true, session: fallbackSession, evidenceRef }
      : { ok: false, evidenceRef }
  }

  const ensureConfigurationDesiredState = async (
    context: BootstrapStageContext,
  ): Promise<{
    desired_revision: number
    desired_digest: string
    release_tree: string
    held_event_ids: string[]
    mutation?: Omit<BootstrapMutation, 'mutation_id' | 'stage' | 'rollback_status'>
  } | null> => {
    const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
    const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
    if (!postgres || !context.repoHead) return null
    const treeResult = await run('git', ['rev-parse', 'HEAD^{tree}'], { ...commandOptions(context, 10_000), cwd: context.repoRoot })
    // The injected command port is authoritative. A read-only native fallback
    // keeps older bootstrap adapters compatible while still resolving the
    // exact tree from the checkout rather than inventing it from the commit.
    const nativeTreeResult = treeResult.exitCode === 0
      ? null
      : Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], {
          cwd: context.repoRoot,
          env: context.env,
          stdout: 'pipe',
          stderr: 'pipe',
        })
    const releaseTree = treeResult.exitCode === 0
      ? treeResult.stdout.trim()
      : nativeTreeResult?.exitCode === 0
        ? nativeTreeResult.stdout.toString().trim()
        : ''
    if (!/^[0-9a-f]{40}$/.test(releaseTree)) throw new Error('configuration desired release tree unavailable')
    let createdArtifact: DurableArtifactIdentity | null = null
    let recoveryAdmitted = false
    try {
      return await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
        const preAgentResult = await tx.queryOne<{
          row: Record<string, unknown>
          repo_url: string | null
          workspace_path: string | null
        }>(
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
            WHERE a.agent_id = $1
            FOR UPDATE OF a`,
          [context.agentId],
        )
        if (!preAgentResult?.row) throw new Error('configuration desired agent row unavailable')
        const preAgentRow = preAgentResult.row
        if (context.resolvedRuntime === 'codex' && context.providerRootAuthority?.existingTarget === true) {
          const liveMetadata = jsonRecord(preAgentRow.metadata)
          const liveProjection = jsonRecord(preAgentRow.ordinary_projection)
          const liveRoot = typeof liveMetadata.codex_home === 'string' ? liveMetadata.codex_home : ''
          const liveProjectedRoot = typeof liveProjection.provider_config_root === 'string'
            ? liveProjection.provider_config_root
            : ''
          const liveTupleDigest = providerRootAuthorityTupleDigest(context.agentId, {
            ...preAgentRow,
            repo_url: preAgentResult.repo_url,
            workspace_path: preAgentResult.workspace_path,
          })
          const expectedTupleDigest = context.providerRootAuthority.authorityTupleDigest ?? liveTupleDigest
          if (liveRoot !== context.providerRootAuthority.canonicalRoot
            || liveProjectedRoot !== context.providerRootAuthority.canonicalRoot
            || liveTupleDigest !== expectedTupleDigest) {
            throw new Error('provider root authority drift under B3 row lock')
          }
        }
        const preOutboxRows = (await tx.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(o) AS row
             FROM aun_configuration_desired_outbox o
            WHERE agent_id = $1
            ORDER BY event_id`,
          [context.agentId],
        )).map((item) => item.row)
        const preEventIds = new Set(preOutboxRows.map((row) => String(row.event_id)))

        await tx.execute(`SELECT set_config('aun.actor_ref', $1, true)`, [`aun-bootstrap:${context.runId}`])
        const updated = await tx.execute(
          `UPDATE agents SET
             canonical_workspace = $2,
             canonical_home = $3,
             supervisor_identity = 'launchd:com.agent-comms.state-daemon',
             ordinary_communication_enrollment = true,
             ordinary_projection = $4::jsonb,
             desired_release_commit = $5,
             desired_release_tree = $6,
             desired_control_refs = $7::jsonb,
             metadata = CASE WHEN $8::boolean
               THEN jsonb_set(COALESCE(metadata, '{}'::jsonb), '{codex_home}', to_jsonb($9::text), true)
               ELSE metadata END
           WHERE agent_id = $1`,
          [
            context.agentId, context.workspaceRoot, home,
            JSON.stringify({
              owner: 'continuous-reconciler',
              provider_repo_root: context.repoRoot,
              provider_config_root: context.resolvedRuntime === 'claude'
                ? env.CLAUDE_CONFIG_DIR || join(home, '.claude')
                : context.providerRootAuthority?.canonicalRoot || env.CODEX_HOME || join(home, '.codex'),
              daemon_checkout: join(defaultStateDaemonRestoreRoot(home), context.repoHead),
              schema_version: 'aun-configuration-projection/v1',
            }),
            context.repoHead, releaseTree,
            JSON.stringify(['https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803']),
            context.resolvedRuntime === 'codex' && context.providerRootAuthority?.existingTarget === false,
            context.providerRootAuthority?.canonicalRoot ?? env.CODEX_HOME ?? join(home, '.codex'),
          ],
        )
        if (updated.rowCount !== 1) throw new Error('configuration desired agent update rejected')
        const postAgentResult = await tx.queryOne<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`,
          [context.agentId],
        )
        const postAgentRow = postAgentResult?.row
        const desiredRevision = Number(postAgentRow?.desired_revision)
        const desiredDigest = String(postAgentRow?.desired_digest ?? '')
        if (!postAgentRow || !Number.isSafeInteger(desiredRevision) || desiredRevision < 1
          || !/^[0-9a-f]{64}$/.test(desiredDigest)) {
          throw new Error('configuration desired state readback invalid')
        }
        const postBeforeHold = (await tx.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(o) AS row
             FROM aun_configuration_desired_outbox o
            WHERE agent_id = $1
            ORDER BY event_id`,
          [context.agentId],
        )).map((item) => item.row)
        const newEvents = postBeforeHold.filter((row) => !preEventIds.has(String(row.event_id)))
        const changed = bootstrapDigest(configurationDesiredControlledRow(preAgentRow))
          !== bootstrapDigest(configurationDesiredControlledRow(postAgentRow))
        if ((!changed && newEvents.length !== 0) || (changed && newEvents.length !== 1)) {
          throw new Error('configuration desired event cardinality invalid')
        }
        for (const event of newEvents) {
          if (String(event.agent_id) !== context.agentId
            || Number(event.desired_revision) !== desiredRevision
            || String(event.desired_digest) !== desiredDigest
            || event.delivered_at !== null
            || Number(event.attempt_count) !== 0) {
            throw new Error('configuration desired event identity invalid')
          }
          const held = await tx.execute(
            `UPDATE aun_configuration_desired_outbox
                SET available_at = 'infinity'::timestamptz
              WHERE event_id = $1 AND agent_id = $2
                AND desired_revision = $3 AND desired_digest = $4
                AND delivered_at IS NULL AND attempt_count = 0`,
            [String(event.event_id), context.agentId, desiredRevision, desiredDigest],
          )
          if (held.rowCount !== 1) throw new Error('configuration desired event hold rejected')
        }
        const postOutboxRows = (await tx.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(o) AS row
             FROM aun_configuration_desired_outbox o
            WHERE agent_id = $1
            ORDER BY event_id`,
          [context.agentId],
        )).map((item) => item.row)
        const heldEventIds = newEvents.map((row) => String(row.event_id)).sort()
        if (!changed) {
          return {
            desired_revision: desiredRevision,
            desired_digest: desiredDigest,
            release_tree: String(postAgentRow.desired_release_tree),
            held_event_ids: [],
          }
        }
        const artifact: ConfigurationDesiredRollbackArtifact = {
          schema_version: 'aun-bootstrap-configuration-desired-rollback/v1',
          run_id: context.runId,
          agent_id: context.agentId,
          pre_agent_row: preAgentRow,
          post_agent_row: postAgentRow,
          pre_outbox_rows: preOutboxRows,
          post_outbox_rows: postOutboxRows,
          new_event_ids: heldEventIds,
        }
        createdArtifact = writeConfigurationDesiredArtifact(home, env, artifact)
        const artifactDigest = bootstrapDigest(artifact)
        const mutation = {
          kind: 'configuration_desired' as const,
          owner_key: `configuration-desired:${context.runId}:${context.agentId}`,
          before_digest: bootstrapDigest({ agent: configurationDesiredControlledRow(preAgentRow), outbox: preOutboxRows }),
          intended_after_digest: bootstrapDigest({ agent: configurationDesiredControlledRow(postAgentRow), outbox: postOutboxRows }),
          actual_after_digest: bootstrapDigest({ agent: configurationDesiredControlledRow(postAgentRow), outbox: postOutboxRows }),
          rollback_action: 'restore the exact locked agents/outbox preimage and delete only exact run/compensating events',
          rollback_payload: {
            created_by_run: true,
            rollback_artifact_digest: artifactDigest,
            rollback_artifact_identity: createdArtifact,
            new_event_ids: heldEventIds,
            desired_revision: desiredRevision,
            desired_digest: desiredDigest,
            post_union_digest: bootstrapDigest({ agent: configurationDesiredControlledRow(postAgentRow), outbox: postOutboxRows }),
          },
        }
        context.admitRecoveryMutation?.({
          ...mutation,
          actual_after_digest: null,
          rollback_payload: {
            ...mutation.rollback_payload,
            recovery_admission: true,
            recovery_admission_phase: 'B3_PRE_COMMIT',
          },
        })
        recoveryAdmitted = Boolean(context.admitRecoveryMutation)
        return {
          desired_revision: desiredRevision,
          desired_digest: desiredDigest,
          release_tree: String(postAgentRow.desired_release_tree),
          held_event_ids: heldEventIds,
          mutation,
        }
      }))
    } catch (error) {
      if (!recoveryAdmitted && createdArtifact && existsSync(createdArtifact.path)) {
        try { removeConfigurationDesiredArtifact(createdArtifact) } catch { /* preserve an unverifiable artifact for manual recovery */ }
      }
      throw error
    }
  }

  const configurationDesiredReadback = (
    configuration: Awaited<ReturnType<typeof ensureConfigurationDesiredState>>,
  ) => configuration ? {
    desired_revision: configuration.desired_revision,
    desired_digest: configuration.desired_digest,
    release_tree: configuration.release_tree,
    held_event_ids: configuration.held_event_ids,
  } : null

  const configurationDesiredReadOnly = async (
    agentId: string,
  ): Promise<{ desired_revision: number; desired_digest: string; release_tree: string } | null> => {
    const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
    const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
    if (!postgres || !databaseAlreadyExists()) return null
    return withBootstrapDb(env, async (db) => {
      const row = await db.queryOne<any>(
        `SELECT desired_revision, desired_digest, desired_release_tree
           FROM agents WHERE agent_id = $1`,
        [agentId],
      )
      return row && Number.isSafeInteger(Number(row.desired_revision)) && /^[0-9a-f]{64}$/.test(String(row.desired_digest ?? ''))
        ? {
            desired_revision: Number(row.desired_revision),
            desired_digest: String(row.desired_digest),
            release_tree: String(row.desired_release_tree),
          }
        : null
    }, { readonly: true }).catch(() => null)
  }

  const recordBootstrapConfigurationReady = async (
    context: BootstrapStageContext,
    nativeReadback: {
      providerNativeDigest: string
      launchagentPlistDigest: string
      launchctlEnvironmentDigest: string
      runtimeIdentityDigest: string
    },
  ): Promise<{
    hostId: string
    desiredRevision: number
    desiredDigest: string
    candidateDigest: string
    outboxEventId: string | null
    previousObservedState: Record<string, unknown> | null
    idempotent: boolean
  } | null> => {
    const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
    const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
    if (!postgres) return null
    if (Object.values(nativeReadback).some((digest) => !/^[0-9a-f]{64}$/.test(digest))) {
      throw new Error('configuration native readback digest unavailable')
    }
    const desiredMutation = context.priorState.mutations.find((mutation) => mutation.kind === 'configuration_desired')
    const desiredPayload = desiredMutation?.rollback_payload ?? {}
    const heldEventIds = Array.isArray(desiredPayload.new_event_ids)
      ? desiredPayload.new_event_ids.map(String)
      : []
    if (heldEventIds.length > 1) throw new Error('configuration desired held event cardinality invalid')
    return withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
      const desired = await readConfigurationDesiredState(tx, context.agentId)
      if (!desired) throw new Error('configuration desired state unavailable')
      if (desiredMutation && (Number(desiredPayload.desired_revision) !== desired.desiredRevision
        || String(desiredPayload.desired_digest ?? '') !== desired.desiredDigest)) {
        throw new Error('configuration desired mutation binding mismatch')
      }
      const projection = desired.ordinaryProjection
      const providerRepoRoot = typeof projection.provider_repo_root === 'string'
        ? projection.provider_repo_root
        : context.repoRoot
      const daemonCheckout = typeof projection.daemon_checkout === 'string'
        ? projection.daemon_checkout
        : join(defaultStateDaemonRestoreRoot(home), desired.releaseCommit)
      const providerConfigRoot = typeof projection.provider_config_root === 'string'
        ? projection.provider_config_root
        : desired.runtimeEnginePreference === 'claude'
          ? env.CLAUDE_CONFIG_DIR || join(home, '.claude')
          : env.CODEX_HOME || join(home, '.codex')
      const candidate = buildDefaultAunConfigurationCandidate({
        hostId: env.AUN_HOST_ID?.trim() || hostname(),
        desired,
        databaseLocatorRef: env.AUN_DATABASE_LOCATOR_REF?.trim() || 'env:DATABASE_URL',
        databaseCredentialRef: env.AUN_DATABASE_CREDENTIAL_REF?.trim() || 'env:DATABASE_URL',
        bunPath,
        serverEntry: 'server.ts',
        providerRepoRoot,
        providerConfigRoot,
        daemonCheckout,
        daemonEntry: join(daemonCheckout, 'bin', 'state-daemon.ts'),
        restartRequired: true,
      })
      if (context.priorState.terminal_status === 'READY' || context.priorState.terminal_status === 'IDEMPOTENT_READY') {
        const observed = await tx.queryOne<Record<string, unknown>>(
          `SELECT host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
                  release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
                  launchctl_environment_digest, runtime_identity_digest, reconcile_status,
                  drift_reason_codes, lease_id, fencing_token, observed_at
             FROM aun_configuration_observed_state
            WHERE host_id = $1 AND agent_id = $2`,
          [candidate.hostId, candidate.agentId],
        )
        const event = heldEventIds.length === 1 ? await tx.queryOne<any>(
          `SELECT event_id, desired_revision, desired_digest, attempt_count, delivered_at
             FROM aun_configuration_desired_outbox
            WHERE event_id = $1 AND agent_id = $2`,
          [heldEventIds[0], desired.agentId],
        ) : null
        if (!observed
          || Number(observed.observed_revision) !== desired.desiredRevision
          || String(observed.observed_desired_digest) !== desired.desiredDigest
          || String(observed.candidate_digest) !== candidate.candidateDigest
          || (heldEventIds.length === 1 && (!event || Number(event.attempt_count) !== 1 || event.delivered_at === null
            || Number(event.desired_revision) !== desired.desiredRevision || String(event.desired_digest) !== desired.desiredDigest))) {
          throw new Error('configuration idempotent readback invalid')
        }
        return {
          hostId: candidate.hostId,
          desiredRevision: desired.desiredRevision,
          desiredDigest: desired.desiredDigest,
          candidateDigest: candidate.candidateDigest,
          outboxEventId: event ? String(event.event_id) : null,
          previousObservedState: observed,
          idempotent: true,
        }
      }
      const previousObservedState = await tx.queryOne<Record<string, unknown>>(
        `SELECT host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
                release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
                launchctl_environment_digest, runtime_identity_digest, reconcile_status,
                drift_reason_codes, lease_id, fencing_token, observed_at
           FROM aun_configuration_observed_state
          WHERE host_id = $1 AND agent_id = $2`,
        [candidate.hostId, candidate.agentId],
      )
      const acquired = await acquireControlPlaneLease(tx, {
        scopeType: 'runtime_instance',
        scopeId: `configuration-reconciler:${candidate.hostId}`,
        purpose: 'maintenance',
        ttlMs: 45_000,
        holderAgentId: context.agentId,
        holderRuntimeInstanceId: env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID ?? null,
        metadata: { owner: 'aun-bootstrap-first-reconciliation', run_id: context.runId },
      })
      if (!acquired.ok) throw new Error('configuration reconciliation lease unavailable')
      try {
        const recorded = await recordConfigurationObservedState(tx, {
          hostId: candidate.hostId,
          agentId: candidate.agentId,
          observedRevision: desired.desiredRevision,
          observedDesiredDigest: desired.desiredDigest,
          candidateDigest: candidate.candidateDigest,
          releaseCommit: candidate.releaseCommit,
          releaseTree: candidate.releaseTree,
          providerNativeDigest: nativeReadback.providerNativeDigest,
          launchagentPlistDigest: nativeReadback.launchagentPlistDigest,
          launchctlEnvironmentDigest: nativeReadback.launchctlEnvironmentDigest,
          runtimeIdentityDigest: nativeReadback.runtimeIdentityDigest,
          reconcileStatus: 'READY',
          driftReasonCodes: [],
          leaseId: acquired.lease.lease_id,
          fencingToken: acquired.lease.fencing_token,
        })
        if (!recorded) throw new Error('configuration observed state fence rejected')
        const event = heldEventIds.length === 1 ? await tx.queryOne<any>(
          `SELECT event_id, desired_revision, desired_digest, attempt_count,
                  delivered_at, available_at::text AS available_at_text
             FROM aun_configuration_desired_outbox
            WHERE event_id = $1 AND agent_id = $2
              AND desired_revision = $3 AND desired_digest = $4
            FOR UPDATE`,
          [heldEventIds[0], desired.agentId, desired.desiredRevision, desired.desiredDigest],
        ) : null
        if (heldEventIds.length === 1 && (!event || event.delivered_at !== null
          || Number(event.attempt_count) !== 0 || event.available_at_text !== 'infinity')) {
          throw new Error('configuration exact held event readback invalid')
        }
        if (event) {
          const delivered = await markConfigurationEventDelivered(
            tx, String(event.event_id), Number(event.desired_revision), String(event.desired_digest),
          )
          if (!delivered) throw new Error('configuration outbox delivery receipt rejected')
        }
        return {
          hostId: candidate.hostId,
          desiredRevision: desired.desiredRevision,
          desiredDigest: desired.desiredDigest,
          candidateDigest: candidate.candidateDigest,
          outboxEventId: event ? String(event.event_id) : null,
          previousObservedState,
          idempotent: false,
        }
      } finally {
        await releaseControlPlaneLease(tx, {
          leaseId: acquired.lease.lease_id,
          fencingToken: acquired.lease.fencing_token,
          holderAgentId: context.agentId,
          holderRuntimeInstanceId: env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID ?? null,
        })
      }
    }))
  }

  const postgresSchemaDigest = async (): Promise<string> => withBootstrapDb(env, async (db) => {
    const columns = await db.query<any>(
      `SELECT table_name, column_name, ordinal_position, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position`,
    )
    const constraints = await db.query<any>(
      `SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
              COALESCE(kcu.column_name, '') AS column_name
         FROM information_schema.table_constraints tc
         LEFT JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_schema = tc.constraint_schema
          AND kcu.constraint_name = tc.constraint_name
          AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = 'public'
        ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position`,
    )
    return bootstrapDigest({ columns, constraints })
  }, { readonly: true })

  const currentDatabaseStageDigest = async (): Promise<string | null> => {
    const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
    const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
    if (postgres) return postgresSchemaDigest().catch(() => null)
    const path = realpathOrResolve(env.AGENT_COM_SQLITE_PATH || join(repoRoot, 'agent-com.db'))
    return sqliteArtifactDigest(path)
  }

  const queueStageReadbackDigest = async (queueId: string, agentId: string, runId: string, runtimeId: string): Promise<string | null> =>
    withBootstrapDb(env, async (db) => {
      const row = await db.queryOne<any>(
        `SELECT id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at, done_at
           FROM message_queue WHERE id = $1 AND agent_id = $2`,
        [queueId, agentId],
      )
      if (!row) return null
      const payload = parseJsonRecord(row.payload)
      const outbound = row.message_id
        ? await db.query<any>('SELECT id, status FROM outbound_queue WHERE message_id = $1 ORDER BY id', [row.message_id]).catch(() => [])
        : []
      return bootstrapDigest({
        queue_id: String(row.id),
        message_id: row.message_id,
        status: row.status,
        claimed_by: row.claimed_by,
        claimed_at: row.claimed_at,
        claim_expires_at: row.claim_expires_at,
        done_at: row.done_at,
        bootstrap_run_id: payload.bootstrap_run_id,
        runtime_instance_id: payload.runtime_instance_id,
        receive_claim_source: payload.receive_claim?.source,
        no_reply_required: payload.terminal_baton?.no_reply_required,
        outbound_rows: outbound,
        exact_identity: payload.bootstrap_run_id === runId && payload.runtime_instance_id === runtimeId,
      })
    }, { readonly: true }).catch(() => null)

  const memoryGate = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
    if (context.dryRun) {
      return {
        ok: true,
        evidenceRefs: ['memory-ready:planned-readback'],
        readinessPredicates: { memory_recovery_readback_planned: true },
      }
    }
    const project = env.AGENT_MEMORY_PROJECT || env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(context.workspaceRoot)
    let runtimeInstanceId: string | null = null
    let runtimeCreated = false
    let runtimeBeforeDigest: string | null = null
    let runtimeBeforeIdentities: Array<{ runtime_instance_id: string; row_digest: string }> = []
    let evidenceId: string | number | null = null
    let runtimeTupleDigest: string | null = null
    let failureDiscriminator = 'runtime_receipt_input_invalid'
    try {
      const profile = await profileGet(context.agentId)
      const sessionName = env.AUN_BOOTSTRAP_TMUX_SESSION || profile?.tmux_session
      const port = Number(env.AUN_BOOTSTRAP_CHANNEL_PORT || profile?.channel_port)
      const providerPid = Number(env.AUN_BOOTSTRAP_PROVIDER_PID)
      if (!profile || !sessionName || !Number.isInteger(port) || port <= 0
        || !Number.isInteger(providerPid) || providerPid <= 1 || !context.resolvedRuntime || !context.repoHead) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_RUNTIME_RECEIPT'],
          evidenceRefs: [`memory-error:runtime_receipt_input_invalid:${bootstrapDigest({
            profile_present: Boolean(profile),
            session_present: Boolean(sessionName),
            port_valid: Number.isInteger(port) && port > 0,
            provider_pid_valid: Number.isInteger(providerPid) && providerPid > 1,
            runtime_present: Boolean(context.resolvedRuntime),
            commit_present: Boolean(context.repoHead),
          })}`],
        }
      }
      if (explicitTmuxSessionProvided && explicitTmuxPaneProvided) {
        failureDiscriminator = 'target_authority_readback'
        const authority = await resolveExplicitTargetRuntimeAuthority({
          run,
          context,
          repoRoot,
          env,
          session: explicitTmuxSession,
          pane: explicitTmuxPane,
        })
        if (!authority.ok || authority.providerPids[context.resolvedRuntime] !== providerPid) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_RUNTIME_RECEIPT'],
            evidenceRefs: [
              authority.evidenceRef,
              `memory-error:target_authority_mismatch:${bootstrapDigest({
                authority_ok: authority.ok,
                runtime: context.resolvedRuntime,
                provider_pid_matches: authority.ok
                  ? authority.providerPids[context.resolvedRuntime] === providerPid
                  : false,
              })}`,
            ],
          }
        }
      }
      const runtimeTuple = expectedRuntimeReceiptTuple(context, env, profile)!
      runtimeTupleDigest = bootstrapDigest(runtimeTuple)
      failureDiscriminator = 'runtime_receipt_db_read'
      const runtime = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
        const agent = await tx.queryOne<{ agent_id: string }>(
          'SELECT agent_id FROM agents WHERE agent_id = $1 FOR UPDATE',
          [context.agentId],
        )
        if (!agent) throw new Error('runtime receipt agent unavailable')
        const workspaceRows = await tx.query<{ workspace_id: string }>(
          `SELECT w.workspace_id
             FROM agent_workspace_bindings b
             JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
            WHERE b.agent_id = $1
              AND b.active = true
              AND b.binding_role = 'primary'
            ORDER BY w.workspace_id
            LIMIT 2`,
          [context.agentId],
        )
        if (workspaceRows.length !== 1) throw new Error('runtime receipt active primary workspace unavailable or ambiguous')
        const workspaceId = String(workspaceRows[0]!.workspace_id)
        const readActive = () => tx.query<any>(
          `SELECT runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id,
                  port, checkout_path, commit_sha, status, metadata
             FROM agent_runtime_instances
            WHERE agent_id = $1 AND status IN ('running', 'active')
            ORDER BY runtime_instance_id`,
          [context.agentId],
        )
        const active = await readActive()
        runtimeBeforeDigest = bootstrapDigest(active)
        runtimeBeforeIdentities = active.map((row) => ({
          runtime_instance_id: String(row.runtime_instance_id),
          row_digest: bootstrapDigest(row),
        }))
        const decision = classifyRuntimeReceiptRows(active, runtimeTuple)
        if (!decision.ok) throw new RuntimeReceiptSelectionError(decision.discriminator, decision.evidenceDigest)
        if (decision.action === 'reuse' && decision.runtimeInstanceId) {
          return { id: decision.runtimeInstanceId, created: false, decisionDigest: decision.evidenceDigest }
        }
        const id = randomUUID()
        const inserted = await tx.query<{ runtime_instance_id: string }>(
          `INSERT INTO agent_runtime_instances
             (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, session_name,
              process_id, port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
           VALUES
             ($1, $2, $3, $4, 'bootstrap_bound_provider', $5,
              $6, $7, $8, $9, 'running', now(), now(), COALESCE($10::jsonb, '{}'::jsonb))
           RETURNING runtime_instance_id`,
          [id, context.agentId, workspaceId, context.resolvedRuntime, sessionName, providerPid, port,
            runtimeTuple.checkout_path, context.repoHead, JSON.stringify({ bootstrap_run_id: context.runId, tuple_digest: runtimeTupleDigest })],
        )
        const insertedId = String(inserted[0]?.runtime_instance_id ?? id)
        const postInsert = classifyRuntimeReceiptRows(await readActive(), runtimeTuple)
        if (!postInsert.ok || postInsert.action !== 'reuse' || postInsert.runtimeInstanceId !== insertedId) {
          throw new RuntimeReceiptSelectionError('runtime_receipt_post_insert_readback', postInsert.evidenceDigest)
        }
        return { id: insertedId, created: true, decisionDigest: postInsert.evidenceDigest }
      }))
      runtimeInstanceId = runtime.id
      runtimeCreated = runtime.created
      env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID = runtime.id

      failureDiscriminator = 'memory_recovery'
      const transport = await readConfiguredWasurezuTransport(context, run)
      if (!transport) throw new Error('provider-native Wasurezu stdio tuple missing')
      const recovery = await runStdioMcpRecovery(transport, project, context)
      failureDiscriminator = 'memory_post_mutation_readback'
      const result = await withBootstrapDb(env, async (db) => {
        const evidence = buildWasurezuBootstrapEvidence({
          agent_id: context.agentId,
          project,
          runtime_instance_id: runtime.id,
          profile_revision: Number(profile.profile_revision) || null,
          profile_source: profile.profile_source ?? 'aun-bootstrap',
          session_name: sessionName,
          port,
          checkout_path: runtimeTuple.checkout_path,
          checkout_commit_sha: context.repoHead,
          recovery_command: 'mcp:initialize>tools/list>tools/call:recover_context',
        })
        evidence.metadata = {
          ...(evidence.metadata ?? {}),
          bootstrap_run_id: context.runId,
          provider_tuple_digest: transport.tupleDigest,
          recovery_response_digest: recovery.responseDigest,
          recovery_tool_count: recovery.toolCount,
          recovery_content_count: recovery.contentCount,
          recovery_started_at: recovery.startedAt,
          recovery_completed_at: recovery.completedAt,
          runtime_tuple_digest: runtimeTupleDigest,
        }
        const recorded = await recordRuntimeMemoryReadyEvidence(db as any, evidence)
        const storedEvidence = await db.queryOne<any>(
          'SELECT valid_until FROM runtime_memory_ready_evidence WHERE id = $1 AND runtime_instance_id = $2',
          [recorded.evidence_id, runtime.id],
        )
        const gate = await evaluateSelectedRuntimeMemoryReadyGate(
          db,
          {
            agent_id: context.agentId,
            expected_agent_id: context.agentId,
            project,
          },
          { runtimeInstanceId: runtime.id, evidenceId: recorded.evidence_id },
          runtimeTuple,
        )
        return { recorded, gate, recovery, validUntil: storedEvidence?.valid_until ?? null }
      })
      evidenceId = result.recorded.evidence_id
      const stableMemoryReadback = {
        evidence_id: evidenceId,
        runtime_instance_id: runtime.id,
        project,
        valid_until: result.validUntil,
        provider_tuple_digest: transport.tupleDigest,
        recovery_response_digest: recovery.responseDigest,
        runtime_tuple_digest: runtimeTupleDigest,
      }
      const mutation = {
        kind: 'memory_readiness' as const,
        owner_key: `memory:${context.runId}:${runtime.id}:${String(evidenceId)}`,
        before_digest: bootstrapDigest({ runtime_before_digest: runtimeBeforeDigest, evidence_absent: true }),
        intended_after_digest: bootstrapDigest({ runtime_tuple_digest: runtimeTupleDigest, recovery: recovery.responseDigest }),
        actual_after_digest: bootstrapDigest(stableMemoryReadback),
        rollback_action: 'expire run-owned memory evidence and stop only a run-owned runtime receipt',
        rollback_payload: {
          runtime_instance_id: runtime.id, runtime_created: runtimeCreated, evidence_id: evidenceId,
          bootstrap_run_id: context.runId, project, recovery_response_digest: recovery.responseDigest, runtime_tuple_digest: runtimeTupleDigest,
          provider_tuple_digest: transport.tupleDigest,
          valid_until: result.validUntil,
          runtime_before_identities: runtimeBeforeIdentities,
        },
      }
      return result.gate.ok
        ? {
            ok: true,
            evidenceRefs: [`memory-ready:${bootstrapDigest(result.gate)}`, `wasurezu-recovery:${recovery.responseDigest}`, `runtime-tuple:${runtimeTupleDigest}`],
            readinessPredicates: { memory_recovery_ready: true, runtime_receipt_present: true, genuine_mcp_recovery: true },
            readbackDigest: bootstrapDigest(stableMemoryReadback),
            mutation,
          }
        : { ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'], evidenceRefs: [`memory-no-go:${bootstrapDigest(result.gate)}`], mutation }
    } catch (err) {
      const observed = runtimeInstanceId ? await withBootstrapDb(env, async (db) => ({
        runtime: await db.queryOne<any>(
          `SELECT runtime_instance_id, agent_id, runtime_engine, session_name, process_id,
                  port, checkout_path, commit_sha, status, metadata
             FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND agent_id = $2`,
          [runtimeInstanceId, context.agentId],
        ),
        evidence: evidenceId === null || evidenceId === undefined ? null : await db.queryOne<any>(
          `SELECT id, project, runtime_instance_id, result_status, valid_until, metadata
             FROM runtime_memory_ready_evidence WHERE id = $1 AND runtime_instance_id = $2`,
          [evidenceId, runtimeInstanceId],
        ),
      })).catch(() => null) : null
      const mutation = runtimeInstanceId && (runtimeCreated || evidenceId !== null) ? {
        kind: 'memory_readiness' as const,
        owner_key: `memory:${context.runId}:${runtimeInstanceId}:${String(evidenceId ?? 'none')}`,
        before_digest: bootstrapDigest({ runtime_before_digest: runtimeBeforeDigest, evidence_absent: true }),
        intended_after_digest: runtimeTupleDigest,
        actual_after_digest: observed ? bootstrapDigest(observed) : null,
        rollback_action: 'expire run-owned memory evidence and stop only a run-owned runtime receipt',
        rollback_payload: {
          runtime_instance_id: runtimeInstanceId, runtime_created: runtimeCreated, evidence_id: evidenceId,
          bootstrap_run_id: context.runId, post_error_readback_digest: observed ? bootstrapDigest(observed) : null,
          runtime_before_identities: runtimeBeforeIdentities,
        },
      } : undefined
      const discriminator = err instanceof RuntimeReceiptSelectionError ? err.discriminator : failureDiscriminator
      const errorDigest = err instanceof RuntimeReceiptSelectionError
        ? err.evidenceDigest
        : bootstrapDigest({ discriminator, error_type: err instanceof Error ? err.name : typeof err })
      return {
        ok: false,
        reasonCodes: [mutation
          ? 'NO_GO_POST_MUTATION_READBACK'
          : runtimeInstanceId ? 'NO_GO_MEMORY_RECOVERY' : 'NO_GO_RUNTIME_RECEIPT'],
        evidenceRefs: [`memory-error:${discriminator}:${errorDigest}`],
        mutation,
      }
    }
  }

  const memoryReadback = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
    const project = env.AGENT_MEMORY_PROJECT || env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(context.workspaceRoot)
    const mutation = context.priorState.mutations.find((item) => item.kind === 'memory_readiness')
    try {
      const mutationPayload = mutation?.rollback_payload ?? {}
      const selectedRuntimeInstanceId = String(
        mutationPayload.runtime_instance_id ?? env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID ?? '',
      ).trim()
      const readbackProfile = selectedRuntimeInstanceId ? await profileGet(context.agentId) : null
      const releaseContextTuple = selectedRuntimeInstanceId
        ? expectedRuntimeReceiptTuple(context, env, readbackProfile)
        : null
      const boundTupleDigest = typeof mutationPayload.runtime_tuple_digest === 'string'
        ? mutationPayload.runtime_tuple_digest
        : null
      let expectedTuple = releaseContextTuple
      let selectedRuntimeRowPresent = false
      let selectedRuntimeTupleDigest: string | null = null
      let currentProviderIdentityMatches = false
      let tupleBindingMatches = !mutation
      let tupleBindingSource: 'release_context' | 'bound_runtime_receipt' = 'release_context'
      if (mutation && selectedRuntimeInstanceId && releaseContextTuple && boundTupleDigest) {
        const selected = await withBootstrapDb(env, (db) => db.queryOne<any>(
          `SELECT agent_id, runtime_engine, runtime_kind, session_name, process_id,
                  port, checkout_path, commit_sha, status, metadata
             FROM agent_runtime_instances
            WHERE runtime_instance_id = $1 AND agent_id = $2`,
          [selectedRuntimeInstanceId, context.agentId],
        ), { readonly: true })
        selectedRuntimeRowPresent = Boolean(selected)
        const metadata = parseJsonRecord(selected?.metadata)
        const selectedTuple: RuntimeReceiptTuple | null = selected
          && selected.runtime_kind === 'bootstrap_bound_provider'
          && (selected.status === 'running' || selected.status === 'active')
          && typeof selected.checkout_path === 'string' && selected.checkout_path.trim()
          && typeof selected.commit_sha === 'string' && /^[0-9a-f]{40}$/.test(selected.commit_sha)
          ? {
              agent_id: String(selected.agent_id),
              runtime_engine: String(selected.runtime_engine) as BootstrapResolvedRuntime,
              session_name: String(selected.session_name),
              process_id: Number(selected.process_id),
              port: Number(selected.port),
              checkout_path: realpathOrResolve(selected.checkout_path),
              commit_sha: selected.commit_sha,
            }
          : null
        selectedRuntimeTupleDigest = selectedTuple ? bootstrapDigest(selectedTuple) : null
        currentProviderIdentityMatches = Boolean(selectedTuple)
          && selectedTuple!.agent_id === releaseContextTuple.agent_id
          && selectedTuple!.runtime_engine === releaseContextTuple.runtime_engine
          && selectedTuple!.session_name === releaseContextTuple.session_name
          && selectedTuple!.process_id === releaseContextTuple.process_id
          && selectedTuple!.port === releaseContextTuple.port
        tupleBindingMatches = currentProviderIdentityMatches
          && selectedRuntimeTupleDigest === boundTupleDigest
          && metadata.tuple_digest === boundTupleDigest
        if (tupleBindingMatches) {
          expectedTuple = selectedTuple
          tupleBindingSource = 'bound_runtime_receipt'
        }
      }
      if ((mutation && !selectedRuntimeInstanceId)
        || (selectedRuntimeInstanceId && (!expectedTuple || !tupleBindingMatches))) {
        return {
          ok: false,
          reasonCodes: [mutation ? 'NO_GO_POST_MUTATION_READBACK' : 'NO_GO_RUNTIME_RECEIPT'],
          evidenceRefs: [`memory-readback:runtime_receipt_input_invalid:${bootstrapDigest({
            runtime_instance_id: selectedRuntimeInstanceId,
            profile_present: Boolean(readbackProfile),
            session_present: Boolean(env.AUN_BOOTSTRAP_TMUX_SESSION || readbackProfile?.tmux_session),
            port_valid: Number.isInteger(Number(env.AUN_BOOTSTRAP_CHANNEL_PORT || readbackProfile?.channel_port))
              && Number(env.AUN_BOOTSTRAP_CHANNEL_PORT || readbackProfile?.channel_port) > 0,
            provider_pid_valid: Number.isInteger(Number(env.AUN_BOOTSTRAP_PROVIDER_PID))
              && Number(env.AUN_BOOTSTRAP_PROVIDER_PID) > 1,
            runtime_present: Boolean(context.resolvedRuntime),
            commit_present: Boolean(context.repoHead),
            tuple_binding_present: Boolean(boundTupleDigest),
            tuple_binding_matches: tupleBindingMatches,
            tuple_binding_source: tupleBindingSource,
            selected_runtime_row_present: selectedRuntimeRowPresent,
            selected_runtime_tuple_digest: selectedRuntimeTupleDigest,
            current_provider_identity_matches: currentProviderIdentityMatches,
          })}`],
        }
      }
      const gate = await withBootstrapDb(env, (db) => evaluateSelectedRuntimeMemoryReadyGate(
        db,
        {
          agent_id: context.agentId,
          expected_agent_id: context.agentId,
          project,
        },
        selectedRuntimeInstanceId
          ? {
              runtimeInstanceId: selectedRuntimeInstanceId,
              evidenceId: mutationPayload.evidence_id as string | number | null | undefined,
            }
          : null,
        expectedTuple ?? undefined,
      ))
      if (!env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID && gate.ok && gate.runtime_instance_id) {
        env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID = gate.runtime_instance_id
      }
      const runtimeMatches = Boolean(env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID)
        && gate.runtime_instance_id === env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID
      let mutationMatches = true
      if (mutation) {
        const payload = mutation.rollback_payload ?? {}
        const evidence = await withBootstrapDb(env, (db) => db.queryOne<any>(
          `SELECT id, project, runtime_instance_id, result_status, valid_until, metadata
             FROM runtime_memory_ready_evidence
            WHERE id = $1 AND runtime_instance_id = $2`,
          [payload.evidence_id, payload.runtime_instance_id],
        ))
        const metadata = parseJsonRecord(evidence?.metadata)
        const nativeTransport = await readConfiguredWasurezuTransport(context, run)
        const readbackDigest = bootstrapDigest({
          evidence_id: evidence?.id ?? null,
          runtime_instance_id: evidence?.runtime_instance_id ?? null,
          project: evidence?.project ?? null,
          valid_until: evidence?.valid_until ?? null,
          provider_tuple_digest: metadata.provider_tuple_digest ?? null,
          recovery_response_digest: metadata.recovery_response_digest ?? null,
          runtime_tuple_digest: metadata.runtime_tuple_digest ?? null,
        })
        mutationMatches = evidence?.result_status === 'ready'
          && metadata.bootstrap_run_id === payload.bootstrap_run_id
          && Boolean(evidence?.valid_until) && Date.parse(String(evidence.valid_until)) > Date.now()
          && nativeTransport?.tupleDigest === payload.provider_tuple_digest
          && metadata.provider_tuple_digest === payload.provider_tuple_digest
          && readbackDigest === mutation.actual_after_digest
      }
      return gate.ok && runtimeMatches && mutationMatches
        ? {
            ok: true,
            evidenceRefs: [
              `memory-readback:${bootstrapDigest(gate)}`,
              `memory-runtime-binding:${tupleBindingSource}:${selectedRuntimeTupleDigest ?? bootstrapDigest(expectedTuple ?? {})}`,
            ],
            readinessPredicates: { memory_recovery_ready: true, runtime_receipt_present: true },
            readbackDigest: mutation?.actual_after_digest ?? bootstrapDigest(gate),
          }
        : {
            ok: false,
            reasonCodes: [mutation
              ? 'NO_GO_POST_MUTATION_READBACK'
              : gate.runtime_instance_id ? 'NO_GO_MEMORY_RECOVERY' : 'NO_GO_RUNTIME_RECEIPT'],
            evidenceRefs: [`memory-readback-no-go:${bootstrapDigest(gate)}`],
          }
    } catch (err) {
      return {
        ok: false,
        reasonCodes: [mutation ? 'NO_GO_POST_MUTATION_READBACK' : 'NO_GO_MEMORY_RECOVERY'],
        evidenceRefs: [`memory-readback-error:${bootstrapDigest(String(err))}`],
      }
    }
  }

  return {
    async lockAndSnapshot(context) {
      const dirty = await run('git', ['status', '--porcelain'], { ...commandOptions(context, 10_000), cwd: context.repoRoot })
      if (dirty.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_PRESTATE_UNREADABLE'] }
      return {
        ok: true,
        evidenceRefs: [`prestate:${bootstrapDigest({ repo_head: context.repoHead, dirty: dirty.stdout })}`],
        readinessPredicates: { state_journal_mode_0600: true, safe_d1_defaults_planned: true },
        readbackDigest: bootstrapDigest({ repo_head: context.repoHead, dirty: dirty.stdout }),
      }
    },

    async dependencyPreflight(context) {
      const common = await Promise.all([
        run(bunPath, ['--version'], commandOptions(context, 10_000)),
        run('node', ['--version'], commandOptions(context, 10_000)),
        run('git', ['--version'], commandOptions(context, 10_000)),
        run('tmux', ['-V'], commandOptions(context, 10_000)),
        run('launchctl', ['help'], commandOptions(context, 10_000)),
      ])
      if (common.slice(0, 3).some((result) => result.exitCode !== 0)) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }
      if (!executableVersionOk(common[0].stdout + common[0].stderr, 1) || !executableVersionOk(common[1].stdout + common[1].stderr, 20)) {
        return { ok: false, reasonCodes: ['NO_GO_VERSION_UNSUPPORTED'] }
      }
      if (common[3].exitCode !== 0 || common[4].exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }
      let tmuxIdentity = `${explicitTmuxSession}:${explicitTmuxPane}`
      if (!explicitTmuxSessionProvided && !explicitTmuxPaneProvided) {
        const callerTmux = await run(
          'tmux', ['display-message', '-p', '#S:#I.#P'], commandOptions(context, 10_000),
        )
        if (callerTmux.exitCode !== 0 || !callerTmux.stdout.trim()) {
          return { ok: false, reasonCodes: ['NO_GO_IDENTITY_MISMATCH'] }
        }
        tmuxIdentity = callerTmux.stdout.trim()
        const [tmuxSession, tmuxPane] = tmuxIdentity.split(':', 2)
        env.AUN_BOOTSTRAP_TMUX_SESSION = tmuxSession
        env.AUN_BOOTSTRAP_TMUX_PANE = tmuxPane ?? env.TMUX_PANE ?? ''
      }

      profileBefore = await profileGetReadOnly(context.agentId)
      const controllerSignals = await processRuntimeSignals(
        run,
        repoRoot,
        env,
        !(explicitTmuxSessionProvided && explicitTmuxPaneProvided),
      )
      let signals = controllerSignals
      const authorityEvidenceRefs: string[] = []
      let targetAuthority: TargetRuntimeAuthority | null = null
      if (explicitTmuxSessionProvided && explicitTmuxPaneProvided) {
        delete env.AUN_BOOTSTRAP_PROVIDER_PID
        targetAuthority = await resolveExplicitTargetRuntimeAuthority({
          run,
          context,
          repoRoot,
          env,
          session: explicitTmuxSession,
          pane: explicitTmuxPane,
        })
        authorityEvidenceRefs.push(targetAuthority.evidenceRef)
        authorityEvidenceRefs.push(`runtime-authority:controller-evidence-only:${bootstrapDigest(controllerSignals)}`)
        if (!targetAuthority.ok) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_IDENTITY_MISMATCH'],
            evidenceRefs: authorityEvidenceRefs,
          }
        }
        signals = targetAuthority.signals
      }
      const profileSignal = profileRuntimeSignal(profileBefore)
      if (profileSignal) signals.push(profileSignal)
      const selection = selectBootstrapRuntime(context.requestedRuntime, signals)
      if (!selection.ok || !selection.runtime) return { ok: false, reasonCodes: [selection.reason] }
      if (targetAuthority?.ok) {
        const providerPid = targetAuthority.providerPids[selection.runtime]
        if (!providerPid) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_IDENTITY_MISMATCH'],
            evidenceRefs: [
              ...authorityEvidenceRefs,
              `runtime-authority:target_runtime_mismatch:${bootstrapDigest({
                selected_runtime: selection.runtime,
                available_runtime_digests: Object.keys(targetAuthority.providerPids).map(bootstrapDigest),
              })}`,
            ],
          }
        }
        env.AUN_BOOTSTRAP_PROVIDER_PID = String(providerPid)
      }
      const liveRuntimes = [...new Set(signals.filter((signal) => signal.source === 'process_identity' && signal.verified).map((signal) => signal.runtime))]
      if (liveRuntimes.length === 1) env.AUN_BOOTSTRAP_PROCESS_RUNTIME = liveRuntimes[0]
      else delete env.AUN_BOOTSTRAP_PROCESS_RUNTIME
      const provider = await adapters[selection.runtime].dependencyPreflight({ ...context, resolvedRuntime: selection.runtime, env })
      if (!provider.ok) return provider
      return {
        ok: true,
        resolvedRuntime: selection.runtime,
        evidenceRefs: [
          `runtime-selection:${bootstrapDigest(selection)}`,
          ...authorityEvidenceRefs,
          ...(provider.evidenceRefs ?? []),
        ],
        readinessPredicates: { dependencies_present: true, supervisor_capable: true, runtime_unambiguous: true },
        readbackDigest: bootstrapDigest({
          runtime: selection.runtime,
          tmux_identity: tmuxIdentity,
          provider_readback_digest: provider.readbackDigest ?? null,
          provider_executable: realpathOrResolve(selection.runtime),
          config_scope: selection.runtime === 'claude' ? 'user' : 'native-default',
        }),
      }
    },

    async migrateDatabase(context) {
      if (context.dryRun) return { ok: true, evidenceRefs: ['db-migration:planned'], readinessPredicates: { migration_plan_safe: true } }
      const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
      const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
      const sqlitePath = realpathOrResolve(env.AGENT_COM_SQLITE_PATH || join(repoRoot, 'agent-com.db'))
      const sqliteExisted = !postgres && existsSync(sqlitePath)
      if (sqliteExisted && sqliteHasSidecars(sqlitePath)) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      const beforeBytes = sqliteExisted ? readFileSync(sqlitePath) : null
      const beforeByteDigest = beforeBytes ? bootstrapDigest(beforeBytes) : null
      const postgresBefore = postgres ? await postgresSchemaDigest().catch(() => null) : null
      if (postgres && !postgresBefore) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      const before = postgres ? postgresBefore : sqliteExisted ? sqliteArtifactDigest(sqlitePath) : null
      const beforeIdentity = sqliteExisted ? sqliteFileIdentity(sqlitePath) : null
      const beforeMode = beforeIdentity?.mode ?? null
      const backupPath = join(bootstrapStateRoot(home, env), context.agentId, `${context.runId}.sqlite.before`)
      if (beforeBytes) {
        mkdirSync(join(bootstrapStateRoot(home, env), context.agentId), { recursive: true, mode: 0o700 })
        writeFileSync(backupPath, beforeBytes, { mode: 0o600 })
        chmodSync(backupPath, 0o600)
      }
      const databaseMutation = (afterDigest: string | null) => ({
        kind: 'db' as const,
        owner_key: `db:${context.runId}`,
        before_digest: before,
        intended_after_digest: afterDigest,
        actual_after_digest: afterDigest,
        rollback_action: postgres
          ? 'preserve shared PostgreSQL schema; delete or expire exact bootstrap-run-owned rows and prove inactive absence'
          : sqliteExisted
            ? 'restore exact owner-protected SQLite backup only under post-state digest fence'
            : 'remove exact run-created SQLite file only under realpath and post-state digest fence',
        rollback_payload: postgres
          ? {
              backend: 'postgres', shared: true, bootstrap_run_id: context.runId,
              endpoint_digest: bootstrapDigest(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp'),
              migration_ledger_digest: bootstrapDigest(readFileSync(join(repoRoot, 'db', 'migrate.ts'))),
              configuration_migration_digest: bootstrapDigest(readFileSync(join(
                repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql',
              ))),
              schema_before_digest: before,
              schema_after_digest: afterDigest,
              bootstrap_owned_row_keys: [{ key: 'bootstrap_run_id', value: context.runId }],
            }
          : {
              backend: 'sqlite', path: sqlitePath, before_exists: sqliteExisted, created_by_run: !sqliteExisted,
              before_digest: before, before_byte_digest: beforeByteDigest, before_mode: beforeMode, before_identity: beforeIdentity,
              backup_path: sqliteExisted ? backupPath : null, after_digest: afterDigest,
              after_identity: existsSync(sqlitePath) ? sqliteFileIdentity(sqlitePath) : null,
            },
      })
      const result = await run(bunPath, ['db/migrate.ts'], commandOptions(context, 120_000))
      if (result.exitCode !== 0) {
        const observedAfter = await currentDatabaseStageDigest()
        const observedMutation = observedAfter !== before ? databaseMutation(observedAfter) : undefined
        return {
          ok: false,
          reasonCodes: observedMutation
            ? ['NO_GO_POST_MUTATION_READBACK']
            : [/destructive/i.test(result.stderr) ? 'NO_GO_DESTRUCTIVE_MIGRATION_GATE' : 'NO_GO_DB_MIGRATION'],
          evidenceRefs: [`db-post-command-readback:${bootstrapDigest({ exit: result.exitCode, before, after: observedAfter })}`],
          readbackDigest: bootstrapDigest(observedAfter ?? { absent: true }),
          mutation: observedMutation,
        }
      }
      const configurationMigration = join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql')
      const configurationMigrationSql = postgres ? readFileSync(configurationMigration, 'utf8') : ''
      const applyConfigurationMigration = async (): Promise<BootstrapCommandResult> => {
        try {
          const applied = await withBootstrapDb(env, async (db) => db.execute(configurationMigrationSql))
          return {
            exitCode: 0,
            stdout: JSON.stringify({ row_count: applied.rowCount, migration_digest: bootstrapDigest(configurationMigrationSql) }),
            stderr: '',
          }
        } catch (error) {
          return { exitCode: 1, stdout: '', stderr: `configuration migration failed:${bootstrapDigest(String(error))}` }
        }
      }
      if (postgres) {
        const paired = await applyConfigurationMigration()
        if (paired.exitCode !== 0) {
          const observedAfter = await currentDatabaseStageDigest()
          return {
            ok: false,
            reasonCodes: observedAfter !== before ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_DB_MIGRATION'],
            evidenceRefs: [`configuration-migration-post-command-readback:${bootstrapDigest({ exit: paired.exitCode, before, after: observedAfter })}`],
            readbackDigest: bootstrapDigest(observedAfter ?? { absent: true }),
            mutation: observedAfter !== before ? databaseMutation(observedAfter) : undefined,
          }
        }
      }
      const idempotency = postgres
        ? await applyConfigurationMigration()
        : await run(bunPath, ['db/migrate.ts'], commandOptions(context, 120_000))
      if (idempotency.exitCode !== 0) {
        const observedAfter = await currentDatabaseStageDigest()
        const observedMutation = observedAfter !== before ? databaseMutation(observedAfter) : undefined
        return {
          ok: false,
          reasonCodes: observedMutation ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_DB_MIGRATION'],
          evidenceRefs: [`db-idempotency-post-command-readback:${bootstrapDigest({ exit: idempotency.exitCode, before, after: observedAfter })}`],
          readbackDigest: bootstrapDigest(observedAfter ?? { absent: true }),
          mutation: observedMutation,
        }
      }
      const after = postgres
        ? await postgresSchemaDigest().catch(() => null)
        : sqliteArtifactDigest(sqlitePath)
      if (!after) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      return {
        ok: true,
        evidenceRefs: [`db-migration:${after}`, `db-migration-idempotency:${bootstrapDigest(idempotency.stdout)}`],
        readinessPredicates: { migration_complete: true, migration_idempotent: true },
        readbackDigest: after,
        mutation: postgres || before !== after ? databaseMutation(after) : undefined,
      }
    },

    async ensureAgentProfile(context) {
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      const existing = context.dryRun && !databaseAlreadyExists() ? profileBefore : await profileGet(context.agentId)
      const tmuxAuthority = await resolveTmuxAuthority(context, existing?.tmux_session)
      if (!tmuxAuthority.ok) {
        return { ok: false, reasonCodes: ['NO_GO_IDENTITY_MISMATCH'], evidenceRefs: [tmuxAuthority.evidenceRef] }
      }
      const session = tmuxAuthority.session
      const port = await choosePort(run, context, existing)
      if (!port) return { ok: false, reasonCodes: ['NO_GO_PORT_CONFLICT'] }
      env.AUN_BOOTSTRAP_CHANNEL_PORT = String(port)
      const desired = {
        runtime: 'TUI', runtime_engine_preference: context.resolvedRuntime,
        home_directory: context.workspaceRoot, channel_port: port, tmux_session: session, profile_enabled: true,
      }
      const matches = existing
        && existing.runtime === desired.runtime
        && existing.runtime_engine_preference === desired.runtime_engine_preference
        && resolve(existing.home_directory ?? '') === resolve(desired.home_directory)
        && Number(existing.channel_port) === port
        && existing.tmux_session === session
        && existing.profile_enabled === true
      if (context.dryRun) {
        if (existing && !matches) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_PROFILE_CONFLICT'],
            evidenceRefs: [tmuxAuthority.evidenceRef, `profile-mismatch:${bootstrapDigest({ existing: managedProfile(existing), desired })}`],
          }
        }
        return {
          ok: true,
          evidenceRefs: [tmuxAuthority.evidenceRef, `profile-plan:${bootstrapDigest(desired)}`],
          readinessPredicates: { profile_plan_unambiguous: true },
        }
      }
      if (matches) {
        let workspaceAuthority: Awaited<ReturnType<typeof ensureActivePrimaryWorkspace>>
        try { workspaceAuthority = await ensureActivePrimaryWorkspace(context) } catch (error) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
            evidenceRefs: [`workspace-authority-error:${bootstrapDigest(String(error))}`],
          }
        }
        let configuration: Awaited<ReturnType<typeof ensureConfigurationDesiredState>>
        try { configuration = await ensureConfigurationDesiredState(context) } catch (error) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
            evidenceRefs: [`configuration-desired-error:${bootstrapDigest(String(error))}`],
          }
        }
        const configurationReadback = configurationDesiredReadback(configuration)
        const workspaceMutation = workspaceAuthority.mutation
        const workspaceReadback = {
          workspace_id: workspaceAuthority.workspace_id,
          canonical_path: workspaceAuthority.canonical_path,
        }
        return {
          ok: true,
          evidenceRefs: [
            tmuxAuthority.evidenceRef,
            `profile-existing:${bootstrapDigest(existing)}`,
            `workspace-authority:${bootstrapDigest(workspaceReadback)}`,
            ...(configuration ? [`configuration-desired:${configuration.desired_revision}:${configuration.desired_digest}`] : []),
          ],
          readinessPredicates: {
            profile_readback_matches: true,
            configuration_desired_state_ready: configuration !== null || env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite',
          },
          readbackDigest: bootstrapDigest({ profile: managedProfile(existing), workspace: workspaceReadback, configuration: configurationReadback }),
          mutations: workspaceMutation && configuration?.mutation ? [workspaceMutation] : undefined,
          mutation: configuration?.mutation ?? workspaceMutation,
        }
      }
      if (existing) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_PROFILE_CONFLICT'],
          evidenceRefs: [tmuxAuthority.evidenceRef, `profile-mismatch:${bootstrapDigest({ existing: managedProfile(existing), desired })}`],
        }
      }
      const applied = await run(bunPath, [
        'cli/index.ts', 'agent', 'profile', 'set', context.agentId,
        '--runtime', 'TUI', '--runtime-engine', context.resolvedRuntime!,
        '--home-directory', context.workspaceRoot, '--channel-port', String(port),
        '--tmux-session', session, '--enabled', 'true', '--execute',
      ], commandOptions(context, 120_000))
      const readback = await profileGet(context.agentId)
      const actualProfile = managedProfile(readback)
      const actualDigest = actualProfile ? bootstrapDigest(actualProfile) : null
      const observedMutation = actualProfile ? {
        kind: 'profile' as const,
        owner_key: `profile:${context.runId}:${context.agentId}`,
        before_digest: bootstrapDigest({ absent: true }),
        intended_after_digest: bootstrapDigest(desired), actual_after_digest: actualDigest,
        rollback_action: 'disable only the exact profile created by this run and verify native readback',
        rollback_payload: { created_by_run: true, profile_digest: actualDigest },
      } : undefined
      if (applied.exitCode !== 0) return {
        ok: false,
        reasonCodes: observedMutation ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_PROFILE_CONFLICT'],
        evidenceRefs: [`profile-post-command-readback:${bootstrapDigest({ exit: applied.exitCode, actual: actualProfile })}`],
        readbackDigest: bootstrapDigest(actualProfile ?? { absent: true }),
        mutation: observedMutation,
      }
      if (!readback || readback.runtime_engine_preference !== context.resolvedRuntime || Number(readback.channel_port) !== port) {
        return {
          ok: false,
          reasonCodes: observedMutation ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_IDENTITY_MISMATCH'],
          readbackDigest: bootstrapDigest(actualProfile ?? { absent: true }),
          mutation: observedMutation,
        }
      }
      let workspaceAuthority: Awaited<ReturnType<typeof ensureActivePrimaryWorkspace>>
      try { workspaceAuthority = await ensureActivePrimaryWorkspace(context) } catch (error) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
          evidenceRefs: [`workspace-authority-error:${bootstrapDigest(String(error))}`],
          mutation: observedMutation,
        }
      }
      let configuration: Awaited<ReturnType<typeof ensureConfigurationDesiredState>>
      try { configuration = await ensureConfigurationDesiredState(context) } catch (error) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
          evidenceRefs: [`configuration-desired-error:${bootstrapDigest(String(error))}`],
          mutation: observedMutation,
        }
      }
      const configurationReadback = configurationDesiredReadback(configuration)
      const workspaceReadback = {
        workspace_id: workspaceAuthority.workspace_id,
        canonical_path: workspaceAuthority.canonical_path,
      }
      return {
        ok: true,
        evidenceRefs: [
          tmuxAuthority.evidenceRef,
          `profile-readback:${bootstrapDigest(readback)}`,
          `workspace-authority:${bootstrapDigest(workspaceReadback)}`,
          ...(configuration ? [`configuration-desired:${configuration.desired_revision}:${configuration.desired_digest}`] : []),
        ],
        readinessPredicates: {
          profile_readback_matches: true,
          endpoint_allocated: true,
          configuration_desired_state_ready: configuration !== null || env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite',
        },
        readbackDigest: bootstrapDigest({ profile: managedProfile(readback), workspace: workspaceReadback, configuration: configurationReadback }),
        mutations: [observedMutation, workspaceAuthority.mutation, configuration?.mutation]
          .filter((mutation): mutation is NonNullable<typeof mutation> => Boolean(mutation)),
      }
    },

    async ensureMcpRegistration(context) {
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      if (context.dryRun) return adapter.planMcpRegistration(context)
      return adapter.applyMcpRegistration(context)
    },

    ensureMemoryReadiness: memoryGate,

    async installAndStartDaemon(context) {
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      const runtimePlan = await adapter.planRuntimeStart(context)
      if (!runtimePlan.ok) return runtimePlan
      const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
      const before = await readDaemonNativeState(context)
      const beforeDigest = bootstrapDigest(before)
      if (!context.dryRun && before.launch_loaded && !before.plist_exists) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_PRESTATE_UNREADABLE'],
          evidenceRefs: [`daemon-loaded-without-plist:${beforeDigest}`],
          readbackDigest: beforeDigest,
        }
      }
      if (!context.dryRun && before.plist_exists && !safeD1FromPlist(home)) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_INSTALL_PLAN'],
          evidenceRefs: [`daemon-preexisting-unsafe:${beforeDigest}`],
          readbackDigest: beforeDigest,
        }
      }
      if (!context.dryRun && before.plist_exists && before.launch_loaded) {
        if (before.launch_safe_d1_digest !== bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_INSTALL_PLAN'],
            evidenceRefs: [`daemon-live-environment-unsafe:${beforeDigest}`],
            readbackDigest: beforeDigest,
          }
        }
        const existing = await run(bunPath, stateDaemonReadinessArgs(), commandOptions(context, 30_000))
        const existingJson = parseJsonOutput(existing)
        return existing.exitCode === 0 && existingJson?.ok
          ? {
              ok: true,
              evidenceRefs: [`daemon-existing:${bootstrapDigest({ native: before, readiness: existingJson })}`],
              readinessPredicates: { daemon_started: true, process_identity_matches: true, daemon_preexisting_unchanged: true },
              readbackDigest: beforeDigest,
            }
          : {
              ok: false,
              reasonCodes: ['NO_GO_INSTALL_PLAN'],
              evidenceRefs: [`daemon-preexisting-mismatch:${bootstrapDigest({ native: before, readiness_exit: existing.exitCode })}`],
              readbackDigest: beforeDigest,
            }
      }
      const backupPath = join(bootstrapStateRoot(home, env), context.agentId, `${context.runId}.daemon.before.plist`)
      if (!context.dryRun && before.plist_exists) {
        mkdirSync(join(bootstrapStateRoot(home, env), context.agentId), { recursive: true, mode: 0o700 })
        writeFileSync(backupPath, readFileSync(plistPath), { mode: 0o600 })
        chmodSync(backupPath, 0o600)
      }
      const args = [
        'scripts/state-daemon-launchagent.ts', 'restore', '--commit', context.repoHead ?? '',
        '--bootstrap-safe-defaults',
        ...(env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite'
          ? ['--sqlite-path', realpathOrResolve(env.AGENT_COM_SQLITE_PATH || join(repoRoot, 'agent-com.db'))]
          : ['--database-url', env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp']),
        ...(context.dryRun ? [] : ['--execute']),
      ]
      const result = await run(bunPath, args, commandOptions(context, 120_000))
      if (context.dryRun) return { ok: true, evidenceRefs: [`daemon-plan:${bootstrapDigest(result.stdout)}`], readinessPredicates: { install_plan_go: true, d1_safe_defaults_planned: true } }
      const after = await readDaemonNativeState(context)
      const afterDigest = bootstrapDigest(after)
      const changed = afterDigest !== beforeDigest
      const mutation = changed ? {
        kind: 'daemon' as const,
        owner_key: `launchd:${context.runId}:${context.agentId}:${STATE_DAEMON_PLIST_NAME}`,
        before_digest: beforeDigest,
        intended_after_digest: bootstrapDigest(args),
        actual_after_digest: afterDigest,
        rollback_action: 'restore exact captured plist/load pre-state or prove exact run-created absence',
        rollback_payload: {
          created_by_run: !before.plist_exists && !before.launch_loaded,
          bootstrap_run_id: context.runId,
          agent_id: context.agentId,
          plist_path: plistPath,
          backup_path: before.plist_exists ? backupPath : null,
          before_state: before,
          before_state_digest: beforeDigest,
          after_state: after,
          after_state_digest: afterDigest,
          launch_domain: daemonDomain,
          launch_label: daemonLabel,
        },
      } : undefined
      if (result.exitCode !== 0) return {
        ok: false,
        reasonCodes: mutation ? ['NO_GO_POST_MUTATION_READBACK'] : ['NO_GO_DAEMON_START'],
        evidenceRefs: [`daemon-post-command-readback:${bootstrapDigest({ exit: result.exitCode, before, after })}`],
        readbackDigest: afterDigest,
        mutation,
      }
      const identity = await adapter.verifyRuntimeIdentity(context)
      const exactAfter = after.plist_exists && after.launch_loaded
        && after.safe_d1_digest === bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)
        && after.launch_safe_d1_digest === bootstrapDigest(BOOTSTRAP_SAFE_D1_DEFAULTS)
      if (!identity.ok || !exactAfter) return {
        ok: false,
        reasonCodes: mutation ? ['NO_GO_POST_MUTATION_READBACK'] : (identity.reasonCodes ?? ['NO_GO_DAEMON_START']),
        evidenceRefs: [`daemon-post-command-invalid:${afterDigest}`, ...(identity.evidenceRefs ?? [])],
        readbackDigest: afterDigest,
        mutation,
      }
      return {
        ok: true,
        evidenceRefs: [`daemon-start:${bootstrapDigest(result.stdout)}`, `daemon-native:${afterDigest}`, ...(identity.evidenceRefs ?? [])],
        readinessPredicates: { daemon_started: true, process_identity_matches: true },
        readbackDigest: afterDigest,
        mutation,
      }
    },

    async runQueueSmoke(context) {
      if (context.dryRun) return { ok: true, evidenceRefs: ['queue-smoke:planned'], readinessPredicates: { no_effect_smoke_planned: true } }
      const runtimeInstanceId = env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID
      if (!runtimeInstanceId) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_RECEIPT'] }
      const envelope = await withBootstrapDb(env, (db) => enqueueBootstrapQueueSmoke(db as any, {
        agentId: context.agentId,
        runId: context.runId,
        messageId: randomUUID(),
        runtimeInstanceId,
        observerPid: process.pid,
      }))
      const consumerEnv = {
        ...env,
        AGENT_ID: context.agentId,
        AGENT_COM_EXPECTED_AGENT_ID: context.agentId,
        AUN_RECEIVE_CLAIM_SOURCE: envelope.claim_source,
        AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID: runtimeInstanceId,
      }
      const commands: string[][] = [
        ['bin/aun.ts', 'receive', '--agent-id', context.agentId, '--queue-id', envelope.queue_id],
        ['bin/aun.ts', 'processing', '--agent-id', context.agentId, '--queue-id', envelope.queue_id],
        ['bin/aun.ts', 'record-no-reply', '--agent-id', context.agentId, '--queue-id', envelope.queue_id, '--reason', `aun-bootstrap-no-effect:${context.runId}`],
      ]
      const consumer: BootstrapQueueSmokeConsumerEvidence = { pids: [], exit_codes: [], stdout_digests: [] }
      const smokeStarted = performance.now()
      for (const args of commands) {
        const remainingMs = 30_000 - (performance.now() - smokeStarted)
        if (remainingMs <= 0) break
        const result = await run(bunPath, args, {
          cwd: repoRoot, env: consumerEnv, timeoutMs: Math.max(1, remainingMs), signal: context.abortSignal,
        })
        if (result.pid) consumer.pids.push(result.pid)
        consumer.exit_codes.push(result.exitCode)
        consumer.stdout_digests.push(bootstrapDigest(result.stdout))
        if (result.exitCode !== 0) break
      }
      queueSmokeEvidence = await withBootstrapDb(env, (db) => observeBootstrapQueueSmoke(db as any, envelope, consumer))
      if (!queueSmokeEvidence.ok) {
        const mapped: BootstrapReasonCode[] = queueSmokeEvidence.reason_codes.map((code) =>
          code.startsWith('NO_GO_DUPLICATE_CLAIM') ? 'NO_GO_DUPLICATE_CLAIM'
            : code.startsWith('NO_GO_SMOKE_NOT_TERMINAL') ? 'NO_GO_SMOKE_NOT_TERMINAL'
              : code.startsWith('NO_GO_QUEUE_ENQUEUE') ? 'NO_GO_QUEUE_ENQUEUE'
                : code.startsWith('NO_GO_QUEUE_ORDINARY_RECEIVE_UNPROVEN') ? 'NO_GO_QUEUE_ORDINARY_RECEIVE_UNPROVEN'
                  : 'NO_GO_QUEUE_NO_PROGRESS')
        return { ok: false, reasonCodes: mapped }
      }
      const queueReadbackDigest = await queueStageReadbackDigest(
        queueSmokeEvidence.queue_id, context.agentId, context.runId, runtimeInstanceId,
      )
      if (!queueReadbackDigest) return { ok: false, reasonCodes: ['NO_GO_QUEUE_ORDINARY_RECEIVE_UNPROVEN'] }
      return {
        ok: true,
        evidenceRefs: [`queue-smoke:${bootstrapDigest(queueSmokeEvidence)}`],
        readinessPredicates: {
          enqueue_once: queueSmokeEvidence.enqueue_count === 1,
          claim_at_most_once: queueSmokeEvidence.claim_count <= 1,
          terminal_once: queueSmokeEvidence.terminal_outcome_count === 1,
          duplicate_effect_zero: queueSmokeEvidence.duplicate_effect_count === 0,
          external_effect_zero: queueSmokeEvidence.external_effect_count === 0,
        },
        readbackDigest: queueReadbackDigest,
        mutation: {
          kind: 'queue_smoke', owner_key: `queue:${queueSmokeEvidence.queue_id}`,
          before_digest: null, intended_after_digest: bootstrapDigest({ status: 'done' }),
          actual_after_digest: bootstrapDigest(queueSmokeEvidence), rollback_action: 'none: exact smoke row is already terminal',
        },
      }
    },

    async readbackReady(context) {
      if (context.dryRun) return { ok: true, evidenceRefs: ['ready-readback:planned'], readinessPredicates: { all_readbacks_planned: true } }
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      const profile = await profileGet(context.agentId)
      if (profile) {
        env.AUN_BOOTSTRAP_CHANNEL_PORT = String(profile.channel_port ?? '')
        env.AUN_BOOTSTRAP_TMUX_SESSION = String(profile.tmux_session ?? '')
      }
      const [mcp, runtimeIdentity, memory, daemon, daemonNative] = await Promise.all([
        adapter.readbackMcpRegistration(context),
        adapter.verifyRuntimeIdentity(context),
        memoryReadback(context),
        run(bunPath, stateDaemonReadinessArgs(), commandOptions(context, 30_000)),
        readDaemonNativeState(context),
      ])
      const safeD1 = safeD1FromPlist(home)
      const daemonJson = parseJsonOutput(daemon)
      let queueReady = Boolean(queueSmokeEvidence?.ok)
      let queueReadbackDigest: string | null = null
      if (queueSmokeEvidence?.ok) {
        const runtimeId = context.priorState.readback_bindings?.runtime_instance_id
          ?? env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID ?? ''
        queueReadbackDigest = await queueStageReadbackDigest(
          queueSmokeEvidence.queue_id, context.agentId,
          context.priorState.readback_bindings?.source_run_id ?? context.priorState.run_id,
          runtimeId,
        )
        queueReady = Boolean(queueReadbackDigest)
      }
      if (!queueReady) {
        const queueMutation = context.priorState.mutations.find((mutation) => mutation.kind === 'queue_smoke')
        const queueId = queueMutation?.owner_key.startsWith('queue:')
          ? queueMutation.owner_key.slice('queue:'.length)
          : context.priorState.readback_bindings?.queue_id ?? null
        if (queueId) {
          queueReady = await withBootstrapDb(env, async (db) => {
            const row = await db.queryOne<any>(
              `SELECT message_id, payload, status, claimed_by, claimed_at, done_at
                 FROM message_queue WHERE id = $1 AND agent_id = $2`,
              [queueId, context.agentId],
            )
            const payload = parseJsonRecord(row?.payload)
            const sourceRunId = context.priorState.readback_bindings?.source_run_id ?? context.priorState.run_id
            const runtimeId = context.priorState.readback_bindings?.runtime_instance_id
            const outbound = row?.message_id
              ? await db.query<any>('SELECT id FROM outbound_queue WHERE message_id = $1 LIMIT 1', [row.message_id]).catch(() => [])
              : []
            return row?.status === 'done'
              && row?.claimed_by === context.agentId && Boolean(row?.claimed_at) && Boolean(row?.done_at)
              && payload.bootstrap_run_id === sourceRunId
              && payload.runtime_instance_id === runtimeId
              && payload.receive_claim?.source === `aun-bootstrap:${sourceRunId}:${runtimeId}`
              && payload.terminal_baton?.no_reply_required === true
              && outbound.length === 0
          }).catch(() => false)
          if (queueReady) {
            queueReadbackDigest = await queueStageReadbackDigest(
              String(queueId), context.agentId,
              context.priorState.readback_bindings?.source_run_id ?? context.priorState.run_id,
              context.priorState.readback_bindings?.runtime_instance_id ?? '',
            )
            queueReady = Boolean(queueReadbackDigest)
          }
        }
      }
      const ok = mcp.ok && runtimeIdentity.ok && memory.ok && Boolean(profile) && daemon.exitCode === 0
        && Boolean(daemonJson?.ok) && daemonNative.launch_loaded && queueReady && Boolean(safeD1)
      if (!ok) {
        const codes: BootstrapReasonCode[] = []
        if (!mcp.ok) codes.push('NO_GO_MCP_READBACK')
        if (!runtimeIdentity.ok) codes.push('NO_GO_IDENTITY_MISMATCH')
        if (!memory.ok) codes.push(...(memory.reasonCodes ?? ['NO_GO_MEMORY_RECOVERY']))
        if (!profile) codes.push('NO_GO_IDENTITY_MISMATCH')
        if (daemon.exitCode !== 0 || !daemonJson?.ok) codes.push('NO_GO_DAEMON_START')
        if (!queueReady) codes.push('NO_GO_QUEUE_NO_PROGRESS')
        if (!safeD1) codes.push('NO_GO_READY_PREDICATE_FALSE')
        return { ok: false, reasonCodes: [...new Set(codes)] }
      }
      let configuration: Awaited<ReturnType<typeof recordBootstrapConfigurationReady>> = null
      try {
        const nativeConfigurationEvidence = {
          providerNativeDigest: mcp.readbackDigest ?? '',
          launchagentPlistDigest: daemonNative.plist_digest ?? '',
          launchctlEnvironmentDigest: daemonNative.launch_safe_d1_digest ?? '',
          runtimeIdentityDigest: runtimeIdentity.readbackDigest
            ?? bootstrapDigest(runtimeIdentity.readinessPredicates ?? {}),
        }
        configuration = await recordBootstrapConfigurationReady(context, nativeConfigurationEvidence)
      } catch (error) {
        return {
          ok: false,
          reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
          evidenceRefs: [`configuration-first-reconcile-error:${bootstrapDigest(String(error))}`],
        }
      }
      const configurationMutation = configuration && !configuration.idempotent ? {
        kind: 'configuration' as const,
        owner_key: `configuration:${context.runId}:${configuration.hostId}:${context.agentId}`,
        before_digest: bootstrapDigest(configuration.previousObservedState ?? { absent: true }),
        intended_after_digest: bootstrapDigest({
          host_id: configuration.hostId,
          agent_id: context.agentId,
          desired_revision: configuration.desiredRevision,
          desired_digest: configuration.desiredDigest,
          candidate_digest: configuration.candidateDigest,
        }),
        actual_after_digest: bootstrapDigest({
          host_id: configuration.hostId,
          agent_id: context.agentId,
          desired_revision: configuration.desiredRevision,
          desired_digest: configuration.desiredDigest,
          candidate_digest: configuration.candidateDigest,
        }),
        rollback_action: 'restore the exact prior observed projection and re-hold only the exact run desired event',
        rollback_payload: {
          host_id: configuration.hostId,
          agent_id: context.agentId,
          desired_revision: configuration.desiredRevision,
          desired_digest: configuration.desiredDigest,
          candidate_digest: configuration.candidateDigest,
          outbox_event_id: configuration.outboxEventId,
          previous_observed_state: configuration.previousObservedState,
        },
      } : undefined
      const providerMutation = context.priorState.mutations.find((mutation) =>
        mutation.kind === 'mcp_registration' && mutation.stage === 'B4_MCP_REGISTRATION')
      if (providerMutation && providerMutation.rollback_payload?.backup_retained === true
        && adapter.finalizeRuntimeRegistration) {
        const finalized = await adapter.finalizeRuntimeRegistration(context, providerMutation)
        if (!finalized.ok) {
          return {
            ...finalized,
            mutation: configurationMutation,
          }
        }
      }
      return {
        ok: true,
        evidenceRefs: [
          ...(mcp.evidenceRefs ?? []), ...(memory.evidenceRefs ?? []),
          `profile-final:${bootstrapDigest(profile)}`, `daemon-final:${bootstrapDigest(daemonJson)}`,
          `d1-safe-final:${bootstrapDigest(safeD1)}`,
          ...(configuration ? [`configuration-first-reconcile:${configuration.desiredRevision}:${configuration.candidateDigest}`] : []),
        ],
        readinessPredicates: {
          identity_ready: true, mcp_ready: true, memory_ready: true,
          process_endpoint_ready: true, queue_progress_ready: true, safe_d1_readback: true,
          configuration_reconciler_handoff_ready:
            configuration !== null || env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite',
        },
        readbackDigest: bootstrapDigest({
          mcp: mcp.readbackDigest ?? null,
          runtime_identity: runtimeIdentity.readbackDigest ?? bootstrapDigest(runtimeIdentity.readinessPredicates ?? {}),
          memory: memory.readbackDigest ?? null,
          profile: bootstrapDigest(managedProfile(profile)),
          daemon: bootstrapDigest(daemonNative),
          queue: queueReadbackDigest,
          safe_d1: bootstrapDigest(safeD1),
          configuration,
        }),
        mutation: configurationMutation,
      }
    },

    async revalidateStage(context, stage) {
      if (stage === 'B0_LOCK_AND_SNAPSHOT' || stage === 'B1_DEPENDENCY_PREFLIGHT') return { ok: true }
      if (stage === 'B2_DB_MIGRATION') {
        const mutation = context.priorState.mutations.find((item) => item.stage === stage && item.kind === 'db')
        const recordedEvidence = context.priorState.stages.find((item) => item.stage === stage)
          ?.evidence_refs.find((ref) => ref.startsWith('db-migration:'))
        const expectedDigest = mutation?.actual_after_digest ?? recordedEvidence?.slice('db-migration:'.length)
        const currentDigest = await currentDatabaseStageDigest()
        return Boolean(expectedDigest) && currentDigest === expectedDigest
          ? { ok: true, evidenceRefs: [`resume-db-readback:${currentDigest}`], readbackDigest: currentDigest! }
          : { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
      }
      if (stage === 'B3_AGENT_PROFILE') {
        const profile = await profileGet(context.agentId)
        const workspace = await readActivePrimaryWorkspaceAuthority(context)
        const configuration = await configurationDesiredReadOnly(context.agentId)
        const mutation = context.priorState.mutations.find((item) => item.stage === stage && item.kind === 'profile')
        const digestMatches = !mutation || mutation.actual_after_digest === bootstrapDigest(managedProfile(profile))
        const ok = Boolean(profile) && Boolean(workspace)
          && profile.runtime_engine_preference === context.resolvedRuntime
          && resolve(profile.home_directory ?? '') === resolve(context.workspaceRoot)
          && profile.tmux_session === env.AUN_BOOTSTRAP_TMUX_SESSION
          && profile.profile_enabled === true
          && digestMatches
        if (ok) env.AUN_BOOTSTRAP_CHANNEL_PORT = String(profile.channel_port)
        return ok ? {
          ok: true,
          evidenceRefs: [`resume-profile-readback:${bootstrapDigest(profile)}`],
          readbackDigest: bootstrapDigest({ profile: managedProfile(profile), workspace, configuration }),
        } : { ok: false, reasonCodes: ['NO_GO_RESUME_REVALIDATION'] }
      }
      if (stage === 'B4_MCP_REGISTRATION') {
        const adapter = adapterFor(context)
        return adapter ? adapter.readbackMcpRegistration(context) : { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      }
      if (stage === 'B5_MEMORY_READINESS') return memoryReadback(context)
      if (stage === 'B6_ORDINARY_DAEMON_INSTALL_START') {
        const native = await readDaemonNativeState(context)
        const nativeDigest = bootstrapDigest(native)
        const daemon = await run(bunPath, stateDaemonReadinessArgs(), commandOptions(context, 30_000))
        return daemon.exitCode === 0 && parseJsonOutput(daemon)?.ok && Boolean(safeD1FromPlist(home)) && native.launch_loaded
          ? { ok: true, evidenceRefs: [`resume-daemon-readback:${nativeDigest}`], readbackDigest: nativeDigest }
          : { ok: false, reasonCodes: ['NO_GO_RESUME_REVALIDATION'] }
      }
      if (stage === 'B7_QUEUE_SMOKE') {
        const mutation = context.priorState.mutations.find((item) => item.stage === stage && item.kind === 'queue_smoke')
        const queueId = mutation?.owner_key.split(':').at(-1) ?? context.priorState.readback_bindings?.queue_id
        if (!queueId) return { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
        const ok = await withBootstrapDb(env, async (db) => {
          const row = await db.queryOne<any>('SELECT payload, status, claimed_by, claimed_at, done_at FROM message_queue WHERE id = $1 AND agent_id = $2', [queueId, context.agentId])
          const payload = row ? JSON.parse(String(row.payload ?? '{}')) : {}
          return row?.status === 'done' && row?.claimed_by === context.agentId && Boolean(row?.claimed_at) && Boolean(row?.done_at)
            && payload?.bootstrap_run_id === context.runId
            && payload?.runtime_instance_id === env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID
            && payload?.terminal_baton?.no_reply_required === true
        }).catch(() => false)
        const runtimeId = env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID ?? ''
        const digest = ok ? await queueStageReadbackDigest(String(queueId), context.agentId, context.runId, runtimeId) : null
        return ok && digest
          ? { ok: true, evidenceRefs: [`resume-queue-readback:${queueId}`], readbackDigest: digest }
          : { ok: false, reasonCodes: ['NO_GO_RESUME_REVALIDATION'] }
      }
      return { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
    },

    async rollbackMutation(context, mutation) {
      const adapter = adapterFor(context)
      if (mutation.kind === 'mcp_registration' && adapter) return adapter.rollbackRuntimeRegistration(context, mutation)
      if (mutation.kind === 'workspace_authority') {
        const payload = mutation.rollback_payload ?? {}
        const workspaceId = String(payload.workspace_id ?? '')
        const canonicalPath = String(payload.canonical_path ?? '')
        const project = String(payload.project ?? '')
        const workspaceCreated = payload.workspace_created === true
        const workspacePreimageDigest = payload.workspace_preimage_digest === null
          ? null
          : String(payload.workspace_preimage_digest ?? '')
        const bindingPreimage = payload.binding_preimage && typeof payload.binding_preimage === 'object'
          ? payload.binding_preimage as Record<string, unknown>
          : null
        const runtimePreimages = Array.isArray(payload.runtime_preimages)
          ? payload.runtime_preimages.map(normalizedRuntimeLink)
          : []
        const preservedBindingsPreimage = Array.isArray(payload.preserved_bindings_preimage)
          ? payload.preserved_bindings_preimage.map(normalizedWorkspaceBinding)
          : []
        const preservedRuntimesPreimage = Array.isArray(payload.preserved_runtimes_preimage)
          ? payload.preserved_runtimes_preimage.map(normalizedRuntimeLink)
          : []
        const preservedReferenceDigest = String(payload.preserved_reference_digest ?? '')
        const beforeProjectionDigest = String(payload.before_projection_digest ?? '')
        const intendedProjectionDigest = String(payload.intended_projection_digest ?? '')
        const expectedOwner = `workspace-authority:${context.runId}:${context.agentId}:${workspaceId}`
        if (payload.schema_version !== 'aun-bootstrap-workspace-authority-rollback/v1'
          || payload.bootstrap_run_id !== context.runId || payload.agent_id !== context.agentId
          || mutation.owner_key !== expectedOwner || !workspaceId || !canonicalPath || !project
          || !bindingPreimage || typeof bindingPreimage.existed !== 'boolean'
          || !/^[0-9a-f]{64}$/.test(preservedReferenceDigest)
          || !/^[0-9a-f]{64}$/.test(beforeProjectionDigest)
          || !/^[0-9a-f]{64}$/.test(intendedProjectionDigest)
          || mutation.before_digest !== beforeProjectionDigest
          || mutation.intended_after_digest !== intendedProjectionDigest
          || (!workspaceCreated && !/^[0-9a-f]{64}$/.test(workspacePreimageDigest ?? ''))) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const restored = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
          const agent = await tx.queryOne<{ agent_id: string }>(
            'SELECT agent_id FROM agents WHERE agent_id = $1 FOR UPDATE', [context.agentId],
          )
          if (!agent) throw new Error('workspace rollback agent unavailable')
          const readWorkspace = async () => normalizedWorkspaceRow(await tx.queryOne<any>(
            `SELECT workspace_id, org_id, name, workspace_type, local_path, repo_url,
                    default_branch, metadata, created_at, updated_at
               FROM agent_workspaces WHERE workspace_id = $1 FOR UPDATE`,
            [workspaceId],
          ))
          const readBinding = async () => normalizedWorkspaceBinding(await tx.queryOne<any>(
            `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
               FROM agent_workspace_bindings
              WHERE agent_id = $1 AND workspace_id = $2 AND binding_role = 'primary'
              FOR UPDATE`,
            [context.agentId, workspaceId],
          ))
          const runtimeIds = new Set(runtimePreimages.map((row) => row.runtime_instance_id))
          const readRuntimeLinks = async () => (runtimeIds.size === 0 ? [] : (await tx.query<any>(
            `SELECT runtime_instance_id, agent_id, workspace_id
               FROM agent_runtime_instances WHERE agent_id = $1 ORDER BY runtime_instance_id`,
            [context.agentId],
          )).map(normalizedRuntimeLink).filter((row) => runtimeIds.has(row.runtime_instance_id)))
          const readPreservedReferences = async () => {
            const bindings = (await tx.query<any>(
              `SELECT agent_id, workspace_id, binding_role, active, created_at, updated_at
                 FROM agent_workspace_bindings
                WHERE workspace_id = $1
                  AND NOT (agent_id = $2 AND binding_role = 'primary')
                ORDER BY agent_id, binding_role`,
              [workspaceId, context.agentId],
            )).map(normalizedWorkspaceBinding)
            const runtimes = (await tx.query<any>(
              `SELECT runtime_instance_id, agent_id, workspace_id
                 FROM agent_runtime_instances WHERE workspace_id = $1 ORDER BY runtime_instance_id`,
              [workspaceId],
            )).map(normalizedRuntimeLink).filter((row) =>
              row.agent_id !== context.agentId || !runtimeIds.has(row.runtime_instance_id))
            return { bindings, runtimes }
          }
          const currentWorkspace = await readWorkspace()
          const currentBinding = await readBinding()
          const currentRuntimeLinks = await readRuntimeLinks()
          const currentPreserved = await readPreservedReferences()
          const currentPreservedDigest = bootstrapDigest(currentPreserved)
          const preBinding = bindingPreimage.existed === true ? {
            agent_id: context.agentId,
            workspace_id: workspaceId,
            binding_role: 'primary',
            active: bindingPreimage.active === true,
          } : null
          const beforeProjection = workspaceAuthorityProjection({
            workspaceId, canonicalPath, workspaceCreated: false,
            workspaceRowDigest: workspacePreimageDigest,
            binding: preBinding,
            runtimeLinks: runtimePreimages,
            preservedReferenceDigest: currentPreservedDigest,
            bootstrapRunId: context.runId,
            project,
          })
          const currentIsPreimage = (workspaceCreated ? currentWorkspace === null
            : bootstrapDigest(currentWorkspace) === workspacePreimageDigest)
            && (bindingPreimage.existed === true
              ? bootstrapDigest(currentBinding) === String(bindingPreimage.row_digest ?? '')
              : currentBinding === null)
            && bootstrapDigest(currentRuntimeLinks) === bootstrapDigest(runtimePreimages)
            && currentPreservedDigest === preservedReferenceDigest
            && bootstrapDigest(beforeProjection) === beforeProjectionDigest
          if (currentIsPreimage) {
            return { noEffect: true, digest: beforeProjectionDigest }
          }

          const intendedBinding = {
            agent_id: context.agentId,
            workspace_id: workspaceId,
            binding_role: 'primary',
            active: true,
          }
          const intendedRuntimeLinks = runtimePreimages.map((row) => ({ ...row, workspace_id: workspaceId }))
          const currentProjection = workspaceAuthorityProjection({
            workspaceId, canonicalPath, workspaceCreated,
            workspaceRowDigest: workspacePreimageDigest,
            binding: currentBinding,
            runtimeLinks: currentRuntimeLinks,
            preservedReferenceDigest: currentPreservedDigest,
            bootstrapRunId: context.runId,
            project,
          })
          if (!currentWorkspace || !currentBinding?.active
            || bootstrapDigest(currentProjection) !== intendedProjectionDigest
            || currentPreservedDigest !== preservedReferenceDigest
            || bootstrapDigest(currentRuntimeLinks) !== bootstrapDigest(intendedRuntimeLinks)) {
            throw new Error('workspace rollback postimage fence mismatch')
          }
          if (workspaceCreated) {
            const metadata = parseJsonRecord(currentWorkspace.metadata)
            if (metadata.bootstrap_run_id !== context.runId || metadata.agent_id !== context.agentId
              || (payload.workspace_postimage_digest
                && bootstrapDigest(currentWorkspace) !== String(payload.workspace_postimage_digest))) {
              throw new Error('workspace rollback ownership fence mismatch')
            }
          } else if (bootstrapDigest(currentWorkspace) !== workspacePreimageDigest) {
            throw new Error('workspace rollback shared row changed')
          }
          if (payload.binding_postimage_digest
            && bootstrapDigest(currentBinding) !== String(payload.binding_postimage_digest)) {
            throw new Error('workspace rollback binding postimage mismatch')
          }

          for (const runtime of runtimePreimages) {
            const unlinked = await tx.execute(
              `UPDATE agent_runtime_instances SET workspace_id = $3
                WHERE runtime_instance_id = $1 AND agent_id = $2 AND workspace_id = $4`,
              [runtime.runtime_instance_id, context.agentId, runtime.workspace_id, workspaceId],
            )
            if (unlinked.rowCount !== 1) throw new Error('workspace rollback runtime link fence rejected')
          }
          if (bindingPreimage.existed === true) {
            if (bindingPreimage.active !== true) {
              const restoredBinding = await tx.execute(
                `UPDATE agent_workspace_bindings SET active = false
                  WHERE agent_id = $1 AND workspace_id = $2 AND binding_role = 'primary' AND active = true`,
                [context.agentId, workspaceId],
              )
              if (restoredBinding.rowCount !== 1) throw new Error('workspace rollback binding restore rejected')
            }
          } else {
            const removedBinding = await tx.execute(
              `DELETE FROM agent_workspace_bindings
                WHERE agent_id = $1 AND workspace_id = $2 AND binding_role = 'primary' AND active = true`,
              [context.agentId, workspaceId],
            )
            if (removedBinding.rowCount !== 1) throw new Error('workspace rollback binding removal rejected')
          }
          if (workspaceCreated) {
            const removedWorkspace = await tx.execute(
              `DELETE FROM agent_workspaces WHERE workspace_id = $1 AND org_id = 'default' AND local_path = $2`,
              [workspaceId, canonicalPath],
            )
            if (removedWorkspace.rowCount !== 1) throw new Error('workspace rollback workspace removal rejected')
          }
          const finalWorkspace = await readWorkspace()
          const finalBinding = await readBinding()
          const finalRuntimeLinks = await readRuntimeLinks()
          const finalPreserved = await readPreservedReferences()
          const finalPreservedDigest = bootstrapDigest(finalPreserved)
          const exact = (workspaceCreated ? finalWorkspace === null
            : bootstrapDigest(finalWorkspace) === workspacePreimageDigest)
            && (bindingPreimage.existed === true
              ? bootstrapDigest(finalBinding) === String(bindingPreimage.row_digest ?? '')
              : finalBinding === null)
            && bootstrapDigest(finalRuntimeLinks) === bootstrapDigest(runtimePreimages)
            && finalPreservedDigest === preservedReferenceDigest
            && bootstrapDigest(finalPreserved.bindings) === bootstrapDigest(preservedBindingsPreimage)
            && bootstrapDigest(finalPreserved.runtimes) === bootstrapDigest(preservedRuntimesPreimage)
          if (!exact) throw new Error('workspace rollback exact preimage readback mismatch')
          return { noEffect: false, digest: beforeProjectionDigest }
        })).catch((error) => ({ error: bootstrapDigest(String(error)) }))
        if ('error' in restored) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`workspace-authority-rollback-failed:${restored.error}`],
          }
        }
        return {
          ok: true,
          readinessPredicates: {
            rollback_verified: true,
            recovery_admission_no_effect: restored.noEffect,
            foreign_shared_rows_unchanged: true,
          },
          evidenceRefs: [`workspace-authority-rollback:${bootstrapDigest({
            workspace_id: workspaceId,
            no_effect: restored.noEffect,
            final_digest: restored.digest,
          })}`],
          readbackDigest: restored.digest,
        }
      }
      if (mutation.kind === 'daemon'
        && mutation.owner_key === `launchd:${context.runId}:${context.agentId}:${STATE_DAEMON_PLIST_NAME}`) {
        const plist = String(mutation.rollback_payload?.plist_path ?? '')
        const payload = mutation.rollback_payload ?? {}
        const beforeState = payload.before_state as DaemonNativeState | undefined
        const expectedAfterDigest = String(payload.after_state_digest ?? '')
        if (!plist || !beforeState || payload.bootstrap_run_id !== context.runId || payload.agent_id !== context.agentId
          || payload.launch_domain !== daemonDomain || payload.launch_label !== daemonLabel) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const live = await readDaemonNativeState(context)
        if (bootstrapDigest(live) !== expectedAfterDigest || mutation.actual_after_digest !== expectedAfterDigest) {
          return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`daemon-rollback-poststate-fence-mismatch:${bootstrapDigest(live)}`],
          }
        }
        if (live.launch_loaded) {
          const bootout = await run('launchctl', ['bootout', daemonDomain, plist], commandOptions(context, 30_000))
          if (bootout.exitCode !== 0) return {
            ok: false,
            reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
            evidenceRefs: [`daemon-rollback-bootout-failed:${bootout.exitCode}`],
          }
        }
        if (payload.created_by_run === true) {
          rmSync(plist, { force: true })
        } else {
          const backup = String(payload.backup_path ?? '')
          if (!beforeState.plist_exists || !backup || !existsSync(backup)
            || bootstrapDigest(readFileSync(backup)) !== beforeState.plist_digest) {
            return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
          const restoreTemp = `${plist}.${context.runId}.restore.tmp`
          rmSync(restoreTemp, { force: true })
          try {
            writeFileSync(restoreTemp, readFileSync(backup), { mode: Number(beforeState.plist_mode) })
            chmodSync(restoreTemp, Number(beforeState.plist_mode))
            renameSync(restoreTemp, plist)
          } finally {
            rmSync(restoreTemp, { force: true })
          }
          if (beforeState.launch_loaded) {
            const restored = await run('launchctl', ['bootstrap', daemonDomain, plist], commandOptions(context, 30_000))
            if (restored.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
        }
        const finalState = await readDaemonNativeState(context)
        const expectedFinal = payload.created_by_run === true
          ? {
              ...beforeState,
              plist_exists: false, plist_digest: null, plist_mode: null,
              launch_loaded: false, launch_pid: null,
              safe_d1_digest: null, launch_safe_d1_digest: null,
            }
          : beforeState
        const ok = bootstrapDigest(finalState) === bootstrapDigest(expectedFinal)
        return ok
          ? {
              ok: true,
              readinessPredicates: { rollback_verified: true },
              evidenceRefs: [`daemon-rollback-native-readback:${bootstrapDigest(finalState)}`],
              readbackDigest: bootstrapDigest(finalState),
            }
          : {
              ok: false,
              reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
              evidenceRefs: [`daemon-rollback-final-mismatch:${bootstrapDigest({ expected: expectedFinal, actual: finalState })}`],
            }
      }
      if (mutation.kind === 'queue_smoke') return {
        ok: true,
        readinessPredicates: { terminal_smoke_retained: true },
        readbackDigest: mutation.actual_after_digest ?? bootstrapDigest({ terminal_smoke_retained: true }),
      }
      if (mutation.kind === 'configuration_desired') {
        const payload = mutation.rollback_payload ?? {}
        if (mutation.owner_key !== `configuration-desired:${context.runId}:${context.agentId}`
          || payload.created_by_run !== true) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        let artifactReadback: ReturnType<typeof readConfigurationDesiredArtifact>
        try {
          artifactReadback = readConfigurationDesiredArtifact(
            payload.rollback_artifact_identity,
            payload.rollback_artifact_digest,
          )
        } catch {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const { artifact, identity } = artifactReadback
        const artifactPostDigest = bootstrapDigest({
          agent: configurationDesiredControlledRow(artifact.post_agent_row),
          outbox: artifact.post_outbox_rows,
        })
        const artifactPreDigest = bootstrapDigest({
          agent: configurationDesiredControlledRow(artifact.pre_agent_row),
          outbox: artifact.pre_outbox_rows,
        })
        const admissionOpen = payload.recovery_admission === true && mutation.actual_after_digest === null
        if (artifact.run_id !== context.runId || artifact.agent_id !== context.agentId
          || artifactPostDigest !== (admissionOpen ? mutation.intended_after_digest : mutation.actual_after_digest)
          || artifactPreDigest !== mutation.before_digest) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const restored = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
          const currentAgent = (await tx.queryOne<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1 FOR UPDATE`,
            [context.agentId],
          ))?.row
          const currentOutbox = (await tx.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o
              WHERE agent_id = $1 ORDER BY event_id`,
            [context.agentId],
          )).map((item) => item.row)
          const currentDigest = currentAgent
            ? bootstrapDigest({ agent: configurationDesiredControlledRow(currentAgent), outbox: currentOutbox })
            : null
          if (admissionOpen && currentDigest === artifactPreDigest) {
            return {
              digest: artifactPreDigest,
              compensatingEventCount: 0,
              exactDeleteCount: 0,
              recoveryAdmissionNoEffect: true,
            }
          }
          if (!currentAgent || currentDigest !== artifactPostDigest) {
            throw new Error('configuration desired rollback poststate fence mismatch')
          }
          const currentEventIds = new Set(currentOutbox.map((row) => String(row.event_id)))
          const pre = artifact.pre_agent_row
          await tx.execute(`SELECT set_config('aun.actor_ref', $1, true)`, [`aun-bootstrap-rollback:${context.runId}`])
          const restoredWatched = await tx.execute(
            `UPDATE agents SET
               profile_enabled = $2,
               runtime_engine_preference = $3,
               home_directory = $4,
               canonical_workspace = $5,
               canonical_home = $6,
               channel_port = $7,
               supervisor_identity = $8,
               expected_provider_identity = $9::jsonb,
               expected_provider_identity_ref = $10,
               provider_token_source_ref = $11,
               ordinary_communication_enrollment = $12,
               ordinary_projection = $13::jsonb,
               desired_release_commit = $14,
               desired_release_tree = $15,
               desired_control_refs = $16::jsonb
             WHERE agent_id = $1`,
            [
              context.agentId,
              pre.profile_enabled,
              pre.runtime_engine_preference,
              pre.home_directory,
              pre.canonical_workspace,
              pre.canonical_home,
              pre.channel_port,
              pre.supervisor_identity,
              JSON.stringify(pre.expected_provider_identity ?? {}),
              pre.expected_provider_identity_ref,
              pre.provider_token_source_ref,
              pre.ordinary_communication_enrollment,
              JSON.stringify(pre.ordinary_projection ?? {}),
              pre.desired_release_commit,
              pre.desired_release_tree,
              JSON.stringify(pre.desired_control_refs ?? []),
            ],
          )
          if (restoredWatched.rowCount !== 1) throw new Error('configuration desired watched restore rejected')
          const afterWatchedOutbox = (await tx.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o
              WHERE agent_id = $1 ORDER BY event_id`,
            [context.agentId],
          )).map((item) => item.row)
          const compensatingEvents = afterWatchedOutbox.filter((row) => !currentEventIds.has(String(row.event_id)))
          const expectedCompensatingEventCount = artifact.pre_agent_row.desired_revision === null
            ? 0
            : artifact.new_event_ids.length
          if (compensatingEvents.length !== expectedCompensatingEventCount) {
            throw new Error('configuration desired compensating event cardinality invalid')
          }
          for (const event of compensatingEvents) {
            const desiredRevision = Number(event.desired_revision)
            const desiredDigest = String(event.desired_digest ?? '')
            if (!Number.isSafeInteger(desiredRevision) || !/^[0-9a-f]{64}$/.test(desiredDigest)) {
              throw new Error('configuration desired compensating event identity invalid')
            }
            const held = await tx.execute(
              `UPDATE aun_configuration_desired_outbox SET available_at = 'infinity'::timestamptz
                WHERE event_id = $1 AND agent_id = $2
                  AND desired_revision = $3 AND desired_digest = $4
                  AND delivered_at IS NULL AND attempt_count = 0`,
              [String(event.event_id), context.agentId, desiredRevision, desiredDigest],
            )
            if (held.rowCount !== 1) throw new Error('configuration desired compensating event hold rejected')
          }
          let exactDeleteCount = 0
          const runEvents = artifact.post_outbox_rows.filter((row) => artifact.new_event_ids.includes(String(row.event_id)))
          const exactEvents = [...runEvents, ...compensatingEvents]
          if (exactEvents.length !== artifact.new_event_ids.length + compensatingEvents.length) {
            throw new Error('configuration desired exact event fence cardinality invalid')
          }
          for (const event of exactEvents) {
            const eventId = String(event.event_id)
            const desiredRevision = Number(event.desired_revision)
            const desiredDigest = String(event.desired_digest ?? '')
            const exactReadback = await tx.queryOne<Record<string, unknown>>(
              `SELECT event_id, agent_id, desired_revision, desired_digest, delivered_at, attempt_count, available_at
                 FROM aun_configuration_desired_outbox
                WHERE event_id = $1 AND agent_id = $2 FOR UPDATE`,
              [eventId, context.agentId],
            )
            if (!exactReadback
              || Number(exactReadback.desired_revision) !== desiredRevision
              || String(exactReadback.desired_digest) !== desiredDigest
              || exactReadback.delivered_at !== null
              || Number(exactReadback.attempt_count) !== 0
              || (exactReadback.available_at !== Number.POSITIVE_INFINITY
                && String(exactReadback.available_at).toLowerCase() !== 'infinity')) {
              throw new Error('configuration desired exact event readback fence mismatch')
            }
            const removed = await tx.execute(
              `DELETE FROM aun_configuration_desired_outbox
                WHERE event_id = $1 AND agent_id = $2
                  AND desired_revision = $3 AND desired_digest = $4
                  AND delivered_at IS NULL AND attempt_count = 0
                  AND available_at = 'infinity'::timestamptz`,
              [eventId, context.agentId, desiredRevision, desiredDigest],
            )
            if (removed.rowCount !== 1) throw new Error('configuration desired exact event removal rejected')
            exactDeleteCount += removed.rowCount
          }
          const preMetadata = jsonRecord(pre.metadata)
          const restoredDerived = await tx.execute(
            `UPDATE agents SET
               desired_revision = $2,
               desired_digest = $3,
               desired_updated_at = $4,
               desired_updated_by = $5,
               metadata = CASE WHEN $6::boolean
                 THEN jsonb_set(COALESCE(metadata, '{}'::jsonb), '{codex_home}', to_jsonb($7::text), true)
                 ELSE COALESCE(metadata, '{}'::jsonb) - 'codex_home' END
             WHERE agent_id = $1`,
            [
              context.agentId,
              pre.desired_revision,
              pre.desired_digest,
              pre.desired_updated_at,
              pre.desired_updated_by,
              typeof preMetadata.codex_home === 'string',
              typeof preMetadata.codex_home === 'string' ? preMetadata.codex_home : '',
            ],
          )
          if (restoredDerived.rowCount !== 1) throw new Error('configuration desired derived restore rejected')
          const finalAgent = (await tx.queryOne<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`,
            [context.agentId],
          ))?.row
          const finalOutbox = (await tx.query<{ row: Record<string, unknown> }>(
            `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o
              WHERE agent_id = $1 ORDER BY event_id`,
            [context.agentId],
          )).map((item) => item.row)
          if (!finalAgent
            || bootstrapDigest(configurationDesiredControlledRow(finalAgent))
              !== bootstrapDigest(configurationDesiredControlledRow(artifact.pre_agent_row))
            || bootstrapDigest(finalOutbox) !== bootstrapDigest(artifact.pre_outbox_rows)) {
            throw new Error('configuration desired full preimage restore mismatch')
          }
          return {
            digest: bootstrapDigest({ agent: finalAgent, outbox: finalOutbox }),
            compensatingEventCount: compensatingEvents.length,
            exactDeleteCount,
            recoveryAdmissionNoEffect: false,
          }
        })).catch(() => null)
        if (!restored) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        try { removeConfigurationDesiredArtifact(identity) } catch {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        mutation.rollback_payload = {
          ...payload,
          rollback_artifact_deleted: true,
          rollback_artifact_identity: {
            path_digest: bootstrapDigest(identity.path),
            sha256: identity.sha256,
          },
        }
        return {
          ok: true,
          readinessPredicates: {
            rollback_verified: true,
            rollback_artifact_deleted: true,
            held_run_event_delivery_count: 0,
            compensating_event_count: restored.compensatingEventCount,
            exact_delete_count: restored.exactDeleteCount,
            broad_delete_count: 0,
            trigger_disable_count: 0,
            foreign_event_mutation_count: 0,
            recovery_admission_no_effect: restored.recoveryAdmissionNoEffect,
          },
          evidenceRefs: [`configuration-desired-rollback:${bootstrapDigest({
            final_digest: restored.digest,
            compensating_event_count: restored.compensatingEventCount,
            exact_delete_count: restored.exactDeleteCount,
            broad_delete_count: 0,
            trigger_disable_count: 0,
            foreign_event_mutation_count: 0,
            recovery_admission_no_effect: restored.recoveryAdmissionNoEffect,
          })}`],
          readbackDigest: restored.digest,
        }
      }
      if (mutation.kind === 'configuration') {
        const payload = mutation.rollback_payload ?? {}
        const hostId = String(payload.host_id ?? '')
        const agentId = String(payload.agent_id ?? '')
        const desiredRevision = Number(payload.desired_revision)
        const desiredDigest = String(payload.desired_digest ?? '')
        const candidateDigest = String(payload.candidate_digest ?? '')
        const outboxEventId = payload.outbox_event_id === null || payload.outbox_event_id === undefined
          ? null
          : String(payload.outbox_event_id)
        const previous = payload.previous_observed_state && typeof payload.previous_observed_state === 'object'
          ? payload.previous_observed_state as Record<string, any>
          : null
        if (mutation.owner_key !== `configuration:${context.runId}:${hostId}:${agentId}`
          || agentId !== context.agentId
          || !Number.isSafeInteger(desiredRevision) || desiredRevision < 1
          || !/^[0-9a-f]{64}$/.test(desiredDigest)
          || !/^[0-9a-f]{64}$/.test(candidateDigest)) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const readback = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
          const removed = await tx.execute(
            `DELETE FROM aun_configuration_observed_state
              WHERE host_id = $1 AND agent_id = $2
                AND observed_revision = $3 AND observed_desired_digest = $4
                AND candidate_digest = $5`,
            [hostId, agentId, desiredRevision, desiredDigest, candidateDigest],
          )
          if (removed.rowCount !== 1) throw new Error('configuration rollback fence rejected')
          if (previous) {
            await tx.execute(
              `INSERT INTO aun_configuration_observed_state (
                 host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
                 release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
                 launchctl_environment_digest, runtime_identity_digest, reconcile_status,
                 drift_reason_codes, lease_id, fencing_token, observed_at
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16
               )`,
              [
                previous.host_id, previous.agent_id, previous.observed_revision,
                previous.observed_desired_digest, previous.candidate_digest,
                previous.release_commit, previous.release_tree, previous.provider_native_digest,
                previous.launchagent_plist_digest, previous.launchctl_environment_digest,
                previous.runtime_identity_digest, previous.reconcile_status,
                JSON.stringify(previous.drift_reason_codes ?? []), previous.lease_id,
                previous.fencing_token, previous.observed_at,
              ],
            )
          }
          if (outboxEventId) {
            const restoredEvent = await tx.execute(
              `UPDATE aun_configuration_desired_outbox
                  SET delivered_at = NULL, attempt_count = 0,
                      available_at = 'infinity'::timestamptz
                WHERE event_id = $1 AND agent_id = $2
                  AND desired_revision = $3 AND desired_digest = $4
                  AND delivered_at IS NOT NULL AND attempt_count = 1`,
              [outboxEventId, agentId, desiredRevision, desiredDigest],
            )
            if (restoredEvent.rowCount !== 1) throw new Error('configuration outbox rollback fence rejected')
          }
          const observed = await tx.queryOne<Record<string, unknown>>(
            `SELECT host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
                    release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
                    launchctl_environment_digest, runtime_identity_digest, reconcile_status,
                    drift_reason_codes, lease_id, fencing_token, observed_at
               FROM aun_configuration_observed_state
              WHERE host_id = $1 AND agent_id = $2`,
            [hostId, agentId],
          )
          const event = outboxEventId
            ? await tx.queryOne<any>(
                `SELECT event_id, attempt_count, delivered_at, available_at::text AS available_at_text
                   FROM aun_configuration_desired_outbox WHERE event_id = $1`,
                [outboxEventId],
              )
            : null
          return { observed, event }
        })).catch(() => null)
        const restored = Boolean(readback)
          && (!outboxEventId || (String(readback!.event?.event_id) === outboxEventId
            && Number(readback!.event?.attempt_count) === 0
            && readback!.event?.delivered_at === null
            && readback!.event?.available_at_text === 'infinity'))
          && bootstrapDigest(readback!.observed ?? { absent: true }) === bootstrapDigest(previous ?? { absent: true })
        return restored
          ? {
              ok: true,
              readinessPredicates: { rollback_verified: true },
              readbackDigest: bootstrapDigest({ observed: readback!.observed, outbox_event_held: Boolean(outboxEventId) }),
            }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'memory_readiness') {
        const payload = mutation.rollback_payload ?? {}
        const runtimeId = String(payload.runtime_instance_id ?? '')
        const evidenceId = payload.evidence_id
        const rollback = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
          if (evidenceId !== null && evidenceId !== undefined) {
            const evidence = await tx.queryOne<any>(
              'SELECT result_status, failure_reason, metadata FROM runtime_memory_ready_evidence WHERE id = $1 AND runtime_instance_id = $2',
              [evidenceId, runtimeId],
            )
            const metadata = parseJsonRecord(evidence?.metadata)
            if (!evidence || metadata.bootstrap_run_id !== context.runId) return false
            if (evidence.result_status === 'ready') {
              const expired = await tx.execute(
                `UPDATE runtime_memory_ready_evidence
                    SET result_status = 'failed', failure_reason = 'BOOTSTRAP_ROLLBACK', valid_until = now()
                  WHERE id = $1 AND runtime_instance_id = $2 AND result_status = 'ready'`,
                [evidenceId, runtimeId],
              )
              if (expired.rowCount !== 1) return false
            } else if (evidence.result_status !== 'failed' || evidence.failure_reason !== 'BOOTSTRAP_ROLLBACK') {
              return false
            }
          }
          if (payload.runtime_created === true) {
            const row = await tx.queryOne<any>('SELECT status, workspace_id, metadata FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND agent_id = $2', [runtimeId, context.agentId])
            const metadata = parseJsonRecord(row?.metadata)
            if (metadata.bootstrap_run_id !== context.runId) return false
            if (row?.status === 'running' || row?.status === 'active') {
              const stopped = await tx.execute(
                `UPDATE agent_runtime_instances
                    SET status = 'stopped', stopped_at = now(), last_seen_at = now(), workspace_id = NULL
                  WHERE runtime_instance_id = $1 AND agent_id = $2 AND status IN ('running', 'active')`,
                [runtimeId, context.agentId],
              )
              if (stopped.rowCount !== 1) return false
            } else if (row?.status !== 'stopped') {
              return false
            } else if (row.workspace_id !== null && row.workspace_id !== undefined) {
              const unlinked = await tx.execute(
                `UPDATE agent_runtime_instances SET workspace_id = NULL
                  WHERE runtime_instance_id = $1 AND agent_id = $2 AND status = 'stopped' AND workspace_id = $3`,
                [runtimeId, context.agentId, row.workspace_id],
              )
              if (unlinked.rowCount !== 1) return false
            }
          }
          const evidence = evidenceId === null || evidenceId === undefined
            ? null
            : await tx.queryOne<any>('SELECT result_status, failure_reason FROM runtime_memory_ready_evidence WHERE id = $1', [evidenceId])
          const active = payload.runtime_created === true
            ? await tx.queryOne('SELECT runtime_instance_id FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND status IN (\'running\', \'active\')', [runtimeId])
            : null
          const beforeIdentities = Array.isArray(payload.runtime_before_identities)
            ? payload.runtime_before_identities as Array<{ runtime_instance_id?: unknown; row_digest?: unknown }>
            : []
          const preexistingRuntimeUnchanged = (await Promise.all(beforeIdentities.map(async (identity) => {
            const id = String(identity.runtime_instance_id ?? '')
            const expectedDigest = String(identity.row_digest ?? '')
            if (!id || !expectedDigest) return false
            const row = await tx.queryOne<any>(
              `SELECT runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id,
                      port, checkout_path, commit_sha, status, metadata
                 FROM agent_runtime_instances
                WHERE runtime_instance_id = $1 AND agent_id = $2`,
              [id, context.agentId],
            )
            return Boolean(row) && bootstrapDigest(row) === expectedDigest
          }))).every(Boolean)
          return {
            ok: (!evidence || (evidence.result_status === 'failed' && evidence.failure_reason === 'BOOTSTRAP_ROLLBACK'))
              && !active && preexistingRuntimeUnchanged,
            preexistingRuntimeUnchanged,
          }
        })).catch(() => false)
        return rollback && rollback.ok
          ? {
              ok: true,
              readinessPredicates: { rollback_verified: true, preexisting_runtime_unchanged: rollback.preexistingRuntimeUnchanged },
              readbackDigest: bootstrapDigest({
                runtime_id: runtimeId,
                evidence_id: evidenceId,
                active: false,
                preexisting_runtime_unchanged: rollback.preexistingRuntimeUnchanged,
              }),
            }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'profile') {
        if (mutation.owner_key !== `profile:${context.runId}:${context.agentId}` || mutation.rollback_payload?.created_by_run !== true) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        const current = await profileGet(context.agentId)
        if (!current || bootstrapDigest(managedProfile(current)) !== mutation.rollback_payload.profile_digest) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        const disabled = await run(bunPath, ['cli/index.ts', 'agent', 'profile', 'set', context.agentId, '--enabled', 'false', '--execute'], commandOptions(context, 30_000))
        const readback = await profileGet(context.agentId)
        return disabled.exitCode === 0 && readback?.profile_enabled === false
          ? { ok: true, readinessPredicates: { rollback_verified: true }, readbackDigest: bootstrapDigest(managedProfile(readback)) }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'db') {
        const payload = mutation.rollback_payload ?? {}
        if (payload.backend === 'postgres') {
          if (payload.bootstrap_run_id !== context.runId
            || payload.endpoint_digest !== bootstrapDigest(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp')) {
            return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
          const schemaBeforeCleanup = await postgresSchemaDigest().catch(() => null)
          if (!schemaBeforeCleanup || schemaBeforeCleanup !== payload.schema_after_digest) {
            return {
              ok: false,
              reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
              evidenceRefs: [`postgres-rollback-schema-fence-mismatch:${bootstrapDigest(schemaBeforeCleanup)}`],
            }
          }
          const ledger = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
            const queueBefore = await tx.query<any>(
              `SELECT id, status, payload FROM message_queue ORDER BY id`,
            )
            const ownedQueueBefore = queueBefore.filter((row) => bootstrapRunIdFromQueuePayload(row.payload) === context.runId)
            const sharedQueueBefore = queueBefore.filter((row) => bootstrapRunIdFromQueuePayload(row.payload) !== context.runId)
            const sharedBefore = [
              await tx.query<any>(`SELECT runtime_instance_id, status, metadata FROM agent_runtime_instances
                WHERE COALESCE(metadata->>'bootstrap_run_id', '') <> $1 ORDER BY runtime_instance_id`, [context.runId]),
              await tx.query<any>(`SELECT id, result_status, metadata FROM runtime_memory_ready_evidence
                WHERE COALESCE(metadata->>'bootstrap_run_id', '') <> $1 ORDER BY id`, [context.runId]),
              sharedQueueBefore,
            ]
            const ownedBefore = [
              await tx.query<any>(`SELECT runtime_instance_id, status FROM agent_runtime_instances
                WHERE metadata->>'bootstrap_run_id' = $1 ORDER BY runtime_instance_id`, [context.runId]),
              await tx.query<any>(`SELECT id, result_status FROM runtime_memory_ready_evidence
                WHERE metadata->>'bootstrap_run_id' = $1 ORDER BY id`, [context.runId]),
              ownedQueueBefore.map((row) => ({ id: row.id, status: row.status })),
            ]
            await tx.execute(`UPDATE runtime_memory_ready_evidence
              SET result_status = 'failed', failure_reason = 'BOOTSTRAP_ROLLBACK', valid_until = now()
              WHERE metadata->>'bootstrap_run_id' = $1 AND result_status = 'ready'`, [context.runId])
            await tx.execute(`UPDATE agent_runtime_instances
              SET status = 'stopped', stopped_at = COALESCE(stopped_at, now()), last_seen_at = now()
              WHERE metadata->>'bootstrap_run_id' = $1 AND status IN ('running', 'active')`, [context.runId])
            let exactQueueUpdateCount = 0
            for (const row of ownedQueueBefore) {
              const updated = await tx.execute(`UPDATE message_queue
                SET status = CASE
                      WHEN status IN ('pending', 'read', 'received', 'in_progress') THEN 'skipped'
                      ELSE status
                    END,
                    failed_reason = CASE
                      WHEN status IN ('pending', 'read', 'received', 'in_progress') THEN 'BOOTSTRAP_ROLLBACK'
                      ELSE failed_reason
                    END,
                    done_at = CASE
                      WHEN status IN ('pending', 'read', 'received', 'in_progress') THEN COALESCE(done_at, now())
                      ELSE done_at
                    END,
                    claim_expires_at = now(),
                    payload = jsonb_set(payload::jsonb, '{bootstrap_rollback_expired}', 'true'::jsonb, true)::text
                WHERE id = $1 AND payload = $2`, [row.id, row.payload])
              if (updated.rowCount !== 1) throw new Error('bootstrap queue rollback exact row fence rejected')
              exactQueueUpdateCount += updated.rowCount
            }
            const queueAfter = await tx.query<any>(
              `SELECT id, status, payload FROM message_queue ORDER BY id`,
            )
            const ownedQueueAfter = queueAfter.filter((row) => bootstrapRunIdFromQueuePayload(row.payload) === context.runId)
            const sharedQueueAfter = queueAfter.filter((row) => bootstrapRunIdFromQueuePayload(row.payload) !== context.runId)
            const activeAfter = [
              await tx.query<any>(`SELECT runtime_instance_id FROM agent_runtime_instances
                WHERE metadata->>'bootstrap_run_id' = $1 AND status IN ('running', 'active')`, [context.runId]),
              await tx.query<any>(`SELECT id FROM runtime_memory_ready_evidence
                WHERE metadata->>'bootstrap_run_id' = $1 AND result_status = 'ready'`, [context.runId]),
              ownedQueueAfter
                .filter((row) => ['pending', 'read', 'received', 'in_progress'].includes(String(row.status)))
                .map((row) => ({ id: row.id })),
            ]
            const sharedAfter = [
              await tx.query<any>(`SELECT runtime_instance_id, status, metadata FROM agent_runtime_instances
                WHERE COALESCE(metadata->>'bootstrap_run_id', '') <> $1 ORDER BY runtime_instance_id`, [context.runId]),
              await tx.query<any>(`SELECT id, result_status, metadata FROM runtime_memory_ready_evidence
                WHERE COALESCE(metadata->>'bootstrap_run_id', '') <> $1 ORDER BY id`, [context.runId]),
              sharedQueueAfter,
            ]
            return {
              owned_before_digest: bootstrapDigest(ownedBefore),
              owned_before_counts: ownedBefore.map((rows) => rows.length),
              active_after_counts: activeAfter.map((rows) => rows.length),
              exact_queue_update_count: exactQueueUpdateCount,
              exact_queue_update_expected: ownedQueueBefore.length,
              shared_before_digest: bootstrapDigest(sharedBefore),
              shared_after_digest: bootstrapDigest(sharedAfter),
              shared_unchanged: bootstrapDigest(sharedBefore) === bootstrapDigest(sharedAfter),
            }
          })).catch(() => null)
          const schemaAfterCleanup = await postgresSchemaDigest().catch(() => null)
          const ownedAbsent = Boolean(ledger)
            && ledger!.active_after_counts.every((count) => count === 0)
            && ledger!.exact_queue_update_count === ledger!.exact_queue_update_expected
            && ledger!.shared_unchanged
            && schemaAfterCleanup === schemaBeforeCleanup
          const approvedConfigurationMigration = payload.configuration_migration_digest === bootstrapDigest(readFileSync(join(
            repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql',
          )))
          const sharedSchemaPreserved = payload.schema_before_digest === payload.schema_after_digest
            || (approvedConfigurationMigration && schemaAfterCleanup === payload.schema_after_digest)
          const evidence = `postgres-run-owned-rollback:${bootstrapDigest({ ledger, schemaBeforeCleanup, schemaAfterCleanup, sharedSchemaPreserved })}`
          return ownedAbsent && sharedSchemaPreserved
            ? { ok: true, readinessPredicates: { rollback_verified: true }, evidenceRefs: [evidence], readbackDigest: bootstrapDigest({ ledger, schemaAfterCleanup }) }
            : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'], evidenceRefs: [evidence] }
        }
        if (payload.backend !== 'sqlite') return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        const path = String(payload.path ?? '')
        if (!path || !existsSync(path)
          || !sqliteIdentityMatches(path, payload.after_identity)
          || sqliteArtifactDigest(path) !== payload.after_digest) {
          return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        if (payload.before_exists === true) {
          const backup = String(payload.backup_path ?? '')
          if (!backup || !existsSync(backup) || bootstrapDigest(readFileSync(backup)) !== payload.before_byte_digest) {
            return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
          }
          const restoreTemp = `${path}.${context.runId}.restore.tmp`
          rmSync(restoreTemp, { force: true })
          try {
            writeFileSync(restoreTemp, readFileSync(backup), { mode: Number(payload.before_mode) })
            chmodSync(restoreTemp, Number(payload.before_mode))
            rmSync(`${path}-wal`, { force: true })
            rmSync(`${path}-shm`, { force: true })
            renameSync(restoreTemp, path)
          } finally {
            rmSync(restoreTemp, { force: true })
          }
          const restoredDigest = sqliteFileDigest(path)
          return restoredDigest === payload.before_byte_digest
            && !sqliteHasSidecars(path)
            && (statSync(path).mode & 0o777) === Number(payload.before_mode)
            ? { ok: true, readinessPredicates: { rollback_verified: true }, readbackDigest: bootstrapDigest({ restored_digest: restoredDigest, sidecars_absent: true, mode: Number(payload.before_mode) }) }
            : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        if (payload.created_by_run !== true) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        removeSqliteArtifacts(path)
        const absent = [path, `${path}-wal`, `${path}-shm`].every((candidate) => !existsSync(candidate))
        return absent
          ? { ok: true, readinessPredicates: { rollback_verified: true }, readbackDigest: bootstrapDigest({ path, absent: true }) }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    },
  }
}

export type BootstrapDependencies = {
  stateStore?: BootstrapStateStore
  ports?: BootstrapExecutionPorts
  run?: BootstrapAdapterCommandRunner
  uuid?: () => string
  stageDeadlineMs?: Partial<Record<BootstrapStage, number>>
}

export async function bootstrap(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies = {},
): Promise<BootstrapResult> {
  const agentId = validateBootstrapAgentId(options.agentId)
  if (!['auto', 'codex', 'claude'].includes(options.runtime)) throw new Error('--runtime must be auto, codex, or claude')
  if (options.resumeRunId && options.rollbackRunId) throw new Error('--resume and --rollback are mutually exclusive')
  const env = cleanEnv(options.env ?? process.env)
  const home = options.home ?? env.HOME ?? homedir()
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, '..', '..'))
  const workspaceRoot = resolve(options.workspaceRoot ?? env.AUN_BOOTSTRAP_WORKSPACE ?? process.cwd())
  const runCommand = dependencies.run ?? defaultCommandRunner()
  const repoHead = await findRepoHead(repoRoot, runCommand, env)
  const stateStore = dependencies.stateStore ?? new FileBootstrapStateStore(bootstrapStateRoot(home, env))
  const runId = options.resumeRunId ?? options.rollbackRunId ?? `bootstrap-${(dependencies.uuid ?? randomUUID)()}`
  let state = options.resumeRunId || options.rollbackRunId ? stateStore.load(agentId, runId) : null
  if (state && options.resumeRunId
    && (state.terminal_status === 'NO_GO' || state.terminal_status === 'PARTIAL_ROLLBACK_NO_GO')) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  const requestedRuntimeForDigest = state?.requested_runtime ?? options.runtime
  const rootResolution = await resolveProviderRootAuthority({
    agentId,
    requestedRuntime: requestedRuntimeForDigest,
    env,
    home,
    repoRoot,
  })
  if (rootResolution.ok && rootResolution.authority) {
    // Target Codex commands always receive the canonical root. Caller/TUI
    // values remain evidence-only and cannot fill or override it.
    env.CODEX_HOME = rootResolution.authority.canonicalRoot
  }
  let providerSnapshot: Record<string, unknown> = {}
  let providerSnapshotReason: BootstrapReasonCode | null = null
  if (rootResolution.ok) {
    try {
      providerSnapshot = await providerInputSnapshot({
        requestedRuntime: requestedRuntimeForDigest, repoRoot, home, env, run: runCommand,
      })
    } catch (error) {
      providerSnapshotReason = String((error as Error).message).includes('NO_GO_PROVIDER_NATIVE_JSON_INVALID')
        ? 'NO_GO_PROVIDER_NATIVE_JSON_INVALID'
        : 'NO_GO_MCP_READBACK'
      providerSnapshot = { invalid_provider_snapshot: providerSnapshotReason }
    }
  } else {
    providerSnapshot = { provider_root_authority_error: rootResolution.reasonCode }
  }
  const inputDigest = bootstrapInputDigest({
    agentId, requestedRuntime: requestedRuntimeForDigest, repoRoot, workspaceRoot, repoHead, home, env, providerSnapshot,
  })
  if (!rootResolution.ok || providerSnapshotReason) {
    const failed = state ?? initialState({ runId, agentId, runtime: options.runtime, inputDigest, repoRoot, workspaceRoot, repoHead })
    const reason = !rootResolution.ok ? rootResolution.reasonCode : providerSnapshotReason!
    const record = failed.stages.find((candidate) => candidate.stage === 'B1_DEPENDENCY_PREFLIGHT')!
    record.status = 'failed'
    record.started_at = nowIso()
    record.completed_at = record.started_at
    record.reason_codes = [reason]
    record.evidence_refs = !rootResolution.ok ? [rootResolution.evidenceRef] : [`provider-snapshot:${bootstrapDigest({ reason })}`]
    failed.terminal_status = 'NO_GO'
    return resultFromState(failed, 'B1_DEPENDENCY_PREFLIGHT', 'NO_GO', [reason])
  }
  if ((options.resumeRunId || options.rollbackRunId) && !state) {
    const missing = initialState({ runId, agentId, runtime: options.runtime, inputDigest, repoRoot, workspaceRoot, repoHead })
    return resultFromState(missing, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RUN_NOT_FOUND'])
  }
  if (state && options.runtime !== state.requested_runtime && options.runtime !== state.resolved_runtime) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  if (state && state.mutation_manifest_digest !== bootstrapDigest(state.mutations)) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  if (state && (options.resumeRunId || options.rollbackRunId) && !passedStageSealsAreValid(state)) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_REVALIDATION'])
  }
  if (state && state.input_digest !== inputDigest) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  state ??= initialState({ runId, agentId, runtime: options.runtime, inputDigest, repoRoot, workspaceRoot, repoHead })
  if (options.rollbackRunId && state.resolved_runtime) env.AUN_BOOTSTRAP_PROCESS_RUNTIME = state.resolved_runtime
  const hydrateRunEnvironment = (source: BootstrapRunState) => {
    const memory = [...source.mutations].reverse().find((mutation) => mutation.kind === 'memory_readiness')
    const runtimeId = memory?.rollback_payload?.runtime_instance_id ?? source.readback_bindings?.runtime_instance_id
    if (typeof runtimeId === 'string' && runtimeId) env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID = runtimeId
  }
  hydrateRunEnvironment(state)
  const ports = dependencies.ports ?? createDefaultPorts({ run: runCommand, env, home, repoRoot })
  let lockHeld = false
  const bootstrapStartedAt = performance.now()
  const boundedDeadline = (stage: BootstrapStage, task: (signal: AbortSignal) => Promise<BootstrapStageOutcome>) =>
    withDeadline(
      stage,
      task,
      600_000 - (performance.now() - bootstrapStartedAt),
      dependencies.stageDeadlineMs?.[stage] ?? STAGE_DEADLINE_MS[stage],
    )

  const refreshOwnedRollbackFences = (source: BootstrapRunState): boolean => {
    const sqlite = source.mutations.find((mutation) => mutation.kind === 'db' && mutation.rollback_payload?.backend === 'sqlite')
    const path = typeof sqlite?.rollback_payload?.path === 'string' ? sqlite.rollback_payload.path : null
    if (sqlite && path && existsSync(path)) {
      const expectedIdentity = sqlite.rollback_payload?.after_identity
      const digest = sqliteIdentityMatches(path, expectedIdentity) ? sqliteArtifactDigest(path) : null
      if (!digest) return false
      sqlite.actual_after_digest = digest
      sqlite.rollback_payload = { ...sqlite.rollback_payload, after_digest: digest }
    }
    const memory = [...source.mutations].reverse().find((mutation) => mutation.kind === 'memory_readiness')
    const queue = [...source.mutations].reverse().find((mutation) => mutation.kind === 'queue_smoke')
    source.readback_bindings = {
      source_run_id: source.run_id,
      runtime_instance_id: typeof memory?.rollback_payload?.runtime_instance_id === 'string'
        ? memory.rollback_payload.runtime_instance_id
        : source.readback_bindings?.runtime_instance_id ?? null,
      queue_id: queue?.owner_key.startsWith('queue:')
        ? queue.owner_key.slice('queue:'.length)
        : source.readback_bindings?.queue_id ?? null,
    }
    return true
  }

  if (!options.dryRun) {
    try {
      stateStore.acquireLock(agentId, runId)
      lockHeld = true
    } catch {
      return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_BOOTSTRAP_BUSY'])
    }
  }

  let activeStageForAdmission: BootstrapStage | null = null
  const fsyncRecoveryAdmissionState = () => {
    if (!(stateStore instanceof FileBootstrapStateStore)) return
    const path = join(stateStore.root, validateBootstrapAgentId(agentId), `${runId}.json`)
    const identity = lstatSync(path)
    if (identity.isSymbolicLink() || !identity.isFile() || identity.nlink !== 1) {
      throw new Error('recovery admission journal identity invalid')
    }
    const fd = openSync(path, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    fsyncDirectory(dirname(path))
  }
  const context = (abortSignal?: AbortSignal, priorState: BootstrapRunState = state!): BootstrapStageContext => ({
    runId, agentId, requestedRuntime: state!.requested_runtime, resolvedRuntime: state!.resolved_runtime,
    repoRoot, workspaceRoot, repoHead, dryRun: Boolean(options.dryRun), env, priorState, abortSignal,
    admitRecoveryMutation: options.dryRun ? undefined : (reported) => {
      const stage = activeStageForAdmission
      if (!stage) throw new Error('recovery admission attempted outside an active bootstrap stage')
      const recoveryFields = {
        recovery_admission: true,
        recovery_preimage_readback_fence: reported.before_digest,
        recovery_intended_mutation_fence: reported.intended_after_digest,
        recovery_ownership_predicate_digest: bootstrapDigest({
          stage,
          owner_key: reported.owner_key,
          kind: reported.kind,
          before_digest: reported.before_digest,
          intended_after_digest: reported.intended_after_digest,
          rollback_artifact_identity: reported.rollback_payload?.rollback_artifact_identity
            ?? reported.rollback_payload?.private_backup_identity
            ?? null,
        }),
        rollback_disposition: 'admitted_pending_effect',
      }
      const existing = state!.mutations.find((mutation) => mutation.stage === stage
        && mutation.owner_key === reported.owner_key
        && mutation.rollback_payload?.recovery_admission === true)
      if (existing) {
        Object.assign(existing, reported)
        existing.rollback_payload = {
          ...(reported.rollback_payload ?? {}),
          ...recoveryFields,
        }
      } else {
        state!.mutations.push({
          mutation_id: `${runId}:${stage}:admission:${state!.mutations.length + 1}`,
          stage,
          rollback_status: 'not_run',
          ...reported,
          rollback_payload: {
            ...(reported.rollback_payload ?? {}),
            ...recoveryFields,
          },
        })
      }
      state!.updated_at = nowIso()
      stateStore.save(state!)
      fsyncRecoveryAdmissionState()
    },
    cancelRecoveryAdmission: options.dryRun ? undefined : (ownerKey) => {
      const stage = activeStageForAdmission
      if (!stage) throw new Error('recovery admission cancellation attempted outside an active bootstrap stage')
      const before = state!.mutations.length
      state!.mutations = state!.mutations.filter((mutation) => !(mutation.stage === stage
        && mutation.owner_key === ownerKey
        && mutation.rollback_payload?.recovery_admission === true))
      if (state!.mutations.length === before) throw new Error('recovery admission cancellation target missing')
      state!.updated_at = nowIso()
      stateStore.save(state!)
      fsyncRecoveryAdmissionState()
    },
    providerRootAuthority: rootResolution.authority ?? undefined,
  })

  try {
    if (options.rollbackRunId) {
      let allVerified = true
      for (const mutation of [...state.mutations].reverse()) {
        if (mutation.rollback_status === 'verified' || mutation.rollback_status === 'skipped') continue
        const rollbackStartedAt = nowIso()
        mutation.rollback_status = 'attempting'
        mutation.rollback_payload = {
          ...(mutation.rollback_payload ?? {}),
          rollback_disposition: 'attempting',
          rollback_started_at: rollbackStartedAt,
        }
        state.updated_at = rollbackStartedAt
        stateStore.save(state)
        const outcome = await boundedDeadline(mutation.stage, (signal) => ports.rollbackMutation(context(signal), mutation))
        const rollbackVerified = outcome.ok && Boolean(outcome.readbackDigest)
        mutation.rollback_status = rollbackVerified ? 'verified' : 'failed'
        mutation.rollback_payload = {
          ...(mutation.rollback_payload ?? {}),
          rollback_disposition: rollbackVerified ? 'verified' : 'failed',
          rollback_evidence_refs: outcome.evidenceRefs ?? [],
          rollback_readback_digest: outcome.readbackDigest ?? null,
          rollback_completed_at: nowIso(),
        }
        state.evidence_refs = [...new Set([...state.evidence_refs, ...(outcome.evidenceRefs ?? [])])]
        allVerified &&= rollbackVerified
        if (rollbackVerified && mutation.kind !== 'db') refreshOwnedRollbackFences(state)
        const stageRecord = state.stages.find((record) => record.stage === mutation.stage)
        if (stageRecord?.status === 'passed') stageRecord.seal_digest = stageSealDigest(state, mutation.stage)
        state.updated_at = nowIso()
        stateStore.save(state)
      }
      state.terminal_status = allVerified ? 'ROLLED_BACK' : 'PARTIAL_ROLLBACK_NO_GO'
      state.updated_at = nowIso()
      stateStore.save(state)
      return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', state.terminal_status, allVerified ? [] : ['NO_GO_ROLLBACK_UNVERIFIED'])
    }

    if (options.resumeRunId && state.mutations.some((mutation) => mutation.rollback_payload?.recovery_admission === true)) {
      state.terminal_status = 'NO_GO'
      state.updated_at = nowIso()
      stateStore.save(state)
      return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_REVALIDATION'])
    }

    const priorReady = !options.resumeRunId && !options.dryRun ? stateStore.findLatestReady(agentId, inputDigest) : null
    if (priorReady) {
      if (!passedStageSealsAreValid(priorReady)) {
        return resultFromState(state, 'B1_DEPENDENCY_PREFLIGHT', 'NO_GO', ['NO_GO_RESUME_REVALIDATION'])
      }
      state.resolved_runtime = priorReady.resolved_runtime
      hydrateRunEnvironment(priorReady)
      const preflight = await boundedDeadline('B1_DEPENDENCY_PREFLIGHT', (signal) => ports.dependencyPreflight(context(signal, priorReady)))
      if (preflight.resolvedRuntime) state.resolved_runtime = preflight.resolvedRuntime
      if (!preflight.ok || state.resolved_runtime !== priorReady.resolved_runtime) {
        return resultFromState(state, 'B1_DEPENDENCY_PREFLIGHT', 'NO_GO', preflight.reasonCodes ?? ['NO_GO_RESUME_INPUT_MISMATCH'])
      }
      const readback = await boundedDeadline('B8_READY_READBACK', (signal) => ports.readbackReady(context(signal, priorReady)))
      if (readback.ok) {
        state = structuredClone(priorReady)
        state.run_id = runId
        state.created_at = nowIso()
        state.updated_at = state.created_at
        state.terminal_status = 'IDEMPOTENT_READY'
        state.mutations = []
        state.mutation_manifest_digest = bootstrapDigest([])
        state.readback_bindings ??= {
          source_run_id: priorReady.run_id,
          runtime_instance_id: null,
          queue_id: null,
        }
        state.evidence_refs = [...new Set([...state.evidence_refs, `idempotent-readback-of:${priorReady.run_id}`])]
        const b1 = state.stages.find((record) => record.stage === 'B1_DEPENDENCY_PREFLIGHT')!
        b1.started_at = state.created_at
        b1.completed_at = state.updated_at
        b1.evidence_refs = preflight.evidenceRefs ?? []
        b1.readiness_predicates = preflight.readinessPredicates ?? {}
        b1.readback_digest = outcomeReadbackDigest(preflight)
        const b8 = state.stages.find((record) => record.stage === 'B8_READY_READBACK')!
        b8.started_at = state.created_at
        b8.completed_at = state.updated_at
        b8.evidence_refs = readback.evidenceRefs ?? []
        b8.readiness_predicates = readback.readinessPredicates ?? {}
        b8.readback_digest = outcomeReadbackDigest(readback)
        for (const record of state.stages) {
          if (record.status === 'passed') record.seal_digest = stageSealDigest(state, record.stage)
        }
        stateStore.save(state)
        return resultFromState(state, 'B8_READY_READBACK', 'IDEMPOTENT_READY', [])
      }
      return resultFromState(state, 'B8_READY_READBACK', 'NO_GO', readback.reasonCodes ?? ['NO_GO_READY_PREDICATE_FALSE'])
    }

    for (const stage of BOOTSTRAP_STAGES) {
      const record = state.stages.find((candidate) => candidate.stage === stage)!
      const sealedRecord = structuredClone(record)
      if (options.resumeRunId && record.status === 'passed' && stage !== 'B0_LOCK_AND_SNAPSHOT' && stage !== 'B1_DEPENDENCY_PREFLIGHT') {
        if (!ports.revalidateStage) return resultFromState(state, stage, 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
        const revalidated = await boundedDeadline(stage, (signal) => ports.revalidateStage!(context(signal), stage))
        const liveReadbackDigest = outcomeReadbackDigest(revalidated)
        if (!revalidated.ok || !record.readback_digest || liveReadbackDigest !== record.readback_digest) {
          state.terminal_status = 'NO_GO'
          state.updated_at = nowIso()
          stateStore.save(state)
          return resultFromState(state, stage, 'NO_GO', ['NO_GO_RESUME_REVALIDATION'])
        }
        record.evidence_refs = [...new Set([...record.evidence_refs, ...(revalidated.evidenceRefs ?? [])])]
        record.seal_digest = stageSealDigest(state, stage)
        state.updated_at = nowIso()
        stateStore.save(state)
        continue
      }
      record.status = options.dryRun ? 'planned' : 'pending'
      record.started_at = nowIso()
      record.reason_codes = []
      const method = STAGE_METHOD[stage]
      if (!options.dryRun) {
        state.updated_at = nowIso()
        stateStore.save(state)
      }
      activeStageForAdmission = stage
      const outcome = await boundedDeadline(stage, (signal) => ports[method](context(signal)))
      activeStageForAdmission = null
      record.completed_at = nowIso()
      record.reason_codes = outcome.reasonCodes ?? []
      record.evidence_refs = outcome.evidenceRefs ?? []
      record.readiness_predicates = outcome.readinessPredicates ?? {}
      record.readback_digest = outcomeReadbackDigest(outcome)
      if (outcome.resolvedRuntime) state.resolved_runtime = outcome.resolvedRuntime
      if (options.resumeRunId && sealedRecord.status === 'passed'
        && (stage === 'B0_LOCK_AND_SNAPSHOT' || stage === 'B1_DEPENDENCY_PREFLIGHT')
        && sealedRecord.readback_digest !== record.readback_digest) {
        record.status = 'failed'
        record.reason_codes = ['NO_GO_RESUME_REVALIDATION']
        state.terminal_status = 'NO_GO'
        state.updated_at = nowIso()
        stateStore.save(state)
        return resultFromState(state, stage, 'NO_GO', ['NO_GO_RESUME_REVALIDATION'])
      }
      if (!options.dryRun) {
        const reportedMutations = [
          ...(outcome.mutations ?? []),
          ...(outcome.mutation ? [outcome.mutation] : []),
        ]
        const orderedStageMutations: BootstrapMutation[] = []
        for (const reported of reportedMutations) {
          const admitted = state.mutations.find((mutation) => mutation.stage === stage
            && mutation.owner_key === reported.owner_key
            && mutation.rollback_payload?.recovery_admission === true)
          if (admitted) {
            const admittedPayload = admitted.rollback_payload ?? {}
            Object.assign(admitted, reported)
            admitted.rollback_payload = {
              ...admittedPayload,
              ...(reported.rollback_payload ?? {}),
              recovery_admission: false,
              recovery_admission_phase: 'COMMITTED_AND_READ_BACK',
            }
            orderedStageMutations.push(admitted)
            continue
          }
          const observed: BootstrapMutation = {
            mutation_id: `${runId}:${stage}:${state.mutations.length + 1}`,
            stage,
            rollback_status: 'not_run',
            ...reported,
          }
          orderedStageMutations.push(observed)
        }
        const reportedIds = new Set(orderedStageMutations.map((mutation) => mutation.mutation_id))
        const unmatchedStageAdmissions = state.mutations.filter((mutation) => mutation.stage === stage
          && !reportedIds.has(mutation.mutation_id))
        state.mutations = [
          ...state.mutations.filter((mutation) => mutation.stage !== stage),
          ...orderedStageMutations,
          ...unmatchedStageAdmissions,
        ]
      }
      state.updated_at = nowIso()
      if (!outcome.ok) {
        record.status = 'failed'
        state.terminal_status = 'NO_GO'
        if (!options.dryRun) {
          refreshOwnedRollbackFences(state)
          state.updated_at = nowIso()
          stateStore.save(state)
          let allRollbackVerified = true
          for (const mutation of [...state.mutations].reverse()) {
            if (mutation.rollback_status === 'verified' || mutation.rollback_status === 'skipped') continue
            const rollbackStartedAt = nowIso()
            mutation.rollback_status = 'attempting'
            mutation.rollback_payload = {
              ...(mutation.rollback_payload ?? {}),
              rollback_disposition: 'attempting_after_failed_command',
              rollback_started_at: rollbackStartedAt,
            }
            state.updated_at = rollbackStartedAt
            stateStore.save(state)
            const rollback = await boundedDeadline(mutation.stage, (signal) => ports.rollbackMutation(context(signal), mutation))
            const rollbackVerified = rollback.ok && Boolean(rollback.readbackDigest)
            mutation.rollback_status = rollbackVerified ? 'verified' : 'failed'
            mutation.rollback_payload = {
              ...(mutation.rollback_payload ?? {}),
              rollback_disposition: rollbackVerified ? 'verified_after_failed_command' : 'recovery_required_after_failed_command',
              rollback_completed_at: nowIso(),
              rollback_evidence_refs: rollback.evidenceRefs ?? [],
              rollback_readback_digest: rollback.readbackDigest ?? null,
            }
            state.evidence_refs = [...new Set([...state.evidence_refs, ...(rollback.evidenceRefs ?? [])])]
            allRollbackVerified &&= rollbackVerified
            if (rollbackVerified && mutation.kind !== 'db') refreshOwnedRollbackFences(state)
            state.updated_at = nowIso()
            stateStore.save(state)
          }
          if (!allRollbackVerified) {
            state.terminal_status = 'PARTIAL_ROLLBACK_NO_GO'
            record.reason_codes = [...new Set([
              ...(record.reason_codes.length > 0 ? record.reason_codes : ['NO_GO_POST_MUTATION_READBACK']),
              'NO_GO_ROLLBACK_UNVERIFIED',
            ])]
          }
          for (const sealed of state.stages) {
            if (sealed.status === 'passed') sealed.seal_digest = stageSealDigest(state, sealed.stage)
          }
          stateStore.save(state)
        }
        return resultFromState(state, stage, 'NO_GO', record.reason_codes.length > 0 ? record.reason_codes : ['NO_GO_READY_PREDICATE_FALSE'])
      }
      record.status = options.dryRun ? 'planned' : 'passed'
      if (!options.dryRun) {
        record.seal_digest = stageSealDigest(state, stage)
        stateStore.save(state)
      }
    }

    state.terminal_status = options.dryRun ? 'PLANNED' : 'READY'
    state.updated_at = nowIso()
    if (!options.dryRun) {
      if (!refreshOwnedRollbackFences(state)) {
        state.terminal_status = 'NO_GO'
        stateStore.save(state)
        return resultFromState(state, 'B8_READY_READBACK', 'NO_GO', ['NO_GO_ROLLBACK_UNVERIFIED'])
      }
      for (const record of state.stages) {
        if (record.status === 'passed') record.seal_digest = stageSealDigest(state, record.stage)
      }
      stateStore.save(state)
    }
    return resultFromState(state, 'B8_READY_READBACK', state.terminal_status, [])
  } finally {
    if (lockHeld) {
      state.lock_release_authorized_at = nowIso()
      state.updated_at = state.lock_release_authorized_at
      stateStore.save(state)
      stateStore.releaseLock(agentId, runId)
      lockHeld = false
      state.lock_released_at = nowIso()
      state.updated_at = state.lock_released_at
      stateStore.save(state)
    }
  }
}

export const bootstrapInternal = {
  defaultCommandRunner,
  runStdioMcpRecovery,
  createDefaultPorts,
  providerInputSnapshot,
  resolveProviderRootAuthority,
  classifyRuntimeReceiptRows,
}
