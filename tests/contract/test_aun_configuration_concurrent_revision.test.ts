import { expect, test } from 'bun:test'
import { AunConfigurationReconciler } from '../../core/aun-configuration-reconciler'
import { FakeLease, FakeProjection, FakeStore, desiredFixture, eventFixture } from '../aun-configuration-reconciler.test'

test('an older concurrent revision cannot apply and the latest applies at most once', async () => {
  const oldDesired = desiredFixture(1)
  const latest = desiredFixture(2, { channelPort: 8811 })
  const store = new FakeStore(latest)
  store.desiredReads = [oldDesired, latest]
  const port = new FakeProjection()
  const reconciler = new AunConfigurationReconciler('host-a', store, new FakeLease(), port)
  const stale = await reconciler.reconcileAgent('misell', eventFixture(oldDesired))
  expect(stale).toMatchObject({ status: 'NO_GO_STALE_CANDIDATE', applyCount: 0 })
  const applied = await reconciler.reconcileAgent('misell', eventFixture(latest))
  expect(applied).toMatchObject({ status: 'READY', applyCount: 1 })
  expect(port.applyCalls).toBe(1)
})
