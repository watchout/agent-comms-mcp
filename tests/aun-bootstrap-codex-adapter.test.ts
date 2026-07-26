import { describe, expect, test } from 'bun:test'
import { createCodexBootstrapAdapter } from '../bin/aun/bootstrap-adapter-codex'
import type { BootstrapStageContext } from '../bin/aun/bootstrap-types'

const context = {
  runId: 'run-1', agentId: 'codex-probe', requestedRuntime: 'codex', resolvedRuntime: 'codex',
  repoRoot: '/repo', workspaceRoot: '/workspace', repoHead: 'a'.repeat(40), dryRun: false,
  env: { DATABASE_URL: 'postgresql:///probe', AUN_BOOTSTRAP_CHANNEL_PORT: '8891', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex' },
  priorState: {} as any,
} satisfies BootstrapStageContext

const environment = {
  AGENT_ID: 'codex-probe',
  AGENT_COM_EXPECTED_AGENT_ID: 'codex-probe',
  DATABASE_URL: 'postgresql:///probe',
  AGENT_COM_PG_NOTIFY: 'false',
  AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
  AUN_WEBHOOK_PORT: '8891',
}

function exactGet(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'aun', enabled: true,
    transport: { type: 'stdio', command: '/bin/bun', args: ['run', '--cwd', '/repo', 'server.ts'], env: environment },
    ...overrides,
  })
}

describe('aun bootstrap Codex adapter', () => {
  test('uses provider CLI registration and exact get/list readback', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let added = false
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (command, args) => {
        calls.push({ command, args })
        if (args.join(' ') === 'mcp get aun --json') return added
          ? { exitCode: 0, stdout: exactGet(), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'not found' }
        if (args.join(' ') === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(added ? [{ name: 'aun', enabled: true }] : []), stderr: '' }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') { added = true; return { exitCode: 0, stdout: 'added', stderr: '' } }
        return { exitCode: 0, stdout: 'codex 1.0.0', stderr: '' }
      },
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    expect(result.mutation?.owner_key).toBe('codex:aun:run-1')
    const add = calls.find((call) => call.args.slice(0, 3).join(' ') === 'mcp add aun')!
    expect(add.command).toBe('codex')
    expect(add.args).toContain('AGENT_ID=codex-probe')
    expect(add.args).toContain('AUN_WEBHOOK_PORT=8891')
    expect(add.args.slice(-6)).toEqual(['--', '/bin/bun', 'run', '--cwd', '/repo', 'server.ts'])
  })

  test('exact existing registration is idempotent and creates no mutation', async () => {
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => args.includes('get')
        ? { exitCode: 0, stdout: exactGet(), stderr: '' }
        : { exitCode: 0, stdout: JSON.stringify([{ name: 'aun', enabled: true }]), stderr: '' },
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    expect(result.mutation).toBeUndefined()
  })

  test('mcp add that mutates then exits 124 returns an observed mutation and native rollback proof', async () => {
    let added = false
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        const joined = args.join(' ')
        if (joined === 'mcp get aun --json') return added
          ? { exitCode: 0, stdout: exactGet(), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
        if (joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(added ? [{ name: 'aun', enabled: true }] : []), stderr: '' }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') {
          added = true
          return { exitCode: 124, stdout: '', stderr: 'timed out after mutation' }
        }
        if (joined === 'mcp remove aun') {
          added = false
          return { exitCode: 0, stdout: 'removed', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })
    const failed = await adapter.applyMcpRegistration(context)
    expect(failed.ok).toBe(false)
    expect(failed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    expect(failed.mutation?.actual_after_digest).toBeString()
    expect(added).toBe(true)
    const rolledBack = await adapter.rollbackRuntimeRegistration(context, {
      mutation_id: 'm1', stage: 'B4_MCP_REGISTRATION', rollback_status: 'not_run', ...failed.mutation!,
    })
    expect(rolledBack.ok).toBe(true)
    expect(added).toBe(false)
  })

  test('post-exit readback uses a fresh bounded signal after the stage signal aborts', async () => {
    const stageController = new AbortController()
    const postAddSignals: Array<{ signal: AbortSignal | undefined; aborted: boolean }> = []
    let added = false
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args, options) => {
        const joined = args.join(' ')
        if (options.signal?.aborted) return { exitCode: 124, stdout: '', stderr: 'aborted signal' }
        if (joined === 'mcp get aun --json') {
          if (added) postAddSignals.push({ signal: options.signal, aborted: Boolean(options.signal?.aborted) })
          return added
            ? { exitCode: 0, stdout: exactGet(), stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
        }
        if (joined === 'mcp list --json') {
          if (added) postAddSignals.push({ signal: options.signal, aborted: Boolean(options.signal?.aborted) })
          return { exitCode: 0, stdout: JSON.stringify(added ? [{ name: 'aun', enabled: true }] : []), stderr: '' }
        }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') {
          added = true
          stageController.abort(new Error('B4 stage deadline'))
          return { exitCode: 124, stdout: '', stderr: 'stage deadline after mutation' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })

    const failed = await adapter.applyMcpRegistration({ ...context, abortSignal: stageController.signal })
    expect(stageController.signal.aborted).toBe(true)
    expect(failed.ok).toBe(false)
    expect(failed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    expect(failed.mutation?.actual_after_digest).toBeString()
    expect(postAddSignals).toHaveLength(2)
    expect(postAddSignals.every((entry) => entry.signal !== stageController.signal && !entry.aborted)).toBe(true)
  })

  test('unresolved post-exit target still returns a recovery-required owned mutation', async () => {
    const stageController = new AbortController()
    let added = false
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args, options) => {
        const joined = args.join(' ')
        if (joined === 'mcp get aun --json') {
          if (added) return { exitCode: 124, stdout: '', stderr: 'native readback unavailable' }
          return { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
        }
        if (joined === 'mcp list --json') {
          return added
            ? { exitCode: 124, stdout: '', stderr: 'native list unavailable' }
            : { exitCode: 0, stdout: '[]', stderr: '' }
        }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') {
          added = true
          stageController.abort(new Error('B4 stage deadline'))
          return { exitCode: 124, stdout: '', stderr: 'stage deadline after mutation' }
        }
        return options.signal?.aborted
          ? { exitCode: 124, stdout: '', stderr: 'aborted' }
          : { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })

    const failed = await adapter.applyMcpRegistration({ ...context, abortSignal: stageController.signal })
    expect(failed.ok).toBe(false)
    expect(failed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    expect(failed.mutation?.actual_after_digest).toBeNull()
    expect(failed.mutation?.rollback_payload).toMatchObject({
      created_by_run: true,
      post_exit_readback_signal: 'fresh_bounded',
      recovery_required: true,
      target_readback_unresolved: true,
    })
  })

  for (const [name, mutate] of [
    ['disabled', (value: any) => ({ ...value, enabled: false })],
    ['wrong-command', (value: any) => ({ ...value, transport: { ...value.transport, command: '/wrong/bun' } })],
    ['wrong-argv', (value: any) => ({ ...value, transport: { ...value.transport, args: ['server.ts'] } })],
    ['wrong-agent', (value: any) => ({ ...value, transport: { ...value.transport, env: { ...value.transport.env, AGENT_ID: 'wrong' } } })],
    ['wrong-database', (value: any) => ({ ...value, transport: { ...value.transport, env: { ...value.transport.env, DATABASE_URL: 'postgresql:///wrong' } } })],
    ['wrong-port', (value: any) => ({ ...value, transport: { ...value.transport, env: { ...value.transport.env, AUN_WEBHOOK_PORT: '1' } } })],
    ['wrong-repo', (value: any) => ({ ...value, transport: { ...value.transport, args: ['run', '--cwd', '/wrong', 'server.ts'] } })],
  ] as const) {
    test(`rejects stale existing ${name} tuple without mutation`, async () => {
      const base = JSON.parse(exactGet())
      let addCalled = false
      const adapter = createCodexBootstrapAdapter({
        bunPath: '/bin/bun', serverEntry: 'server.ts',
        run: async (_command, args) => {
          if (args.slice(0, 3).join(' ') === 'mcp add aun') addCalled = true
          if (args.includes('get')) return { exitCode: 0, stdout: JSON.stringify(mutate(base)), stderr: '' }
          return { exitCode: 0, stdout: JSON.stringify([{ name: 'aun', enabled: true }]), stderr: '' }
        },
      })
      const result = await adapter.applyMcpRegistration(context)
      expect(result.ok).toBe(false)
      expect(result.reasonCodes).toEqual(['NO_GO_PROVIDER_ADAPTER_MISMATCH'])
      expect(addCalled).toBe(false)
    })
  }

  test('failed or duplicate native list readback is never absence verification', async () => {
    for (const list of [
      { exitCode: 1, stdout: '', stderr: 'failed' },
      { exitCode: 0, stdout: JSON.stringify([{ name: 'aun', enabled: true }, { name: 'aun', enabled: true }]), stderr: '' },
    ]) {
      const adapter = createCodexBootstrapAdapter({
        bunPath: '/bin/bun', serverEntry: 'server.ts',
        run: async (_command, args) => args.includes('get') ? { exitCode: 1, stdout: '', stderr: 'missing' } : list,
      })
      expect((await adapter.applyMcpRegistration(context)).ok).toBe(false)
    }
  })
})
