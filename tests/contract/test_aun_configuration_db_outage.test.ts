import { expect, test } from 'bun:test'
import { AunConfigurationReconciler } from '../../core/aun-configuration-reconciler'
import { FakeLease, FakeProjection, FakeStore } from '../aun-configuration-reconciler.test'

test('DB outage keeps last-known-good and cannot mutate or claim READY', async () => {
  const store = new FakeStore()
  store.unavailable = true
  const port = new FakeProjection()
  const results = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).sweepOnce()
  expect(results[0]).toMatchObject({
    status: 'DEGRADED_DB_UNAVAILABLE', applyCount: 0, eventDelivered: false, freshNativeReadback: false,
  })
  expect(port.applyCalls).toBe(0)
  expect(port.rollbackCalls).toBe(0)
})
