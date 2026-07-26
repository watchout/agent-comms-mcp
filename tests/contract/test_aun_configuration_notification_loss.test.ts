import { expect, test } from 'bun:test'
import {
  AunConfigurationReconciler,
  CONFIGURATION_RECONCILER_HEARTBEAT_MS,
  CONFIGURATION_RECONCILER_LEASE_TTL_MS,
  CONFIGURATION_RECONCILER_NOTIFICATION_LOSS_DEADLINE_MS,
  CONFIGURATION_RECONCILER_SWEEP_MS,
} from '../../core/aun-configuration-reconciler'
import { FakeLease, FakeProjection, FakeStore, eventFixture } from '../aun-configuration-reconciler.test'

test('lost notification is recovered by the bounded sweep within the sealed deadline', async () => {
  const store = new FakeStore()
  store.events = [eventFixture(store.desired)]
  const port = new FakeProjection()
  const results = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).sweepOnce()
  expect(CONFIGURATION_RECONCILER_SWEEP_MS).toBe(30_000)
  expect(CONFIGURATION_RECONCILER_HEARTBEAT_MS).toBe(15_000)
  expect(CONFIGURATION_RECONCILER_HEARTBEAT_MS * 3).toBe(CONFIGURATION_RECONCILER_LEASE_TTL_MS)
  expect(CONFIGURATION_RECONCILER_SWEEP_MS * 2).toBeLessThanOrEqual(CONFIGURATION_RECONCILER_NOTIFICATION_LOSS_DEADLINE_MS)
  expect(results).toHaveLength(1)
  expect(results[0]).toMatchObject({ status: 'READY', eventDelivered: true })
})
