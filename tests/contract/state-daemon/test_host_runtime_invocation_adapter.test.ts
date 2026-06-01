import { describe, expect, test } from 'bun:test'
import {
  buildClaudePrintCommand,
  buildCodexExecCommand,
  parseSupportedCliFlags,
  validateRuntimeInvocationProfile,
  type HostRuntimeRunnerInvocation,
  type RuntimeInvocationProfile,
} from '../../../core/state-daemon/host-runtime-invocation'

const baseInvocation: HostRuntimeRunnerInvocation = {
  invocation_id: 'inv-1',
  queue_id: 123,
  message_id: 'msg-123',
  agent_id: 'codex-aun',
  task_kind: 'audit',
  trusted_instruction: 'Run the audit using the referenced context.',
  policy_refs: ['policy://l1-audit'],
  untrusted_context_refs: ['queue://123', 'github://issue/644?body'],
  context_pack_refs: ['wasurezu://pack/1'],
  expected_result_schema_ref: 'schema://audit-result',
  runtime_profile_ref: 'profile://codex-readonly',
}

function profile(overrides: Partial<RuntimeInvocationProfile> = {}): RuntimeInvocationProfile {
  return {
    profile_id: 'profile-1',
    runtime: 'codex',
    cwd: '/repo',
    allowed_dirs: ['/repo'],
    prompt_delivery: 'stdin-json',
    output_stream: 'jsonl',
    final_output_schema_ref: 'schema://result',
    sandbox: 'read-only',
    env_allowlist: ['AUN_TOKEN', 'DATABASE_URL'],
    secret_policy: 'single-invocation-env',
    timeout_ms: 30_000,
    degraded_tui_fallback_allowed: false,
    ...overrides,
  }
}

describe('host runtime invocation adapter contract', () => {
  test('validates RuntimeInvocationProfile/v1 required fields', () => {
    expect(validateRuntimeInvocationProfile(null)).toMatchObject({
      ok: false,
      code: 'RUNTIME_PROFILE_REQUIRED',
    })
    expect(validateRuntimeInvocationProfile(profile({ profile_id: '' }))).toMatchObject({
      ok: false,
      code: 'RUNTIME_PROFILE_INVALID',
    })
    expect(validateRuntimeInvocationProfile(profile({ timeout_ms: 0 }))).toMatchObject({
      ok: false,
      code: 'RUNTIME_PROFILE_INVALID',
    })
    expect(validateRuntimeInvocationProfile(profile())).toBeNull()
  })

  test('parses supported CLI flags from help text', () => {
    const flags = parseSupportedCliFlags(`
      Usage: codex exec [OPTIONS]
        --json
        --output-schema <FILE>
        --output-last-message <FILE>
        --sandbox <MODE>
        --cd <DIR>
        -p, --print
    `)

    expect(flags.has('--json')).toBe(true)
    expect(flags.has('--output-schema')).toBe(true)
    expect(flags.has('--output-last-message')).toBe(true)
    expect(flags.has('--sandbox')).toBe(true)
    expect(flags.has('--cd')).toBe(true)
    expect(flags.has('-p')).toBe(true)
  })

  test('builds Codex exec argv with schema, JSONL stream, stdin envelope, and allowlisted env', () => {
    const result = buildCodexExecCommand({
      profile: profile({
        allowed_dirs: ['/repo', '/repo/shared'],
      }),
      invocation: baseInvocation,
      schemaPath: '/tmp/schema.json',
      outputLastMessagePath: '/tmp/final.txt',
      supportedFlags: [
        '--json',
        '--output-schema',
        '--output-last-message',
        '--sandbox',
        '--cd',
        '--add-dir',
        '--ephemeral',
      ],
      env: {
        AUN_TOKEN: 'secret-token',
        DATABASE_URL: 'postgresql:///agent_comms',
        SHOULD_NOT_LEAK: 'nope',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command.command).toBe('codex')
    expect(result.command.args).toEqual([
      'exec',
      '--json',
      '--output-schema', '/tmp/schema.json',
      '--output-last-message', '/tmp/final.txt',
      '--sandbox', 'read-only',
      '--cd', '/repo',
      '--add-dir', '/repo/shared',
      '--ephemeral',
      '-',
    ])
    expect(result.command.stdin).toBe(JSON.stringify(baseInvocation))
    expect(result.command.args.join(' ')).not.toContain('github://issue/644?body')
    expect(result.command.env).toEqual({
      AUN_TOKEN: 'secret-token',
      DATABASE_URL: 'postgresql:///agent_comms',
    })
    expect(result.command.redacted_env_policy).toEqual({
      allowlist: ['AUN_TOKEN', 'DATABASE_URL'],
      secret_policy: 'single-invocation-env',
    })
  })

  test('Codex builder fails closed when a required flag is unsupported', () => {
    const result = buildCodexExecCommand({
      profile: profile(),
      invocation: baseInvocation,
      schemaPath: '/tmp/schema.json',
      outputLastMessagePath: '/tmp/final.txt',
      supportedFlags: ['--json', '--sandbox', '--cd'],
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'RUNTIME_FLAG_UNSUPPORTED',
    })
  })

  test('builds Claude print argv with stream-json, schema, tool constraints, and trusted prompt only', () => {
    const result = buildClaudePrintCommand({
      profile: profile({
        runtime: 'claude',
        prompt_delivery: 'prompt-arg',
        output_stream: 'jsonl',
        approval_mode: 'dontAsk',
        allowed_tools: ['Read', 'Grep'],
        disallowed_tools: ['Bash(rm *)'],
        mcp_config_ref: '/tmp/mcp.json',
      }),
      invocation: baseInvocation,
      schemaJson: '{"type":"object"}',
      supportedFlags: [
        '-p',
        '--output-format',
        '--json-schema',
        '--permission-mode',
        '--allowedTools',
        '--disallowedTools',
        '--mcp-config',
        '--strict-mcp-config',
        '--bare',
        '--no-session-persistence',
      ],
      env: {
        AUN_TOKEN: 'secret-token',
        DATABASE_URL: 'postgresql:///agent_comms',
        SHOULD_NOT_LEAK: 'nope',
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command.command).toBe('claude')
    expect(result.command.args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--json-schema', '{"type":"object"}',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read,Grep',
      '--disallowedTools', 'Bash(rm *)',
      '--mcp-config', '/tmp/mcp.json',
      '--strict-mcp-config',
      '--bare',
      '--no-session-persistence',
      'Run the audit using the referenced context.',
    ])
    expect(result.command.args.join(' ')).not.toContain('queue://123')
    expect(result.command.args.join(' ')).not.toContain('github://issue/644?body')
    expect(result.command.env).toEqual({
      AUN_TOKEN: 'secret-token',
      DATABASE_URL: 'postgresql:///agent_comms',
    })
  })

  test('optional unsupported Claude flags downgrade with explicit degraded evidence', () => {
    const result = buildClaudePrintCommand({
      profile: profile({
        runtime: 'claude',
        allowed_tools: ['Read'],
        mcp_config_ref: '/tmp/mcp.json',
      }),
      invocation: baseInvocation,
      schemaJson: '{"type":"object"}',
      supportedFlags: [
        '-p',
        '--output-format',
        '--json-schema',
        '--permission-mode',
        '--allowedTools',
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command.degraded).toBe(true)
    expect(result.command.degradation_reasons).toEqual([
      'optional_flag_unsupported:--mcp-config',
      'optional_flag_unsupported:--strict-mcp-config',
      'optional_flag_unsupported:--bare',
      'optional_flag_unsupported:--no-session-persistence',
    ])
  })
})
