export type HostRuntimeKind = 'codex' | 'claude' | 'custom'

export type PromptDelivery = 'stdin-json' | 'stdin-text' | 'prompt-arg' | 'session-resume'
export type OutputStream = 'jsonl' | 'json' | 'text'
export type RuntimeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access' | 'host-specific'
export type SecretPolicy = 'none' | 'single-invocation-env' | 'external-secret-store'

export type HostRuntimeFailureCode =
  | 'RUNTIME_PROFILE_REQUIRED'
  | 'RUNTIME_PROFILE_INVALID'
  | 'UNSUPPORTED_RUNTIME'
  | 'RUNTIME_FLAG_UNSUPPORTED'
  | 'SCHEMA_REQUIRED'
  | 'SANDBOX_POLICY_VIOLATION'

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
