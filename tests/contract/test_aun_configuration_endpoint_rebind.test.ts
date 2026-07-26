import { expect, test } from 'bun:test'
import { buildAunConfigurationCandidate } from '../../core/aun-configuration-candidate'
import { candidateFixture, desiredFixture } from '../aun-configuration-reconciler.test'

test('DB endpoint rebind is one exact candidate and uses the protected restart gate', () => {
  const desired = desiredFixture(2)
  const old = candidateFixture(desired, true)
  const rebound = buildAunConfigurationCandidate({
    hostId: old.hostId, desired,
    externalRoot: {
      databaseLocatorRef: 'external-locator:db-v2', databaseCredentialRef: 'secret-ref:db-v2',
      releaseCommit: desired.releaseCommit, releaseTree: desired.releaseTree, controlRefs: desired.controlRefs,
    },
    providerMcp: { ...old.providerMcp, databaseLocatorRef: 'external-locator:db-v2', environmentRefs: { DATABASE_URL: 'external-locator:db-v2' } },
    launchAgent: { ...old.launchAgent, databaseLocatorRef: 'external-locator:db-v2', environmentRefs: { DATABASE_URL: 'external-locator:db-v2' } },
    runtimeRegistration: old.runtimeRegistration,
    rollback: { providerMcp: old.providerMcp, launchAgent: old.launchAgent, runtimeRegistration: old.runtimeRegistration },
    restartRequired: true,
  })
  expect(rebound.providerMcp.databaseLocatorRef).toBe(rebound.launchAgent.databaseLocatorRef)
  expect(rebound.restartRequired).toBe(true)
  expect(rebound.candidateDigest).not.toBe(old.candidateDigest)
})
