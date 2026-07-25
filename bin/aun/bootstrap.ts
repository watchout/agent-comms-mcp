import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  BOOTSTRAP_SAFE_D1_DEFAULTS,
  FileBootstrapStateStore,
  bootstrapDigest,
  bootstrapStateRoot,
  validateBootstrapAgentId,
  type BootstrapStateStore,
} from '../../core/aun-bootstrap-state'
import {
  parseStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
} from '../../core/state-daemon/launchagent'
import { evaluateRuntimeMemoryReadyGate } from '../../core/runtime-memory-ready'
import {
  selectBootstrapRuntime,
  type BootstrapRuntimeSignal,
} from '../../core/runtime-inventory'
import { runBootstrapQueueSmoke } from '../../core/queue-runtime'
import { createCodexBootstrapAdapter, type BootstrapAdapterCommandRunner } from './bootstrap-adapter-codex'
import { createClaudeBootstrapAdapter } from './bootstrap-adapter-claude'
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
    stages: BOOTSTRAP_STAGES.map((stage) => ({
      stage,
      status: 'pending',
      started_at: null,
      completed_at: null,
      reason_codes: [],
      evidence_refs: [],
      readiness_predicates: {},
    })),
    mutations: [],
    evidence_refs: [],
    safe_D1_readback: { ...BOOTSTRAP_SAFE_D1_DEFAULTS },
  }
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
          action: `Resolve ${reasonCodes.join(', ') || 'the failed bootstrap predicate'}, then resume this exact run.`,
          deliver_via: `aun bootstrap --agent-id ${state.agent_id} --runtime ${state.resolved_runtime ?? state.requested_runtime} --resume ${state.run_id} --json`,
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
  task: Promise<BootstrapStageOutcome>,
): Promise<BootstrapStageOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<BootstrapStageOutcome>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ ok: false, reasonCodes: ['NO_GO_STAGE_TIMEOUT'] }), STAGE_DEADLINE_MS[stage])
  })
  const outcome = await Promise.race([task, timeout])
  if (timer) clearTimeout(timer)
  return outcome
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
    const finish = (result: BootstrapCommandResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolveResult(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ exitCode: 124, stdout, stderr: `${stderr}\ncommand timed out` })
    }, options.timeoutMs)
    child.on('error', (err) => finish({ exitCode: 127, stdout, stderr: err.message }))
    child.on('exit', (code) => finish({ exitCode: code ?? 1, stdout, stderr }))
  })
}

async function withBootstrapDb<T>(env: Record<string, string>, fn: (db: DbAdapter) => Promise<T>): Promise<T> {
  const explicit = env.AGENT_COM_DB?.trim().toLowerCase()
  const postgres = explicit === 'postgres' || explicit === 'postgresql' || (!explicit && Boolean(env.DATABASE_URL))
  const db: DbAdapter = postgres
    ? new PgAdapter(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp')
    : new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
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

async function processRuntimeSignals(run: BootstrapAdapterCommandRunner, repoRoot: string, env: Record<string, string>): Promise<BootstrapRuntimeSignal[]> {
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
    const command = match[2].toLowerCase()
    if (/(^|[/\s])codex(?:\s|$)/.test(command)) signals.push({ source: 'process_identity', runtime: 'codex', verified: true, evidence: `ancestor_pid:${pid}` })
    if (/(^|[/\s])claude(?:\s|$)/.test(command)) signals.push({ source: 'process_identity', runtime: 'claude', verified: true, evidence: `ancestor_pid:${pid}` })
    pid = Number(match[1])
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) signals.push({ source: 'process_identity', runtime: 'codex', verified: true, evidence: 'codex_runtime_env' })
  if (env.CLAUDECODE === '1') signals.push({ source: 'process_identity', runtime: 'claude', verified: true, evidence: 'claude_runtime_env' })
  return signals.filter((signal, index, all) => all.findIndex((candidate) => candidate.source === signal.source && candidate.runtime === signal.runtime) === index)
}

function parseJsonOutput(result: BootstrapCommandResult): any | null {
  if (result.exitCode !== 0) return null
  try { return JSON.parse(result.stdout) } catch { return null }
}

function executableVersionOk(output: string, minimumMajor: number): boolean {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/)
  return Boolean(match && Number(match[1]) >= minimumMajor)
}

function profilePort(profile: any): number | null {
  const port = Number(profile?.channel_port)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
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

type DefaultPortsOptions = {
  run: BootstrapAdapterCommandRunner
  env: Record<string, string>
  home: string
  repoRoot: string
}

function createDefaultPorts(options: DefaultPortsOptions): BootstrapExecutionPorts {
  const { run, env, home, repoRoot } = options
  const bunPath = process.execPath
  const adapterDeps = { run, bunPath, serverEntry: 'server.ts' }
  const adapters: Record<BootstrapResolvedRuntime, BootstrapRuntimeAdapter> = {
    codex: createCodexBootstrapAdapter(adapterDeps),
    claude: createClaudeBootstrapAdapter(adapterDeps),
  }
  let profileBefore: any = null
  let queueSmokeEvidence: Awaited<ReturnType<typeof runBootstrapQueueSmoke>> | null = null

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

  const memoryGate = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
    if (context.dryRun) {
      return {
        ok: true,
        evidenceRefs: ['memory-ready:planned-readback'],
        readinessPredicates: { memory_recovery_readback_planned: true },
      }
    }
    const project = env.AGENT_MEMORY_PROJECT || env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(context.workspaceRoot)
    try {
      const gate = await withBootstrapDb(env, (db) => evaluateRuntimeMemoryReadyGate(db as any, {
        agent_id: context.agentId,
        expected_agent_id: context.agentId,
        project,
      }))
      return gate.ok
        ? { ok: true, evidenceRefs: [`memory-ready:${bootstrapDigest(gate)}`], readinessPredicates: { memory_recovery_ready: true, runtime_receipt_present: true } }
        : { ok: false, reasonCodes: [gate.reason === 'runtime_instance_missing' ? 'NO_GO_RUNTIME_RECEIPT' : 'NO_GO_MEMORY_RECOVERY'], evidenceRefs: [`memory-no-go:${bootstrapDigest(gate)}`], readinessPredicates: { memory_recovery_ready: false } }
    } catch (err) {
      return { ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'], evidenceRefs: [`memory-error:${bootstrapDigest(String(err))}`] }
    }
  }

  return {
    async lockAndSnapshot(context) {
      const dirty = await run('git', ['status', '--porcelain'], { cwd: context.repoRoot, env, timeoutMs: 10_000 })
      if (dirty.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_PRESTATE_UNREADABLE'] }
      return {
        ok: true,
        evidenceRefs: [`prestate:${bootstrapDigest({ repo_head: context.repoHead, dirty: dirty.stdout })}`],
        readinessPredicates: { state_journal_mode_0600: true, safe_d1_defaults_planned: true },
      }
    },

    async dependencyPreflight(context) {
      const common = await Promise.all([
        run(bunPath, ['--version'], { cwd: repoRoot, env, timeoutMs: 10_000 }),
        run('node', ['--version'], { cwd: repoRoot, env, timeoutMs: 10_000 }),
        run('git', ['--version'], { cwd: repoRoot, env, timeoutMs: 10_000 }),
        run('tmux', ['display-message', '-p', '#S'], { cwd: repoRoot, env, timeoutMs: 10_000 }),
        run('launchctl', ['help'], { cwd: repoRoot, env, timeoutMs: 10_000 }),
      ])
      if (common.slice(0, 3).some((result) => result.exitCode !== 0)) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }
      if (!executableVersionOk(common[0].stdout + common[0].stderr, 1) || !executableVersionOk(common[1].stdout + common[1].stderr, 20)) {
        return { ok: false, reasonCodes: ['NO_GO_VERSION_UNSUPPORTED'] }
      }
      if (common[3].exitCode !== 0 || common[4].exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }

      profileBefore = context.dryRun && !databaseAlreadyExists() ? null : await profileGet(context.agentId)
      const signals = await processRuntimeSignals(run, repoRoot, env)
      const profileSignal = profileRuntimeSignal(profileBefore)
      if (profileSignal) signals.push(profileSignal)
      const selection = selectBootstrapRuntime(context.requestedRuntime, signals)
      if (!selection.ok || !selection.runtime) return { ok: false, reasonCodes: [selection.reason] }
      const liveRuntimes = [...new Set(signals.filter((signal) => signal.source === 'process_identity' && signal.verified).map((signal) => signal.runtime))]
      if (liveRuntimes.length === 1) env.AUN_BOOTSTRAP_PROCESS_RUNTIME = liveRuntimes[0]
      else delete env.AUN_BOOTSTRAP_PROCESS_RUNTIME
      const provider = await adapters[selection.runtime].dependencyPreflight({ ...context, resolvedRuntime: selection.runtime, env })
      if (!provider.ok) return provider
      return {
        ok: true,
        resolvedRuntime: selection.runtime,
        evidenceRefs: [`runtime-selection:${bootstrapDigest(selection)}`, ...(provider.evidenceRefs ?? [])],
        readinessPredicates: { dependencies_present: true, supervisor_capable: true, runtime_unambiguous: true },
      }
    },

    async migrateDatabase(context) {
      if (context.dryRun) return { ok: true, evidenceRefs: ['db-migration:planned'], readinessPredicates: { migration_plan_safe: true } }
      const before = env.AGENT_COM_SQLITE_PATH && existsSync(env.AGENT_COM_SQLITE_PATH)
        ? bootstrapDigest(readFileSync(env.AGENT_COM_SQLITE_PATH))
        : null
      const result = await run(bunPath, ['db/migrate.ts'], { cwd: repoRoot, env, timeoutMs: 120_000 })
      if (result.exitCode !== 0) return { ok: false, reasonCodes: [/destructive/i.test(result.stderr) ? 'NO_GO_DESTRUCTIVE_MIGRATION_GATE' : 'NO_GO_DB_MIGRATION'] }
      const idempotency = await run(bunPath, ['db/migrate.ts'], { cwd: repoRoot, env, timeoutMs: 120_000 })
      if (idempotency.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      const after = env.AGENT_COM_SQLITE_PATH && existsSync(env.AGENT_COM_SQLITE_PATH)
        ? bootstrapDigest(readFileSync(env.AGENT_COM_SQLITE_PATH))
        : bootstrapDigest(result.stdout)
      return {
        ok: true,
        evidenceRefs: [`db-migration:${after}`, `db-migration-idempotency:${bootstrapDigest(idempotency.stdout)}`],
        readinessPredicates: { migration_complete: true, migration_idempotent: true },
        mutation: before === after ? undefined : {
          kind: 'db', owner_key: `db:${context.runId}`, before_digest: before,
          intended_after_digest: after, actual_after_digest: after,
          rollback_action: 'resume-only: migration rollback requires an exact pre-state snapshot',
        },
      }
    },

    async ensureAgentProfile(context) {
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      const existing = context.dryRun && !databaseAlreadyExists() ? profileBefore : await profileGet(context.agentId)
      const tmux = await run('tmux', ['display-message', '-p', '#S'], { cwd: repoRoot, env, timeoutMs: 10_000 })
      const session = tmux.exitCode === 0 ? tmux.stdout.trim() : existing?.tmux_session
      if (!session) return { ok: false, reasonCodes: ['NO_GO_IDENTITY_MISMATCH'] }
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
      if (context.dryRun) return { ok: true, evidenceRefs: [`profile-plan:${bootstrapDigest(desired)}`], readinessPredicates: { profile_plan_unambiguous: true } }
      if (matches) return { ok: true, evidenceRefs: [`profile-existing:${bootstrapDigest(existing)}`], readinessPredicates: { profile_readback_matches: true } }
      const applied = await run(bunPath, [
        'cli/index.ts', 'agent', 'profile', 'set', context.agentId,
        '--runtime', 'TUI', '--runtime-engine', context.resolvedRuntime!,
        '--home-directory', context.workspaceRoot, '--channel-port', String(port),
        '--tmux-session', session, '--enabled', 'true', '--execute',
      ], { cwd: repoRoot, env, timeoutMs: 120_000 })
      if (applied.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_PROFILE_CONFLICT'] }
      const readback = await profileGet(context.agentId)
      if (!readback || readback.runtime_engine_preference !== context.resolvedRuntime || Number(readback.channel_port) !== port) {
        return { ok: false, reasonCodes: ['NO_GO_IDENTITY_MISMATCH'] }
      }
      return {
        ok: true,
        evidenceRefs: [`profile-readback:${bootstrapDigest(readback)}`],
        readinessPredicates: { profile_readback_matches: true, endpoint_allocated: true },
        mutation: {
          kind: 'profile', owner_key: `profile:${context.agentId}`,
          before_digest: existing ? bootstrapDigest(existing) : null,
          intended_after_digest: bootstrapDigest(desired), actual_after_digest: bootstrapDigest(readback),
          rollback_action: 'restore exact prior profile fields or disable a profile created by this run',
        },
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
      const args = [
        'scripts/state-daemon-launchagent.ts', 'restore', '--commit', context.repoHead ?? '',
        '--agent-allowlist', context.agentId, '--disable-codex-runner', '--bootstrap-safe-defaults',
        ...(context.dryRun ? [] : ['--execute']),
      ]
      const result = await run(bunPath, args, { cwd: repoRoot, env, timeoutMs: 120_000 })
      if (result.exitCode !== 0) return { ok: false, reasonCodes: [context.dryRun ? 'NO_GO_INSTALL_PLAN' : 'NO_GO_DAEMON_START'] }
      if (context.dryRun) return { ok: true, evidenceRefs: [`daemon-plan:${bootstrapDigest(result.stdout)}`], readinessPredicates: { install_plan_go: true, d1_safe_defaults_planned: true } }
      const identity = await adapter.verifyRuntimeIdentity(context)
      if (!identity.ok) return identity
      return {
        ok: true,
        evidenceRefs: [`daemon-start:${bootstrapDigest(result.stdout)}`, ...(identity.evidenceRefs ?? [])],
        readinessPredicates: { daemon_started: true, process_identity_matches: true },
        mutation: {
          kind: 'daemon', owner_key: `launchd:${context.runId}:${STATE_DAEMON_PLIST_NAME}`,
          before_digest: null, intended_after_digest: bootstrapDigest(args),
          actual_after_digest: bootstrapDigest(result.stdout),
          rollback_action: `launchctl bootout gui/<uid> ${join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)}`,
        },
      }
    },

    async runQueueSmoke(context) {
      if (context.dryRun) return { ok: true, evidenceRefs: ['queue-smoke:planned'], readinessPredicates: { no_effect_smoke_planned: true } }
      queueSmokeEvidence = await withBootstrapDb(env, (db) => runBootstrapQueueSmoke(db as any, {
        agentId: context.agentId,
        runId: context.runId,
        messageId: randomUUID(),
      }))
      if (!queueSmokeEvidence.ok) {
        const mapped: BootstrapReasonCode[] = queueSmokeEvidence.reason_codes.map((code) =>
          code.startsWith('NO_GO_DUPLICATE_CLAIM') ? 'NO_GO_DUPLICATE_CLAIM'
            : code.startsWith('NO_GO_SMOKE_NOT_TERMINAL') ? 'NO_GO_SMOKE_NOT_TERMINAL'
              : code.startsWith('NO_GO_QUEUE_ENQUEUE') ? 'NO_GO_QUEUE_ENQUEUE'
                : 'NO_GO_QUEUE_NO_PROGRESS')
        return { ok: false, reasonCodes: mapped }
      }
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
      const [mcp, runtimeIdentity, memory, profile, daemon] = await Promise.all([
        adapter.readbackMcpRegistration(context),
        adapter.verifyRuntimeIdentity(context),
        memoryGate(context),
        profileGet(context.agentId),
        run(bunPath, ['cli/index.ts', 'state-daemon', 'readiness', '--require-running', '--expected-agent-id', context.agentId, '--format', 'json'], { cwd: repoRoot, env, timeoutMs: 30_000 }),
      ])
      const safeD1 = safeD1FromPlist(home)
      const daemonJson = parseJsonOutput(daemon)
      let queueReady = Boolean(queueSmokeEvidence?.ok)
      if (!queueReady) {
        const queueMutation = context.priorState.mutations.find((mutation) => mutation.kind === 'queue_smoke')
        const queueId = queueMutation?.owner_key.startsWith('queue:') ? queueMutation.owner_key.slice('queue:'.length) : null
        if (queueId) {
          queueReady = await withBootstrapDb(env, async (db) => {
            const row = await db.queryOne<{ status: string }>('SELECT status FROM message_queue WHERE id = $1 AND agent_id = $2', [queueId, context.agentId])
            return row?.status === 'done' || row?.status === 'replied'
          }).catch(() => false)
        }
      }
      const ok = mcp.ok && runtimeIdentity.ok && memory.ok && Boolean(profile) && daemon.exitCode === 0 && Boolean(daemonJson?.ok) && queueReady && Boolean(safeD1)
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
      return {
        ok: true,
        evidenceRefs: [
          ...(mcp.evidenceRefs ?? []), ...(memory.evidenceRefs ?? []),
          `profile-final:${bootstrapDigest(profile)}`, `daemon-final:${bootstrapDigest(daemonJson)}`,
          `d1-safe-final:${bootstrapDigest(safeD1)}`,
        ],
        readinessPredicates: {
          identity_ready: true, mcp_ready: true, memory_ready: true,
          process_endpoint_ready: true, queue_progress_ready: true, safe_d1_readback: true,
        },
      }
    },

    async rollbackMutation(context, mutation) {
      const adapter = adapterFor(context)
      if (mutation.kind === 'mcp_registration' && adapter) return adapter.rollbackRuntimeRegistration(context, mutation)
      if (mutation.kind === 'daemon' && mutation.owner_key === `launchd:${context.runId}:${STATE_DAEMON_PLIST_NAME}`) {
        const plist = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
        const result = await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plist], { cwd: repoRoot, env, timeoutMs: 30_000 })
        return result.exitCode === 0 ? { ok: true, readinessPredicates: { rollback_verified: true } } : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'queue_smoke') return { ok: true, readinessPredicates: { terminal_smoke_retained: true } }
      return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    },
  }
}

export type BootstrapDependencies = {
  stateStore?: BootstrapStateStore
  ports?: BootstrapExecutionPorts
  run?: BootstrapAdapterCommandRunner
  uuid?: () => string
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
  const requestedRuntimeForDigest = state?.requested_runtime ?? options.runtime
  const inputDigest = bootstrapDigest({ agent_id: agentId, requested_runtime: requestedRuntimeForDigest, repo_root: repoRoot, workspace_root: workspaceRoot, repo_head: repoHead, safe_d1: BOOTSTRAP_SAFE_D1_DEFAULTS })
  if ((options.resumeRunId || options.rollbackRunId) && !state) {
    const missing = initialState({ runId, agentId, runtime: options.runtime, inputDigest, repoRoot, workspaceRoot, repoHead })
    return resultFromState(missing, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RUN_NOT_FOUND'])
  }
  if (state && options.runtime !== state.requested_runtime && options.runtime !== state.resolved_runtime) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  if (state && state.input_digest !== inputDigest) {
    return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
  }
  state ??= initialState({ runId, agentId, runtime: options.runtime, inputDigest, repoRoot, workspaceRoot, repoHead })
  if (options.rollbackRunId && state.resolved_runtime) env.AUN_BOOTSTRAP_PROCESS_RUNTIME = state.resolved_runtime
  const ports = dependencies.ports ?? createDefaultPorts({ run: runCommand, env, home, repoRoot })
  let lockHeld = false

  if (!options.dryRun) {
    try {
      stateStore.acquireLock(agentId, runId)
      lockHeld = true
    } catch {
      return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', 'NO_GO', ['NO_GO_BOOTSTRAP_BUSY'])
    }
  }

  const context = (): BootstrapStageContext => ({
    runId, agentId, requestedRuntime: state!.requested_runtime, resolvedRuntime: state!.resolved_runtime,
    repoRoot, workspaceRoot, repoHead, dryRun: Boolean(options.dryRun), env, priorState: state!,
  })

  try {
    if (options.rollbackRunId) {
      let allVerified = true
      for (const mutation of [...state.mutations].reverse()) {
        if (mutation.rollback_status === 'verified') continue
        const outcome = await ports.rollbackMutation(context(), mutation)
        mutation.rollback_status = outcome.ok ? 'verified' : 'failed'
        allVerified &&= outcome.ok
        state.updated_at = nowIso()
        stateStore.save(state)
      }
      state.terminal_status = allVerified ? 'ROLLED_BACK' : 'PARTIAL_ROLLBACK_NO_GO'
      state.updated_at = nowIso()
      stateStore.save(state)
      return resultFromState(state, 'B0_LOCK_AND_SNAPSHOT', state.terminal_status, allVerified ? [] : ['NO_GO_ROLLBACK_UNVERIFIED'])
    }

    const priorReady = !options.resumeRunId && !options.dryRun ? stateStore.findLatestReady(agentId, inputDigest) : null
    if (priorReady) {
      state.resolved_runtime = priorReady.resolved_runtime
      const preflight = await withDeadline('B1_DEPENDENCY_PREFLIGHT', ports.dependencyPreflight(context()))
      if (preflight.resolvedRuntime) state.resolved_runtime = preflight.resolvedRuntime
      const readback = preflight.ok && state.resolved_runtime === priorReady.resolved_runtime
        ? await withDeadline('B8_READY_READBACK', ports.readbackReady(context()))
        : { ok: false }
      if (readback.ok) {
        state = structuredClone(priorReady)
        state.run_id = runId
        state.created_at = nowIso()
        state.updated_at = state.created_at
        state.terminal_status = 'IDEMPOTENT_READY'
        stateStore.save(state)
        return resultFromState(state, 'B8_READY_READBACK', 'IDEMPOTENT_READY', [])
      }
    }

    for (const stage of BOOTSTRAP_STAGES) {
      const record = state.stages.find((candidate) => candidate.stage === stage)!
      if (options.resumeRunId && record.status === 'passed' && stage !== 'B0_LOCK_AND_SNAPSHOT' && stage !== 'B1_DEPENDENCY_PREFLIGHT') continue
      record.status = options.dryRun ? 'planned' : 'pending'
      record.started_at = nowIso()
      record.reason_codes = []
      const method = STAGE_METHOD[stage]
      const outcome = await withDeadline(stage, ports[method](context()))
      record.completed_at = nowIso()
      record.reason_codes = outcome.reasonCodes ?? []
      record.evidence_refs = outcome.evidenceRefs ?? []
      record.readiness_predicates = outcome.readinessPredicates ?? {}
      if (outcome.resolvedRuntime) state.resolved_runtime = outcome.resolvedRuntime
      if (outcome.mutation && !options.dryRun) {
        state.mutations.push({
          mutation_id: `${runId}:${stage}:${state.mutations.length + 1}`,
          stage,
          rollback_status: 'not_run',
          ...outcome.mutation,
        })
      }
      state.updated_at = nowIso()
      if (!outcome.ok) {
        record.status = 'failed'
        state.terminal_status = 'NO_GO'
        if (!options.dryRun) stateStore.save(state)
        return resultFromState(state, stage, 'NO_GO', record.reason_codes.length > 0 ? record.reason_codes : ['NO_GO_READY_PREDICATE_FALSE'])
      }
      record.status = options.dryRun ? 'planned' : 'passed'
      if (!options.dryRun) stateStore.save(state)
    }

    state.terminal_status = options.dryRun ? 'PLANNED' : 'READY'
    state.updated_at = nowIso()
    if (!options.dryRun) stateStore.save(state)
    return resultFromState(state, 'B8_READY_READBACK', state.terminal_status, [])
  } finally {
    if (lockHeld) stateStore.releaseLock(agentId, runId)
  }
}
