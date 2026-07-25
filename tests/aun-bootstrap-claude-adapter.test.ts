import { describe, expect, test } from 'bun:test'
import { createClaudeBootstrapAdapter } from '../bin/aun/bootstrap-adapter-claude'
import type { BootstrapStageContext } from '../bin/aun/bootstrap-types'

const context = {
  runId: 'run-1', agentId: 'claude-probe', requestedRuntime: 'claude', resolvedRuntime: 'claude',
  repoRoot: '/repo', workspaceRoot: '/workspace', repoHead: 'b'.repeat(40), dryRun: false,
  env: { DATABASE_URL: 'postgresql:///probe', AUN_BOOTSTRAP_CHANNEL_PORT: '8892', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'claude' },
  priorState: {} as any,
} satisfies BootstrapStageContext

describe('aun bootstrap Claude adapter', () => {
  test('uses the user-scope stdio provider CLI and list readback', async () => {
    const calls: string[][] = []
    let listed = false
    const adapter = createClaudeBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        calls.push(args)
        if (args.join(' ') === 'mcp list') return { exitCode: 0, stdout: listed ? 'aun: connected\n' : '', stderr: '' }
        if (args[0] === 'mcp' && args[1] === 'add') { listed = true; return { exitCode: 0, stdout: 'added', stderr: '' } }
        return { exitCode: 0, stdout: '2.1.80', stderr: '' }
      },
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    const add = calls.find((args) => args[0] === 'mcp' && args[1] === 'add')!
    expect(add.slice(0, 6)).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'stdio'])
    expect(add).toContain('AGENT_ID=claude-probe')
    expect(add.slice(-6)).toEqual(['--', '/bin/bun', 'run', '--cwd', '/repo', 'server.ts'])
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
