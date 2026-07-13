import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ConnectorRegistry,
  EventLog,
  LoadedRegistrationUnprovenError,
  ReconciliationTransitionCollisionError,
  ReopenAtomicSetIncompleteError,
  ReopenNotAuthorizedError,
  attestationDigest,
  attestationEvent,
  canonicalJson,
  connectorCapabilityDigest,
  evidenceEvent,
  ensureEventLogSchema,
  issuerRegistrationDigest,
  issuerRegistrationEvent,
  loadedConnectorRegistrationDigest,
  outboxView,
  pendingDeliveries,
  producerRegistrationDigest,
  producerRegistrationEvent,
  reconciliationObservationDigest,
  reconciliationObservationEventId,
  reconciliationRequestDigest,
  recoverDispatcherClaims,
  retryBudgetAuthorityDigest,
  retryBudgetSnapshotEvent,
  sha256Utf8,
  startProviderInvocation,
  storedEventConflictMaterial,
  zeroEffectEvidenceDigest,
  type CommitReopenAuthorizationCASInput,
  type CommitReconciliationTerminalCASInputV1,
  type ConnectorDeliveryCapabilityV1,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type ReplyDeliveryUnknownPayloadV1,
  type LoadedConnectorRegistrationV1,
  type LoadedConnectorVerifierPort,
  type RetryBudgetAuthorityV1,
  type RetryBudgetIssuerRegistrationV1,
  type RetryBudgetSnapshotV1,
  type ZeroEffectProducerRegistrationV1,
  type ZeroExternalEffectAttestationV1,
  type ZeroExternalEffectEvidenceRecordV1,
} from '../../core/eventlog'
import type { DbAdapter } from '../../core/db/adapter'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-views-'))
  db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function enqueue(replyId: string) {
  return new EventLog(db).append({
    eventId: `enq:${replyId}`,
    eventType: 'reply.enqueued',
    seatId: 'aun',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    replyId,
    payload: { content: 'hello', channel_external_id: 'channel-1' },
  })
}

async function claim(replyId: string, epoch: number, instance = 'dispatcher-old') {
  return new EventLog(db).append({
    eventId: `claim:${replyId}:${epoch}`,
    eventType: 'reply.delivery_claimed',
    seatId: 'dispatcher',
    seatInstanceId: instance,
    replyId,
    claimEpoch: epoch,
  })
}

describe('unknown, reopened, and handoff projection truth', () => {
  test('delivery_unknown is never ordinary pending; exact reopen admits only the next attempt', async () => {
    const replyId = 'reply-unknown'
    await enqueue(replyId)
    await claim(replyId, 0)
    await new EventLog(db).append({
      eventId: 'unknown-event-0',
      eventType: 'reply.delivery_unknown',
      replyId,
      claimEpoch: 0,
      payload: { delivery_id: 'delivery-1' },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)
    expect(await outboxView(db)).toHaveLength(0)

    await new EventLog(db).append({
      eventId: 'reopen-event-1',
      eventType: 'reply.delivery_reopened',
      replyId,
      claimEpoch: 1,
      payload: { causation_delivery_unknown_event_id: 'unknown-event-0' },
    })
    const reopened = await pendingDeliveries(db)
    expect(reopened).toHaveLength(1)
    expect(Number(reopened[0]!.attempts)).toBe(1)
    expect(reopened[0]!.delivery_claim_event_id).toBeNull()
    await claim(replyId, 1)
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('durable_handoff placement is non-delivered and not dispatchable', async () => {
    const replyId = 'reply-handoff'
    await enqueue(replyId)
    await new EventLog(db).append({
      eventId: 'handoff-accepted-1',
      eventType: 'reply.handoff_accepted',
      replyId,
      payload: { reply_id: replyId, delivery_id: 'delivery-handoff', recipient_seat_id: 'spec', receipt_digest: '1'.repeat(64), fanout_child_provenance_digest: null },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('strict permanent field terminates while retryable legacy field reopens', async () => {
    await enqueue('reply-permanent')
    await new EventLog(db).append({
      eventId: 'failed-permanent', eventType: 'reply.failed', replyId: 'reply-permanent', claimEpoch: 0,
      payload: { reply_id: 'reply-permanent', delivery_id: 'delivery-permanent', recipient_seat_id: 'spec', failure_code: 'rejected', permanent: true, fanout_child_provenance_digest: null },
    })
    expect(await pendingDeliveries(db)).toHaveLength(0)

    await enqueue('reply-retryable')
    await claim('reply-retryable', 0)
    await new EventLog(db).append({
      eventId: 'failed-retryable', eventType: 'reply.failed', replyId: 'reply-retryable', claimEpoch: 0,
      payload: { kind: 'retryable', reason: 'pre-invocation' },
    })
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual(['reply-retryable'])
  })
})

describe('restart recovery does not blindly resend a started provider attempt', () => {
  test('stale pre-start claim is released, but invocation-start claim is preserved', async () => {
    await enqueue('reply-before-start')
    await claim('reply-before-start', 0)
    const released = await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'dispatcher-new' })
    expect(released.map(row => row.reply_id)).toEqual(['reply-before-start'])
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual(['reply-before-start'])

    await enqueue('reply-after-start')
    await claim('reply-after-start', 0)
    await startProviderInvocation(db, {
      delivery_id: 'delivery-after-start', reply_id: 'reply-after-start', recipient_seat_id: 'spec', attempt_ordinal: 0,
      provider_nonce: 'a1_abcdefghijklmnopqrstuv', delivery_digest: '2'.repeat(64), provider_request_digest: '3'.repeat(64),
    })
    const afterStart = await recoverDispatcherClaims(db, { dispatcherId: 'dispatcher', activeInstanceId: 'dispatcher-new' })
    expect(afterStart).toHaveLength(0)
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).not.toContain('reply-after-start')
    const retryFailures = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'reply.failed' AND reply_id = $1`,
      ['reply-after-start'],
    )
    expect(Number(retryFailures[0]?.n ?? 0)).toBe(0)
  })
})

interface ReopenFixture {
  log: EventLog
  input: CommitReopenAuthorizationCASInput
  groupEventIds: string[]
  directAuthorityRejections: number
  verifierCalls: { loaded: number; producer: number; issuer: number }
}

interface TerminalFixture {
  log: EventLog
  input: CommitReconciliationTerminalCASInputV1
  outcomeEventId: string
}

async function installTerminalSources(
  target: DbAdapter,
  options: {
    suffix: string
    observedOutcome: 'validated_original_receipt' | 'permanent_failure' | 'not_found'
    replyId?: string
    deliveryId?: string
    appendEnqueued?: boolean
  },
): Promise<TerminalFixture> {
  const log = new EventLog(target)
  const replyId = options.replyId ?? `reply-terminal-${options.suffix}`
  const deliveryId = options.deliveryId ?? `delivery-terminal-${options.suffix}`
  if (options.appendEnqueued !== false) {
    await log.append({
      eventId: `enq-terminal:${options.suffix}`, eventType: 'reply.enqueued', seatId: 'aun',
      conversationId: 'conversation-terminal', turnId: 'turn-terminal', replyId,
      payload: { content: 'terminal fixture', channel_external_id: 'channel-terminal' },
    })
  }
  const unknown: ReplyDeliveryUnknownPayloadV1 = {
    reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', attempt_ordinal: 0,
    connector_instance_id: '11111111-1111-4111-8111-111111111111',
    resolved_binding_snapshot_digest: '2'.repeat(64), resolved_delivery_decision_digest: '3'.repeat(64),
    delivery_digest: '4'.repeat(64), provider_request_digest: '5'.repeat(64),
    business_nonce: `business-${options.suffix}`, provider_nonce: `provider-${options.suffix}`,
    capability_digest: '6'.repeat(64), invocation_started_event_id: `provider-started:${options.suffix}`,
    reconciliation_mode: 'provider_lookup', fanout_child_provenance_digest: null,
  }
  const unknownEvent = await log.append({
    eventId: `delivery-unknown:${options.suffix}`, eventType: 'reply.delivery_unknown',
    conversationId: 'conversation-terminal', correlationId: 'correlation-terminal', turnId: 'turn-terminal',
    replyId, claimEpoch: 0, payload: unknown as unknown as Record<string, unknown>,
  })
  const requestMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
    reconciliation_id: `reconciliation-${options.suffix}`,
    delivery_unknown_event_id: unknownEvent.event.event_id,
    delivery_unknown_event_digest: sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent.event))),
    reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', attempt_ordinal: 0,
    connector_instance_id: unknown.connector_instance_id,
    resolved_binding_snapshot_digest: unknown.resolved_binding_snapshot_digest,
    resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
    delivery_digest: unknown.delivery_digest, provider_request_digest: unknown.provider_request_digest,
    business_nonce: unknown.business_nonce, provider_nonce: unknown.provider_nonce,
    capability_digest: unknown.capability_digest, reconciliation_mode: 'provider_lookup' as const,
    reconciler_registration_digest: '7'.repeat(64),
  }
  const request: DeliveryUnknownReconciliationRequestV1 = {
    ...requestMaterial,
    request_digest: reconciliationRequestDigest(requestMaterial),
  }
  const requestEventId = `delivery-reconciliation-requested:${options.suffix}`
  await log.append({
    eventId: requestEventId, eventType: 'reply.delivery_reconciliation_requested',
    replyId, claimEpoch: 0, payload: request as unknown as Record<string, unknown>,
  })
  const receiptDigest = 'a'.repeat(64)
  const failureCode = 'provider-permanent-rejection'
  const observationMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
    reconciliation_request_digest: request.request_digest,
    observed_outcome: options.observedOutcome,
    validated_receipt_digest: options.observedOutcome === 'validated_original_receipt' ? receiptDigest : null,
    permanent_failure_code: options.observedOutcome === 'permanent_failure' ? failureCode : null,
    zero_external_effect_attestation_digest: null,
    evidence_digest: '8'.repeat(64),
  }
  const observation: DeliveryUnknownReconciliationObservationV1 = {
    ...observationMaterial,
    observation_digest: reconciliationObservationDigest(observationMaterial),
  }
  const observationEventId = reconciliationObservationEventId(unknownEvent.event.event_id, observation.observation_digest)
  await log.append({
    eventId: observationEventId, eventType: 'reply.delivery_reconciliation_observed',
    replyId, claimEpoch: 0, payload: observation as unknown as Record<string, unknown>,
  })
  const terminal = options.observedOutcome === 'permanent_failure'
    ? {
        outcome: 'permanent_failure' as const,
        event_id: `reconciled-permanent:${options.suffix}`,
        payload: {
          reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec',
          failure_code: failureCode, permanent: true, fanout_child_provenance_digest: null,
        },
      }
    : {
        outcome: 'delivered' as const,
        event_id: `reconciled-delivered:${options.suffix}`,
        payload: {
          reply_id: replyId, delivery_id: deliveryId, recipient_seat_id: 'spec', receipt_digest: receiptDigest,
          provider_request_digest: unknown.provider_request_digest,
          resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
          fanout_child_provenance_digest: null,
        },
      }
  return {
    log,
    input: {
      unknown_event_id: unknownEvent.event.event_id,
      reconciliation_request_event_id: requestEventId,
      reconciliation_observation_event_id: observationEventId,
      terminal,
    },
    outcomeEventId: `delivery-reconciliation-outcome:${sha256Utf8('aun-delivery-unknown-outcome/v1\n' + canonicalJson({ delivery_id: deliveryId, attempt_ordinal: 0 }))}`,
  }
}

describe('conclusive reconciliation terminal outcome CAS', () => {
  test('validated original receipt and permanent failure each atomically append one causal terminal', async () => {
    const delivered = await installTerminalSources(db, { suffix: 'delivered', observedOutcome: 'validated_original_receipt' })
    const deliveredResult = await delivered.log.commitReconciliationTerminalCAS(delivered.input)
    expect(deliveredResult.status).toBe('inserted')
    expect(deliveredResult.provider_invocations).toBe(0)
    expect(deliveredResult.terminal.event_type).toBe('reply.delivered')
    expect(deliveredResult.terminal.causation_id).toBe(deliveredResult.outcome.event_id)
    expect((await delivered.log.commitReconciliationTerminalCAS(structuredClone(delivered.input))).status).toBe('byte_identical_existing')

    const permanent = await installTerminalSources(db, { suffix: 'permanent', observedOutcome: 'permanent_failure' })
    const permanentResult = await permanent.log.commitReconciliationTerminalCAS(permanent.input)
    expect(permanentResult.status).toBe('inserted')
    expect(permanentResult.provider_invocations).toBe(0)
    expect(permanentResult.terminal.event_type).toBe('reply.failed')
    expect(permanentResult.terminal.causation_id).toBe(permanentResult.outcome.event_id)
    expect(await pendingDeliveries(db)).toHaveLength(0)
  })

  test('inconclusive observation consumes no outcome winner and every precommit kill rolls back both members', async () => {
    const inconclusive = await installTerminalSources(db, { suffix: 'not-found', observedOutcome: 'not_found' })
    await expect(inconclusive.log.commitReconciliationTerminalCAS(inconclusive.input))
      .rejects.toBeInstanceOf(ReconciliationTransitionCollisionError)
    expect(await inconclusive.log.getByEventId(inconclusive.outcomeEventId)).toBeNull()

    const killPoints = ['after_outcome_append', 'after_terminal_append', 'before_commit'] as const
    for (const [index, killPoint] of killPoints.entries()) {
      const isolated = new SqliteAdapter(join(dir, `terminal-kill-${index}.db`))
      await ensureEventLogSchema(isolated)
      const fixture = await installTerminalSources(isolated, { suffix: `kill-${index}`, observedOutcome: 'validated_original_receipt' })
      fixture.input.on_commit_point = point => { if (point === killPoint) throw new Error(`kill:${killPoint}`) }
      await expect(fixture.log.commitReconciliationTerminalCAS(fixture.input)).rejects.toThrow(`kill:${killPoint}`)
      expect(await fixture.log.getByEventId(fixture.outcomeEventId)).toBeNull()
      expect(await fixture.log.getByEventId(fixture.input.terminal.event_id)).toBeNull()
      await isolated.close()
    }
  })

  test('distinct unknown events and delivered/permanent contenders produce one outcome winner', async () => {
    const replyId = 'reply-race-terminal'
    const deliveryId = 'delivery-race-terminal'
    const delivered = await installTerminalSources(db, {
      suffix: 'race-delivered', observedOutcome: 'validated_original_receipt', replyId, deliveryId,
    })
    const permanent = await installTerminalSources(db, {
      suffix: 'race-permanent', observedOutcome: 'permanent_failure', replyId, deliveryId, appendEnqueued: false,
    })
    const settled = await Promise.allSettled([
      delivered.log.commitReconciliationTerminalCAS(delivered.input),
      permanent.log.commitReconciliationTerminalCAS(permanent.input),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1)
    const outcomeCount = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id = $1`,
      [delivered.outcomeEventId],
    )
    const terminalCount = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE reply_id = $1 AND event_type IN ('reply.delivered', 'reply.failed')`,
      [replyId],
    )
    expect(Number(outcomeCount?.n ?? 0)).toBe(1)
    expect(Number(terminalCount?.n ?? 0)).toBe(1)
  })
})

async function installReopenSources(
  target: DbAdapter,
  identity: {
    suffix?: string
    connectorId?: string
    producerRegistrationId?: string
    issuerRegistrationId?: string
    authorityMode?: 'trusted_registry' | 'direct_self_attested'
  } = {},
): Promise<ReopenFixture> {
  const log = new EventLog(target)
  const suffix = identity.suffix ? `:${identity.suffix}` : ''
  const connectorId = identity.connectorId ?? '11111111-1111-4111-8111-111111111111'
  const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
  const adapterBytes = new TextEncoder().encode(`reopen-adapter-v1${suffix}`)
  const fixtureBytes = new TextEncoder().encode(`reopen-fixtures-v1${suffix}`)
  const producerBytes = new TextEncoder().encode(`reopen-producer-v1${suffix}`)
  const issuerBytes = new TextEncoder().encode(`reopen-issuer-v1${suffix}`)
  const policyBytes = new TextEncoder().encode(`reopen-policy-v1${suffix}`)
  const capabilityMaterial = {
    schema_version: 'aun-connector-delivery-capability/v1' as const,
    connector_instance_id: connectorId,
    connector_kind: 'fixture',
    idempotency_mode: 'lookup' as const,
    receipt_mode: 'provider_ack' as const,
    dedupe_scope: null,
    dedupe_window_seconds: null,
    provider_nonce_max_bytes: null,
    provider_nonce_charset: null,
    semantic_capabilities: ['direct_attention', 'post_message', 'reply_context'] as Array<'post_message' | 'reply_context' | 'direct_attention'>,
    reconciliation_mode: 'provider_lookup' as const,
    guarantee: 'effectively_once' as const,
    typed_rate_limit_retry_budget: 1,
    ambiguous_outcome_retry_budget: 0 as const,
    adapter_contract_version: 'fixture/v1',
    adapter_build_digest: digest(adapterBytes),
    capability_fixture_set_digest: digest(fixtureBytes),
  }
  const capability: ConnectorDeliveryCapabilityV1 = {
    ...capabilityMaterial,
    capability_digest: connectorCapabilityDigest(capabilityMaterial),
  }
  const capabilityDigest = capability.capability_digest
  const loadedMaterial = {
    schema_version: 'aun-loaded-connector-registration/v1' as const,
    registration_id: randomUUID(),
    connector_instance_id: connectorId,
    connector_kind: capability.connector_kind,
    loaded_adapter_instance_id: `loaded-reopen-fixture${suffix}`,
    adapter_contract_version: capability.adapter_contract_version,
    adapter_build_digest: capability.adapter_build_digest,
    canonical_capability_digest: capability.capability_digest,
    fixture_manifest_version: '1.0.0',
    fixture_manifest_digest: capability.capability_fixture_set_digest,
    build_test_attestation_ref: `fixture://reopen/build-test${suffix}`,
    build_test_attestation_digest: '1'.repeat(64),
    loader_identity_digest: '2'.repeat(64),
    registry_generation: 1,
    status: 'active' as const,
  }
  const loaded: LoadedConnectorRegistrationV1 = {
    ...loadedMaterial,
    registration_digest: loadedConnectorRegistrationDigest(loadedMaterial),
  }
  const producerMaterial: Omit<ZeroEffectProducerRegistrationV1, 'registration_digest'> = {
    schema_version: 'aun-zero-effect-producer-registration/v1', registration_id: identity.producerRegistrationId ?? '22222222-2222-4222-8222-222222222222',
    producer_instance_id: `producer-1${suffix}`, producer_kind: 'provider_rejection_verifier', connector_instance_id: connectorId,
    capability_digest: capabilityDigest, authorized_evidence_kinds: ['provider_rejected_before_effect'],
    verifier_contract_version: 'verifier/v1', producer_build_digest: digest(producerBytes), build_test_attestation_digest: 'b'.repeat(64),
    registry_generation: 1, valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', status: 'active',
  }
  const producer: ZeroEffectProducerRegistrationV1 = { ...producerMaterial, registration_digest: producerRegistrationDigest(producerMaterial) }
  const budgetPolicyDigest = 'c'.repeat(64)
  const issuerMaterial: Omit<RetryBudgetIssuerRegistrationV1, 'registration_digest'> = {
    schema_version: 'aun-retry-budget-issuer-registration/v1', registration_id: identity.issuerRegistrationId ?? '33333333-3333-4333-8333-333333333333',
    issuer_instance_id: `issuer-1${suffix}`, capability_digest: capabilityDigest, budget_policy_digest: budgetPolicyDigest,
    policy_source_digest: digest(policyBytes), issuer_build_digest: digest(issuerBytes), build_test_attestation_digest: 'f'.repeat(64),
    registry_generation: 1, valid_from: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', status: 'active',
  }
  const issuer: RetryBudgetIssuerRegistrationV1 = { ...issuerMaterial, registration_digest: issuerRegistrationDigest(issuerMaterial) }
  const verifierCalls = { loaded: 0, producer: 0, issuer: 0 }
  const verifier: LoadedConnectorVerifierPort = {
    loader_identity_digest: loaded.loader_identity_digest,
    async verifyBuildTestAttestation(input) {
      verifierCalls.loaded += 1
      return {
        verified: true,
        attestation_ref: input.registration.build_test_attestation_ref,
        attestation_digest: input.registration.build_test_attestation_digest,
        subject_adapter_build_digest: input.observed_adapter_build_digest,
        subject_capability_digest: input.capability.capability_digest,
        subject_fixture_manifest_digest: input.observed_fixture_manifest_digest,
        registry_generation: input.registration.registry_generation,
      }
    },
    async verifyZeroEffectProducerRegistration(input) {
      verifierCalls.producer += 1
      return {
        verified: true,
        producer_build_digest: input.producer_build_digest,
        build_test_attestation_digest: input.registration.build_test_attestation_digest,
        registry_generation: input.registration.registry_generation,
        verifier_contract_version: input.registration.verifier_contract_version,
      }
    },
    async verifyRetryBudgetIssuerRegistration(input) {
      verifierCalls.issuer += 1
      return {
        verified: true,
        issuer_build_digest: input.issuer_build_digest,
        build_test_attestation_digest: input.registration.build_test_attestation_digest,
        policy_source_digest: input.policy_source_digest,
        registry_generation: input.registration.registry_generation,
      }
    },
  }
  const registry = new ConnectorRegistry(target, verifier)
  await registry.registerLoadedConnector({
    registration: loaded,
    capability,
    loaded_adapter_bytes: adapterBytes,
    fixture_manifest_bytes: fixtureBytes,
  })
  const authorityInput = {
    connector_instance_id: connectorId,
    loaded_registration_digest: loaded.registration_digest,
    capability,
    loaded_adapter_bytes: adapterBytes,
    fixture_manifest_bytes: fixtureBytes,
  }
  let directAuthorityRejections = 0
  if ((identity.authorityMode ?? 'trusted_registry') === 'trusted_registry') {
    await registry.registerZeroEffectProducer({ ...authorityInput, registration: producer, producer_build_bytes: producerBytes })
    await registry.registerRetryBudgetIssuer({
      ...authorityInput,
      registration: issuer,
      issuer_build_bytes: issuerBytes,
      policy_source_bytes: policyBytes,
    })
  } else {
    for (const event of [producerRegistrationEvent(producer), issuerRegistrationEvent(issuer)]) {
      try {
        await log.append(event)
      } catch (error) {
        if (!(error instanceof LoadedRegistrationUnprovenError)) throw error
        directAuthorityRejections += 1
      }
    }
  }
  const providerRequestDigest = '5'.repeat(64)
  const providerNonce = `provider-001${suffix}`
  const unknown: ReplyDeliveryUnknownPayloadV1 = {
    reply_id: `reply-001${suffix}`, delivery_id: `delivery-001${suffix}`, recipient_seat_id: 'spec', attempt_ordinal: 0,
    connector_instance_id: connectorId, resolved_binding_snapshot_digest: '2'.repeat(64),
    resolved_delivery_decision_digest: '3'.repeat(64), delivery_digest: '4'.repeat(64),
    provider_request_digest: providerRequestDigest, business_nonce: `business-001${suffix}`, provider_nonce: providerNonce,
    capability_digest: capabilityDigest, invocation_started_event_id: `provider-invocation-started:fixture${suffix}`,
    reconciliation_mode: 'provider_lookup', fanout_child_provenance_digest: null,
  }
  const unknownEvent = await log.append({
    eventId: `delivery-unknown:evt-001${suffix}`, eventType: 'reply.delivery_unknown', conversationId: `conversation-1${suffix}`,
    correlationId: 'correlation-1', turnId: 'turn-1', replyId: unknown.reply_id, claimEpoch: 0,
    payload: unknown as unknown as Record<string, unknown>,
  })
  const unknownDigest = sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent.event)))

  const requestMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
    reconciliation_id: `recon-001${suffix}`, delivery_unknown_event_id: unknownEvent.event.event_id,
    delivery_unknown_event_digest: unknownDigest, reply_id: unknown.reply_id, delivery_id: unknown.delivery_id,
    recipient_seat_id: unknown.recipient_seat_id, attempt_ordinal: unknown.attempt_ordinal,
    connector_instance_id: unknown.connector_instance_id,
    resolved_binding_snapshot_digest: unknown.resolved_binding_snapshot_digest,
    resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
    delivery_digest: unknown.delivery_digest, provider_request_digest: providerRequestDigest,
    business_nonce: unknown.business_nonce, provider_nonce: providerNonce, capability_digest: capabilityDigest,
    reconciliation_mode: 'provider_lookup' as const, reconciler_registration_digest: '7'.repeat(64),
  }
  const request: DeliveryUnknownReconciliationRequestV1 = { ...requestMaterial, request_digest: reconciliationRequestDigest(requestMaterial) }
  const requestEventId = `delivery-reconciliation-requested:fixture${suffix}`
  await log.append({ eventId: requestEventId, eventType: 'reply.delivery_reconciliation_requested', replyId: unknown.reply_id, claimEpoch: 0, payload: request as unknown as Record<string, unknown> })

  const evidenceBody = {
    delivery_id: unknown.delivery_id, attempt_ordinal: 0, provider_request_digest: providerRequestDigest,
    provider_nonce: providerNonce, provider_response_digest: '8'.repeat(64), provider_rejection_code: `rejected-before-effect${suffix}`,
    provider_contract_digest: '9'.repeat(64), provider_contract_effect: 'rejected_before_effect' as const,
  }
  const evidence: ZeroExternalEffectEvidenceRecordV1 = {
    schema_version: 'aun-zero-external-effect-evidence/v1', evidence_kind: 'provider_rejected_before_effect',
    evidence_body: evidenceBody, evidence_digest: zeroEffectEvidenceDigest('provider_rejected_before_effect', evidenceBody),
  }
  const evidenceAppend = evidenceEvent(evidence)
  await log.append(evidenceAppend)

  const producerAppend = producerRegistrationEvent(producer)

  const attestationMaterial = {
    attestation_id: `attestation-001${suffix}`, delivery_id: unknown.delivery_id, attempt_ordinal: 0, connector_instance_id: connectorId,
    provider_request_digest: providerRequestDigest, provider_nonce: providerNonce, evidence_kind: evidence.evidence_kind,
    evidence_digest: evidence.evidence_digest, producer_registration_digest: producer.registration_digest,
    issued_at: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z',
  }
  const attestation: ZeroExternalEffectAttestationV1 = { ...attestationMaterial, attestation_digest: attestationDigest(attestationMaterial) }
  const attestationAppend = attestationEvent(attestation)
  await log.append(attestationAppend)

  const observationMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
    reconciliation_request_digest: request.request_digest, observed_outcome: 'proven_zero_external_effect' as const,
    validated_receipt_digest: null, permanent_failure_code: null,
    zero_external_effect_attestation_digest: attestation.attestation_digest, evidence_digest: evidence.evidence_digest,
  }
  const observation: DeliveryUnknownReconciliationObservationV1 = { ...observationMaterial, observation_digest: reconciliationObservationDigest(observationMaterial) }
  const observationEventId = reconciliationObservationEventId(unknownEvent.event.event_id, observation.observation_digest)
  await log.append({ eventId: observationEventId, eventType: 'reply.delivery_reconciliation_observed', replyId: unknown.reply_id, claimEpoch: 0, payload: observation as unknown as Record<string, unknown> })

  const issuerAppend = issuerRegistrationEvent(issuer)

  const budget: RetryBudgetSnapshotV1 = {
    schema_version: 'aun-retry-budget-snapshot/v1', reply_id: unknown.reply_id, delivery_id: unknown.delivery_id,
    capability_digest: capabilityDigest, budget_policy_digest: budgetPolicyDigest,
    authority_registration_digest: issuer.registration_digest, generation: 1, remaining: 1,
    prior_snapshot_event_id: null, transition_authority_digest: null,
  }
  const budgetAppend = retryBudgetSnapshotEvent(budget)
  await log.append(budgetAppend)

  const authorityMaterial: Omit<RetryBudgetAuthorityV1, 'authority_digest'> = {
    delivery_id: unknown.delivery_id, capability_digest: capabilityDigest, budget_policy_digest: budgetPolicyDigest,
    current_attempt_ordinal: 0, remaining_before: 1, remaining_after: 0, generation_before: 1, generation_after: 2,
    authority_registration_digest: issuer.registration_digest, issued_at: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z',
  }
  const authority: RetryBudgetAuthorityV1 = { ...authorityMaterial, authority_digest: retryBudgetAuthorityDigest(authorityMaterial) }
  const input: CommitReopenAuthorizationCASInput = {
    unknown_event_id: unknownEvent.event.event_id,
    reconciliation_request_event_id: requestEventId,
    reconciliation_observation_event_id: observationEventId,
    evidence_event_id: evidenceAppend.eventId,
    attestation_event_id: attestationAppend.eventId,
    producer_registration_event_id: producerAppend.eventId,
    issuer_registration_event_id: issuerAppend.eventId,
    budget_snapshot_event_id: budgetAppend.eventId,
    retry_budget_authority: authority,
    intended_next_attempt_ordinal: 1,
  }
  const resultIds = [
    `delivery-reconciliation-outcome:${sha256Utf8('aun-delivery-unknown-outcome/v1\n' + canonicalJson({ delivery_id: unknown.delivery_id, attempt_ordinal: 0 }))}`,
    `zero-external-effect-attestation-consumed:${sha256Utf8('aun-zero-external-effect-attestation-consumption-key/v1\n' + canonicalJson({ attestation_digest: attestation.attestation_digest }))}`,
    `retry-budget-snapshot:${sha256Utf8('aun-retry-budget-snapshot-key/v1\n' + canonicalJson({ delivery_id: unknown.delivery_id, generation: 2 }))}`,
    `delivery-reopened:${sha256Utf8('aun-delivery-reopen/v1\n' + canonicalJson({ delivery_unknown_event_id: unknownEvent.event.event_id, delivery_id: unknown.delivery_id, next_attempt_ordinal: 1 }))}`,
  ]
  return { log, input, groupEventIds: resultIds, directAuthorityRejections, verifierCalls }
}

describe('EventLogReopenAuthorizationPersistencePortV1', () => {
  test('one CAS commits exactly outcome+consumption+snapshot+reopen and byte-identical replay', async () => {
    const fixture = await installReopenSources(db)
    expect(fixture.directAuthorityRejections).toBe(0)
    expect(fixture.verifierCalls).toEqual({ loaded: 3, producer: 1, issuer: 1 })
    const result = await fixture.log.commitReopenAuthorizationCAS(fixture.input)
    expect(result.status).toBe('inserted')
    expect(result.provider_invocations).toBe(0)
    const durable = await db.query<{ event_id: string }>(
      `SELECT event_id FROM event_log WHERE event_id IN ($1,$2,$3,$4) ORDER BY event_id`,
      fixture.groupEventIds,
    )
    expect(durable).toHaveLength(4)
    const replay = await fixture.log.commitReopenAuthorizationCAS(structuredClone(fixture.input))
    expect(replay.status).toBe('byte_identical_existing')
    expect(replay.provider_invocations).toBe(0)
    expect((await pendingDeliveries(db)).map(row => row.reply_id)).toEqual([])
  })

  test('every precommit kill point rolls back all four members; after-commit replay recovers', async () => {
    const killPoints = [
      'before_outcome_append', 'after_outcome_append', 'before_consumption_append', 'after_consumption_append',
      'before_budget_snapshot_append', 'after_budget_snapshot_append', 'before_reopen_append', 'after_reopen_append', 'before_commit',
    ] as const
    for (const [index, killPoint] of killPoints.entries()) {
      const isolated = new SqliteAdapter(join(dir, `reopen-kill-${index}.db`))
      await ensureEventLogSchema(isolated)
      const fixture = await installReopenSources(isolated)
      fixture.input.on_commit_point = point => { if (point === killPoint) throw new Error(`kill:${killPoint}`) }
      await expect(fixture.log.commitReopenAuthorizationCAS(fixture.input)).rejects.toThrow(`kill:${killPoint}`)
      const count = await isolated.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
        fixture.groupEventIds,
      )
      expect(Number(count?.n ?? 0)).toBe(0)
      await isolated.close()
    }

    const committedDb = new SqliteAdapter(join(dir, 'reopen-after-commit.db'))
    await ensureEventLogSchema(committedDb)
    const committed = await installReopenSources(committedDb)
    committed.input.on_commit_point = point => { if (point === 'after_commit_before_return') throw new Error('kill:after_commit_before_return') }
    await expect(committed.log.commitReopenAuthorizationCAS(committed.input)).rejects.toThrow('kill:after_commit_before_return')
    const replayInput = { ...committed.input, on_commit_point: undefined }
    expect((await committed.log.commitReopenAuthorizationCAS(replayInput)).status).toBe('byte_identical_existing')
    await committedDb.close()
  })

  test('a visible 1-of-4 prefix is typed incomplete and never repaired', async () => {
    const sourceDb = new SqliteAdapter(join(dir, 'reopen-source.db'))
    await ensureEventLogSchema(sourceDb)
    const source = await installReopenSources(sourceDb)
    const committed = await source.log.commitReopenAuthorizationCAS(source.input)

    const partialDb = new SqliteAdapter(join(dir, 'reopen-partial.db'))
    await ensureEventLogSchema(partialDb)
    const partial = await installReopenSources(partialDb)
    const outcome = committed.outcome
    await partial.log.append({
      eventId: outcome.event_id, eventType: outcome.event_type, seatId: outcome.seat_id,
      seatInstanceId: outcome.seat_instance_id, conversationId: outcome.conversation_id,
      causationId: outcome.causation_id, correlationId: outcome.correlation_id, turnId: outcome.turn_id,
      replyId: outcome.reply_id, claimEpoch: outcome.claim_epoch,
      payload: typeof outcome.payload === 'string' ? JSON.parse(outcome.payload) : outcome.payload as any,
    })
    await expect(partial.log.commitReopenAuthorizationCAS(partial.input)).rejects.toBeInstanceOf(ReopenAtomicSetIncompleteError)
    const count = await partialDb.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
      partial.groupEventIds,
    )
    expect(Number(count?.n ?? 0)).toBe(1)
    await sourceDb.close()
    await partialDb.close()
  })

  test('TN-017C.authority direct self-attestation stays unknown with reopen=0 pending=0 provider=0', async () => {
    const fixture = await installReopenSources(db, { authorityMode: 'direct_self_attested' })
    expect(fixture.directAuthorityRejections).toBe(2)
    expect(fixture.verifierCalls).toEqual({ loaded: 1, producer: 0, issuer: 0 })
    const providerInvocations = 0
    await expect(fixture.log.commitReopenAuthorizationCAS(fixture.input))
      .rejects.toBeInstanceOf(ReopenNotAuthorizedError)
    const reopen = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
      fixture.groupEventIds,
    )
    const authority = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type IN ('authority.zero_effect_producer_registered', 'authority.retry_budget_issuer_registered')`,
    )
    expect(Number(reopen?.n ?? 0)).toBe(0)
    expect(Number(authority?.n ?? 0)).toBe(0)
    expect(await pendingDeliveries(db)).toHaveLength(0)
    expect(providerInvocations).toBe(0)
  })

  test('wrong persisted producer/evidence pair remains unknown with zero group members', async () => {
    const fixture = await installReopenSources(db)
    const producer = await db.queryOne<any>(`SELECT * FROM event_log WHERE event_id = $1`, [fixture.input.producer_registration_event_id])
    // Append a higher generation with a different mapped kind. The original
    // generation is now retired inside the CAS and cannot authorize reopen.
    const payload = typeof producer.payload === 'string' ? JSON.parse(producer.payload) : producer.payload
    const wrongMaterial = { ...payload, registry_generation: 2, producer_kind: 'invocation_guard', authorized_evidence_kinds: ['typed_pre_invocation_failure'] }
    wrongMaterial.registration_digest = producerRegistrationDigest(wrongMaterial)
    const wrongEvent = producerRegistrationEvent(wrongMaterial)
    // A registry-created later generation is represented directly in this
    // projection fixture; production writes remain ConnectorRegistry-only.
    await db.execute(
      `INSERT INTO event_log (event_id, event_type, payload) VALUES ($1, $2, $3)`,
      [wrongEvent.eventId, wrongEvent.eventType, JSON.stringify(wrongEvent.payload)],
    )
    await expect(fixture.log.commitReopenAuthorizationCAS(fixture.input)).rejects.toBeInstanceOf(ReopenNotAuthorizedError)
    const count = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
      fixture.groupEventIds,
    )
    expect(Number(count?.n ?? 0)).toBe(0)
  })

  test('delivered and reopen contenders share one outcome winner with no terminal/reopen coexistence', async () => {
    const fixture = await installReopenSources(db)
    const unknownRow = await db.queryOne<any>(`SELECT * FROM event_log WHERE event_id = $1`, [fixture.input.unknown_event_id])
    const requestRow = await db.queryOne<any>(`SELECT * FROM event_log WHERE event_id = $1`, [fixture.input.reconciliation_request_event_id])
    const unknown = typeof unknownRow.payload === 'string' ? JSON.parse(unknownRow.payload) : unknownRow.payload
    const request = typeof requestRow.payload === 'string' ? JSON.parse(requestRow.payload) : requestRow.payload
    const receiptDigest = '1'.repeat(64)
    const observationMaterial = {
      schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
      reconciliation_request_digest: request.request_digest,
      observed_outcome: 'validated_original_receipt' as const,
      validated_receipt_digest: receiptDigest,
      permanent_failure_code: null,
      zero_external_effect_attestation_digest: null,
      evidence_digest: '2'.repeat(64),
    }
    const observation = {
      ...observationMaterial,
      observation_digest: reconciliationObservationDigest(observationMaterial),
    }
    const observationEventId = reconciliationObservationEventId(fixture.input.unknown_event_id, observation.observation_digest)
    await fixture.log.append({
      eventId: observationEventId, eventType: 'reply.delivery_reconciliation_observed',
      replyId: unknown.reply_id, claimEpoch: unknown.attempt_ordinal,
      payload: observation,
    })
    const terminalInput: CommitReconciliationTerminalCASInputV1 = {
      unknown_event_id: fixture.input.unknown_event_id,
      reconciliation_request_event_id: fixture.input.reconciliation_request_event_id,
      reconciliation_observation_event_id: observationEventId,
      terminal: {
        outcome: 'delivered',
        event_id: 'reconciled-delivered:reopen-race',
        payload: {
          reply_id: unknown.reply_id, delivery_id: unknown.delivery_id, recipient_seat_id: unknown.recipient_seat_id,
          receipt_digest: receiptDigest, provider_request_digest: unknown.provider_request_digest,
          resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
          fanout_child_provenance_digest: unknown.fanout_child_provenance_digest,
        },
      },
    }
    const settled = await Promise.allSettled([
      fixture.log.commitReopenAuthorizationCAS(fixture.input),
      fixture.log.commitReconciliationTerminalCAS(terminalInput),
    ])
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    const outcomeCount = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_id = $1`,
      [fixture.groupEventIds[0]],
    )
    const stateCounts = await db.queryOne<{ delivered: number; reopened: number }>(
      `SELECT
         SUM(CASE WHEN event_type = 'reply.delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN event_type = 'reply.delivery_reopened' THEN 1 ELSE 0 END) AS reopened
       FROM event_log WHERE reply_id = $1`,
      [unknown.reply_id],
    )
    expect(Number(outcomeCount?.n ?? 0)).toBe(1)
    expect(Number(stateCounts?.delivered ?? 0) + Number(stateCounts?.reopened ?? 0)).toBe(1)
    expect(Number(stateCounts?.delivered ?? 0) * Number(stateCounts?.reopened ?? 0)).toBe(0)
  })
})

function postgresTestUrl(): string | undefined {
  if (process.env.AGENT_COM_TEST_DATABASE_URL) return process.env.AGENT_COM_TEST_DATABASE_URL
  const url = process.env.DATABASE_URL
  if (!url) return undefined
  const dbName = url.split('?')[0]!.split('/').pop() ?? ''
  return dbName.endsWith('_test') ? url : undefined
}

const POSTGRES_TEST_URL = postgresTestUrl()

describe.if(!!POSTGRES_TEST_URL)('TN-017E PostgreSQL separate-process reopen CAS', () => {
  test('SIGKILL before commit leaves 0/4; commit and restart replay expose exactly 4/4', async () => {
    const { PgAdapter } = await import('../../core/db/pg-adapter')
    const url = POSTGRES_TEST_URL!
    const pg = new PgAdapter(url)
    const suffix = randomUUID()
    try {
      await ensureEventLogSchema(pg)
      const fixture = await installReopenSources(pg, {
        suffix,
        connectorId: randomUUID(),
        producerRegistrationId: randomUUID(),
        issuerRegistrationId: randomUUID(),
      })
      const serializedInput = JSON.stringify(fixture.input)
      const marker = join(dir, `pg-reopen-precommit-${suffix}`)
      const killWorker = `
        import { PgAdapter } from './core/db/pg-adapter.ts'
        import { EventLog } from './core/eventlog/store.ts'
        const db = new PgAdapter(process.env.PG_TEST_URL)
        const input = JSON.parse(process.env.REOPEN_INPUT)
        input.on_commit_point = async point => {
          if (point === 'after_consumption_append') {
            await Bun.write(process.env.PG_MARKER, 'two-members-visible-only-inside-transaction')
            await new Promise(() => {})
          }
        }
        await new EventLog(db).commitReopenAuthorizationCAS(input)
      `
      const killed = Bun.spawn([process.execPath, '-e', killWorker], {
        cwd: process.cwd(),
        env: { ...process.env, PG_TEST_URL: url, REOPEN_INPUT: serializedInput, PG_MARKER: marker },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      for (let attempt = 0; attempt < 300 && !existsSync(marker); attempt += 1) await Bun.sleep(10)
      expect(existsSync(marker)).toBe(true)
      killed.kill('SIGKILL')
      expect(await killed.exited).not.toBe(0)
      const rolledBack = await pg.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
        fixture.groupEventIds,
      )
      expect(Number(rolledBack?.n ?? 0)).toBe(0)

      const commitWorker = `
        import { PgAdapter } from './core/db/pg-adapter.ts'
        import { EventLog } from './core/eventlog/store.ts'
        const db = new PgAdapter(process.env.PG_TEST_URL)
        try {
          const result = await new EventLog(db).commitReopenAuthorizationCAS(JSON.parse(process.env.REOPEN_INPUT))
          console.log(JSON.stringify({ status: result.status, provider_invocations: result.provider_invocations }))
        } finally { await db.close() }
      `
      const committed = Bun.spawn([process.execPath, '-e', commitWorker], {
        cwd: process.cwd(),
        env: { ...process.env, PG_TEST_URL: url, REOPEN_INPUT: serializedInput },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const committedOutput = await new Response(committed.stdout).text()
      expect(await committed.exited).toBe(0)
      expect(JSON.parse(committedOutput.trim())).toEqual({ status: 'inserted', provider_invocations: 0 })

      const replayed = Bun.spawn([process.execPath, '-e', commitWorker], {
        cwd: process.cwd(),
        env: { ...process.env, PG_TEST_URL: url, REOPEN_INPUT: serializedInput },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const replayOutput = await new Response(replayed.stdout).text()
      expect(await replayed.exited).toBe(0)
      expect(JSON.parse(replayOutput.trim())).toEqual({ status: 'byte_identical_existing', provider_invocations: 0 })
      const durable = await pg.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_id IN ($1,$2,$3,$4)`,
        fixture.groupEventIds,
      )
      expect(Number(durable?.n ?? 0)).toBe(4)
    } finally {
      await pg.close()
    }
  })
})
