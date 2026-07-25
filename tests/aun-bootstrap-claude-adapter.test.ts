import { describe, expect, test } from 'bun:test'
import { createClaudeBootstrapAdapter } from '../bin/aun/bootstrap-adapter-claude'
import type { BootstrapStageContext } from '../bin/aun/bootstrap-types'

const context = {
  runId: 'run-1', agentId: 'claude-probe', requestedRuntime: 'claude', resolvedRuntime: 'claude',
  repoRoot: '/repo', workspaceRoot: '/workspace', repoHead: 'b'.repeat(40), dryRun: false,
  env: { DATABASE_URL: 'postgresql:///probe', AUN_BOOTSTRAP_CHANNEL_PORT: '8892', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'claude' },
  priorState: {} as any,
} satisfies BootstrapStageContext

const exactGet = (changes: Partial<Record<'scope' | 'status' | 'type' | 'command' | 'args' | 'agent' | 'database' | 'port', string>> = {}) => `
Scope: ${changes.scope ?? 'User config'}
Status: ${changes.status ?? '✔ Connected'}
Type: ${changes.type ?? 'stdio'}
Command: ${changes.command ?? '/bin/bun'}
Args: ${changes.args ?? 'run --cwd /repo server.ts'}
Environment:
  AGENT_ID=${changes.agent ?? 'claude-probe'}
  AGENT_COM_EXPECTED_AGENT_ID=claude-probe
  DATABASE_URL=${changes.database ?? 'postgresql:///probe'}
  AGENT_COM_PG_NOTIFY=false
  AGENT_COMMS_TTL_SWEEP_DISABLED=1
  AUN_WEBHOOK_PORT=${changes.port ?? '8892'}
`

describe('aun bootstrap Claude adapter', () => {
  test('uses the user-scope stdio provider CLI and exact native readback', async () => {
    const calls: string[][] = []
    let added = false
    const adapter = createClaudeBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        calls.push(args)
        if (args.join(' ') === 'mcp get aun') return added
          ? { exitCode: 0, stdout: exactGet(), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'No MCP server named "aun"' }
        if (args.join(' ') === 'mcp list') return { exitCode: 0, stdout: added ? 'aun: /bin/bun - ✔ Connected\n' : '', stderr: '' }
        if (args[0] === 'mcp' && args[1] === 'add') { added = true; return { exitCode: 0, stdout: 'added', stderr: '' } }
        return { exitCode: 0, stdout: '2.1.80', stderr: '' }
      },
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    expect(result.mutation?.owner_key).toBe('claude:aun:run-1')
    const add = calls.find((args) => args[0] === 'mcp' && args[1] === 'add')!
    expect(add.slice(0, 6)).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'stdio'])
    expect(add).toContain('AGENT_ID=claude-probe')
    expect(add.slice(-6)).toEqual(['--', '/bin/bun', 'run', '--cwd', '/repo', 'server.ts'])
  })

  for (const [name, changes] of [
    ['disconnected', { status: '✘ Disconnected' }],
    ['wrong-scope', { scope: 'Project' }],
    ['wrong-command', { command: '/wrong/bun' }],
    ['wrong-argv', { args: 'server.ts' }],
    ['wrong-agent', { agent: 'wrong' }],
    ['wrong-database', { database: 'postgresql:///wrong' }],
    ['wrong-port', { port: '1' }],
    ['wrong-repo', { args: 'run --cwd /wrong server.ts' }],
  ] as const) {
    test(`rejects stale existing ${name} tuple without mutation`, async () => {
      let addCalled = false
      const adapter = createClaudeBootstrapAdapter({
        bunPath: '/bin/bun', serverEntry: 'server.ts',
        run: async (_command, args) => {
          if (args[1] === 'add') addCalled = true
          if (args.includes('get')) return { exitCode: 0, stdout: exactGet(changes), stderr: '' }
          return { exitCode: 0, stdout: 'aun: /bin/bun - ✔ Connected\n', stderr: '' }
        },
      })
      const result = await adapter.applyMcpRegistration(context)
      expect(result.ok).toBe(false)
      expect(result.reasonCodes).toEqual(['NO_GO_PROVIDER_ADAPTER_MISMATCH'])
      expect(addCalled).toBe(false)
    })
  }

  test('malformed or duplicate readback fails closed', async () => {
    for (const get of ['aun: connected\n', exactGet()]) {
      const adapter = createClaudeBootstrapAdapter({
        bunPath: '/bin/bun', serverEntry: 'server.ts',
        run: async (_command, args) => args.includes('get')
          ? { exitCode: 0, stdout: get, stderr: '' }
          : { exitCode: 0, stdout: 'aun: x - ✔ Connected\naun: y - ✔ Connected\n', stderr: '' },
      })
      expect((await adapter.applyMcpRegistration(context)).ok).toBe(false)
    }
  })

  test('runtime identity mismatch is fail closed', async () => {
    const adapter = createClaudeBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    })
    const result = await adapter.verifyRuntimeIdentity({ ...context, env: { ...context.env, AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex' } })
    expect(result.ok).toBe(false)
    expect(result.reasonCodes).toEqual(['NO_GO_IDENTITY_MISMATCH'])
  })
})
