import { describe, expect, test } from 'bun:test'
import {
  AunConfigurationReconciler,
  CONFIGURATION_RECONCILER_HEARTBEAT_MS,
  configurationEffectAuthorizationDigest,
  type ConfigurationEffectAuthorization,
  type ConfigurationDesiredStateStore,
  type ConfigurationLeasePort,
  type ConfigurationProjectionPort,
  type ConfigurationProjectionReadback,
} from '../core/aun-configuration-reconciler'
import { buildAunConfigurationCandidate, type AunConfigurationCandidate } from '../core/aun-configuration-candidate'
import {
  AUN_CONFIGURATION_EVENT_TYPE,
  computeDesiredDigest,
  type AunConfigurationDesiredState,
  type AunConfigurationObservedState,
  type AunConfigurationOutboxEvent,
  type AunConfigurationRestartRequest,
} from '../core/aun-configuration-desired-state'
import type { ControlPlaneLease } from '../core/control-plane-leases'

const COMMIT = 'b09a7bd5deca0e4814d1f6e57455579ba7af2c50'
const TREE = '20fd33be3849089516655238c14fc0af6e746222'
const CONTROL = 'https://github.com/watchout/agent-comms-mcp/issues/887#issuecomment-5082585803'
const DIGEST = 'a'.repeat(64)

export function desiredFixture(revision = 1, overrides: Partial<AunConfigurationDesiredState> = {}): AunConfigurationDesiredState {
  const value = {
    agentId: 'misell', profileEnabled: true, runtimeEnginePreference: 'codex',
    canonicalWorkspace: '/srv/misell', canonicalHome: '/Users/misell', channelPort: 8810,
    supervisorIdentity: 'launchd:com.agent-comms.state-daemon',
    expectedProviderIdentityRef: 'agent-profile:misell:identity', providerTokenSourceRef: 'env:DISCORD_TOKEN',
    ordinaryCommunicationEnrollment: true, ordinaryProjection: {
      mode: 'native', provider_repo_root: '/srv/agent-comms', provider_config_root: '/Users/misell/.codex',
      daemon_checkout: '/srv/state-daemon',
    },
    desiredRevision: revision, desiredDigest: '', releaseCommit: COMMIT, releaseTree: TREE,
    controlRefs: [CONTROL], updatedAt: '2026-07-26T00:00:00Z', updatedBy: 'fixture',
    ...overrides,
  } satisfies AunConfigurationDesiredState
  value.desiredDigest = overrides.desiredDigest ?? computeDesiredDigest(value)
  return value
}

export function candidateFixture(desired = desiredFixture(), restartRequired = false): AunConfigurationCandidate {
  return buildAunConfigurationCandidate({
    hostId: 'host-a', desired,
    externalRoot: {
      databaseLocatorRef: 'env:DATABASE_URL', databaseCredentialRef: 'env:DATABASE_URL',
      releaseCommit: COMMIT, releaseTree: TREE, controlRefs: [CONTROL],
    },
    providerMcp: {
      enabled: desired.profileEnabled && desired.ordinaryCommunicationEnrollment,
      expectedProviderIdentityRef: desired.expectedProviderIdentityRef,
      providerTokenSourceRef: desired.providerTokenSourceRef,
      provider: 'codex', providerHome: desired.canonicalHome, providerConfigRoot: '/Users/misell/.codex',
      checkoutRoot: '/srv/agent-comms', serverName: 'aun', command: '/bin/bun',
      args: ['run', '--cwd', '/srv/agent-comms', 'server.ts'],
      environmentRefs: {
        DATABASE_URL: 'env:DATABASE_URL',
        AGENT_COM_EXPECTED_PROVIDER_IDENTITY_REF: desired.expectedProviderIdentityRef,
        ...(desired.providerTokenSourceRef
          ? { AGENT_COM_PROVIDER_TOKEN_SOURCE_REF: desired.providerTokenSourceRef }
          : {}),
      }, databaseLocatorRef: 'env:DATABASE_URL',
    },
    launchAgent: {
      label: 'com.agent-comms.state-daemon', programArguments: ['/bin/bun', 'bin/state-daemon.ts'],
      workingDirectory: '/srv/misell', environmentRefs: { DATABASE_URL: 'env:DATABASE_URL' },
      databaseLocatorRef: 'env:DATABASE_URL',
    },
    runtimeRegistration: {
      enabled: desired.profileEnabled && desired.ordinaryCommunicationEnrollment,
      agentId: desired.agentId, runtimeEngine: desired.runtimeEnginePreference,
      workspace: desired.canonicalWorkspace, channelPort: desired.channelPort,
      supervisorIdentity: desired.supervisorIdentity,
    },
    rollback: { providerMcp: null, launchAgent: null, runtimeRegistration: null },
    restartRequired,
  })
}

export function eventFixture(desired = desiredFixture()): AunConfigurationOutboxEvent {
  return {
    eventId: `event-${desired.desiredRevision}`, agentId: desired.agentId,
    desiredRevision: desired.desiredRevision, desiredDigest: desired.desiredDigest,
    eventType: AUN_CONFIGURATION_EVENT_TYPE, createdAt: new Date(), attemptCount: 0,
    availableAt: new Date(), deliveredAt: null,
  }
}

export class FakeStore implements ConfigurationDesiredStateStore {
  desired: AunConfigurationDesiredState
  desiredReads: AunConfigurationDesiredState[] = []
  events: AunConfigurationOutboxEvent[] = []
  dueAgentIds: string[] = []
  observed: AunConfigurationObservedState | null = null
  restarts: AunConfigurationRestartRequest[] = []
  delivered: string[] = []
  unavailable = false

  constructor(desired = desiredFixture()) { this.desired = desired }
  async readDesired(): Promise<AunConfigurationDesiredState | null> {
    if (this.unavailable) throw new Error('DB unavailable')
    return this.desiredReads.shift() ?? this.desired
  }
  async listPendingEvents(): Promise<AunConfigurationOutboxEvent[]> {
    if (this.unavailable) throw new Error('DB unavailable')
    return [...this.events]
  }
  async listDueDesiredAgents(): Promise<string[]> {
    if (this.unavailable) throw new Error('DB unavailable')
    return [...this.dueAgentIds]
  }
  async markEventDelivered(event: AunConfigurationOutboxEvent): Promise<boolean> {
    this.delivered.push(event.eventId)
    this.events = this.events.filter((value) => value.eventId !== event.eventId)
    return true
  }
  async readObserved(): Promise<AunConfigurationObservedState | null> { return this.observed }
  async recordObserved(value: AunConfigurationObservedState): Promise<boolean> { this.observed = value; return true }
  async createRestartRequest(input: AunConfigurationRestartRequest): Promise<string> {
    this.restarts.push(input)
    return `restart-${input.toRevision}`
  }
}

export class FakeLease implements ConfigurationLeasePort {
  verifyCalls = 0
  heartbeatCalls = 0
  valid = true
  lease: ControlPlaneLease = {
    lease_id: '11111111-1111-4111-8111-111111111111', lease_scope_type: 'runtime_instance',
    lease_scope_id: 'configuration-reconciler:host-a', lease_purpose: 'maintenance',
    holder_agent_id: 'codex-aun', holder_runtime_instance_id: null, holder_connector_instance_id: null,
    fencing_token: 1, status: 'active', acquired_at: new Date(), heartbeat_at: new Date(),
    expires_at: new Date(Date.now() + 45_000), released_at: null, metadata: {},
  }
  async acquire(): Promise<ControlPlaneLease | null> { return this.lease }
  async heartbeat(): Promise<boolean> { this.heartbeatCalls++; return this.valid }
  async verify(): Promise<boolean> { this.verifyCalls++; return this.valid }
  async release(): Promise<void> {}
}

export class FakeProjection implements ConfigurationProjectionPort {
  restartRequired = false
  readbackMatches = false
  applyCalls = 0
  readbackCalls = 0
  rollbackCalls = 0
  committedMutations = 0
  applyResult = { ok: true, mutated: true, partial: false }
  rollbackResult = { ok: true }
  renderDelay: Promise<void> | null = null
  beforeApplyCommit: ((authorization: ConfigurationEffectAuthorization) => void | Promise<void>) | null = null
  beforeRollbackCommit: ((authorization: ConfigurationEffectAuthorization) => void | Promise<void>) | null = null

  async render({ desired }: { hostId: string; desired: AunConfigurationDesiredState }) {
    if (this.renderDelay) await this.renderDelay
    return candidateFixture(desired, this.restartRequired)
  }
  async validate() { return { ok: true, reasonCodes: [] } }
  async applyFenced(_candidate: AunConfigurationCandidate, authorization: ConfigurationEffectAuthorization) {
    this.applyCalls++
    await this.beforeApplyCommit?.(authorization)
    const fenceVerifiedAtCommit = await authorization.verifyCurrent()
    if (!fenceVerifiedAtCommit) {
      return {
        ok: false, mutated: false, partial: false, reasonCode: 'ADAPTER_EFFECT_FENCE_REJECTED',
        authorizationDigest: configurationEffectAuthorizationDigest(authorization),
        fenceVerifiedAtCommit,
      }
    }
    if (this.applyResult.mutated) this.committedMutations++
    this.readbackMatches = this.applyResult.ok
    return {
      ...this.applyResult,
      authorizationDigest: configurationEffectAuthorizationDigest(authorization),
      fenceVerifiedAtCommit,
    }
  }
  async readback(): Promise<ConfigurationProjectionReadback> {
    this.readbackCalls++
    return {
      matchesCandidate: this.readbackMatches,
      providerNativeDigest: DIGEST, launchagentPlistDigest: DIGEST,
      launchctlEnvironmentDigest: DIGEST, runtimeIdentityDigest: DIGEST,
      driftReasonCodes: this.readbackMatches ? [] : ['FIXTURE_DRIFT'],
    }
  }
  async rollbackFenced(_candidate: AunConfigurationCandidate, authorization: ConfigurationEffectAuthorization) {
    this.rollbackCalls++
    await this.beforeRollbackCommit?.(authorization)
    const fenceVerifiedAtCommit = await authorization.verifyCurrent()
    if (fenceVerifiedAtCommit && this.rollbackResult.ok && this.committedMutations > 0) this.committedMutations--
    return {
      ...this.rollbackResult,
      authorizationDigest: configurationEffectAuthorizationDigest(authorization),
      fenceVerifiedAtCommit,
    }
  }
}

describe('AUN configuration reconciler', () => {
  test('applies one unprotected candidate and requires exact native readback before READY', async () => {
    const store = new FakeStore()
    const event = eventFixture(store.desired)
    const lease = new FakeLease()
    const port = new FakeProjection()
    const result = await new AunConfigurationReconciler('host-a', store, lease, port).reconcileAgent('misell', event)
    expect(result).toMatchObject({ status: 'READY', applyCount: 1, eventDelivered: true, freshNativeReadback: true })
    expect(port.applyCalls).toBe(1)
    expect(port.readbackCalls).toBe(2)
    expect(lease.verifyCalls).toBe(4)
    expect(store.observed?.observedRevision).toBe(1)
  })

  test('an equal second run performs zero mutations and still fresh-readbacks', async () => {
    const store = new FakeStore()
    const port = new FakeProjection()
    port.readbackMatches = true
    const result = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).reconcileAgent('misell')
    expect(result).toMatchObject({ status: 'READY', applyCount: 0, freshNativeReadback: true })
    expect(port.applyCalls).toBe(0)
    expect(port.readbackCalls).toBe(1)
  })

  test('discards a stale candidate before any apply', async () => {
    const store = new FakeStore()
    store.desiredReads = [desiredFixture(1), desiredFixture(2)]
    const port = new FakeProjection()
    const result = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port)
      .reconcileAgent('misell', eventFixture(desiredFixture(1)))
    expect(result.status).toBe('NO_GO_STALE_CANDIDATE')
    expect(result.applyCount).toBe(0)
    expect(port.applyCalls).toBe(0)
  })

  test('lease loss inside a successful adapter call rejects the effect before commit', async () => {
    const store = new FakeStore()
    const lease = new FakeLease()
    const port = new FakeProjection()
    port.beforeApplyCommit = () => { lease.valid = false }
    const result = await new AunConfigurationReconciler('host-a', store, lease, port).reconcileAgent('misell')
    expect(result).toMatchObject({
      status: 'NO_GO_STALE_CANDIDATE', applyCount: 0,
      reasonCodes: ['ADAPTER_EFFECT_FENCE_REJECTED'],
    })
    expect(port.applyCalls).toBe(1)
    expect(port.committedMutations).toBe(0)
    expect(port.rollbackCalls).toBe(0)
  })

  test('lease loss inside a partial adapter call cannot commit or invoke stale rollback', async () => {
    const store = new FakeStore()
    const lease = new FakeLease()
    const port = new FakeProjection()
    port.applyResult = { ok: false, mutated: true, partial: true, reasonCode: 'PARTIAL' }
    port.beforeApplyCommit = () => { lease.valid = false }
    const result = await new AunConfigurationReconciler('host-a', store, lease, port).reconcileAgent('misell')
    expect(result).toMatchObject({
      status: 'NO_GO_STALE_CANDIDATE', applyCount: 0,
      reasonCodes: ['ADAPTER_EFFECT_FENCE_REJECTED'],
    })
    expect(port.committedMutations).toBe(0)
    expect(port.rollbackCalls).toBe(0)
  })

  test('never closes an outbox event when the stale observed receipt is fence-rejected', async () => {
    const store = new FakeStore()
    const event = eventFixture(store.desired)
    store.desiredReads = [desiredFixture(1), desiredFixture(2)]
    store.recordObserved = async () => false
    const result = await new AunConfigurationReconciler('host-a', store, new FakeLease(), new FakeProjection())
      .reconcileAgent('misell', event)
    expect(result).toMatchObject({ status: 'NO_GO_STALE_CANDIDATE', eventDelivered: false })
    expect(result.reasonCodes).toEqual(['OBSERVED_FENCE_REJECTED'])
    expect(store.delivered).toEqual([])
  })

  test('a failed candidate render stays undelivered and does not reject the sweep', async () => {
    const store = new FakeStore()
    const event = eventFixture(store.desired)
    store.events = [event]
    const port = new FakeProjection()
    port.render = async () => { throw new Error('synthetic raw detail must not escape') }
    const results = await new AunConfigurationReconciler('host-a', store, new FakeLease(), port).sweepOnce()
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      status: 'DRIFTED', eventDelivered: false,
    })
    expect(results[0].reasonCodes[0]).toBe('RECONCILE_ERROR')
    expect(results[0].reasonCodes[1]).toMatch(/^ERROR_DIGEST:[0-9a-f]{64}$/)
    expect(JSON.stringify(results)).not.toContain('synthetic raw detail')
    expect(store.delivered).toEqual([])
  })

  test('partial apply and rollback failure fail closed with no automatic retry', async () => {
    const store = new FakeStore()
    const event = eventFixture(store.desired)
    store.events = [event]
    const port = new FakeProjection()
    port.applyResult = { ok: false, mutated: true, partial: true, reasonCode: 'PARTIAL' }
    port.rollbackResult = { ok: false, reasonCode: 'ROLLBACK_FAILED' }
    const reconciler = new AunConfigurationReconciler('host-a', store, new FakeLease(), port)
    const result = await reconciler.reconcileAgent('misell', event)
    expect(result.status).toBe('NO_GO_ROLLBACK')
    expect(result.eventDelivered).toBe(true)
    expect(port.applyCalls).toBe(1)
    expect(port.rollbackCalls).toBe(1)
    expect(store.delivered).toEqual([event.eventId])
    expect(await reconciler.sweepOnce()).toEqual([])
    expect(port.applyCalls).toBe(1)
  })

  test('coalesces concurrent same-key work into one apply', async () => {
    const store = new FakeStore()
    const port = new FakeProjection()
    let release!: () => void
    port.renderDelay = new Promise<void>((resolve) => { release = resolve })
    const reconciler = new AunConfigurationReconciler('host-a', store, new FakeLease(), port)
    const first = reconciler.reconcileAgent('misell')
    const second = reconciler.reconcileAgent('misell')
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(port.applyCalls).toBe(1)
  })

  test('heartbeats an in-flight reconciliation at the sealed 15-second target', async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    let scheduledMs = 0
    let tick: (() => void) | null = null
    let cleared = false
    globalThis.setInterval = ((callback: TimerHandler, timeout?: number) => {
      scheduledMs = Number(timeout)
      tick = () => { if (typeof callback === 'function') callback() }
      return 887 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => { cleared = true }) as typeof clearInterval
    try {
      const lease = new FakeLease()
      const port = new FakeProjection()
      let release!: () => void
      port.renderDelay = new Promise<void>((resolve) => { release = resolve })
      const running = new AunConfigurationReconciler('host-a', new FakeStore(), lease, port).reconcileAgent('misell')
      for (let attempt = 0; attempt < 5 && !tick; attempt++) await Promise.resolve()
      expect(scheduledMs).toBe(CONFIGURATION_RECONCILER_HEARTBEAT_MS)
      tick?.()
      await Promise.resolve()
      expect(lease.heartbeatCalls).toBe(1)
      release()
      expect((await running).status).toBe('READY')
      expect(cleared).toBe(true)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })
})
