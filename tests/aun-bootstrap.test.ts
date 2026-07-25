import { describe, expect, test } from 'bun:test'
import { bootstrap } from '../bin/aun/bootstrap'
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
    rollbackMutation: pass('rollback', { ok: true }),
  }
}

describe('aun bootstrap B0-B8 state machine', () => {
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
    expect(calls).toEqual(['B0', 'B1', 'B5', 'B6', 'B7', 'B8'])
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
    ports.rollbackMutation = async (_context, mutation) => { rollbackOrder.push(mutation.kind); return { ok: true } }
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
