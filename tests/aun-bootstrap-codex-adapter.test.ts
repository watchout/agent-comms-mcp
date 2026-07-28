import { describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  test('absent-prestate recovery preserves a foreign current tuple without invoking remove', async () => {
    let state: 'absent' | 'intended' | 'foreign' = 'absent'
    let removeCalls = 0
    let admission: any = null
    const foreignTuple = {
      name: 'aun', enabled: true,
      transport: { type: 'stdio', command: '/foreign/bun', args: ['foreign-server.ts'], env: { OWNER: 'foreign' } },
    }
    const recoveryContext: BootstrapStageContext = {
      ...context,
      admitRecoveryMutation: (mutation) => { admission = structuredClone(mutation) },
    }
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        const joined = args.join(' ')
        if (joined === 'mcp get aun --json') {
          if (state === 'absent') return { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
          return { exitCode: 0, stdout: state === 'intended' ? exactGet() : JSON.stringify(foreignTuple), stderr: '' }
        }
        if (joined === 'mcp list --json') return {
          exitCode: 0,
          stdout: JSON.stringify(state === 'absent' ? [] : [{ name: 'aun', enabled: true }]),
          stderr: '',
        }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') {
          state = 'intended'
          return { exitCode: 0, stdout: 'added', stderr: '' }
        }
        if (joined === 'mcp remove aun') {
          removeCalls++
          state = 'absent'
          return { exitCode: 0, stdout: 'removed', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })
    const applied = await adapter.applyMcpRegistration(recoveryContext)
    expect(applied.ok).toBe(true)
    expect(admission).not.toBeNull()
    state = 'foreign'
    const foreignBefore = JSON.stringify(foreignTuple)
    const rolledBack = await adapter.rollbackRuntimeRegistration(recoveryContext, {
      mutation_id: 'absent-admission-foreign',
      stage: 'B4_MCP_REGISTRATION',
      rollback_status: 'not_run',
      ...admission,
      rollback_payload: { ...admission.rollback_payload, recovery_admission: true },
    })
    expect(rolledBack.ok).toBe(false)
    expect(rolledBack.reasonCodes).toEqual(['NO_GO_ROLLBACK_UNVERIFIED'])
    expect(removeCalls).toBe(0)
    expect(state).toBe('foreign')
    expect(JSON.stringify(foreignTuple)).toBe(foreignBefore)
    console.log(JSON.stringify({
      fixture: 'B4_ABSENT_PRESTATE_FOREIGN_TUPLE_FENCE',
      rollback_result: 'NO_GO_ROLLBACK_UNVERIFIED',
      remove_calls: removeCalls,
      foreign_tuple_preserved: state === 'foreign' && JSON.stringify(foreignTuple) === foreignBefore,
    }))
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

  test('F7 enabled, duplicate, or unrecognized legacy tuples fail closed with zero mutation', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-codex-legacy-reject-')))
    const configPath = join(root, 'config.toml')
    const original = Buffer.from('[mcp_servers.aun]\nenabled = false\nlegacy = "exact"\n')
    writeFileSync(configPath, original, { mode: 0o600 })
    const legacy = {
      name: 'aun', enabled: false, scope: 'user',
      transport: {
        type: 'stdio', command: '/Users/yuji/.bun/bin/bun',
        args: ['run', '/Users/yuji/.agent-comms/state-daemon/current/server.ts'], env: null,
      },
    }
    const candidateContext: BootstrapStageContext = {
      ...context,
      providerRootAuthority: {
        existingTarget: true, canonicalSourceField: 'metadata.codex_home', canonicalRoot: root,
        canonicalRootDigest: 'root', canonicalRealpathDigest: 'real-root',
        projectionMatches: true, callerMismatch: false,
      },
    }
    const fixtures: Array<{ name: string; tuple: any; list: any[] }> = [
      { name: 'enabled', tuple: { ...legacy, enabled: true }, list: [{ name: 'aun', enabled: true }] },
      { name: 'duplicate', tuple: legacy, list: [{ name: 'aun', enabled: false }, { name: 'aun', enabled: false }] },
      { name: 'wrong-scope', tuple: { ...legacy, scope: 'project' }, list: [{ name: 'aun', enabled: false }] },
      { name: 'wrong-command', tuple: { ...legacy, transport: { ...legacy.transport, command: '/wrong/bun' } }, list: [{ name: 'aun', enabled: false }] },
      { name: 'wrong-argv', tuple: { ...legacy, transport: { ...legacy.transport, args: ['run', '/wrong/server.ts'] } }, list: [{ name: 'aun', enabled: false }] },
      { name: 'non-null-env', tuple: { ...legacy, transport: { ...legacy.transport, env: {} } }, list: [{ name: 'aun', enabled: false }] },
      { name: 'extra-top-field', tuple: { ...legacy, foreign: true }, list: [{ name: 'aun', enabled: false }] },
      { name: 'extra-transport-field', tuple: { ...legacy, transport: { ...legacy.transport, foreign: true } }, list: [{ name: 'aun', enabled: false }] },
    ]
    try {
      for (const fixture of fixtures) {
        const mutations: string[] = []
        const adapter = createCodexBootstrapAdapter({
          bunPath: '/bin/bun', serverEntry: 'server.ts',
          run: async (_command, args) => {
            const joined = args.join(' ')
            if (joined === 'mcp get aun --json') return { exitCode: 0, stdout: JSON.stringify(fixture.tuple), stderr: '' }
            if (joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(fixture.list), stderr: '' }
            if (joined === 'mcp remove aun' || args.slice(0, 3).join(' ') === 'mcp add aun') mutations.push(joined)
            return { exitCode: 1, stdout: '', stderr: 'unexpected mutation' }
          },
        })
        const result = await adapter.applyMcpRegistration(candidateContext)
        expect(result.ok, fixture.name).toBe(false)
        expect(result.reasonCodes, fixture.name).toEqual(['NO_GO_PROVIDER_ADAPTER_MISMATCH'])
        expect(result.mutation, fixture.name).toBeUndefined()
        expect(mutations, fixture.name).toEqual([])
        expect(readFileSync(configPath).equals(original), fixture.name).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('F8 nonzero legacy remove with exact unchanged prestate deletes the private backup without mutation', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-codex-legacy-remove-fail-')))
    const configPath = join(root, 'config.toml')
    const original = Buffer.from('[mcp_servers.aun]\nenabled = false\nlegacy = "exact"\n')
    writeFileSync(configPath, original, { mode: 0o600 })
    const legacy = {
      name: 'aun', enabled: false, scope: 'user',
      transport: {
        type: 'stdio', command: '/Users/yuji/.bun/bin/bun',
        args: ['run', '/Users/yuji/.agent-comms/state-daemon/current/server.ts'], env: null,
      },
    }
    const candidateContext: BootstrapStageContext = {
      ...context,
      providerRootAuthority: {
        existingTarget: true, canonicalSourceField: 'metadata.codex_home', canonicalRoot: root,
        canonicalRootDigest: 'root', canonicalRealpathDigest: 'real-root',
        projectionMatches: true, callerMismatch: false,
      },
    }
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        const joined = args.join(' ')
        if (joined === 'mcp get aun --json') return { exitCode: 0, stdout: JSON.stringify(legacy), stderr: '' }
        if (joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify([{ name: 'aun', enabled: false }]), stderr: '' }
        if (joined === 'mcp remove aun') return { exitCode: 124, stdout: '', stderr: 'timeout without mutation' }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })
    try {
      const result = await adapter.applyMcpRegistration(candidateContext)
      expect(result.ok).toBe(false)
      expect(result.reasonCodes).toEqual(['NO_GO_MCP_REGISTRATION'])
      expect(result.mutation).toBeUndefined()
      expect(readFileSync(configPath).equals(original)).toBe(true)
      expect(existsSync(join(root, `.aun-bootstrap-rollback-${context.runId}`))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('F13 a hard-linked provider artifact fails closed before native mutation', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-codex-hardlink-reject-')))
    const configPath = join(root, 'config.toml')
    const original = Buffer.from('[mcp_servers.aun]\nenabled = false\nlegacy = "exact"\n')
    writeFileSync(configPath, original, { mode: 0o600 })
    linkSync(configPath, join(root, 'config.toml.foreign-link'))
    const legacy = {
      name: 'aun', enabled: false, scope: 'user',
      transport: {
        type: 'stdio', command: '/Users/yuji/.bun/bin/bun',
        args: ['run', '/Users/yuji/.agent-comms/state-daemon/current/server.ts'], env: null,
      },
    }
    const candidateContext: BootstrapStageContext = {
      ...context,
      providerRootAuthority: {
        existingTarget: true, canonicalSourceField: 'metadata.codex_home', canonicalRoot: root,
        canonicalRootDigest: 'root', canonicalRealpathDigest: 'real-root',
        projectionMatches: true, callerMismatch: false,
      },
    }
    const mutations: string[] = []
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      run: async (_command, args) => {
        const joined = args.join(' ')
        if (joined === 'mcp get aun --json') return { exitCode: 0, stdout: JSON.stringify(legacy), stderr: '' }
        if (joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify([{ name: 'aun', enabled: false }]), stderr: '' }
        mutations.push(joined)
        return { exitCode: 1, stdout: '', stderr: 'unexpected mutation' }
      },
    })
    try {
      const result = await adapter.applyMcpRegistration(candidateContext)
      expect(result.ok).toBe(false)
      expect(result.reasonCodes).toEqual(['NO_GO_PROVIDER_ARTIFACT_AMBIGUOUS'])
      expect(result.mutation).toBeUndefined()
      expect(mutations).toEqual([])
      expect(readFileSync(configPath).equals(original)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recognized disabled user-scope legacy tuple upgrades with a private durable backup and exact rollback', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-codex-legacy-')))
    const configPath = join(root, 'config.toml')
    const original = Buffer.from('[mcp_servers.aun]\nenabled = false\nlegacy = "exact"\n')
    const absentBytes = Buffer.from('[mcp_servers.other]\nenabled = true\n')
    const intendedBytes = Buffer.from('[mcp_servers.aun]\nenabled = true\ncommand = "current"\n')
    const foreignBytes = Buffer.from('[mcp_servers.foreign]\nenabled = true\nowner = "other-process"\n')
    writeFileSync(configPath, original, { mode: 0o600 })
    const legacy = {
      name: 'aun', enabled: false, scope: 'user',
      transport: {
        type: 'stdio', command: '/Users/yuji/.bun/bin/bun',
        args: ['run', '/Users/yuji/.agent-comms/state-daemon/current/server.ts'], env: null,
      },
    }
    const candidateContext: BootstrapStageContext = {
      ...context,
      env: { ...context.env, CODEX_HOME: '/tmp/caller-must-not-win' },
      providerRootAuthority: {
        existingTarget: true,
        canonicalSourceField: 'metadata.codex_home',
        canonicalRoot: root,
        canonicalRootDigest: 'root',
        canonicalRealpathDigest: 'real-root',
        projectionMatches: true,
        callerMismatch: true,
      },
    }
    const nativeState = () => readFileSync(configPath).equals(original)
      ? 'legacy'
      : readFileSync(configPath).equals(intendedBytes) ? 'intended' : 'absent'
    const seenRoots: string[] = []
    const admissionTrace: string[] = []
    let addExitCode = 0
    let injectForeignEditDuringAbsenceReadback = false
    let injectForeignEditAtAtomicCommit = false
    candidateContext.admitRecoveryMutation = (mutation) => {
      admissionTrace.push(`admit:${String(mutation.rollback_payload?.recovery_admission_phase)}`)
    }
    candidateContext.cancelRecoveryAdmission = () => {
      admissionTrace.push('cancel')
    }
    const adapter = createCodexBootstrapAdapter({
      bunPath: '/bin/bun', serverEntry: 'server.ts',
      beforeProviderArtifactNoClobberCommit: () => {
        if (!injectForeignEditAtAtomicCommit) return
        injectForeignEditAtAtomicCommit = false
        writeFileSync(configPath, foreignBytes, { mode: 0o600 })
      },
      run: async (_command, args, options) => {
        seenRoots.push(options.env.CODEX_HOME)
        const joined = args.join(' ')
        const state = nativeState()
        if (joined === 'mcp get aun --json') {
          if (state === 'legacy') return { exitCode: 0, stdout: JSON.stringify(legacy), stderr: '' }
          if (state === 'intended') return { exitCode: 0, stdout: exactGet(), stderr: '' }
          if (injectForeignEditDuringAbsenceReadback) {
            injectForeignEditDuringAbsenceReadback = false
            writeFileSync(configPath, foreignBytes, { mode: 0o600 })
          }
          return { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
        }
        if (joined === 'mcp list --json') return {
          exitCode: 0,
          stdout: JSON.stringify(state === 'legacy'
            ? [{ name: 'aun', enabled: false }]
            : state === 'intended' ? [{ name: 'aun', enabled: true }] : []),
          stderr: '',
        }
        if (joined === 'mcp remove aun') {
          admissionTrace.push('remove')
          writeFileSync(configPath, absentBytes, { mode: 0o600 })
          return { exitCode: 0, stdout: 'removed', stderr: '' }
        }
        if (args.slice(0, 3).join(' ') === 'mcp add aun') {
          admissionTrace.push('add')
          writeFileSync(configPath, intendedBytes, { mode: 0o600 })
          return { exitCode: addExitCode, stdout: addExitCode === 0 ? 'added' : '', stderr: addExitCode === 0 ? '' : 'timeout after mutation' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
    })
    try {
      const upgraded = await adapter.applyMcpRegistration(candidateContext)
      expect(upgraded.ok).toBe(true)
      expect(admissionTrace.slice(0, 4)).toEqual([
        'admit:B4_PRE_PROVIDER_REMOVE',
        'remove',
        'admit:B4_POST_PROVIDER_REMOVE',
        'add',
      ])
      expect(upgraded.mutation?.rollback_payload).toMatchObject({
        replaced_recognized_disabled_legacy: true,
        backup_fsync_verified: true,
        backup_retained: true,
      })
      const backupPath = String(upgraded.mutation?.rollback_payload?.private_backup_path)
      expect(statSync(backupPath).mode & 0o777).toBe(0o600)
      expect(seenRoots.every((value) => value === root)).toBe(true)
      const rolledBack = await adapter.rollbackRuntimeRegistration(candidateContext, {
        mutation_id: 'legacy-upgrade', stage: 'B4_MCP_REGISTRATION', rollback_status: 'not_run', ...upgraded.mutation!,
      })
      expect(rolledBack.ok).toBe(true)
      expect(readFileSync(configPath).equals(original)).toBe(true)
      expect(existsSync(backupPath)).toBe(false)
      addExitCode = 124
      const timedOutUpgrade = await adapter.applyMcpRegistration(candidateContext)
      expect(timedOutUpgrade.ok).toBe(false)
      expect(timedOutUpgrade.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
      expect(timedOutUpgrade.mutation?.actual_after_digest).toBeString()
      const timedOutRollback = await adapter.rollbackRuntimeRegistration(candidateContext, {
        mutation_id: 'legacy-timeout', stage: 'B4_MCP_REGISTRATION', rollback_status: 'not_run', ...timedOutUpgrade.mutation!,
      })
      expect(timedOutRollback.ok).toBe(true)
      expect(readFileSync(configPath).equals(original)).toBe(true)
      expect(existsSync(String(timedOutUpgrade.mutation?.rollback_payload?.private_backup_path))).toBe(false)
      addExitCode = 0
      const terminalUpgrade = await adapter.applyMcpRegistration(candidateContext)
      expect(terminalUpgrade.ok).toBe(true)
      const terminalMutation = {
        mutation_id: 'legacy-terminal', stage: 'B4_MCP_REGISTRATION' as const,
        rollback_status: 'not_run' as const, ...terminalUpgrade.mutation!,
      }
      const terminalBackupPath = String(terminalMutation.rollback_payload?.private_backup_path)
      const finalized = await adapter.finalizeRuntimeRegistration!(candidateContext, terminalMutation)
      expect(finalized.ok).toBe(true)
      expect(existsSync(terminalBackupPath)).toBe(false)
      expect(terminalMutation.rollback_payload).toMatchObject({ backup_retained: false, backup_deleted: true })

      writeFileSync(configPath, original, { mode: 0o600 })
      const foreignUpgrade = await adapter.applyMcpRegistration(candidateContext)
      expect(foreignUpgrade.ok).toBe(true)
      const foreignBackupPath = String(foreignUpgrade.mutation?.rollback_payload?.private_backup_path)
      injectForeignEditDuringAbsenceReadback = true
      const foreignRollback = await adapter.rollbackRuntimeRegistration(candidateContext, {
        mutation_id: 'legacy-foreign-edit', stage: 'B4_MCP_REGISTRATION', rollback_status: 'not_run', ...foreignUpgrade.mutation!,
      })
      expect(foreignRollback.ok).toBe(false)
      expect(foreignRollback.reasonCodes).toEqual(['NO_GO_ROLLBACK_UNVERIFIED'])
      expect(readFileSync(configPath).equals(foreignBytes)).toBe(true)
      expect(existsSync(foreignBackupPath)).toBe(true)

      rmSync(join(root, `.aun-bootstrap-rollback-${candidateContext.runId}`), { recursive: true, force: true })
      writeFileSync(configPath, original, { mode: 0o600 })
      const atomicRaceUpgrade = await adapter.applyMcpRegistration(candidateContext)
      expect(atomicRaceUpgrade.ok).toBe(true)
      const atomicRaceBackupPath = String(atomicRaceUpgrade.mutation?.rollback_payload?.private_backup_path)
      injectForeignEditAtAtomicCommit = true
      const atomicRaceRollback = await adapter.rollbackRuntimeRegistration(candidateContext, {
        mutation_id: 'legacy-final-no-clobber-race',
        stage: 'B4_MCP_REGISTRATION',
        rollback_status: 'not_run',
        ...atomicRaceUpgrade.mutation!,
      })
      expect(atomicRaceRollback.ok).toBe(false)
      expect(atomicRaceRollback.reasonCodes).toEqual(['NO_GO_ROLLBACK_UNVERIFIED'])
      expect(readFileSync(configPath).equals(foreignBytes)).toBe(true)
      expect(existsSync(atomicRaceBackupPath)).toBe(true)
      expect(existsSync(join(root, `.config.toml.aun-displaced-${candidateContext.runId}`))).toBe(false)
      console.log(JSON.stringify({
        fixture: 'B4_PROVIDER_FINAL_CHECK_TO_COMMIT_RACE',
        rollback_result: 'NO_GO_ROLLBACK_UNVERIFIED',
        no_clobber_commit: true,
        foreign_bytes_preserved: readFileSync(configPath).equals(foreignBytes),
        private_backup_retained: existsSync(atomicRaceBackupPath),
        displaced_run_owned_residue: false,
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
