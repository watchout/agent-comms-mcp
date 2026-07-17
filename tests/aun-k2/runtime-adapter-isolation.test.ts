import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/runtime-binding-valid-v1.json'
import type { DbAdapter } from '../../core/db/adapter'
import type { QueueViewRow } from '../../core/eventlog/types'
import {
  codexExecRuntime,
  RuntimeTimeoutError,
  UnknownRuntimeEngineError,
  runtimeForBinding,
  type HeadlessInvoker,
  type RuntimeSpawnOptions,
} from '../../core/eventlog/runtimes'
import {
  resolveRuntimeBinding,
  RuntimeBindingResolutionError,
  type ResolvedRuntimeBindingV1,
} from '../../core/eventlog/runtime-binding'

const turn: QueueViewRow = {
  turn_id: 'turn:arc:m1', seat_id: 'arc', conversation_id: null,
  received_seq: 1, received_event_id: 'recv:arc:m1', received_at: '2026-07-16T00:00:00Z',
  message_id: 'm1', claim_event_id: null, claim_epoch: null,
  claimed_by_seat: null, claimed_by_instance: null, claim_seq: null,
}

function readOnlyDb(): DbAdapter {
  return {
    dialect: 'sqlite',
    async query() { return [] },
    async queryOne() { return { payload: JSON.stringify({ content: 'hello', author_id: 'owner', channel_id: 'test' }) } as never },
    async execute() { throw new Error('unexpected mutation') },
    async transaction() { throw new Error('unexpected transaction') },
    async close() {},
  }
}

describe('K2 runtime adapter isolation', () => {
  test('K2-TC-005 child receives exact cwd/env/tool/sandbox binding', async () => {
    let captured: { cmd: string[]; opts?: RuntimeSpawnOptions } | null = null
    const invoker: HeadlessInvoker = {
      async run(cmd, opts) {
        captured = { cmd, opts }
        return { exitCode: 0, stdout: '{"ok":true,"outcome":"no_reply","reply":null}\n', stderr: '' }
      },
    }
    const binding = resolveRuntimeBinding({ binding: structuredClone(fixture) })
    const runtime = runtimeForBinding(binding, {
      db: readOnlyDb(), schemaPath: '/tmp/schema.json', invoker,
      parentEnv: { PATH: '/bin', TMPDIR: '/tmp', SECRET_TOKEN: 'never', DATABASE_URL: 'never' },
    })
    await runtime.runTurn({ seatId: 'arc', turn, payload: { message_id: 'm1' } })
    expect(captured?.opts?.cwd).toBe('/workspace/agent-comms-mcp')
    expect(captured?.opts?.env).toEqual({ PATH: '/bin', TMPDIR: '/tmp' })
    expect(captured?.opts?.allowedTools).toEqual(['apply_patch', 'exec_command'])
    expect(captured?.opts?.sandboxProfile).toBe('workspace-write')
    expect(captured?.cmd).toContain('--sandbox')
    expect(captured?.cmd).toContain('--ignore-user-config')
    expect(captured?.cmd).toContain('--strict-config')
    expect(captured?.cmd).toContain('--cd')
    expect(captured?.cmd).toContain('web_search="disabled"')
    expect(captured?.cmd).toContain('mcp_servers={}')
    expect(captured?.cmd).toContain('plugins={}')
    expect(captured?.cmd).toContain('unified_exec')
    for (const disabled of [
      'apps', 'browser_use', 'computer_use', 'goals', 'hooks', 'image_generation',
      'multi_agent', 'plugins', 'remote_plugin', 'shell_tool', 'tool_suggest',
    ]) {
      const index = captured?.cmd.findIndex((value, position) => value === disabled && captured?.cmd[position - 1] === '--disable') ?? -1
      expect(index).toBeGreaterThan(0)
    }
  })

  test('K2-TOOL-LIMIT-ENFORCEMENT-001 unrepresented Codex tool fails before child spawn', async () => {
    const source = structuredClone(fixture) as Record<string, unknown>
    source.allowed_tools = ['apply_patch', 'exec_command', 'web_search']
    let childSpawns = 0
    const runtime = runtimeForBinding(resolveRuntimeBinding({ binding: source }), {
      db: readOnlyDb(), schemaPath: '/tmp/schema.json',
      invoker: {
        async run() {
          childSpawns += 1
          return { exitCode: 0, stdout: '{"ok":true,"outcome":"no_reply","reply":null}', stderr: '' }
        },
      },
      parentEnv: { PATH: '/bin', TMPDIR: '/tmp' },
    })
    try {
      await runtime.runTurn({ seatId: 'arc', turn, payload: { message_id: 'm1' } })
      throw new Error('expected runtime policy rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBindingResolutionError)
      expect((error as RuntimeBindingResolutionError).code).toBe('RUNTIME_POLICY_UNVERIFIED')
    }
    expect(childSpawns).toBe(0)
  })

  test('K2-TOOL-LIMIT-ENFORCEMENT-001 production invoker cannot bypass a signed tool binding', async () => {
    const runtime = codexExecRuntime({ db: readOnlyDb(), schemaPath: '/tmp/schema.json' })
    try {
      await runtime.runTurn({ seatId: 'arc', turn, payload: { message_id: 'm1' } })
      throw new Error('expected missing signed binding rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBindingResolutionError)
      expect((error as RuntimeBindingResolutionError).code).toBe('RUNTIME_POLICY_UNVERIFIED')
    }
  })

  test('K2-TC-006 timeout is typed and never converted to a model result', async () => {
    let childKills = 0
    const invoker: HeadlessInvoker = {
      async run() {
        childKills += 1
        throw new RuntimeTimeoutError('fake child exceeded 50ms and was killed')
      },
    }
    const runtime = runtimeForBinding(resolveRuntimeBinding({ binding: structuredClone(fixture) }), {
      db: readOnlyDb(), schemaPath: '/tmp/schema.json', invoker, timeoutMs: 50,
      parentEnv: { PATH: '/bin', TMPDIR: '/tmp' },
    })
    await expect(runtime.runTurn({ seatId: 'arc', turn, payload: { message_id: 'm1' } })).rejects.toBeInstanceOf(RuntimeTimeoutError)
    expect(childKills).toBe(1)
  })

  test('claude binding carries strict tool, MCP, permission and persistence limits', async () => {
    const source = structuredClone(fixture) as Record<string, unknown>
    source.model_adapter = 'claude_code'
    source.sandbox_profile = 'dontAsk'
    let captured: { cmd: string[]; opts?: RuntimeSpawnOptions } | null = null
    const runtime = runtimeForBinding(resolveRuntimeBinding({ binding: source }), {
      db: readOnlyDb(), schemaPath: '/tmp/schema.json',
      invoker: {
        async run(cmd, opts) {
          captured = { cmd, opts }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ is_error: false, result: '{"ok":true,"outcome":"no_reply","reply":null}' }),
            stderr: '',
          }
        },
      },
      parentEnv: { PATH: '/bin', TMPDIR: '/tmp', DATABASE_URL: 'never' },
    })
    await runtime.runTurn({ seatId: 'arc', turn, payload: { message_id: 'm1' } })
    expect(captured?.cmd).toContain('--tools')
    expect(captured?.cmd).toContain('--allowedTools')
    expect(captured?.cmd).toContain('--strict-mcp-config')
    expect(captured?.cmd).toContain('--no-session-persistence')
    expect(captured?.cmd).toContain('dontAsk')
    expect(captured?.opts?.env).toEqual({ PATH: '/bin', TMPDIR: '/tmp' })
  })

  test('K2-TC-004 runtimeForBinding never defaults or spawns an unknown engine', () => {
    let childSpawns = 0
    const invalid = { ...resolveRuntimeBinding({ binding: structuredClone(fixture) }), model_adapter: 'other' } as unknown as ResolvedRuntimeBindingV1
    expect(() => runtimeForBinding(invalid, {
      db: readOnlyDb(),
      schemaPath: '/tmp/schema.json',
      invoker: { async run() { childSpawns += 1; return { exitCode: 0, stdout: '', stderr: '' } } },
    })).toThrow(UnknownRuntimeEngineError)
    expect(childSpawns).toBe(0)
  })
})
