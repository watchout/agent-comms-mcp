import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { createDbAdapter } from '../../core/db'
import {
  QUEUE_WORK_RESULT_VERSION,
  finalizeDoneQueueWork,
  runReceivedQueueWork,
  type LlmRuntimeAdapter,
  type QueueReplySender,
  type QueueWorkEnvelope,
  type QueueWorkResult,
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
  return {
    repoRoot: opts.cwd ?? repoRoot(),
    agent_id: opts.agentId ?? env.AGENT_ID ?? null,
    queue_id: opts.queueId ?? null,
    runtime: opts.runtime ?? env.AUN_QUEUE_WORK_RUNTIME ?? (env.AUN_QUEUE_WORK_COMMAND ? 'command-json' : 'unconfigured'),
    invocation_source: opts.invocationSource ?? env.AUN_QUEUE_WORK_INVOCATION_SOURCE ?? null,
    expected_claim_source: opts.expectedClaimSource ?? env.AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE ?? null,
    finalize: !!opts.finalize,
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

interface ExecResult {
  status: number
  stdout: string
  stderr: string
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
      const status = err == null
        ? 0
        : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : 1
      resolvePromise({ status, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
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
  const raw = env.AUN_QUEUE_WORK_ARGS_JSON
  if (!raw) return []
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
    throw new Error('AUN_QUEUE_WORK_ARGS_JSON must be a JSON string array')
  }
  return parsed
}

function createRuntimeAdapter(plan: RunQueueWorkPlan, env: NodeJS.ProcessEnv): LlmRuntimeAdapter {
  if (plan.runtime === 'echo') return new EchoRuntimeAdapter()
  if (plan.runtime === 'command-json') {
    const command = env.AUN_QUEUE_WORK_COMMAND
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
