export type HostRuntimeKind = 'codex' | 'claude' | 'custom'

export type PromptDelivery = 'stdin-json' | 'stdin-text' | 'prompt-arg' | 'session-resume'
export type OutputStream = 'jsonl' | 'json' | 'text'
export type RuntimeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access' | 'host-specific'
export type SecretPolicy = 'none' | 'single-invocation-env' | 'external-secret-store'

export type HostRuntimeFailureCode =
  | 'RUNTIME_PROFILE_REQUIRED'
  | 'RUNTIME_PROFILE_INVALID'
  | 'UNSUPPORTED_RUNTIME'
  | 'RUNTIME_INVOKER_UNCONFIGURED'
  | 'RUNTIME_FLAG_UNSUPPORTED'
  | 'SCHEMA_REQUIRED'
  | 'OUTPUT_SCHEMA_MISMATCH'
  | 'STREAM_PARSE_ERROR'
  | 'FINAL_MESSAGE_MISSING'
  | 'RUNTIME_TIMEOUT'
  | 'RUNTIME_NONZERO_EXIT'
  | 'SANDBOX_POLICY_VIOLATION'

const HOST_RUNTIME_FAILURE_RETRYABILITY: Record<HostRuntimeFailureCode, boolean> = {
  RUNTIME_PROFILE_REQUIRED: false,
  RUNTIME_PROFILE_INVALID: false,
  UNSUPPORTED_RUNTIME: false,
  RUNTIME_INVOKER_UNCONFIGURED: false,
  RUNTIME_FLAG_UNSUPPORTED: false,
  SCHEMA_REQUIRED: false,
  OUTPUT_SCHEMA_MISMATCH: false,
  STREAM_PARSE_ERROR: false,
  FINAL_MESSAGE_MISSING: false,
  RUNTIME_TIMEOUT: true,
  RUNTIME_NONZERO_EXIT: true,
  SANDBOX_POLICY_VIOLATION: false,
}

/**
 * Retryability is a closed control-plane classification. Runtime prose does
 * not get to choose whether the same queue row is invoked again.
 */
export function isHostRuntimeFailureRetryable(code: HostRuntimeFailureCode): boolean {
  return HOST_RUNTIME_FAILURE_RETRYABILITY[code]
}

export interface RuntimeInvocationProfile {
  profile_id: string
  runtime: HostRuntimeKind
  runtime_version_detected?: string
  cwd: string
  allowed_dirs: string[]
  prompt_delivery: PromptDelivery
  output_stream: OutputStream
  final_output_schema_ref?: string
  sandbox: RuntimeSandbox
  approval_mode?: string
  allowed_tools?: string[]
  disallowed_tools?: string[]
  mcp_config_ref?: string
  env_allowlist: string[]
  secret_policy: SecretPolicy
  max_turns?: number
  max_budget_usd?: number
  timeout_ms: number
  degraded_tui_fallback_allowed: boolean
}

export interface HostRuntimeRunnerInvocation {
  invocation_id: string
  queue_id?: number
  message_id?: string
  agent_id: string
  task_kind: 'receive' | 'reply' | 'audit' | 'restart' | 'recovery' | 'maintenance'
  trusted_instruction: string
  policy_refs: string[]
  untrusted_context_refs: string[]
  context_pack_refs: string[]
  expected_result_schema_ref: string
  runtime_profile_ref: string
}

export interface HostRuntimeCommand {
  command: string
  args: string[]
  env: Record<string, string>
  stdin?: string
  degraded: boolean
  degradation_reasons: string[]
  redacted_env_policy: {
    allowlist: string[]
    secret_policy: SecretPolicy
  }
}

export type HostRuntimeCommandResult =
  | { ok: true; command: HostRuntimeCommand }
  | { ok: false; code: HostRuntimeFailureCode; message: string }

export interface HostRuntimeToolCallEvidence {
  name: string
  status: string
  redacted_args_hash?: string
}

export interface HostRuntimeFileChangeEvidence {
  path: string
  action: string
}

export interface HostRuntimeRunnerResult {
  invocation_id: string
  runtime: HostRuntimeKind
  exit_status: number
  started_at: string
  finished_at: string
  final_message?: string
  final_structured_result?: unknown
  schema_valid: boolean
  event_counts: Record<string, number>
  tool_calls: HostRuntimeToolCallEvidence[]
  file_changes?: HostRuntimeFileChangeEvidence[]
  degraded: boolean
  degradation_reasons: string[]
  parser_outcome: 'success' | 'runtime_error' | 'parse_error' | 'schema_mismatch'
  failure_code?: HostRuntimeFailureCode
  parse_errors?: string[]
  timed_out: boolean
}

export interface HostRuntimeParseInput {
  invocation_id: string
  stdout: string
  exit_status: number
  started_at: string
  finished_at: string
  final_message?: string
  schema_valid?: boolean
  timed_out?: boolean
  degradation_reasons?: string[]
}

export interface HostRuntimeAdapterGateInput {
  enabled: boolean
  profile?: RuntimeInvocationProfile | null
  invocation: HostRuntimeRunnerInvocation
  schemaPath?: string | null
  schemaJson?: string | null
  outputLastMessagePath?: string | null
  codexBin?: string
  claudeBin?: string
  supportedFlags?: Iterable<string> | null
  env?: Record<string, string | undefined>
  timestamp?: string
}

export interface HostRuntimeAdapterGateEvidence {
  enabled: boolean
  selected: 'codex-runner' | 'host-runtime'
  reason: string
  profile_id: string | null
  runtime: HostRuntimeKind | null
  failure_code?: HostRuntimeFailureCode
}

export type HostRuntimeAdapterGateResult =
  | {
      ok: true
      selected: 'codex-runner'
      evidence: HostRuntimeAdapterGateEvidence
    }
  | {
      ok: true
      selected: 'host-runtime'
      profile: RuntimeInvocationProfile
      invocation: HostRuntimeRunnerInvocation
      command: HostRuntimeCommand
      parser: 'codex-jsonl' | 'claude-stream-json'
      evidence: HostRuntimeAdapterGateEvidence
    }
  | {
      ok: false
      selected: 'host-runtime'
      failure: HostRuntimeRunnerResult
      evidence: HostRuntimeAdapterGateEvidence
    }

const PROMPT_DELIVERIES: readonly PromptDelivery[] = ['stdin-json', 'stdin-text', 'prompt-arg', 'session-resume']
const OUTPUT_STREAMS: readonly OutputStream[] = ['jsonl', 'json', 'text']
const SANDBOXES: readonly RuntimeSandbox[] = ['read-only', 'workspace-write', 'danger-full-access', 'host-specific']
const SECRET_POLICIES: readonly SecretPolicy[] = ['none', 'single-invocation-env', 'external-secret-store']

function hasValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function inList<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

export function validateRuntimeInvocationProfile(profile: RuntimeInvocationProfile | null | undefined): HostRuntimeCommandResult | null {
  if (!profile) {
    return { ok: false, code: 'RUNTIME_PROFILE_REQUIRED', message: 'runtime invocation profile is required' }
  }
  if (!hasValue(profile.profile_id)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'profile_id is required' }
  }
  if (!['codex', 'claude', 'custom'].includes(profile.runtime)) {
    return { ok: false, code: 'UNSUPPORTED_RUNTIME', message: `unsupported runtime: ${String(profile.runtime)}` }
  }
  if (!hasValue(profile.cwd)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'cwd is required' }
  }
  if (!Array.isArray(profile.allowed_dirs)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'allowed_dirs must be an array' }
  }
  if (!inList(profile.prompt_delivery, PROMPT_DELIVERIES)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'prompt_delivery is invalid' }
  }
  if (!inList(profile.output_stream, OUTPUT_STREAMS)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'output_stream is invalid' }
  }
  if (!inList(profile.sandbox, SANDBOXES)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'sandbox is invalid' }
  }
  if (!Array.isArray(profile.env_allowlist)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'env_allowlist must be an array' }
  }
  if (!inList(profile.secret_policy, SECRET_POLICIES)) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'secret_policy is invalid' }
  }
  if (!Number.isFinite(profile.timeout_ms) || profile.timeout_ms <= 0) {
    return { ok: false, code: 'RUNTIME_PROFILE_INVALID', message: 'timeout_ms must be positive' }
  }
  return null
}

export function parseSupportedCliFlags(helpText: string): Set<string> {
  const flags = new Set<string>()
  for (const match of helpText.matchAll(/(?:^|[\s,])(--[a-zA-Z0-9][a-zA-Z0-9-]*|-p)(?=[\s,]|$)/g)) {
    flags.add(match[1])
  }
  return flags
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function eventKind(event: Record<string, unknown>): string {
  return stringField(event, ['type', 'event', 'kind']) ?? 'unknown'
}

function countEvent(counts: Record<string, number>, kind: string): void {
  counts[kind] = (counts[kind] ?? 0) + 1
}

function extractToolCall(event: Record<string, unknown>): HostRuntimeToolCallEvidence | null {
  const kind = eventKind(event).toLowerCase()
  const tool = objectRecord(event.tool) ?? objectRecord(event.tool_call) ?? event
  const name = stringField(tool, ['name', 'tool_name'])
  if (!name && !kind.includes('tool')) return null
  return {
    name: name ?? 'unknown',
    status: stringField(tool, ['status', 'state', 'outcome']) ?? stringField(event, ['status', 'state', 'outcome']) ?? 'unknown',
    redacted_args_hash: stringField(tool, ['redacted_args_hash']),
  }
}

function extractFileChange(event: Record<string, unknown>): HostRuntimeFileChangeEvidence | null {
  const change = objectRecord(event.file_change) ?? objectRecord(event.file) ?? event
  const path = stringField(change, ['path'])
  const action = stringField(change, ['action', 'status'])
  if (!path || !action) return null
  const kind = eventKind(event).toLowerCase()
  return kind.includes('file') || objectRecord(event.file_change) ? { path, action } : null
}

function extractStructuredResult(event: Record<string, unknown>): unknown {
  if ('final_structured_result' in event) return event.final_structured_result
  if ('structured_result' in event) return event.structured_result
  if ('result' in event) return event.result
  return undefined
}

function extractFinalMessage(event: Record<string, unknown>): string | null {
  const direct = stringField(event, ['final_message', 'message', 'content', 'text'])
  if (direct) return direct
  const message = objectRecord(event.message)
  return message ? stringField(message, ['content', 'text']) : null
}

function parseJsonEventStream(stdout: string): {
  events: Record<string, unknown>[]
  parseErrors: string[]
} {
  const events: Record<string, unknown>[] = []
  const parseErrors: string[] = []
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const [idx, line] of lines.entries()) {
    try {
      const event = objectRecord(JSON.parse(line))
      if (event) events.push(event)
      else parseErrors.push(`line ${idx + 1}: JSON event must be an object`)
    } catch (err) {
      parseErrors.push(`line ${idx + 1}: ${(err as Error).message}`)
    }
  }
  return { events, parseErrors }
}

function parseStructuredRuntimeStream(runtime: HostRuntimeKind, input: HostRuntimeParseInput): HostRuntimeRunnerResult {
  const { events, parseErrors } = parseJsonEventStream(input.stdout)
  const eventCounts: Record<string, number> = {}
  const toolCalls: HostRuntimeToolCallEvidence[] = []
  const fileChanges: HostRuntimeFileChangeEvidence[] = []
  let finalMessage = input.final_message
  let finalStructuredResult: unknown

  for (const event of events) {
    const kind = eventKind(event)
    countEvent(eventCounts, kind)
    const toolCall = extractToolCall(event)
    if (toolCall) toolCalls.push(toolCall)
    const fileChange = extractFileChange(event)
    if (fileChange) fileChanges.push(fileChange)
    const structured = extractStructuredResult(event)
    if (structured !== undefined) finalStructuredResult = structured
    const candidateFinalMessage = extractFinalMessage(event)
    if (candidateFinalMessage && ['final', 'final_result', 'result', 'assistant_final'].includes(kind)) {
      finalMessage = candidateFinalMessage
    }
  }

  const timedOut = input.timed_out === true
  const schemaValid = input.schema_valid !== false && parseErrors.length === 0 && !timedOut && input.exit_status === 0
  let failureCode: HostRuntimeFailureCode | undefined
  let parserOutcome: HostRuntimeRunnerResult['parser_outcome'] = 'success'

  if (timedOut) {
    failureCode = 'RUNTIME_TIMEOUT'
    parserOutcome = 'runtime_error'
  } else if (parseErrors.length > 0) {
    failureCode = 'STREAM_PARSE_ERROR'
    parserOutcome = 'parse_error'
  } else if (input.exit_status !== 0) {
    failureCode = 'RUNTIME_NONZERO_EXIT'
    parserOutcome = 'runtime_error'
  } else if (!hasValue(finalMessage)) {
    failureCode = 'FINAL_MESSAGE_MISSING'
    parserOutcome = 'parse_error'
  } else if (input.schema_valid === false) {
    failureCode = 'OUTPUT_SCHEMA_MISMATCH'
    parserOutcome = 'schema_mismatch'
  }

  return {
    invocation_id: input.invocation_id,
    runtime,
    exit_status: input.exit_status,
    started_at: input.started_at,
    finished_at: input.finished_at,
    final_message: finalMessage,
    final_structured_result: finalStructuredResult,
    schema_valid: schemaValid && !failureCode,
    event_counts: eventCounts,
    tool_calls: toolCalls,
    file_changes: fileChanges.length > 0 ? fileChanges : undefined,
    degraded: (input.degradation_reasons?.length ?? 0) > 0,
    degradation_reasons: input.degradation_reasons ?? [],
    parser_outcome: parserOutcome,
    failure_code: failureCode,
    parse_errors: parseErrors.length > 0 ? parseErrors : undefined,
    timed_out: timedOut,
  }
}

export function parseCodexJsonlRuntimeResult(input: HostRuntimeParseInput): HostRuntimeRunnerResult {
  return parseStructuredRuntimeStream('codex', input)
}

export function parseClaudeStreamJsonRuntimeResult(input: HostRuntimeParseInput): HostRuntimeRunnerResult {
  return parseStructuredRuntimeStream('claude', input)
}

export function parseHostRuntimeResultForProfile(
  profile: RuntimeInvocationProfile,
  input: HostRuntimeParseInput,
): HostRuntimeRunnerResult {
  if (profile.runtime === 'codex') return parseCodexJsonlRuntimeResult(input)
  if (profile.runtime === 'claude') return parseClaudeStreamJsonRuntimeResult(input)
  return buildHostRuntimeFailureResult({
    invocation_id: input.invocation_id,
    runtime: profile.runtime,
    code: 'UNSUPPORTED_RUNTIME',
    message: `unsupported runtime: ${profile.runtime}`,
    timestamp: input.finished_at,
  })
}

export function buildHostRuntimeFailureResult(input: {
  invocation_id: string
  runtime?: HostRuntimeKind
  code: HostRuntimeFailureCode
  message: string
  timestamp?: string
  degradation_reasons?: string[]
}): HostRuntimeRunnerResult {
  const at = input.timestamp ?? new Date(0).toISOString()
  const reasons = input.degradation_reasons ?? [input.message]
  return {
    invocation_id: input.invocation_id,
    runtime: input.runtime ?? 'custom',
    exit_status: 1,
    started_at: at,
    finished_at: at,
    schema_valid: false,
    event_counts: {},
    tool_calls: [],
    degraded: reasons.length > 0,
    degradation_reasons: reasons,
    parser_outcome: 'runtime_error',
    failure_code: input.code,
    timed_out: false,
  }
}

function defaultGateResult(input: HostRuntimeAdapterGateInput, reason: 'profile_disabled' | 'profile_absent'): HostRuntimeAdapterGateResult {
  return {
    ok: true,
    selected: 'codex-runner',
    evidence: {
      enabled: input.enabled,
      selected: 'codex-runner',
      reason,
      profile_id: input.profile?.profile_id ?? null,
      runtime: input.profile?.runtime ?? null,
    },
  }
}

function failedGateResult(
  input: HostRuntimeAdapterGateInput,
  code: HostRuntimeFailureCode,
  message: string,
): HostRuntimeAdapterGateResult {
  return {
    ok: false,
    selected: 'host-runtime',
    failure: buildHostRuntimeFailureResult({
      invocation_id: input.invocation.invocation_id,
      runtime: input.profile?.runtime,
      code,
      message,
      timestamp: input.timestamp,
    }),
    evidence: {
      enabled: input.enabled,
      selected: 'host-runtime',
      reason: 'profile_failed_closed',
      profile_id: input.profile?.profile_id ?? null,
      runtime: input.profile?.runtime ?? null,
      failure_code: code,
    },
  }
}

export function selectHostRuntimeAdapter(input: HostRuntimeAdapterGateInput): HostRuntimeAdapterGateResult {
  if (!input.enabled) return defaultGateResult(input, 'profile_disabled')
  if (!input.profile) return defaultGateResult(input, 'profile_absent')

  let commandResult: HostRuntimeCommandResult
  let parser: 'codex-jsonl' | 'claude-stream-json'
  if (input.profile.runtime === 'codex') {
    if (!hasValue(input.outputLastMessagePath)) {
      return failedGateResult(input, 'SCHEMA_REQUIRED', 'Codex output-last-message path is required')
    }
    commandResult = buildCodexExecCommand({
      profile: input.profile,
      invocation: input.invocation,
      schemaPath: input.schemaPath ?? '',
      outputLastMessagePath: input.outputLastMessagePath,
      codexBin: input.codexBin,
      supportedFlags: input.supportedFlags ?? undefined,
      env: input.env,
    })
    parser = 'codex-jsonl'
  } else if (input.profile.runtime === 'claude') {
    commandResult = buildClaudePrintCommand({
      profile: input.profile,
      invocation: input.invocation,
      schemaJson: input.schemaJson ?? '',
      claudeBin: input.claudeBin,
      supportedFlags: input.supportedFlags ?? undefined,
      env: input.env,
    })
    parser = 'claude-stream-json'
  } else {
    return failedGateResult(input, 'UNSUPPORTED_RUNTIME', `unsupported runtime: ${input.profile.runtime}`)
  }

  if (!commandResult.ok) {
    return failedGateResult(input, commandResult.code, commandResult.message)
  }

  return {
    ok: true,
    selected: 'host-runtime',
    profile: input.profile,
    invocation: input.invocation,
    command: commandResult.command,
    parser,
    evidence: {
      enabled: input.enabled,
      selected: 'host-runtime',
      reason: 'profile_selected',
      profile_id: input.profile.profile_id,
      runtime: input.profile.runtime,
    },
  }
}

function normalizeFlags(flags?: Iterable<string>): Set<string> | null {
  return flags ? new Set(flags) : null
}

function requireFlags(supportedFlags: Set<string> | null, required: readonly string[]): string | null {
  if (!supportedFlags) return null
  return required.find((flag) => !supportedFlags.has(flag)) ?? null
}

function addOptionalFlag(
  args: string[],
  supportedFlags: Set<string> | null,
  flag: string,
  values: string[],
  degradationReasons: string[],
): void {
  if (supportedFlags && !supportedFlags.has(flag)) {
    degradationReasons.push(`optional_flag_unsupported:${flag}`)
    return
  }
  args.push(flag, ...values)
}

function allowlistedEnv(profile: RuntimeInvocationProfile, sourceEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of profile.env_allowlist) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function profileValidation(profile: RuntimeInvocationProfile, runtime: HostRuntimeKind): HostRuntimeCommandResult | null {
  const invalid = validateRuntimeInvocationProfile(profile)
  if (invalid) return invalid
  if (profile.runtime !== runtime) {
    return { ok: false, code: 'UNSUPPORTED_RUNTIME', message: `profile runtime must be ${runtime}` }
  }
  return null
}

function requireSchema(schema: string | null | undefined): HostRuntimeCommandResult | null {
  if (!hasValue(schema)) {
    return { ok: false, code: 'SCHEMA_REQUIRED', message: 'final output schema is required' }
  }
  return null
}

export function buildCodexExecCommand(input: {
  profile: RuntimeInvocationProfile
  invocation: HostRuntimeRunnerInvocation
  schemaPath: string
  outputLastMessagePath: string
  codexBin?: string
  supportedFlags?: Iterable<string>
  env?: Record<string, string | undefined>
}): HostRuntimeCommandResult {
  const invalid = profileValidation(input.profile, 'codex') ?? requireSchema(input.schemaPath)
  if (invalid) return invalid
  if (input.profile.sandbox === 'host-specific') {
    return { ok: false, code: 'SANDBOX_POLICY_VIOLATION', message: 'codex requires an explicit sandbox mapping' }
  }
  const supportedFlags = normalizeFlags(input.supportedFlags)
  const missing = requireFlags(supportedFlags, ['--json', '--output-schema', '--output-last-message', '--sandbox', '--cd'])
  if (missing) {
    return { ok: false, code: 'RUNTIME_FLAG_UNSUPPORTED', message: `required Codex flag unsupported: ${missing}` }
  }

  const degradationReasons: string[] = []
  const args = [
    'exec',
    '--json',
    '--output-schema', input.schemaPath,
    '--output-last-message', input.outputLastMessagePath,
    '--sandbox', input.profile.sandbox,
    '--cd', input.profile.cwd,
  ]
  for (const dir of input.profile.allowed_dirs.filter((dir) => dir !== input.profile.cwd)) {
    addOptionalFlag(args, supportedFlags, '--add-dir', [dir], degradationReasons)
  }
  if (supportedFlags?.has('--ephemeral') ?? true) args.push('--ephemeral')
  else degradationReasons.push('optional_flag_unsupported:--ephemeral')
  args.push('-')

  return {
    ok: true,
    command: {
      command: input.codexBin ?? 'codex',
      args,
      env: allowlistedEnv(input.profile, input.env ?? process.env),
      stdin: JSON.stringify(input.invocation),
      degraded: degradationReasons.length > 0,
      degradation_reasons: degradationReasons,
      redacted_env_policy: {
        allowlist: [...input.profile.env_allowlist],
        secret_policy: input.profile.secret_policy,
      },
    },
  }
}

export function buildClaudePrintCommand(input: {
  profile: RuntimeInvocationProfile
  invocation: HostRuntimeRunnerInvocation
  schemaJson: string
  claudeBin?: string
  supportedFlags?: Iterable<string>
  env?: Record<string, string | undefined>
}): HostRuntimeCommandResult {
  const invalid = profileValidation(input.profile, 'claude') ?? requireSchema(input.schemaJson)
  if (invalid) return invalid
  const supportedFlags = normalizeFlags(input.supportedFlags)
  const missing = requireFlags(supportedFlags, ['-p', '--output-format', '--json-schema', '--permission-mode'])
  if (missing) {
    return { ok: false, code: 'RUNTIME_FLAG_UNSUPPORTED', message: `required Claude flag unsupported: ${missing}` }
  }

  const degradationReasons: string[] = []
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--json-schema', input.schemaJson,
    '--permission-mode', input.profile.approval_mode ?? 'default',
  ]
  if (input.profile.allowed_tools?.length) {
    addOptionalFlag(args, supportedFlags, '--allowedTools', [input.profile.allowed_tools.join(',')], degradationReasons)
  }
  if (input.profile.disallowed_tools?.length) {
    addOptionalFlag(args, supportedFlags, '--disallowedTools', [input.profile.disallowed_tools.join(',')], degradationReasons)
  }
  if (input.profile.mcp_config_ref) {
    addOptionalFlag(args, supportedFlags, '--mcp-config', [input.profile.mcp_config_ref], degradationReasons)
    if (supportedFlags?.has('--strict-mcp-config') ?? true) args.push('--strict-mcp-config')
    else degradationReasons.push('optional_flag_unsupported:--strict-mcp-config')
  }
  if (supportedFlags?.has('--bare') ?? true) args.push('--bare')
  else degradationReasons.push('optional_flag_unsupported:--bare')
  if (supportedFlags?.has('--no-session-persistence') ?? true) args.push('--no-session-persistence')
  else degradationReasons.push('optional_flag_unsupported:--no-session-persistence')
  args.push(input.invocation.trusted_instruction)

  return {
    ok: true,
    command: {
      command: input.claudeBin ?? 'claude',
      args,
      env: allowlistedEnv(input.profile, input.env ?? process.env),
      degraded: degradationReasons.length > 0,
      degradation_reasons: degradationReasons,
      redacted_env_policy: {
        allowlist: [...input.profile.env_allowlist],
        secret_policy: input.profile.secret_policy,
      },
    },
  }
}
