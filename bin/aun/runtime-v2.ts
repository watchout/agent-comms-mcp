import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDbAdapter, PgAdapter, SqliteAdapter, type DbAdapter } from '../../core/db'
import {
  AUN_RUNTIME_V2_CLAIM_SOURCE,
  buildAunRuntimeV2Plan,
  runAunRuntimeV2,
  validateAunRuntimeV2ExecutionFence,
  validateAunRuntimeV2LiveCapability,
  validateAunRuntimeV2Plan,
  type AunRuntimeV2Options,
  type AunRuntimeV2Outcome,
  type AunRuntimeV2Plan,
} from '../../core/aun-runtime-v2'
import {
  buildAunRuntimeV2ReadOnlyPlan,
  validateAunRuntimeV2ReadOnlyPlanArgs,
  type AunRuntimeV2ReadOnlyPlan,
  type AunRuntimeV2ReadOnlyPlanError,
} from '../../core/aun-runtime-v2-plan'
import {
  buildAunRuntimeV2ClaimDryRun,
  validateAunRuntimeV2ClaimDryRunArgs,
  type AunRuntimeV2ClaimDryRun,
  type AunRuntimeV2ClaimDryRunError,
} from '../../core/aun-runtime-v2-claim-plan'
import {
  buildAunRuntimeV2LiveClaim,
  validateAunRuntimeV2LiveClaimArgs,
  type AunRuntimeV2LiveClaim,
  type AunRuntimeV2LiveClaimError,
} from '../../core/aun-runtime-v2-live-claim'
import {
  buildCodexExecQueueWorkCommand,
  createWritebackSender,
  describeCodexExecFailure,
  repoRoot,
  type RunQueueWorkPlan,
} from './run-queue-work'
import { ShirubeD1RuntimeController } from '../../core/shirube-d1-runtime'
import {
  QUEUE_WORK_RESULT_VERSION,
  type LlmRuntimeAdapter,
  type QueueReplySender,
  type QueueWorkEnvelope,
  type QueueWorkResult,
} from '../../core/queue-work'

export interface RuntimeV2CliOptions extends AunRuntimeV2Options {
  mode?: 'execute' | 'plan' | 'claim'
  format?: 'json'
  liveCanary?: boolean
}

export interface RuntimeV2CliResult {
  ok: boolean
  dry_run: boolean
  plan: AunRuntimeV2Plan
  outcome?: AunRuntimeV2Outcome
  error?: string
}

export interface RuntimeV2PlanCliResult {
  ok: boolean
  code: number
  result: AunRuntimeV2ReadOnlyPlan | AunRuntimeV2ReadOnlyPlanError
}

export interface RuntimeV2ClaimDryRunCliResult {
  ok: boolean
  code: number
  result: AunRuntimeV2ClaimDryRun | AunRuntimeV2ClaimDryRunError
}

export interface RuntimeV2ClaimLiveCanaryCliResult {
  ok: boolean
  code: number
  result: AunRuntimeV2LiveClaim | AunRuntimeV2LiveClaimError
}

function parseArgs(argv: string[]): RuntimeV2CliOptions {
  const out: RuntimeV2CliOptions = {}
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === 'runtime-v2') continue
    if (tok === 'plan') out.mode = 'plan'
    if (tok === 'claim') out.mode = 'claim'
    if (tok === '--agent-id') out.agentId = argv[++i]
    else if (tok === '--queue-id') out.queueId = argv[++i]
    else if (tok === '--message-id') out.messageId = argv[++i]
    else if (tok === '--created-after') out.createdAfter = argv[++i]
    else if (tok === '--runtime') out.runtime = argv[++i]
    else if (tok === '--claim-ttl-seconds') out.claimTtlSeconds = Number(argv[++i])
    else if (tok === '--finalize') out.finalize = true
    else if (tok === '--dry-run') out.dryRun = true
    else if (tok === '--live-canary') out.liveCanary = true
    else if (tok === '--json') out.format = 'json'
    else if (tok === '--format') out.format = argv[++i] as 'json'
  }
  return out
}

function queueWorkPlanFromRuntimeV2(plan: AunRuntimeV2Plan, env: NodeJS.ProcessEnv): RunQueueWorkPlan {
  return {
    repoRoot: plan.repoRoot ?? repoRoot(),
    agent_id: plan.agent_id,
    queue_id: plan.queue_id,
    runtime: plan.runtime,
    invocation_source: plan.invocation_source,
    expected_claim_source: plan.expected_claim_source,
    finalize: plan.finalize,
    github_writeback_mode: env.AUN_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? null,
    adapter_contract: 'queue_work_envelope_v1_stdin_to_queue_work_result_v1_stdout',
  }
}

interface ExecResult {
  status: number
  stdout: string
  stderr: string
  errorMessage?: string
  signal?: string | null
  killed?: boolean
}

function execFileAsync(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; input?: string; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      encoding: 'utf-8',
      signal: opts.signal,
    }, (err, stdout, stderr) => {
      const execErr = err as (NodeJS.ErrnoException & {
        code?: unknown
        signal?: string | null
        killed?: boolean
      }) | null
      resolvePromise({
        status: err == null ? 0 : typeof execErr.code === 'number' ? execErr.code : 1,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        errorMessage: execErr?.message,
        signal: execErr?.signal ?? null,
        killed: execErr?.killed,
      })
    })
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

function positiveExecutionTimeoutMs(raw: string | undefined): number {
  const value = Number(raw ?? '600000')
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('AUN queue-work execution timeout must be a finite positive integer')
  }
  return value
}

class EchoRuntimeAdapter implements LlmRuntimeAdapter {
  runtime_id = 'echo'
  capabilities = {
    input: 'stdin_prompt',
    output: 'schema_json',
    supportsBareMode: true,
    supportsResume: false,
    supportsToolAllowlist: false,
    supportsSandbox: false,
    supportsUsageMetadata: false,
  } as const

  async invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult> {
    return {
      schema_version: QUEUE_WORK_RESULT_VERSION,
      ok: true,
      summary: `echo runtime-v2 processed queue_id=${envelope.queue_id}`,
      reply: envelope.reply_contract.required
        ? `Processed queue_id=${envelope.queue_id}\n\n${envelope.content}`
        : null,
      evidence: [
        `semantic_outcome=${envelope.reply_contract.required ? 'reply' : 'close'}`,
        'outcome_reason=runtime_v2_echo_completed',
        `queue_id=${envelope.queue_id}`,
      ],
      next_action: envelope.reply_contract.required ? 'reply' : 'close',
    }
  }
}

function parseQueueWorkResultJson(raw: string): QueueWorkResult {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('codex exec produced an empty final message')
  try {
    return JSON.parse(trimmed) as QueueWorkResult
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as QueueWorkResult
    }
    throw new Error('codex exec final message was not JSON')
  }
}

class CodexExecRuntimeAdapter implements LlmRuntimeAdapter {
  runtime_id = 'codex-exec'
  readonly execution_timeout_ms: number
  readonly supportsAbort = true
  capabilities = {
    input: 'stdin_context',
    output: 'schema_json',
    supportsBareMode: true,
    supportsResume: false,
    supportsToolAllowlist: false,
    supportsSandbox: true,
    supportsUsageMetadata: true,
  } as const

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.execution_timeout_ms = positiveExecutionTimeoutMs(
      env.AUN_QUEUE_WORK_CODEX_TIMEOUT_MS ?? env.AUN_QUEUE_WORK_TIMEOUT_MS,
    )
  }

  async invoke(envelope: QueueWorkEnvelope, opts?: { signal?: AbortSignal }): Promise<QueueWorkResult> {
    const dir = mkdtempSync(join(tmpdir(), 'aun-runtime-v2-codex-'))
    const outputLastMessagePath = join(dir, 'final-message.json')
    try {
      const command = buildCodexExecQueueWorkCommand({
        envelope,
        cwd: this.cwd,
        env: this.env,
        outputLastMessagePath,
      })
      if (!existsSync(command.schemaPath)) {
        throw new Error(`queue work result schema missing: ${command.schemaPath}`)
      }
      const child = await execFileAsync(command.command, command.args, {
        cwd: this.cwd,
        env: this.env,
        input: command.stdin,
        timeout: this.execution_timeout_ms,
        maxBuffer: 1024 * 1024 * 20,
        signal: opts?.signal,
      })
      if (child.status !== 0) {
        throw new Error(describeCodexExecFailure({
          result: child,
          outputLastMessagePath,
        }))
      }
      if (!existsSync(outputLastMessagePath)) {
        throw new Error('codex exec did not write --output-last-message')
      }
      return parseQueueWorkResultJson(readFileSync(outputLastMessagePath, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

class CommandJsonRuntimeAdapter implements LlmRuntimeAdapter {
  runtime_id = 'command-json'
  readonly execution_timeout_ms: number
  readonly supportsAbort = true
  capabilities = {
    input: 'stdin_prompt',
    output: 'schema_json',
    supportsBareMode: false,
    supportsResume: false,
    supportsToolAllowlist: false,
    supportsSandbox: false,
    supportsUsageMetadata: false,
  } as const

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.execution_timeout_ms = positiveExecutionTimeoutMs(env.AUN_QUEUE_WORK_TIMEOUT_MS)
  }

  async invoke(envelope: QueueWorkEnvelope, opts?: { signal?: AbortSignal }): Promise<QueueWorkResult> {
    const child = await execFileAsync(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      input: JSON.stringify(envelope) + '\n',
      timeout: this.execution_timeout_ms,
      maxBuffer: 1024 * 1024 * 20,
      signal: opts?.signal,
    })
    if (child.status !== 0) {
      throw new Error(`runtime command failed status=${child.status} stderr=${child.stderr.slice(0, 1000)}`)
    }
    return JSON.parse(child.stdout || '{}') as QueueWorkResult
  }
}

function commandArgsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AUN_QUEUE_WORK_ARGS_JSON ?? env.STATE_DAEMON_QUEUE_WORK_ARGS_JSON
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string')) {
    throw new Error('AUN_QUEUE_WORK_ARGS_JSON must be a JSON string array')
  }
  return parsed
}

function createRuntimeAdapter(plan: RunQueueWorkPlan, env: NodeJS.ProcessEnv): LlmRuntimeAdapter {
  if (plan.runtime === 'echo') return new EchoRuntimeAdapter()
  if (plan.runtime === 'codex-exec') return new CodexExecRuntimeAdapter(plan.repoRoot, env)
  if (plan.runtime === 'command-json') {
    const command = env.AUN_QUEUE_WORK_COMMAND ?? env.STATE_DAEMON_QUEUE_WORK_COMMAND
    if (!command) {
      throw new Error('AUN_QUEUE_WORK_COMMAND is required when runtime=command-json')
    }
    return new CommandJsonRuntimeAdapter(command, commandArgsFromEnv(env), plan.repoRoot, env)
  }
  throw new Error(`unsupported runtime-v2 runtime: ${plan.runtime}`)
}

class AgentComCliReplySender implements QueueReplySender {
  constructor(private readonly cwd: string, private readonly env: NodeJS.ProcessEnv) {}

  async sendReply(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    content: string
    mention: string | null
    idempotency_key?: string | null
  }): Promise<{ message_id?: string | null }> {
    if (!input.mention) throw new Error('reply mention is required for agent-com send')
    const child = await execFileAsync('bun', [
      'cli/index.ts',
      'send',
      '--content',
      input.content,
      '--mentions',
      input.mention,
      '--queue-id',
      input.queue_id,
      ...(input.message_id ? ['--message-id', input.message_id] : []),
      ...(input.idempotency_key ? ['--d1-invocation-key', input.idempotency_key, '--no-close'] : []),
    ], {
      cwd: this.cwd,
      env: {
        ...this.env,
        AGENT_ID: input.agent_id,
        AGENT_COM_EXPECTED_AGENT_ID: input.agent_id,
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 5,
    })
    if (child.status !== 0) {
      throw new Error(`agent-com send failed status=${child.status} stderr=${child.stderr}`)
    }
    const parsed = JSON.parse(child.stdout || '{}')
    return { message_id: parsed.message_id ?? null }
  }
}

function toLegacyDb(db: ReturnType<typeof createDbAdapter>) {
  return {
    async query<T = any>(sql: string, params?: unknown[]) {
      const rows = await db.query<T>(sql, params as any[])
      return { rows, rowCount: rows.length }
    },
  }
}

const MUTATION_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|CALL|DO)\b/i

function toReadOnlyLegacyDb(db: DbAdapter) {
  return {
    async query<T = any>(sql: string, params?: unknown[]) {
      if (MUTATION_SQL.test(sql)) {
        throw new Error(`runtime-v2 plan attempted non-read SQL: ${sql.trim().slice(0, 80)}`)
      }
      const rows = await db.query<T>(sql, params as any[])
      return { rows, rowCount: rows.length }
    },
  }
}

function createReadOnlyPlanDbAdapter(env: NodeJS.ProcessEnv): DbAdapter {
  const dbType = env.AGENT_COM_DB || (env.DATABASE_URL ? 'postgres' : 'sqlite')
  if (dbType === 'postgres' || dbType === 'postgresql') {
    return new PgAdapter(env.DATABASE_URL)
  }
  const dbPath = env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
  return new SqliteAdapter(dbPath, { readonly: true, create: false })
}

function createLiveClaimDbAdapter(env: NodeJS.ProcessEnv): DbAdapter {
  const dbType = env.AGENT_COM_DB || (env.DATABASE_URL ? 'postgres' : 'sqlite')
  if (dbType === 'postgres' || dbType === 'postgresql') {
    return new PgAdapter(env.DATABASE_URL)
  }
  const dbPath = env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
  if (!existsSync(dbPath)) {
    throw new Error(`sqlite database not found: ${dbPath}`)
  }
  return new SqliteAdapter(dbPath)
}

interface RuntimeV2DbUnreachableError {
  error: 'db_unreachable'
  message: string
}

function dbUnreachableError(err: unknown): RuntimeV2DbUnreachableError {
  return {
    error: 'db_unreachable',
    message: (err as Error).message ?? String(err),
  }
}

function claimDbUnreachableError(err: unknown): RuntimeV2DbUnreachableError {
  return dbUnreachableError(err)
}

export async function runtimeV2Plan(opts: RuntimeV2CliOptions = {}): Promise<RuntimeV2PlanCliResult> {
  const env = opts.env ?? process.env
  if (opts.format !== 'json') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun runtime-v2 plan requires --json',
      },
    }
  }

  const args = validateAunRuntimeV2ReadOnlyPlanArgs({
    agentId: opts.agentId,
    queueId: opts.queueId,
    messageId: opts.messageId,
    createdAfter: opts.createdAfter,
    env,
    now: opts.now,
  })
  if (!args.ok) {
    return { ok: false, code: args.error.error === 'db_unreachable' ? 1 : 2, result: args.error }
  }

  let db: DbAdapter
  try {
    db = createReadOnlyPlanDbAdapter(env)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: dbUnreachableError(err),
    }
  }

  try {
    const result = await buildAunRuntimeV2ReadOnlyPlan(toReadOnlyLegacyDb(db), {
      agentId: opts.agentId,
      queueId: opts.queueId,
      messageId: opts.messageId,
      createdAfter: opts.createdAfter,
      env,
      now: opts.now,
    })
    if ('error' in result) {
      return {
        ok: false,
        code: result.error === 'invalid_arguments' || result.error === 'fence_required' ? 2 : 1,
        result,
      }
    }
    return { ok: true, code: 0, result }
  } finally {
    await db.close()
  }
}

export async function runtimeV2ClaimDryRun(
  opts: RuntimeV2CliOptions = {},
): Promise<RuntimeV2ClaimDryRunCliResult> {
  const env = opts.env ?? process.env
  if (opts.format !== 'json') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun runtime-v2 claim --dry-run requires --json',
      },
    }
  }

  const args = validateAunRuntimeV2ClaimDryRunArgs({
    agentId: opts.agentId,
    queueId: opts.queueId,
    messageId: opts.messageId,
    createdAfter: opts.createdAfter,
    env,
    now: opts.now,
    dryRun: opts.dryRun,
  })
  if (!args.ok) {
    return { ok: false, code: 2, result: args.error }
  }

  let db: DbAdapter
  try {
    db = createReadOnlyPlanDbAdapter(env)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: claimDbUnreachableError(err),
    }
  }

  try {
    const result = await buildAunRuntimeV2ClaimDryRun(toReadOnlyLegacyDb(db), {
      agentId: opts.agentId,
      queueId: opts.queueId,
      messageId: opts.messageId,
      createdAfter: opts.createdAfter,
      env,
      now: opts.now,
      dryRun: opts.dryRun,
    })
    if ('error' in result) {
      return {
        ok: false,
        code: result.error === 'db_unreachable' ? 1 : 2,
        result,
      }
    }
    return { ok: true, code: 0, result }
  } finally {
    await db.close()
  }
}

export async function runtimeV2ClaimLiveCanary(
  opts: RuntimeV2CliOptions = {},
): Promise<RuntimeV2ClaimLiveCanaryCliResult> {
  const env = opts.env ?? process.env
  if (opts.format !== 'json') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun runtime-v2 claim --live-canary requires --json',
      },
    }
  }

  const args = validateAunRuntimeV2LiveClaimArgs({
    agentId: opts.agentId,
    queueId: opts.queueId,
    messageId: opts.messageId,
    createdAfter: opts.createdAfter,
    env,
    now: opts.now,
    liveCanary: opts.liveCanary,
    claimTtlSeconds: opts.claimTtlSeconds,
  })
  if (!args.ok) {
    return { ok: false, code: 2, result: args.error }
  }

  let db: DbAdapter
  try {
    db = createLiveClaimDbAdapter(env)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: claimDbUnreachableError(err),
    }
  }

  try {
    const result = await buildAunRuntimeV2LiveClaim(toLegacyDb(db), {
      agentId: opts.agentId,
      queueId: opts.queueId,
      messageId: opts.messageId,
      createdAfter: opts.createdAfter,
      env,
      now: opts.now,
      liveCanary: opts.liveCanary,
      claimTtlSeconds: opts.claimTtlSeconds,
    })
    if ('error' in result) {
      return {
        ok: false,
        code: result.error === 'db_unreachable' ? 1 : 2,
        result,
      }
    }
    return { ok: result.claim.claimed, code: result.claim.claimed ? 0 : 1, result }
  } finally {
    await db.close()
  }
}

export async function runtimeV2(opts: RuntimeV2CliOptions = {}): Promise<RuntimeV2CliResult> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? repoRoot()
  const db = createDbAdapter(env.DATABASE_URL)
  const legacyDb = toLegacyDb(db)
  let plan: AunRuntimeV2Plan | undefined
  try {
    const d1Runtime = new ShirubeD1RuntimeController(db, { env, now: opts.now })
    plan = buildAunRuntimeV2Plan({
      ...opts,
      env,
      cwd,
      d1Runtime,
      claimSource: opts.claimSource ?? AUN_RUNTIME_V2_CLAIM_SOURCE,
    })
    const validPlan = validateAunRuntimeV2Plan(plan)
    if (!validPlan.ok) {
      return {
        ok: false,
        dry_run: !!opts.dryRun,
        plan,
        error: validPlan.detail ?? validPlan.code,
      }
    }
    if (!opts.dryRun) {
      const validFence = validateAunRuntimeV2ExecutionFence(plan)
      if (!validFence.ok) {
        return {
          ok: false,
          dry_run: false,
          plan,
          error: validFence.detail,
        }
      }
      const validLiveAgent = validateAunRuntimeV2LiveCapability(plan)
      if (!validLiveAgent.ok) {
        return {
          ok: false,
          dry_run: false,
          plan,
          error: validLiveAgent.detail,
        }
      }
    }
    const queueWorkPlan = queueWorkPlanFromRuntimeV2(plan, env)
    const outcome = await runAunRuntimeV2(legacyDb, {
      ...opts,
      env,
      cwd,
      claimSource: plan.claim_source,
      invocationSource: plan.invocation_source,
      expectedClaimSource: plan.expected_claim_source,
      adapter: opts.dryRun ? undefined : createRuntimeAdapter(queueWorkPlan, env),
      replySender: plan.finalize ? new AgentComCliReplySender(queueWorkPlan.repoRoot, env) : undefined,
      writebackSender: plan.finalize ? createWritebackSender(queueWorkPlan, env) : undefined,
      d1Runtime,
    })
    return {
      ok: outcome.ok,
      dry_run: outcome.dry_run,
      plan,
      outcome,
    }
  } catch (err) {
    const fallbackPlan = buildAunRuntimeV2Plan({
      ...opts,
      env: { ...env, SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1' },
      cwd,
      claimSource: opts.claimSource ?? AUN_RUNTIME_V2_CLAIM_SOURCE,
    })
    return {
      ok: false,
      dry_run: !!opts.dryRun,
      plan: plan ?? fallbackPlan,
      error: (err as Error).message ?? String(err),
    }
  } finally {
    await db.close()
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv)
  if (opts.mode === 'plan') {
    const result = await runtimeV2Plan(opts)
    process.stdout.write(JSON.stringify(result.result, null, 2) + '\n')
    process.exit(result.code)
  }
  if (opts.mode === 'claim') {
    const result = opts.liveCanary
      ? await runtimeV2ClaimLiveCanary(opts)
      : await runtimeV2ClaimDryRun(opts)
    process.stdout.write(JSON.stringify(result.result, null, 2) + '\n')
    process.exit(result.code)
  }

  const result = await runtimeV2(opts)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) {
  void main()
}
