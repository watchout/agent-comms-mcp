import { expect, test } from 'bun:test'
import {
  AunConfigurationReconciler,
  configurationEffectAuthorizationDigest,
} from '../../core/aun-configuration-reconciler'
import {
  claudeNativeMcpAbsent,
  codexNativeMcpAbsent,
  launchctlEnvironment,
  nativeReleaseIdentityMatches,
  runtimeRegistrationRowsMatch,
} from '../../bin/state-daemon'
import { candidateFixture, desiredFixture, FakeLease, FakeProjection, FakeStore } from '../aun-configuration-reconciler.test'

test('manual projection tamper is detected and never back-propagates to DB desired state', async () => {
  const store = new FakeStore()
  store.dueAgentIds = ['misell']
  const original = structuredClone(store.desired)
  const port = new FakeProjection()
  port.applyFenced = async (_candidate, authorization) => {
    port.applyCalls++
    return {
      ok: true, mutated: false, partial: false,
      authorizationDigest: configurationEffectAuthorizationDigest(authorization),
      fenceVerifiedAtCommit: await authorization.verifyCurrent(),
    }
  }
  const [result] = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).sweepOnce()
  expect(result.status).toBe('DRIFTED')
  expect(store.observed?.reconcileStatus).toBe('DRIFTED')
  expect(store.desired).toEqual(original)
  expect(store.observed?.reconcileStatus).not.toBe('READY')
})

test('launchctl native readback extracts only the exact candidate environment keys', () => {
  const output = `pid = 4242
DATABASE_URL => postgresql:///fixture
STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED => 1
UNRELATED_VALUE => must-not-enter-candidate-readback
`
  expect(launchctlEnvironment(output, [
    'DATABASE_URL',
    'STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED',
  ])).toEqual({
    DATABASE_URL: 'postgresql:///fixture',
    STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED: '1',
  })
})

test('runtime native readback requires the exact active primary workspace projection', () => {
  const store = new FakeStore()
  const candidate = candidateFixture(store.desired, true)
  const exact = [{ runtime_engine: 'codex', port: 8810, status: 'active', local_path: '/srv/misell' }]
  expect(runtimeRegistrationRowsMatch(exact, candidate)).toBe(true)
  expect(runtimeRegistrationRowsMatch([{ ...exact[0], local_path: '/srv/other' }], candidate)).toBe(false)
  expect(runtimeRegistrationRowsMatch([...exact, exact[0]], candidate)).toBe(false)

  const disabled = candidateFixture(desiredFixture(2, { profileEnabled: false }), true)
  expect(runtimeRegistrationRowsMatch([], disabled)).toBe(true)
  expect(runtimeRegistrationRowsMatch(exact, disabled)).toBe(false)
})

test('disabled provider readback requires exact native get and list absence', () => {
  const absent = { exitCode: 1, stdout: '', stderr: 'No MCP server named aun' }
  const codexList = { exitCode: 0, stdout: JSON.stringify([{ name: 'other', enabled: true }]), stderr: '' }
  expect(codexNativeMcpAbsent(absent, codexList, 'aun')).toBe(true)
  expect(codexNativeMcpAbsent(absent, { ...codexList, stdout: JSON.stringify([{ name: 'aun' }]) }, 'aun')).toBe(false)
  expect(codexNativeMcpAbsent({ ...absent, stderr: 'provider unavailable' }, codexList, 'aun')).toBe(false)

  const claudeList = { exitCode: 0, stdout: 'other: Connected\n', stderr: '' }
  expect(claudeNativeMcpAbsent(absent, claudeList, 'aun')).toBe(true)
  expect(claudeNativeMcpAbsent(absent, { ...claudeList, stdout: 'aun: Connected\n' }, 'aun')).toBe(false)
  expect(claudeNativeMcpAbsent(absent, { ...claudeList, exitCode: 1 }, 'aun')).toBe(false)
})

test('native release readback requires exact commit, tree, and a clean checkout', () => {
  const candidate = candidateFixture(new FakeStore().desired, true)
  const exact = { commit: candidate.releaseCommit, tree: candidate.releaseTree, clean: true }
  expect(nativeReleaseIdentityMatches(exact, candidate)).toBe(true)
  expect(nativeReleaseIdentityMatches({ ...exact, commit: '1'.repeat(40) }, candidate)).toBe(false)
  expect(nativeReleaseIdentityMatches({ ...exact, tree: '2'.repeat(40) }, candidate)).toBe(false)
  expect(nativeReleaseIdentityMatches({ ...exact, clean: false }, candidate)).toBe(false)
})
