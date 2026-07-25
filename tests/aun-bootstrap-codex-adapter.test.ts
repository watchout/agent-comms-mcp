import { describe, expect, test } from 'bun:test'
import { createCodexBootstrapAdapter } from '../bin/aun/bootstrap-adapter-codex'
import type { BootstrapStageContext } from '../bin/aun/bootstrap-types'

const context = {
  runId: 'run-1', agentId: 'codex-probe', requestedRuntime: 'codex', resolvedRuntime: 'codex',
  repoRoot: '/repo', workspaceRoot: '/workspace', repoHead: 'a'.repeat(40), dryRun: false,
  env: { DATABASE_URL: 'postgresql:///probe', AUN_BOOTSTRAP_CHANNEL_PORT: '8891', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex' },
  priorState: {} as any,
} satisfies BootstrapStageContext

describe('aun bootstrap Codex adapter', () => {
  test('uses provider CLI registration and exact list readback', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    let listed = false
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (command, args) => {
        calls.push({ command, args })
        if (args.join(' ') === 'mcp list') return { exitCode: 0, stdout: listed ? 'aun enabled\n' : '', stderr: '' }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') { listed = true; return { exitCode: 0, stdout: 'added', stderr: '' } }
        return { exitCode: 0, stdout: 'codex 1.0.0', stderr: '' }
      },
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    expect(result.mutation?.owner_key).toBe('codex:aun:codex-probe')
    const add = calls.find((call) => call.args.slice(0, 3).join(' ') === 'mcp add aun')!
    expect(add.command).toBe('codex')
    expect(add.args).toContain('AGENT_ID=codex-probe')
    expect(add.args).toContain('AUN_WEBHOOK_PORT=8891')
    expect(add.args.slice(-6)).toEqual(['--', '/bin/bun', 'run', '--cwd', '/repo', 'server.ts'])
  })

  test('existing registration is idempotent and creates no mutation', async () => {
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async () => ({ exitCode: 0, stdout: 'aun enabled\n', stderr: '' }),
    })
    const result = await adapter.applyMcpRegistration(context)
    expect(result.ok).toBe(true)
    expect(result.mutation).toBeUndefined()
  })
})
