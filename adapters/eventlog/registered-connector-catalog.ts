/**
 * Checked-in, connector-neutral production catalog for the dormant registered
 * loader.  This module exports data only: it has no database, writer, verifier,
 * callback, or live authority handle.
 */

import {
  canonicalJson,
  connectorCapabilityDigest,
  issuerRegistrationDigest,
  loadedConnectorRegistrationDigest,
  producerRegistrationDigest,
  sha256Utf8,
  type ConnectorDeliveryCapabilityV1,
  type LoadedConnectorRegistrationV1,
  type RetryBudgetIssuerRegistrationV1,
  type Sha256,
  type ZeroEffectProducerRegistrationV1,
} from '../../core/eventlog/transport-contract'

export interface RegisteredConnectorCatalogEntryV1 {
  connector_kind: string
  adapter_contract_version: string
  connector_instance_selector: string
  adapter_module_specifier: string
  adapter_build_digest: Sha256
  capability_digest: Sha256
  fixture_manifest_ref: string
  fixture_manifest_digest: Sha256
  build_test_attestation_ref: string
  build_test_attestation_digest: Sha256
  producer_build_digest: Sha256
  issuer_build_digest: Sha256
  policy_source_digest: Sha256
  registry_generation: number
  verifier_contract_version: string
}

export interface RegisteredConnectorCatalogV1 {
  schema_version: 'aun-registered-connector-catalog/v1'
  entries: readonly RegisteredConnectorCatalogEntryV1[]
  catalog_digest: Sha256
}

const shaBytes = (value: string): Sha256 => sha256Utf8(value)

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

const embedded = deepFreeze({
  fixture_manifest: canonicalJson({
    schema_version: 'aun-registered-connector-fixture-manifest/v1',
    connector_kind: 'discord',
    adapter_contract_version: '1.1.4',
    fixtures: ['discord-frozen-request-v1', 'discord-provider-ack-v1'],
  }),
  loaded_build_attestation: 'registered-loader:discord:loaded-build-attestation:v1\n',
  producer_build: 'registered-loader:discord:zero-effect-producer:v1\n',
  producer_build_attestation: 'registered-loader:discord:producer-build-attestation:v1\n',
  issuer_build: 'registered-loader:discord:retry-budget-issuer:v1\n',
  issuer_build_attestation: 'registered-loader:discord:issuer-build-attestation:v1\n',
  policy_source: 'registered-loader:discord:retry-budget-policy:v1\n',
})

const connectorInstanceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const adapterBuildDigest = '4792797fa065b0d7ae1eb4e6e530947c60a8a91fee3d0cbbb463ec9dcab6c371'
const fixtureManifestDigest = shaBytes(embedded.fixture_manifest)
const loadedBuildAttestationDigest = shaBytes(embedded.loaded_build_attestation)
const producerBuildDigest = shaBytes(embedded.producer_build)
const producerBuildAttestationDigest = shaBytes(embedded.producer_build_attestation)
const issuerBuildDigest = shaBytes(embedded.issuer_build)
const issuerBuildAttestationDigest = shaBytes(embedded.issuer_build_attestation)
const policySourceDigest = shaBytes(embedded.policy_source)

const capabilityWithoutDigest: Omit<ConnectorDeliveryCapabilityV1, 'capability_digest'> = {
  schema_version: 'aun-connector-delivery-capability/v1',
  connector_instance_id: connectorInstanceId,
  connector_kind: 'discord',
  idempotency_mode: 'none',
  receipt_mode: 'provider_ack',
  dedupe_scope: null,
  dedupe_window_seconds: null,
  provider_nonce_max_bytes: null,
  provider_nonce_charset: null,
  semantic_capabilities: ['direct_attention', 'post_message', 'reply_context'],
  reconciliation_mode: 'provider_lookup',
  guarantee: 'at_least_once',
  typed_rate_limit_retry_budget: 3,
  ambiguous_outcome_retry_budget: 0,
  adapter_contract_version: '1.1.4',
  adapter_build_digest: adapterBuildDigest,
  capability_fixture_set_digest: fixtureManifestDigest,
}

export const REGISTERED_DISCORD_CAPABILITY: Readonly<ConnectorDeliveryCapabilityV1> = deepFreeze({
  ...capabilityWithoutDigest,
  capability_digest: connectorCapabilityDigest(capabilityWithoutDigest),
})

const entryWithoutCatalogDigest: RegisteredConnectorCatalogEntryV1 = {
  connector_kind: 'discord',
  adapter_contract_version: '1.1.4',
  connector_instance_selector: connectorInstanceId,
  adapter_module_specifier: '../../adapters/eventlog/discord-transport.ts',
  adapter_build_digest: adapterBuildDigest,
  capability_digest: REGISTERED_DISCORD_CAPABILITY.capability_digest,
  fixture_manifest_ref: 'embedded://registered-loader/discord-fixtures/v1',
  fixture_manifest_digest: fixtureManifestDigest,
  build_test_attestation_ref: 'embedded://registered-loader/discord-loaded-attestation/v1',
  build_test_attestation_digest: loadedBuildAttestationDigest,
  producer_build_digest: producerBuildDigest,
  issuer_build_digest: issuerBuildDigest,
  policy_source_digest: policySourceDigest,
  registry_generation: 1,
  verifier_contract_version: 'registered-loader/v1',
}

const sortedEntries = deepFreeze([{ ...entryWithoutCatalogDigest }])
const catalogDigest = sha256Utf8(
  'aun-registered-connector-catalog/v1\n' + canonicalJson(sortedEntries),
)
const loaderIdentityDigest = sha256Utf8(
  'aun-registered-loader-identity/v1\n' + canonicalJson({
    catalog_digest: catalogDigest,
    composition_module_specifier: 'core/eventlog/registered-loader.ts',
    verifier_contract_version: 'registered-loader/v1',
  }),
)

export const REGISTERED_CONNECTOR_CATALOG: Readonly<RegisteredConnectorCatalogV1> = deepFreeze({
  schema_version: 'aun-registered-connector-catalog/v1',
  entries: sortedEntries,
  catalog_digest: catalogDigest,
})

const loadedWithoutDigest: Omit<LoadedConnectorRegistrationV1, 'registration_digest'> = {
  schema_version: 'aun-loaded-connector-registration/v1',
  registration_id: '11111111-1111-4111-8111-111111111111',
  connector_instance_id: connectorInstanceId,
  connector_kind: 'discord',
  loaded_adapter_instance_id: 'registered-discord-transport/v1',
  adapter_contract_version: '1.1.4',
  adapter_build_digest: adapterBuildDigest,
  canonical_capability_digest: REGISTERED_DISCORD_CAPABILITY.capability_digest,
  fixture_manifest_version: '1.0.0',
  fixture_manifest_digest: fixtureManifestDigest,
  build_test_attestation_ref: entryWithoutCatalogDigest.build_test_attestation_ref,
  build_test_attestation_digest: loadedBuildAttestationDigest,
  loader_identity_digest: loaderIdentityDigest,
  registry_generation: 1,
  status: 'active',
}

export const REGISTERED_LOADED_CONNECTOR: Readonly<LoadedConnectorRegistrationV1> = deepFreeze({
  ...loadedWithoutDigest,
  registration_digest: loadedConnectorRegistrationDigest(loadedWithoutDigest),
})

const producerWithoutDigest: Omit<ZeroEffectProducerRegistrationV1, 'registration_digest'> = {
  schema_version: 'aun-zero-effect-producer-registration/v1',
  registration_id: '22222222-2222-4222-8222-222222222222',
  producer_instance_id: 'registered-discord-zero-effect-producer/v1',
  producer_kind: 'provider_rejection_verifier',
  connector_instance_id: connectorInstanceId,
  capability_digest: REGISTERED_DISCORD_CAPABILITY.capability_digest,
  authorized_evidence_kinds: ['provider_rejected_before_effect'],
  verifier_contract_version: 'registered-loader/v1',
  producer_build_digest: producerBuildDigest,
  build_test_attestation_digest: producerBuildAttestationDigest,
  registry_generation: 1,
  valid_from: '2020-01-01T00:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  status: 'active',
}

export const REGISTERED_ZERO_EFFECT_PRODUCER: Readonly<ZeroEffectProducerRegistrationV1> = deepFreeze({
  ...producerWithoutDigest,
  registration_digest: producerRegistrationDigest(producerWithoutDigest),
})

const issuerWithoutDigest: Omit<RetryBudgetIssuerRegistrationV1, 'registration_digest'> = {
  schema_version: 'aun-retry-budget-issuer-registration/v1',
  registration_id: '33333333-3333-4333-8333-333333333333',
  issuer_instance_id: 'registered-discord-retry-budget-issuer/v1',
  capability_digest: REGISTERED_DISCORD_CAPABILITY.capability_digest,
  budget_policy_digest: policySourceDigest,
  policy_source_digest: policySourceDigest,
  issuer_build_digest: issuerBuildDigest,
  build_test_attestation_digest: issuerBuildAttestationDigest,
  registry_generation: 1,
  valid_from: '2020-01-01T00:00:00.000Z',
  expires_at: '2099-01-01T00:00:00.000Z',
  status: 'active',
}

export const REGISTERED_RETRY_BUDGET_ISSUER: Readonly<RetryBudgetIssuerRegistrationV1> = deepFreeze({
  ...issuerWithoutDigest,
  registration_digest: issuerRegistrationDigest(issuerWithoutDigest),
})

/** Checked-in byte sources. They are data-only and cannot confer persistence authority. */
export const REGISTERED_CONNECTOR_BYTE_SOURCES = deepFreeze({ ...embedded })
