/**
 * Transport-Neutral Contract r1.1.4.
 *
 * This module is the deterministic, connector-neutral contract boundary for
 * AUN Receive Runtime V2.  It contains only typed data, canonical encoding,
 * digest derivation, and fail-closed validation.  Provider invocation and
 * persistence are separate injected ports; Discord is never routing or
 * identity authority here.
 *
 * Durable authority:
 * - agent-comms-mcp#794 comment 4954668058 (Contract r1.1.4)
 * - inherited comments 4954507774, 4953392412, and 4952920646
 */

import { createHash } from 'node:crypto'
import type { AppendEvent } from './types'

export const TRANSPORT_NEUTRAL_CONTRACT_REVISION = '1.1.4' as const

export const PRODUCER_KIND_TO_EVIDENCE_KIND = {
  invocation_guard: 'typed_pre_invocation_failure',
  provider_rejection_verifier: 'provider_rejected_before_effect',
  read_only_lookup_verifier: 'verified_lookup_no_effect',
} as const

export type ProducerKind = keyof typeof PRODUCER_KIND_TO_EVIDENCE_KIND
export type EvidenceKind = (typeof PRODUCER_KIND_TO_EVIDENCE_KIND)[ProducerKind]
export type Sha256 = string

export const CONTRACT_DOMAINS = {
  delivery: 'aun-delivery-unit/v1\n',
  capability: 'aun-connector-capability/v1\n',
  loadedRegistration: 'aun-loaded-connector-registration/v1\n',
  loadedRegistrationKey: 'aun-loaded-connector-registration-key/v1\n',
  providerNonce: 'aun-provider-nonce/v1\n',
  providerDedupeScope: 'aun-provider-dedupe-scope-identity/v1\n',
  providerNonceReservationKey: 'aun-provider-nonce-reservation-key/v1\n',
  providerInvocationStart: 'aun-provider-invocation-start/v1\n',
  destination: 'aun-destination/v1\n',
  opaqueAddress: 'aun-opaque-address/v1\n',
  bindingSnapshot: 'aun-binding-snapshot/v1\n',
  resolvedDeliveryDecision: 'aun-resolved-delivery-decision/v1\n',
  receipt: 'aun-transport-receipt/v1\n',
  discordRequest: 'aun-discord-provider-request/v1\n',
  discordResponse: 'aun-discord-provider-response/v1\n',
  discordAck: 'aun-discord-provider-ack/v1\n',
  fanoutRequest: 'aun-fanout-request/v1\n',
  fanoutChild: 'aun-fanout-child/v1\n',
  fanoutProvenance: 'aun-fanout-child-provenance/v1\n',
  reconciliationRequest: 'aun-delivery-unknown-reconciliation-request/v1\n',
  reconciliationObservation: 'aun-delivery-unknown-reconciliation-observation/v1\n',
  reconciliationObservationEvent: 'aun-delivery-unknown-observation/v1\n',
  reconciliationOutcome: 'aun-delivery-unknown-outcome/v1\n',
  reconciliationOutcomeKey: 'aun-delivery-unknown-outcome-key/v1\n',
  reopen: 'aun-delivery-reopen/v1\n',
  producerRegistration: 'aun-zero-effect-producer-registration/v1\n',
  producerRegistrationKey: 'aun-zero-effect-producer-registration-key/v1\n',
  issuerRegistration: 'aun-retry-budget-issuer-registration/v1\n',
  issuerRegistrationKey: 'aun-retry-budget-issuer-registration-key/v1\n',
  authoritySubjectConflictMaterial: 'aun-authority-subject-conflict-material/v1\n',
  authoritySubjectPayload: 'aun-authority-subject-payload/v1\n',
  authorityAdmissionId: 'aun-authority-admission-id/v1\n',
  authorityAdmissionReceiptMaterial: 'aun-authority-admission-receipt-material/v1\n',
  authorityAdmissionReceiptEventId: 'aun-authority-admission-receipt-event-id/v1\n',
  registeredReopenCursorSuccessor: 'aun-registered-reopen-scan-cursor-successor/v1\n',
  zeroEffectAttestation: 'aun-zero-external-effect-attestation/v1\n',
  retryBudgetAuthority: 'aun-retry-budget-authority/v1\n',
  retryBudgetSnapshotKey: 'aun-retry-budget-snapshot-key/v1\n',
  attestationConsumptionKey: 'aun-zero-external-effect-attestation-consumption-key/v1\n',
} as const

export class ContractValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ContractValidationError('NON_CANONICAL_NUMBER', 'only safe integers are admitted')
    }
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const child = value[key]
      if (child === undefined) {
        throw new ContractValidationError('NON_CANONICAL_UNDEFINED', `field ${key} is undefined`)
      }
      result[key] = canonicalize(child)
    }
    return result
  }
  throw new ContractValidationError('NON_CANONICAL_VALUE', `unsupported value type ${typeof value}`)
}

/** Sorted-key, UTF-8 canonical JSON used by every contract digest. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256Utf8(value: string): Sha256 {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function digestCanonical(domain: string, value: unknown): Sha256 {
  return sha256Utf8(domain + canonicalJson(value))
}

export function withoutField<T extends Record<string, unknown>>(value: T, field: keyof T | string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  delete copy[String(field)]
  return copy
}

function assertExactKeys(value: unknown, required: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new ContractValidationError('STRICT_DECODE_FAILED', `${name} must be an object`)
  const actual = Object.keys(value).sort()
  const expected = [...required].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.filter(key => !actual.includes(key))
    const extra = actual.filter(key => !expected.includes(key))
    throw new ContractValidationError(
      'STRICT_DECODE_FAILED',
      `${name} field mismatch missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    )
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be a non-empty string`)
  }
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null) assertString(value, field)
}

function assertSha(value: unknown, field: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be lowercase sha256`)
  }
}

function assertNullableSha(value: unknown, field: string): asserts value is Sha256 | null {
  if (value !== null) assertSha(value, field)
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be a non-negative integer`)
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be a positive integer`)
  }
}

function assertRfc3339(value: unknown, field: string): asserts value is string {
  assertString(value, field)
  const millis = Date.parse(value)
  if (!Number.isFinite(millis) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be RFC3339`)
  }
}

function assertOrderedInterval(start: string, end: string, name: string): void {
  if (Date.parse(start) >= Date.parse(end)) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${name} interval must be non-empty`)
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be a UUID`)
  }
}

export function sortedUnique(values: readonly string[], field = 'set-like array'): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length === 0)) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must contain non-empty strings`)
  }
  const sorted = [...values].sort()
  if (sorted.some((value, index) => index > 0 && value === sorted[index - 1])) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} contains duplicates`)
  }
  return sorted
}

function assertAlreadySortedUnique(values: unknown, field: string): asserts values is string[] {
  if (!Array.isArray(values)) throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must be an array`)
  const canonical = sortedUnique(values as string[], field)
  if (canonical.some((value, index) => value !== values[index])) {
    throw new ContractValidationError('STRICT_DECODE_FAILED', `${field} must already be sorted`)
  }
}

export interface ConnectorDeliveryCapabilityV1 {
  schema_version: 'aun-connector-delivery-capability/v1'
  connector_instance_id: string
  connector_kind: string
  idempotency_mode: 'native' | 'lookup' | 'none'
  receipt_mode: 'provider_ack' | 'durable_handoff' | 'none'
  dedupe_scope: 'same_author' | 'channel' | 'thread' | 'connector_instance' | null
  dedupe_window_seconds: number | null
  provider_nonce_max_bytes: number | null
  provider_nonce_charset: string | null
  semantic_capabilities: Array<'post_message' | 'reply_context' | 'direct_attention'>
  reconciliation_mode: 'provider_lookup' | 'durable_ledger_lookup' | 'none'
  guarantee: 'effectively_once' | 'at_least_once'
  typed_rate_limit_retry_budget: number
  ambiguous_outcome_retry_budget: 0
  adapter_contract_version: string
  adapter_build_digest: Sha256
  capability_fixture_set_digest: Sha256
  capability_digest: Sha256
}

const CONNECTOR_CAPABILITY_FIELDS = [
  'schema_version', 'connector_instance_id', 'connector_kind', 'idempotency_mode', 'receipt_mode',
  'dedupe_scope', 'dedupe_window_seconds', 'provider_nonce_max_bytes', 'provider_nonce_charset',
  'semantic_capabilities', 'reconciliation_mode', 'guarantee', 'typed_rate_limit_retry_budget',
  'ambiguous_outcome_retry_budget', 'adapter_contract_version', 'adapter_build_digest',
  'capability_fixture_set_digest', 'capability_digest',
] as const

export function connectorCapabilityDigest(value: Omit<ConnectorDeliveryCapabilityV1, 'capability_digest'> | ConnectorDeliveryCapabilityV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.capability, withoutField(value as unknown as Record<string, unknown>, 'capability_digest'))
}

export function decodeConnectorCapability(value: unknown): ConnectorDeliveryCapabilityV1 {
  assertExactKeys(value, CONNECTOR_CAPABILITY_FIELDS, 'ConnectorDeliveryCapabilityV1')
  const capability = value as unknown as ConnectorDeliveryCapabilityV1
  if (capability.schema_version !== 'aun-connector-delivery-capability/v1') throw new ContractValidationError('CAPABILITY_UNPROVEN', 'wrong capability schema')
  assertUuid(capability.connector_instance_id, 'connector_instance_id')
  assertString(capability.connector_kind, 'connector_kind')
  assertString(capability.adapter_contract_version, 'adapter_contract_version')
  for (const field of ['adapter_build_digest', 'capability_fixture_set_digest', 'capability_digest'] as const) assertSha(capability[field], field)
  assertAlreadySortedUnique(capability.semantic_capabilities, 'semantic_capabilities')
  if (capability.semantic_capabilities.some(item => !['post_message', 'reply_context', 'direct_attention'].includes(item))) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'unknown semantic capability')
  if (!['native', 'lookup', 'none'].includes(capability.idempotency_mode)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid idempotency_mode')
  if (!['provider_ack', 'durable_handoff', 'none'].includes(capability.receipt_mode)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid receipt_mode')
  if (capability.dedupe_scope !== null && !['same_author', 'channel', 'thread', 'connector_instance'].includes(capability.dedupe_scope)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid dedupe_scope')
  if (!['provider_lookup', 'durable_ledger_lookup', 'none'].includes(capability.reconciliation_mode)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid reconciliation_mode')
  if (!['effectively_once', 'at_least_once'].includes(capability.guarantee)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid guarantee')
  assertNonNegativeInteger(capability.typed_rate_limit_retry_budget, 'typed_rate_limit_retry_budget')
  if (capability.ambiguous_outcome_retry_budget !== 0) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'ambiguous outcome budget must be zero')
  if (capability.guarantee === 'effectively_once' && capability.idempotency_mode === 'none') throw new ContractValidationError('CAPABILITY_UNPROVEN', 'effectively_once requires idempotency')
  if (capability.idempotency_mode === 'native') {
    if (capability.dedupe_scope === null) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'native idempotency requires a dedupe scope')
    if (capability.dedupe_window_seconds !== null) assertPositiveInteger(capability.dedupe_window_seconds, 'dedupe_window_seconds')
    if (capability.provider_nonce_max_bytes !== null) assertPositiveInteger(capability.provider_nonce_max_bytes, 'provider_nonce_max_bytes')
    assertNullableString(capability.provider_nonce_charset, 'provider_nonce_charset')
  } else {
    if (capability.dedupe_window_seconds !== null) assertPositiveInteger(capability.dedupe_window_seconds, 'dedupe_window_seconds')
    if (capability.provider_nonce_max_bytes !== null) assertPositiveInteger(capability.provider_nonce_max_bytes, 'provider_nonce_max_bytes')
    assertNullableString(capability.provider_nonce_charset, 'provider_nonce_charset')
  }
  if (connectorCapabilityDigest(capability) !== capability.capability_digest) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'capability digest differs')
  return capability
}

export interface CapabilityAuthorityV1 {
  source: 'registered_loaded_adapter'
  connector_instance_id: string
  adapter_contract_version: string
  adapter_build_digest: Sha256
  capability_digest: Sha256
  capability_fixture_set_digest: Sha256
  loaded_registration_digest: Sha256
  caller_supplied_capability_is_authority: false
}

export interface LoadedConnectorRegistrationV1 {
  schema_version: 'aun-loaded-connector-registration/v1'
  registration_id: string
  connector_instance_id: string
  connector_kind: string
  loaded_adapter_instance_id: string
  adapter_contract_version: string
  adapter_build_digest: Sha256
  canonical_capability_digest: Sha256
  fixture_manifest_version: string
  fixture_manifest_digest: Sha256
  build_test_attestation_ref: string
  build_test_attestation_digest: Sha256
  loader_identity_digest: Sha256
  registry_generation: number
  status: 'active' | 'revoked'
  registration_digest: Sha256
}

const LOADED_REGISTRATION_FIELDS = [
  'schema_version', 'registration_id', 'connector_instance_id', 'connector_kind',
  'loaded_adapter_instance_id', 'adapter_contract_version', 'adapter_build_digest',
  'canonical_capability_digest', 'fixture_manifest_version', 'fixture_manifest_digest',
  'build_test_attestation_ref', 'build_test_attestation_digest', 'loader_identity_digest',
  'registry_generation', 'status', 'registration_digest',
] as const

export function loadedConnectorRegistrationDigest(value: Omit<LoadedConnectorRegistrationV1, 'registration_digest'> | LoadedConnectorRegistrationV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.loadedRegistration, withoutField(value as unknown as Record<string, unknown>, 'registration_digest'))
}

export function decodeLoadedConnectorRegistration(value: unknown): LoadedConnectorRegistrationV1 {
  assertExactKeys(value, LOADED_REGISTRATION_FIELDS, 'LoadedConnectorRegistrationV1')
  const registration = value as unknown as LoadedConnectorRegistrationV1
  if (registration.schema_version !== 'aun-loaded-connector-registration/v1') throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'wrong loaded registration schema')
  assertUuid(registration.registration_id, 'registration_id')
  assertUuid(registration.connector_instance_id, 'connector_instance_id')
  for (const field of ['connector_kind', 'loaded_adapter_instance_id', 'adapter_contract_version', 'fixture_manifest_version', 'build_test_attestation_ref'] as const) assertString(registration[field], field)
  for (const field of ['adapter_build_digest', 'canonical_capability_digest', 'fixture_manifest_digest', 'build_test_attestation_digest', 'loader_identity_digest', 'registration_digest'] as const) assertSha(registration[field], field)
  assertPositiveInteger(registration.registry_generation, 'registry_generation')
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(registration.fixture_manifest_version)) throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'fixture manifest version must be semver')
  if (!['active', 'revoked'].includes(registration.status)) throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'invalid registration status')
  if (loadedConnectorRegistrationDigest(registration) !== registration.registration_digest) throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'registration digest differs')
  return registration
}

export function loadedConnectorRegistrationEventId(registrationId: string, registryGeneration: number): string {
  assertUuid(registrationId, 'registration_id')
  assertPositiveInteger(registryGeneration, 'registry_generation')
  const digest = digestCanonical(CONTRACT_DOMAINS.loadedRegistrationKey, {
    registration_id: registrationId,
    registry_generation: registryGeneration,
  })
  return `loaded-connector-registration:${digest}`
}

export const LOADED_CONNECTOR_REGISTRATION_EVENT_ID_VECTOR = {
  registration_id: '00000000-0000-4000-8000-000000000001',
  registry_generation: 1,
  domain_utf8_bytes: 41,
  canonical_key_utf8_bytes: 82,
  complete_preimage_utf8_bytes: 123,
  sha256: '5c0fce43316c349afba145d811fb119c9f17dcc1a2c1b34de86ed90ad63b6eb1',
  event_id: 'loaded-connector-registration:5c0fce43316c349afba145d811fb119c9f17dcc1a2c1b34de86ed90ad63b6eb1',
} as const

export const AUTHORITY_SUBJECT_EVENT_TYPES = [
  'authority.loaded_connector_registered',
  'authority.zero_effect_producer_registered',
  'authority.retry_budget_issuer_registered',
] as const

export const PROTECTED_AUTHORITY_EVENT_TYPES = [
  ...AUTHORITY_SUBJECT_EVENT_TYPES,
  'authority.connector_registry_admission_recorded',
  'authority.reopen_scan_cursor_advanced',
] as const

export type AuthoritySubjectEventType = (typeof AUTHORITY_SUBJECT_EVENT_TYPES)[number]
export type ProtectedAuthorityEventType = (typeof PROTECTED_AUTHORITY_EVENT_TYPES)[number]
export type AuthorityAdmissionVerificationKind =
  | 'loaded_build_and_fixture'
  | 'zero_effect_producer'
  | 'retry_budget_issuer_and_policy'

export function isProtectedAuthorityEventType(value: string): value is ProtectedAuthorityEventType {
  return (PROTECTED_AUTHORITY_EVENT_TYPES as readonly string[]).includes(value)
}

export interface AuthorityAdmissionMaterialV2 {
  subject_event_id: string
  subject_event_type: AuthoritySubjectEventType
  subject_conflict_material_digest: Sha256
  subject_payload_digest: Sha256
  registration_id: string
  connector_instance_id: string
  registry_generation: number
  capability_digest: Sha256
  loader_catalog_digest: Sha256
  loader_identity_digest: Sha256
  verification_kind: AuthorityAdmissionVerificationKind
  verifier_contract_version: string
  build_test_attestation_digest: Sha256
  policy_source_digest: Sha256 | null
}

export interface AuthorityAdmissionReceiptV1 extends AuthorityAdmissionMaterialV2 {
  schema_version: 'aun-authority-admission-receipt/v1'
  admission_id: Sha256
  admission_digest: Sha256
}

const AUTHORITY_ADMISSION_MATERIAL_FIELDS = [
  'subject_event_id', 'subject_event_type', 'subject_conflict_material_digest',
  'subject_payload_digest', 'registration_id', 'connector_instance_id',
  'registry_generation', 'capability_digest', 'loader_catalog_digest',
  'loader_identity_digest', 'verification_kind', 'verifier_contract_version',
  'build_test_attestation_digest', 'policy_source_digest',
] as const

const AUTHORITY_ADMISSION_RECEIPT_FIELDS = [
  'schema_version', 'admission_id', ...AUTHORITY_ADMISSION_MATERIAL_FIELDS, 'admission_digest',
] as const

export function decodeAuthorityAdmissionMaterial(value: unknown): AuthorityAdmissionMaterialV2 {
  assertExactKeys(value, AUTHORITY_ADMISSION_MATERIAL_FIELDS, 'AuthorityAdmissionMaterialV2')
  const material = value as unknown as AuthorityAdmissionMaterialV2
  assertString(material.subject_event_id, 'subject_event_id')
  if (!(AUTHORITY_SUBJECT_EVENT_TYPES as readonly string[]).includes(material.subject_event_type)) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_SUBJECT_INVALID', 'unknown subject_event_type')
  }
  for (const field of [
    'subject_conflict_material_digest', 'subject_payload_digest', 'capability_digest',
    'loader_catalog_digest', 'loader_identity_digest', 'build_test_attestation_digest',
  ] as const) assertSha(material[field], field)
  assertUuid(material.registration_id, 'registration_id')
  assertUuid(material.connector_instance_id, 'connector_instance_id')
  assertPositiveInteger(material.registry_generation, 'registry_generation')
  assertString(material.verifier_contract_version, 'verifier_contract_version')
  if (![
    'loaded_build_and_fixture', 'zero_effect_producer', 'retry_budget_issuer_and_policy',
  ].includes(material.verification_kind)) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_SUBJECT_INVALID', 'unknown verification_kind')
  }
  const expectedKind: Record<AuthoritySubjectEventType, AuthorityAdmissionVerificationKind> = {
    'authority.loaded_connector_registered': 'loaded_build_and_fixture',
    'authority.zero_effect_producer_registered': 'zero_effect_producer',
    'authority.retry_budget_issuer_registered': 'retry_budget_issuer_and_policy',
  }
  if (expectedKind[material.subject_event_type] !== material.verification_kind) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_SUBJECT_INVALID', 'verification_kind differs from subject type')
  }
  assertNullableSha(material.policy_source_digest, 'policy_source_digest')
  if ((material.subject_event_type === 'authority.retry_budget_issuer_registered') !== (material.policy_source_digest !== null)) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_SUBJECT_INVALID', 'policy_source_digest one-of differs from subject type')
  }
  return material
}

export function authoritySubjectConflictMaterialDigest(conflictMaterial: unknown): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.authoritySubjectConflictMaterial, conflictMaterial)
}

export function authoritySubjectPayloadDigest(payload: unknown): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.authoritySubjectPayload, payload)
}

export function authorityAdmissionId(material: AuthorityAdmissionMaterialV2): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.authorityAdmissionId, decodeAuthorityAdmissionMaterial(material))
}

function receiptWithoutDigest(
  material: AuthorityAdmissionMaterialV2,
  admissionId = authorityAdmissionId(material),
): Omit<AuthorityAdmissionReceiptV1, 'admission_digest'> {
  return {
    schema_version: 'aun-authority-admission-receipt/v1',
    admission_id: admissionId,
    ...decodeAuthorityAdmissionMaterial(material),
  }
}

export function authorityAdmissionDigest(
  value: AuthorityAdmissionMaterialV2 | Omit<AuthorityAdmissionReceiptV1, 'admission_digest'>,
): Sha256 {
  const receipt = 'schema_version' in value
    ? value
    : receiptWithoutDigest(value)
  return digestCanonical(CONTRACT_DOMAINS.authorityAdmissionReceiptMaterial, receipt)
}

export function buildAuthorityAdmissionReceipt(
  material: AuthorityAdmissionMaterialV2,
): AuthorityAdmissionReceiptV1 {
  const withoutDigest = receiptWithoutDigest(material)
  return decodeAuthorityAdmissionReceipt({
    ...withoutDigest,
    admission_digest: authorityAdmissionDigest(withoutDigest),
  })
}

export function authorityAdmissionReceiptEventId(receipt: AuthorityAdmissionReceiptV1): string {
  const decoded = decodeAuthorityAdmissionReceipt(receipt)
  const key = {
    admission_id: decoded.admission_id,
    subject_event_id: decoded.subject_event_id,
    subject_event_type: decoded.subject_event_type,
    registry_generation: decoded.registry_generation,
    admission_digest: decoded.admission_digest,
  }
  return `authority-admission:${digestCanonical(CONTRACT_DOMAINS.authorityAdmissionReceiptEventId, key)}`
}

export function decodeAuthorityAdmissionReceipt(value: unknown): AuthorityAdmissionReceiptV1 {
  assertExactKeys(value, AUTHORITY_ADMISSION_RECEIPT_FIELDS, 'AuthorityAdmissionReceiptV1')
  const receipt = value as unknown as AuthorityAdmissionReceiptV1
  if (receipt.schema_version !== 'aun-authority-admission-receipt/v1') {
    throw new ContractValidationError('AUTHORITY_ADMISSION_RECEIPT_INVALID', 'wrong admission receipt schema')
  }
  assertSha(receipt.admission_id, 'admission_id')
  assertSha(receipt.admission_digest, 'admission_digest')
  const material: AuthorityAdmissionMaterialV2 = {
    subject_event_id: receipt.subject_event_id,
    subject_event_type: receipt.subject_event_type,
    subject_conflict_material_digest: receipt.subject_conflict_material_digest,
    subject_payload_digest: receipt.subject_payload_digest,
    registration_id: receipt.registration_id,
    connector_instance_id: receipt.connector_instance_id,
    registry_generation: receipt.registry_generation,
    capability_digest: receipt.capability_digest,
    loader_catalog_digest: receipt.loader_catalog_digest,
    loader_identity_digest: receipt.loader_identity_digest,
    verification_kind: receipt.verification_kind,
    verifier_contract_version: receipt.verifier_contract_version,
    build_test_attestation_digest: receipt.build_test_attestation_digest,
    policy_source_digest: receipt.policy_source_digest,
  }
  decodeAuthorityAdmissionMaterial(material)
  const expectedId = authorityAdmissionId(material)
  if (receipt.admission_id !== expectedId) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_ID_MISMATCH', 'admission_id differs')
  }
  const expectedDigest = authorityAdmissionDigest(receiptWithoutDigest(material, expectedId))
  if (receipt.admission_digest !== expectedDigest) {
    throw new ContractValidationError('AUTHORITY_ADMISSION_DIGEST_MISMATCH', 'admission_digest differs')
  }
  return receipt
}

export function authorityAdmissionReceiptEvent(receipt: AuthorityAdmissionReceiptV1): AppendEvent {
  const decoded = decodeAuthorityAdmissionReceipt(receipt)
  return {
    eventId: authorityAdmissionReceiptEventId(decoded),
    eventType: 'authority.connector_registry_admission_recorded',
    causationId: decoded.subject_event_id,
    payload: decoded as unknown as Record<string, unknown>,
  }
}

export type RegisteredReopenClassificationCode =
  | 'ELIGIBLE'
  | 'ALREADY_RESOLVED_OR_REOPENED'
  | 'MALFORMED_IMMUTABLE'
  | 'REQUEST_ID_OR_CONFLICT_MISMATCH'
  | 'SOURCE_INCOMPLETE_AT_FROZEN_EPOCH'
  | 'SOURCE_CONFLICT_IMMUTABLE'
  | 'AUTHORITY_SNAPSHOT_NOT_CURRENT'
  | 'ATOMIC_SET_QUARANTINED'

export interface RegisteredReopenScannedDispositionV1 {
  request_seq: number
  request_event_id: string
  request_conflict_material_digest: Sha256
  classification_code: RegisteredReopenClassificationCode
}

export interface RegisteredReopenScanCursorV1 {
  schema_version: 'aun-registered-reopen-scan-cursor/v1'
  selector_version: 'registered-reopen-selector/v1'
  predecessor_cursor_event_id: string
  cycle_source_epoch_seq: number
  page_start_after_request_seq: number
  page_start_after_request_event_id: string | null
  page_end_request_seq: number
  page_end_request_event_id: string | null
  cycle_exhausted: boolean
  scanned_dispositions: RegisteredReopenScannedDispositionV1[]
  selected_request_event_id: string | null
  selected_result: 'reopened' | 'byte_identical_existing' | null
}

const REOPEN_CURSOR_FIELDS = [
  'schema_version', 'selector_version', 'predecessor_cursor_event_id',
  'cycle_source_epoch_seq', 'page_start_after_request_seq',
  'page_start_after_request_event_id', 'page_end_request_seq',
  'page_end_request_event_id', 'cycle_exhausted', 'scanned_dispositions',
  'selected_request_event_id', 'selected_result',
] as const

export function decodeRegisteredReopenScanCursor(value: unknown): RegisteredReopenScanCursorV1 {
  assertExactKeys(value, REOPEN_CURSOR_FIELDS, 'RegisteredReopenScanCursorV1')
  const cursor = value as unknown as RegisteredReopenScanCursorV1
  if (cursor.schema_version !== 'aun-registered-reopen-scan-cursor/v1' ||
      cursor.selector_version !== 'registered-reopen-selector/v1') {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'wrong cursor schema or selector version')
  }
  assertString(cursor.predecessor_cursor_event_id, 'predecessor_cursor_event_id')
  for (const field of [
    'cycle_source_epoch_seq', 'page_start_after_request_seq', 'page_end_request_seq',
  ] as const) assertNonNegativeInteger(cursor[field], field)
  assertNullableString(cursor.page_start_after_request_event_id, 'page_start_after_request_event_id')
  assertNullableString(cursor.page_end_request_event_id, 'page_end_request_event_id')
  assertNullableString(cursor.selected_request_event_id, 'selected_request_event_id')
  if (typeof cursor.cycle_exhausted !== 'boolean') {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'cycle_exhausted must be boolean')
  }
  if (cursor.selected_result !== null && !['reopened', 'byte_identical_existing'].includes(cursor.selected_result)) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'selected_result is invalid')
  }
  if (!Array.isArray(cursor.scanned_dispositions) || cursor.scanned_dispositions.length > 64) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'scanned dispositions must contain at most 64 rows')
  }
  let previous: [number, string] | null = null
  const admittedCodes: RegisteredReopenClassificationCode[] = [
    'ELIGIBLE', 'ALREADY_RESOLVED_OR_REOPENED', 'MALFORMED_IMMUTABLE',
    'REQUEST_ID_OR_CONFLICT_MISMATCH', 'SOURCE_INCOMPLETE_AT_FROZEN_EPOCH',
    'SOURCE_CONFLICT_IMMUTABLE', 'AUTHORITY_SNAPSHOT_NOT_CURRENT', 'ATOMIC_SET_QUARANTINED',
  ]
  for (const disposition of cursor.scanned_dispositions) {
    assertExactKeys(disposition, [
      'request_seq', 'request_event_id', 'request_conflict_material_digest', 'classification_code',
    ], 'RegisteredReopenScannedDispositionV1')
    assertPositiveInteger(disposition.request_seq, 'request_seq')
    assertString(disposition.request_event_id, 'request_event_id')
    assertSha(disposition.request_conflict_material_digest, 'request_conflict_material_digest')
    if (!admittedCodes.includes(disposition.classification_code)) {
      throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'unknown classification code')
    }
    const tuple: [number, string] = [disposition.request_seq, disposition.request_event_id]
    if (previous && (tuple[0] < previous[0] || tuple[0] === previous[0] && tuple[1] <= previous[1])) {
      throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'dispositions are not strictly ordered')
    }
    previous = tuple
  }
  if ((cursor.page_start_after_request_seq === 0) !== (cursor.page_start_after_request_event_id === null)) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'page start tuple nullability differs')
  }
  if ((cursor.page_end_request_seq === 0) !== (cursor.page_end_request_event_id === null)) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'page end tuple nullability differs')
  }
  if (cursor.page_end_request_seq < cursor.page_start_after_request_seq ||
      cursor.cycle_source_epoch_seq < cursor.page_end_request_seq) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'cursor tuple moved backward or past epoch')
  }
  const first = cursor.scanned_dispositions[0]
  const last = cursor.scanned_dispositions.at(-1)
  if (!first) {
    if (
      cursor.page_end_request_seq !== cursor.page_start_after_request_seq ||
      cursor.page_end_request_event_id !== cursor.page_start_after_request_event_id
    ) throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'empty page changed its tuple')
  } else {
    if (
      first.request_seq < cursor.page_start_after_request_seq ||
      first.request_seq === cursor.page_start_after_request_seq &&
        first.request_event_id <= (cursor.page_start_after_request_event_id ?? '')
    ) throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'first disposition is not after page start')
    if (
      last!.request_seq !== cursor.page_end_request_seq ||
      last!.request_event_id !== cursor.page_end_request_event_id
    ) throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'page end differs from last disposition')
  }
  const eligible = cursor.scanned_dispositions.filter(item => item.classification_code === 'ELIGIBLE')
  if (cursor.selected_request_event_id === null) {
    if (cursor.selected_result !== null || eligible.length !== 0) {
      throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'unselected cursor contains an eligible result')
    }
  } else if (
    cursor.selected_result === null ||
    cursor.cycle_exhausted ||
    eligible.length !== 1 ||
    eligible[0] !== last ||
    last?.request_event_id !== cursor.selected_request_event_id
  ) {
    throw new ContractValidationError('REGISTERED_REOPEN_CURSOR_CORRUPT', 'selected result does not bind the last eligible disposition')
  }
  return cursor
}

export function registeredReopenCursorEventId(predecessorCursorEventId: string): string {
  assertString(predecessorCursorEventId, 'predecessor_cursor_event_id')
  return `authority-reopen-scan-cursor:${digestCanonical(CONTRACT_DOMAINS.registeredReopenCursorSuccessor, {
    selector_version: 'registered-reopen-selector/v1',
    predecessor_cursor_event_id: predecessorCursorEventId,
  })}`
}

export function registeredReopenCursorEvent(cursor: RegisteredReopenScanCursorV1): AppendEvent {
  const decoded = decodeRegisteredReopenScanCursor(cursor)
  return {
    eventId: registeredReopenCursorEventId(decoded.predecessor_cursor_event_id),
    eventType: 'authority.reopen_scan_cursor_advanced',
    causationId: decoded.selected_request_event_id,
    payload: decoded as unknown as Record<string, unknown>,
  }
}

export interface ConnectorAddressV1 {
  schema_version: 'aun-connector-address/v1'
  connector_instance_id: string
  opaque_address_token: string
  destination_ref: Sha256
  resolved_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
}

export interface ResolvedDeliveryBindingSnapshotV1 {
  schema_version: 'aun-resolved-delivery-binding-snapshot/v1'
  channel_binding_id: string
  channel_id: string
  connector_instance_id: string
  connector_kind: string
  provider: string
  provider_identity_fingerprint: Sha256
  provider_channel_access_id: string
  channel_access_generation_or_digest: string
  projection_identity_id: string | null
  binding_role: 'outbound' | 'bidirectional' | 'projection'
  status: 'active' | 'inactive'
  priority: number
  ordering_scope: 'none' | 'channel' | 'thread' | 'custom'
  policy_source: string
  routing_metadata_allowlist: Record<string, string | number | boolean | null>
  opaque_address_fingerprint: Sha256
  capability_digest: Sha256
  resolver_version: string
}

export interface ResolvedDeliveryDecisionV1 {
  schema_version: 'aun-resolved-delivery-decision/v1'
  resolution_input_digest: Sha256
  evaluated_candidate_set_digest: Sha256
  eligible_candidate_set_digest: Sha256
  selected_route_digest: Sha256
  policy_digest: Sha256
  resolver_version: string
  selected_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
}

const SNAPSHOT_FIELDS = [
  'schema_version', 'channel_binding_id', 'channel_id', 'connector_instance_id', 'connector_kind',
  'provider', 'provider_identity_fingerprint', 'provider_channel_access_id',
  'channel_access_generation_or_digest', 'projection_identity_id', 'binding_role', 'status',
  'priority', 'ordering_scope', 'policy_source', 'routing_metadata_allowlist',
  'opaque_address_fingerprint', 'capability_digest', 'resolver_version',
] as const

const DECISION_FIELDS = [
  'schema_version', 'resolution_input_digest', 'evaluated_candidate_set_digest',
  'eligible_candidate_set_digest', 'selected_route_digest', 'policy_digest', 'resolver_version',
  'selected_binding_snapshot_digest', 'resolved_delivery_decision_digest',
] as const

export function bindingSnapshotDigest(snapshot: ResolvedDeliveryBindingSnapshotV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.bindingSnapshot, snapshot)
}

export function decodeBindingSnapshot(value: unknown): ResolvedDeliveryBindingSnapshotV1 {
  assertExactKeys(value, SNAPSHOT_FIELDS, 'ResolvedDeliveryBindingSnapshotV1')
  const snapshot = value as unknown as ResolvedDeliveryBindingSnapshotV1
  if (snapshot.schema_version !== 'aun-resolved-delivery-binding-snapshot/v1') throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'wrong binding snapshot schema')
  assertUuid(snapshot.channel_binding_id, 'channel_binding_id')
  assertUuid(snapshot.connector_instance_id, 'connector_instance_id')
  for (const field of ['channel_id', 'connector_kind', 'provider', 'provider_channel_access_id', 'channel_access_generation_or_digest', 'policy_source', 'resolver_version'] as const) assertString(snapshot[field], field)
  assertNullableString(snapshot.projection_identity_id, 'projection_identity_id')
  for (const field of ['provider_identity_fingerprint', 'opaque_address_fingerprint', 'capability_digest'] as const) assertSha(snapshot[field], field)
  if (!['outbound', 'bidirectional', 'projection'].includes(snapshot.binding_role)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'invalid binding_role')
  if (!['active', 'inactive'].includes(snapshot.status)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'invalid binding status')
  if (!['none', 'channel', 'thread', 'custom'].includes(snapshot.ordering_scope)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'invalid ordering_scope')
  if (!Number.isSafeInteger(snapshot.priority)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'priority must be an integer')
  if (!isPlainObject(snapshot.routing_metadata_allowlist)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'routing metadata must be an object')
  for (const [key, item] of Object.entries(snapshot.routing_metadata_allowlist)) {
    assertString(key, 'routing metadata key')
    if (!(item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isSafeInteger(item)))) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'routing metadata contains a noncanonical value')
  }
  return snapshot
}

export function resolvedDeliveryDecisionDigest(value: Omit<ResolvedDeliveryDecisionV1, 'resolved_delivery_decision_digest'> | ResolvedDeliveryDecisionV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.resolvedDeliveryDecision, withoutField(value as unknown as Record<string, unknown>, 'resolved_delivery_decision_digest'))
}

export function decodeResolvedDeliveryDecision(value: unknown): ResolvedDeliveryDecisionV1 {
  assertExactKeys(value, DECISION_FIELDS, 'ResolvedDeliveryDecisionV1')
  const decision = value as unknown as ResolvedDeliveryDecisionV1
  if (decision.schema_version !== 'aun-resolved-delivery-decision/v1') throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'wrong decision schema')
  for (const field of ['resolution_input_digest', 'evaluated_candidate_set_digest', 'eligible_candidate_set_digest', 'selected_route_digest', 'policy_digest', 'selected_binding_snapshot_digest', 'resolved_delivery_decision_digest'] as const) assertSha(decision[field], field)
  assertString(decision.resolver_version, 'resolver_version')
  if (resolvedDeliveryDecisionDigest(decision) !== decision.resolved_delivery_decision_digest) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'decision digest differs')
  return decision
}

export interface DeliveryIdempotencyV1 {
  schema_version: 'aun-delivery-idempotency/v1'
  business_nonce: string
  provider_nonce: string
  derivation_version: 'aun-provider-nonce/v1'
  delivery_digest: Sha256
  required_guarantee: 'effectively_once' | 'at_least_once'
}

export interface FanoutChildProvenanceV1 {
  schema_version: 'aun-fanout-child-provenance/v1'
  fanout_planned_event_id: string
  fanout_id: string
  fanout_digest: Sha256
  parent_reply_id: string
  provenance_digest: Sha256
}

export interface DeliveryDigestMaterialV1 {
  schema_version: 'aun-delivery-digest-material/v1'
  delivery_id: string
  sender_seat_id: string
  recipient_seat_id: string
  conversation_id: string
  turn_id: string
  reply_id: string
  correlation_id: string | null
  causation_id: string | null
  content: { media_type: 'text/plain'; text: string }
  destination_ref: Sha256
  resolved_binding_snapshot_digest: Sha256
  capability_digest: Sha256
  required_semantic_capabilities: Array<'post_message' | 'reply_context' | 'direct_attention'>
  required_receipt_mode: 'provider_ack' | 'durable_handoff' | 'none'
  business_nonce: string
  required_guarantee: 'effectively_once' | 'at_least_once'
  fanout_child_provenance: FanoutChildProvenanceV1 | null
}

export interface DeliveryUnitV1 extends Omit<DeliveryDigestMaterialV1, 'schema_version'> {
  schema_version: 'aun-delivery-unit/v1'
  destination: ConnectorAddressV1
  resolved_binding_snapshot: ResolvedDeliveryBindingSnapshotV1
  resolved_delivery_decision: ResolvedDeliveryDecisionV1
  connector_capability: ConnectorDeliveryCapabilityV1
  capability_authority: CapabilityAuthorityV1
  idempotency: DeliveryIdempotencyV1
}

export function deliveryDigest(material: DeliveryDigestMaterialV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.delivery, material)
}

export function providerNonce(businessNonce: string, digest: Sha256): string {
  assertString(businessNonce, 'business_nonce')
  assertSha(digest, 'delivery_digest')
  const encoded = createHash('sha256')
    .update(CONTRACT_DOMAINS.providerNonce + businessNonce + '\n' + digest, 'utf8')
    .digest('base64url')
  return `a1_${encoded.slice(0, 22)}`
}

export function destinationRef(connectorInstanceId: string, opaqueAddressToken: string): Sha256 {
  assertUuid(connectorInstanceId, 'connector_instance_id')
  assertString(opaqueAddressToken, 'opaque_address_token')
  return sha256Utf8(CONTRACT_DOMAINS.destination + connectorInstanceId + '\n' + opaqueAddressToken)
}

export function opaqueAddressFingerprint(opaqueAddressToken: string): Sha256 {
  assertString(opaqueAddressToken, 'opaque_address_token')
  return sha256Utf8(CONTRACT_DOMAINS.opaqueAddress + opaqueAddressToken)
}

export interface ProviderDedupeScopeIdentityMaterialV1 {
  connector_instance_id: string
  dedupe_scope: 'same_author' | 'channel' | 'thread' | 'connector_instance'
  provider_author_identity_id: string | null
  provider_author_identity_fingerprint: Sha256 | null
  channel_scope_ref: Sha256 | null
  thread_scope_ref: Sha256 | null
}

export function validateProviderDedupeScopeIdentity(value: ProviderDedupeScopeIdentityMaterialV1): void {
  assertExactKeys(value, ['connector_instance_id', 'dedupe_scope', 'provider_author_identity_id', 'provider_author_identity_fingerprint', 'channel_scope_ref', 'thread_scope_ref'], 'ProviderDedupeScopeIdentityMaterialV1')
  assertUuid(value.connector_instance_id, 'connector_instance_id')
  if (!['same_author', 'channel', 'thread', 'connector_instance'].includes(value.dedupe_scope)) {
    throw new ContractValidationError('INVALID_DEDUPE_SCOPE', 'unknown dedupe_scope')
  }
  assertNullableString(value.provider_author_identity_id, 'provider_author_identity_id')
  assertNullableSha(value.provider_author_identity_fingerprint, 'provider_author_identity_fingerprint')
  assertNullableSha(value.channel_scope_ref, 'channel_scope_ref')
  assertNullableSha(value.thread_scope_ref, 'thread_scope_ref')
  if (value.dedupe_scope === 'same_author') {
    assertString(value.provider_author_identity_id, 'provider_author_identity_id')
    assertSha(value.provider_author_identity_fingerprint, 'provider_author_identity_fingerprint')
    if (value.channel_scope_ref !== null || value.thread_scope_ref !== null) throw new ContractValidationError('INVALID_DEDUPE_SCOPE', 'same_author forbids channel/thread scope refs')
  } else if (value.dedupe_scope === 'channel') {
    assertSha(value.channel_scope_ref, 'channel_scope_ref')
    if (value.provider_author_identity_id !== null || value.provider_author_identity_fingerprint !== null || value.thread_scope_ref !== null) throw new ContractValidationError('INVALID_DEDUPE_SCOPE', 'channel admits only channel_scope_ref')
  } else if (value.dedupe_scope === 'thread') {
    assertSha(value.channel_scope_ref, 'channel_scope_ref')
    assertSha(value.thread_scope_ref, 'thread_scope_ref')
    if (value.provider_author_identity_id !== null || value.provider_author_identity_fingerprint !== null) throw new ContractValidationError('INVALID_DEDUPE_SCOPE', 'thread forbids author scope')
  } else if ([value.provider_author_identity_id, value.provider_author_identity_fingerprint, value.channel_scope_ref, value.thread_scope_ref].some(item => item !== null)) {
    throw new ContractValidationError('INVALID_DEDUPE_SCOPE', 'connector_instance requires all optional refs null')
  }
}

export function providerDedupeScopeDigest(value: ProviderDedupeScopeIdentityMaterialV1): Sha256 {
  validateProviderDedupeScopeIdentity(value)
  return digestCanonical(CONTRACT_DOMAINS.providerDedupeScope, value)
}

export interface ProviderNonceReservationKeyV1 {
  connector_instance_id: string
  concrete_dedupe_scope_identity: Sha256
  provider_nonce: string
}

export interface ProviderNonceReservationValueV1 {
  business_nonce: string
  delivery_digest: Sha256
  adapter_build_digest: Sha256
}

export interface ProviderNonceReservationPayloadV1 {
  key: ProviderNonceReservationKeyV1
  value: ProviderNonceReservationValueV1
}

export interface ProviderInvocationStartPayloadV1 {
  delivery_id: string
  reply_id: string
  recipient_seat_id: string
  attempt_ordinal: number
  provider_nonce: string
  delivery_digest: Sha256
  provider_request_digest: Sha256
}

export function decodeProviderNonceReservation(value: unknown): ProviderNonceReservationPayloadV1 {
  assertExactKeys(value, ['key', 'value'], 'ProviderNonceReservationPayloadV1')
  const reservation = value as unknown as ProviderNonceReservationPayloadV1
  assertExactKeys(reservation.key, ['connector_instance_id', 'concrete_dedupe_scope_identity', 'provider_nonce'], 'ProviderNonceReservationKeyV1')
  assertExactKeys(reservation.value, ['business_nonce', 'delivery_digest', 'adapter_build_digest'], 'ProviderNonceReservationValueV1')
  assertUuid(reservation.key.connector_instance_id, 'connector_instance_id')
  assertSha(reservation.key.concrete_dedupe_scope_identity, 'concrete_dedupe_scope_identity')
  assertString(reservation.key.provider_nonce, 'provider_nonce')
  assertString(reservation.value.business_nonce, 'business_nonce')
  assertSha(reservation.value.delivery_digest, 'delivery_digest')
  assertSha(reservation.value.adapter_build_digest, 'adapter_build_digest')
  return reservation
}

export function providerNonceReservationEventId(key: ProviderNonceReservationKeyV1): string {
  decodeProviderNonceReservation({
    key,
    value: {
      business_nonce: 'validation-only',
      delivery_digest: '0'.repeat(64),
      adapter_build_digest: '0'.repeat(64),
    },
  })
  return `provider-nonce-reservation:${digestCanonical(CONTRACT_DOMAINS.providerNonceReservationKey, key)}`
}

export function decodeProviderInvocationStart(value: unknown): ProviderInvocationStartPayloadV1 {
  assertExactKeys(value, ['delivery_id', 'reply_id', 'recipient_seat_id', 'attempt_ordinal', 'provider_nonce', 'delivery_digest', 'provider_request_digest'], 'ProviderInvocationStartPayloadV1')
  const start = value as unknown as ProviderInvocationStartPayloadV1
  for (const field of ['delivery_id', 'reply_id', 'recipient_seat_id', 'provider_nonce'] as const) assertString(start[field], field)
  assertNonNegativeInteger(start.attempt_ordinal, 'attempt_ordinal')
  for (const field of ['delivery_digest', 'provider_request_digest'] as const) assertSha(start[field], field)
  return start
}

export function providerInvocationStartEventId(deliveryId: string, attemptOrdinal: number): string {
  assertString(deliveryId, 'delivery_id')
  assertNonNegativeInteger(attemptOrdinal, 'attempt_ordinal')
  return `provider-invocation-started:${digestCanonical(CONTRACT_DOMAINS.providerInvocationStart, { delivery_id: deliveryId, attempt_ordinal: attemptOrdinal })}`
}

export function validateDeliveryUnit(
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
): void {
  const deliveryUnitFields = [
    'schema_version', 'delivery_id', 'sender_seat_id', 'recipient_seat_id', 'conversation_id',
    'turn_id', 'reply_id', 'correlation_id', 'causation_id', 'content', 'destination_ref',
    'resolved_binding_snapshot_digest', 'capability_digest', 'required_semantic_capabilities',
    'required_receipt_mode', 'business_nonce', 'required_guarantee', 'fanout_child_provenance',
    'destination', 'resolved_binding_snapshot', 'resolved_delivery_decision', 'connector_capability',
    'capability_authority', 'idempotency',
  ] as const
  assertExactKeys(unit, deliveryUnitFields, 'DeliveryUnitV1')
  if (unit.schema_version !== 'aun-delivery-unit/v1') throw new ContractValidationError('INVALID_DELIVERY_UNIT', 'wrong schema_version')
  for (const field of ['delivery_id', 'sender_seat_id', 'recipient_seat_id', 'conversation_id', 'turn_id', 'reply_id', 'business_nonce'] as const) assertString(unit[field], field)
  assertNullableString(unit.correlation_id, 'correlation_id')
  assertNullableString(unit.causation_id, 'causation_id')
  assertExactKeys(unit.content, ['media_type', 'text'], 'delivery content')
  if (unit.content.media_type !== 'text/plain') throw new ContractValidationError('INVALID_DELIVERY_UNIT', 'unsupported content media type')
  assertString(unit.content.text, 'content.text')
  assertSha(unit.destination_ref, 'destination_ref')
  assertSha(unit.resolved_binding_snapshot_digest, 'resolved_binding_snapshot_digest')
  assertSha(unit.capability_digest, 'capability_digest')
  assertAlreadySortedUnique(unit.required_semantic_capabilities, 'required_semantic_capabilities')
  if (unit.required_semantic_capabilities.some(item => !['post_message', 'reply_context', 'direct_attention'].includes(item))) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'unknown required semantic capability')
  decodeBindingSnapshot(unit.resolved_binding_snapshot)
  decodeResolvedDeliveryDecision(unit.resolved_delivery_decision)
  decodeConnectorCapability(unit.connector_capability)
  const registration = decodeLoadedConnectorRegistration(loadedRegistration)
  if (registration.status !== 'active') throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'loaded registration is not active')
  assertExactKeys(unit.destination, ['schema_version', 'connector_instance_id', 'opaque_address_token', 'destination_ref', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest'], 'ConnectorAddressV1')
  if (unit.destination.schema_version !== 'aun-connector-address/v1') throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'wrong address schema')
  assertUuid(unit.destination.connector_instance_id, 'destination.connector_instance_id')
  assertString(unit.destination.opaque_address_token, 'destination.opaque_address_token')
  for (const field of ['destination_ref', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest'] as const) assertSha(unit.destination[field], `destination.${field}`)
  assertExactKeys(unit.capability_authority, ['source', 'connector_instance_id', 'adapter_contract_version', 'adapter_build_digest', 'capability_digest', 'capability_fixture_set_digest', 'loaded_registration_digest', 'caller_supplied_capability_is_authority'], 'CapabilityAuthorityV1')
  if (unit.capability_authority.source !== 'registered_loaded_adapter' || unit.capability_authority.caller_supplied_capability_is_authority !== false) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'caller or declaration is not capability authority')
  assertUuid(unit.capability_authority.connector_instance_id, 'capability_authority.connector_instance_id')
  assertString(unit.capability_authority.adapter_contract_version, 'capability_authority.adapter_contract_version')
  for (const field of ['adapter_build_digest', 'capability_digest', 'capability_fixture_set_digest', 'loaded_registration_digest'] as const) assertSha(unit.capability_authority[field], `capability_authority.${field}`)
  assertExactKeys(unit.idempotency, ['schema_version', 'business_nonce', 'provider_nonce', 'derivation_version', 'delivery_digest', 'required_guarantee'], 'DeliveryIdempotencyV1')
  if (unit.idempotency.schema_version !== 'aun-delivery-idempotency/v1' || unit.idempotency.derivation_version !== 'aun-provider-nonce/v1') throw new ContractValidationError('INVALID_DELIVERY_UNIT', 'wrong idempotency schema')
  assertString(unit.idempotency.business_nonce, 'idempotency.business_nonce')
  assertString(unit.idempotency.provider_nonce, 'idempotency.provider_nonce')
  assertSha(unit.idempotency.delivery_digest, 'idempotency.delivery_digest')
  if (!['effectively_once', 'at_least_once'].includes(unit.required_guarantee) || unit.idempotency.required_guarantee !== unit.required_guarantee || unit.connector_capability.guarantee !== unit.required_guarantee) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'guarantee mismatch')
  if (!['provider_ack', 'durable_handoff', 'none'].includes(unit.required_receipt_mode)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'invalid required receipt mode')
  if (unit.required_receipt_mode === 'provider_ack' && unit.connector_capability.receipt_mode !== 'provider_ack') throw new ContractValidationError('CAPABILITY_UNPROVEN', 'provider ack is not supported')
  if (unit.required_receipt_mode === 'durable_handoff' && !['provider_ack', 'durable_handoff'].includes(unit.connector_capability.receipt_mode)) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'durable handoff is not supported')
  if (unit.required_semantic_capabilities.some(item => !unit.connector_capability.semantic_capabilities.includes(item))) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'required semantic capability is absent')
  if (unit.destination.connector_instance_id !== unit.connector_capability.connector_instance_id || unit.destination.connector_instance_id !== unit.capability_authority.connector_instance_id) {
    throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'connector instance IDs differ')
  }
  if (unit.connector_capability.capability_digest !== unit.capability_digest || unit.capability_authority.capability_digest !== unit.capability_digest) {
    throw new ContractValidationError('CAPABILITY_UNPROVEN', 'capability digests differ')
  }
  if (unit.connector_capability.adapter_contract_version !== unit.capability_authority.adapter_contract_version || unit.connector_capability.adapter_build_digest !== unit.capability_authority.adapter_build_digest || unit.connector_capability.capability_fixture_set_digest !== unit.capability_authority.capability_fixture_set_digest) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'loaded adapter authority fields differ')
  if (
    registration.registration_digest !== unit.capability_authority.loaded_registration_digest ||
    registration.connector_instance_id !== unit.connector_capability.connector_instance_id ||
    registration.connector_kind !== unit.connector_capability.connector_kind ||
    registration.adapter_contract_version !== unit.connector_capability.adapter_contract_version ||
    registration.adapter_build_digest !== unit.connector_capability.adapter_build_digest ||
    registration.canonical_capability_digest !== unit.connector_capability.capability_digest ||
    registration.fixture_manifest_digest !== unit.connector_capability.capability_fixture_set_digest
  ) throw new ContractValidationError('LOADED_REGISTRATION_UNPROVEN', 'persisted loaded registration does not bind the delivery capability')
  if (
    unit.resolved_binding_snapshot.connector_instance_id !== unit.destination.connector_instance_id ||
    unit.resolved_binding_snapshot.connector_kind !== unit.connector_capability.connector_kind ||
    unit.resolved_binding_snapshot.capability_digest !== unit.capability_digest ||
    unit.resolved_binding_snapshot.status !== 'active'
  ) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'binding snapshot authority differs or is inactive')
  if (unit.destination.destination_ref !== unit.destination_ref) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'destination_ref differs')
  if (destinationRef(unit.destination.connector_instance_id, unit.destination.opaque_address_token) !== unit.destination_ref) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'destination_ref does not recompute')
  if (unit.destination.resolved_binding_snapshot_digest !== unit.resolved_binding_snapshot_digest) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'binding snapshot digest differs')
  if (bindingSnapshotDigest(unit.resolved_binding_snapshot) !== unit.resolved_binding_snapshot_digest) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'binding snapshot does not recompute')
  if (unit.destination.resolved_delivery_decision_digest !== unit.resolved_delivery_decision.resolved_delivery_decision_digest || unit.resolved_delivery_decision.selected_binding_snapshot_digest !== unit.resolved_binding_snapshot_digest) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'resolved decision binding differs')
  if (unit.resolved_delivery_decision.resolver_version !== unit.resolved_binding_snapshot.resolver_version) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'resolver versions differ')
  if (unit.resolved_binding_snapshot.opaque_address_fingerprint !== opaqueAddressFingerprint(unit.destination.opaque_address_token)) throw new ContractValidationError('DELIVERY_AUTHORITY_MISMATCH', 'opaque address fingerprint differs')
  if (unit.idempotency.business_nonce !== unit.business_nonce) throw new ContractValidationError('NONCE_COLLISION', 'business nonce differs')
  const material: DeliveryDigestMaterialV1 = {
    schema_version: 'aun-delivery-digest-material/v1',
    delivery_id: unit.delivery_id,
    sender_seat_id: unit.sender_seat_id,
    recipient_seat_id: unit.recipient_seat_id,
    conversation_id: unit.conversation_id,
    turn_id: unit.turn_id,
    reply_id: unit.reply_id,
    correlation_id: unit.correlation_id,
    causation_id: unit.causation_id,
    content: unit.content,
    destination_ref: unit.destination_ref,
    resolved_binding_snapshot_digest: unit.resolved_binding_snapshot_digest,
    capability_digest: unit.capability_digest,
    required_semantic_capabilities: unit.required_semantic_capabilities,
    required_receipt_mode: unit.required_receipt_mode,
    business_nonce: unit.business_nonce,
    required_guarantee: unit.required_guarantee,
    fanout_child_provenance: unit.fanout_child_provenance,
  }
  const expectedDigest = deliveryDigest(material)
  if (unit.idempotency.delivery_digest !== expectedDigest) throw new ContractValidationError('DELIVERY_DIGEST_MISMATCH', 'delivery digest does not match canonical material')
  const expectedNonce = providerNonce(unit.business_nonce, expectedDigest)
  if (unit.idempotency.provider_nonce !== expectedNonce) throw new ContractValidationError('PROVIDER_NONCE_MISMATCH', 'provider nonce does not match delivery')
  if (unit.connector_capability.provider_nonce_max_bytes !== null && Buffer.byteLength(expectedNonce, 'utf8') > unit.connector_capability.provider_nonce_max_bytes) throw new ContractValidationError('PROVIDER_NONCE_MISMATCH', 'provider nonce exceeds loaded capability ceiling')
  if (unit.connector_capability.provider_nonce_charset === 'ascii_base64url' && !/^[A-Za-z0-9_-]+$/.test(expectedNonce)) throw new ContractValidationError('PROVIDER_NONCE_MISMATCH', 'provider nonce violates loaded capability charset')
  if (unit.fanout_child_provenance !== null) decodeFanoutProvenance(unit.fanout_child_provenance)
}

export interface CanonicalDiscordMessageReferenceV1 {
  message_id: string
  channel_id: string
  guild_id: string | null
  fail_if_not_exists: boolean
}

export interface CanonicalDiscordAllowedMentionsV1 {
  parse: Array<'everyone' | 'roles' | 'users'>
  roles: string[]
  users: string[]
  replied_user: boolean
}

export interface DiscordProviderRequestV1 {
  schema_version: 'aun-discord-provider-request/v1'
  connector_instance_id: string
  adapter_build_digest: Sha256
  channel_id: string
  thread_id: string | null
  message_reference: CanonicalDiscordMessageReferenceV1 | null
  final_content_utf8: string
  allowed_mentions: CanonicalDiscordAllowedMentionsV1
  direct_attention_targets: string[]
  provider_nonce: string
  enforce_nonce: true
  projection_identity_id: string
  expected_mention_everyone: boolean
  expected_mentioned_user_ids: string[]
  expected_mentioned_role_ids: string[]
  provider_request_digest: Sha256
}

export interface DiscordProviderAckV1 {
  schema_version: 'aun-discord-provider-ack/v1'
  provider_request_digest: Sha256
  actual_provider_request_digest: Sha256
  message_id: string
  channel_id: string
  thread_id: string | null
  nonce: string
  author_id: string
  message_reference: CanonicalDiscordMessageReferenceV1 | null
  actual_content_utf8: string
  mention_everyone: boolean
  mentioned_user_ids: string[]
  mentioned_role_ids: string[]
  provider_response_digest: Sha256
}

const DISCORD_REQUEST_FIELDS = [
  'schema_version', 'connector_instance_id', 'adapter_build_digest', 'channel_id', 'thread_id',
  'message_reference', 'final_content_utf8', 'allowed_mentions', 'direct_attention_targets',
  'provider_nonce', 'enforce_nonce', 'projection_identity_id', 'expected_mention_everyone',
  'expected_mentioned_user_ids', 'expected_mentioned_role_ids', 'provider_request_digest',
] as const

export function discordProviderRequestDigest(request: Omit<DiscordProviderRequestV1, 'provider_request_digest'> | DiscordProviderRequestV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.discordRequest, withoutField(request as unknown as Record<string, unknown>, 'provider_request_digest'))
}

export function decodeDiscordProviderRequest(value: unknown): DiscordProviderRequestV1 {
  assertExactKeys(value, DISCORD_REQUEST_FIELDS, 'DiscordProviderRequestV1')
  const request = value as unknown as DiscordProviderRequestV1
  if (request.schema_version !== 'aun-discord-provider-request/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong Discord request schema')
  assertUuid(request.connector_instance_id, 'connector_instance_id')
  assertSha(request.adapter_build_digest, 'adapter_build_digest')
  assertString(request.channel_id, 'channel_id')
  assertNullableString(request.thread_id, 'thread_id')
  assertString(request.final_content_utf8, 'final_content_utf8')
  if (request.message_reference !== null) {
    assertExactKeys(request.message_reference, ['message_id', 'channel_id', 'guild_id', 'fail_if_not_exists'], 'message_reference')
    assertString(request.message_reference.message_id, 'message_reference.message_id')
    assertString(request.message_reference.channel_id, 'message_reference.channel_id')
    assertNullableString(request.message_reference.guild_id, 'message_reference.guild_id')
    if (typeof request.message_reference.fail_if_not_exists !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'message_reference.fail_if_not_exists must be boolean')
  }
  assertExactKeys(request.allowed_mentions, ['parse', 'roles', 'users', 'replied_user'], 'allowed_mentions')
  assertAlreadySortedUnique(request.allowed_mentions.parse, 'allowed_mentions.parse')
  if (request.allowed_mentions.parse.some(item => !['everyone', 'roles', 'users'].includes(item))) throw new ContractValidationError('STRICT_DECODE_FAILED', 'allowed_mentions.parse has an unknown value')
  assertAlreadySortedUnique(request.allowed_mentions.roles, 'allowed_mentions.roles')
  assertAlreadySortedUnique(request.allowed_mentions.users, 'allowed_mentions.users')
  if (typeof request.allowed_mentions.replied_user !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'allowed_mentions.replied_user must be boolean')
  assertAlreadySortedUnique(request.direct_attention_targets, 'direct_attention_targets')
  assertAlreadySortedUnique(request.expected_mentioned_user_ids, 'expected_mentioned_user_ids')
  assertAlreadySortedUnique(request.expected_mentioned_role_ids, 'expected_mentioned_role_ids')
  if (typeof request.expected_mention_everyone !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'expected_mention_everyone must be boolean')
  assertString(request.projection_identity_id, 'projection_identity_id')
  if (request.enforce_nonce !== true || request.provider_nonce.length !== 25 || !/^[A-Za-z0-9_-]+$/.test(request.provider_nonce)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'invalid enforced provider nonce')
  assertSha(request.provider_request_digest, 'provider_request_digest')
  if (discordProviderRequestDigest(request) !== request.provider_request_digest) throw new ContractValidationError('PROVIDER_REQUEST_DIGEST_MISMATCH', 'request digest differs')
  return request
}

export function discordActualRequestDigest(request: DiscordProviderRequestV1): Sha256 {
  return discordProviderRequestDigest(request)
}

export function discordProviderResponseDigest(ack: Omit<DiscordProviderAckV1, 'provider_response_digest'> | DiscordProviderAckV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.discordResponse, withoutField(ack as unknown as Record<string, unknown>, 'provider_response_digest'))
}

const DISCORD_ACK_FIELDS = [
  'schema_version', 'provider_request_digest', 'actual_provider_request_digest', 'message_id',
  'channel_id', 'thread_id', 'nonce', 'author_id', 'message_reference', 'actual_content_utf8',
  'mention_everyone', 'mentioned_user_ids', 'mentioned_role_ids', 'provider_response_digest',
] as const

export function decodeDiscordProviderAck(value: unknown): DiscordProviderAckV1 {
  assertExactKeys(value, DISCORD_ACK_FIELDS, 'DiscordProviderAckV1')
  const ack = value as unknown as DiscordProviderAckV1
  if (ack.schema_version !== 'aun-discord-provider-ack/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong Discord ack schema')
  for (const field of ['message_id', 'channel_id', 'nonce', 'author_id', 'actual_content_utf8'] as const) assertString(ack[field], field)
  assertNullableString(ack.thread_id, 'thread_id')
  for (const field of ['provider_request_digest', 'actual_provider_request_digest', 'provider_response_digest'] as const) assertSha(ack[field], field)
  if (ack.message_reference !== null) {
    assertExactKeys(ack.message_reference, ['message_id', 'channel_id', 'guild_id', 'fail_if_not_exists'], 'ack.message_reference')
    assertString(ack.message_reference.message_id, 'ack.message_reference.message_id')
    assertString(ack.message_reference.channel_id, 'ack.message_reference.channel_id')
    assertNullableString(ack.message_reference.guild_id, 'ack.message_reference.guild_id')
    if (typeof ack.message_reference.fail_if_not_exists !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'ack.message_reference.fail_if_not_exists must be boolean')
  }
  if (typeof ack.mention_everyone !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'mention_everyone must be boolean')
  assertAlreadySortedUnique(ack.mentioned_user_ids, 'mentioned_user_ids')
  assertAlreadySortedUnique(ack.mentioned_role_ids, 'mentioned_role_ids')
  if (discordProviderResponseDigest(ack) !== ack.provider_response_digest) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'response digest differs')
  return ack
}

export function validateDiscordProviderAck(request: DiscordProviderRequestV1, ack: DiscordProviderAckV1): void {
  decodeDiscordProviderRequest(request)
  decodeDiscordProviderAck(ack)
  if (ack.provider_request_digest !== request.provider_request_digest || ack.actual_provider_request_digest !== request.provider_request_digest) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'request digest mismatch')
  if (ack.channel_id !== request.channel_id || ack.thread_id !== request.thread_id || ack.nonce !== request.provider_nonce || ack.author_id !== request.projection_identity_id) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'destination, nonce, or author differs')
  if (canonicalJson(ack.message_reference) !== canonicalJson(request.message_reference)) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'message reference differs')
  if (ack.actual_content_utf8 !== request.final_content_utf8 || ack.mention_everyone !== request.expected_mention_everyone) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'content/everyone effect differs')
  if (canonicalJson(ack.mentioned_user_ids) !== canonicalJson(request.expected_mentioned_user_ids) || canonicalJson(ack.mentioned_role_ids) !== canonicalJson(request.expected_mentioned_role_ids)) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'mention effect differs')
}

export interface FrozenProviderRequestEnvelopeV1 {
  schema_version: 'aun-frozen-provider-request-envelope/v1'
  connector_kind: string
  connector_instance_id: string
  adapter_contract_version: string
  adapter_build_digest: Sha256
  provider_request_schema_version: string
  provider_request_digest: Sha256
  provider_request_payload: Record<string, unknown>
}

export interface ConnectorProviderAckEnvelopeV1 {
  schema_version: 'aun-connector-provider-ack-envelope/v1'
  connector_kind: string
  connector_instance_id: string
  adapter_contract_version: string
  adapter_build_digest: Sha256
  provider_ack_schema_version: string
  provider_request_digest: Sha256
  provider_ack_digest: Sha256
  provider_ack_payload: Record<string, unknown>
}

const FROZEN_REQUEST_ENVELOPE_FIELDS = ['schema_version', 'connector_kind', 'connector_instance_id', 'adapter_contract_version', 'adapter_build_digest', 'provider_request_schema_version', 'provider_request_digest', 'provider_request_payload'] as const
const PROVIDER_ACK_ENVELOPE_FIELDS = ['schema_version', 'connector_kind', 'connector_instance_id', 'adapter_contract_version', 'adapter_build_digest', 'provider_ack_schema_version', 'provider_request_digest', 'provider_ack_digest', 'provider_ack_payload'] as const

export function decodeFrozenProviderRequestEnvelope(value: unknown): FrozenProviderRequestEnvelopeV1 {
  assertExactKeys(value, FROZEN_REQUEST_ENVELOPE_FIELDS, 'FrozenProviderRequestEnvelopeV1')
  const envelope = value as unknown as FrozenProviderRequestEnvelopeV1
  if (envelope.schema_version !== 'aun-frozen-provider-request-envelope/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong frozen request envelope schema')
  assertString(envelope.connector_kind, 'connector_kind')
  assertUuid(envelope.connector_instance_id, 'connector_instance_id')
  assertString(envelope.adapter_contract_version, 'adapter_contract_version')
  assertSha(envelope.adapter_build_digest, 'adapter_build_digest')
  assertString(envelope.provider_request_schema_version, 'provider_request_schema_version')
  assertSha(envelope.provider_request_digest, 'provider_request_digest')
  if (!isPlainObject(envelope.provider_request_payload)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'provider_request_payload must be an object')
  return envelope
}

export function decodeConnectorProviderAckEnvelope(value: unknown): ConnectorProviderAckEnvelopeV1 {
  assertExactKeys(value, PROVIDER_ACK_ENVELOPE_FIELDS, 'ConnectorProviderAckEnvelopeV1')
  const envelope = value as unknown as ConnectorProviderAckEnvelopeV1
  if (envelope.schema_version !== 'aun-connector-provider-ack-envelope/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong provider ack envelope schema')
  assertString(envelope.connector_kind, 'connector_kind')
  assertUuid(envelope.connector_instance_id, 'connector_instance_id')
  assertString(envelope.adapter_contract_version, 'adapter_contract_version')
  assertSha(envelope.adapter_build_digest, 'adapter_build_digest')
  assertString(envelope.provider_ack_schema_version, 'provider_ack_schema_version')
  for (const field of ['provider_request_digest', 'provider_ack_digest'] as const) assertSha(envelope[field], field)
  if (!isPlainObject(envelope.provider_ack_payload)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'provider_ack_payload must be an object')
  return envelope
}

/** Strict Discord subtype binding for the connector-neutral request envelope. */
export function validateDiscordFrozenRequestEnvelope(
  value: unknown,
  authority: CapabilityAuthorityV1,
): { envelope: FrozenProviderRequestEnvelopeV1; request: DiscordProviderRequestV1 } {
  const envelope = decodeFrozenProviderRequestEnvelope(value)
  assertExactKeys(authority, ['source', 'connector_instance_id', 'adapter_contract_version', 'adapter_build_digest', 'capability_digest', 'capability_fixture_set_digest', 'loaded_registration_digest', 'caller_supplied_capability_is_authority'], 'CapabilityAuthorityV1')
  if (
    authority.source !== 'registered_loaded_adapter' ||
    authority.caller_supplied_capability_is_authority !== false ||
    envelope.connector_kind !== 'discord' ||
    envelope.connector_instance_id !== authority.connector_instance_id ||
    envelope.adapter_contract_version !== authority.adapter_contract_version ||
    envelope.adapter_build_digest !== authority.adapter_build_digest ||
    envelope.provider_request_schema_version !== 'aun-discord-provider-request/v1'
  ) throw new ContractValidationError('CAPABILITY_UNPROVEN', 'request envelope differs from loaded Discord authority')
  const request = decodeDiscordProviderRequest(envelope.provider_request_payload)
  if (
    request.connector_instance_id !== envelope.connector_instance_id ||
    request.adapter_build_digest !== envelope.adapter_build_digest ||
    request.provider_request_digest !== envelope.provider_request_digest
  ) throw new ContractValidationError('PROVIDER_REQUEST_DIGEST_MISMATCH', 'request subtype differs from frozen envelope')
  return { envelope, request }
}

/** Strict Discord subtype binding for an acknowledgement envelope. */
export function validateDiscordAckEnvelope(
  value: unknown,
  requestEnvelope: FrozenProviderRequestEnvelopeV1,
): { envelope: ConnectorProviderAckEnvelopeV1; ack: DiscordProviderAckV1 } {
  const envelope = decodeConnectorProviderAckEnvelope(value)
  if (
    envelope.connector_kind !== 'discord' ||
    envelope.connector_instance_id !== requestEnvelope.connector_instance_id ||
    envelope.adapter_contract_version !== requestEnvelope.adapter_contract_version ||
    envelope.adapter_build_digest !== requestEnvelope.adapter_build_digest ||
    envelope.provider_ack_schema_version !== 'aun-discord-provider-ack/v1' ||
    envelope.provider_request_digest !== requestEnvelope.provider_request_digest
  ) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'ack envelope differs from frozen request authority')
  const request = decodeDiscordProviderRequest(requestEnvelope.provider_request_payload)
  const ack = decodeDiscordProviderAck(envelope.provider_ack_payload)
  validateDiscordProviderAck(request, ack)
  const expectedAckDigest = digestCanonical(CONTRACT_DOMAINS.discordAck, ack)
  if (envelope.provider_ack_digest !== expectedAckDigest) throw new ContractValidationError('PROVIDER_EFFECT_MISMATCH', 'provider acknowledgement digest differs')
  return { envelope, ack }
}

export interface ProviderAckTransportReceiptV1 {
  schema_version: 'aun-provider-ack-transport-receipt/v1'
  delivery_id: string
  reply_id: string
  recipient_seat_id: string
  connector_instance_id: string
  channel_binding_id: string
  destination_ref: Sha256
  resolved_binding_snapshot_digest: Sha256
  capability_digest: Sha256
  opaque_address_fingerprint: Sha256
  business_nonce: string
  provider_nonce: string
  delivery_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  provider_request_digest: Sha256
  receipt_mode: 'provider_ack'
  receipt_id: string
  provider_ack: ConnectorProviderAckEnvelopeV1
  acknowledged_at: string
  proof_tier: 'provider_acknowledged'
  receipt_digest: Sha256
}

const PROVIDER_ACK_RECEIPT_FIELDS = [
  'schema_version', 'delivery_id', 'reply_id', 'recipient_seat_id', 'connector_instance_id',
  'channel_binding_id', 'destination_ref', 'resolved_binding_snapshot_digest', 'capability_digest',
  'opaque_address_fingerprint', 'business_nonce', 'provider_nonce', 'delivery_digest',
  'resolved_delivery_decision_digest', 'provider_request_digest', 'receipt_mode', 'receipt_id',
  'provider_ack', 'acknowledged_at', 'proof_tier', 'receipt_digest',
] as const

export function transportReceiptDigest(value: Omit<ProviderAckTransportReceiptV1, 'receipt_digest'> | ProviderAckTransportReceiptV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.receipt, withoutField(value as unknown as Record<string, unknown>, 'receipt_digest'))
}

export function decodeProviderAckTransportReceipt(value: unknown): ProviderAckTransportReceiptV1 {
  assertExactKeys(value, PROVIDER_ACK_RECEIPT_FIELDS, 'ProviderAckTransportReceiptV1')
  const receipt = value as unknown as ProviderAckTransportReceiptV1
  if (receipt.schema_version !== 'aun-provider-ack-transport-receipt/v1' || receipt.receipt_mode !== 'provider_ack' || receipt.proof_tier !== 'provider_acknowledged') throw new ContractValidationError('RECEIPT_INVALID', 'wrong provider acknowledgement receipt vocabulary')
  for (const field of ['delivery_id', 'reply_id', 'recipient_seat_id', 'channel_binding_id', 'business_nonce', 'provider_nonce', 'receipt_id'] as const) assertString(receipt[field], field)
  assertUuid(receipt.connector_instance_id, 'connector_instance_id')
  for (const field of ['destination_ref', 'resolved_binding_snapshot_digest', 'capability_digest', 'opaque_address_fingerprint', 'delivery_digest', 'resolved_delivery_decision_digest', 'provider_request_digest', 'receipt_digest'] as const) assertSha(receipt[field], field)
  assertRfc3339(receipt.acknowledged_at, 'acknowledged_at')
  decodeConnectorProviderAckEnvelope(receipt.provider_ack)
  if (receipt.provider_ack.connector_instance_id !== receipt.connector_instance_id || receipt.provider_ack.provider_request_digest !== receipt.provider_request_digest) throw new ContractValidationError('RECEIPT_INVALID', 'provider acknowledgement envelope identity differs')
  if (transportReceiptDigest(receipt) !== receipt.receipt_digest) throw new ContractValidationError('RECEIPT_INVALID', 'receipt digest differs')
  return receipt
}

export interface DurableHandoffTransportReceiptV1 {
  schema_version: 'aun-durable-handoff-transport-receipt/v1'
  delivery_id: string
  reply_id: string
  recipient_seat_id: string
  connector_instance_id: string
  channel_binding_id: string
  destination_ref: Sha256
  resolved_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  capability_digest: Sha256
  opaque_address_fingerprint: Sha256
  business_nonce: string
  provider_nonce: string
  delivery_digest: Sha256
  receipt_mode: 'durable_handoff'
  receipt_id: string
  durable_placement_digest: Sha256
  acknowledged_at: string
  proof_tier: 'durable_handoff'
  receipt_digest: Sha256
}

const DURABLE_HANDOFF_RECEIPT_FIELDS = [
  'schema_version', 'delivery_id', 'reply_id', 'recipient_seat_id', 'connector_instance_id',
  'channel_binding_id', 'destination_ref', 'resolved_binding_snapshot_digest',
  'resolved_delivery_decision_digest', 'capability_digest', 'opaque_address_fingerprint',
  'business_nonce', 'provider_nonce', 'delivery_digest', 'receipt_mode', 'receipt_id',
  'durable_placement_digest', 'acknowledged_at', 'proof_tier', 'receipt_digest',
] as const

export function durableHandoffReceiptDigest(value: Omit<DurableHandoffTransportReceiptV1, 'receipt_digest'> | DurableHandoffTransportReceiptV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.receipt, withoutField(value as unknown as Record<string, unknown>, 'receipt_digest'))
}

export function decodeDurableHandoffTransportReceipt(value: unknown): DurableHandoffTransportReceiptV1 {
  assertExactKeys(value, DURABLE_HANDOFF_RECEIPT_FIELDS, 'DurableHandoffTransportReceiptV1')
  const receipt = value as unknown as DurableHandoffTransportReceiptV1
  if (
    receipt.schema_version !== 'aun-durable-handoff-transport-receipt/v1' ||
    receipt.receipt_mode !== 'durable_handoff' ||
    receipt.proof_tier !== 'durable_handoff'
  ) throw new ContractValidationError('RECEIPT_INVALID', 'wrong durable handoff receipt vocabulary')
  for (const field of ['delivery_id', 'reply_id', 'recipient_seat_id', 'channel_binding_id', 'business_nonce', 'provider_nonce', 'receipt_id'] as const) assertString(receipt[field], field)
  assertUuid(receipt.connector_instance_id, 'connector_instance_id')
  for (const field of ['destination_ref', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'capability_digest', 'opaque_address_fingerprint', 'delivery_digest', 'durable_placement_digest', 'receipt_digest'] as const) assertSha(receipt[field], field)
  assertRfc3339(receipt.acknowledged_at, 'acknowledged_at')
  if (durableHandoffReceiptDigest(receipt) !== receipt.receipt_digest) throw new ContractValidationError('RECEIPT_INVALID', 'receipt digest differs')
  return receipt
}

export type TransportReceiptV1 = ProviderAckTransportReceiptV1 | DurableHandoffTransportReceiptV1

export function decodeTransportReceipt(value: unknown): TransportReceiptV1 {
  if (!isPlainObject(value)) throw new ContractValidationError('RECEIPT_INVALID', 'transport receipt must be an object')
  if (value.schema_version === 'aun-provider-ack-transport-receipt/v1') return decodeProviderAckTransportReceipt(value)
  if (value.schema_version === 'aun-durable-handoff-transport-receipt/v1') return decodeDurableHandoffTransportReceipt(value)
  throw new ContractValidationError('RECEIPT_INVALID', 'unknown transport receipt schema')
}

/** Connector-neutral receipt binding; provider subtype validation stays in the loaded adapter. */
export function validateTransportReceiptForDelivery(
  value: unknown,
  unit: DeliveryUnitV1,
  loadedRegistration: LoadedConnectorRegistrationV1,
): TransportReceiptV1 {
  validateDeliveryUnit(unit, loadedRegistration)
  const receipt = decodeTransportReceipt(value)
  if (
    receipt.delivery_id !== unit.delivery_id ||
    receipt.reply_id !== unit.reply_id ||
    receipt.recipient_seat_id !== unit.recipient_seat_id ||
    receipt.connector_instance_id !== unit.destination.connector_instance_id ||
    receipt.channel_binding_id !== unit.resolved_binding_snapshot.channel_binding_id ||
    receipt.destination_ref !== unit.destination_ref ||
    receipt.resolved_binding_snapshot_digest !== unit.resolved_binding_snapshot_digest ||
    receipt.resolved_delivery_decision_digest !== unit.resolved_delivery_decision.resolved_delivery_decision_digest ||
    receipt.capability_digest !== unit.capability_digest ||
    receipt.opaque_address_fingerprint !== unit.resolved_binding_snapshot.opaque_address_fingerprint ||
    receipt.business_nonce !== unit.business_nonce ||
    receipt.provider_nonce !== unit.idempotency.provider_nonce ||
    receipt.delivery_digest !== unit.idempotency.delivery_digest
  ) throw new ContractValidationError('RECEIPT_INVALID', 'receipt differs from the frozen delivery unit')
  if (receipt.receipt_mode !== unit.required_receipt_mode) {
    throw new ContractValidationError('RECEIPT_INVALID', 'receipt mode differs from the required delivery truth')
  }
  if (receipt.receipt_mode === 'provider_ack') {
    if (
      receipt.provider_ack.connector_kind !== unit.connector_capability.connector_kind ||
      receipt.provider_ack.connector_instance_id !== unit.destination.connector_instance_id ||
      receipt.provider_ack.adapter_contract_version !== unit.connector_capability.adapter_contract_version ||
      receipt.provider_ack.adapter_build_digest !== unit.connector_capability.adapter_build_digest ||
      receipt.provider_ack.provider_request_digest !== receipt.provider_request_digest
    ) throw new ContractValidationError('RECEIPT_INVALID', 'provider acknowledgement envelope differs from loaded authority')
  }
  return receipt
}

export interface ReplyDeliveredPayloadV1 {
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  receipt_digest: Sha256
  provider_request_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  fanout_child_provenance_digest: Sha256 | null
}

export interface ReplyHandoffAcceptedPayloadV1 {
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  receipt_digest: Sha256
  fanout_child_provenance_digest: Sha256 | null
}

export interface ReplyFailedPayloadV1 {
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  failure_code: string
  permanent: boolean
  fanout_child_provenance_digest: Sha256 | null
}

const DELIVERED_FIELDS = ['reply_id', 'delivery_id', 'recipient_seat_id', 'receipt_digest', 'provider_request_digest', 'resolved_delivery_decision_digest', 'fanout_child_provenance_digest'] as const
const HANDOFF_ACCEPTED_FIELDS = ['reply_id', 'delivery_id', 'recipient_seat_id', 'receipt_digest', 'fanout_child_provenance_digest'] as const
const FAILED_FIELDS = ['reply_id', 'delivery_id', 'recipient_seat_id', 'failure_code', 'permanent', 'fanout_child_provenance_digest'] as const

export function decodeReplyDeliveredPayload(value: unknown): ReplyDeliveredPayloadV1 {
  assertExactKeys(value, DELIVERED_FIELDS, 'ReplyDeliveredPayloadV1')
  const payload = value as unknown as ReplyDeliveredPayloadV1
  for (const field of ['reply_id', 'delivery_id', 'recipient_seat_id'] as const) assertString(payload[field], field)
  for (const field of ['receipt_digest', 'provider_request_digest', 'resolved_delivery_decision_digest'] as const) assertSha(payload[field], field)
  assertNullableSha(payload.fanout_child_provenance_digest, 'fanout_child_provenance_digest')
  return payload
}

export function decodeReplyHandoffAcceptedPayload(value: unknown): ReplyHandoffAcceptedPayloadV1 {
  assertExactKeys(value, HANDOFF_ACCEPTED_FIELDS, 'ReplyHandoffAcceptedPayloadV1')
  const payload = value as unknown as ReplyHandoffAcceptedPayloadV1
  for (const field of ['reply_id', 'delivery_id', 'recipient_seat_id'] as const) assertString(payload[field], field)
  assertSha(payload.receipt_digest, 'receipt_digest')
  assertNullableSha(payload.fanout_child_provenance_digest, 'fanout_child_provenance_digest')
  return payload
}

export function decodeReplyFailedPayload(value: unknown): ReplyFailedPayloadV1 {
  assertExactKeys(value, FAILED_FIELDS, 'ReplyFailedPayloadV1')
  const payload = value as unknown as ReplyFailedPayloadV1
  for (const field of ['reply_id', 'delivery_id', 'recipient_seat_id', 'failure_code'] as const) assertString(payload[field], field)
  if (typeof payload.permanent !== 'boolean') throw new ContractValidationError('STRICT_DECODE_FAILED', 'permanent must be boolean')
  assertNullableSha(payload.fanout_child_provenance_digest, 'fanout_child_provenance_digest')
  return payload
}

export interface DeliveryUnknownReconciliationRequestV1 {
  schema_version: 'aun-delivery-unknown-reconciliation-request/v1'
  reconciliation_id: string
  delivery_unknown_event_id: string
  delivery_unknown_event_digest: Sha256
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  attempt_ordinal: number
  connector_instance_id: string
  resolved_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  delivery_digest: Sha256
  provider_request_digest: Sha256
  business_nonce: string
  provider_nonce: string
  capability_digest: Sha256
  reconciliation_mode: 'provider_lookup' | 'durable_ledger_lookup' | 'none'
  reconciler_registration_digest: Sha256
  request_digest: Sha256
}

const RECONCILIATION_REQUEST_FIELDS = [
  'schema_version', 'reconciliation_id', 'delivery_unknown_event_id', 'delivery_unknown_event_digest',
  'reply_id', 'delivery_id', 'recipient_seat_id', 'attempt_ordinal', 'connector_instance_id',
  'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'delivery_digest',
  'provider_request_digest', 'business_nonce', 'provider_nonce', 'capability_digest',
  'reconciliation_mode', 'reconciler_registration_digest', 'request_digest',
] as const

export function reconciliationRequestDigest(value: Omit<DeliveryUnknownReconciliationRequestV1, 'request_digest'> | DeliveryUnknownReconciliationRequestV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.reconciliationRequest, withoutField(value as unknown as Record<string, unknown>, 'request_digest'))
}

export function decodeReconciliationRequest(value: unknown): DeliveryUnknownReconciliationRequestV1 {
  assertExactKeys(value, RECONCILIATION_REQUEST_FIELDS, 'DeliveryUnknownReconciliationRequestV1')
  const request = value as unknown as DeliveryUnknownReconciliationRequestV1
  if (request.schema_version !== 'aun-delivery-unknown-reconciliation-request/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong reconciliation request schema')
  for (const field of ['reconciliation_id', 'delivery_unknown_event_id', 'reply_id', 'delivery_id', 'recipient_seat_id', 'business_nonce', 'provider_nonce'] as const) assertString(request[field], field)
  for (const field of ['delivery_unknown_event_digest', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'delivery_digest', 'provider_request_digest', 'capability_digest', 'reconciler_registration_digest', 'request_digest'] as const) assertSha(request[field], field)
  assertNonNegativeInteger(request.attempt_ordinal, 'attempt_ordinal')
  assertUuid(request.connector_instance_id, 'connector_instance_id')
  if (!['provider_lookup', 'durable_ledger_lookup', 'none'].includes(request.reconciliation_mode)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'invalid reconciliation_mode')
  if (reconciliationRequestDigest(request) !== request.request_digest) throw new ContractValidationError('RECONCILIATION_DIGEST_MISMATCH', 'request digest differs')
  return request
}

export type ReconciliationObservedOutcome = 'validated_original_receipt' | 'permanent_failure' | 'proven_zero_external_effect' | 'not_found' | 'ambiguous' | 'unavailable' | 'permission_denied' | 'truncated' | 'unverifiable'

export interface DeliveryUnknownReconciliationObservationV1 {
  schema_version: 'aun-delivery-unknown-reconciliation-observation/v1'
  reconciliation_request_digest: Sha256
  observed_outcome: ReconciliationObservedOutcome
  validated_receipt_digest: Sha256 | null
  permanent_failure_code: string | null
  zero_external_effect_attestation_digest: Sha256 | null
  evidence_digest: Sha256
  observation_digest: Sha256
}

const RECONCILIATION_OBSERVATION_FIELDS = [
  'schema_version', 'reconciliation_request_digest', 'observed_outcome', 'validated_receipt_digest',
  'permanent_failure_code', 'zero_external_effect_attestation_digest', 'evidence_digest', 'observation_digest',
] as const

export function reconciliationObservationDigest(value: Omit<DeliveryUnknownReconciliationObservationV1, 'observation_digest'> | DeliveryUnknownReconciliationObservationV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.reconciliationObservation, withoutField(value as unknown as Record<string, unknown>, 'observation_digest'))
}

export function decodeReconciliationObservation(value: unknown): DeliveryUnknownReconciliationObservationV1 {
  assertExactKeys(value, RECONCILIATION_OBSERVATION_FIELDS, 'DeliveryUnknownReconciliationObservationV1')
  const observation = value as unknown as DeliveryUnknownReconciliationObservationV1
  if (observation.schema_version !== 'aun-delivery-unknown-reconciliation-observation/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong observation schema')
  assertSha(observation.reconciliation_request_digest, 'reconciliation_request_digest')
  assertNullableSha(observation.validated_receipt_digest, 'validated_receipt_digest')
  assertNullableString(observation.permanent_failure_code, 'permanent_failure_code')
  assertNullableSha(observation.zero_external_effect_attestation_digest, 'zero_external_effect_attestation_digest')
  assertSha(observation.evidence_digest, 'evidence_digest')
  assertSha(observation.observation_digest, 'observation_digest')
  const admittedOutcomes: ReconciliationObservedOutcome[] = ['validated_original_receipt', 'permanent_failure', 'proven_zero_external_effect', 'not_found', 'ambiguous', 'unavailable', 'permission_denied', 'truncated', 'unverifiable']
  if (!admittedOutcomes.includes(observation.observed_outcome)) throw new ContractValidationError('UNVERIFIABLE_RECONCILIATION_OBSERVATION', 'unknown observed_outcome')
  const optional = [observation.validated_receipt_digest, observation.permanent_failure_code, observation.zero_external_effect_attestation_digest]
  const requiredIndex = observation.observed_outcome === 'validated_original_receipt' ? 0 : observation.observed_outcome === 'permanent_failure' ? 1 : observation.observed_outcome === 'proven_zero_external_effect' ? 2 : -1
  optional.forEach((item, index) => {
    if ((index === requiredIndex) !== (item !== null)) throw new ContractValidationError('UNVERIFIABLE_RECONCILIATION_OBSERVATION', 'outcome evidence one-of violated')
  })
  if (reconciliationObservationDigest(observation) !== observation.observation_digest) throw new ContractValidationError('RECONCILIATION_DIGEST_MISMATCH', 'observation digest differs')
  return observation
}

export interface ZeroEffectProducerRegistrationV1 {
  schema_version: 'aun-zero-effect-producer-registration/v1'
  registration_id: string
  producer_instance_id: string
  producer_kind: ProducerKind
  connector_instance_id: string
  capability_digest: Sha256
  authorized_evidence_kinds: EvidenceKind[]
  verifier_contract_version: string
  producer_build_digest: Sha256
  build_test_attestation_digest: Sha256
  registry_generation: number
  valid_from: string
  expires_at: string
  status: 'active' | 'revoked'
  registration_digest: Sha256
}

export interface RetryBudgetIssuerRegistrationV1 {
  schema_version: 'aun-retry-budget-issuer-registration/v1'
  registration_id: string
  issuer_instance_id: string
  capability_digest: Sha256
  budget_policy_digest: Sha256
  policy_source_digest: Sha256
  issuer_build_digest: Sha256
  build_test_attestation_digest: Sha256
  registry_generation: number
  valid_from: string
  expires_at: string
  status: 'active' | 'revoked'
  registration_digest: Sha256
}

const PRODUCER_REGISTRATION_FIELDS = [
  'schema_version', 'registration_id', 'producer_instance_id', 'producer_kind', 'connector_instance_id',
  'capability_digest', 'authorized_evidence_kinds', 'verifier_contract_version', 'producer_build_digest',
  'build_test_attestation_digest', 'registry_generation', 'valid_from', 'expires_at', 'status', 'registration_digest',
] as const

const ISSUER_REGISTRATION_FIELDS = [
  'schema_version', 'registration_id', 'issuer_instance_id', 'capability_digest', 'budget_policy_digest',
  'policy_source_digest', 'issuer_build_digest', 'build_test_attestation_digest', 'registry_generation',
  'valid_from', 'expires_at', 'status', 'registration_digest',
] as const

export function producerRegistrationDigest(value: Omit<ZeroEffectProducerRegistrationV1, 'registration_digest'> | ZeroEffectProducerRegistrationV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.producerRegistration, withoutField(value as unknown as Record<string, unknown>, 'registration_digest'))
}

export function issuerRegistrationDigest(value: Omit<RetryBudgetIssuerRegistrationV1, 'registration_digest'> | RetryBudgetIssuerRegistrationV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.issuerRegistration, withoutField(value as unknown as Record<string, unknown>, 'registration_digest'))
}

export function decodeProducerRegistration(value: unknown): ZeroEffectProducerRegistrationV1 {
  assertExactKeys(value, PRODUCER_REGISTRATION_FIELDS, 'ZeroEffectProducerRegistrationV1')
  const registration = value as unknown as ZeroEffectProducerRegistrationV1
  if (registration.schema_version !== 'aun-zero-effect-producer-registration/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong producer registration schema')
  assertUuid(registration.registration_id, 'registration_id')
  assertUuid(registration.connector_instance_id, 'connector_instance_id')
  assertString(registration.producer_instance_id, 'producer_instance_id')
  assertString(registration.verifier_contract_version, 'verifier_contract_version')
  for (const field of ['capability_digest', 'producer_build_digest', 'build_test_attestation_digest', 'registration_digest'] as const) assertSha(registration[field], field)
  assertPositiveInteger(registration.registry_generation, 'registry_generation')
  assertRfc3339(registration.valid_from, 'valid_from')
  assertRfc3339(registration.expires_at, 'expires_at')
  assertOrderedInterval(registration.valid_from, registration.expires_at, 'producer registration')
  if (!['active', 'revoked'].includes(registration.status)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'invalid producer registration status')
  if (!(registration.producer_kind in PRODUCER_KIND_TO_EVIDENCE_KIND)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'unknown producer_kind')
  const mapped = PRODUCER_KIND_TO_EVIDENCE_KIND[registration.producer_kind]
  assertAlreadySortedUnique(registration.authorized_evidence_kinds, 'authorized_evidence_kinds')
  if (registration.authorized_evidence_kinds.length !== 1 || registration.authorized_evidence_kinds[0] !== mapped) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'producer/evidence mapping is not the exact singleton')
  if (producerRegistrationDigest(registration) !== registration.registration_digest) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'producer registration digest differs')
  return registration
}

export function decodeIssuerRegistration(value: unknown): RetryBudgetIssuerRegistrationV1 {
  assertExactKeys(value, ISSUER_REGISTRATION_FIELDS, 'RetryBudgetIssuerRegistrationV1')
  const registration = value as unknown as RetryBudgetIssuerRegistrationV1
  if (registration.schema_version !== 'aun-retry-budget-issuer-registration/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong issuer registration schema')
  assertUuid(registration.registration_id, 'registration_id')
  assertString(registration.issuer_instance_id, 'issuer_instance_id')
  for (const field of ['capability_digest', 'budget_policy_digest', 'policy_source_digest', 'issuer_build_digest', 'build_test_attestation_digest', 'registration_digest'] as const) assertSha(registration[field], field)
  assertPositiveInteger(registration.registry_generation, 'registry_generation')
  assertRfc3339(registration.valid_from, 'valid_from')
  assertRfc3339(registration.expires_at, 'expires_at')
  assertOrderedInterval(registration.valid_from, registration.expires_at, 'issuer registration')
  if (!['active', 'revoked'].includes(registration.status)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'invalid issuer registration status')
  if (issuerRegistrationDigest(registration) !== registration.registration_digest) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'issuer registration digest differs')
  return registration
}

export type TypedPreInvocationFailureEvidenceV1 = {
  delivery_id: string
  attempt_ordinal: number
  provider_request_digest: Sha256
  provider_nonce: string
  nonce_reservation_event_id: string
  invocation_started_event_id: null
  failure_code: 'frozen_request_rejected' | 'reservation_failed_before_start' | 'capability_rejected_before_start'
}

export type ProviderRejectedBeforeEffectEvidenceV1 = {
  delivery_id: string
  attempt_ordinal: number
  provider_request_digest: Sha256
  provider_nonce: string
  provider_response_digest: Sha256
  provider_rejection_code: string
  provider_contract_digest: Sha256
  provider_contract_effect: 'rejected_before_effect'
}

export type VerifiedLookupNoEffectEvidenceV1 = {
  delivery_id: string
  attempt_ordinal: number
  provider_request_digest: Sha256
  provider_nonce: string
  reconciliation_request_digest: Sha256
  reconciliation_observation_digest: Sha256
  lookup_evidence_digest: Sha256
  observed_at: string
  provider_effect_found: false
}

export type ZeroExternalEffectEvidenceBodyV1 = TypedPreInvocationFailureEvidenceV1 | ProviderRejectedBeforeEffectEvidenceV1 | VerifiedLookupNoEffectEvidenceV1

export interface ZeroExternalEffectEvidenceRecordV1 {
  schema_version: 'aun-zero-external-effect-evidence/v1'
  evidence_kind: EvidenceKind
  evidence_body: ZeroExternalEffectEvidenceBodyV1
  evidence_digest: Sha256
}

const EVIDENCE_BODY_FIELDS: Record<EvidenceKind, readonly string[]> = {
  typed_pre_invocation_failure: ['delivery_id', 'attempt_ordinal', 'provider_request_digest', 'provider_nonce', 'nonce_reservation_event_id', 'invocation_started_event_id', 'failure_code'],
  provider_rejected_before_effect: ['delivery_id', 'attempt_ordinal', 'provider_request_digest', 'provider_nonce', 'provider_response_digest', 'provider_rejection_code', 'provider_contract_digest', 'provider_contract_effect'],
  verified_lookup_no_effect: ['delivery_id', 'attempt_ordinal', 'provider_request_digest', 'provider_nonce', 'reconciliation_request_digest', 'reconciliation_observation_digest', 'lookup_evidence_digest', 'observed_at', 'provider_effect_found'],
}

export function zeroEffectEvidenceDigest(kind: EvidenceKind, body: ZeroExternalEffectEvidenceBodyV1): Sha256 {
  return digestCanonical(`aun-zero-external-effect-evidence/${kind}/v1\n`, body)
}

export function decodeEvidenceRecord(value: unknown): ZeroExternalEffectEvidenceRecordV1 {
  assertExactKeys(value, ['schema_version', 'evidence_kind', 'evidence_body', 'evidence_digest'], 'ZeroExternalEffectEvidenceRecordV1')
  const record = value as unknown as ZeroExternalEffectEvidenceRecordV1
  if (record.schema_version !== 'aun-zero-external-effect-evidence/v1' || !(record.evidence_kind in EVIDENCE_BODY_FIELDS)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'unknown evidence variant')
  assertExactKeys(record.evidence_body, EVIDENCE_BODY_FIELDS[record.evidence_kind], `${record.evidence_kind} evidence`)
  const body = record.evidence_body as unknown as Record<string, unknown>
  assertString(body.delivery_id, 'evidence.delivery_id')
  assertNonNegativeInteger(body.attempt_ordinal, 'evidence.attempt_ordinal')
  assertSha(body.provider_request_digest, 'evidence.provider_request_digest')
  assertString(body.provider_nonce, 'evidence.provider_nonce')
  if (record.evidence_kind === 'typed_pre_invocation_failure') {
    if (body.invocation_started_event_id !== null) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'pre-invocation evidence names an invocation')
    assertString(body.nonce_reservation_event_id, 'evidence.nonce_reservation_event_id')
    if (!['frozen_request_rejected', 'reservation_failed_before_start', 'capability_rejected_before_start'].includes(String(body.failure_code))) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'unknown pre-invocation failure_code')
  } else if (record.evidence_kind === 'provider_rejected_before_effect') {
    for (const field of ['provider_response_digest', 'provider_contract_digest'] as const) assertSha(body[field], `evidence.${field}`)
    assertString(body.provider_rejection_code, 'evidence.provider_rejection_code')
    if (body.provider_contract_effect !== 'rejected_before_effect') throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'provider contract does not prove zero effect')
  } else {
    for (const field of ['reconciliation_request_digest', 'reconciliation_observation_digest', 'lookup_evidence_digest'] as const) assertSha(body[field], `evidence.${field}`)
    if (body.provider_effect_found !== false) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'lookup found a provider effect')
    assertRfc3339(body.observed_at, 'evidence.observed_at')
  }
  assertSha(record.evidence_digest, 'evidence_digest')
  if (zeroEffectEvidenceDigest(record.evidence_kind, record.evidence_body) !== record.evidence_digest) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'evidence digest differs')
  return record
}

export interface ZeroExternalEffectAttestationV1 {
  attestation_id: string
  delivery_id: string
  attempt_ordinal: number
  connector_instance_id: string
  provider_request_digest: Sha256
  provider_nonce: string
  evidence_kind: EvidenceKind
  evidence_digest: Sha256
  producer_registration_digest: Sha256
  issued_at: string
  expires_at: string
  attestation_digest: Sha256
}

const ATTESTATION_FIELDS = ['attestation_id', 'delivery_id', 'attempt_ordinal', 'connector_instance_id', 'provider_request_digest', 'provider_nonce', 'evidence_kind', 'evidence_digest', 'producer_registration_digest', 'issued_at', 'expires_at', 'attestation_digest'] as const

export function attestationDigest(value: Omit<ZeroExternalEffectAttestationV1, 'attestation_digest'> | ZeroExternalEffectAttestationV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.zeroEffectAttestation, withoutField(value as unknown as Record<string, unknown>, 'attestation_digest'))
}

export function decodeAttestation(value: unknown): ZeroExternalEffectAttestationV1 {
  assertExactKeys(value, ATTESTATION_FIELDS, 'ZeroExternalEffectAttestationV1')
  const attestation = value as unknown as ZeroExternalEffectAttestationV1
  for (const field of ['attestation_id', 'delivery_id', 'provider_nonce'] as const) assertString(attestation[field], field)
  assertNonNegativeInteger(attestation.attempt_ordinal, 'attempt_ordinal')
  assertUuid(attestation.connector_instance_id, 'connector_instance_id')
  for (const field of ['provider_request_digest', 'evidence_digest', 'producer_registration_digest', 'attestation_digest'] as const) assertSha(attestation[field], field)
  assertRfc3339(attestation.issued_at, 'issued_at')
  assertRfc3339(attestation.expires_at, 'expires_at')
  assertOrderedInterval(attestation.issued_at, attestation.expires_at, 'attestation')
  if (!Object.values(PRODUCER_KIND_TO_EVIDENCE_KIND).includes(attestation.evidence_kind)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'unknown evidence_kind')
  if (attestationDigest(attestation) !== attestation.attestation_digest) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'attestation digest differs')
  return attestation
}

export interface RetryBudgetAuthorityV1 {
  delivery_id: string
  capability_digest: Sha256
  budget_policy_digest: Sha256
  current_attempt_ordinal: number
  remaining_before: number
  remaining_after: number
  generation_before: number
  generation_after: number
  authority_registration_digest: Sha256
  issued_at: string
  expires_at: string
  authority_digest: Sha256
}

const RETRY_AUTHORITY_FIELDS = ['delivery_id', 'capability_digest', 'budget_policy_digest', 'current_attempt_ordinal', 'remaining_before', 'remaining_after', 'generation_before', 'generation_after', 'authority_registration_digest', 'issued_at', 'expires_at', 'authority_digest'] as const

export function retryBudgetAuthorityDigest(value: Omit<RetryBudgetAuthorityV1, 'authority_digest'> | RetryBudgetAuthorityV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.retryBudgetAuthority, withoutField(value as unknown as Record<string, unknown>, 'authority_digest'))
}

export function decodeRetryBudgetAuthority(value: unknown): RetryBudgetAuthorityV1 {
  assertExactKeys(value, RETRY_AUTHORITY_FIELDS, 'RetryBudgetAuthorityV1')
  const authority = value as unknown as RetryBudgetAuthorityV1
  assertString(authority.delivery_id, 'delivery_id')
  for (const field of ['capability_digest', 'budget_policy_digest', 'authority_registration_digest', 'authority_digest'] as const) assertSha(authority[field], field)
  assertNonNegativeInteger(authority.current_attempt_ordinal, 'current_attempt_ordinal')
  assertPositiveInteger(authority.remaining_before, 'remaining_before')
  assertNonNegativeInteger(authority.remaining_after, 'remaining_after')
  assertPositiveInteger(authority.generation_before, 'generation_before')
  assertPositiveInteger(authority.generation_after, 'generation_after')
  assertRfc3339(authority.issued_at, 'issued_at')
  assertRfc3339(authority.expires_at, 'expires_at')
  assertOrderedInterval(authority.issued_at, authority.expires_at, 'retry budget authority')
  if (authority.remaining_after !== authority.remaining_before - 1) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'budget decrement is not exactly one')
  if (authority.generation_after !== authority.generation_before + 1) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'budget generation is not contiguous')
  if (retryBudgetAuthorityDigest(authority) !== authority.authority_digest) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'authority digest differs')
  return authority
}

export interface RetryBudgetSnapshotV1 {
  schema_version: 'aun-retry-budget-snapshot/v1'
  reply_id: string
  delivery_id: string
  capability_digest: Sha256
  budget_policy_digest: Sha256
  authority_registration_digest: Sha256
  generation: number
  remaining: number
  prior_snapshot_event_id: string | null
  transition_authority_digest: Sha256 | null
}

const BUDGET_SNAPSHOT_FIELDS = ['schema_version', 'reply_id', 'delivery_id', 'capability_digest', 'budget_policy_digest', 'authority_registration_digest', 'generation', 'remaining', 'prior_snapshot_event_id', 'transition_authority_digest'] as const

export function decodeRetryBudgetSnapshot(value: unknown): RetryBudgetSnapshotV1 {
  assertExactKeys(value, BUDGET_SNAPSHOT_FIELDS, 'RetryBudgetSnapshotV1')
  const snapshot = value as unknown as RetryBudgetSnapshotV1
  if (snapshot.schema_version !== 'aun-retry-budget-snapshot/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong budget snapshot schema')
  assertString(snapshot.reply_id, 'reply_id')
  assertString(snapshot.delivery_id, 'delivery_id')
  for (const field of ['capability_digest', 'budget_policy_digest', 'authority_registration_digest'] as const) assertSha(snapshot[field], field)
  assertPositiveInteger(snapshot.generation, 'generation')
  assertNonNegativeInteger(snapshot.remaining, 'remaining')
  assertNullableString(snapshot.prior_snapshot_event_id, 'prior_snapshot_event_id')
  assertNullableSha(snapshot.transition_authority_digest, 'transition_authority_digest')
  if (snapshot.generation === 1 && (snapshot.prior_snapshot_event_id !== null || snapshot.transition_authority_digest !== null)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'initial snapshot must have null transition fields')
  if (snapshot.generation > 1 && (snapshot.prior_snapshot_event_id === null || snapshot.transition_authority_digest === null)) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'transition snapshot must bind predecessor and authority')
  return snapshot
}

export interface ReplyDeliveryUnknownPayloadV1 {
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  attempt_ordinal: number
  connector_instance_id: string
  resolved_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  delivery_digest: Sha256
  provider_request_digest: Sha256
  business_nonce: string
  provider_nonce: string
  capability_digest: Sha256
  invocation_started_event_id: string
  reconciliation_mode: 'provider_lookup' | 'durable_ledger_lookup' | 'none'
  fanout_child_provenance_digest: Sha256 | null
}

const DELIVERY_UNKNOWN_FIELDS = ['reply_id', 'delivery_id', 'recipient_seat_id', 'attempt_ordinal', 'connector_instance_id', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'delivery_digest', 'provider_request_digest', 'business_nonce', 'provider_nonce', 'capability_digest', 'invocation_started_event_id', 'reconciliation_mode', 'fanout_child_provenance_digest'] as const

export function decodeReplyDeliveryUnknownPayload(value: unknown): ReplyDeliveryUnknownPayloadV1 {
  assertExactKeys(value, DELIVERY_UNKNOWN_FIELDS, 'ReplyDeliveryUnknownPayloadV1')
  const payload = value as unknown as ReplyDeliveryUnknownPayloadV1
  for (const field of ['reply_id', 'delivery_id', 'recipient_seat_id', 'business_nonce', 'provider_nonce', 'invocation_started_event_id'] as const) assertString(payload[field], field)
  assertNonNegativeInteger(payload.attempt_ordinal, 'attempt_ordinal')
  assertUuid(payload.connector_instance_id, 'connector_instance_id')
  for (const field of ['resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'delivery_digest', 'provider_request_digest', 'capability_digest'] as const) assertSha(payload[field], field)
  assertNullableSha(payload.fanout_child_provenance_digest, 'fanout_child_provenance_digest')
  if (!['provider_lookup', 'durable_ledger_lookup', 'none'].includes(payload.reconciliation_mode)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'invalid reconciliation_mode')
  return payload
}

export function buildReplyDeliveryUnknownPayload(
  unit: DeliveryUnitV1,
  start: ProviderInvocationStartPayloadV1,
  invocationStartedEventId: string,
): ReplyDeliveryUnknownPayloadV1 {
  decodeProviderInvocationStart(start)
  assertString(invocationStartedEventId, 'invocation_started_event_id')
  if (
    start.delivery_id !== unit.delivery_id ||
    start.reply_id !== unit.reply_id ||
    start.recipient_seat_id !== unit.recipient_seat_id ||
    start.provider_nonce !== unit.idempotency.provider_nonce ||
    start.delivery_digest !== unit.idempotency.delivery_digest
  ) throw new ContractValidationError('INVOCATION_START_COLLISION', 'invocation start differs from delivery unit')
  return decodeReplyDeliveryUnknownPayload({
    reply_id: unit.reply_id,
    delivery_id: unit.delivery_id,
    recipient_seat_id: unit.recipient_seat_id,
    attempt_ordinal: start.attempt_ordinal,
    connector_instance_id: unit.destination.connector_instance_id,
    resolved_binding_snapshot_digest: unit.resolved_binding_snapshot_digest,
    resolved_delivery_decision_digest: unit.resolved_delivery_decision.resolved_delivery_decision_digest,
    delivery_digest: unit.idempotency.delivery_digest,
    provider_request_digest: start.provider_request_digest,
    business_nonce: unit.business_nonce,
    provider_nonce: unit.idempotency.provider_nonce,
    capability_digest: unit.capability_digest,
    invocation_started_event_id: invocationStartedEventId,
    reconciliation_mode: unit.connector_capability.reconciliation_mode,
    fanout_child_provenance_digest: unit.fanout_child_provenance?.provenance_digest ?? null,
  })
}

export interface ReplyDeliveryReconciliationResolvedPayloadV1 {
  delivery_unknown_event_id: string
  reconciliation_observation_event_id: string
  reconciliation_request_digest: Sha256
  observation_digest: Sha256
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  attempt_ordinal: number
  reconciliation_outcome_key: Sha256
  outcome: 'delivered' | 'permanent_failure' | 'reopened'
  resulting_event_id: string
}

const RECONCILIATION_RESOLVED_FIELDS = ['delivery_unknown_event_id', 'reconciliation_observation_event_id', 'reconciliation_request_digest', 'observation_digest', 'reply_id', 'delivery_id', 'recipient_seat_id', 'attempt_ordinal', 'reconciliation_outcome_key', 'outcome', 'resulting_event_id'] as const

export function decodeReconciliationResolvedPayload(value: unknown): ReplyDeliveryReconciliationResolvedPayloadV1 {
  assertExactKeys(value, RECONCILIATION_RESOLVED_FIELDS, 'ReplyDeliveryReconciliationResolvedPayloadV1')
  const payload = value as unknown as ReplyDeliveryReconciliationResolvedPayloadV1
  for (const field of ['delivery_unknown_event_id', 'reconciliation_observation_event_id', 'reply_id', 'delivery_id', 'recipient_seat_id', 'resulting_event_id'] as const) assertString(payload[field], field)
  for (const field of ['reconciliation_request_digest', 'observation_digest', 'reconciliation_outcome_key'] as const) assertSha(payload[field], field)
  assertNonNegativeInteger(payload.attempt_ordinal, 'attempt_ordinal')
  if (!['delivered', 'permanent_failure', 'reopened'].includes(payload.outcome)) throw new ContractValidationError('STRICT_DECODE_FAILED', 'invalid reconciliation outcome')
  return payload
}

export interface ReplyDeliveryReopenedPayloadV1 {
  reply_id: string
  delivery_id: string
  recipient_seat_id: string
  causation_delivery_unknown_event_id: string
  reconciliation_request_digest: Sha256
  reconciliation_observation_digest: Sha256
  prior_attempt_ordinal: number
  next_attempt_ordinal: number
  provider_request_digest: Sha256
  capability_digest: Sha256
  attestation_digest: Sha256
  producer_registration_digest: Sha256
  retry_budget_before_reopen: number
  retry_budget_after_reopen: number
  retry_budget_generation_before: number
  retry_budget_generation_after: number
  authority_digest: Sha256
  authority_registration_digest: Sha256
  fanout_child_provenance_digest: Sha256 | null
}

const REOPENED_FIELDS = ['reply_id', 'delivery_id', 'recipient_seat_id', 'causation_delivery_unknown_event_id', 'reconciliation_request_digest', 'reconciliation_observation_digest', 'prior_attempt_ordinal', 'next_attempt_ordinal', 'provider_request_digest', 'capability_digest', 'attestation_digest', 'producer_registration_digest', 'retry_budget_before_reopen', 'retry_budget_after_reopen', 'retry_budget_generation_before', 'retry_budget_generation_after', 'authority_digest', 'authority_registration_digest', 'fanout_child_provenance_digest'] as const

export function decodeReplyDeliveryReopenedPayload(value: unknown): ReplyDeliveryReopenedPayloadV1 {
  assertExactKeys(value, REOPENED_FIELDS, 'ReplyDeliveryReopenedPayloadV1')
  const payload = value as unknown as ReplyDeliveryReopenedPayloadV1
  for (const field of ['reply_id', 'delivery_id', 'recipient_seat_id', 'causation_delivery_unknown_event_id'] as const) assertString(payload[field], field)
  for (const field of ['reconciliation_request_digest', 'reconciliation_observation_digest', 'provider_request_digest', 'capability_digest', 'attestation_digest', 'producer_registration_digest', 'authority_digest', 'authority_registration_digest'] as const) assertSha(payload[field], field)
  assertNullableSha(payload.fanout_child_provenance_digest, 'fanout_child_provenance_digest')
  assertNonNegativeInteger(payload.prior_attempt_ordinal, 'prior_attempt_ordinal')
  assertPositiveInteger(payload.next_attempt_ordinal, 'next_attempt_ordinal')
  assertPositiveInteger(payload.retry_budget_before_reopen, 'retry_budget_before_reopen')
  assertNonNegativeInteger(payload.retry_budget_after_reopen, 'retry_budget_after_reopen')
  assertPositiveInteger(payload.retry_budget_generation_before, 'retry_budget_generation_before')
  assertPositiveInteger(payload.retry_budget_generation_after, 'retry_budget_generation_after')
  if (payload.next_attempt_ordinal !== payload.prior_attempt_ordinal + 1 || payload.retry_budget_after_reopen !== payload.retry_budget_before_reopen - 1 || payload.retry_budget_generation_after !== payload.retry_budget_generation_before + 1) throw new ContractValidationError('REOPEN_NOT_AUTHORIZED', 'reopen ordinal or budget transition is non-contiguous')
  return payload
}

export interface ZeroExternalEffectAttestationConsumptionV1 {
  schema_version: 'aun-zero-external-effect-attestation-consumption/v1'
  reply_id: string
  delivery_id: string
  attempt_ordinal: number
  attestation_digest: Sha256
  evidence_digest: Sha256
  producer_registration_digest: Sha256
  reconciliation_outcome_key: Sha256
  reconciliation_resolved_event_id: string
  reopen_event_id: string
}

const ATTESTATION_CONSUMPTION_FIELDS = ['schema_version', 'reply_id', 'delivery_id', 'attempt_ordinal', 'attestation_digest', 'evidence_digest', 'producer_registration_digest', 'reconciliation_outcome_key', 'reconciliation_resolved_event_id', 'reopen_event_id'] as const

export function decodeAttestationConsumption(value: unknown): ZeroExternalEffectAttestationConsumptionV1 {
  assertExactKeys(value, ATTESTATION_CONSUMPTION_FIELDS, 'ZeroExternalEffectAttestationConsumptionV1')
  const consumption = value as unknown as ZeroExternalEffectAttestationConsumptionV1
  if (consumption.schema_version !== 'aun-zero-external-effect-attestation-consumption/v1') throw new ContractValidationError('STRICT_DECODE_FAILED', 'wrong attestation consumption schema')
  for (const field of ['reply_id', 'delivery_id', 'reconciliation_resolved_event_id', 'reopen_event_id'] as const) assertString(consumption[field], field)
  assertNonNegativeInteger(consumption.attempt_ordinal, 'attempt_ordinal')
  for (const field of ['attestation_digest', 'evidence_digest', 'producer_registration_digest', 'reconciliation_outcome_key'] as const) assertSha(consumption[field], field)
  return consumption
}

export interface FanoutRequestV1 {
  schema_version: 'aun-fanout-request/v1'
  fanout_id: string
  sender_seat_id: string
  conversation_id: string
  turn_id: string
  parent_reply_id: string
  correlation_id: string | null
  causation_id: string | null
  recipient_seat_ids: string[]
  content: { media_type: 'text/plain'; text: string }
  authority_snapshot_digest: Sha256
  resolver_version: string
  fanout_digest: Sha256
}

export interface FanoutPlanChildV1 {
  recipient_seat_id: string
  child_reply_id: string
  delivery_id: string
  destination_ref: Sha256
  resolved_binding_snapshot_digest: Sha256
  resolved_delivery_decision_digest: Sha256
  fanout_child_provenance_digest: Sha256
}

export interface FanoutPlanV1 {
  schema_version: 'aun-fanout-plan/v1'
  fanout_id: string
  fanout_digest: Sha256
  parent_reply_id: string
  authority_snapshot_digest: Sha256
  resolver_version: string
  children: FanoutPlanChildV1[]
}

const FANOUT_REQUEST_FIELDS = ['schema_version', 'fanout_id', 'sender_seat_id', 'conversation_id', 'turn_id', 'parent_reply_id', 'correlation_id', 'causation_id', 'recipient_seat_ids', 'content', 'authority_snapshot_digest', 'resolver_version', 'fanout_digest'] as const
const FANOUT_PLAN_FIELDS = ['schema_version', 'fanout_id', 'fanout_digest', 'parent_reply_id', 'authority_snapshot_digest', 'resolver_version', 'children'] as const
const FANOUT_PLAN_CHILD_FIELDS = ['recipient_seat_id', 'child_reply_id', 'delivery_id', 'destination_ref', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'fanout_child_provenance_digest'] as const
const FANOUT_PROVENANCE_FIELDS = ['schema_version', 'fanout_planned_event_id', 'fanout_id', 'fanout_digest', 'parent_reply_id', 'provenance_digest'] as const

export function fanoutDigest(value: Omit<FanoutRequestV1, 'fanout_digest'> | FanoutRequestV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.fanoutRequest, withoutField(value as unknown as Record<string, unknown>, 'fanout_digest'))
}

/**
 * FanoutExpanderPort input boundary: normalize the set-like recipient list
 * before identity is derived. Duplicate, empty, or malformed inputs remain
 * cardinality failures; only ordering differences normalize to one identity.
 */
export function buildFanoutRequest(
  value: Omit<FanoutRequestV1, 'fanout_digest'>,
): FanoutRequestV1 {
  const recipientSeatIds = sortedUnique(value.recipient_seat_ids, 'recipient_seat_ids')
  const material = { ...value, recipient_seat_ids: recipientSeatIds }
  const request = { ...material, fanout_digest: fanoutDigest(material) }
  return decodeFanoutRequest(request)
}

export function decodeFanoutRequest(value: unknown): FanoutRequestV1 {
  assertExactKeys(value, FANOUT_REQUEST_FIELDS, 'FanoutRequestV1')
  const request = value as unknown as FanoutRequestV1
  if (request.schema_version !== 'aun-fanout-request/v1') throw new ContractValidationError('FANOUT_COLLISION', 'wrong fanout request schema')
  for (const field of ['fanout_id', 'sender_seat_id', 'conversation_id', 'turn_id', 'parent_reply_id', 'resolver_version'] as const) assertString(request[field], field)
  assertNullableString(request.correlation_id, 'correlation_id')
  assertNullableString(request.causation_id, 'causation_id')
  assertAlreadySortedUnique(request.recipient_seat_ids, 'recipient_seat_ids')
  if (request.recipient_seat_ids.length === 0) throw new ContractValidationError('FANOUT_COLLISION', 'fanout recipient set is empty')
  assertExactKeys(request.content, ['media_type', 'text'], 'fanout content')
  if (request.content.media_type !== 'text/plain') throw new ContractValidationError('FANOUT_COLLISION', 'unsupported fanout content type')
  assertString(request.content.text, 'content.text')
  for (const field of ['authority_snapshot_digest', 'fanout_digest'] as const) assertSha(request[field], field)
  if (fanoutDigest(request) !== request.fanout_digest) throw new ContractValidationError('FANOUT_COLLISION', 'fanout digest differs')
  return request
}

export function decodeFanoutProvenance(value: unknown): FanoutChildProvenanceV1 {
  assertExactKeys(value, FANOUT_PROVENANCE_FIELDS, 'FanoutChildProvenanceV1')
  const provenance = value as unknown as FanoutChildProvenanceV1
  if (provenance.schema_version !== 'aun-fanout-child-provenance/v1') throw new ContractValidationError('FANOUT_PARENT_LINK_MISMATCH', 'wrong fanout provenance schema')
  for (const field of ['fanout_planned_event_id', 'fanout_id', 'parent_reply_id'] as const) assertString(provenance[field], field)
  for (const field of ['fanout_digest', 'provenance_digest'] as const) assertSha(provenance[field], field)
  if (fanoutProvenanceDigest(provenance) !== provenance.provenance_digest) throw new ContractValidationError('FANOUT_PARENT_LINK_MISMATCH', 'fanout provenance digest differs')
  return provenance
}

export function decodeFanoutPlan(value: unknown): FanoutPlanV1 {
  assertExactKeys(value, FANOUT_PLAN_FIELDS, 'FanoutPlanV1')
  const plan = value as unknown as FanoutPlanV1
  if (plan.schema_version !== 'aun-fanout-plan/v1') throw new ContractValidationError('FANOUT_COLLISION', 'wrong fanout plan schema')
  for (const field of ['fanout_id', 'parent_reply_id', 'resolver_version'] as const) assertString(plan[field], field)
  for (const field of ['fanout_digest', 'authority_snapshot_digest'] as const) assertSha(plan[field], field)
  if (!Array.isArray(plan.children) || plan.children.length === 0) throw new ContractValidationError('FANOUT_COLLISION', 'fanout plan children are missing')
  const recipients: string[] = []
  for (const child of plan.children) {
    assertExactKeys(child, FANOUT_PLAN_CHILD_FIELDS, 'FanoutPlanChildV1')
    for (const field of ['recipient_seat_id', 'child_reply_id', 'delivery_id'] as const) assertString(child[field], field)
    for (const field of ['destination_ref', 'resolved_binding_snapshot_digest', 'resolved_delivery_decision_digest', 'fanout_child_provenance_digest'] as const) assertSha(child[field], field)
    const expected = fanoutChildIds(plan.fanout_id, plan.fanout_digest, child.recipient_seat_id)
    if (child.child_reply_id !== expected.child_reply_id || child.delivery_id !== expected.delivery_id) throw new ContractValidationError('FANOUT_COLLISION', 'fanout child identity differs')
    recipients.push(child.recipient_seat_id)
  }
  const canonicalRecipients = sortedUnique(recipients, 'fanout plan recipients')
  if (canonicalRecipients.some((recipient, index) => recipient !== recipients[index])) throw new ContractValidationError('FANOUT_COLLISION', 'fanout plan children must be sorted')
  return plan
}

export function fanoutChildHash(fanoutId: string, digest: Sha256, recipientSeatId: string): Sha256 {
  return sha256Utf8(CONTRACT_DOMAINS.fanoutChild + fanoutId + '\n' + digest + '\n' + recipientSeatId)
}

export function fanoutChildIds(fanoutId: string, digest: Sha256, recipientSeatId: string): { child_reply_id: string; delivery_id: string } {
  const hash = fanoutChildHash(fanoutId, digest, recipientSeatId)
  return { child_reply_id: `reply:fanout:${hash}`, delivery_id: `delivery:fanout:${hash}` }
}

export function fanoutProvenanceDigest(value: Omit<FanoutChildProvenanceV1, 'provenance_digest'> | FanoutChildProvenanceV1): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.fanoutProvenance, withoutField(value as unknown as Record<string, unknown>, 'provenance_digest'))
}

export function buildFanoutProvenance(fanoutPlannedEventId: string, request: FanoutRequestV1): FanoutChildProvenanceV1 {
  const material = {
    schema_version: 'aun-fanout-child-provenance/v1' as const,
    fanout_planned_event_id: fanoutPlannedEventId,
    fanout_id: request.fanout_id,
    fanout_digest: request.fanout_digest,
    parent_reply_id: request.parent_reply_id,
  }
  return { ...material, provenance_digest: fanoutProvenanceDigest(material) }
}

export function reconciliationObservationEventId(deliveryUnknownEventId: string, observationDigest: Sha256): string {
  return `delivery-reconciliation-observed:${sha256Utf8(CONTRACT_DOMAINS.reconciliationObservationEvent + deliveryUnknownEventId + '\n' + observationDigest)}`
}

export function reconciliationOutcomeEventId(deliveryId: string, attemptOrdinal: number): string {
  return `delivery-reconciliation-outcome:${digestCanonical(CONTRACT_DOMAINS.reconciliationOutcome, { delivery_id: deliveryId, attempt_ordinal: attemptOrdinal })}`
}

export function reconciliationOutcomeKey(deliveryId: string, attemptOrdinal: number): Sha256 {
  return digestCanonical(CONTRACT_DOMAINS.reconciliationOutcomeKey, { delivery_id: deliveryId, attempt_ordinal: attemptOrdinal })
}

export function reopenEventId(deliveryUnknownEventId: string, deliveryId: string, nextAttemptOrdinal: number): string {
  return `delivery-reopened:${digestCanonical(CONTRACT_DOMAINS.reopen, { delivery_unknown_event_id: deliveryUnknownEventId, delivery_id: deliveryId, next_attempt_ordinal: nextAttemptOrdinal })}`
}

export function producerRegistrationEventId(registrationId: string, registryGeneration: number): string {
  return `zero-effect-producer-registration:${digestCanonical(CONTRACT_DOMAINS.producerRegistrationKey, { registration_id: registrationId, registry_generation: registryGeneration })}`
}

export function issuerRegistrationEventId(registrationId: string, registryGeneration: number): string {
  return `retry-budget-issuer-registration:${digestCanonical(CONTRACT_DOMAINS.issuerRegistrationKey, { registration_id: registrationId, registry_generation: registryGeneration })}`
}

export function retryBudgetSnapshotEventId(deliveryId: string, generation: number): string {
  return `retry-budget-snapshot:${digestCanonical(CONTRACT_DOMAINS.retryBudgetSnapshotKey, { delivery_id: deliveryId, generation })}`
}

export function attestationConsumptionEventId(attestationDigestValue: Sha256): string {
  return `zero-external-effect-attestation-consumed:${digestCanonical(CONTRACT_DOMAINS.attestationConsumptionKey, { attestation_digest: attestationDigestValue })}`
}

export function producerRegistrationEvent(registration: ZeroEffectProducerRegistrationV1): AppendEvent {
  decodeProducerRegistration(registration)
  return { eventId: producerRegistrationEventId(registration.registration_id, registration.registry_generation), eventType: 'authority.zero_effect_producer_registered', payload: registration as unknown as Record<string, unknown> }
}

export function issuerRegistrationEvent(registration: RetryBudgetIssuerRegistrationV1): AppendEvent {
  decodeIssuerRegistration(registration)
  return { eventId: issuerRegistrationEventId(registration.registration_id, registration.registry_generation), eventType: 'authority.retry_budget_issuer_registered', payload: registration as unknown as Record<string, unknown> }
}

export function evidenceEvent(record: ZeroExternalEffectEvidenceRecordV1): AppendEvent {
  decodeEvidenceRecord(record)
  return { eventId: `zero-external-effect-evidence:${record.evidence_digest}`, eventType: 'reply.zero_external_effect_evidence_recorded', payload: record as unknown as Record<string, unknown> }
}

export function attestationEvent(attestation: ZeroExternalEffectAttestationV1): AppendEvent {
  decodeAttestation(attestation)
  return { eventId: `zero-external-effect-attestation:${attestation.attestation_digest}`, eventType: 'reply.zero_external_effect_attested', replyId: null, claimEpoch: attestation.attempt_ordinal, payload: attestation as unknown as Record<string, unknown> }
}

export function retryBudgetSnapshotEvent(snapshot: RetryBudgetSnapshotV1): AppendEvent {
  decodeRetryBudgetSnapshot(snapshot)
  return { eventId: retryBudgetSnapshotEventId(snapshot.delivery_id, snapshot.generation), eventType: 'reply.retry_budget_snapshot', replyId: snapshot.reply_id, payload: snapshot as unknown as Record<string, unknown> }
}

export const RETRY_BUDGET_AUTHORITY_VECTOR_CANONICAL_JSON = '{"authority_registration_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","budget_policy_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capability_digest":"6666666666666666666666666666666666666666666666666666666666666666","current_attempt_ordinal":0,"delivery_id":"delivery-001","expires_at":"2026-07-13T00:05:00Z","generation_after":2,"generation_before":1,"issued_at":"2026-07-13T00:00:00Z","remaining_after":0,"remaining_before":1}'
export const RETRY_BUDGET_AUTHORITY_VECTOR_DIGEST = 'c71a8ada0db7df5f5c608acdaf2dad0054aa9ea434dd0f6098302438481bf009'
export const REOPENED_PAYLOAD_VECTOR_CANONICAL_JSON = '{"attestation_digest":"b9a883aba5fc51dfcb145d8dd044111e1118a17faa45de0d3f44f2db2f2e7863","authority_digest":"c71a8ada0db7df5f5c608acdaf2dad0054aa9ea434dd0f6098302438481bf009","authority_registration_digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","capability_digest":"6666666666666666666666666666666666666666666666666666666666666666","causation_delivery_unknown_event_id":"delivery-unknown:evt-001","delivery_id":"delivery-001","fanout_child_provenance_digest":null,"next_attempt_ordinal":1,"prior_attempt_ordinal":0,"producer_registration_digest":"9999999999999999999999999999999999999999999999999999999999999999","provider_request_digest":"5555555555555555555555555555555555555555555555555555555555555555","recipient_seat_id":"spec","reconciliation_observation_digest":"2c5b765c6d73a4855889ee76d9ced137c83673a48c4a7c3f75a0ef1323c89877","reconciliation_request_digest":"fd910d0635103dac95e6278a82cf5fee68d25a3ceb63907eabd2677499d2240a","reply_id":"reply-001","retry_budget_after_reopen":0,"retry_budget_before_reopen":1,"retry_budget_generation_after":2,"retry_budget_generation_before":1}'
export const REOPENED_PAYLOAD_VECTOR_DIGEST = 'b6604c8a9b84889c0fcb146d1a77f2930f904a8f25124d7b215a621f56d6bc02'
