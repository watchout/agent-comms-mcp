import { expect, test } from 'bun:test'
import {
  AunConfigurationReconciler,
  executeApprovedConfigurationRestart,
} from '../../core/aun-configuration-reconciler'
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

test('an exact fixture owner decision permits one fake CTO restart and exact readback', async () => {
  const candidate = candidateFixture(undefined, true)
  let restartCount = 0
  const result = await executeApprovedConfigurationRestart({
    requestId: 'request-1', candidateDigest: candidate.candidateDigest,
    rollbackArtifactDigest: candidate.rollbackArtifactDigest, restartBudget: 1,
    status: 'APPROVED', ownerDecisionRef: 'https://github.com/watchout/example/issues/1#issuecomment-1',
  }, candidate, {
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
  expect(result).toEqual({ ok: true, restartCount: 1, rollbackEvidencePresent: true, reasonCode: null })
  expect(restartCount).toBe(1)
})
