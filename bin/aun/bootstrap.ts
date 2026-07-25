import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    mutation_manifest_digest: bootstrapDigest([]),
    readback_bindings: null,
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
  task: (signal: AbortSignal) => Promise<BootstrapStageOutcome>,
  remainingTotalMs = Number.POSITIVE_INFINITY,
): Promise<BootstrapStageOutcome> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`bootstrap stage deadline exceeded: ${stage}`))
  }, Math.max(1, Math.min(STAGE_DEADLINE_MS[stage], remainingTotalMs)))
  try {
    const outcome = await task(controller.signal)
    return timedOut ? { ok: false, reasonCodes: ['NO_GO_STAGE_TIMEOUT'] } : outcome
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

function bootstrapInputDigest(input: {
  agentId: string
  requestedRuntime: BootstrapOptions['runtime']
  repoRoot: string
  workspaceRoot: string
  repoHead: string | null
  home: string
  env: Record<string, string>
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
    tmux_session: input.env.TMUX || input.env.TMUX_PANE || null,
    memory_project: input.env.AGENT_MEMORY_PROJECT || input.env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(input.workspaceRoot),
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
    if (/(^|[/\s])codex(?:\s|$)/.test(command)) {
      signals.push({ source: 'process_identity', runtime: 'codex', verified: true, evidence: `ancestor_pid:${pid}` })
      env.AUN_BOOTSTRAP_PROVIDER_PID = String(pid)
    }
    if (/(^|[/\s])claude(?:\s|$)/.test(command)) {
      signals.push({ source: 'process_identity', runtime: 'claude', verified: true, evidence: `ancestor_pid:${pid}` })
      env.AUN_BOOTSTRAP_PROVIDER_PID = String(pid)
    }
    pid = Number(match[1])
  }
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) {
    signals.push({ source: 'process_identity', runtime: 'codex', verified: true, evidence: 'codex_runtime_env' })
    env.AUN_BOOTSTRAP_PROVIDER_PID ||= String(process.ppid)
  }
  if (env.CLAUDECODE === '1') {
    signals.push({ source: 'process_identity', runtime: 'claude', verified: true, evidence: 'claude_runtime_env' })
    env.AUN_BOOTSTRAP_PROVIDER_PID ||= String(process.ppid)
  }
  return signals.filter((signal, index, all) => all.findIndex((candidate) => candidate.source === signal.source && candidate.runtime === signal.runtime) === index)
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
    let evidenceId: string | number | null = null
    let runtimeTupleDigest: string | null = null
    try {
      const profile = await profileGet(context.agentId)
      const sessionName = env.AUN_BOOTSTRAP_TMUX_SESSION || profile?.tmux_session
      const port = Number(env.AUN_BOOTSTRAP_CHANNEL_PORT || profile?.channel_port)
      const providerPid = Number(env.AUN_BOOTSTRAP_PROVIDER_PID)
      if (!profile || !sessionName || !Number.isInteger(port) || port <= 0
        || !Number.isInteger(providerPid) || providerPid <= 1 || !context.resolvedRuntime || !context.repoHead) {
        return { ok: false, reasonCodes: ['NO_GO_RUNTIME_RECEIPT'] }
      }
      const runtimeTuple = {
        agent_id: context.agentId,
        runtime_engine: context.resolvedRuntime,
        session_name: sessionName,
        process_id: providerPid,
        port,
        checkout_path: realpathOrResolve(context.repoRoot),
        commit_sha: context.repoHead,
      }
      runtimeTupleDigest = bootstrapDigest(runtimeTuple)
      const runtime = await withBootstrapDb(env, async (db) => {
        const active = await db.query<any>(
          `SELECT runtime_instance_id, agent_id, runtime_engine, session_name, process_id,
                  port, checkout_path, commit_sha, status, metadata
             FROM agent_runtime_instances
            WHERE agent_id = $1 AND status IN ('running', 'active')
            ORDER BY COALESCE(last_seen_at, started_at) DESC`,
          [context.agentId],
        )
        const matches = active.filter((row) => row.agent_id === runtimeTuple.agent_id
          && row.runtime_engine === runtimeTuple.runtime_engine
          && row.session_name === runtimeTuple.session_name
          && Number(row.process_id) === runtimeTuple.process_id
          && Number(row.port) === runtimeTuple.port
          && realpathOrResolve(String(row.checkout_path ?? '')) === runtimeTuple.checkout_path
          && row.commit_sha === runtimeTuple.commit_sha)
        if (matches.length === 1 && active.length === 1) {
          return { id: String(matches[0].runtime_instance_id), created: false }
        }
        if (active.length > 0) throw new Error('active runtime tuple mismatch')
        const id = randomUUID()
        const inserted = await db.query<{ runtime_instance_id: string }>(
          `INSERT INTO agent_runtime_instances
             (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
              process_id, port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
           VALUES
             ($1, $2, $3, 'bootstrap_bound_provider', $4,
              $5, $6, $7, $8, 'running', now(), now(), COALESCE($9::jsonb, '{}'::jsonb))
           RETURNING runtime_instance_id`,
          [id, context.agentId, context.resolvedRuntime, sessionName, providerPid, port,
            runtimeTuple.checkout_path, context.repoHead, JSON.stringify({ bootstrap_run_id: context.runId, tuple_digest: runtimeTupleDigest })],
        )
        return { id: String(inserted[0]?.runtime_instance_id ?? id), created: true }
      })
      runtimeInstanceId = runtime.id
      runtimeCreated = runtime.created
      env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID = runtime.id

      const transport = await readConfiguredWasurezuTransport(context, run)
      if (!transport) throw new Error('provider-native Wasurezu stdio tuple missing')
      const recovery = await runStdioMcpRecovery(transport, project, context)
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
        const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
          agent_id: context.agentId,
          expected_agent_id: context.agentId,
          project,
        })
        return { recorded, gate, recovery }
      })
      evidenceId = result.recorded.evidence_id
      const stableMemoryReadback = {
        evidence_id: evidenceId,
        runtime_instance_id: runtime.id,
        project,
        recovery_response_digest: recovery.responseDigest,
        runtime_tuple_digest: runtimeTupleDigest,
      }
      const mutation = {
        kind: 'memory_readiness' as const,
        owner_key: `memory:${context.runId}:${runtime.id}:${String(evidenceId)}`,
        before_digest: bootstrapDigest({ runtime_created: runtimeCreated, evidence_absent: true }),
        intended_after_digest: bootstrapDigest({ runtime_tuple_digest: runtimeTupleDigest, recovery: recovery.responseDigest }),
        actual_after_digest: bootstrapDigest(stableMemoryReadback),
        rollback_action: 'expire run-owned memory evidence and stop only a run-owned runtime receipt',
        rollback_payload: {
          runtime_instance_id: runtime.id, runtime_created: runtimeCreated, evidence_id: evidenceId,
          bootstrap_run_id: context.runId, project, recovery_response_digest: recovery.responseDigest, runtime_tuple_digest: runtimeTupleDigest,
        },
      }
      return result.gate.ok
        ? {
            ok: true,
            evidenceRefs: [`memory-ready:${bootstrapDigest(result.gate)}`, `wasurezu-recovery:${recovery.responseDigest}`, `runtime-tuple:${runtimeTupleDigest}`],
            readinessPredicates: { memory_recovery_ready: true, runtime_receipt_present: true, genuine_mcp_recovery: true },
            mutation,
          }
        : { ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'], evidenceRefs: [`memory-no-go:${bootstrapDigest(result.gate)}`], mutation }
    } catch (err) {
      const mutation = runtimeInstanceId ? {
        kind: 'memory_readiness' as const,
        owner_key: `memory:${context.runId}:${runtimeInstanceId}:${String(evidenceId ?? 'none')}`,
        before_digest: bootstrapDigest({ runtime_created: runtimeCreated, evidence_absent: true }),
        intended_after_digest: runtimeTupleDigest,
        actual_after_digest: null,
        rollback_action: 'expire run-owned memory evidence and stop only a run-owned runtime receipt',
        rollback_payload: { runtime_instance_id: runtimeInstanceId, runtime_created: runtimeCreated, evidence_id: evidenceId, bootstrap_run_id: context.runId },
      } : undefined
      return {
        ok: false,
        reasonCodes: [runtimeInstanceId ? 'NO_GO_MEMORY_RECOVERY' : 'NO_GO_RUNTIME_RECEIPT'],
        evidenceRefs: [`memory-error:${bootstrapDigest(String(err))}`],
        mutation,
      }
    }
  }

  const memoryReadback = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
    const project = env.AGENT_MEMORY_PROJECT || env.AGENT_COMMS_MEMORY_READY_PROJECT || basename(context.workspaceRoot)
    try {
      const gate = await withBootstrapDb(env, (db) => evaluateRuntimeMemoryReadyGate(db as any, {
        agent_id: context.agentId,
        expected_agent_id: context.agentId,
        project,
      }))
      if (!env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID && gate.ok && gate.runtime_instance_id) {
        env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID = gate.runtime_instance_id
      }
      const runtimeMatches = Boolean(env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID)
        && gate.runtime_instance_id === env.AUN_BOOTSTRAP_RUNTIME_INSTANCE_ID
      const mutation = context.priorState.mutations.find((item) => item.kind === 'memory_readiness')
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
        const readbackDigest = bootstrapDigest({
          evidence_id: evidence?.id ?? null,
          runtime_instance_id: evidence?.runtime_instance_id ?? null,
          project: evidence?.project ?? null,
          recovery_response_digest: metadata.recovery_response_digest ?? null,
          runtime_tuple_digest: metadata.runtime_tuple_digest ?? null,
        })
        mutationMatches = evidence?.result_status === 'ready'
          && metadata.bootstrap_run_id === payload.bootstrap_run_id
          && readbackDigest === mutation.actual_after_digest
      }
      return gate.ok && runtimeMatches && mutationMatches
        ? { ok: true, evidenceRefs: [`memory-readback:${bootstrapDigest(gate)}`], readinessPredicates: { memory_recovery_ready: true, runtime_receipt_present: true } }
        : { ok: false, reasonCodes: [gate.runtime_instance_id ? 'NO_GO_MEMORY_RECOVERY' : 'NO_GO_RUNTIME_RECEIPT'], evidenceRefs: [`memory-readback-no-go:${bootstrapDigest(gate)}`] }
    } catch (err) {
      return { ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'], evidenceRefs: [`memory-readback-error:${bootstrapDigest(String(err))}`] }
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
      }
    },

    async dependencyPreflight(context) {
      const common = await Promise.all([
        run(bunPath, ['--version'], commandOptions(context, 10_000)),
        run('node', ['--version'], commandOptions(context, 10_000)),
        run('git', ['--version'], commandOptions(context, 10_000)),
        run('tmux', ['display-message', '-p', '#S:#I.#P'], commandOptions(context, 10_000)),
        run('launchctl', ['help'], commandOptions(context, 10_000)),
      ])
      if (common.slice(0, 3).some((result) => result.exitCode !== 0)) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }
      if (!executableVersionOk(common[0].stdout + common[0].stderr, 1) || !executableVersionOk(common[1].stdout + common[1].stderr, 20)) {
        return { ok: false, reasonCodes: ['NO_GO_VERSION_UNSUPPORTED'] }
      }
      if (common[3].exitCode !== 0 || common[4].exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'] }
      const tmuxIdentity = common[3].stdout.trim()
      if (!tmuxIdentity) return { ok: false, reasonCodes: ['NO_GO_IDENTITY_MISMATCH'] }
      const [tmuxSession, tmuxPane] = tmuxIdentity.split(':', 2)
      env.AUN_BOOTSTRAP_TMUX_SESSION = tmuxSession
      env.AUN_BOOTSTRAP_TMUX_PANE = tmuxPane ?? env.TMUX_PANE ?? ''

      profileBefore = await profileGetReadOnly(context.agentId)
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
      const result = await run(bunPath, ['db/migrate.ts'], commandOptions(context, 120_000))
      if (result.exitCode !== 0) return { ok: false, reasonCodes: [/destructive/i.test(result.stderr) ? 'NO_GO_DESTRUCTIVE_MIGRATION_GATE' : 'NO_GO_DB_MIGRATION'] }
      const idempotency = await run(bunPath, ['db/migrate.ts'], commandOptions(context, 120_000))
      if (idempotency.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      const after = postgres
        ? await postgresSchemaDigest().catch(() => null)
        : sqliteArtifactDigest(sqlitePath)
      if (!after) return { ok: false, reasonCodes: ['NO_GO_DB_MIGRATION'] }
      const afterIdentity = !postgres && existsSync(sqlitePath) ? sqliteFileIdentity(sqlitePath) : null
      return {
        ok: true,
        evidenceRefs: [`db-migration:${after}`, `db-migration-idempotency:${bootstrapDigest(idempotency.stdout)}`],
        readinessPredicates: { migration_complete: true, migration_idempotent: true },
        mutation: before === after ? undefined : {
          kind: 'db', owner_key: `db:${context.runId}`, before_digest: before,
          intended_after_digest: after, actual_after_digest: after,
          rollback_action: postgres
            ? 'shared PostgreSQL schema is never dropped or down-migrated; clean only run-owned rows and report resume-required'
            : sqliteExisted
              ? 'restore exact owner-protected SQLite backup only under post-state digest fence'
              : 'remove exact run-created SQLite file only under realpath and post-state digest fence',
          rollback_payload: postgres
            ? {
                backend: 'postgres', shared: true,
                endpoint_digest: bootstrapDigest(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp'),
                migration_ledger_digest: bootstrapDigest(readFileSync(join(repoRoot, 'db', 'migrate.ts'))),
                schema_before_digest: before,
                schema_after_digest: after,
                bootstrap_owned_row_keys: [],
              }
            : {
                backend: 'sqlite', path: sqlitePath, before_exists: sqliteExisted, created_by_run: !sqliteExisted,
                before_digest: before, before_byte_digest: beforeByteDigest, before_mode: beforeMode, before_identity: beforeIdentity,
                backup_path: sqliteExisted ? backupPath : null, after_digest: after, after_identity: afterIdentity,
              },
        },
      }
    },

    async ensureAgentProfile(context) {
      const adapter = adapterFor(context)
      if (!adapter) return { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      const existing = context.dryRun && !databaseAlreadyExists() ? profileBefore : await profileGet(context.agentId)
      const tmux = await run('tmux', ['display-message', '-p', '#S'], commandOptions(context, 10_000))
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
      if (existing) {
        return { ok: false, reasonCodes: ['NO_GO_PROFILE_CONFLICT'], evidenceRefs: [`profile-mismatch:${bootstrapDigest(existing)}`] }
      }
      const applied = await run(bunPath, [
        'cli/index.ts', 'agent', 'profile', 'set', context.agentId,
        '--runtime', 'TUI', '--runtime-engine', context.resolvedRuntime!,
        '--home-directory', context.workspaceRoot, '--channel-port', String(port),
        '--tmux-session', session, '--enabled', 'true', '--execute',
      ], commandOptions(context, 120_000))
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
          kind: 'profile', owner_key: `profile:${context.runId}:${context.agentId}`,
          before_digest: bootstrapDigest({ absent: true }),
          intended_after_digest: bootstrapDigest(desired), actual_after_digest: bootstrapDigest(managedProfile(readback)),
          rollback_action: 'disable only the exact profile created by this run and verify native readback',
          rollback_payload: { created_by_run: true, profile_digest: bootstrapDigest(managedProfile(readback)) },
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
      const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
      if (!context.dryRun && existsSync(plistPath)) {
        const existingSafe = safeD1FromPlist(home)
        const existing = await run(bunPath, [
          'cli/index.ts', 'state-daemon', 'readiness', '--require-running',
          '--expected-agent-id', context.agentId, '--format', 'json',
        ], commandOptions(context, 30_000))
        const existingJson = parseJsonOutput(existing)
        return existingSafe && existing.exitCode === 0 && existingJson?.ok
          ? {
              ok: true,
              evidenceRefs: [`daemon-existing:${bootstrapDigest({ plist: readFileSync(plistPath), readiness: existingJson })}`],
              readinessPredicates: { daemon_started: true, process_identity_matches: true, daemon_preexisting_unchanged: true },
            }
          : { ok: false, reasonCodes: ['NO_GO_INSTALL_PLAN'], evidenceRefs: [`daemon-preexisting-mismatch:${bootstrapDigest({ safe: Boolean(existingSafe), readiness_exit: existing.exitCode })}`] }
      }
      const args = [
        'scripts/state-daemon-launchagent.ts', 'restore', '--commit', context.repoHead ?? '',
        '--agent-allowlist', context.agentId, '--bootstrap-safe-defaults',
        ...(env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite'
          ? ['--sqlite-path', realpathOrResolve(env.AGENT_COM_SQLITE_PATH || join(repoRoot, 'agent-com.db'))]
          : ['--database-url', env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp']),
        ...(context.dryRun ? [] : ['--execute']),
      ]
      const result = await run(bunPath, args, commandOptions(context, 120_000))
      if (result.exitCode !== 0) return { ok: false, reasonCodes: [context.dryRun ? 'NO_GO_INSTALL_PLAN' : 'NO_GO_DAEMON_START'] }
      if (context.dryRun) return { ok: true, evidenceRefs: [`daemon-plan:${bootstrapDigest(result.stdout)}`], readinessPredicates: { install_plan_go: true, d1_safe_defaults_planned: true } }
      const identity = await adapter.verifyRuntimeIdentity(context)
      if (!identity.ok) return identity
      if (!existsSync(plistPath)) return { ok: false, reasonCodes: ['NO_GO_DAEMON_START'] }
      const plistDigest = bootstrapDigest(readFileSync(plistPath))
      return {
        ok: true,
        evidenceRefs: [`daemon-start:${bootstrapDigest(result.stdout)}`, ...(identity.evidenceRefs ?? [])],
        readinessPredicates: { daemon_started: true, process_identity_matches: true },
        mutation: {
          kind: 'daemon', owner_key: `launchd:${context.runId}:${STATE_DAEMON_PLIST_NAME}`,
          before_digest: null, intended_after_digest: bootstrapDigest(args),
          actual_after_digest: plistDigest,
          rollback_action: `launchctl bootout gui/<uid> ${join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)}`,
          rollback_payload: { created_by_run: true, plist_path: plistPath, plist_digest: plistDigest },
        },
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
      const profile = await profileGet(context.agentId)
      if (profile) {
        env.AUN_BOOTSTRAP_CHANNEL_PORT = String(profile.channel_port ?? '')
        env.AUN_BOOTSTRAP_TMUX_SESSION = String(profile.tmux_session ?? '')
      }
      const [mcp, runtimeIdentity, memory, daemon] = await Promise.all([
        adapter.readbackMcpRegistration(context),
        adapter.verifyRuntimeIdentity(context),
        memoryReadback(context),
        run(bunPath, ['cli/index.ts', 'state-daemon', 'readiness', '--require-running', '--expected-agent-id', context.agentId, '--format', 'json'], commandOptions(context, 30_000)),
      ])
      const safeD1 = safeD1FromPlist(home)
      const daemonJson = parseJsonOutput(daemon)
      let queueReady = Boolean(queueSmokeEvidence?.ok)
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

    async revalidateStage(context, stage) {
      if (stage === 'B0_LOCK_AND_SNAPSHOT' || stage === 'B1_DEPENDENCY_PREFLIGHT') return { ok: true }
      if (stage === 'B2_DB_MIGRATION') {
        const result = await run(bunPath, ['db/migrate.ts'], commandOptions(context, 120_000))
        const mutation = context.priorState.mutations.find((item) => item.stage === stage && item.kind === 'db')
        const recordedEvidence = context.priorState.stages.find((item) => item.stage === stage)
          ?.evidence_refs.find((ref) => ref.startsWith('db-migration:'))
        const expectedDigest = mutation?.actual_after_digest ?? recordedEvidence?.slice('db-migration:'.length)
        const currentDigest = result.exitCode === 0 ? await currentDatabaseStageDigest() : null
        return result.exitCode === 0 && Boolean(expectedDigest) && currentDigest === expectedDigest
          ? { ok: true, evidenceRefs: [`resume-db-readback:${currentDigest}`] }
          : { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
      }
      if (stage === 'B3_AGENT_PROFILE') {
        const profile = await profileGet(context.agentId)
        const mutation = context.priorState.mutations.find((item) => item.stage === stage && item.kind === 'profile')
        const digestMatches = !mutation || mutation.actual_after_digest === bootstrapDigest(managedProfile(profile))
        const ok = Boolean(profile)
          && profile.runtime_engine_preference === context.resolvedRuntime
          && resolve(profile.home_directory ?? '') === resolve(context.workspaceRoot)
          && profile.tmux_session === env.AUN_BOOTSTRAP_TMUX_SESSION
          && profile.profile_enabled === true
          && digestMatches
        if (ok) env.AUN_BOOTSTRAP_CHANNEL_PORT = String(profile.channel_port)
        return ok ? { ok: true, evidenceRefs: [`resume-profile-readback:${bootstrapDigest(profile)}`] } : { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
      }
      if (stage === 'B4_MCP_REGISTRATION') {
        const adapter = adapterFor(context)
        return adapter ? adapter.readbackMcpRegistration(context) : { ok: false, reasonCodes: ['NO_GO_RUNTIME_UNDETECTED'] }
      }
      if (stage === 'B5_MEMORY_READINESS') return memoryReadback(context)
      if (stage === 'B6_ORDINARY_DAEMON_INSTALL_START') {
        const daemon = await run(bunPath, ['cli/index.ts', 'state-daemon', 'readiness', '--require-running', '--expected-agent-id', context.agentId, '--format', 'json'], commandOptions(context, 30_000))
        return daemon.exitCode === 0 && parseJsonOutput(daemon)?.ok && Boolean(safeD1FromPlist(home))
          ? { ok: true, evidenceRefs: [`resume-daemon-readback:${bootstrapDigest(parseJsonOutput(daemon))}`] }
          : { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
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
        return ok ? { ok: true, evidenceRefs: [`resume-queue-readback:${queueId}`] } : { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
      }
      return { ok: false, reasonCodes: ['NO_GO_RESUME_INPUT_MISMATCH'] }
    },

    async rollbackMutation(context, mutation) {
      const adapter = adapterFor(context)
      if (mutation.kind === 'mcp_registration' && adapter) return adapter.rollbackRuntimeRegistration(context, mutation)
      if (mutation.kind === 'daemon' && mutation.owner_key === `launchd:${context.runId}:${STATE_DAEMON_PLIST_NAME}`) {
        const plist = String(mutation.rollback_payload?.plist_path ?? '')
        const expectedDigest = mutation.rollback_payload?.plist_digest
        if (mutation.rollback_payload?.created_by_run !== true || !plist || !existsSync(plist)
          || bootstrapDigest(readFileSync(plist)) !== expectedDigest) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        const result = await run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, plist], commandOptions(context, 30_000))
        if (result.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        rmSync(plist)
        const unloaded = await run(
          'launchctl', ['print', `gui/${process.getuid?.() ?? ''}/${STATE_DAEMON_PLIST_NAME.replace(/\.plist$/, '')}`],
          commandOptions(context, 30_000),
        )
        return !existsSync(plist) && unloaded.exitCode !== 0
          ? { ok: true, readinessPredicates: { rollback_verified: true } }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'queue_smoke') return { ok: true, readinessPredicates: { terminal_smoke_retained: true } }
      if (mutation.kind === 'memory_readiness') {
        const payload = mutation.rollback_payload ?? {}
        const runtimeId = String(payload.runtime_instance_id ?? '')
        const evidenceId = payload.evidence_id
        const ok = await withBootstrapDb(env, async (db) => db.transaction(async (tx) => {
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
            const row = await tx.queryOne<any>('SELECT status, metadata FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND agent_id = $2', [runtimeId, context.agentId])
            const metadata = parseJsonRecord(row?.metadata)
            if (metadata.bootstrap_run_id !== context.runId) return false
            if (row?.status === 'running' || row?.status === 'active') {
              const stopped = await tx.execute(
                `UPDATE agent_runtime_instances SET status = 'stopped', stopped_at = now(), last_seen_at = now()
                  WHERE runtime_instance_id = $1 AND agent_id = $2 AND status IN ('running', 'active')`,
                [runtimeId, context.agentId],
              )
              if (stopped.rowCount !== 1) return false
            } else if (row?.status !== 'stopped') {
              return false
            }
          }
          const evidence = evidenceId === null || evidenceId === undefined
            ? null
            : await tx.queryOne<any>('SELECT result_status, failure_reason FROM runtime_memory_ready_evidence WHERE id = $1', [evidenceId])
          const active = payload.runtime_created === true
            ? await tx.queryOne('SELECT runtime_instance_id FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND status IN (\'running\', \'active\')', [runtimeId])
            : null
          return (!evidence || (evidence.result_status === 'failed' && evidence.failure_reason === 'BOOTSTRAP_ROLLBACK')) && !active
        })).catch(() => false)
        return ok ? { ok: true, readinessPredicates: { rollback_verified: true } } : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
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
          ? { ok: true, readinessPredicates: { rollback_verified: true } }
          : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      if (mutation.kind === 'db') {
        const payload = mutation.rollback_payload ?? {}
        if (payload.backend === 'postgres') return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
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
          return sqliteFileDigest(path) === payload.before_byte_digest
            && !sqliteHasSidecars(path)
            && (statSync(path).mode & 0o777) === Number(payload.before_mode)
            ? { ok: true, readinessPredicates: { rollback_verified: true } }
            : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        }
        if (payload.created_by_run !== true) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        removeSqliteArtifacts(path)
        return [path, `${path}-wal`, `${path}-shm`].every((candidate) => !existsSync(candidate))
          ? { ok: true, readinessPredicates: { rollback_verified: true } }
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
  const inputDigest = bootstrapInputDigest({
    agentId, requestedRuntime: requestedRuntimeForDigest, repoRoot, workspaceRoot, repoHead, home, env,
  })
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
    withDeadline(stage, task, 600_000 - (performance.now() - bootstrapStartedAt))

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

  const context = (abortSignal?: AbortSignal, priorState: BootstrapRunState = state!): BootstrapStageContext => ({
    runId, agentId, requestedRuntime: state!.requested_runtime, resolvedRuntime: state!.resolved_runtime,
    repoRoot, workspaceRoot, repoHead, dryRun: Boolean(options.dryRun), env, priorState, abortSignal,
  })

  try {
    if (options.rollbackRunId) {
      let allVerified = true
      for (const mutation of [...state.mutations].reverse()) {
        if (mutation.rollback_status === 'verified') continue
        const outcome = await boundedDeadline(mutation.stage, (signal) => ports.rollbackMutation(context(signal), mutation))
        mutation.rollback_status = outcome.ok ? 'verified' : 'failed'
        allVerified &&= outcome.ok
        if (outcome.ok && mutation.kind !== 'db') refreshOwnedRollbackFences(state)
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
        stateStore.save(state)
        return resultFromState(state, 'B8_READY_READBACK', 'IDEMPOTENT_READY', [])
      }
      return resultFromState(state, 'B8_READY_READBACK', 'NO_GO', readback.reasonCodes ?? ['NO_GO_READY_PREDICATE_FALSE'])
    }

    for (const stage of BOOTSTRAP_STAGES) {
      const record = state.stages.find((candidate) => candidate.stage === stage)!
      if (options.resumeRunId && record.status === 'passed' && stage !== 'B0_LOCK_AND_SNAPSHOT' && stage !== 'B1_DEPENDENCY_PREFLIGHT') {
        if (!ports.revalidateStage) return resultFromState(state, stage, 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
        const revalidated = await boundedDeadline(stage, (signal) => ports.revalidateStage!(context(signal), stage))
        if (!revalidated.ok) {
          state.terminal_status = 'NO_GO'
          state.updated_at = nowIso()
          stateStore.save(state)
          return resultFromState(state, stage, 'NO_GO', ['NO_GO_RESUME_INPUT_MISMATCH'])
        }
        record.evidence_refs = [...new Set([...record.evidence_refs, ...(revalidated.evidenceRefs ?? [])])]
        state.updated_at = nowIso()
        stateStore.save(state)
        continue
      }
      record.status = options.dryRun ? 'planned' : 'pending'
      record.started_at = nowIso()
      record.reason_codes = []
      const method = STAGE_METHOD[stage]
      const outcome = await boundedDeadline(stage, (signal) => ports[method](context(signal)))
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
        if (!options.dryRun) {
          refreshOwnedRollbackFences(state)
          stateStore.save(state)
        }
        return resultFromState(state, stage, 'NO_GO', record.reason_codes.length > 0 ? record.reason_codes : ['NO_GO_READY_PREDICATE_FALSE'])
      }
      record.status = options.dryRun ? 'planned' : 'passed'
      if (!options.dryRun) stateStore.save(state)
    }

    state.terminal_status = options.dryRun ? 'PLANNED' : 'READY'
    state.updated_at = nowIso()
    if (!options.dryRun) {
      if (!refreshOwnedRollbackFences(state)) {
        state.terminal_status = 'NO_GO'
        stateStore.save(state)
        return resultFromState(state, 'B8_READY_READBACK', 'NO_GO', ['NO_GO_ROLLBACK_UNVERIFIED'])
      }
      stateStore.save(state)
    }
    return resultFromState(state, 'B8_READY_READBACK', state.terminal_status, [])
  } finally {
    if (lockHeld) stateStore.releaseLock(agentId, runId)
  }
}

export const bootstrapInternal = {
  defaultCommandRunner,
  runStdioMcpRecovery,
}
