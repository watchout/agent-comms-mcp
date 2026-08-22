import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDbAdapter } from '../../core/db'
import {
  QUEUE_WORK_RESULT_VERSION,
  finalizeDoneQueueWork,
  queueWorkResultLooksValid,
  runReceivedQueueWork,
  type LlmRuntimeAdapter,
  type QueueWorkClaimFence,
  type QueueReplySender,
  type QueueWorkEnvelope,
  type QueueWorkGithubIssueCommentWriteback,
  type QueueWorkHandoffContract,
  type QueueWorkRuntimeResultSummary,
  type QueueWorkResult,
  type QueueWorkWritebackSender,
  QueueWorkAdapterInvocationError,
} from '../../core/queue-work'

export interface RunQueueWorkOptions {
  agentId?: string
  queueId?: string
  runtime?: string
  invocationSource?: string
  expectedClaimSource?: string
  claimFence?: QueueWorkClaimFence
  requireClaimFence?: boolean
  finalize?: boolean
  finalizeOnly?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
  runtimeCwd?: string
}

export interface RunQueueWorkPlan {
  repoRoot: string
  runtime_cwd: string
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
    else if (tok === '--finalize-only') {
      out.finalize = true
      out.finalizeOnly = true
    }
    else if (tok === '--dry-run') out.dryRun = true
  }
  return out
}

export function buildRunQueueWorkPlan(opts: RunQueueWorkOptions = {}): RunQueueWorkPlan {
  const env = opts.env ?? process.env
  const envRuntime = env.AUN_QUEUE_WORK_RUNTIME ?? env.STATE_DAEMON_QUEUE_WORK_RUNTIME
  const envCommand = env.AUN_QUEUE_WORK_COMMAND ?? env.STATE_DAEMON_QUEUE_WORK_COMMAND
  const subjectRoot = opts.cwd ?? repoRoot()
  return {
    repoRoot: subjectRoot,
    runtime_cwd: opts.runtimeCwd
      ?? env.AUN_QUEUE_WORK_RUNTIME_CWD
      ?? env.STATE_DAEMON_QUEUE_WORK_RUNTIME_CWD
      ?? subjectRoot,
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

/** Resolve the current Bun runtime without relying on a launchd PATH. */
export function resolveQueueWorkBunExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUN_BUN_EXECUTABLE?.trim()
    || env.STATE_DAEMON_BUN_EXECUTABLE?.trim()
    || process.execPath
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

export type QueueWorkRuntimeEngineId = 'codex-exec' | 'claude-code'

export interface QueueWorkRuntimeEngineConfigurationContract {
  runtime_id: QueueWorkRuntimeEngineId
  result_schema: 'file' | 'inline-json-from-file'
  mcp_config_mode: 'none' | 'strict'
}

/**
 * Every queue-work engine must declare its configuration surface here before
 * a command builder can use it. This keeps schema and MCP requirements from
 * becoming implicit, engine-local defaults.
 */
export const QUEUE_WORK_RUNTIME_ENGINE_CONFIGURATION_CONTRACTS = Object.freeze({
  'codex-exec': Object.freeze({
    runtime_id: 'codex-exec',
    result_schema: 'file',
    mcp_config_mode: 'none',
  }),
  'claude-code': Object.freeze({
    runtime_id: 'claude-code',
    result_schema: 'inline-json-from-file',
    mcp_config_mode: 'strict',
  }),
} satisfies Record<QueueWorkRuntimeEngineId, QueueWorkRuntimeEngineConfigurationContract>)

export interface ResolvedQueueWorkRuntimeEngineConfiguration {
  contract: QueueWorkRuntimeEngineConfigurationContract
  schemaPath: string
  schemaJson: string
  mcpConfig: string | null
  mcpConfigSource: 'not-applicable' | 'generated' | 'inline' | 'file'
}

export interface QueueWorkRuntimeCommand {
  runtimeId: QueueWorkRuntimeEngineId
  command: string
  args: string[]
  stdin: string
  schemaPath: string
}

export interface CodexExecQueueWorkCommand {
  runtimeId: 'codex-exec'
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

const CANONICAL_CLAUDE_NO_SERVER_MCP_CONFIG = JSON.stringify({ mcpServers: {} })

function configurationInvalid(detail: string): never {
  throw new QueueWorkAdapterInvocationError(
    'ADAPTER_CONFIGURATION_INVALID',
    detail,
    false,
  )
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readJsonConfigFile(path: string, label: string): unknown {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return configurationInvalid(`${label} unreadable: ${path}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    return configurationInvalid(`${label} malformed JSON: ${path}`)
  }
}

function resolveResultSchema(input: {
  runtimeId: QueueWorkRuntimeEngineId
  subjectRoot: string
  configuredPath: string | undefined
}): { schemaPath: string; schemaJson: string } {
  if (input.configuredPath !== undefined && !input.configuredPath.trim()) {
    configurationInvalid(`${input.runtimeId} missing required configuration input: result schema path`)
  }
  const schemaPath = resolve(
    input.subjectRoot,
    input.configuredPath ?? defaultQueueWorkResultSchemaPath(input.subjectRoot),
  )
  if (!existsSync(schemaPath)) {
    configurationInvalid(`${input.runtimeId} result schema missing: ${schemaPath}`)
  }
  const schema = readJsonConfigFile(schemaPath, `${input.runtimeId} result schema`)
  if (!jsonRecord(schema)) {
    configurationInvalid(`${input.runtimeId} invalid required configuration input: result schema object`)
  }
  return { schemaPath, schemaJson: JSON.stringify(schema) }
}

function resolveClaudeMcpConfig(input: {
  cwd: string
  configuredValue: string | undefined
}): Pick<ResolvedQueueWorkRuntimeEngineConfiguration, 'mcpConfig' | 'mcpConfigSource'> {
  if (input.configuredValue === undefined) {
    return {
      mcpConfig: CANONICAL_CLAUDE_NO_SERVER_MCP_CONFIG,
      mcpConfigSource: 'generated',
    }
  }
  const configured = input.configuredValue.trim()
  if (!configured) {
    configurationInvalid('claude-code missing required configuration input: mcpServers')
  }

  let parsed: unknown
  let mcpConfig: string
  let mcpConfigSource: 'inline' | 'file'
  if (configured.startsWith('{') || configured.startsWith('[')) {
    try {
      parsed = JSON.parse(configured)
    } catch {
      return configurationInvalid('claude-code malformed required configuration input: MCP config JSON')
    }
    mcpConfig = JSON.stringify(parsed)
    mcpConfigSource = 'inline'
  } else {
    const configPath = resolve(input.cwd, configured)
    if (!existsSync(configPath)) {
      configurationInvalid(`claude-code MCP config file missing: ${configPath}`)
    }
    parsed = readJsonConfigFile(configPath, 'claude-code MCP config')
    mcpConfig = configPath
    mcpConfigSource = 'file'
  }

  if (!jsonRecord(parsed)) {
    configurationInvalid('claude-code invalid required configuration input: MCP config object')
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) {
    configurationInvalid('claude-code missing required configuration input: mcpServers')
  }
  if (!jsonRecord(parsed.mcpServers)) {
    configurationInvalid('claude-code invalid required configuration input type: mcpServers')
  }
  return { mcpConfig, mcpConfigSource }
}

export function resolveQueueWorkRuntimeEngineConfiguration(input: {
  runtimeId: QueueWorkRuntimeEngineId
  cwd: string
  subjectRoot: string
  env: NodeJS.ProcessEnv
}): ResolvedQueueWorkRuntimeEngineConfiguration {
  const contract = QUEUE_WORK_RUNTIME_ENGINE_CONFIGURATION_CONTRACTS[input.runtimeId]
  const configuredSchemaPath = input.runtimeId === 'codex-exec'
    ? input.env.AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
    : input.env.AUN_QUEUE_WORK_CLAUDE_OUTPUT_SCHEMA
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_OUTPUT_SCHEMA
  const schema = resolveResultSchema({
    runtimeId: input.runtimeId,
    subjectRoot: input.subjectRoot,
    configuredPath: configuredSchemaPath,
  })
  const mcp = contract.mcp_config_mode === 'strict'
    ? resolveClaudeMcpConfig({
        cwd: input.cwd,
        configuredValue: input.env.AUN_QUEUE_WORK_CLAUDE_MCP_CONFIG
          ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_MCP_CONFIG,
      })
    : { mcpConfig: null, mcpConfigSource: 'not-applicable' as const }
  return { contract, ...schema, ...mcp }
}

function queueWorkPrompt(envelope: QueueWorkEnvelope, subjectRoot: string): string {
  return [
    'You are the AUN queue-work runtime adapter for one exact queue row.',
    'Return only JSON matching queue_work_result_v1.',
    'Do not call next, inbox, processing, done, send, repair commands, tmux, or Discord.',
    'Do not post to GitHub directly.',
    'Do not inspect unrelated queue rows.',
    `The immutable implementation subject is available read-only at ${subjectRoot}. Inspect that path for repository evidence; do not treat the execution workspace as the implementation subject.`,
    'For terminal completion, evidence must include machine-readable entries semantic_outcome=<reply|handoff|no_reply|close|fail> and outcome_reason=<stable_reason>.',
    'If handoff_contract.github_backed is true, include writeback.mode="github_issue_comment" with repo, issue_number, body, and evidence. The trusted wrapper will post it.',
    'If handoff_contract.github_backed is false, omit writeback or set it to null.',
    'If reply_contract.required is false, use next_action "close" and omit reply.',
    'If reply_contract.required is true and you can answer, use next_action "reply" with reply text.',
    'A negative audit, gate, or domain finding is still successfully completed work: return ok=true and put the finding in summary, evidence, writeback, and reply as applicable.',
    'Use ok=false only when the requested inspection or work itself could not be completed safely.',
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

function withAdapterEvidence(result: QueueWorkResult, evidence: string[]): QueueWorkResult {
  return {
    ...result,
    evidence: Array.from(new Set([...(result.evidence ?? []), ...evidence])),
  }
}

/**
 * Secondary result transport for a successful Codex invocation whose
 * --output-last-message file was not materialized. Only the exact final
 * agent_message item from the same JSONL stream is eligible.
 */
export function parseCodexJsonlQueueWorkFallback(stdout: string): QueueWorkResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let finalText: string | null = null
  for (const [index, line] of lines.entries()) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new QueueWorkAdapterInvocationError(
        'CODEX_OUTPUT_LAST_MESSAGE_MISSING',
        `codex output-last-message missing and JSONL fallback is malformed at line ${index + 1}`,
        false,
      )
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    const item = record.item && typeof record.item === 'object' && !Array.isArray(record.item)
      ? record.item as Record<string, unknown>
      : null
    if (
      record.type === 'item.completed'
      && item?.type === 'agent_message'
      && typeof item.text === 'string'
      && item.text.trim()
    ) {
      finalText = item.text
    }
  }
  if (!finalText) {
    throw new QueueWorkAdapterInvocationError(
      'CODEX_OUTPUT_LAST_MESSAGE_MISSING',
      'codex output-last-message missing and JSONL fallback has no completed agent_message',
      false,
    )
  }
  let parsed: QueueWorkResult
  try {
    parsed = parseQueueWorkResultJson(finalText)
  } catch {
    throw new QueueWorkAdapterInvocationError(
      'CODEX_OUTPUT_LAST_MESSAGE_MISSING',
      'codex output-last-message missing and JSONL agent_message violates queue_work_result_v1',
      false,
    )
  }
  if (!queueWorkResultLooksValid(parsed)) {
    throw new QueueWorkAdapterInvocationError(
      'CODEX_OUTPUT_LAST_MESSAGE_MISSING',
      'codex output-last-message missing and JSONL agent_message violates queue_work_result_v1',
      false,
    )
  }
  return withAdapterEvidence(parsed, [
    'runtime_adapter_fallback=codex_jsonl_agent_message',
    'runtime_adapter_primary_failure=CODEX_OUTPUT_LAST_MESSAGE_MISSING',
  ])
}

export function parseClaudeStreamJsonQueueWorkResult(stdout: string): QueueWorkResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let finalEvent: Record<string, unknown> | null = null
  for (const [index, line] of lines.entries()) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new QueueWorkAdapterInvocationError(
        'CLAUDE_FINAL_RESULT_MISSING',
        `claude stream-json is malformed at line ${index + 1}`,
        false,
      )
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    if (record.type === 'result') finalEvent = record
  }
  if (!finalEvent) {
    throw new QueueWorkAdapterInvocationError(
      'CLAUDE_FINAL_RESULT_MISSING',
      'claude stream-json has no final result event',
      false,
    )
  }
  if (finalEvent.is_error === true) {
    throw new QueueWorkAdapterInvocationError(
      'RUNTIME_NONZERO_EXIT',
      'claude final result event reports is_error=true',
      true,
    )
  }
  const structured = finalEvent.structured_output
  let parsed: QueueWorkResult
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    parsed = structured as QueueWorkResult
  } else if (typeof finalEvent.result === 'string') {
    try {
      parsed = parseQueueWorkResultJson(finalEvent.result)
    } catch {
      throw new QueueWorkAdapterInvocationError(
        'ADAPTER_RESULT_INVALID',
        'claude final result violates queue_work_result_v1',
        false,
      )
    }
  } else if (finalEvent.result && typeof finalEvent.result === 'object' && !Array.isArray(finalEvent.result)) {
    parsed = finalEvent.result as QueueWorkResult
  } else {
    throw new QueueWorkAdapterInvocationError(
      'CLAUDE_FINAL_RESULT_MISSING',
      'claude final result event has no structured_output or result',
      false,
    )
  }
  if (!queueWorkResultLooksValid(parsed)) {
    throw new QueueWorkAdapterInvocationError(
      'ADAPTER_RESULT_INVALID',
      'claude final result violates queue_work_result_v1',
      false,
    )
  }
  return withAdapterEvidence(parsed, ['runtime_adapter_engine=claude-code'])
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
  subjectRoot?: string
  env: NodeJS.ProcessEnv
  outputLastMessagePath: string
}): CodexExecQueueWorkCommand {
  const subjectRoot = input.subjectRoot ?? input.cwd
  const configuration = resolveQueueWorkRuntimeEngineConfiguration({
    runtimeId: 'codex-exec',
    cwd: input.cwd,
    subjectRoot,
    env: input.env,
  })
  const schemaPath = configuration.schemaPath
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
    // Runtime workspaces are DB-authorized agent roots and need not be Git
    // repositories. The immutable subject, read-only sandbox, and queue fence
    // remain separate authority boundaries.
    '--skip-git-repo-check',
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
    runtimeId: 'codex-exec',
    command,
    args,
    stdin: queueWorkPrompt(input.envelope, subjectRoot),
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
    private readonly subjectRoot: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult> {
    const dir = mkdtempSync(join(tmpdir(), 'aun-queue-work-codex-'))
    const outputLastMessagePath = join(dir, 'final-message.json')
    try {
      const plan = buildCodexExecQueueWorkCommand({
        envelope,
        cwd: this.cwd,
        subjectRoot: this.subjectRoot,
        env: this.env,
        outputLastMessagePath,
      })
      const child = await execFileAsync(plan.command, plan.args, {
        cwd: this.cwd,
        env: this.env,
        input: plan.stdin,
        timeout: Number.parseInt(this.env.AUN_QUEUE_WORK_CODEX_TIMEOUT_MS ?? this.env.AUN_QUEUE_WORK_TIMEOUT_MS ?? '600000', 10),
        maxBuffer: 1024 * 1024 * 20,
      })
      if (child.status !== 0) {
        throw classifyQueueWorkRuntimeExecFailure({
          runtimeId: plan.runtimeId,
          result: child,
          detail: describeCodexExecFailure({ result: child, outputLastMessagePath }),
        })
      }
      if (!existsSync(outputLastMessagePath)) {
        return parseCodexJsonlQueueWorkFallback(child.stdout)
      }
      try {
        return parseQueueWorkResultJson(readFileSync(outputLastMessagePath, 'utf8'))
      } catch {
        throw new QueueWorkAdapterInvocationError(
          'ADAPTER_RESULT_INVALID',
          'codex output-last-message violates queue_work_result_v1',
          false,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export interface ClaudeCodeQueueWorkCommand {
  runtimeId: 'claude-code'
  command: string
  args: string[]
  stdin: string
  schemaPath: string
  mcpConfigSource: 'generated' | 'inline' | 'file'
}

export function buildClaudeCodeQueueWorkCommand(input: {
  envelope: QueueWorkEnvelope
  cwd: string
  subjectRoot?: string
  env: NodeJS.ProcessEnv
}): ClaudeCodeQueueWorkCommand {
  const subjectRoot = input.subjectRoot ?? input.cwd
  const configuration = resolveQueueWorkRuntimeEngineConfiguration({
    runtimeId: 'claude-code',
    cwd: input.cwd,
    subjectRoot,
    env: input.env,
  })
  if (configuration.mcpConfig === null || configuration.mcpConfigSource === 'not-applicable') {
    configurationInvalid('claude-code missing required configuration input: strict MCP config')
  }
  const command = input.env.AUN_QUEUE_WORK_CLAUDE_EXECUTABLE
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_EXECUTABLE
    ?? 'claude'
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--json-schema', configuration.schemaJson,
    '--permission-mode', input.env.AUN_QUEUE_WORK_CLAUDE_PERMISSION_MODE
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_PERMISSION_MODE
      ?? 'dontAsk',
    '--tools', input.env.AUN_QUEUE_WORK_CLAUDE_TOOLS
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_TOOLS
      ?? '',
    '--allowedTools', input.env.AUN_QUEUE_WORK_CLAUDE_ALLOWED_TOOLS
      ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_ALLOWED_TOOLS
      ?? '',
    '--mcp-config', configuration.mcpConfig,
    '--strict-mcp-config',
    '--safe-mode',
    '--no-session-persistence',
    '--verbose',
  ]
  const model = input.env.AUN_QUEUE_WORK_CLAUDE_MODEL
    ?? input.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_MODEL
  if (model) args.push('--model', model)
  return {
    runtimeId: 'claude-code',
    command,
    args,
    stdin: queueWorkPrompt(input.envelope, subjectRoot),
    schemaPath: configuration.schemaPath,
    mcpConfigSource: configuration.mcpConfigSource,
  }
}

function claudeConfigurationFailureItem(result: ExecResult): string | null {
  const diagnostic = [result.stderr, result.stdout, result.errorMessage].filter(Boolean).join('\n')
  if (/invalid mcp configuration/i.test(diagnostic) || /mcpServers\s*:\s*expected (?:a )?record/i.test(diagnostic)) {
    return 'mcpServers'
  }
  if (/invalid (?:json )?schema/i.test(diagnostic) || /json schema[^\n]*invalid/i.test(diagnostic)) {
    return 'result schema'
  }
  if (/\bENOENT\b/.test(diagnostic)) return 'executable'
  return null
}

export function classifyQueueWorkRuntimeExecFailure(input: {
  runtimeId: QueueWorkRuntimeEngineId
  result: ExecResult
  detail: string
}): QueueWorkAdapterInvocationError {
  if (input.result.killed || input.result.signal) {
    return new QueueWorkAdapterInvocationError('RUNTIME_TIMEOUT', input.detail, true)
  }
  if (input.runtimeId === 'claude-code') {
    const item = claudeConfigurationFailureItem(input.result)
    if (item) {
      return new QueueWorkAdapterInvocationError(
        'ADAPTER_CONFIGURATION_INVALID',
        `claude-code runtime rejected deterministic configuration input: ${item}`,
        false,
      )
    }
  }
  return new QueueWorkAdapterInvocationError('RUNTIME_NONZERO_EXIT', input.detail, true)
}

export class ClaudeCodeRuntimeAdapter implements LlmRuntimeAdapter {
  runtime_id = 'claude-code'
  capabilities = {
    input: 'stdin_context',
    output: 'jsonl_events',
    supportsBareMode: true,
    supportsResume: false,
    supportsToolAllowlist: true,
    supportsSandbox: true,
    supportsUsageMetadata: true,
  } as const

  constructor(
    private readonly cwd: string,
    private readonly subjectRoot: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async invoke(envelope: QueueWorkEnvelope): Promise<QueueWorkResult> {
    const plan = buildClaudeCodeQueueWorkCommand({
      envelope,
      cwd: this.cwd,
      subjectRoot: this.subjectRoot,
      env: this.env,
    })
    const child = await execFileAsync(plan.command, plan.args, {
      cwd: this.cwd,
      env: this.env,
      input: plan.stdin,
      timeout: Number.parseInt(
        this.env.AUN_QUEUE_WORK_CLAUDE_TIMEOUT_MS
          ?? this.env.AUN_QUEUE_WORK_TIMEOUT_MS
          ?? this.env.STATE_DAEMON_QUEUE_WORK_CLAUDE_TIMEOUT_MS
          ?? this.env.STATE_DAEMON_QUEUE_WORK_TIMEOUT_MS
          ?? '600000',
        10,
      ),
      maxBuffer: 1024 * 1024 * 20,
    })
    if (child.status !== 0) {
      throw classifyQueueWorkRuntimeExecFailure({
        runtimeId: plan.runtimeId,
        result: child,
        detail: `claude -p failed status=${child.status} ${snippet('stderr', child.stderr)} ${snippet('stdout', child.stdout)}`,
      })
    }
    return withAdapterEvidence(parseClaudeStreamJsonQueueWorkResult(child.stdout), [
      `runtime_adapter_mcp_config_source=${plan.mcpConfigSource}`,
    ])
  }
}

class FailClosedRuntimePreferenceAdapter implements LlmRuntimeAdapter {
  capabilities = {
    input: 'stdin_context',
    output: 'schema_json',
    supportsBareMode: true,
    supportsResume: false,
    supportsToolAllowlist: false,
    supportsSandbox: true,
    supportsUsageMetadata: false,
  } as const

  constructor(
    readonly runtime_id: 'runtime-preference-required' | 'runtime-preference-unsupported',
  ) {}

  async invoke(): Promise<QueueWorkResult> {
    const code = this.runtime_id === 'runtime-preference-required'
      ? 'RUNTIME_ENGINE_PREFERENCE_REQUIRED'
      : 'RUNTIME_ENGINE_PREFERENCE_UNSUPPORTED'
    throw new QueueWorkAdapterInvocationError(code, code, false)
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

type QueueWorkRuntimeAdapterFactory = (
  plan: RunQueueWorkPlan,
  env: NodeJS.ProcessEnv,
) => LlmRuntimeAdapter

const QUEUE_WORK_RUNTIME_ADAPTER_FACTORIES = Object.freeze({
  'codex-exec': (plan, env) => new CodexExecRuntimeAdapter(plan.runtime_cwd, plan.repoRoot, env),
  'claude-code': (plan, env) => new ClaudeCodeRuntimeAdapter(plan.runtime_cwd, plan.repoRoot, env),
} satisfies Record<QueueWorkRuntimeEngineId, QueueWorkRuntimeAdapterFactory>)

function createRuntimeAdapter(plan: RunQueueWorkPlan, env: NodeJS.ProcessEnv): LlmRuntimeAdapter {
  if (plan.runtime === 'echo') return new EchoRuntimeAdapter()
  if (Object.prototype.hasOwnProperty.call(QUEUE_WORK_RUNTIME_ADAPTER_FACTORIES, plan.runtime)) {
    return QUEUE_WORK_RUNTIME_ADAPTER_FACTORIES[plan.runtime as QueueWorkRuntimeEngineId](plan, env)
  }
  if (plan.runtime === 'runtime-preference-required' || plan.runtime === 'runtime-preference-unsupported') {
    return new FailClosedRuntimePreferenceAdapter(plan.runtime)
  }
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
  readonly queue_close_mode = 'sender' as const

  constructor(
    private readonly repoRoot: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly expectedRuntimeId: string,
  ) {}

  async sendReply(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    content: string
    mention: string | null
    idempotency_key?: string | null
  }): Promise<{ message_id?: string | null }> {
    if (!input.mention) {
      throw new Error('reply mention is required for agent-com send')
    }
    const child = await execFileAsync(resolveQueueWorkBunExecutable(this.env), [
      'cli/index.ts',
      'send',
      '--content',
      input.content,
      '--mentions',
      input.mention,
      '--queue-id',
      input.queue_id,
      ...(input.message_id ? ['--message-id', input.message_id] : []),
      ...(input.idempotency_key
        ? ['--d1-invocation-key', input.idempotency_key, '--no-close']
        : ['--queue-work-finalizer', '--close']),
    ], {
      cwd: this.repoRoot,
      env: {
        ...this.env,
        AGENT_ID: input.agent_id,
        AGENT_COM_EXPECTED_AGENT_ID: input.agent_id,
        AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID: this.expectedRuntimeId,
      },
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 5,
    })
    if (child.status !== 0) {
      throw new Error([
        `agent-com send failed status=${child.status}`,
        child.errorMessage ? `error=${child.errorMessage}` : null,
        `stderr=${child.stderr}`,
        `stdout=${child.stdout}`,
      ].filter(Boolean).join(' '))
    }
    const parsed = JSON.parse(child.stdout || '{}')
    return {
      message_id: parsed.message_id ?? null,
      queue_closed: parsed.work_closed === true,
    }
  }
}

interface MediatedPostingRequest {
  schema_version: 'queue_work_mediated_posting_request_v1'
  operation?: 'perform' | 'readback'
  queue_id: string
  agent_id: string
  message_id: string | null
  handoff_contract: QueueWorkHandoffContract
  writeback: QueueWorkGithubIssueCommentWriteback
  runtime_result_summary: QueueWorkRuntimeResultSummary
}

function mediatedMarkerForAgent(agentId: string): string {
  if (/^(l1auditor|l2auditor|auditor|codex-audit)$/i.test(agentId)) return 'aun:l2-audit/v1'
  if (/^qa$/i.test(agentId)) return 'aun:qa-check/v1'
  if (/^check$/i.test(agentId)) return 'aun:technical-check/v1'
  if (/^arc$/i.test(agentId)) return 'aun:arc-technical-design/v1'
  if (/^(cto|codex-cto)$/i.test(agentId)) return 'aun:cto-go-no-go/v1'
  return 'aun:state-transition-request/v1'
}

export function frameMediatedGithubWriteback(input: {
  queueId: string
  agentId: string
  messageId: string | null
  writeback: QueueWorkGithubIssueCommentWriteback
}): QueueWorkGithubIssueCommentWriteback {
  const body = input.writeback.body
  if (/^<!--\s*aun:[a-z0-9-]+\/v\d+\s*-->/i.test(body)) return input.writeback
  // A marker anywhere except the first line is invalid and must remain invalid
  // for the trusted wrapper to reject; do not conceal conflicting authority.
  if (/<!--\s*aun:[a-z0-9-]+\/v\d+\s*-->/i.test(body)) return input.writeback
  const headers = [
    `<!-- ${mediatedMarkerForAgent(input.agentId)} -->`,
    `repo: ${input.writeback.repo}`,
    `issue: ${input.writeback.issue_number}`,
    `role: ${input.agentId}`,
    `source_queue_id: ${input.queueId}`,
    ...(input.messageId ? [`source_message_id: ${input.messageId}`] : []),
    'status: completed',
    ...(input.writeback.idempotency_key
      ? [`idempotency_key: ${input.writeback.idempotency_key}`]
      : []),
    '',
    body,
  ]
  return {
    ...input.writeback,
    body: headers.join('\n'),
    // The wrapper returns the digest of the trusted framed body.
    body_sha256: null,
  }
}

class MediatedPostingCommandSender implements QueueWorkWritebackSender {
  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly repoRoot: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  private async invoke(input: {
    queue_id: string
    agent_id: string
    message_id: string | null
    handoff_contract: QueueWorkHandoffContract
    writeback: QueueWorkGithubIssueCommentWriteback
    runtime_result_summary: QueueWorkRuntimeResultSummary
  }, operation: 'perform' | 'readback'): Promise<{ posted_with?: string | null; body_sha256?: string | null }> {
    const request: MediatedPostingRequest = {
      schema_version: 'queue_work_mediated_posting_request_v1',
      operation,
      queue_id: input.queue_id,
      agent_id: input.agent_id,
      message_id: input.message_id,
      handoff_contract: input.handoff_contract,
      writeback: frameMediatedGithubWriteback({
        queueId: input.queue_id,
        agentId: input.agent_id,
        messageId: input.message_id,
        writeback: input.writeback,
      }),
      runtime_result_summary: input.runtime_result_summary,
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
    return {
      posted_with: typeof parsed.posted_with === 'string' ? parsed.posted_with : null,
      body_sha256: typeof parsed.body_sha256 === 'string' ? parsed.body_sha256 : null,
    }
  }

  async sendWriteback(input: Parameters<QueueWorkWritebackSender['sendWriteback']>[0]) {
    return this.invoke(input, 'perform')
  }

  async readWriteback(input: Parameters<QueueWorkWritebackSender['sendWriteback']>[0]) {
    return this.invoke(input, 'readback')
  }
}

export function createWritebackSender(plan: RunQueueWorkPlan, env: NodeJS.ProcessEnv): QueueWorkWritebackSender | undefined {
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
    dialect: db.dialect,
    async query<T = any>(sql: string, params?: unknown[]) {
      const rows = await db.query<T>(sql, params as any[])
      return { rows, rowCount: rows.length }
    },
  }

  try {
    const adapter = createRuntimeAdapter(plan, env)
    const writebackSender = createWritebackSender(plan, env)
    if (opts.finalizeOnly) {
      if (!plan.queue_id || !plan.finalize) {
        return {
          ok: false,
          dry_run: false,
          plan,
          error: 'finalize-only requires queue_id and finalize=true',
        }
      }
      const finalizer = await finalizeDoneQueueWork(legacyDb, {
        queueId: plan.queue_id,
        replySender: new AgentComCliReplySender(plan.repoRoot, env, adapter.runtime_id),
        writebackSender,
        ...(plan.expected_claim_source ? {
          claimResultFence: {
            expectedClaimSource: plan.expected_claim_source,
            expectedRuntimeId: adapter.runtime_id,
          },
        } : {}),
      })
      return {
        ok: finalizer.ok,
        dry_run: false,
        plan,
        finalizer,
      }
    }
    const runner = await runReceivedQueueWork(legacyDb, {
      queueId: plan.queue_id ?? undefined,
      agentId: plan.agent_id ?? undefined,
      adapter,
      invocationSource: plan.invocation_source ?? undefined,
      expectedClaimSource: plan.expected_claim_source ?? undefined,
      claimFence: opts.claimFence,
      requireClaimFence: opts.requireClaimFence ?? plan.expected_claim_source !== null,
    })
    let finalizer: unknown = undefined
    if (plan.finalize && runner.ok) {
      finalizer = await finalizeDoneQueueWork(legacyDb, {
        queueId: runner.queue_id,
        replySender: new AgentComCliReplySender(plan.repoRoot, env, adapter.runtime_id),
        writebackSender,
        ...(plan.expected_claim_source ? {
          claimResultFence: {
            expectedClaimSource: plan.expected_claim_source,
            expectedRuntimeId: adapter.runtime_id,
          },
        } : {}),
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
