import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDbAdapter } from '../../core/db'
import {
  QUEUE_WORK_RESULT_VERSION,
  finalizeDoneQueueWork,
  runReceivedQueueWork,
  type LlmRuntimeAdapter,
  type QueueReplySender,
  type QueueWorkEnvelope,
  type QueueWorkGithubIssueCommentWriteback,
  type QueueWorkResult,
  type QueueWorkWritebackSender,
} from '../../core/queue-work'

export interface RunQueueWorkOptions {
  agentId?: string
  queueId?: string
  runtime?: string
  invocationSource?: string
  expectedClaimSource?: string
  finalize?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface RunQueueWorkPlan {
  repoRoot: string
  agent_id: string | null
  queue_id: string | null
  runtime: string
  invocation_source: string | null
  expected_claim_source: string | null
  finalize: boolean
  github_writeback_mode: string | null
  adapter_contract: 'queue_work_envelope_v1_stdin_to_queue_work_result_v1_stdout'
}

export interface RunQueueWorkCliResult {
  ok: boolean
  dry_run: boolean
  plan: RunQueueWorkPlan
  runner?: unknown
  finalizer?: unknown
  error?: string
}

export function repoRoot(): string {
  return resolve(import.meta.dir, '..', '..')
}

function parseArgs(argv: string[]): RunQueueWorkOptions {
  const out: RunQueueWorkOptions = {}
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--agent-id') out.agentId = argv[++i]
    else if (tok === '--queue-id') out.queueId = argv[++i]
    else if (tok === '--runtime') out.runtime = argv[++i]
    else if (tok === '--expected-claim-source') out.expectedClaimSource = argv[++i]
    else if (tok === '--finalize') out.finalize = true
    else if (tok === '--dry-run') out.dryRun = true
  }
  return out
}

export function buildRunQueueWorkPlan(opts: RunQueueWorkOptions = {}): RunQueueWorkPlan {
  const env = opts.env ?? process.env
  const envRuntime = env.AUN_QUEUE_WORK_RUNTIME ?? env.STATE_DAEMON_QUEUE_WORK_RUNTIME
  const envCommand = env.AUN_QUEUE_WORK_COMMAND ?? env.STATE_DAEMON_QUEUE_WORK_COMMAND
  return {
    repoRoot: opts.cwd ?? repoRoot(),
    agent_id: opts.agentId ?? env.AGENT_ID ?? null,
    queue_id: opts.queueId ?? null,
    runtime: opts.runtime ?? envRuntime ?? (envCommand ? 'command-json' : 'unconfigured'),
    invocation_source: opts.invocationSource ?? env.AUN_QUEUE_WORK_INVOCATION_SOURCE ?? null,
    expected_claim_source: opts.expectedClaimSource ?? env.AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE ?? null,
    finalize: !!opts.finalize,
    github_writeback_mode: env.AUN_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? null,
    adapter_contract: 'queue_work_envelope_v1_stdin_to_queue_work_result_v1_stdout',
  }
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
      summary: `echo runtime processed queue_id=${envelope.queue_id}`,
      reply: envelope.reply_contract.required
        ? `Processed queue_id=${envelope.queue_id}\n\n${envelope.content}`
        : undefined,
      evidence: [],
      next_action: envelope.reply_contract.required ? 'reply' : 'close',
    }
  }
}

export interface ExecResult {
  status: number
  stdout: string
  stderr: string
  errorMessage?: string
  signal?: string | null
  killed?: boolean
}

/**
 * Async execFile so adapter runs never block the caller's event loop — the
 * state-daemon invokes this in-process and must keep heartbeat/sweep/notify
 * handling alive while an LLM runtime works on a queue item.
 */
function execFileAsync(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; input?: string },
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = execFile(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      encoding: 'utf-8',
    }, (err, stdout, stderr) => {
      const execErr = err as (NodeJS.ErrnoException & {
        code?: unknown
        signal?: string | null
        killed?: boolean
      }) | null
      const status = err == null
        ? 0
        : typeof execErr.code === 'number'
          ? execErr.code
          : 1
      resolvePromise({
        status,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        errorMessage: execErr ? execErr.message : undefined,
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

export interface CodexExecQueueWorkCommand {
  command: string
  args: string[]
  stdin: string
  outputLastMessagePath: string
  schemaPath: string
}

function truthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

function defaultQueueWorkResultSchemaPath(cwd: string): string {
  return resolve(cwd, 'schemas', 'queue-work-result-v1.schema.json')
}

function queueWorkPrompt(envelope: QueueWorkEnvelope): string {
  return [
    'You are the AUN queue-work runtime adapter for one exact queue row.',
    'Return only JSON matching queue_work_result_v1.',
    'Do not call next, inbox, processing, done, send, repair commands, tmux, or Discord.',
    'Do not post to GitHub directly.',
    'Do not inspect unrelated queue rows.',
    'If handoff_contract.github_backed is true, include writeback.mode="github_issue_comment" with repo, issue_number, body, and evidence. The trusted wrapper will post it.',
    'If handoff_contract.github_backed is false, set writeback to null.',
    'If reply_contract.required is false, use next_action "close" and omit reply.',
    'If reply_contract.required is true and you can answer, use next_action "reply" with reply text.',
    'If you cannot safely complete the work, return ok=false with next_action "retry" and a concise summary.',
    '',
    JSON.stringify(envelope),
  ].join('\n')
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

function snippet(label: string, value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return `${label}=<empty>`
  return `${label}=${JSON.stringify(trimmed.slice(0, 1000))}`
}

export function describeCodexExecFailure(input: {
  result: ExecResult
  outputLastMessagePath: string
}): string {
  let finalMessage = ''
  try {
    if (existsSync(input.outputLastMessagePath)) {
      finalMessage = readFileSync(input.outputLastMessagePath, 'utf8')
    }
  } catch {
    finalMessage = '<unreadable>'
  }
  return [
    `codex exec failed status=${input.result.status}`,
    input.result.signal ? `signal=${input.result.signal}` : null,
    input.result.killed ? 'killed=true' : null,
    input.result.errorMessage ? snippet('error', input.result.errorMessage) : null,
    snippet('stderr', input.result.stderr),
    snippet('stdout', input.result.stdout),
    finalMessage ? snippet('final_message', finalMessage) : 'final_message=<missing>',
  ].filter(Boolean).join(' ')
}

export function buildCodexExecQueueWorkCommand(input: {
  envelope: QueueWorkEnvelope
  cwd: string
  env: NodeJS.ProcessEnv
  outputLastMessagePath: string
}): CodexExecQueueWorkCommand {
  const schemaPath = resolve(
    input.env.AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
      ?? defaultQueueWorkResultSchemaPath(input.cwd),
  )
  const sandbox = input.env.AUN_QUEUE_WORK_CODEX_SANDBOX
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_SANDBOX
    ?? 'read-only'
  const command = input.env.AUN_QUEUE_WORK_CODEX_EXECUTABLE
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_EXECUTABLE
    ?? 'codex'
  const args = [
    'exec',
    '--json',
    '--output-schema', schemaPath,
    '--output-last-message', input.outputLastMessagePath,
    '--sandbox', sandbox,
    '--cd', input.cwd,
  ]
  const profile = input.env.AUN_QUEUE_WORK_CODEX_PROFILE
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_PROFILE
  if (profile) args.push('--profile', profile)
  const model = input.env.AUN_QUEUE_WORK_CODEX_MODEL
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_MODEL
  if (model) args.push('--model', model)
  if ((input.env.AUN_QUEUE_WORK_CODEX_EPHEMERAL ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_EPHEMERAL) !== '0') {
    args.push('--ephemeral')
  }
  if (truthyEnv(input.env.AUN_QUEUE_WORK_CODEX_IGNORE_RULES ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_IGNORE_RULES)) {
    args.push('--ignore-rules')
  }
  args.push('-')

  return {
    command,
    args,
    stdin: queueWorkPrompt(input.envelope),
    outputLastMessagePath: input.outputLastMessagePath,
    schemaPath,
  }
}

class CodexExecRuntimeAdapter implements LlmRuntimeAdapter {
  runtime_id = 'codex-exec'
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
  ) {}

  async invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult> {
    const dir = mkdtempSync(join(tmpdir(), 'aun-queue-work-codex-'))
    const outputLastMessagePath = join(dir, 'final-message.json')
    try {
      const plan = buildCodexExecQueueWorkCommand({
        envelope,
        cwd: this.cwd,
        env: this.env,
        outputLastMessagePath,
      })
      if (!existsSync(plan.schemaPath)) {
        throw new Error(`queue work result schema missing: ${plan.schemaPath}`)
      }
      const child = await execFileAsync(plan.command, plan.args, {
        cwd: this.cwd,
        env: this.env,
        input: plan.stdin,
        timeout: Number.parseInt(this.env.AUN_QUEUE_WORK_CODEX_TIMEOUT_MS ?? this.env.AUN_QUEUE_WORK_TIMEOUT_MS ?? '600000', 10),
        maxBuffer: 1024 * 1024 * 20,
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
  ) {}

  async invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult> {
    const child = await execFileAsync(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      input: JSON.stringify(envelope) + '\n',
      timeout: Number.parseInt(this.env.AUN_QUEUE_WORK_TIMEOUT_MS ?? '600000', 10),
      maxBuffer: 1024 * 1024 * 20,
    })
    if (child.status !== 0) {
      throw new Error(
        `runtime command failed status=${child.status} stderr=${child.stderr.slice(0, 1000)}`,
      )
    }
    try {
      return JSON.parse(child.stdout || '{}') as QueueWorkResult
    } catch (err) {
      throw new Error(`runtime command returned non-JSON stdout: ${child.stdout.slice(0, 1000)}`)
    }
  }
}

function commandArgsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AUN_QUEUE_WORK_ARGS_JSON ?? env.STATE_DAEMON_QUEUE_WORK_ARGS_JSON
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
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
  throw new Error(`unsupported queue work runtime: ${plan.runtime}`)
}

class AgentComCliReplySender implements QueueReplySender {
  constructor(private readonly repoRoot: string, private readonly env: NodeJS.ProcessEnv) {}

  async sendReply(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    content: string
    mention: string | null
  }): Promise<{ message_id?: string | null }> {
    if (!input.mention) {
      throw new Error('reply mention is required for agent-com send')
    }
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
    ], {
      cwd: this.repoRoot,
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

interface MediatedPostingRequest {
  schema_version: 'queue_work_mediated_posting_request_v1'
  queue_id: string
  agent_id: string
  message_id: string | null
  writeback: QueueWorkGithubIssueCommentWriteback
}

class MediatedPostingCommandSender implements QueueWorkWritebackSender {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly repoRoot: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async sendWriteback(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    writeback: QueueWorkGithubIssueCommentWriteback
  }): Promise<{ posted_with?: string | null }> {
    const request: MediatedPostingRequest = {
      schema_version: 'queue_work_mediated_posting_request_v1',
      queue_id: input.queue_id,
      agent_id: input.agent_id,
      message_id: input.message_id,
      writeback: input.writeback,
    }
    const child = await execFileAsync(this.command, this.args, {
      cwd: this.repoRoot,
      env: {
        ...this.env,
        AGENT_ID: input.agent_id,
        AGENT_COM_EXPECTED_AGENT_ID: input.agent_id,
      },
      input: JSON.stringify(request) + '\n',
      timeout: Number.parseInt(
        this.env.AUN_QUEUE_WORK_MEDIATED_POSTING_TIMEOUT_MS
          ?? this.env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_TIMEOUT_MS
          ?? '120000',
        10,
      ),
      maxBuffer: 1024 * 1024 * 5,
    })
    if (child.status !== 0) {
      throw new Error(`mediated posting command failed status=${child.status} stderr=${child.stderr.slice(0, 1000)}`)
    }
    const parsed = JSON.parse(child.stdout || '{}')
    if (parsed.ok === false) {
      throw new Error(`mediated posting command returned ok=false: ${JSON.stringify(parsed).slice(0, 1000)}`)
    }
    return { posted_with: typeof parsed.posted_with === 'string' ? parsed.posted_with : null }
  }
}

function createWritebackSender(plan: RunQueueWorkPlan, env: NodeJS.ProcessEnv): QueueWorkWritebackSender | undefined {
  if (plan.github_writeback_mode !== 'mediated') return undefined
  const command = env.AUN_QUEUE_WORK_MEDIATED_POSTING_COMMAND
    ?? env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND
  if (!command) {
    throw new Error('AUN_QUEUE_WORK_MEDIATED_POSTING_COMMAND is required when github_writeback_mode=mediated')
  }
  const rawArgs = env.AUN_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
    ?? env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
  const args = rawArgs ? JSON.parse(rawArgs) : []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('AUN_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON must be a JSON string array')
  }
  return new MediatedPostingCommandSender(command, args, plan.repoRoot, env)
}

export async function runQueueWork(opts: RunQueueWorkOptions = {}): Promise<RunQueueWorkCliResult> {
  const env = opts.env ?? process.env
  const plan = buildRunQueueWorkPlan(opts)
  if (opts.dryRun) return { ok: true, dry_run: true, plan }
  if (!plan.queue_id && !plan.agent_id) {
    return {
      ok: false,
      dry_run: false,
      plan,
      error: 'queue_id or agent_id is required',
    }
  }

  const db = createDbAdapter()
  const legacyDb = {
    async query<T = any>(sql: string, params?: unknown[]) {
      const rows = await db.query<T>(sql, params as any[])
      return { rows, rowCount: rows.length }
    },
  }

  try {
    const writebackSender = createWritebackSender(plan, env)
    const runner = await runReceivedQueueWork(legacyDb, {
      queueId: plan.queue_id ?? undefined,
      agentId: plan.agent_id ?? undefined,
      adapter: createRuntimeAdapter(plan, env),
      invocationSource: plan.invocation_source ?? undefined,
      expectedClaimSource: plan.expected_claim_source ?? undefined,
    })
    let finalizer: unknown = undefined
    if (plan.finalize && runner.ok) {
      finalizer = await finalizeDoneQueueWork(legacyDb, {
        queueId: runner.queue_id,
        replySender: new AgentComCliReplySender(plan.repoRoot, env),
        writebackSender,
      })
    }
    return {
      ok: runner.ok && (!plan.finalize || (finalizer as any)?.ok === true),
      dry_run: false,
      plan,
      runner,
      finalizer,
    }
  } catch (err) {
    return {
      ok: false,
      dry_run: false,
      plan,
      error: (err as Error).message ?? String(err),
    }
  } finally {
    await db.close()
  }
}

async function main(): Promise<void> {
  const result = await runQueueWork(parseArgs(process.argv))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) {
  void main()
}
