/** Trusted loaded-connector registry for Transport-Neutral Contract r1.1.4. */

import { createHash } from 'node:crypto'
import type { DbAdapter } from '../db/adapter'
import { assertByteIdenticalEvent, EventLog } from './store'
import {
  LoadedRegistrationUnprovenError,
  parseEventPayload,
  type AppendEvent,
  type AppendResult,
  type StoredEvent,
} from './types'
import {
  ContractValidationError,
  decodeConnectorCapability,
  decodeIssuerRegistration,
  decodeLoadedConnectorRegistration,
  decodeProducerRegistration,
  issuerRegistrationEvent,
  loadedConnectorRegistrationEventId,
  producerRegistrationEvent,
  type CapabilityAuthorityV1,
  type ConnectorDeliveryCapabilityV1,
  type LoadedConnectorRegistrationV1,
  type RetryBudgetIssuerRegistrationV1,
  type Sha256,
  type ZeroEffectProducerRegistrationV1,
} from './transport-contract'

class ConnectorRegistryEventLog extends EventLog {
  appendVerifiedAuthority(input: AppendEvent): Promise<AppendResult> {
    return this.appendRegistryVerifiedAuthority(input)
  }
}

export interface LoadedBuildAttestationVerificationV1 {
  verified: true
  attestation_ref: string
  attestation_digest: Sha256
  subject_adapter_build_digest: Sha256
  subject_capability_digest: Sha256
  subject_fixture_manifest_digest: Sha256
  registry_generation: number
}

/** This port is installed by the registered loader, never by a delivery caller. */
export interface LoadedConnectorVerifierPort {
  readonly loader_identity_digest: Sha256
  verifyBuildTestAttestation(input: {
    registration: LoadedConnectorRegistrationV1
    capability: ConnectorDeliveryCapabilityV1
    observed_adapter_build_digest: Sha256
    observed_fixture_manifest_digest: Sha256
  }): Promise<LoadedBuildAttestationVerificationV1>
  verifyZeroEffectProducerRegistration?(input: {
    registration: ZeroEffectProducerRegistrationV1
    capability: ConnectorDeliveryCapabilityV1
    producer_build_digest: Sha256
  }): Promise<{
    verified: true
    producer_build_digest: Sha256
    build_test_attestation_digest: Sha256
    registry_generation: number
    verifier_contract_version: string
  }>
  verifyRetryBudgetIssuerRegistration?(input: {
    registration: RetryBudgetIssuerRegistrationV1
    capability: ConnectorDeliveryCapabilityV1
    issuer_build_digest: Sha256
    policy_source_digest: Sha256
  }): Promise<{
    verified: true
    issuer_build_digest: Sha256
    build_test_attestation_digest: Sha256
    policy_source_digest: Sha256
    registry_generation: number
  }>
}

export interface RegisterLoadedConnectorInput {
  registration: LoadedConnectorRegistrationV1
  capability: ConnectorDeliveryCapabilityV1
  loaded_adapter_bytes: Uint8Array
  fixture_manifest_bytes: Uint8Array
}

export interface ResolveLoadedCapabilityInput {
  connector_instance_id: string
  loaded_registration_digest: Sha256
  capability: ConnectorDeliveryCapabilityV1
  /** Bytes from the currently loaded adapter, supplied by the trusted loader. */
  loaded_adapter_bytes: Uint8Array
  /** Bytes of the currently installed versioned fixture manifest. */
  fixture_manifest_bytes: Uint8Array
}

export interface ResolvedLoadedCapabilityV1 {
  registration: LoadedConnectorRegistrationV1
  authority: CapabilityAuthorityV1
}

export interface RegisterZeroEffectProducerInputV1 extends ResolveLoadedCapabilityInput {
  registration: ZeroEffectProducerRegistrationV1
  producer_build_bytes: Uint8Array
}

export interface RegisterRetryBudgetIssuerInputV1 extends ResolveLoadedCapabilityInput {
  registration: RetryBudgetIssuerRegistrationV1
  issuer_build_bytes: Uint8Array
  policy_source_bytes: Uint8Array
}

function sha256Bytes(bytes: Uint8Array): Sha256 {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireSha(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new LoadedRegistrationUnprovenError(`${field} must be lowercase sha256`)
  }
}

function fail(message: string): never {
  throw new LoadedRegistrationUnprovenError(message)
}

export class ConnectorRegistry {
  private readonly log: ConnectorRegistryEventLog

  constructor(
    private readonly db: DbAdapter,
    private readonly verifier: LoadedConnectorVerifierPort,
  ) {
    requireSha(verifier.loader_identity_digest, 'loader_identity_digest')
    this.log = new ConnectorRegistryEventLog(db)
  }

  async registerLoadedConnector(input: RegisterLoadedConnectorInput): Promise<{ inserted: boolean; registration: LoadedConnectorRegistrationV1 }> {
    let registration: LoadedConnectorRegistrationV1
    let capability: ConnectorDeliveryCapabilityV1
    try {
      registration = decodeLoadedConnectorRegistration(input.registration)
      capability = decodeConnectorCapability(input.capability)
    } catch (error) {
      if (error instanceof ContractValidationError) fail(error.message)
      throw error
    }

    const observedAdapterBuildDigest = sha256Bytes(input.loaded_adapter_bytes)
    const observedFixtureManifestDigest = sha256Bytes(input.fixture_manifest_bytes)
    if (
      registration.connector_instance_id !== capability.connector_instance_id ||
      registration.connector_kind !== capability.connector_kind ||
      registration.adapter_contract_version !== capability.adapter_contract_version ||
      registration.adapter_build_digest !== observedAdapterBuildDigest ||
      registration.adapter_build_digest !== capability.adapter_build_digest ||
      registration.canonical_capability_digest !== capability.capability_digest ||
      registration.fixture_manifest_digest !== observedFixtureManifestDigest ||
      registration.fixture_manifest_digest !== capability.capability_fixture_set_digest ||
      registration.loader_identity_digest !== this.verifier.loader_identity_digest
    ) {
      fail('loaded bytes, fixture bytes, capability, or loader identity do not match registration')
    }

    const attestation = await this.verifier.verifyBuildTestAttestation({
      registration,
      capability,
      observed_adapter_build_digest: observedAdapterBuildDigest,
      observed_fixture_manifest_digest: observedFixtureManifestDigest,
    })
    requireSha(attestation.attestation_digest, 'attestation_digest')
    if (
      attestation.verified !== true ||
      attestation.attestation_ref !== registration.build_test_attestation_ref ||
      attestation.attestation_digest !== registration.build_test_attestation_digest ||
      attestation.subject_adapter_build_digest !== observedAdapterBuildDigest ||
      attestation.subject_capability_digest !== capability.capability_digest ||
      attestation.subject_fixture_manifest_digest !== observedFixtureManifestDigest ||
      attestation.registry_generation !== registration.registry_generation
    ) {
      fail('build-test attestation does not bind loaded bytes, fixtures, capability, and generation')
    }

    const eventId = loadedConnectorRegistrationEventId(
      registration.registration_id,
      registration.registry_generation,
    )
    const result = await this.log.append({
      eventId,
      eventType: 'authority.loaded_connector_registered',
      payload: registration as unknown as Record<string, unknown>,
    })
    return { inserted: result.inserted, registration }
  }

  async resolveCapabilityAuthority(input: ResolveLoadedCapabilityInput): Promise<ResolvedLoadedCapabilityV1> {
    requireSha(input.loaded_registration_digest, 'loaded_registration_digest')
    let capability: ConnectorDeliveryCapabilityV1
    try {
      capability = decodeConnectorCapability(input.capability)
    } catch (error) {
      if (error instanceof ContractValidationError) fail(error.message)
      throw error
    }

    const stored = await this.db.query<StoredEvent>(
      `SELECT * FROM event_log
       WHERE event_type = 'authority.loaded_connector_registered'
       ORDER BY seq ASC`,
    )
    const registrations = stored.map(event => {
      let registration: LoadedConnectorRegistrationV1
      try {
        registration = decodeLoadedConnectorRegistration(parseEventPayload(event.payload))
      } catch (error) {
        fail(`persisted loaded registration cannot be decoded: ${String(error)}`)
      }
      const expectedEventId = loadedConnectorRegistrationEventId(
        registration!.registration_id,
        registration!.registry_generation,
      )
      if (event.event_id !== expectedEventId) fail('persisted loaded registration event_id does not recompute')
      try {
        assertByteIdenticalEvent({
          eventId: expectedEventId,
          eventType: 'authority.loaded_connector_registered',
          payload: registration as unknown as Record<string, unknown>,
        }, event)
      } catch (error) {
        fail(`persisted loaded registration conflict material differs: ${String(error)}`)
      }
      return registration!
    }).filter(registration => registration.connector_instance_id === input.connector_instance_id)

    if (registrations.length === 0) fail('loaded registration is missing')
    const currentGeneration = Math.max(...registrations.map(item => item.registry_generation))
    const current = registrations.filter(item => item.registry_generation === currentGeneration)
    if (current.length !== 1 || current[0].status !== 'active') fail('current loaded registration is duplicated, missing, or revoked')
    const registration = current[0]
    const observedAdapterBuildDigest = sha256Bytes(input.loaded_adapter_bytes)
    const observedFixtureManifestDigest = sha256Bytes(input.fixture_manifest_bytes)
    if (
      registration.registration_digest !== input.loaded_registration_digest ||
      registration.loader_identity_digest !== this.verifier.loader_identity_digest ||
      registration.connector_instance_id !== capability.connector_instance_id ||
      registration.connector_kind !== capability.connector_kind ||
      registration.adapter_contract_version !== capability.adapter_contract_version ||
      registration.adapter_build_digest !== capability.adapter_build_digest ||
      registration.canonical_capability_digest !== capability.capability_digest ||
      registration.fixture_manifest_digest !== capability.capability_fixture_set_digest ||
      registration.adapter_build_digest !== observedAdapterBuildDigest ||
      registration.fixture_manifest_digest !== observedFixtureManifestDigest
    ) {
      fail('current loaded registration does not bind requested capability authority')
    }

    const attestation = await this.verifier.verifyBuildTestAttestation({
      registration,
      capability,
      observed_adapter_build_digest: observedAdapterBuildDigest,
      observed_fixture_manifest_digest: observedFixtureManifestDigest,
    })
    if (
      attestation.verified !== true ||
      attestation.attestation_ref !== registration.build_test_attestation_ref ||
      attestation.attestation_digest !== registration.build_test_attestation_digest ||
      attestation.subject_adapter_build_digest !== observedAdapterBuildDigest ||
      attestation.subject_capability_digest !== capability.capability_digest ||
      attestation.subject_fixture_manifest_digest !== observedFixtureManifestDigest ||
      attestation.registry_generation !== registration.registry_generation
    ) fail('restart readback cannot reproduce loaded build/fixture attestation authority')

    return {
      registration,
      authority: {
        source: 'registered_loaded_adapter',
        connector_instance_id: capability.connector_instance_id,
        adapter_contract_version: capability.adapter_contract_version,
        adapter_build_digest: capability.adapter_build_digest,
        capability_digest: capability.capability_digest,
        capability_fixture_set_digest: capability.capability_fixture_set_digest,
        loaded_registration_digest: registration.registration_digest,
        caller_supplied_capability_is_authority: false,
      },
    }
  }

  async registerZeroEffectProducer(input: RegisterZeroEffectProducerInputV1): Promise<{ inserted: boolean; registration: ZeroEffectProducerRegistrationV1 }> {
    let registration: ZeroEffectProducerRegistrationV1
    try {
      registration = decodeProducerRegistration(input.registration)
    } catch (error) {
      fail(`zero-effect producer registration failed strict decode: ${String(error)}`)
    }
    if (!this.verifier.verifyZeroEffectProducerRegistration) fail('trusted producer verifier is not installed')
    const resolved = await this.resolveCapabilityAuthority(input)
    const observedBuildDigest = sha256Bytes(input.producer_build_bytes)
    const verification = await this.verifier.verifyZeroEffectProducerRegistration!({
      registration: registration!,
      capability: input.capability,
      producer_build_digest: observedBuildDigest,
    })
    if (
      verification.verified !== true ||
      registration!.status !== 'active' ||
      registration!.connector_instance_id !== resolved.registration.connector_instance_id ||
      registration!.capability_digest !== resolved.registration.canonical_capability_digest ||
      registration!.producer_build_digest !== observedBuildDigest ||
      verification.producer_build_digest !== observedBuildDigest ||
      verification.build_test_attestation_digest !== registration!.build_test_attestation_digest ||
      verification.registry_generation !== registration!.registry_generation ||
      verification.registry_generation !== resolved.registration.registry_generation ||
      verification.verifier_contract_version !== registration!.verifier_contract_version
    ) fail('producer registration is not bound to loaded capability/build/test authority')
    const result = await this.log.appendVerifiedAuthority(producerRegistrationEvent(registration!))
    return { inserted: result.inserted, registration: registration! }
  }

  async registerRetryBudgetIssuer(input: RegisterRetryBudgetIssuerInputV1): Promise<{ inserted: boolean; registration: RetryBudgetIssuerRegistrationV1 }> {
    let registration: RetryBudgetIssuerRegistrationV1
    try {
      registration = decodeIssuerRegistration(input.registration)
    } catch (error) {
      fail(`retry-budget issuer registration failed strict decode: ${String(error)}`)
    }
    if (!this.verifier.verifyRetryBudgetIssuerRegistration) fail('trusted retry-budget issuer verifier is not installed')
    const resolved = await this.resolveCapabilityAuthority(input)
    const observedBuildDigest = sha256Bytes(input.issuer_build_bytes)
    const observedPolicyDigest = sha256Bytes(input.policy_source_bytes)
    const verification = await this.verifier.verifyRetryBudgetIssuerRegistration!({
      registration: registration!,
      capability: input.capability,
      issuer_build_digest: observedBuildDigest,
      policy_source_digest: observedPolicyDigest,
    })
    if (
      verification.verified !== true ||
      registration!.status !== 'active' ||
      registration!.capability_digest !== resolved.registration.canonical_capability_digest ||
      registration!.issuer_build_digest !== observedBuildDigest ||
      registration!.policy_source_digest !== observedPolicyDigest ||
      verification.issuer_build_digest !== observedBuildDigest ||
      verification.policy_source_digest !== observedPolicyDigest ||
      verification.build_test_attestation_digest !== registration!.build_test_attestation_digest ||
      verification.registry_generation !== registration!.registry_generation ||
      verification.registry_generation !== resolved.registration.registry_generation
    ) fail('retry-budget issuer registration is not bound to loaded capability/policy/build/test authority')
    const result = await this.log.appendVerifiedAuthority(issuerRegistrationEvent(registration!))
    return { inserted: result.inserted, registration: registration! }
  }
}
