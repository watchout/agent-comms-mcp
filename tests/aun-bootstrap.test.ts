import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, bootstrapInternal } from '../bin/aun/bootstrap'
import type {
  BootstrapExecutionPorts,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from '../bin/aun/bootstrap-types'
import { MemoryBootstrapStateStore } from '../core/aun-bootstrap-state'
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

  test('a failed memory predicate is exact resumable NO_GO, never READY', async () => {
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
    expect(result.next_action.deliver_via).toContain(`--resume ${result.run_id}`)
  })

  test('resume accepts the resolved provider and reruns only safety preflight plus incomplete stages', async () => {
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
    expect(resumed.status).toBe('READY')
    expect(calls).toEqual([
      'B0', 'B1',
      'R:B2_DB_MIGRATION', 'R:B3_AGENT_PROFILE', 'R:B4_MCP_REGISTRATION',
      'B5', 'B6', 'B7', 'B8',
    ])
  })

  test('resume digest fences database endpoint, AUN state root, workspace, and selected provider inputs', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    ports.ensureMemoryReadiness = async () => ({ ok: false, reasonCodes: ['NO_GO_MEMORY_RECOVERY'] })
    const base = {
      agentId: 'resume-fence', runtime: 'codex' as const, home: '/tmp/resume-fence', repoRoot: process.cwd(),
      workspaceRoot: '/tmp/workspace-a', env: { HOME: '/tmp/resume-fence', AUN_HOME: '/tmp/aun-a', DATABASE_URL: 'postgresql:///a' },
    }
    const first = await bootstrap(base, { stateStore: store, ports, run: fakeRun() })
    expect(first.status).toBe('NO_GO')
    for (const changed of [
      { env: { ...base.env, DATABASE_URL: 'postgresql:///b' } },
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

  test('resume revalidates provider, Wasurezu, and daemon stage seals before any later mutation', async () => {
    for (const driftStage of ['B4_MCP_REGISTRATION', 'B5_MEMORY_READINESS', 'B6_ORDINARY_DAEMON_INSTALL_START'] as const) {
      const store = new MemoryBootstrapStateStore()
      const calls: string[] = []
      const ports = passingPorts(calls)
      ports.runQueueSmoke = async () => { calls.push('B7'); return { ok: false, reasonCodes: ['NO_GO_QUEUE_NO_PROGRESS'] } }
      const input = { agentId: `resume-${driftStage.toLowerCase()}`, runtime: 'codex' as const, home: `/tmp/resume-${driftStage}`, repoRoot: process.cwd(), env: { HOME: `/tmp/resume-${driftStage}` } }
      const first = await bootstrap(input, { stateStore: store, ports, run: fakeRun() })
      expect(first.status).toBe('NO_GO')
      calls.length = 0
      ports.revalidateStage = async (context, stage) => {
        calls.push(`R:${stage}`)
        return {
          ok: true,
          readbackDigest: stage === driftStage
            ? `drift:${stage}`
            : context.priorState.stages.find((record) => record.stage === stage)?.readback_digest ?? undefined,
        }
      }
      const resumed = await bootstrap({ ...input, resumeRunId: first.run_id }, { stateStore: store, ports, run: fakeRun() })
      expect(resumed.status).toBe('NO_GO')
      expect(resumed.reason_codes).toEqual(['NO_GO_RESUME_REVALIDATION'])
      expect(calls).not.toContain('B7')
    }
  })

  test('exact unchanged resume performs every skipped-stage native readback before continuing', async () => {
    const store = new MemoryBootstrapStateStore()
    const calls: string[] = []
    const ports = passingPorts(calls)
    ports.runQueueSmoke = async () => { calls.push('B7'); return { ok: false, reasonCodes: ['NO_GO_QUEUE_NO_PROGRESS'] } }
    const input = { agentId: 'resume-all-native', runtime: 'codex' as const, home: '/tmp/resume-all-native', repoRoot: process.cwd(), env: { HOME: '/tmp/resume-all-native' } }
    const first = await bootstrap(input, { stateStore: store, ports, run: fakeRun() })
    expect(first.status).toBe('NO_GO')
    calls.length = 0
    ports.runQueueSmoke = async () => { calls.push('B7'); return { ok: true, readbackDigest: 'queue-live' } }
    const resumed = await bootstrap({ ...input, resumeRunId: first.run_id }, { stateStore: store, ports, run: fakeRun() })
    expect(resumed.status).toBe('READY')
    expect(calls).toEqual([
      'B0', 'B1',
      'R:B2_DB_MIGRATION', 'R:B3_AGENT_PROFILE', 'R:B4_MCP_REGISTRATION',
      'R:B5_MEMORY_READINESS', 'R:B6_ORDINARY_DAEMON_INSTALL_START',
      'B7', 'B8',
    ])
  })

  test('resume rejects altered passed-stage evidence seal and provider input version drift', async () => {
    const store = new MemoryBootstrapStateStore()
    const ports = passingPorts()
    ports.runQueueSmoke = async () => ({ ok: false, reasonCodes: ['NO_GO_QUEUE_NO_PROGRESS'] })
    let providerVersion = 'codex 1.0.0'
    let wasurezuTuple = '{"tuple":"stable"}'
    const run = async (command: string, args: string[]) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return { exitCode: 0, stdout: `${HEAD}\n`, stderr: '' }
      if (command === 'codex' && args.join(' ') === '--version') return { exitCode: 0, stdout: providerVersion, stderr: '' }
      if (command === 'codex' && args.join(' ') === 'mcp get wasurezu --json') return { exitCode: 0, stdout: wasurezuTuple, stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const input = { agentId: 'resume-seal-drift', runtime: 'codex' as const, home: '/tmp/resume-seal-drift', repoRoot: process.cwd(), env: { HOME: '/tmp/resume-seal-drift' } }
    const first = await bootstrap(input, { stateStore: store, ports, run })
    const stored = store.states.get(`resume-seal-drift/${first.run_id}`)!
    stored.stages.find((record) => record.stage === 'B5_MEMORY_READINESS')!.evidence_refs.push('tampered')
    store.save(stored)
    const tampered = await bootstrap({ ...input, resumeRunId: first.run_id }, { stateStore: store, ports, run })
    expect(tampered.reason_codes).toEqual(['NO_GO_RESUME_REVALIDATION'])

    const secondStore = new MemoryBootstrapStateStore()
    const second = await bootstrap({ ...input, agentId: 'resume-version-drift' }, { stateStore: secondStore, ports, run })
    providerVersion = 'codex 2.0.0'
    const versionDrift = await bootstrap({ ...input, agentId: 'resume-version-drift', resumeRunId: second.run_id }, { stateStore: secondStore, ports, run })
    expect(versionDrift.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])

    providerVersion = 'codex 1.0.0'
    const thirdStore = new MemoryBootstrapStateStore()
    const third = await bootstrap({ ...input, agentId: 'resume-wasurezu-drift' }, { stateStore: thirdStore, ports, run })
    wasurezuTuple = '{"tuple":"changed"}'
    const wasurezuDrift = await bootstrap({ ...input, agentId: 'resume-wasurezu-drift', resumeRunId: third.run_id }, { stateStore: thirdStore, ports, run })
    expect(wasurezuDrift.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])

    wasurezuTuple = '{"tuple":"stable"}'
    const fourthStore = new MemoryBootstrapStateStore()
    const fourthInput = { ...input, agentId: 'resume-config-drift', env: { ...input.env, CODEX_HOME: '/tmp/codex-a' } }
    const fourth = await bootstrap(fourthInput, { stateStore: fourthStore, ports, run })
    const configDrift = await bootstrap({ ...fourthInput, env: { ...fourthInput.env, CODEX_HOME: '/tmp/codex-b' }, resumeRunId: fourth.run_id }, { stateStore: fourthStore, ports, run })
    expect(configDrift.reason_codes).toEqual(['NO_GO_RESUME_INPUT_MISMATCH'])
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
    store.releaseLock('busy-agent', 'existing-run')
  })
})
