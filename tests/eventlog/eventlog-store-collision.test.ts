import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ConnectorRegistry,
  EventIdCanonicalMaterialCollisionError,
  EventLog,
  LoadedRegistrationUnprovenError,
  connectorCapabilityDigest,
  ensureEventLogSchema,
  loadedConnectorRegistrationDigest,
  loadedConnectorRegistrationEventId,
  issuerRegistrationDigest,
  producerRegistrationDigest,
  type AppendEvent,
  type ConnectorDeliveryCapabilityV1,
  type LoadedConnectorRegistrationV1,
  type LoadedConnectorVerifierPort,
  type RetryBudgetIssuerRegistrationV1,
  type ZeroEffectProducerRegistrationV1,
} from '../../core/eventlog'

let dir: string
let path: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-collision-'))
  path = join(dir, 'eventlog.db')
  db = new SqliteAdapter(path)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

function baseEvent(): AppendEvent {
  return {
    eventId: 'same-id',
    eventType: 'message.received',
    seatId: 'aun',
    seatInstanceId: 'instance-1',
    conversationId: 'conversation-1',
    causationId: 'cause-1',
    correlationId: 'correlation-1',
    turnId: 'turn-1',
    replyId: 'reply-1',
    claimEpoch: 1,
    payload: { a: 1, nested: { z: true } },
  }
}

describe('AppendEventConflictMaterialV1', () => {
  test('same ID plus byte-identical canonical material is idempotent', async () => {
    const log = new EventLog(db)
    expect((await log.append(baseEvent())).inserted).toBe(true)
    const reordered = { ...baseEvent(), payload: { nested: { z: true }, a: 1 } }
    expect((await log.append(reordered)).inserted).toBe(false)
    expect(await log.count()).toBe(1)
  })

  test('every event type, identity, claim, and payload difference is a typed collision', async () => {
    const mutations: Array<(event: AppendEvent) => void> = [
      event => { event.eventType = 'conversation.linked' },
      event => { event.seatId = 'other-seat' },
      event => { event.seatInstanceId = 'instance-2' },
      event => { event.conversationId = 'conversation-2' },
      event => { event.causationId = 'cause-2' },
      event => { event.correlationId = 'correlation-2' },
      event => { event.turnId = 'turn-2' },
      event => { event.replyId = 'reply-2' },
      event => { event.claimEpoch = 2 },
      event => { event.payload = { a: 2, nested: { z: true } } },
    ]
    for (const [index, mutate] of mutations.entries()) {
      const isolated = new SqliteAdapter(join(dir, `field-${index}.db`))
      await ensureEventLogSchema(isolated)
      const log = new EventLog(isolated)
      await log.append(baseEvent())
      const changed = structuredClone(baseEvent())
      mutate(changed)
      await expect(log.append(changed)).rejects.toBeInstanceOf(EventIdCanonicalMaterialCollisionError)
      expect(await log.count()).toBe(1)
      await isolated.close()
    }
  })

  test('collision at every N-event position rolls back the complete batch', async () => {
    for (let collisionIndex = 0; collisionIndex < 4; collisionIndex += 1) {
      const isolated = new SqliteAdapter(join(dir, `batch-${collisionIndex}.db`))
      await ensureEventLogSchema(isolated)
      const log = new EventLog(isolated)
      await log.append({ eventId: `collision-${collisionIndex}`, eventType: 'conversation.linked', payload: { original: true } })
      const batch: AppendEvent[] = Array.from({ length: 4 }, (_, index) => ({
        eventId: index === collisionIndex ? `collision-${collisionIndex}` : `batch-${collisionIndex}-${index}`,
        eventType: 'conversation.linked',
        payload: index === collisionIndex ? { original: false } : { index },
      }))
      await expect(log.appendBatch(batch)).rejects.toBeInstanceOf(EventIdCanonicalMaterialCollisionError)
      expect(await log.count()).toBe(1)
      for (const event of batch) {
        if (event.eventId !== `collision-${collisionIndex}`) expect(await log.getByEventId(event.eventId)).toBeNull()
      }
      await isolated.close()
    }
  })
})

const CONNECTOR_ID = '11111111-1111-4111-8111-111111111111'
const REGISTRATION_ID = '00000000-0000-4000-8000-000000000001'
const adapterBytes = new TextEncoder().encode('loaded-discord-adapter-v1')
const fixtureBytes = new TextEncoder().encode('{"fixture":"discord-v1"}\n')
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

function registryFixture(ids: { connectorId?: string; registrationId?: string } = {}): {
  capability: ConnectorDeliveryCapabilityV1
  registration: LoadedConnectorRegistrationV1
  verifier: LoadedConnectorVerifierPort
} {
  const connectorId = ids.connectorId ?? CONNECTOR_ID
  const registrationId = ids.registrationId ?? REGISTRATION_ID
  const capabilityMaterial = {
    schema_version: 'aun-connector-delivery-capability/v1' as const,
    connector_instance_id: connectorId,
    connector_kind: 'discord',
    idempotency_mode: 'native' as const,
    receipt_mode: 'provider_ack' as const,
    dedupe_scope: 'same_author' as const,
    dedupe_window_seconds: null,
    provider_nonce_max_bytes: 25,
    provider_nonce_charset: 'ascii_base64url',
    semantic_capabilities: ['direct_attention', 'post_message', 'reply_context'] as Array<'post_message' | 'reply_context' | 'direct_attention'>,
    reconciliation_mode: 'none' as const,
    guarantee: 'effectively_once' as const,
    typed_rate_limit_retry_budget: 1,
    ambiguous_outcome_retry_budget: 0 as const,
    adapter_contract_version: 'discord/v1',
    adapter_build_digest: sha(adapterBytes),
    capability_fixture_set_digest: sha(fixtureBytes),
  }
  const capability: ConnectorDeliveryCapabilityV1 = {
    ...capabilityMaterial,
    capability_digest: connectorCapabilityDigest(capabilityMaterial),
  }
  const registrationMaterial = {
    schema_version: 'aun-loaded-connector-registration/v1' as const,
    registration_id: registrationId,
    connector_instance_id: connectorId,
    connector_kind: 'discord',
    loaded_adapter_instance_id: 'loaded-discord-1',
    adapter_contract_version: capability.adapter_contract_version,
    adapter_build_digest: capability.adapter_build_digest,
    canonical_capability_digest: capability.capability_digest,
    fixture_manifest_version: '1.0.0',
    fixture_manifest_digest: capability.capability_fixture_set_digest,
    build_test_attestation_ref: 'fixture://discord/build-test/1',
    build_test_attestation_digest: 'c'.repeat(64),
    loader_identity_digest: 'd'.repeat(64),
    registry_generation: 1,
    status: 'active' as const,
  }
  const registration: LoadedConnectorRegistrationV1 = {
    ...registrationMaterial,
    registration_digest: loadedConnectorRegistrationDigest(registrationMaterial),
  }
  const verifier: LoadedConnectorVerifierPort = {
    loader_identity_digest: registration.loader_identity_digest,
    async verifyBuildTestAttestation() {
      return {
        verified: true,
        attestation_ref: registration.build_test_attestation_ref,
        attestation_digest: registration.build_test_attestation_digest,
        subject_adapter_build_digest: capability.adapter_build_digest,
        subject_capability_digest: capability.capability_digest,
        subject_fixture_manifest_digest: capability.capability_fixture_set_digest,
        registry_generation: registration.registry_generation,
      }
    },
  }
  return { capability, registration, verifier }
}

describe('LoadedConnectorRegistrationV1 existing-schema persistence', () => {
  test('persist, identical replay, file-backed WAL restart, and authority readback', async () => {
    const { capability, registration, verifier } = registryFixture()
    const registry = new ConnectorRegistry(db, verifier)
    expect((await registry.registerLoadedConnector({ registration, capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes })).inserted).toBe(true)
    expect((await registry.registerLoadedConnector({ registration, capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes })).inserted).toBe(false)
    await db.close()
    db = new SqliteAdapter(path)
    const restarted = new ConnectorRegistry(db, verifier)
    const resolved = await restarted.resolveCapabilityAuthority({
      connector_instance_id: CONNECTOR_ID,
      loaded_registration_digest: registration.registration_digest,
      capability,
      loaded_adapter_bytes: adapterBytes,
      fixture_manifest_bytes: fixtureBytes,
    })
    expect(resolved.registration).toEqual(registration)
    expect(resolved.authority.loaded_registration_digest).toBe(registration.registration_digest)
  })

  test('same deterministic ID with changed status is collision, not false idempotency', async () => {
    const { capability, registration, verifier } = registryFixture()
    const registry = new ConnectorRegistry(db, verifier)
    await registry.registerLoadedConnector({ registration, capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes })
    const changed = { ...registration, status: 'revoked' as const }
    changed.registration_digest = loadedConnectorRegistrationDigest(changed)
    await expect(registry.registerLoadedConnector({ registration: changed, capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes }))
      .rejects.toBeInstanceOf(EventIdCanonicalMaterialCollisionError)
    expect(await new EventLog(db).count()).toBe(1)
  })

  test('restart identity mismatch is LOADED_REGISTRATION_UNPROVEN with no fallback write', async () => {
    const { capability, registration, verifier } = registryFixture()
    await db.execute(
      `INSERT INTO event_log (event_id, event_type, payload) VALUES ($1, $2, $3)`,
      ['loaded-connector-registration:' + '0'.repeat(64), 'authority.loaded_connector_registered', JSON.stringify(registration)],
    )
    const registry = new ConnectorRegistry(db, verifier)
    await expect(registry.resolveCapabilityAuthority({
      connector_instance_id: CONNECTOR_ID,
      loaded_registration_digest: registration.registration_digest,
      capability,
      loaded_adapter_bytes: adapterBytes,
      fixture_manifest_bytes: fixtureBytes,
    })).rejects.toBeInstanceOf(LoadedRegistrationUnprovenError)
    expect(await new EventLog(db).count()).toBe(1)
    expect(await new EventLog(db).getByEventId(loadedConnectorRegistrationEventId(REGISTRATION_ID, 1))).toBeNull()
  })

  test('producer and issuer registrations require installed loader/policy verification', async () => {
    const fixture = registryFixture()
    const producerBytes = new TextEncoder().encode('producer-build-v1')
    const issuerBytes = new TextEncoder().encode('issuer-build-v1')
    const policyBytes = new TextEncoder().encode('retry-budget-policy-v1')
    const producerMaterial: Omit<ZeroEffectProducerRegistrationV1, 'registration_digest'> = {
      schema_version: 'aun-zero-effect-producer-registration/v1', registration_id: '44444444-4444-4444-8444-444444444444',
      producer_instance_id: 'producer-1', producer_kind: 'invocation_guard', connector_instance_id: CONNECTOR_ID,
      capability_digest: fixture.capability.capability_digest, authorized_evidence_kinds: ['typed_pre_invocation_failure'],
      verifier_contract_version: 'verifier/v1', producer_build_digest: sha(producerBytes), build_test_attestation_digest: 'e'.repeat(64),
      registry_generation: 1, valid_from: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z', status: 'active',
    }
    const producer = { ...producerMaterial, registration_digest: producerRegistrationDigest(producerMaterial) }
    const issuerMaterial: Omit<RetryBudgetIssuerRegistrationV1, 'registration_digest'> = {
      schema_version: 'aun-retry-budget-issuer-registration/v1', registration_id: '55555555-5555-4555-8555-555555555555',
      issuer_instance_id: 'issuer-1', capability_digest: fixture.capability.capability_digest,
      budget_policy_digest: 'f'.repeat(64), policy_source_digest: sha(policyBytes), issuer_build_digest: sha(issuerBytes),
      build_test_attestation_digest: '1'.repeat(64), registry_generation: 1,
      valid_from: '2026-01-01T00:00:00Z', expires_at: '2027-01-01T00:00:00Z', status: 'active',
    }
    const issuer = { ...issuerMaterial, registration_digest: issuerRegistrationDigest(issuerMaterial) }
    const verifier: LoadedConnectorVerifierPort = {
      ...fixture.verifier,
      async verifyZeroEffectProducerRegistration() {
        return { verified: true, producer_build_digest: producer.producer_build_digest, build_test_attestation_digest: producer.build_test_attestation_digest, registry_generation: 1, verifier_contract_version: producer.verifier_contract_version }
      },
      async verifyRetryBudgetIssuerRegistration() {
        return { verified: true, issuer_build_digest: issuer.issuer_build_digest, build_test_attestation_digest: issuer.build_test_attestation_digest, policy_source_digest: issuer.policy_source_digest, registry_generation: 1 }
      },
    }
    const registry = new ConnectorRegistry(db, verifier)
    await registry.registerLoadedConnector({ registration: fixture.registration, capability: fixture.capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes })
    expect((await registry.registerZeroEffectProducer({
      connector_instance_id: CONNECTOR_ID, loaded_registration_digest: fixture.registration.registration_digest,
      capability: fixture.capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes,
      registration: producer, producer_build_bytes: producerBytes,
    })).inserted).toBe(true)
    expect((await registry.registerRetryBudgetIssuer({
      connector_instance_id: CONNECTOR_ID, loaded_registration_digest: fixture.registration.registration_digest,
      capability: fixture.capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes,
      registration: issuer, issuer_build_bytes: issuerBytes, policy_source_bytes: policyBytes,
    })).inserted).toBe(true)

    const withoutPolicyVerifier = new ConnectorRegistry(db, fixture.verifier)
    await expect(withoutPolicyVerifier.registerRetryBudgetIssuer({
      connector_instance_id: CONNECTOR_ID, loaded_registration_digest: fixture.registration.registration_digest,
      capability: fixture.capability, loaded_adapter_bytes: adapterBytes, fixture_manifest_bytes: fixtureBytes,
      registration: issuer, issuer_build_bytes: issuerBytes, policy_source_bytes: policyBytes,
    })).rejects.toBeInstanceOf(LoadedRegistrationUnprovenError)
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

describe.if(!!POSTGRES_TEST_URL)('PostgreSQL separate-process kill/restart', () => {
  test('killed transaction exposes zero rows; committed registration is reverified after process restart', async () => {
    const url = POSTGRES_TEST_URL!
    const killedEventId = `tn-pg-kill-${randomUUID()}`
    const marker = join(dir, 'pg-inserted-before-commit')
    const killWorker = `
      import { PgAdapter } from './core/db/pg-adapter.ts'
      import { EventLog } from './core/eventlog/store.ts'
      const inner = new PgAdapter(process.env.PG_TEST_URL)
      let marked = false
      const db = {
        dialect: 'postgres',
        query: (sql, params) => inner.query(sql, params),
        queryOne: (sql, params) => inner.queryOne(sql, params),
        execute: (sql, params) => inner.execute(sql, params),
        close: () => inner.close(),
        transaction: (fn) => inner.transaction(async (tx) => fn({
          dialect: 'postgres',
          query: (sql, params) => tx.query(sql, params),
          queryOne: (sql, params) => tx.queryOne(sql, params),
          execute: async (sql, params) => {
            const result = await tx.execute(sql, params)
            if (!marked && sql.includes('INSERT INTO event_log')) {
              marked = true
              await Bun.write(process.env.PG_MARKER, 'inserted-before-commit')
              await new Promise(() => {})
            }
            return result
          },
          transaction: (nested) => tx.transaction(nested),
          close: () => tx.close(),
        })),
      }
      await new EventLog(db).append({
        eventId: process.env.PG_EVENT_ID,
        eventType: 'conversation.linked',
        payload: { fixture: 'postgres-kill-before-commit' },
      })
    `
    const killed = Bun.spawn([process.execPath, '-e', killWorker], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PG_TEST_URL: url,
        PG_EVENT_ID: killedEventId,
        PG_MARKER: marker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) await Bun.sleep(10)
    expect(existsSync(marker)).toBe(true)
    killed.kill('SIGKILL')
    expect(await killed.exited).not.toBe(0)

    const { PgAdapter } = await import('../../core/db/pg-adapter')
    const readback = new PgAdapter(url)
    try {
      expect(await new EventLog(readback).getByEventId(killedEventId)).toBeNull()
    } finally {
      await readback.close()
    }

    const fixture = registryFixture({ connectorId: randomUUID(), registrationId: randomUUID() })
    const childInput = JSON.stringify({
      capability: fixture.capability,
      registration: fixture.registration,
      adapter_bytes_base64: Buffer.from(adapterBytes).toString('base64'),
      fixture_bytes_base64: Buffer.from(fixtureBytes).toString('base64'),
    })
    const registryWorker = `
      import { PgAdapter } from './core/db/pg-adapter.ts'
      import { ConnectorRegistry } from './core/eventlog/connector-registry.ts'
      const input = JSON.parse(process.env.REGISTRY_INPUT)
      const verifier = {
        loader_identity_digest: input.registration.loader_identity_digest,
        async verifyBuildTestAttestation() {
          return {
            verified: true,
            attestation_ref: input.registration.build_test_attestation_ref,
            attestation_digest: input.registration.build_test_attestation_digest,
            subject_adapter_build_digest: input.capability.adapter_build_digest,
            subject_capability_digest: input.capability.capability_digest,
            subject_fixture_manifest_digest: input.capability.capability_fixture_set_digest,
            registry_generation: input.registration.registry_generation,
          }
        },
      }
      const db = new PgAdapter(process.env.PG_TEST_URL)
      const registry = new ConnectorRegistry(db, verifier)
      const common = {
        registration: input.registration,
        capability: input.capability,
        loaded_adapter_bytes: Buffer.from(input.adapter_bytes_base64, 'base64'),
        fixture_manifest_bytes: Buffer.from(input.fixture_bytes_base64, 'base64'),
      }
      const result = process.env.REGISTRY_MODE === 'register'
        ? await registry.registerLoadedConnector(common)
        : await registry.resolveCapabilityAuthority({
            connector_instance_id: input.registration.connector_instance_id,
            loaded_registration_digest: input.registration.registration_digest,
            capability: input.capability,
            loaded_adapter_bytes: common.loaded_adapter_bytes,
            fixture_manifest_bytes: common.fixture_manifest_bytes,
          })
      console.log(JSON.stringify({
        mode: process.env.REGISTRY_MODE,
        inserted: result.inserted ?? null,
        registration_digest: (result.registration ?? input.registration).registration_digest,
      }))
      await db.close()
    `
    const runRegistryProcess = async (mode: 'register' | 'resolve') => {
      const processResult = Bun.spawn([process.execPath, '-e', registryWorker], {
        cwd: process.cwd(),
        env: { ...process.env, PG_TEST_URL: url, REGISTRY_INPUT: childInput, REGISTRY_MODE: mode },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processResult.stdout).text(),
        new Response(processResult.stderr).text(),
        processResult.exited,
      ])
      expect(exitCode, stderr).toBe(0)
      return JSON.parse(stdout.trim()) as { mode: string; inserted: boolean | null; registration_digest: string }
    }

    expect(await runRegistryProcess('register')).toEqual({
      mode: 'register',
      inserted: true,
      registration_digest: fixture.registration.registration_digest,
    })
    expect(await runRegistryProcess('resolve')).toEqual({
      mode: 'resolve',
      inserted: null,
      registration_digest: fixture.registration.registration_digest,
    })
  })
})
