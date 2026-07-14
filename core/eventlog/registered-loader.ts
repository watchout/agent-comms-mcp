/**
 * Dormant production composition root for registered connector authority.
 *
 * The two exported functions are deliberately no-argument/data-only.  The
 * DbAdapter, byte verification, authority writer, cursor writer, and live
 * handle never cross this lexical module boundary.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  REGISTERED_CONNECTOR_BYTE_SOURCES,
  REGISTERED_CONNECTOR_CATALOG,
  REGISTERED_DISCORD_CAPABILITY,
  REGISTERED_LOADED_CONNECTOR,
  REGISTERED_RETRY_BUDGET_ISSUER,
  REGISTERED_ZERO_EFFECT_PRODUCER,
} from '../../adapters/eventlog/registered-connector-catalog'
import { createDbAdapter } from '../db'
import type { DbAdapter } from '../db/adapter'
import { ensureEventLogSchema } from './schema'
import { appendEventConflictMaterial, assertByteIdenticalEvent, storedEventConflictMaterial } from './store'
import {
  AuthorityAdmissionError,
  RegisteredLoaderNotReadyError,
  RegisteredReopenCursorError,
  ReopenAtomicSetIncompleteError,
  ReopenNotAuthorizedError,
  parseEventPayload,
  type AppendEvent,
  type StoredEvent,
} from './types'
import {
  PRODUCER_KIND_TO_EVIDENCE_KIND,
  attestationConsumptionEventId,
  authorityAdmissionReceiptEvent,
  authorityAdmissionReceiptEventId,
  authoritySubjectConflictMaterialDigest,
  authoritySubjectPayloadDigest,
  buildAuthorityAdmissionReceipt,
  canonicalJson,
  decodeAttestation,
  decodeAttestationConsumption,
  decodeAuthorityAdmissionReceipt,
  decodeEvidenceRecord,
  decodeIssuerRegistration,
  decodeLoadedConnectorRegistration,
  decodeProducerRegistration,
  decodeReconciliationObservation,
  decodeReconciliationRequest,
  decodeReconciliationResolvedPayload,
  decodeRegisteredReopenScanCursor,
  decodeReplyDeliveryReopenedPayload,
  decodeReplyDeliveryUnknownPayload,
  decodeRetryBudgetAuthority,
  decodeRetryBudgetSnapshot,
  evidenceEvent,
  attestationEvent,
  issuerRegistrationEvent,
  issuerRegistrationEventId,
  loadedConnectorRegistrationEventId,
  producerRegistrationEvent,
  producerRegistrationEventId,
  reconciliationOutcomeEventId,
  reconciliationOutcomeKey,
  registeredReopenCursorEvent,
  registeredReopenCursorEventId,
  reopenEventId,
  retryBudgetAuthorityDigest,
  retryBudgetSnapshotEventId,
  sha256Utf8,
  type AuthorityAdmissionMaterialV2,
  type AuthorityAdmissionReceiptV1,
  type DeliveryUnknownReconciliationObservationV1,
  type DeliveryUnknownReconciliationRequestV1,
  type LoadedConnectorRegistrationV1,
  type RegisteredReopenClassificationCode,
  type RegisteredReopenScanCursorV1,
  type ReplyDeliveryReconciliationResolvedPayloadV1,
  type ReplyDeliveryReopenedPayloadV1,
  type ReplyDeliveryUnknownPayloadV1,
  type RetryBudgetAuthorityV1,
  type RetryBudgetIssuerRegistrationV1,
  type RetryBudgetSnapshotV1,
  type ZeroEffectProducerRegistrationV1,
  type ZeroExternalEffectAttestationConsumptionV1,
  type ZeroExternalEffectAttestationV1,
  type ZeroExternalEffectEvidenceRecordV1,
} from './transport-contract'

const INSERT_SQL = `
  INSERT INTO event_log (
    event_id, event_type, seat_id, seat_instance_id, conversation_id,
    causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT(event_id) DO NOTHING
`

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

const privateCatalog = deepFreeze(JSON.parse(
  canonicalJson(REGISTERED_CONNECTOR_CATALOG),
)) as typeof REGISTERED_CONNECTOR_CATALOG
const productionDb = createDbAdapter()
const transactionTails = new WeakMap<DbAdapter, Promise<void>>()

async function serializedTransaction<T>(db: DbAdapter, fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
  const previous = transactionTails.get(db) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => mine)
  transactionTails.set(db, tail)
  await previous
  try {
    return await db.transaction(fn)
  } finally {
    release()
    if (transactionTails.get(db) === tail) transactionTails.delete(db)
  }
}

interface PrivateAuthorityHandle {
  readonly catalog_digest: string
  readonly loader_identity_digest: string
  readonly subject_event_ids: readonly string[]
  readonly receipt_event_ids: readonly string[]
  readonly registry_generation: number
}

const liveHandles = new WeakMap<DbAdapter, PrivateAuthorityHandle>()

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function appendProtected(tx: DbAdapter, input: AppendEvent): Promise<{ inserted: boolean; event: StoredEvent }> {
  const params = [
    input.eventId,
    input.eventType,
    input.seatId ?? null,
    input.seatInstanceId ?? null,
    input.conversationId ?? null,
    input.causationId ?? null,
    input.correlationId ?? null,
    input.turnId ?? null,
    input.replyId ?? null,
    input.claimEpoch ?? null,
    JSON.stringify(input.payload ?? {}),
  ]
  const result = await tx.execute(INSERT_SQL, params)
  const event = await tx.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [input.eventId])
  if (!event) throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_COLLISION', `missing readback ${input.eventId}`)
  assertByteIdenticalEvent(input, event)
  return { inserted: result.rowCount > 0, event }
}

function catalogEntry() {
  const entry = privateCatalog.entries[0]
  if (!entry || privateCatalog.entries.length !== 1) {
    throw new AuthorityAdmissionError('REGISTERED_LOADER_CATALOG_INVALID', 'exactly one checked-in entry is required')
  }
  const sorted = [...privateCatalog.entries].sort((a, b) =>
    a.connector_kind.localeCompare(b.connector_kind) ||
    a.adapter_contract_version.localeCompare(b.adapter_contract_version) ||
    a.connector_instance_selector.localeCompare(b.connector_instance_selector))
  const recomputedCatalog = sha256Utf8(
    'aun-registered-connector-catalog/v1\n' + canonicalJson(sorted),
  )
  if (recomputedCatalog !== privateCatalog.catalog_digest) {
    throw new AuthorityAdmissionError('REGISTERED_LOADER_CATALOG_DIGEST_MISMATCH', 'catalog digest differs')
  }
  return entry
}

async function verifyCheckedInAuthority(): Promise<{
  loaderIdentityDigest: string
  subjects: readonly AppendEvent[]
  receipts: readonly AuthorityAdmissionReceiptV1[]
}> {
  const entry = catalogEntry()
  const adapterBytes = await readFile(fileURLToPath(new URL('../../adapters/eventlog/discord-transport.ts', import.meta.url)))
  const byteChecks: Array<[string, string, string]> = [
    ['adapter', sha256Bytes(adapterBytes), entry.adapter_build_digest],
    ['fixture', sha256Bytes(REGISTERED_CONNECTOR_BYTE_SOURCES.fixture_manifest), entry.fixture_manifest_digest],
    ['loaded attestation', sha256Bytes(REGISTERED_CONNECTOR_BYTE_SOURCES.loaded_build_attestation), entry.build_test_attestation_digest],
    ['producer', sha256Bytes(REGISTERED_CONNECTOR_BYTE_SOURCES.producer_build), entry.producer_build_digest],
    ['issuer', sha256Bytes(REGISTERED_CONNECTOR_BYTE_SOURCES.issuer_build), entry.issuer_build_digest],
    ['policy', sha256Bytes(REGISTERED_CONNECTOR_BYTE_SOURCES.policy_source), entry.policy_source_digest],
  ]
  for (const [name, actual, expected] of byteChecks) {
    if (actual !== expected) {
      throw new AuthorityAdmissionError('REGISTERED_LOADER_INSTALLED_BYTES_MISMATCH', `${name} bytes differ`)
    }
  }

  const loaded = decodeLoadedConnectorRegistration(REGISTERED_LOADED_CONNECTOR)
  const producer = decodeProducerRegistration(REGISTERED_ZERO_EFFECT_PRODUCER)
  const issuer = decodeIssuerRegistration(REGISTERED_RETRY_BUDGET_ISSUER)
  const capability = REGISTERED_DISCORD_CAPABILITY
  const loaderIdentityDigest = sha256Utf8(
    'aun-registered-loader-identity/v1\n' + canonicalJson({
      catalog_digest: privateCatalog.catalog_digest,
      composition_module_specifier: 'core/eventlog/registered-loader.ts',
      verifier_contract_version: entry.verifier_contract_version,
    }),
  )
  if (
    loaded.loader_identity_digest !== loaderIdentityDigest ||
    loaded.adapter_build_digest !== entry.adapter_build_digest ||
    loaded.fixture_manifest_digest !== entry.fixture_manifest_digest ||
    loaded.canonical_capability_digest !== entry.capability_digest ||
    producer.producer_build_digest !== entry.producer_build_digest ||
    issuer.issuer_build_digest !== entry.issuer_build_digest ||
    issuer.policy_source_digest !== entry.policy_source_digest ||
    capability.capability_digest !== entry.capability_digest ||
    loaded.registry_generation !== entry.registry_generation ||
    producer.registry_generation !== entry.registry_generation ||
    issuer.registry_generation !== entry.registry_generation
  ) {
    throw new AuthorityAdmissionError('REGISTERED_LOADER_ATTESTATION_INVALID', 'catalog/subject binding differs')
  }

  const subjects = [
    {
      eventId: loadedConnectorRegistrationEventId(loaded.registration_id, loaded.registry_generation),
      eventType: 'authority.loaded_connector_registered' as const,
      payload: loaded as unknown as Record<string, unknown>,
    },
    {
      eventId: producerRegistrationEventId(producer.registration_id, producer.registry_generation),
      eventType: 'authority.zero_effect_producer_registered' as const,
      payload: producer as unknown as Record<string, unknown>,
    },
    {
      eventId: issuerRegistrationEventId(issuer.registration_id, issuer.registry_generation),
      eventType: 'authority.retry_budget_issuer_registered' as const,
      payload: issuer as unknown as Record<string, unknown>,
    },
  ] as const
  const admissions = [
    {
      subject: subjects[0], payload: loaded,
      registrationId: loaded.registration_id,
      connectorInstanceId: loaded.connector_instance_id,
      registryGeneration: loaded.registry_generation,
      capabilityDigest: loaded.canonical_capability_digest,
      verificationKind: 'loaded_build_and_fixture' as const,
      buildTestAttestationDigest: loaded.build_test_attestation_digest,
      policySourceDigest: null,
    },
    {
      subject: subjects[1], payload: producer,
      registrationId: producer.registration_id,
      connectorInstanceId: producer.connector_instance_id,
      registryGeneration: producer.registry_generation,
      capabilityDigest: producer.capability_digest,
      verificationKind: 'zero_effect_producer' as const,
      buildTestAttestationDigest: producer.build_test_attestation_digest,
      policySourceDigest: null,
    },
    {
      subject: subjects[2], payload: issuer,
      registrationId: issuer.registration_id,
      connectorInstanceId: loaded.connector_instance_id,
      registryGeneration: issuer.registry_generation,
      capabilityDigest: issuer.capability_digest,
      verificationKind: 'retry_budget_issuer_and_policy' as const,
      buildTestAttestationDigest: issuer.build_test_attestation_digest,
      policySourceDigest: issuer.policy_source_digest,
    },
  ] as const
  const receipts = admissions.map(admission => {
    const material: AuthorityAdmissionMaterialV2 = {
      subject_event_id: admission.subject.eventId,
      subject_event_type: admission.subject.eventType,
      subject_conflict_material_digest: authoritySubjectConflictMaterialDigest(
        appendEventConflictMaterial(admission.subject),
      ),
      subject_payload_digest: authoritySubjectPayloadDigest(admission.payload),
      registration_id: admission.registrationId,
      connector_instance_id: admission.connectorInstanceId,
      registry_generation: admission.registryGeneration,
      capability_digest: admission.capabilityDigest,
      loader_catalog_digest: privateCatalog.catalog_digest,
      loader_identity_digest: loaderIdentityDigest,
      verification_kind: admission.verificationKind,
      verifier_contract_version: entry.verifier_contract_version,
      build_test_attestation_digest: admission.buildTestAttestationDigest,
      policy_source_digest: admission.policySourceDigest,
    }
    return buildAuthorityAdmissionReceipt(material)
  })
  return { loaderIdentityDigest, subjects, receipts }
}

async function assertNoDuplicateReceipt(tx: DbAdapter, subjectEventId: string, expectedEventId: string): Promise<void> {
  const rows = await tx.query<StoredEvent>(
    `SELECT * FROM event_log WHERE event_type = 'authority.connector_registry_admission_recorded' ORDER BY seq ASC`,
  )
  let count = 0
  for (const row of rows) {
    let receipt: AuthorityAdmissionReceiptV1
    try {
      receipt = decodeAuthorityAdmissionReceipt(parseEventPayload(row.payload))
    } catch (error) {
      throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_RECEIPT_INVALID', String(error))
    }
    if (authorityAdmissionReceiptEventId(receipt) !== row.event_id) {
      throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_EVENT_ID_MISMATCH', row.event_id)
    }
    if (receipt.subject_event_id === subjectEventId) {
      count += 1
      if (row.event_id !== expectedEventId) {
        throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_DUPLICATE', subjectEventId)
      }
    }
  }
  if (count > 1) throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_DUPLICATE', subjectEventId)
}

async function persistPair(
  subject: AppendEvent,
  receipt: AuthorityAdmissionReceiptV1,
): Promise<{ subjectsInserted: number; receiptsInserted: number }> {
  const receiptEvent = authorityAdmissionReceiptEvent(receipt)
  return serializedTransaction(productionDb, async tx => {
    const [subjectRow, receiptRow] = await Promise.all([
      tx.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [subject.eventId]),
      tx.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [receiptEvent.eventId]),
    ])
    if (Boolean(subjectRow) !== Boolean(receiptRow)) {
      throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_INCOMPLETE', subject.eventId)
    }
    await assertNoDuplicateReceipt(tx, subject.eventId, receiptEvent.eventId)
    if (subjectRow && receiptRow) {
      try {
        assertByteIdenticalEvent(subject, subjectRow)
        assertByteIdenticalEvent(receiptEvent, receiptRow)
      } catch (error) {
        throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_COLLISION', String(error))
      }
      return { subjectsInserted: 0, receiptsInserted: 0 }
    }
    const subjectResult = await appendProtected(tx, subject)
    const receiptResult = await appendProtected(tx, receiptEvent)
    if (!subjectResult.inserted || !receiptResult.inserted) {
      throw new AuthorityAdmissionError('AUTHORITY_ADMISSION_COLLISION', subject.eventId)
    }
    return { subjectsInserted: 1, receiptsInserted: 1 }
  })
}

export interface RegisteredLoaderLifecycleResultV1 {
  status: 'registered' | 'rebound'
  subjects_inserted: number
  receipts_inserted: number
  subject_event_ids: string[]
  receipt_event_ids: string[]
  fresh_handle_count: 1
  installed_byte_verifications: 6
  provider_invocations: 0
}

export async function runProductionRegisteredLoaderLifecycle(): Promise<RegisteredLoaderLifecycleResultV1> {
  liveHandles.delete(productionDb)
  await ensureEventLogSchema(productionDb)
  const verified = await verifyCheckedInAuthority()
  let subjectsInserted = 0
  let receiptsInserted = 0
  for (let index = 0; index < verified.subjects.length; index += 1) {
    const result = await persistPair(verified.subjects[index]!, verified.receipts[index]!)
    subjectsInserted += result.subjectsInserted
    receiptsInserted += result.receiptsInserted
  }
  const subjectEventIds = verified.subjects.map(subject => subject.eventId)
  const receiptEventIds = verified.receipts.map(receipt => authorityAdmissionReceiptEventId(receipt))
  const handle = Object.freeze({
    catalog_digest: privateCatalog.catalog_digest,
    loader_identity_digest: verified.loaderIdentityDigest,
    subject_event_ids: Object.freeze([...subjectEventIds]),
    receipt_event_ids: Object.freeze([...receiptEventIds]),
    registry_generation: catalogEntry().registry_generation,
  })
  liveHandles.set(productionDb, handle)
  return {
    status: subjectsInserted === 0 ? 'rebound' : 'registered',
    subjects_inserted: subjectsInserted,
    receipts_inserted: receiptsInserted,
    subject_event_ids: [...subjectEventIds],
    receipt_event_ids: [...receiptEventIds],
    fresh_handle_count: 1,
    installed_byte_verifications: 6,
    provider_invocations: 0,
  }
}

function requirePrivateHandle(): PrivateAuthorityHandle {
  const handle = liveHandles.get(productionDb)
  if (!handle) throw new RegisteredLoaderNotReadyError('runProductionRegisteredLoaderLifecycle must complete first')
  return handle
}

export interface ProcessNextRegisteredReopenResultV1 {
  status: 'reopened' | 'byte_identical_existing' | 'scan_advanced_no_eligible' | 'idle_until_source_epoch_advances'
  selected_request_event_id: string | null
  cursor_event_id: string | null
  product_event_ids: string[]
  provider_invocations: 0
}

class CandidateClassificationError extends Error {
  constructor(readonly classification: RegisteredReopenClassificationCode, message: string) {
    super(message)
  }
}

interface PrivateReopenCandidate {
  requestEvent: StoredEvent
  request: DeliveryUnknownReconciliationRequestV1
  unknownEvent: StoredEvent
  unknown: ReplyDeliveryUnknownPayloadV1
  observationEvent: StoredEvent
  observation: DeliveryUnknownReconciliationObservationV1
  evidenceEvent: StoredEvent
  evidence: ZeroExternalEffectEvidenceRecordV1
  attestationEvent: StoredEvent
  attestation: ZeroExternalEffectAttestationV1
  producerEvent: StoredEvent
  producer: ZeroEffectProducerRegistrationV1
  issuerEvent: StoredEvent
  issuer: RetryBudgetIssuerRegistrationV1
  budgetEvent: StoredEvent
  budget: RetryBudgetSnapshotV1
  authority: RetryBudgetAuthorityV1
}

function payloadByteLength(event: StoredEvent): number {
  return Buffer.byteLength(typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload), 'utf8')
}

function strictPayload<T>(event: StoredEvent, decoder: (value: unknown) => T): T {
  if (payloadByteLength(event) > 65_536) {
    throw new CandidateClassificationError('MALFORMED_IMMUTABLE', `${event.event_id} payload exceeds 65536 bytes`)
  }
  try {
    return decoder(parseEventPayload(event.payload))
  } catch (error) {
    throw new CandidateClassificationError('MALFORMED_IMMUTABLE', `${event.event_id}: ${String(error)}`)
  }
}

async function requiredEventAtEpoch(
  db: DbAdapter,
  eventId: string,
  eventType: AppendEvent['eventType'],
  epoch: number,
): Promise<StoredEvent> {
  const event = await db.queryOne<StoredEvent>(
    'SELECT * FROM event_log WHERE event_id = $1 AND seq <= $2',
    [eventId, epoch],
  )
  if (!event) {
    throw new CandidateClassificationError('SOURCE_INCOMPLETE_AT_FROZEN_EPOCH', `missing ${eventType} ${eventId}`)
  }
  if (event.event_type !== eventType) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', `${eventId} has type ${event.event_type}`)
  }
  return event
}

async function oneDecodedByDigest<T>(
  db: DbAdapter,
  eventType: AppendEvent['eventType'],
  epoch: number,
  decoder: (value: unknown) => T,
  digest: (value: T) => string,
  expected: string,
): Promise<{ event: StoredEvent; value: T }> {
  const rows = await db.query<StoredEvent>(
    'SELECT * FROM event_log WHERE event_type = $1 AND seq <= $2 ORDER BY seq ASC, event_id ASC',
    [eventType, epoch],
  )
  const matches: Array<{ event: StoredEvent; value: T }> = []
  for (const event of rows) {
    if (payloadByteLength(event) > 65_536) continue
    try {
      const value = decoder(parseEventPayload(event.payload))
      if (digest(value) === expected) matches.push({ event, value })
    } catch {
      // An unrelated malformed immutable row is classified when its own
      // request is scanned; it cannot become a digest join candidate here.
    }
  }
  if (matches.length === 0) {
    throw new CandidateClassificationError('SOURCE_INCOMPLETE_AT_FROZEN_EPOCH', `missing ${eventType} digest ${expected}`)
  }
  if (matches.length !== 1) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', `duplicate ${eventType} digest ${expected}`)
  }
  return matches[0]!
}

async function assertReceiptSetAndHandle(db: DbAdapter, candidate: {
  producerEvent: StoredEvent
  producer: ZeroEffectProducerRegistrationV1
  issuerEvent: StoredEvent
  issuer: RetryBudgetIssuerRegistrationV1
}): Promise<void> {
  const handle = requirePrivateHandle()
  if (db !== productionDb || liveHandles.get(db) !== handle) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'private store identity or handle differs')
  }
  let verified: Awaited<ReturnType<typeof verifyCheckedInAuthority>>
  try {
    verified = await verifyCheckedInAuthority()
  } catch (error) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', String(error))
  }
  const subjectIds = verified.subjects.map(subject => subject.eventId)
  const receiptIds = verified.receipts.map(receipt => authorityAdmissionReceiptEventId(receipt))
  if (
    canonicalJson(subjectIds) !== canonicalJson(handle.subject_event_ids) ||
    canonicalJson(receiptIds) !== canonicalJson(handle.receipt_event_ids) ||
    candidate.producerEvent.event_id !== subjectIds[1] ||
    candidate.issuerEvent.event_id !== subjectIds[2] ||
    candidate.producer.registration_digest !== REGISTERED_ZERO_EFFECT_PRODUCER.registration_digest ||
    candidate.issuer.registration_digest !== REGISTERED_RETRY_BUDGET_ISSUER.registration_digest
  ) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'candidate differs from exact current catalog generation')
  }
  for (let index = 0; index < verified.subjects.length; index += 1) {
    const subject = await db.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [subjectIds[index]])
    const receipt = await db.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [receiptIds[index]])
    if (!subject || !receipt) {
      throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'subject/receipt pair is incomplete')
    }
    try {
      assertByteIdenticalEvent(verified.subjects[index]!, subject)
      assertByteIdenticalEvent(authorityAdmissionReceiptEvent(verified.receipts[index]!), receipt)
    } catch (error) {
      throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', String(error))
    }
  }
}

function intervalContains(now: number, start: string, end: string): boolean {
  return Date.parse(start) <= now && now < Date.parse(end)
}

function evidenceIdentity(body: Record<string, unknown>) {
  return {
    delivery_id: body.delivery_id,
    attempt_ordinal: body.attempt_ordinal,
    provider_request_digest: body.provider_request_digest,
    provider_nonce: body.provider_nonce,
  }
}

async function validateCandidateChain(db: DbAdapter, candidate: PrivateReopenCandidate): Promise<void> {
  const {
    requestEvent, request, unknownEvent, unknown, observationEvent, observation,
    evidenceEvent: evidenceRow, evidence, attestationEvent: attestationRow,
    attestation, producerEvent, producer, issuerEvent, issuer, budgetEvent, budget,
    authority,
  } = candidate
  const unknownDigest = sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent)))
  if (
    requestEvent.reply_id !== null && requestEvent.reply_id !== unknown.reply_id ||
    unknownEvent.reply_id !== unknown.reply_id ||
    unknownEvent.claim_epoch === null || Number(unknownEvent.claim_epoch) !== unknown.attempt_ordinal ||
    request.delivery_unknown_event_id !== unknownEvent.event_id ||
    request.delivery_unknown_event_digest !== unknownDigest ||
    request.reply_id !== unknown.reply_id ||
    request.delivery_id !== unknown.delivery_id ||
    request.recipient_seat_id !== unknown.recipient_seat_id ||
    request.attempt_ordinal !== unknown.attempt_ordinal ||
    request.connector_instance_id !== unknown.connector_instance_id ||
    request.resolved_binding_snapshot_digest !== unknown.resolved_binding_snapshot_digest ||
    request.resolved_delivery_decision_digest !== unknown.resolved_delivery_decision_digest ||
    request.delivery_digest !== unknown.delivery_digest ||
    request.provider_request_digest !== unknown.provider_request_digest ||
    request.business_nonce !== unknown.business_nonce ||
    request.provider_nonce !== unknown.provider_nonce ||
    request.capability_digest !== unknown.capability_digest ||
    request.reconciliation_mode !== unknown.reconciliation_mode
  ) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', 'request does not bind unknown delivery')
  }
  if (
    observationEvent.reply_id !== null && observationEvent.reply_id !== unknown.reply_id ||
    observation.reconciliation_request_digest !== request.request_digest ||
    observation.observed_outcome !== 'proven_zero_external_effect' ||
    observation.zero_external_effect_attestation_digest !== attestation.attestation_digest ||
    observation.evidence_digest !== evidence.evidence_digest
  ) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', 'observation is not exact zero-effect evidence')
  }
  try {
    assertByteIdenticalEvent(evidenceEvent(evidence), evidenceRow)
    assertByteIdenticalEvent(attestationEvent(attestation), attestationRow)
    assertByteIdenticalEvent(producerRegistrationEvent(producer), producerEvent)
    assertByteIdenticalEvent(issuerRegistrationEvent(issuer), issuerEvent)
  } catch (error) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', String(error))
  }
  const identity = evidenceIdentity(evidence.evidence_body as unknown as Record<string, unknown>)
  if (
    identity.delivery_id !== unknown.delivery_id ||
    identity.attempt_ordinal !== unknown.attempt_ordinal ||
    identity.provider_request_digest !== unknown.provider_request_digest ||
    identity.provider_nonce !== unknown.provider_nonce ||
    attestation.delivery_id !== unknown.delivery_id ||
    attestation.attempt_ordinal !== unknown.attempt_ordinal ||
    attestation.connector_instance_id !== unknown.connector_instance_id ||
    attestation.provider_request_digest !== unknown.provider_request_digest ||
    attestation.provider_nonce !== unknown.provider_nonce ||
    attestation.evidence_kind !== evidence.evidence_kind ||
    attestation.evidence_digest !== evidence.evidence_digest ||
    attestation.producer_registration_digest !== producer.registration_digest ||
    PRODUCER_KIND_TO_EVIDENCE_KIND[producer.producer_kind] !== evidence.evidence_kind ||
    producer.authorized_evidence_kinds.length !== 1 ||
    producer.authorized_evidence_kinds[0] !== evidence.evidence_kind ||
    producer.connector_instance_id !== unknown.connector_instance_id ||
    producer.capability_digest !== unknown.capability_digest
  ) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', 'evidence/attestation/producer linkage differs')
  }
  const nowRow = await db.queryOne<{ transaction_now: unknown }>('SELECT CURRENT_TIMESTAMP AS transaction_now')
  const now = Date.parse(String(nowRow?.transaction_now))
  if (!Number.isFinite(now)) throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'transaction time is unreadable')
  if (
    producer.status !== 'active' || issuer.status !== 'active' ||
    !intervalContains(now, producer.valid_from, producer.expires_at) ||
    !intervalContains(now, issuer.valid_from, issuer.expires_at) ||
    !intervalContains(now, attestation.issued_at, attestation.expires_at) ||
    !intervalContains(now, authority.issued_at, authority.expires_at) ||
    Date.parse(attestation.issued_at) < Date.parse(producer.valid_from) ||
    Date.parse(attestation.expires_at) > Date.parse(producer.expires_at) ||
    Date.parse(authority.issued_at) < Date.parse(issuer.valid_from) ||
    Date.parse(authority.expires_at) > Date.parse(issuer.expires_at)
  ) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'authority interval or status is stale')
  }
  if (
    producerRegistrationEventId(producer.registration_id, producer.registry_generation) !== producerEvent.event_id ||
    issuerRegistrationEventId(issuer.registration_id, issuer.registry_generation) !== issuerEvent.event_id ||
    retryBudgetSnapshotEventId(budget.delivery_id, budget.generation) !== budgetEvent.event_id ||
    issuer.registration_digest !== authority.authority_registration_digest ||
    issuer.capability_digest !== unknown.capability_digest ||
    issuer.budget_policy_digest !== budget.budget_policy_digest ||
    authority.delivery_id !== unknown.delivery_id ||
    authority.capability_digest !== unknown.capability_digest ||
    authority.budget_policy_digest !== budget.budget_policy_digest ||
    authority.current_attempt_ordinal !== unknown.attempt_ordinal ||
    authority.remaining_before !== budget.remaining ||
    authority.remaining_after !== budget.remaining - 1 ||
    authority.generation_before !== budget.generation ||
    authority.generation_after !== budget.generation + 1 ||
    budget.reply_id !== unknown.reply_id ||
    budget.delivery_id !== unknown.delivery_id ||
    budget.capability_digest !== unknown.capability_digest ||
    budget.authority_registration_digest !== issuer.registration_digest
  ) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'budget/issuer authority differs')
  }
  await assertReceiptSetAndHandle(db, { producerEvent, producer, issuerEvent, issuer })
  const terminals = await db.query<StoredEvent>(
    `SELECT * FROM event_log WHERE reply_id = $1 AND event_type IN ('reply.delivered', 'reply.failed') ORDER BY seq ASC`,
    [unknown.reply_id],
  )
  for (const terminal of terminals) {
    const payload = parseEventPayload<Record<string, unknown>>(terminal.payload)
    const sameDelivery = payload.delivery_id === unknown.delivery_id ||
      (payload.delivery_id === undefined && Number(terminal.claim_epoch) === unknown.attempt_ordinal)
    const permanent = terminal.event_type === 'reply.delivered' || payload.permanent === true || payload.kind === 'permanent'
    if (sameDelivery && permanent) {
      throw new CandidateClassificationError('ALREADY_RESOLVED_OR_REOPENED', 'delivery already terminal')
    }
  }
}

async function deriveCandidate(
  db: DbAdapter,
  requestEvent: StoredEvent,
  epoch: number,
): Promise<PrivateReopenCandidate> {
  if (requestEvent.event_type !== 'reply.delivery_reconciliation_requested') {
    throw new CandidateClassificationError('REQUEST_ID_OR_CONFLICT_MISMATCH', 'candidate type differs')
  }
  const request = strictPayload(requestEvent, decodeReconciliationRequest)
  const unknownEvent = await requiredEventAtEpoch(db, request.delivery_unknown_event_id, 'reply.delivery_unknown', epoch)
  const unknown = strictPayload(unknownEvent, decodeReplyDeliveryUnknownPayload)
  const observationMatch = await oneDecodedByDigest(
    db,
    'reply.delivery_reconciliation_observed',
    epoch,
    decodeReconciliationObservation,
    value => value.reconciliation_request_digest,
    request.request_digest,
  )
  const observation = observationMatch.value
  if (!observation.zero_external_effect_attestation_digest) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', 'observation has no zero-effect attestation')
  }
  const evidenceMatch = await oneDecodedByDigest(
    db,
    'reply.zero_external_effect_evidence_recorded',
    epoch,
    decodeEvidenceRecord,
    value => value.evidence_digest,
    observation.evidence_digest,
  )
  const attestationMatch = await oneDecodedByDigest(
    db,
    'reply.zero_external_effect_attested',
    epoch,
    decodeAttestation,
    value => value.attestation_digest,
    observation.zero_external_effect_attestation_digest,
  )
  const producerMatch = await oneDecodedByDigest(
    db,
    'authority.zero_effect_producer_registered',
    epoch,
    decodeProducerRegistration,
    value => value.registration_digest,
    attestationMatch.value.producer_registration_digest,
  )
  const budgetRows = await db.query<StoredEvent>(
    `SELECT * FROM event_log WHERE event_type = 'reply.retry_budget_snapshot' AND seq <= $1 ORDER BY seq ASC`,
    [epoch],
  )
  const budgets: Array<{ event: StoredEvent; value: RetryBudgetSnapshotV1 }> = []
  for (const event of budgetRows) {
    if (payloadByteLength(event) > 65_536) continue
    try {
      const value = decodeRetryBudgetSnapshot(parseEventPayload(event.payload))
      if (value.delivery_id === unknown.delivery_id) budgets.push({ event, value })
    } catch { /* unrelated malformed snapshot cannot authorize */ }
  }
  if (budgets.length === 0) {
    throw new CandidateClassificationError('SOURCE_INCOMPLETE_AT_FROZEN_EPOCH', 'retry budget snapshot is missing')
  }
  const maximumGeneration = Math.max(...budgets.map(item => item.value.generation))
  const currentBudgets = budgets.filter(item => item.value.generation === maximumGeneration)
  if (currentBudgets.length !== 1) {
    throw new CandidateClassificationError('SOURCE_CONFLICT_IMMUTABLE', 'current retry budget generation is duplicated')
  }
  let budgetMatch = currentBudgets[0]!
  // Crash/restart after the four-member transaction but before its cursor
  // successor sees the generation-after snapshot as the durable tip. Rebind
  // the exact predecessor named by that snapshot so the unchanged group can
  // be verified byte-identically instead of being misclassified as exhausted.
  if (
    budgetMatch.value.remaining === 0 &&
    budgetMatch.value.generation > 1 &&
    budgetMatch.value.prior_snapshot_event_id !== null
  ) {
    const predecessor = budgets.filter(item =>
      item.event.event_id === budgetMatch.value.prior_snapshot_event_id)
    if (predecessor.length !== 1) {
      throw new CandidateClassificationError('ATOMIC_SET_QUARANTINED', 'generation-after snapshot predecessor differs')
    }
    budgetMatch = predecessor[0]!
  }
  if (budgetMatch.value.remaining < 1) {
    throw new CandidateClassificationError('AUTHORITY_SNAPSHOT_NOT_CURRENT', 'retry budget is exhausted')
  }
  const issuerMatch = await oneDecodedByDigest(
    db,
    'authority.retry_budget_issuer_registered',
    epoch,
    decodeIssuerRegistration,
    value => value.registration_digest,
    budgetMatch.value.authority_registration_digest,
  )
  const authorityMaterial: Omit<RetryBudgetAuthorityV1, 'authority_digest'> = {
    delivery_id: unknown.delivery_id,
    capability_digest: unknown.capability_digest,
    budget_policy_digest: budgetMatch.value.budget_policy_digest,
    current_attempt_ordinal: unknown.attempt_ordinal,
    remaining_before: budgetMatch.value.remaining,
    remaining_after: budgetMatch.value.remaining - 1,
    generation_before: budgetMatch.value.generation,
    generation_after: budgetMatch.value.generation + 1,
    authority_registration_digest: issuerMatch.value.registration_digest,
    issued_at: issuerMatch.value.valid_from,
    expires_at: issuerMatch.value.expires_at,
  }
  const authority = decodeRetryBudgetAuthority({
    ...authorityMaterial,
    authority_digest: retryBudgetAuthorityDigest(authorityMaterial),
  })
  const candidate: PrivateReopenCandidate = {
    requestEvent,
    request,
    unknownEvent,
    unknown,
    observationEvent: observationMatch.event,
    observation,
    evidenceEvent: evidenceMatch.event,
    evidence: evidenceMatch.value,
    attestationEvent: attestationMatch.event,
    attestation: attestationMatch.value,
    producerEvent: producerMatch.event,
    producer: producerMatch.value,
    issuerEvent: issuerMatch.event,
    issuer: issuerMatch.value,
    budgetEvent: budgetMatch.event,
    budget: budgetMatch.value,
    authority,
  }
  await validateCandidateChain(db, candidate)
  return candidate
}

function buildProductGroup(candidate: PrivateReopenCandidate): AppendEvent[] {
  const { unknown, request, observation, evidence, attestation, producer, issuer, budget, authority } = candidate
  const nextAttempt = unknown.attempt_ordinal + 1
  const outcomeKey = reconciliationOutcomeKey(unknown.delivery_id, unknown.attempt_ordinal)
  const outcomeEventId = reconciliationOutcomeEventId(unknown.delivery_id, unknown.attempt_ordinal)
  const reopenId = reopenEventId(candidate.unknownEvent.event_id, unknown.delivery_id, nextAttempt)
  const consumptionId = attestationConsumptionEventId(attestation.attestation_digest)
  const afterSnapshotId = retryBudgetSnapshotEventId(unknown.delivery_id, authority.generation_after)
  const outcomePayload: ReplyDeliveryReconciliationResolvedPayloadV1 = {
    delivery_unknown_event_id: candidate.unknownEvent.event_id,
    reconciliation_observation_event_id: candidate.observationEvent.event_id,
    reconciliation_request_digest: request.request_digest,
    observation_digest: observation.observation_digest,
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    recipient_seat_id: unknown.recipient_seat_id,
    attempt_ordinal: unknown.attempt_ordinal,
    reconciliation_outcome_key: outcomeKey,
    outcome: 'reopened',
    resulting_event_id: reopenId,
  }
  decodeReconciliationResolvedPayload(outcomePayload)
  const consumptionPayload: ZeroExternalEffectAttestationConsumptionV1 = {
    schema_version: 'aun-zero-external-effect-attestation-consumption/v1',
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    attempt_ordinal: unknown.attempt_ordinal,
    attestation_digest: attestation.attestation_digest,
    evidence_digest: evidence.evidence_digest,
    producer_registration_digest: producer.registration_digest,
    reconciliation_outcome_key: outcomeKey,
    reconciliation_resolved_event_id: outcomeEventId,
    reopen_event_id: reopenId,
  }
  decodeAttestationConsumption(consumptionPayload)
  const afterSnapshot: RetryBudgetSnapshotV1 = {
    schema_version: 'aun-retry-budget-snapshot/v1',
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    capability_digest: unknown.capability_digest,
    budget_policy_digest: budget.budget_policy_digest,
    authority_registration_digest: issuer.registration_digest,
    generation: authority.generation_after,
    remaining: authority.remaining_after,
    prior_snapshot_event_id: candidate.budgetEvent.event_id,
    transition_authority_digest: authority.authority_digest,
  }
  decodeRetryBudgetSnapshot(afterSnapshot)
  const reopenPayload: ReplyDeliveryReopenedPayloadV1 = {
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    recipient_seat_id: unknown.recipient_seat_id,
    causation_delivery_unknown_event_id: candidate.unknownEvent.event_id,
    reconciliation_request_digest: request.request_digest,
    reconciliation_observation_digest: observation.observation_digest,
    prior_attempt_ordinal: unknown.attempt_ordinal,
    next_attempt_ordinal: nextAttempt,
    provider_request_digest: unknown.provider_request_digest,
    capability_digest: unknown.capability_digest,
    attestation_digest: attestation.attestation_digest,
    producer_registration_digest: producer.registration_digest,
    retry_budget_before_reopen: authority.remaining_before,
    retry_budget_after_reopen: authority.remaining_after,
    retry_budget_generation_before: authority.generation_before,
    retry_budget_generation_after: authority.generation_after,
    authority_digest: authority.authority_digest,
    authority_registration_digest: authority.authority_registration_digest,
    fanout_child_provenance_digest: unknown.fanout_child_provenance_digest,
  }
  decodeReplyDeliveryReopenedPayload(reopenPayload)
  return [
    {
      eventId: outcomeEventId,
      eventType: 'reply.delivery_reconciliation_resolved',
      conversationId: candidate.unknownEvent.conversation_id,
      causationId: candidate.observationEvent.event_id,
      correlationId: candidate.unknownEvent.correlation_id,
      turnId: candidate.unknownEvent.turn_id,
      replyId: unknown.reply_id,
      claimEpoch: unknown.attempt_ordinal,
      payload: outcomePayload as unknown as Record<string, unknown>,
    },
    {
      eventId: consumptionId,
      eventType: 'reply.zero_external_effect_attestation_consumed',
      conversationId: candidate.unknownEvent.conversation_id,
      causationId: outcomeEventId,
      correlationId: candidate.unknownEvent.correlation_id,
      turnId: candidate.unknownEvent.turn_id,
      replyId: unknown.reply_id,
      claimEpoch: unknown.attempt_ordinal,
      payload: consumptionPayload as unknown as Record<string, unknown>,
    },
    {
      eventId: afterSnapshotId,
      eventType: 'reply.retry_budget_snapshot',
      conversationId: candidate.unknownEvent.conversation_id,
      causationId: outcomeEventId,
      correlationId: candidate.unknownEvent.correlation_id,
      turnId: candidate.unknownEvent.turn_id,
      replyId: unknown.reply_id,
      claimEpoch: nextAttempt,
      payload: afterSnapshot as unknown as Record<string, unknown>,
    },
    {
      eventId: reopenId,
      eventType: 'reply.delivery_reopened',
      conversationId: candidate.unknownEvent.conversation_id,
      causationId: outcomeEventId,
      correlationId: candidate.unknownEvent.correlation_id,
      turnId: candidate.unknownEvent.turn_id,
      replyId: unknown.reply_id,
      claimEpoch: nextAttempt,
      payload: reopenPayload as unknown as Record<string, unknown>,
    },
  ]
}

async function commitReopenAuthorizationCASPrivate(
  requestEventId: string,
  frozenEpoch: number,
): Promise<{ status: 'reopened' | 'byte_identical_existing'; eventIds: string[] }> {
  requirePrivateHandle()
  return serializedTransaction(productionDb, async tx => {
    const firstRequest = await requiredEventAtEpoch(
      tx,
      requestEventId,
      'reply.delivery_reconciliation_requested',
      frozenEpoch,
    )
    const first = await deriveCandidate(tx, firstRequest, frozenEpoch)
    const firstGroup = buildProductGroup(first)
    const lockIds = [
      ...liveHandles.get(productionDb)!.subject_event_ids,
      ...liveHandles.get(productionDb)!.receipt_event_ids,
      first.budgetEvent.event_id,
      ...firstGroup.map(event => event.eventId),
    ].sort()
    const placeholders = lockIds.map((_, index) => `$${index + 1}`).join(', ')
    await tx.query<{ event_id: string }>(
      `SELECT event_id FROM event_log WHERE event_id IN (${placeholders}) ORDER BY event_id ASC FOR UPDATE`,
      lockIds,
    )
    if (liveHandles.get(tx) !== liveHandles.get(productionDb) && tx !== productionDb) {
      // Transaction adapters may be wrappers. Authority remains bound to the
      // exact root object and is checked through productionDb before entry.
      if (!liveHandles.get(productionDb)) throw new ReopenNotAuthorizedError('private handle was invalidated')
    }
    const request = await requiredEventAtEpoch(
      tx,
      requestEventId,
      'reply.delivery_reconciliation_requested',
      frozenEpoch,
    )
    const candidate = await deriveCandidate(tx, request, frozenEpoch)
    const group = buildProductGroup(candidate)
    const existing = await Promise.all(group.map(event =>
      tx.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [event.eventId])))
    const count = existing.filter(Boolean).length
    if (count > 0 && count < 4) {
      throw new ReopenAtomicSetIncompleteError('reopen atomic set is partial')
    }
    if (count === 4) {
      try {
        group.forEach((event, index) => assertByteIdenticalEvent(event, existing[index]!))
      } catch (error) {
        throw new ReopenAtomicSetIncompleteError(`reopen atomic set collides: ${String(error)}`)
      }
      return { status: 'byte_identical_existing', eventIds: group.map(event => event.eventId) }
    }
    for (const event of group) {
      const result = await appendProtected(tx, event)
      if (!result.inserted) throw new ReopenAtomicSetIncompleteError(`lost append for ${event.eventId}`)
    }
    const readback = await Promise.all(group.map(event =>
      tx.queryOne<StoredEvent>('SELECT * FROM event_log WHERE event_id = $1', [event.eventId])))
    if (readback.some(event => !event)) throw new ReopenAtomicSetIncompleteError('reopen readback is incomplete')
    group.forEach((event, index) => assertByteIdenticalEvent(event, readback[index]!))
    return { status: 'reopened', eventIds: group.map(event => event.eventId) }
  })
}

interface CursorTip {
  eventId: string
  payload: RegisteredReopenScanCursorV1 | null
}

async function loadCursorTip(db: DbAdapter): Promise<CursorTip> {
  const rows = await db.query<StoredEvent>(
    `SELECT * FROM event_log WHERE event_type = 'authority.reopen_scan_cursor_advanced' ORDER BY seq ASC`,
  )
  if (rows.length === 0) return { eventId: 'GENESIS', payload: null }
  const byPredecessor = new Map<string, StoredEvent[]>()
  const decodedById = new Map<string, RegisteredReopenScanCursorV1>()
  for (const row of rows) {
    let decoded: RegisteredReopenScanCursorV1
    try {
      decoded = decodeRegisteredReopenScanCursor(parseEventPayload(row.payload))
    } catch (error) {
      throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', String(error))
    }
    if (row.event_id !== registeredReopenCursorEventId(decoded.predecessor_cursor_event_id)) {
      throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', `event id mismatch ${row.event_id}`)
    }
    const siblings = byPredecessor.get(decoded.predecessor_cursor_event_id) ?? []
    siblings.push(row)
    byPredecessor.set(decoded.predecessor_cursor_event_id, siblings)
    decodedById.set(row.event_id, decoded)
  }
  let predecessor = 'GENESIS'
  let visited = 0
  let tip: CursorTip = { eventId: 'GENESIS', payload: null }
  let priorPayload: RegisteredReopenScanCursorV1 | null = null
  while (true) {
    const successors = byPredecessor.get(predecessor) ?? []
    if (successors.length === 0) break
    if (successors.length !== 1) {
      throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', `fork after ${predecessor}`)
    }
    const row = successors[0]!
    const payload = decodedById.get(row.event_id)!
    if (priorPayload) {
      if (priorPayload.cycle_exhausted) {
        if (
          payload.cycle_source_epoch_seq <= priorPayload.cycle_source_epoch_seq ||
          payload.page_start_after_request_seq !== 0 ||
          payload.page_start_after_request_event_id !== null
        ) {
          throw new RegisteredReopenCursorError(
            'REGISTERED_REOPEN_CURSOR_CORRUPT',
            'new cursor cycle did not advance epoch from the genesis tuple',
          )
        }
      } else if (
        payload.cycle_source_epoch_seq !== priorPayload.cycle_source_epoch_seq ||
        payload.page_start_after_request_seq !== priorPayload.page_end_request_seq ||
        payload.page_start_after_request_event_id !== priorPayload.page_end_request_event_id
      ) {
        throw new RegisteredReopenCursorError(
          'REGISTERED_REOPEN_CURSOR_CORRUPT',
          'cursor reset or changed its frozen source epoch mid-cycle',
        )
      }
    }
    tip = { eventId: row.event_id, payload }
    predecessor = row.event_id
    priorPayload = payload
    visited += 1
    if (visited > rows.length) {
      throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'cursor cycle')
    }
  }
  if (visited !== rows.length) {
    throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'unreachable cursor row')
  }
  return tip
}

async function appendCursorSuccessor(
  predecessor: CursorTip,
  payload: RegisteredReopenScanCursorV1,
): Promise<string> {
  const expectedId = registeredReopenCursorEventId(predecessor.eventId)
  const event = registeredReopenCursorEvent(payload)
  if (event.eventId !== expectedId) {
    throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'successor predecessor differs')
  }
  try {
    return await serializedTransaction(productionDb, async tx => {
      const currentTip = await loadCursorTip(tx)
      if (currentTip.eventId !== predecessor.eventId) {
        throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_COLLISION_RETRY', 'cursor tip advanced')
      }
      await appendProtected(tx, event)
      return event.eventId
    })
  } catch (error) {
    if (error instanceof RegisteredReopenCursorError) throw error
    throw new RegisteredReopenCursorError('REGISTERED_REOPEN_CURSOR_COLLISION_RETRY', String(error))
  }
}

function dispositionFor(
  event: StoredEvent,
  classification: RegisteredReopenClassificationCode,
) {
  return {
    request_seq: Number(event.seq),
    request_event_id: event.event_id,
    request_conflict_material_digest: authoritySubjectConflictMaterialDigest(storedEventConflictMaterial(event)),
    classification_code: classification,
  }
}

async function processFromTip(tip: CursorTip): Promise<ProcessNextRegisteredReopenResultV1> {
  const maxRow = await productionDb.queryOne<{ max_seq: unknown }>(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM event_log WHERE event_type <> 'authority.reopen_scan_cursor_advanced'`,
  )
  const currentMax = Number(maxRow?.max_seq ?? 0)
  let epoch: number
  let startSeq: number
  let startEventId: string | null
  if (!tip.payload) {
    epoch = currentMax
    startSeq = 0
    startEventId = null
  } else if (tip.payload.cycle_exhausted) {
    if (currentMax <= tip.payload.cycle_source_epoch_seq) {
      return {
        status: 'idle_until_source_epoch_advances',
        selected_request_event_id: null,
        cursor_event_id: null,
        product_event_ids: [],
        provider_invocations: 0,
      }
    }
    epoch = currentMax
    startSeq = 0
    startEventId = null
  } else {
    epoch = tip.payload.cycle_source_epoch_seq
    startSeq = tip.payload.page_end_request_seq
    startEventId = tip.payload.page_end_request_event_id
  }
  const rows = await productionDb.query<StoredEvent>(
    `SELECT * FROM event_log
     WHERE event_type = 'reply.delivery_reconciliation_requested'
       AND seq <= $1
       AND (seq > $2 OR (seq = $2 AND event_id > $3))
     ORDER BY seq ASC, event_id ASC
     LIMIT 64`,
    [epoch, startSeq, startEventId ?? ''],
  )
  const dispositions: ReturnType<typeof dispositionFor>[] = []
  let selected: StoredEvent | null = null
  let result: { status: 'reopened' | 'byte_identical_existing'; eventIds: string[] } | null = null
  for (const row of rows) {
    try {
      await deriveCandidate(productionDb, row, epoch)
      result = await commitReopenAuthorizationCASPrivate(row.event_id, epoch)
      selected = row
      dispositions.push(dispositionFor(row, 'ELIGIBLE'))
      break
    } catch (error) {
      if (error instanceof CandidateClassificationError) {
        dispositions.push(dispositionFor(row, error.classification))
        continue
      }
      if (error instanceof ReopenAtomicSetIncompleteError) {
        dispositions.push(dispositionFor(row, 'ATOMIC_SET_QUARANTINED'))
        continue
      }
      throw error
    }
  }
  const end = selected ?? rows.at(-1) ?? null
  const exhausted = selected === null && rows.length < 64
  const cursor: RegisteredReopenScanCursorV1 = {
    schema_version: 'aun-registered-reopen-scan-cursor/v1',
    selector_version: 'registered-reopen-selector/v1',
    predecessor_cursor_event_id: tip.eventId,
    cycle_source_epoch_seq: epoch,
    page_start_after_request_seq: startSeq,
    page_start_after_request_event_id: startEventId,
    page_end_request_seq: end ? Number(end.seq) : startSeq,
    page_end_request_event_id: end?.event_id ?? startEventId,
    cycle_exhausted: exhausted,
    scanned_dispositions: dispositions,
    selected_request_event_id: selected?.event_id ?? null,
    selected_result: result?.status ?? null,
  }
  const cursorEventId = await appendCursorSuccessor(tip, cursor)
  return {
    status: result?.status ?? 'scan_advanced_no_eligible',
    selected_request_event_id: selected?.event_id ?? null,
    cursor_event_id: cursorEventId,
    product_event_ids: result?.eventIds ?? [],
    provider_invocations: 0,
  }
}

export async function processNextRegisteredReopen(): Promise<ProcessNextRegisteredReopenResultV1> {
  requirePrivateHandle()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const tip = await loadCursorTip(productionDb)
    try {
      return await processFromTip(tip)
    } catch (error) {
      if (error instanceof RegisteredReopenCursorError &&
          error.code === 'REGISTERED_REOPEN_CURSOR_COLLISION_RETRY') continue
      throw error
    }
  }
  throw new RegisteredReopenCursorError(
    'REGISTERED_REOPEN_SCAN_TRANSIENT_FAILURE',
    'cursor tip changed during four bounded retries',
  )
}
