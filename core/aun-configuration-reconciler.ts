import {
  acquireControlPlaneLease,
  heartbeatControlPlaneLease,
  releaseControlPlaneLease,
  verifyControlPlaneFence,
  type ControlPlaneLease,
} from './control-plane-leases'
import type { DbAdapter } from './db'
import {
  AUN_CONFIGURATION_NOTIFY_CHANNEL,
  claimApprovedConfigurationRestartExecution,
  completeConfigurationRestartExecution,
  configurationDigest,
  createConfigurationRestartRequest,
  listPendingConfigurationEvents,
  markConfigurationEventDelivered,
  readConfigurationDesiredState,
  recordConfigurationObservedState,
  verifyConfigurationRestartExecutionClaim,
  type AunConfigurationDesiredState,
  type AunConfigurationObservedState,
  type AunConfigurationOutboxEvent,
  type AunConfigurationRestartRequest,
  type AunConfigurationRestartExecutionClaimInput,
  type AunConfigurationRestartExecutionRecord,
  type AunConfigurationStatus,
} from './aun-configuration-desired-state'
import type { AunConfigurationCandidate } from './aun-configuration-candidate'

export const CONFIGURATION_RECONCILER_LEASE_TTL_MS = 45_000
export const CONFIGURATION_RECONCILER_HEARTBEAT_MS = 15_000
export const CONFIGURATION_RECONCILER_SWEEP_MS = 30_000
export const CONFIGURATION_RECONCILER_NOTIFICATION_LOSS_DEADLINE_MS = 60_000
export const CONFIGURATION_RECONCILER_BATCH_LIMIT = 100

export interface ConfigurationProjectionReadback {
  matchesCandidate: boolean
  providerNativeDigest: string
  launchagentPlistDigest: string
  launchctlEnvironmentDigest: string
  runtimeIdentityDigest: string
  driftReasonCodes: string[]
}

export interface ConfigurationApplyResult {
  ok: boolean
  mutated: boolean
  partial: boolean
  authorizationDigest: string
  fenceVerifiedAtCommit: boolean
  reasonCode?: string
}

export interface ConfigurationRollbackResult {
  ok: boolean
  authorizationDigest: string
  fenceVerifiedAtCommit: boolean
  reasonCode?: string
}

export interface ConfigurationEffectAuthorization {
  hostId: string
  agentId: string
  desiredRevision: number
  desiredDigest: string
  leaseId: string
  fencingToken: number
  verifyCurrent(): Promise<boolean>
}

export function configurationEffectAuthorizationDigest(
  authorization: Omit<ConfigurationEffectAuthorization, 'verifyCurrent'> | ConfigurationEffectAuthorization,
): string {
  const { verifyCurrent: _verifyCurrent, ...binding } = authorization as ConfigurationEffectAuthorization
  return configurationDigest(binding)
}

export interface ConfigurationProjectionPort {
  render(input: {
    hostId: string
    desired: AunConfigurationDesiredState
  }): Promise<AunConfigurationCandidate>
  validate(candidate: AunConfigurationCandidate): Promise<{ ok: boolean; reasonCodes: string[] }>
  applyFenced(
    candidate: AunConfigurationCandidate,
    authorization: ConfigurationEffectAuthorization,
  ): Promise<ConfigurationApplyResult>
  readback(candidate: AunConfigurationCandidate): Promise<ConfigurationProjectionReadback>
  rollbackFenced(
    candidate: AunConfigurationCandidate,
    authorization: ConfigurationEffectAuthorization,
  ): Promise<ConfigurationRollbackResult>
}

export interface ConfigurationDesiredStateStore {
  readDesired(agentId: string): Promise<AunConfigurationDesiredState | null>
  listPendingEvents(limit: number): Promise<AunConfigurationOutboxEvent[]>
  listDueDesiredAgents(hostId: string, limit: number, minObservedAgeMs: number): Promise<string[]>
  markEventDelivered(event: AunConfigurationOutboxEvent): Promise<boolean>
  readObserved(hostId: string, agentId: string): Promise<AunConfigurationObservedState | null>
  recordObserved(state: AunConfigurationObservedState): Promise<boolean>
  createRestartRequest(input: AunConfigurationRestartRequest): Promise<string>
  listen?(callback: (event: { agentId: string; desiredRevision: number; desiredDigest: string }) => void): Promise<void>
  unlisten?(): Promise<void>
}

export interface ConfigurationLeasePort {
  acquire(hostId: string): Promise<ControlPlaneLease | null>
  heartbeat(lease: ControlPlaneLease): Promise<boolean>
  verify(lease: ControlPlaneLease): Promise<boolean>
  release(lease: ControlPlaneLease): Promise<void>
}

export interface ConfigurationReconcileResult {
  agentId: string
  desiredRevision: number | null
  desiredDigest: string | null
  candidateDigest: string | null
  status: AunConfigurationStatus
  applyCount: number
  restartRequestId: string | null
  reasonCodes: string[]
  eventDelivered: boolean
  freshNativeReadback: boolean
}

export interface ConfigurationRestartExecutionStore {
  claim(input: AunConfigurationRestartExecutionClaimInput): Promise<AunConfigurationRestartExecutionRecord | null>
  verify(claim: AunConfigurationRestartExecutionRecord): Promise<boolean>
  complete(
    claim: AunConfigurationRestartExecutionRecord,
    input: { status: 'EXECUTED' | 'FAILED'; terminalReceiptDigest: string; reasonCode: string | null },
  ): Promise<boolean>
}

export interface ConfigurationRestartExecutionPort {
  restartOnce(input: AunConfigurationRestartExecutionRecord): Promise<void>
  readback(candidate: AunConfigurationCandidate): Promise<ConfigurationProjectionReadback>
  rollback(candidate: AunConfigurationCandidate, claim: AunConfigurationRestartExecutionRecord): Promise<{ ok: boolean; reasonCode?: string }>
}

export class DbConfigurationRestartExecutionStore implements ConfigurationRestartExecutionStore {
  constructor(private readonly db: DbAdapter) {}
  claim(input: AunConfigurationRestartExecutionClaimInput) {
    return claimApprovedConfigurationRestartExecution(this.db, input)
  }
  verify(claim: AunConfigurationRestartExecutionRecord) {
    return verifyConfigurationRestartExecutionClaim(this.db, claim)
  }
  complete(
    claim: AunConfigurationRestartExecutionRecord,
    input: { status: 'EXECUTED' | 'FAILED'; terminalReceiptDigest: string; reasonCode: string | null },
  ) {
    return completeConfigurationRestartExecution(this.db, claim, input)
  }
}

export async function executeApprovedConfigurationRestart(
  requestId: string,
  candidate: AunConfigurationCandidate,
  execution: { lease: ControlPlaneLease; executorAgentId: string },
  store: ConfigurationRestartExecutionStore,
  port: ConfigurationRestartExecutionPort,
): Promise<{
  ok: boolean
  restartCount: number
  rollbackEvidencePresent: boolean
  terminalReceiptRecorded: boolean
  reasonCode: string | null
}> {
  const claim = await store.claim({
    requestId, hostId: candidate.hostId, agentId: candidate.agentId,
    toRevision: candidate.desiredRevision, toDigest: candidate.desiredDigest,
    candidateDigest: candidate.candidateDigest,
    rollbackArtifactDigest: candidate.rollbackArtifactDigest,
    exactReleaseCommit: candidate.releaseCommit, exactReleaseTree: candidate.releaseTree,
    exactControlRefs: candidate.controlRefs, executionLeaseId: execution.lease.lease_id,
    executionFencingToken: execution.lease.fencing_token,
    executorAgentId: execution.executorAgentId,
  })
  if (!claim) throw new Error('RESTART_EXECUTION_NOT_AUTHORIZED')

  const finish = async (
    status: 'EXECUTED' | 'FAILED',
    reasonCode: string | null,
    restartCount: number,
    rollbackEvidencePresent: boolean,
  ) => {
    const terminalReceiptDigest = configurationDigest({
      requestId: claim.requestId, executionAttempt: claim.executionAttempt,
      executionLeaseId: claim.executionLeaseId,
      executionFencingToken: claim.executionFencingToken,
      candidateDigest: claim.candidateDigest, status, reasonCode,
    })
    const terminalReceiptRecorded = await store.complete(
      claim, { status, terminalReceiptDigest, reasonCode },
    ).catch(() => false)
    return {
      ok: status === 'EXECUTED' && terminalReceiptRecorded,
      restartCount, rollbackEvidencePresent, terminalReceiptRecorded,
      reasonCode: terminalReceiptRecorded ? reasonCode : 'RESTART_TERMINAL_RECEIPT_CAS_REJECTED',
    }
  }

  if (!await store.verify(claim)) {
    return finish('FAILED', 'RESTART_EXECUTION_FENCE_REJECTED', 0, false)
  }
  try {
    await port.restartOnce(claim)
  } catch {
    return finish('FAILED', 'RESTART_EFFECT_FAILED', 1, false)
  }
  let readback: ConfigurationProjectionReadback
  try {
    readback = await port.readback(candidate)
  } catch {
    return finish('FAILED', 'RESTART_READBACK_FAILED', 1, false)
  }
  if (readback.matchesCandidate) {
    return finish('EXECUTED', null, 1, false)
  }
  if (!await store.verify(claim)) {
    return finish('FAILED', 'RESTART_READBACK_MISMATCH_ROLLBACK_NOT_AUTHORIZED', 1, false)
  }
  let rollback: { ok: boolean; reasonCode?: string }
  try {
    rollback = await port.rollback(candidate, claim)
  } catch {
    return finish('FAILED', 'ROLLBACK_FAILED', 1, true)
  }
  return finish(
    'FAILED', rollback.ok ? 'RESTART_READBACK_MISMATCH' : (rollback.reasonCode ?? 'ROLLBACK_FAILED'),
    1, true,
  )
}

function observedFrom(
  hostId: string,
  desired: AunConfigurationDesiredState,
  candidate: AunConfigurationCandidate,
  lease: ControlPlaneLease,
  readback: ConfigurationProjectionReadback,
  status: AunConfigurationStatus,
  reasonCodes: string[],
): AunConfigurationObservedState {
  return {
    hostId,
    agentId: desired.agentId,
    observedRevision: desired.desiredRevision,
    observedDesiredDigest: desired.desiredDigest,
    candidateDigest: candidate.candidateDigest,
    releaseCommit: desired.releaseCommit,
    releaseTree: desired.releaseTree,
    providerNativeDigest: readback.providerNativeDigest,
    launchagentPlistDigest: readback.launchagentPlistDigest,
    launchctlEnvironmentDigest: readback.launchctlEnvironmentDigest,
    runtimeIdentityDigest: readback.runtimeIdentityDigest,
    reconcileStatus: status,
    driftReasonCodes: [...new Set([...reasonCodes, ...readback.driftReasonCodes])].sort(),
    leaseId: lease.lease_id,
    fencingToken: lease.fencing_token,
  }
}

export class DbConfigurationDesiredStateStore implements ConfigurationDesiredStateStore {
  constructor(private readonly db: DbAdapter) {}

  readDesired(agentId: string) { return readConfigurationDesiredState(this.db, agentId) }
  listPendingEvents(limit: number) { return listPendingConfigurationEvents(this.db, limit) }
  async listDueDesiredAgents(hostId: string, limit: number, minObservedAgeMs: number): Promise<string[]> {
    const rows = await this.db.query<{ agent_id: string }>(
      `SELECT a.agent_id
         FROM agents a
         LEFT JOIN aun_configuration_observed_state o
           ON o.host_id = $1 AND o.agent_id = a.agent_id
        WHERE a.desired_revision IS NOT NULL AND a.desired_digest IS NOT NULL
          AND (o.observed_at IS NULL
            OR o.observed_at <= now() - ($3::bigint * interval '1 millisecond'))
        ORDER BY a.desired_revision ASC, a.agent_id ASC
        LIMIT $2`,
      [hostId, limit, minObservedAgeMs],
    )
    return rows.map((row) => String(row.agent_id))
  }
  markEventDelivered(event: AunConfigurationOutboxEvent) {
    return markConfigurationEventDelivered(this.db, event.eventId, event.desiredRevision, event.desiredDigest)
  }
  async readObserved(hostId: string, agentId: string): Promise<AunConfigurationObservedState | null> {
    const row = await this.db.queryOne<any>(
      `SELECT host_id, agent_id, observed_revision, observed_desired_digest, candidate_digest,
              release_commit, release_tree, provider_native_digest, launchagent_plist_digest,
              launchctl_environment_digest, runtime_identity_digest, reconcile_status,
              drift_reason_codes, lease_id, fencing_token, observed_at
         FROM aun_configuration_observed_state WHERE host_id = $1 AND agent_id = $2`,
      [hostId, agentId],
    )
    if (!row) return null
    const reasons = typeof row.drift_reason_codes === 'string'
      ? JSON.parse(row.drift_reason_codes)
      : row.drift_reason_codes
    return {
      hostId: String(row.host_id), agentId: String(row.agent_id),
      observedRevision: Number(row.observed_revision), observedDesiredDigest: String(row.observed_desired_digest),
      candidateDigest: String(row.candidate_digest), releaseCommit: String(row.release_commit),
      releaseTree: String(row.release_tree), providerNativeDigest: String(row.provider_native_digest),
      launchagentPlistDigest: String(row.launchagent_plist_digest),
      launchctlEnvironmentDigest: String(row.launchctl_environment_digest),
      runtimeIdentityDigest: String(row.runtime_identity_digest), reconcileStatus: row.reconcile_status,
      driftReasonCodes: Array.isArray(reasons) ? reasons.map(String) : [],
      leaseId: String(row.lease_id), fencingToken: Number(row.fencing_token), observedAt: row.observed_at,
    }
  }
  recordObserved(state: AunConfigurationObservedState) { return recordConfigurationObservedState(this.db, state) }
  createRestartRequest(input: AunConfigurationRestartRequest) { return createConfigurationRestartRequest(this.db, input) }
  async listen(callback: (event: { agentId: string; desiredRevision: number; desiredDigest: string }) => void): Promise<void> {
    if (!this.db.listen) return
    await this.db.listen(AUN_CONFIGURATION_NOTIFY_CHANNEL, (raw) => {
      try {
        const value = JSON.parse(raw) as Record<string, unknown>
        const desiredRevision = Number(value.desired_revision)
        const agentId = String(value.agent_id ?? '')
        const desiredDigest = String(value.desired_digest ?? '')
        if (agentId && Number.isSafeInteger(desiredRevision) && desiredRevision > 0 && /^[0-9a-f]{64}$/.test(desiredDigest)) {
          callback({ agentId, desiredRevision, desiredDigest })
        }
      } catch { /* bounded sweep is authoritative */ }
    })
  }
  async unlisten(): Promise<void> {
    await this.db.execute(`UNLISTEN ${AUN_CONFIGURATION_NOTIFY_CHANNEL}`)
  }
}

export class DbConfigurationLeasePort implements ConfigurationLeasePort {
  constructor(
    private readonly db: DbAdapter,
    private readonly holderAgentId: string,
    private readonly holderRuntimeInstanceId: string | null,
  ) {}

  async acquire(hostId: string): Promise<ControlPlaneLease | null> {
    const acquired = await acquireControlPlaneLease(this.db, {
      scopeType: 'runtime_instance',
      scopeId: `configuration-reconciler:${hostId}`,
      purpose: 'maintenance',
      ttlMs: CONFIGURATION_RECONCILER_LEASE_TTL_MS,
      holderAgentId: this.holderAgentId,
      holderRuntimeInstanceId: this.holderRuntimeInstanceId,
      metadata: { owner: 'aun-configuration-reconciler' },
    })
    return acquired.ok ? acquired.lease : null
  }

  async verify(lease: ControlPlaneLease): Promise<boolean> {
    const result = await verifyControlPlaneFence(this.db, {
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      holderAgentId: this.holderAgentId,
      holderRuntimeInstanceId: this.holderRuntimeInstanceId,
    })
    return result.ok
  }

  async heartbeat(lease: ControlPlaneLease): Promise<boolean> {
    const result = await heartbeatControlPlaneLease(this.db, {
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      ttlMs: CONFIGURATION_RECONCILER_LEASE_TTL_MS,
      holderAgentId: this.holderAgentId,
      holderRuntimeInstanceId: this.holderRuntimeInstanceId,
    })
    return result.ok
  }

  async release(lease: ControlPlaneLease): Promise<void> {
    await releaseControlPlaneLease(this.db, {
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
      holderAgentId: this.holderAgentId,
      holderRuntimeInstanceId: this.holderRuntimeInstanceId,
    })
  }
}

export class AunConfigurationReconciler {
  private interval: ReturnType<typeof setInterval> | null = null
  private started = false
  private readonly inFlight = new Map<string, Promise<ConfigurationReconcileResult>>()

  constructor(
    private readonly hostId: string,
    private readonly store: ConfigurationDesiredStateStore,
    private readonly leases: ConfigurationLeasePort,
    private readonly projections: ConfigurationProjectionPort,
  ) {
    if (!hostId.trim()) throw new Error('HOST_ID_REQUIRED')
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('CONFIGURATION_RECONCILER_ALREADY_STARTED')
    this.started = true
    await this.store.listen?.((event) => {
      if (this.started) void this.reconcileAgent(event.agentId).catch(() => {})
    })
    this.interval = setInterval(() => { void this.sweepOnce().catch(() => {}) }, CONFIGURATION_RECONCILER_SWEEP_MS)
    void this.sweepOnce().catch(() => {})
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.started = false
    await this.store.unlisten?.().catch(() => {})
    await Promise.allSettled(this.inFlight.values())
  }

  async sweepOnce(): Promise<ConfigurationReconcileResult[]> {
    let events: AunConfigurationOutboxEvent[]
    try {
      events = await this.store.listPendingEvents(CONFIGURATION_RECONCILER_BATCH_LIMIT)
    } catch {
      return [{
        agentId: '*', desiredRevision: null, desiredDigest: null, candidateDigest: null,
        status: 'DEGRADED_DB_UNAVAILABLE', applyCount: 0, restartRequestId: null,
        reasonCodes: ['DB_UNAVAILABLE'], eventDelivered: false, freshNativeReadback: false,
      }]
    }
    const results: ConfigurationReconcileResult[] = []
    const eventAgents = new Set<string>()
    for (const event of events) {
      if (results.length >= CONFIGURATION_RECONCILER_BATCH_LIMIT) break
      try {
        results.push(await this.reconcileAgent(event.agentId, event))
      } catch {
        results.push({
          agentId: event.agentId, desiredRevision: event.desiredRevision,
          desiredDigest: event.desiredDigest, candidateDigest: null, status: 'DRIFTED',
          applyCount: 0, restartRequestId: null, reasonCodes: ['RECONCILE_ATTEMPT_FAILED'],
          eventDelivered: false, freshNativeReadback: false,
        })
      }
      eventAgents.add(event.agentId)
    }
    const remaining = CONFIGURATION_RECONCILER_BATCH_LIMIT - results.length
    if (remaining > 0) {
      let dueAgents: string[]
      try {
        dueAgents = await this.store.listDueDesiredAgents(
          this.hostId, remaining, CONFIGURATION_RECONCILER_SWEEP_MS,
        )
      } catch {
        if (results.length === 0) {
          return [{
            agentId: '*', desiredRevision: null, desiredDigest: null, candidateDigest: null,
            status: 'DEGRADED_DB_UNAVAILABLE', applyCount: 0, restartRequestId: null,
            reasonCodes: ['DB_UNAVAILABLE'], eventDelivered: false, freshNativeReadback: false,
          }]
        }
        return results
      }
      for (const agentId of dueAgents) {
        if (eventAgents.has(agentId) || results.length >= CONFIGURATION_RECONCILER_BATCH_LIMIT) continue
        try {
          results.push(await this.reconcileAgent(agentId))
        } catch {
          results.push({
            agentId, desiredRevision: null, desiredDigest: null, candidateDigest: null,
            status: 'DRIFTED', applyCount: 0, restartRequestId: null,
            reasonCodes: ['RECONCILE_ATTEMPT_FAILED'], eventDelivered: false,
            freshNativeReadback: false,
          })
        }
      }
    }
    return results
  }

  reconcileAgent(agentId: string, event?: AunConfigurationOutboxEvent): Promise<ConfigurationReconcileResult> {
    const existing = this.inFlight.get(agentId)
    if (existing) return existing
    const running = this.reconcileAgentOnce(agentId, event).finally(() => this.inFlight.delete(agentId))
    this.inFlight.set(agentId, running)
    return running
  }

  private async reconcileAgentOnce(
    agentId: string,
    event?: AunConfigurationOutboxEvent,
  ): Promise<ConfigurationReconcileResult> {
    const base = (status: AunConfigurationStatus, reasonCodes: string[]): ConfigurationReconcileResult => ({
      agentId, desiredRevision: event?.desiredRevision ?? null, desiredDigest: event?.desiredDigest ?? null,
      candidateDigest: null, status, applyCount: 0, restartRequestId: null,
      reasonCodes, eventDelivered: false, freshNativeReadback: false,
    })
    const lease = await this.leases.acquire(this.hostId).catch(() => null)
    if (!lease) return base('RECONCILING', ['LEASE_UNAVAILABLE'])
    let heartbeatValid = true
    const heartbeat = setInterval(() => {
      void this.leases.heartbeat(lease)
        .then((valid) => { if (!valid) heartbeatValid = false })
        .catch(() => { heartbeatValid = false })
    }, CONFIGURATION_RECONCILER_HEARTBEAT_MS)
    const fenceValid = async (): Promise<boolean> => heartbeatValid && this.leases.verify(lease)
    try {
      const desired = await this.store.readDesired(agentId).catch(() => null)
      if (!desired) return base('DEGRADED_DB_UNAVAILABLE', ['DESIRED_STATE_UNAVAILABLE'])
      const result = base('RECONCILING', [])
      result.desiredRevision = desired.desiredRevision
      result.desiredDigest = desired.desiredDigest

      if (!await fenceValid()) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['FENCE_INVALID_BEFORE_RENDER'] }
      const candidate = await this.projections.render({ hostId: this.hostId, desired })
      result.candidateDigest = candidate.candidateDigest
      const validation = await this.projections.validate(candidate)
      if (!validation.ok) {
        const readback = await this.projections.readback(candidate)
        result.freshNativeReadback = true
        if (!await fenceValid()) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['FENCE_INVALID_BEFORE_OBSERVED'] }
        }
        const recorded = await this.store.recordObserved(observedFrom(
          this.hostId, desired, candidate, lease, readback, 'DRIFTED', validation.reasonCodes,
        ))
        if (!recorded) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
        if (event) result.eventDelivered = await this.store.markEventDelivered(event)
        return { ...result, status: 'DRIFTED', reasonCodes: validation.reasonCodes }
      }

      const current = await this.store.readDesired(agentId)
      const fenceBeforeApply = await fenceValid()
      if (!current || !fenceBeforeApply || current.desiredRevision !== desired.desiredRevision
        || current.desiredDigest !== desired.desiredDigest) {
        const readback = await this.projections.readback(candidate)
        result.freshNativeReadback = true
        const recorded = await this.store.recordObserved(observedFrom(
          this.hostId, desired, candidate, lease, readback, 'NO_GO_STALE_CANDIDATE', ['STALE_BEFORE_APPLY'],
        ))
        if (!recorded) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
        }
        if (event) result.eventDelivered = await this.store.markEventDelivered(event)
        return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['STALE_BEFORE_APPLY'] }
      }

      const before = await this.store.readObserved(this.hostId, agentId)
      const nativeBefore = await this.projections.readback(candidate)
      result.freshNativeReadback = true
      if (nativeBefore.matchesCandidate) {
        if (!await fenceValid()) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['FENCE_INVALID_BEFORE_OBSERVED'] }
        }
        const recorded = await this.store.recordObserved(observedFrom(
          this.hostId, desired, candidate, lease, nativeBefore, 'READY', [],
        ))
        if (!recorded) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
        if (event) result.eventDelivered = await this.store.markEventDelivered(event)
        return { ...result, status: 'READY', reasonCodes: [] }
      }
      if (candidate.restartRequired) {
        const restartCurrent = await this.store.readDesired(agentId).catch(() => null)
        if (!restartCurrent || !await fenceValid()
          || restartCurrent.desiredRevision !== desired.desiredRevision
          || restartCurrent.desiredDigest !== desired.desiredDigest) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['STALE_BEFORE_RESTART_REQUEST'] }
        }
        result.restartRequestId = await this.store.createRestartRequest({
          hostId: this.hostId, agentId, fromRevision: before?.observedRevision ?? null,
          fromDigest: before?.observedDesiredDigest ?? null, toRevision: desired.desiredRevision,
          toDigest: desired.desiredDigest, candidateDigest: candidate.candidateDigest,
          rollbackArtifactDigest: candidate.rollbackArtifactDigest,
          exactReleaseCommit: candidate.releaseCommit, exactReleaseTree: candidate.releaseTree,
          exactControlRefs: candidate.controlRefs, leaseId: lease.lease_id,
          fencingToken: lease.fencing_token, restartBudget: 1,
        }).catch(() => null)
        if (!result.restartRequestId) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['RESTART_REQUEST_FENCE_REJECTED'] }
        }
        if (!await fenceValid()) {
          return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['FENCE_INVALID_BEFORE_OBSERVED'] }
        }
        const recorded = await this.store.recordObserved(observedFrom(
          this.hostId, desired, candidate, lease, nativeBefore,
          'DEGRADED_APPROVAL_REQUIRED', ['PROTECTED_RESTART_REQUIRED'],
        ))
        if (!recorded) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
        if (event) result.eventDelivered = await this.store.markEventDelivered(event)
        return { ...result, status: 'DEGRADED_APPROVAL_REQUIRED', reasonCodes: ['PROTECTED_RESTART_REQUIRED'] }
      }

      const effectAuthorization: ConfigurationEffectAuthorization = {
        hostId: this.hostId, agentId, desiredRevision: desired.desiredRevision,
        desiredDigest: desired.desiredDigest, leaseId: lease.lease_id,
        fencingToken: lease.fencing_token,
        verifyCurrent: async () => {
          const effectCurrent = await this.store.readDesired(agentId).catch(() => null)
          return Boolean(effectCurrent && await fenceValid()
            && effectCurrent.desiredRevision === desired.desiredRevision
            && effectCurrent.desiredDigest === desired.desiredDigest)
        },
      }
      const expectedAuthorizationDigest = configurationEffectAuthorizationDigest(effectAuthorization)
      const receiptIsCurrent = (receipt: { authorizationDigest: string; fenceVerifiedAtCommit: boolean }) => (
        receipt.fenceVerifiedAtCommit && receipt.authorizationDigest === expectedAuthorizationDigest
      )
      const applied = await this.projections.applyFenced(candidate, effectAuthorization)
      if (!receiptIsCurrent(applied)) {
        return {
          ...result, status: 'NO_GO_STALE_CANDIDATE',
          reasonCodes: ['ADAPTER_EFFECT_FENCE_REJECTED'],
        }
      }
      if (applied.mutated) result.applyCount = 1
      if (!applied.ok) {
        let rollback: ConfigurationRollbackResult = {
          ok: true, authorizationDigest: expectedAuthorizationDigest, fenceVerifiedAtCommit: true,
        }
        if (applied.mutated) {
          if (!await effectAuthorization.verifyCurrent()) {
            return {
              ...result, status: 'NO_GO_STALE_CANDIDATE',
              reasonCodes: ['FENCE_INVALID_BEFORE_ROLLBACK'],
            }
          }
          rollback = await this.projections.rollbackFenced(candidate, effectAuthorization)
          if (!receiptIsCurrent(rollback)) {
            return {
              ...result, status: 'NO_GO_STALE_CANDIDATE',
              reasonCodes: ['ROLLBACK_EFFECT_FENCE_REJECTED'],
            }
          }
        }
        const afterFailure = await this.projections.readback(candidate)
        result.freshNativeReadback = true
        const status: AunConfigurationStatus = rollback.ok ? 'NO_GO_PARTIAL_APPLY' : 'NO_GO_ROLLBACK'
        const reasons = [applied.reasonCode ?? 'APPLY_FAILED', ...(rollback.ok ? [] : [rollback.reasonCode ?? 'ROLLBACK_FAILED'])]
        if (await fenceValid()) {
          const recorded = await this.store.recordObserved(observedFrom(
            this.hostId, desired, candidate, lease, afterFailure, status, reasons,
          ))
          if (!recorded) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
          if (event) result.eventDelivered = await this.store.markEventDelivered(event)
        }
        return { ...result, status, reasonCodes: reasons }
      }

      const nativeAfter = await this.projections.readback(candidate)
      result.freshNativeReadback = true
      const finalDesired = await this.store.readDesired(agentId)
      if (!await fenceValid() || !finalDesired
        || finalDesired.desiredRevision !== desired.desiredRevision
        || finalDesired.desiredDigest !== desired.desiredDigest) {
        return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['STALE_BEFORE_OBSERVED'] }
      }
      const finalStatus: AunConfigurationStatus = nativeAfter.matchesCandidate ? 'READY' : 'DRIFTED'
      const finalReasons = nativeAfter.matchesCandidate ? [] : ['NATIVE_READBACK_MISMATCH']
      const recorded = await this.store.recordObserved(observedFrom(
        this.hostId, desired, candidate, lease, nativeAfter, finalStatus, finalReasons,
      ))
      if (!recorded) return { ...result, status: 'NO_GO_STALE_CANDIDATE', reasonCodes: ['OBSERVED_FENCE_REJECTED'] }
      if (event) result.eventDelivered = await this.store.markEventDelivered(event)
      return { ...result, status: finalStatus, reasonCodes: finalReasons }
    } catch (error) {
      return {
        ...base('DRIFTED', ['RECONCILE_ERROR']),
        reasonCodes: ['RECONCILE_ERROR', `ERROR_DIGEST:${configurationDigest(String((error as Error).message ?? error))}`],
      }
    } finally {
      clearInterval(heartbeat)
      await this.leases.release(lease).catch(() => {})
    }
  }
}
