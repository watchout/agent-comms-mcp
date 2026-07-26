import { expect, test } from 'bun:test'
import {
  AunConfigurationReconciler,
  executeApprovedConfigurationRestart,
  type ConfigurationRestartExecutionStore,
} from '../../core/aun-configuration-reconciler'
import type {
  AunConfigurationRestartExecutionClaimInput,
  AunConfigurationRestartExecutionRecord,
} from '../../core/aun-configuration-desired-state'
import type { ControlPlaneLease } from '../../core/control-plane-leases'
import {
  FakeLease,
  FakeProjection,
  FakeStore,
  candidateFixture,
  desiredFixture,
} from '../aun-configuration-reconciler.test'

test('restart-required reconciliation emits approval request and performs zero restart', async () => {
  const store = new FakeStore()
  const port = new FakeProjection()
  port.restartRequired = true
  const result = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).reconcileAgent('misell')
  expect(result).toMatchObject({ status: 'DEGRADED_APPROVAL_REQUIRED', applyCount: 0 })
  expect(store.restarts).toHaveLength(1)
  expect(store.restarts[0].restartBudget).toBe(1)
  expect(store.restarts[0].leaseId).toBe('11111111-1111-4111-8111-111111111111')
  expect(store.restarts[0].fencingToken).toBe(1)
  expect(store.restarts[0].status ?? 'AWAITING_OWNER_DECISION').toBe('AWAITING_OWNER_DECISION')
  expect(port.applyCalls).toBe(0)
})

test('revision drift during native readback creates no restart request', async () => {
  const store = new FakeStore()
  const port = new FakeProjection()
  port.restartRequired = true
  const originalReadback = port.readback.bind(port)
  port.readback = async () => {
    store.desired = desiredFixture(2)
    return originalReadback()
  }
  const result = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).reconcileAgent('misell')
  expect(result).toMatchObject({ status: 'NO_GO_STALE_CANDIDATE', restartRequestId: null })
  expect(result.reasonCodes).toEqual(['STALE_BEFORE_RESTART_REQUEST'])
  expect(store.restarts).toEqual([])
})

class FakeRestartExecutionStore implements ConfigurationRestartExecutionStore {
  claimable = true
  current = true
  terminalReceiptAccepted = true
  claimCount = 0
  completions: Array<{ status: 'EXECUTED' | 'FAILED'; reasonCode: string | null }> = []

  async claim(input: AunConfigurationRestartExecutionClaimInput): Promise<AunConfigurationRestartExecutionRecord | null> {
    if (!this.claimable || this.claimCount > 0) return null
    this.claimCount++
    return {
      ...input, restartBudget: 1, status: 'EXECUTING',
      ownerDecisionRef: 'https://github.com/watchout/example/issues/1#issuecomment-1',
      ownerDecisionExpiresAt: new Date(Date.now() + 60_000),
      ctoExecutionReceiptRef: 'aun:cto-execution-receipt:fixture', executionAttempt: 1,
    }
  }
  async verify(): Promise<boolean> { return this.current }
  async complete(
    _claim: AunConfigurationRestartExecutionRecord,
    input: { status: 'EXECUTED' | 'FAILED'; terminalReceiptDigest: string; reasonCode: string | null },
  ): Promise<boolean> {
    this.completions.push({ status: input.status, reasonCode: input.reasonCode })
    return this.terminalReceiptAccepted
  }
}

function ctoExecutionLease(): ControlPlaneLease {
  return {
    ...new FakeLease().lease,
    lease_scope_id: 'configuration-restart:host-a:misell',
    holder_agent_id: 'codex-cto',
  }
}

test('a durable exact CTO claim permits one fake restart and exact terminal readback', async () => {
  const candidate = candidateFixture(undefined, true)
  const store = new FakeRestartExecutionStore()
  let restartCount = 0
  const result = await executeApprovedConfigurationRestart('request-1', candidate, {
    lease: ctoExecutionLease(), executorAgentId: 'codex-cto',
  }, store, {
    async restartOnce() { restartCount++ },
    async readback() {
      return {
        matchesCandidate: true, providerNativeDigest: 'a'.repeat(64),
        launchagentPlistDigest: 'b'.repeat(64), launchctlEnvironmentDigest: 'c'.repeat(64),
        runtimeIdentityDigest: 'd'.repeat(64), driftReasonCodes: [],
      }
    },
    async rollback() { return { ok: true } },
  })
  expect(result).toEqual({
    ok: true, restartCount: 1, rollbackEvidencePresent: false,
    terminalReceiptRecorded: true, reasonCode: null,
  })
  expect(restartCount).toBe(1)
  expect(store.completions).toEqual([{ status: 'EXECUTED', reasonCode: null }])
})

test('rejected, expired, superseded, or drifted durable restart claims perform zero effects', async () => {
  const candidate = candidateFixture(undefined, true)
  for (const reason of ['REJECTED', 'EXPIRED', 'SUPERSEDED', 'DRIFTED']) {
    const store = new FakeRestartExecutionStore()
    store.claimable = false
    let restartCount = 0
    await expect(executeApprovedConfigurationRestart(`request-${reason}`, candidate, {
      lease: ctoExecutionLease(), executorAgentId: 'codex-cto',
    }, store, {
      async restartOnce() { restartCount++ },
      async readback() { throw new Error('must not read back') },
      async rollback() { throw new Error('must not roll back') },
    })).rejects.toThrow('RESTART_EXECUTION_NOT_AUTHORIZED')
    expect(restartCount).toBe(0)
  }
})

test('lease loss after durable claim records failure and performs zero restart', async () => {
  const candidate = candidateFixture(undefined, true)
  const store = new FakeRestartExecutionStore()
  store.current = false
  let restartCount = 0
  const result = await executeApprovedConfigurationRestart('request-stale', candidate, {
    lease: ctoExecutionLease(), executorAgentId: 'codex-cto',
  }, store, {
    async restartOnce() { restartCount++ },
    async readback() { throw new Error('must not read back') },
    async rollback() { throw new Error('must not roll back') },
  })
  expect(result).toMatchObject({
    ok: false, restartCount: 0, terminalReceiptRecorded: true,
    reasonCode: 'RESTART_EXECUTION_FENCE_REJECTED',
  })
  expect(restartCount).toBe(0)
})

test('terminal ACK loss cannot claim or restart the same request twice', async () => {
  const candidate = candidateFixture(undefined, true)
  const store = new FakeRestartExecutionStore()
  store.terminalReceiptAccepted = false
  let restartCount = 0
  const port = {
    async restartOnce() { restartCount++ },
    async readback() {
      return {
        matchesCandidate: true, providerNativeDigest: 'a'.repeat(64),
        launchagentPlistDigest: 'b'.repeat(64), launchctlEnvironmentDigest: 'c'.repeat(64),
        runtimeIdentityDigest: 'd'.repeat(64), driftReasonCodes: [],
      }
    },
    async rollback() { return { ok: true } },
  }
  const first = await executeApprovedConfigurationRestart('request-ack-loss', candidate, {
    lease: ctoExecutionLease(), executorAgentId: 'codex-cto',
  }, store, port)
  expect(first).toMatchObject({
    ok: false, restartCount: 1, terminalReceiptRecorded: false,
    reasonCode: 'RESTART_TERMINAL_RECEIPT_CAS_REJECTED',
  })
  await expect(executeApprovedConfigurationRestart('request-ack-loss', candidate, {
    lease: ctoExecutionLease(), executorAgentId: 'codex-cto',
  }, store, port)).rejects.toThrow('RESTART_EXECUTION_NOT_AUTHORIZED')
  expect(restartCount).toBe(1)
})
