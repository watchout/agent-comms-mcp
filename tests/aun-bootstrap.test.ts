import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, bootstrapInternal } from '../bin/aun/bootstrap'
import { createCodexBootstrapAdapter } from '../bin/aun/bootstrap-adapter-codex'
import type {
  BootstrapExecutionPorts,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from '../bin/aun/bootstrap-types'
import { MemoryBootstrapStateStore, bootstrapDigest } from '../core/aun-bootstrap-state'
import { selectBootstrapRuntime } from '../core/runtime-inventory'

const HEAD = 'c8eb30805a587a65a794499fa597935f2460c703'

function fakeRun() {
  return async (command: string, args: string[]) => ({
    exitCode: command === 'git' && args.join(' ') === 'rev-parse HEAD' ? 0 : 1,
    stdout: command === 'git' ? `${HEAD}\n` : '',
    stderr: '',
  })
}

function passingPorts(calls: string[] = []): BootstrapExecutionPorts {
  const pass = (name: string, outcome: BootstrapStageOutcome = { ok: true }) => async (_context: BootstrapStageContext) => {
    calls.push(name)
    return outcome
  }
  return {
    lockAndSnapshot: pass('B0'),
    dependencyPreflight: pass('B1', { ok: true, resolvedRuntime: 'codex', readinessPredicates: { runtime_unambiguous: true } }),
    migrateDatabase: pass('B2', { ok: true, mutation: { kind: 'db', owner_key: 'db:run', before_digest: null, intended_after_digest: 'a', actual_after_digest: 'a', rollback_action: 'restore snapshot' } }),
    ensureAgentProfile: pass('B3', { ok: true, readinessPredicates: { profile_readback_matches: true } }),
    ensureMcpRegistration: pass('B4', { ok: true, readinessPredicates: { mcp_registered: true } }),
    ensureMemoryReadiness: pass('B5', { ok: true, readinessPredicates: { memory_recovery_ready: true } }),
    installAndStartDaemon: pass('B6', { ok: true, readinessPredicates: { daemon_started: true } }),
    runQueueSmoke: pass('B7', { ok: true, readinessPredicates: { enqueue_once: true, claim_at_most_once: true, terminal_once: true, external_effect_zero: true } }),
    readbackReady: pass('B8', { ok: true, readinessPredicates: { safe_d1_readback: true } }),
    revalidateStage: async (context, stage) => {
      calls.push(`R:${stage}`)
      return {
        ok: true,
        readbackDigest: context.priorState.stages.find((record) => record.stage === stage)?.readback_digest ?? undefined,
      }
    },
    rollbackMutation: pass('rollback', { ok: true, readbackDigest: 'exact-prestate' }),
  }
}

describe('aun bootstrap B0-B8 state machine', () => {
  test('F1 canonical provider identity collapses 100 object-key permutations without raw config persistence', async () => {
    const permutations = <T>(items: T[]): T[][] => items.length < 2
      ? [items]
      : items.flatMap((item, index) => permutations(items.filter((_, candidate) => candidate !== index))
          .map((tail) => [item, ...tail]))
    const transport = {
      type: 'stdio', command: '/bin/bun', args: ['run', 2, true],
      env: { A: 'one', B: 'two' },
    }
    const fields: Array<[string, unknown]> = [
      ['name', 'wasurezu'], ['enabled', true], ['scope', 'user'],
      ['transport', transport], ['startup_timeout_sec', 30],
    ]
    const documents = permutations(fields).slice(0, 100)
      .map((entries) => JSON.stringify(Object.fromEntries(entries)))
    expect(new Set(documents).size).toBe(100)
    const digests = new Set<string>()
    for (const stdout of documents) {
      const snapshot = await bootstrapInternal.providerInputSnapshot({
        requestedRuntime: 'codex', repoRoot: process.cwd(), home: '/tmp/provider-json',
        env: { HOME: '/tmp/provider-json', CODEX_HOME: '/tmp/provider-json/.codex' },
        run: async (_command, args) => args.join(' ') === '--version'
          ? { exitCode: 0, stdout: 'codex 1', stderr: '' }
          : { exitCode: 0, stdout, stderr: '' },
      }) as any
      digests.add(snapshot.codex.wasurezu_native_readback_digest)
      expect(JSON.stringify(snapshot)).not.toContain('"env":{"A":"one"')
      expect(JSON.stringify(snapshot)).not.toContain('"args":["run",2,true]')
    }
    expect(digests.size).toBe(1)
  })

  test('F2 every semantic provider tuple change produces a distinct canonical identity', async () => {
    const base = {
      name: 'wasurezu', enabled: true, scope: 'user',
      transport: { type: 'stdio', command: '/bin/bun', args: ['run', 'server.ts'], env: { A: 'one' } },
    }
    const variants = [
      base,
      { ...base, enabled: false },
      { ...base, scope: 'project' },
      { ...base, transport: { ...base.transport, command: '/other/bun' } },
      { ...base, transport: { ...base.transport, args: ['run', 'other.ts'] } },
      { ...base, transport: { ...base.transport, env: { A: 'two' } } },
    ]
    const digests = new Set<string>()
    for (const document of variants) {
      const snapshot = await bootstrapInternal.providerInputSnapshot({
        requestedRuntime: 'codex', repoRoot: process.cwd(), home: '/tmp/provider-json-semantic',
        env: { HOME: '/tmp/provider-json-semantic', CODEX_HOME: '/tmp/provider-json-semantic/.codex' },
        run: async (_command, args) => args.join(' ') === '--version'
          ? { exitCode: 0, stdout: 'codex 1', stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify(document), stderr: '' },
      }) as any
      digests.add(snapshot.codex.wasurezu_native_readback_digest)
    }
    expect(digests.size).toBe(variants.length)
  })

  test('successful malformed provider JSON fails closed before any stage mutation', async () => {
    await expect(bootstrapInternal.providerInputSnapshot({
      requestedRuntime: 'codex', repoRoot: process.cwd(), home: '/tmp/provider-json-invalid',
      env: { HOME: '/tmp/provider-json-invalid' },
      run: async (_command, args) => args.join(' ') === '--version'
        ? { exitCode: 0, stdout: 'codex 1', stderr: '' }
        : { exitCode: 0, stdout: '{invalid', stderr: 'raw-secret=must-not-persist' },
    })).rejects.toThrow('NO_GO_PROVIDER_NATIVE_JSON_INVALID')
  })

  test('clean-host Codex root is canonical HOME/.codex and caller CODEX_HOME is evidence-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-root-authority-'))
    try {
      const resolved = await bootstrapInternal.resolveProviderRootAuthority({
        agentId: 'clean-root', requestedRuntime: 'codex', home,
        repoRoot: process.cwd(), env: { HOME: home, CODEX_HOME: '/tmp/untrusted-caller-root' },
      })
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) throw new Error('unexpected root authority rejection')
      expect(resolved.authority).toMatchObject({
        existingTarget: false,
        canonicalSourceField: 'clean_host_default',
        canonicalRoot: join(realpathSync(home), '.codex'),
        callerMismatch: true,
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('B5-COEXIST-001 rejects an ordinary active row before creating an ambiguous bootstrap receipt', () => {
    const tuple = {
      agent_id: 'misell', runtime_engine: 'codex' as const, session_name: 'misell',
      process_id: 7312, port: 8812, checkout_path: realpathSync(process.cwd()), commit_sha: HEAD,
    }
    const decision = bootstrapInternal.classifyRuntimeReceiptRows([{
      runtime_instance_id: 'ordinary-1', agent_id: 'misell', runtime_engine: 'codex',
      runtime_kind: 'local_process', session_name: 'misell', process_id: 7000,
      port: 8812, checkout_path: tuple.checkout_path, commit_sha: HEAD, status: 'running',
      metadata: { secret: 'must-not-escape' },
    }], tuple)
    expect(decision).toMatchObject({
      ok: false, discriminator: 'runtime_receipt_incompatible', ordinaryActiveCount: 1, bootstrapActiveCount: 0,
    })
    expect(JSON.stringify(decision)).not.toContain('must-not-escape')
  })

  test('B5-COEXIST-002 rejects ordinary plus bootstrap active coexistence deterministically', () => {
    const tuple = {
      agent_id: 'misell', runtime_engine: 'codex' as const, session_name: 'misell',
      process_id: 7312, port: 8812, checkout_path: realpathSync(process.cwd()), commit_sha: HEAD,
    }
    const rows = [
      {
        runtime_instance_id: 'ordinary-1', agent_id: 'misell', runtime_engine: 'codex',
        runtime_kind: 'state_daemon', session_name: null, process_id: 5000,
        port: null, checkout_path: tuple.checkout_path, commit_sha: HEAD, status: 'active', metadata: {},
      },
      {
        runtime_instance_id: 'bootstrap-1', ...tuple,
        runtime_kind: 'bootstrap_bound_provider', status: 'running', metadata: { bootstrap_run_id: 'prior-run' },
      },
    ]
    expect(bootstrapInternal.classifyRuntimeReceiptRows(rows, tuple)).toMatchObject({
      ok: false, discriminator: 'runtime_receipt_ambiguous', ordinaryActiveCount: 1, bootstrapActiveCount: 1,
    })
  })

  test('B5-FAIL-CLOSED-001 rejects one incompatible bootstrap receipt before mutation', () => {
    const tuple = {
      agent_id: 'misell', runtime_engine: 'codex' as const, session_name: 'misell',
      process_id: 7312, port: 8812, checkout_path: realpathSync(process.cwd()), commit_sha: HEAD,
    }
    const decision = bootstrapInternal.classifyRuntimeReceiptRows([{
      runtime_instance_id: 'bootstrap-wrong', ...tuple, process_id: 9999,
      runtime_kind: 'bootstrap_bound_provider', status: 'running', metadata: {},
    }], tuple)
    expect(decision).toMatchObject({
      ok: false, discriminator: 'runtime_receipt_incompatible', ordinaryActiveCount: 0, bootstrapActiveCount: 1,
    })
  })

  test('B5-FAIL-CLOSED-002 rejects multiple bootstrap receipts even when both match', () => {
    const tuple = {
      agent_id: 'misell', runtime_engine: 'codex' as const, session_name: 'misell',
      process_id: 7312, port: 8812, checkout_path: realpathSync(process.cwd()), commit_sha: HEAD,
    }
    const row = {
      agent_id: 'misell', runtime_engine: 'codex', runtime_kind: 'bootstrap_bound_provider',
      session_name: 'misell', process_id: 7312, port: 8812, checkout_path: tuple.checkout_path,
      commit_sha: HEAD, status: 'running', metadata: {},
    }
    const decision = bootstrapInternal.classifyRuntimeReceiptRows([
      { runtime_instance_id: 'bootstrap-1', ...row },
      { runtime_instance_id: 'bootstrap-2', ...row },
    ], tuple)
    expect(decision).toMatchObject({
      ok: false, discriminator: 'runtime_receipt_ambiguous', ordinaryActiveCount: 0, bootstrapActiveCount: 2,
    })
  })

  test('genuine Wasurezu MCP protocol rejects missing/error/wrong-project/fabricated/timeout receipts', async () => {
    const fixture = (mode: string) => `
      const readline = require('node:readline');
      const rl = readline.createInterface({ input: process.stdin });
      if (${JSON.stringify(mode)} === 'fabricated') console.log(JSON.stringify({jsonrpc:'2.0',id:3,result:{content:[{type:'text',text:'Project expected recovered'}],isError:false}}));
      rl.on('line', (line) => {
        const m = JSON.parse(line); const mode = ${JSON.stringify(mode)};
        if (mode === 'timeout') return;
        if (m.id === 1) console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}}}));
        if (m.id === 2) console.log(JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:mode === 'missing' ? [] : [{name:'recover_context',inputSchema:{type:'object'}}]}}));
        if (m.id === 3) console.log(JSON.stringify({jsonrpc:'2.0',id:3,result:{content:[{type:'text',text:mode === 'wrong-project' ? 'Project other recovered' : 'Project expected recovered'}],isError:mode === 'error'}}));
      });
    `
    for (const mode of ['missing', 'error', 'wrong-project', 'fabricated', 'timeout']) {
      const context = {
        runId: 'mcp-test', agentId: 'mcp-test', requestedRuntime: 'codex', resolvedRuntime: 'codex',
        repoRoot: process.cwd(), workspaceRoot: process.cwd(), repoHead: HEAD, dryRun: false,
        env: { AUN_BOOTSTRAP_MCP_RECOVERY_TIMEOUT_MS: '50' }, priorState: {} as any,
      } as const
      await expect(bootstrapInternal.runStdioMcpRecovery({
        command: process.execPath, args: ['-e', fixture(mode)], env: {}, tupleDigest: 'fixture',
      }, 'expected', context as any)).rejects.toThrow()
    }
  }, 10_000)

  test('timed-out child is SIGKILLed and cannot perform a later write before runner resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aun-bootstrap-timeout-'))
    const latePath = join(root, 'late-write')
    try {
      const runner = bootstrapInternal.defaultCommandRunner()
      const started = Date.now()
      const result = await runner(process.execPath, ['-e', `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {});
        setTimeout(() => fs.writeFileSync(${JSON.stringify(latePath)}, 'late'), 6000);
        setInterval(() => {}, 1000);
      `], { cwd: root, env: { ...process.env } as Record<string, string>, timeoutMs: 50 })
      expect(result.exitCode).toBe(124)
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900)
      expect(existsSync(latePath)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  test('auto runtime requires live identity and rejects provider conflict', () => {
    expect(selectBootstrapRuntime('auto', [
      { source: 'agent_profile', runtime: 'codex', verified: true, evidence: 'profile' },
    ]).reason).toBe('NO_GO_RUNTIME_UNDETECTED')
    expect(selectBootstrapRuntime('auto', [
      { source: 'agent_profile', runtime: 'codex', verified: true, evidence: 'profile' },
      { source: 'process_identity', runtime: 'claude', verified: true, evidence: 'process' },
    ]).reason).toBe('NO_GO_RUNTIME_AMBIGUOUS')
    expect(selectBootstrapRuntime('auto', [
      { source: 'agent_profile', runtime: 'codex', verified: true, evidence: 'profile' },
      { source: 'process_identity', runtime: 'codex', verified: true, evidence: 'process' },
    ])).toMatchObject({ ok: true, runtime: 'codex' })
  })

  test('returns READY only after every deterministic stage passes', async () => {
    const store = new MemoryBootstrapStateStore()
    const calls: string[] = []
    const result = await bootstrap({
      agentId: 'clean-codex', runtime: 'auto', home: '/tmp/clean-codex', repoRoot: process.cwd(), env: { HOME: '/tmp/clean-codex' },
    }, { stateStore: store, ports: passingPorts(calls), run: fakeRun() })

    expect(result.status).toBe('READY')
    expect(result.resolved_runtime).toBe('codex')
    expect(calls).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'])
    expect(result.safe_D1_readback).toEqual({
      SHIRUBE_D1_ENABLED: '0',
      SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]',
      STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    })
    expect(result.readiness_predicates).toMatchObject({
      runtime_unambiguous: true,
      memory_recovery_ready: true,
      enqueue_once: true,
      external_effect_zero: true,
      safe_d1_readback: true,
    })
  })

  test('dry-run plans B0-B8 without persisting a run journal', async () => {
    const store = new MemoryBootstrapStateStore()
    const calls: string[] = []
    const result = await bootstrap({
      agentId: 'plan-only', runtime: 'codex', dryRun: true, home: '/tmp/plan-only', repoRoot: process.cwd(), env: { HOME: '/tmp/plan-only' },
    }, { stateStore: store, ports: passingPorts(calls), run: fakeRun() })

    expect(result.status).toBe('PLANNED')
    expect(calls).toHaveLength(9)
    expect(store.states.size).toBe(0)
    expect(store.locks.size).toBe(0)
  })

  test('a failed memory predicate is terminal NO_GO and instructs a new run, never resume', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    ports.ensureMemoryReadiness = async () => ({ ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'] })
    const result = await bootstrap({
      agentId: 'no-memory', runtime: 'codex', home: '/tmp/no-memory', repoRoot: process.cwd(), env: { HOME: '/tmp/no-memory' },
    }, { stateStore: store, ports, run: fakeRun() })

    expect(result.status).toBe('NO_GO')
    expect(result.stage).toBe('B5_MEMORY_READINESS')
    expect(result.reason_codes).toEqual(['NO_GO_MEMORY_RECOVERY'])
    expect(result.next_action.blocking).toBe(true)
    expect(result.next_action.deliver_via).not.toContain('--resume')
    expect(result.next_action.action).toContain('failed run is terminal')
  })

  test('a failed run cannot re-enter stages under --resume', async () => {
    const store = new MemoryBootstrapStateStore()
    const calls: string[] = []
    const ports = passingPorts(calls)
    ports.ensureMemoryReadiness = async () => { calls.push('B5'); return { ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'] } }
    const input = { agentId: 'resume-agent', runtime: 'auto' as const, home: '/tmp/resume-agent', repoRoot: process.cwd(), env: { HOME: '/tmp/resume-agent' } }
    const first = await bootstrap(input, { stateStore: store, ports, run: fakeRun() })
    expect(first.status).toBe('NO_GO')
    calls.length = 0
    ports.ensureMemoryReadiness = async () => { calls.push('B5'); return { ok: true } }
    const resumed = await bootstrap({ ...input, runtime: 'codex', resumeRunId: first.run_id }, { stateStore: store, ports, run: fakeRun() })
    expect(resumed.status).toBe('NO_GO')
    expect(resumed.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])
    expect(calls).toEqual([])
  })

  test('terminal failed-run rejection precedes changed external input probes', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    ports.ensureMemoryReadiness = async () => ({ ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'] })
    const base = {
      agentId: 'resume-fence', runtime: 'codex' as const, home: '/tmp/resume-fence', repoRoot: process.cwd(),
      workspaceRoot: '/tmp/workspace-a', env: { HOME: '/tmp/resume-fence', AUN_HOME: '/tmp/aun-a' },
    }
    const first = await bootstrap(base, { stateStore: store, ports, run: fakeRun() })
    expect(first.status).toBe('NO_GO')
    for (const changed of [
      { env: { ...base.env, DATABASE_URL: 'postgresql:///unreachable' } },
      { env: { ...base.env, AUN_HOME: '/tmp/aun-b' } },
      { workspaceRoot: '/tmp/workspace-b' },
    ]) {
      const resumed = await bootstrap({ ...base, ...changed, resumeRunId: first.run_id }, { stateStore: store, ports, run: fakeRun() })
      expect(resumed.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])
    }
    const stored = store.states.get(`resume-fence/${first.run_id}`)!
    stored.mutations[0].actual_after_digest = 'tampered'
    store.states.set(`resume-fence/${first.run_id}`, stored)
    const mutationDrift = await bootstrap({ ...base, resumeRunId: first.run_id }, { stateStore: store, ports, run: fakeRun() })
    expect(mutationDrift.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])
  })

  test('failed mutating stage is journaled and rolled back before the per-agent lock is released', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    let failWithMutation = true
    let rollbackFinished = false
    ports.ensureMcpRegistration = async (context) => failWithMutation
      ? {
          ok: false,
          reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
          readbackDigest: 'observed-provider-tuple',
          mutation: {
            kind: 'mcp_registration', owner_key: `codex:aun:${context.runId}`,
            before_digest: 'absent', intended_after_digest: 'tuple', actual_after_digest: 'tuple',
            rollback_action: 'remove and native-readback', rollback_payload: { created_by_run: true },
          },
        }
      : { ok: true, readbackDigest: 'observed-provider-tuple' }
    ports.rollbackMutation = async () => {
      await Promise.resolve()
      rollbackFinished = true
      return { ok: true, evidenceRefs: ['native-target-equals-prestate'], readbackDigest: 'native-prestate' }
    }
    const input = { agentId: 'post-mutation-lock', runtime: 'codex' as const, home: '/tmp/post-mutation-lock', repoRoot: process.cwd(), env: { HOME: '/tmp/post-mutation-lock' } }
    const failed = await bootstrap(input, { stateStore: store, ports, run: fakeRun(), uuid: () => 'failed-run' })
    expect(failed.reason_codes).toContain('NO_GO_POST_MUTATION_READBACK')
    expect(rollbackFinished).toBe(true)
    const failedState = store.states.get('post-mutation-lock/bootstrap-failed-run')!
    const providerMutation = failedState.mutations.find((mutation) => mutation.kind === 'mcp_registration')!
    expect(providerMutation.rollback_status).toBe('verified')
    expect(providerMutation.rollback_payload?.rollback_disposition).toBe('verified_after_failed_command')
    expect(providerMutation.rollback_payload?.rollback_readback_digest).toBe('native-prestate')
    expect(Date.parse(failedState.lock_release_authorized_at!)).toBeGreaterThanOrEqual(Date.parse(String(providerMutation.rollback_payload?.rollback_completed_at)))
    expect(Date.parse(failedState.lock_released_at!)).toBeGreaterThanOrEqual(Date.parse(failedState.lock_release_authorized_at!))
    failWithMutation = false
    const retry = await bootstrap(input, { stateStore: store, ports, run: fakeRun(), uuid: () => 'retry-run' })
    expect(retry.status).toBe('READY')
  })

  test('B3 and B4 recovery admissions are durable before the protected effect boundary and block resume re-entry', async () => {
    for (const target of ['B3', 'B4'] as const) {
      const store = new MemoryBootstrapStateStore()
      const ports = passingPorts()
      const agentId = `recovery-admission-${target.toLowerCase()}`
      const input = {
        agentId, runtime: 'codex' as const, home: `/tmp/${agentId}`,
        repoRoot: process.cwd(), env: { HOME: `/tmp/${agentId}` },
      }
      let crashSnapshot: ReturnType<MemoryBootstrapStateStore['load']> = null
      let targetCalls = 0
      const boundary = async (context: BootstrapStageContext): Promise<BootstrapStageOutcome> => {
        targetCalls++
        context.admitRecoveryMutation?.({
          kind: target === 'B3' ? 'configuration_desired' : 'mcp_registration',
          owner_key: `${target.toLowerCase()}:${context.runId}`,
          before_digest: 'exact-prestate',
          intended_after_digest: 'intended-poststate',
          actual_after_digest: null,
          rollback_action: 'restore exact admitted prestate',
          rollback_payload: { created_by_run: true, exact_artifact_identity: 'fixture' },
        })
        crashSnapshot = store.load(agentId, context.runId)
        expect(crashSnapshot?.stages.find((record) => record.stage === (target === 'B3' ? 'B3_AGENT_PROFILE' : 'B4_MCP_REGISTRATION')))
          .toMatchObject({ status: 'pending' })
        expect(crashSnapshot?.mutations).toHaveLength(1)
        expect(crashSnapshot?.mutations[0]?.rollback_payload).toMatchObject({ recovery_admission: true })
        return { ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'] }
      }
      if (target === 'B3') ports.ensureAgentProfile = boundary
      else ports.ensureMcpRegistration = boundary
      ports.rollbackMutation = async () => ({ ok: true, readbackDigest: 'exact-prestate' })
      const first = await bootstrap(input, { stateStore: store, ports, run: fakeRun(), uuid: () => target.toLowerCase() })
      expect(first.status).toBe('NO_GO')
      expect(crashSnapshot).not.toBeNull()
      store.save(crashSnapshot!)
      const resumed = await bootstrap(
        { ...input, resumeRunId: `bootstrap-${target.toLowerCase()}` },
        { stateStore: store, ports, run: fakeRun() },
      )
      expect(resumed.reason_codes).toEqual(['NO_GO_RESUME_REVALIDATION'])
      expect(targetCalls).toBe(1)
    }
  })

  test('F11 forced B5, B6, B7, and B8 failures restore downstream then B4 and ordered B3 mutations', async () => {
    for (const failedStage of ['B5', 'B6', 'B7', 'B8'] as const) {
      const store = new MemoryBootstrapStateStore()
      const rollbackOrder: string[] = []
      const ports = passingPorts()
      ports.ensureAgentProfile = async () => ({
        ok: true,
        mutations: [
          { kind: 'profile', owner_key: 'profile:ordered', before_digest: 'p0', intended_after_digest: 'p1', actual_after_digest: 'p1', rollback_action: 'profile rollback' },
          { kind: 'workspace_authority', owner_key: 'workspace-authority:ordered', before_digest: 'w0', intended_after_digest: 'w1', actual_after_digest: 'w1', rollback_action: 'workspace rollback' },
          { kind: 'configuration_desired', owner_key: 'configuration-desired:ordered', before_digest: 'c0', intended_after_digest: 'c1', actual_after_digest: 'c1', rollback_action: 'desired rollback' },
        ],
      })
      ports.ensureMcpRegistration = async () => ({
        ok: true,
        mutation: { kind: 'mcp_registration', owner_key: 'mcp:ordered', before_digest: 'm0', intended_after_digest: 'm1', actual_after_digest: 'm1', rollback_action: 'provider rollback' },
      })
      const failure = (kind?: 'memory_readiness' | 'daemon' | 'queue_smoke' | 'configuration'): BootstrapStageOutcome => ({
        ok: false,
        reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
        mutation: kind ? {
          kind, owner_key: `${kind}:ordered`, before_digest: `${kind}:0`,
          intended_after_digest: `${kind}:1`, actual_after_digest: `${kind}:1`,
          rollback_action: `${kind} rollback`,
        } : undefined,
      })
      if (failedStage === 'B5') ports.ensureMemoryReadiness = async () => failure()
      if (failedStage === 'B6') ports.installAndStartDaemon = async () => failure('daemon')
      if (failedStage === 'B7') ports.runQueueSmoke = async () => failure('queue_smoke')
      if (failedStage === 'B8') ports.readbackReady = async () => failure('configuration')
      ports.rollbackMutation = async (_context, mutation) => {
        rollbackOrder.push(mutation.kind)
        return { ok: true, readbackDigest: `restored:${mutation.kind}` }
      }
      const agentId = `ordered-reverse-rollback-${failedStage.toLowerCase()}`
      const result = await bootstrap({
        agentId, runtime: 'codex', home: `/tmp/${agentId}`,
        repoRoot: process.cwd(), env: { HOME: `/tmp/${agentId}` },
      }, { stateStore: store, ports, run: fakeRun() })
      expect(result.status, failedStage).toBe('NO_GO')
      const b4Index = rollbackOrder.indexOf('mcp_registration')
      expect(b4Index, failedStage).toBeGreaterThanOrEqual(0)
      expect(rollbackOrder.slice(b4Index, b4Index + 4), failedStage)
        .toEqual(['mcp_registration', 'configuration_desired', 'workspace_authority', 'profile'])
      const state = store.states.get(`${agentId}/${result.run_id}`)!
      expect(state.mutations.every((mutation) => mutation.rollback_status === 'verified'), failedStage).toBe(true)
    }
  })

  test('B4 stage deadline after provider mutation uses fresh readback, journals, and rolls back before lock release', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    let added = false
    let freshReadbackObserved = false
    const run = async (command: string, args: string[], options: { signal?: AbortSignal } = {}) => {
      const joined = args.join(' ')
      if (command === 'git' && joined === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${HEAD}\n`, stderr: '' }
      }
      if (command === 'codex' && joined === '--version') {
        return { exitCode: 0, stdout: 'codex 1.0.0\n', stderr: '' }
      }
      if (command === 'codex' && joined === 'mcp get wasurezu --json') {
        return { exitCode: 0, stdout: '{"name":"wasurezu"}', stderr: '' }
      }
      if (options.signal?.aborted) {
        return { exitCode: 124, stdout: '', stderr: 'command started with aborted signal' }
      }
      if (command === 'codex' && joined === 'mcp get aun --json') {
        if (added) freshReadbackObserved = true
        return added
          ? { exitCode: 0, stdout: JSON.stringify({
              name: 'aun', enabled: true,
              transport: {
                type: 'stdio', command: '/bin/bun', args: ['run', '--cwd', process.cwd(), 'server.ts'],
                env: {
                  AGENT_ID: 'stage-deadline', AGENT_COM_EXPECTED_AGENT_ID: 'stage-deadline',
                  AGENT_COM_SQLITE_PATH: '/tmp/stage-deadline.db', AGENT_COM_DB: 'sqlite',
                  AGENT_COM_PG_NOTIFY: 'false', AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
                },
              },
            }), stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'MCP server aun not found' }
      }
      if (command === 'codex' && joined === 'mcp list --json') {
        if (added) freshReadbackObserved = true
        return { exitCode: 0, stdout: JSON.stringify(added ? [{ name: 'aun', enabled: true }] : []), stderr: '' }
      }
      if (command === 'codex' && args.slice(0, 3).join(' ') === 'mcp add aun') {
        added = true
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          else options.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { exitCode: 124, stdout: '', stderr: 'B4 stage deadline after mutation' }
      }
      if (command === 'codex' && joined === 'mcp remove aun') {
        added = false
        return { exitCode: 0, stdout: 'removed', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    }
    const adapter = createCodexBootstrapAdapter({ bunPath: '/bin/bun', serverEntry: 'server.ts', run: run as any })
    ports.ensureMcpRegistration = (stageContext) => adapter.applyMcpRegistration(stageContext)
    ports.rollbackMutation = (stageContext, mutation) => adapter.rollbackRuntimeRegistration(stageContext, mutation)
    const result = await bootstrap({
      agentId: 'stage-deadline', runtime: 'codex', home: '/tmp/stage-deadline', repoRoot: process.cwd(),
      env: { HOME: '/tmp/stage-deadline', AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: '/tmp/stage-deadline.db' },
    }, {
      stateStore: store,
      ports,
      run: run as any,
      uuid: () => 'stage-deadline-run',
      stageDeadlineMs: { B4_MCP_REGISTRATION: 20 },
    })

    expect(result.status).toBe('NO_GO')
    expect(result.reason_codes).toContain('NO_GO_POST_MUTATION_READBACK')
    expect(freshReadbackObserved).toBe(true)
    expect(added).toBe(false)
    const state = store.states.get('stage-deadline/bootstrap-stage-deadline-run')!
    const mutation = state.mutations.find((entry) => entry.kind === 'mcp_registration')!
    expect(mutation.actual_after_digest).toBeString()
    expect(mutation.rollback_status).toBe('verified')
    expect(mutation.rollback_payload?.rollback_disposition).toBe('verified_after_failed_command')
    expect(Date.parse(state.lock_release_authorized_at!)).toBeGreaterThanOrEqual(
      Date.parse(String(mutation.rollback_payload?.rollback_completed_at)),
    )
    expect(Date.parse(state.lock_released_at!)).toBeGreaterThanOrEqual(Date.parse(state.lock_release_authorized_at!))
  })

  test('unresolved stage-deadline mutation is durably recovery-required before lock release', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    ports.ensureMcpRegistration = async (stageContext) => {
      await new Promise<void>((resolve) => {
        if (stageContext.abortSignal?.aborted) resolve()
        else stageContext.abortSignal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return {
        ok: false,
        reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
        evidenceRefs: ['provider-target-readback-unresolved'],
        mutation: {
          kind: 'mcp_registration', owner_key: `codex:aun:${stageContext.runId}`,
          before_digest: 'absent', intended_after_digest: 'expected-tuple', actual_after_digest: null,
          rollback_action: 'remove and verify native absence',
          rollback_payload: { created_by_run: true, recovery_required: true, target_readback_unresolved: true },
        },
      }
    }
    ports.rollbackMutation = async () => ({
      ok: false,
      reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'],
      evidenceRefs: ['provider-rollback-readback-unresolved'],
    })
    const result = await bootstrap({
      agentId: 'stage-deadline-unresolved', runtime: 'codex', home: '/tmp/stage-deadline-unresolved',
      repoRoot: process.cwd(), env: { HOME: '/tmp/stage-deadline-unresolved' },
    }, {
      stateStore: store,
      ports,
      run: fakeRun(),
      uuid: () => 'stage-deadline-unresolved-run',
      stageDeadlineMs: { B4_MCP_REGISTRATION: 10 },
    })

    expect(result.status).toBe('NO_GO')
    expect(result.reason_codes).toContain('NO_GO_POST_MUTATION_READBACK')
    const state = store.states.get('stage-deadline-unresolved/bootstrap-stage-deadline-unresolved-run')!
    const mutation = state.mutations.find((entry) => entry.kind === 'mcp_registration')!
    expect(mutation.actual_after_digest).toBeNull()
    expect(mutation.rollback_status).toBe('failed')
    expect(mutation.rollback_payload).toMatchObject({
      recovery_required: true,
      target_readback_unresolved: true,
      rollback_disposition: 'recovery_required_after_failed_command',
    })
    expect(mutation.rollback_payload?.rollback_completed_at).toBeString()
    expect(Date.parse(state.lock_release_authorized_at!)).toBeGreaterThanOrEqual(
      Date.parse(String(mutation.rollback_payload?.rollback_completed_at)),
    )
    expect(Date.parse(state.lock_released_at!)).toBeGreaterThanOrEqual(Date.parse(state.lock_release_authorized_at!))
  })

  test('rollback executes only recorded mutations in reverse order', async () => {
    const store = new MemoryBootstrapStateStore()
    const rollbackOrder: string[] = []
    const ports = passingPorts()
    ports.migrateDatabase = async () => ({ ok: true, mutation: {
      kind: 'db', owner_key: 'db:owned', before_digest: 'before-db', intended_after_digest: 'after-db', actual_after_digest: 'after-db', rollback_action: 'restore-db',
    } })
    ports.ensureAgentProfile = async () => ({ ok: true, mutation: {
      kind: 'profile', owner_key: 'profile:owned', before_digest: 'before-profile', intended_after_digest: 'after-profile', actual_after_digest: 'after-profile', rollback_action: 'restore-profile',
    } })
    ports.ensureMcpRegistration = async () => ({ ok: false, reasonCodes: ['NO_GO_MCP_REGISTRATION'] })
    ports.rollbackMutation = async (_context, mutation) => {
      rollbackOrder.push(mutation.kind)
      return { ok: true, readbackDigest: `restored:${mutation.kind}` }
    }
    const input = { agentId: 'rollback-agent', runtime: 'codex' as const, home: '/tmp/rollback-agent', repoRoot: process.cwd(), env: { HOME: '/tmp/rollback-agent' } }
    const failed = await bootstrap(input, { stateStore: store, ports, run: fakeRun() })
    const rolledBack = await bootstrap({ ...input, rollbackRunId: failed.run_id }, { stateStore: store, ports, run: fakeRun() })
    expect(rolledBack.status).toBe('ROLLED_BACK')
    expect(rollbackOrder).toEqual(['profile', 'db'])
  })

  test('same-agent concurrent run fails closed with NO_GO_BOOTSTRAP_BUSY', async () => {
    const store = new MemoryBootstrapStateStore()
    store.acquireLock('busy-agent', 'existing-run')
    const result = await bootstrap({
      agentId: 'busy-agent', runtime: 'codex', home: '/tmp/busy-agent', repoRoot: process.cwd(), env: { HOME: '/tmp/busy-agent' },
    }, { stateStore: store, ports: passingPorts(), run: fakeRun() })
    expect(result.status).toBe('NO_GO')
    expect(result.reason_codes).toEqual(['NO_GO_BOOTSTRAP_BUSY'])
    const loserState = store.states.get(`busy-agent/${result.run_id}`)
    expect(loserState).toMatchObject({ run_id: result.run_id, terminal_status: null })
    expect(loserState?.mutations).toEqual([])
    store.releaseLock('busy-agent', 'existing-run')
  })
})
