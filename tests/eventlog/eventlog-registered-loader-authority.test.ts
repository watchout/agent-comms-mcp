import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REGISTERED_DISCORD_CAPABILITY,
  REGISTERED_LOADED_CONNECTOR,
  REGISTERED_RETRY_BUDGET_ISSUER,
  REGISTERED_ZERO_EFFECT_PRODUCER,
} from '../../adapters/eventlog/registered-connector-catalog'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  EventLog,
  attestationDigest,
  attestationEvent,
  authorityAdmissionReceiptEventId,
  buildAuthorityAdmissionReceipt,
  canonicalJson,
  decodeAuthorityAdmissionReceipt,
  evidenceEvent,
  ensureEventLogSchema,
  loadedConnectorRegistrationEventId,
  reconciliationObservationDigest,
  reconciliationObservationEventId,
  reconciliationRequestDigest,
  retryBudgetSnapshotEvent,
  sha256Utf8,
  storedEventConflictMaterial,
  zeroEffectEvidenceDigest,
  type AuthorityAdmissionMaterialV2,
  type DeliveryUnknownReconciliationRequestV1,
  type ReplyDeliveryUnknownPayloadV1,
  type RetryBudgetSnapshotV1,
  type ZeroExternalEffectAttestationV1,
  type ZeroExternalEffectEvidenceRecordV1,
} from '../../core/eventlog'

let dir: string
let path: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'registered-loader-'))
  path = join(dir, 'eventlog.db')
  db = new SqliteAdapter(path)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

async function runPrivateRoot(calls: number, lifecycle = true) {
  await db.close()
  const child = Bun.spawn([process.execPath, '-e', `
    import * as loader from './core/eventlog/registered-loader.ts'
    let lifecycle = null
    try { lifecycle = ${lifecycle ? 'await loader.runProductionRegisteredLoaderLifecycle()' : 'null'} }
    catch (error) { lifecycle = { error_name: error.constructor.name, error_code: error.code ?? null } }
    const results = []
    for (let index = 0; index < ${calls}; index += 1) {
      try { results.push(await loader.processNextRegisteredReopen()) }
      catch (error) { results.push({ error_name: error.constructor.name, error_code: error.code ?? null }) }
    }
    const connectorRegistry = await import('./core/eventlog/connector-registry.ts')
    const store = await import('./core/eventlog/store.ts')
    console.log(JSON.stringify({
      lifecycle,
      results,
      loader_exports: Object.keys(loader).sort(),
      connector_registry_exports: Object.keys(connectorRegistry).sort(),
      public_cas_type: typeof store.EventLog.prototype.commitReopenAuthorizationCAS,
    }))
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: path,
      DATABASE_URL: '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  db = new SqliteAdapter(path)
  return JSON.parse(stdout.trim()) as {
    lifecycle: null | Record<string, unknown>
    results: Array<Record<string, unknown>>
    loader_exports: string[]
    connector_registry_exports: string[]
    public_cas_type: string
  }
}

async function appendMalformedRequests(count: number, prefix = 'malformed') {
  const log = new EventLog(db)
  for (let index = 0; index < count; index += 1) {
    await log.append({
      eventId: `delivery-reconciliation-requested:${prefix}:${index.toString().padStart(4, '0')}`,
      eventType: 'reply.delivery_reconciliation_requested',
      payload: { schema_version: 'aun-delivery-unknown-reconciliation-request/v1', unexpected: index },
    })
  }
}

async function appendValidReopenSource(suffix: string, target: DbAdapter = db) {
  const log = new EventLog(target)
  const capability = REGISTERED_DISCORD_CAPABILITY
  const producer = REGISTERED_ZERO_EFFECT_PRODUCER
  const issuer = REGISTERED_RETRY_BUDGET_ISSUER
  const unknown: ReplyDeliveryUnknownPayloadV1 = {
    reply_id: `reply-${suffix}`,
    delivery_id: `delivery-${suffix}`,
    recipient_seat_id: 'spec',
    attempt_ordinal: 0,
    connector_instance_id: capability.connector_instance_id,
    resolved_binding_snapshot_digest: '2'.repeat(64),
    resolved_delivery_decision_digest: '3'.repeat(64),
    delivery_digest: '4'.repeat(64),
    provider_request_digest: '5'.repeat(64),
    business_nonce: `business-${suffix}`,
    provider_nonce: `provider-${suffix}`,
    capability_digest: capability.capability_digest,
    invocation_started_event_id: `provider-invocation-started:${suffix}`,
    reconciliation_mode: 'provider_lookup',
    fanout_child_provenance_digest: null,
  }
  const unknownEvent = await log.append({
    eventId: `delivery-unknown:${suffix}`,
    eventType: 'reply.delivery_unknown',
    conversationId: `conversation-${suffix}`,
    correlationId: `correlation-${suffix}`,
    turnId: `turn-${suffix}`,
    replyId: unknown.reply_id,
    claimEpoch: 0,
    payload: unknown as unknown as Record<string, unknown>,
  })
  const requestMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-request/v1' as const,
    reconciliation_id: `reconciliation-${suffix}`,
    delivery_unknown_event_id: unknownEvent.event.event_id,
    delivery_unknown_event_digest: sha256Utf8(canonicalJson(storedEventConflictMaterial(unknownEvent.event))),
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    recipient_seat_id: unknown.recipient_seat_id,
    attempt_ordinal: unknown.attempt_ordinal,
    connector_instance_id: unknown.connector_instance_id,
    resolved_binding_snapshot_digest: unknown.resolved_binding_snapshot_digest,
    resolved_delivery_decision_digest: unknown.resolved_delivery_decision_digest,
    delivery_digest: unknown.delivery_digest,
    provider_request_digest: unknown.provider_request_digest,
    business_nonce: unknown.business_nonce,
    provider_nonce: unknown.provider_nonce,
    capability_digest: unknown.capability_digest,
    reconciliation_mode: unknown.reconciliation_mode,
    reconciler_registration_digest: '7'.repeat(64),
  }
  const request: DeliveryUnknownReconciliationRequestV1 = {
    ...requestMaterial,
    request_digest: reconciliationRequestDigest(requestMaterial),
  }
  const requestEventId = `delivery-reconciliation-requested:${suffix}`
  await log.append({
    eventId: requestEventId,
    eventType: 'reply.delivery_reconciliation_requested',
    replyId: unknown.reply_id,
    claimEpoch: 0,
    payload: request as unknown as Record<string, unknown>,
  })
  const evidenceBody = {
    delivery_id: unknown.delivery_id,
    attempt_ordinal: 0,
    provider_request_digest: unknown.provider_request_digest,
    provider_nonce: unknown.provider_nonce,
    provider_response_digest: '8'.repeat(64),
    provider_rejection_code: `rejected-before-effect-${suffix}`,
    provider_contract_digest: '9'.repeat(64),
    provider_contract_effect: 'rejected_before_effect' as const,
  }
  const evidence: ZeroExternalEffectEvidenceRecordV1 = {
    schema_version: 'aun-zero-external-effect-evidence/v1',
    evidence_kind: 'provider_rejected_before_effect',
    evidence_body: evidenceBody,
    evidence_digest: zeroEffectEvidenceDigest('provider_rejected_before_effect', evidenceBody),
  }
  await log.append(evidenceEvent(evidence))
  const attestationMaterial = {
    attestation_id: `attestation-${suffix}`,
    delivery_id: unknown.delivery_id,
    attempt_ordinal: 0,
    connector_instance_id: unknown.connector_instance_id,
    provider_request_digest: unknown.provider_request_digest,
    provider_nonce: unknown.provider_nonce,
    evidence_kind: evidence.evidence_kind,
    evidence_digest: evidence.evidence_digest,
    producer_registration_digest: producer.registration_digest,
    issued_at: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
  }
  const attestation: ZeroExternalEffectAttestationV1 = {
    ...attestationMaterial,
    attestation_digest: attestationDigest(attestationMaterial),
  }
  await log.append(attestationEvent(attestation))
  const observationMaterial = {
    schema_version: 'aun-delivery-unknown-reconciliation-observation/v1' as const,
    reconciliation_request_digest: request.request_digest,
    observed_outcome: 'proven_zero_external_effect' as const,
    validated_receipt_digest: null,
    permanent_failure_code: null,
    zero_external_effect_attestation_digest: attestation.attestation_digest,
    evidence_digest: evidence.evidence_digest,
  }
  const observation = {
    ...observationMaterial,
    observation_digest: reconciliationObservationDigest(observationMaterial),
  }
  await log.append({
    eventId: reconciliationObservationEventId(unknownEvent.event.event_id, observation.observation_digest),
    eventType: 'reply.delivery_reconciliation_observed',
    replyId: unknown.reply_id,
    claimEpoch: 0,
    payload: observation,
  })
  const budget: RetryBudgetSnapshotV1 = {
    schema_version: 'aun-retry-budget-snapshot/v1',
    reply_id: unknown.reply_id,
    delivery_id: unknown.delivery_id,
    capability_digest: unknown.capability_digest,
    budget_policy_digest: issuer.budget_policy_digest,
    authority_registration_digest: issuer.registration_digest,
    generation: 1,
    remaining: 1,
    prior_snapshot_event_id: null,
    transition_authority_digest: null,
  }
  await log.append(retryBudgetSnapshotEvent(budget))
  return requestEventId
}

const vectorCommon = {
  connector_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  registry_generation: 1,
  capability_digest: 'c'.repeat(64),
  loader_catalog_digest: 'd'.repeat(64),
  loader_identity_digest: 'e'.repeat(64),
  verifier_contract_version: 'registered-loader/v1',
}

describe('TN-017C registered-loader authority boundary', () => {
  test('three canonical AuthorityAdmissionMaterialV2 receipt vectors reproduce exactly', () => {
    const vectors: Array<{
      material: AuthorityAdmissionMaterialV2
      id: string
      digest: string
      eventId: string
      admissionBytes: number
      digestBytes: number
      eventIdBytes: number
    }> = [
      {
        material: {
          ...vectorCommon,
          registration_id: '11111111-1111-4111-8111-111111111111',
          subject_event_id: 'loaded-connector-registration:1e6b04aeae60053b2b470fa64a74c822adb24539ba1fc7029f056b73f0816278',
          subject_event_type: 'authority.loaded_connector_registered',
          subject_conflict_material_digest: '1'.repeat(64),
          subject_payload_digest: '4'.repeat(64),
          verification_kind: 'loaded_build_and_fixture',
          build_test_attestation_digest: 'a'.repeat(64),
          policy_source_digest: null,
        },
        id: '2d0e98eba0c5ec3a90332ebb6d7f88fab8bbd58be19473f7f5778bdeca26363e',
        digest: 'a109805ea79ad281bc8981c9f93f8817c3742cb283bc765df7b4ba6d0d2ee728',
        eventId: 'authority-admission:335ce123d0f3ec6e585becea3bd8c42de48e0aab45fe1dd6f9ce09526dcc8705',
        admissionBytes: 1041,
        digestBytes: 1191,
        eventIdBytes: 414,
      },
      {
        material: {
          ...vectorCommon,
          registration_id: '22222222-2222-4222-8222-222222222222',
          subject_event_id: 'zero-effect-producer-registration:bcf87564e318a0ea2d4c3812c8e868e77e8facd6eeeba9d2008aee910070d5f1',
          subject_event_type: 'authority.zero_effect_producer_registered',
          subject_conflict_material_digest: '2'.repeat(64),
          subject_payload_digest: '5'.repeat(64),
          verification_kind: 'zero_effect_producer',
          build_test_attestation_digest: 'b'.repeat(64),
          policy_source_digest: null,
        },
        id: 'af22eef3983bec8a805b997c59b67a93714cf548ea8ae63c50d96ad240569dd1',
        digest: 'd564638dc2c443cbb2e3bccfd4b93cb67d5d80fa2177cd2d9212aacdcf94a56d',
        eventId: 'authority-admission:6ba7e250da4ca25a7502c3c842fa31ed23e3e646740df3b1c3699e17ce59f4c7',
        admissionBytes: 1045,
        digestBytes: 1195,
        eventIdBytes: 422,
      },
      {
        material: {
          ...vectorCommon,
          registration_id: '33333333-3333-4333-8333-333333333333',
          subject_event_id: 'retry-budget-issuer-registration:0467a083f6d86aa8f6e72e8d2dd5ac5a348b20476fb9732126ef48f3b026b602',
          subject_event_type: 'authority.retry_budget_issuer_registered',
          subject_conflict_material_digest: '3'.repeat(64),
          subject_payload_digest: '6'.repeat(64),
          verification_kind: 'retry_budget_issuer_and_policy',
          build_test_attestation_digest: 'c'.repeat(64),
          policy_source_digest: 'f'.repeat(64),
        },
        id: 'b0c2e1cd0ef4760691d456c68ba9ccf67e011c2a37528165f0f7440ecc5dadf6',
        digest: '37005c2b73c6fc08487ae4c61043c2cb74e858b4a67f368953a32cbf616125a8',
        eventId: 'authority-admission:72ccfd53bd2c68183dbf94829e1dab86906e1c6da06b76c0d52b24c6be588f7d',
        admissionBytes: 1115,
        digestBytes: 1265,
        eventIdBytes: 420,
      },
    ]
    for (const vector of vectors) {
      const receipt = buildAuthorityAdmissionReceipt(vector.material)
      expect(receipt.admission_id).toBe(vector.id)
      expect(receipt.admission_digest).toBe(vector.digest)
      expect(authorityAdmissionReceiptEventId(receipt)).toBe(vector.eventId)
      const { admission_digest: _, ...withoutDigest } = receipt
      const eventKey = {
        admission_id: receipt.admission_id,
        subject_event_id: receipt.subject_event_id,
        subject_event_type: receipt.subject_event_type,
        registry_generation: receipt.registry_generation,
        admission_digest: receipt.admission_digest,
      }
      expect(Buffer.byteLength('aun-authority-admission-id/v1\n' + canonicalJson(vector.material))).toBe(vector.admissionBytes)
      expect(Buffer.byteLength('aun-authority-admission-receipt-material/v1\n' + canonicalJson(withoutDigest))).toBe(vector.digestBytes)
      expect(Buffer.byteLength('aun-authority-admission-receipt-event-id/v1\n' + canonicalJson(eventKey))).toBe(vector.eventIdBytes)
      expect(sha256Utf8('aun-authority-admission-id/v1\n\n' + canonicalJson(vector.material))).not.toBe(vector.id)
    }
  })

  test('receipt decoding rejects extras, unsafe numbers, and recomputed-looking mutations', () => {
    const material: AuthorityAdmissionMaterialV2 = {
      ...vectorCommon,
      registration_id: '11111111-1111-4111-8111-111111111111',
      subject_event_id: 'loaded-connector-registration:1e6b04aeae60053b2b470fa64a74c822adb24539ba1fc7029f056b73f0816278',
      subject_event_type: 'authority.loaded_connector_registered',
      subject_conflict_material_digest: '1'.repeat(64),
      subject_payload_digest: '4'.repeat(64),
      verification_kind: 'loaded_build_and_fixture',
      build_test_attestation_digest: 'a'.repeat(64),
      policy_source_digest: null,
    }
    const receipt = buildAuthorityAdmissionReceipt(material)
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, extra: true })).toThrow()
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, registry_generation: Number.MAX_SAFE_INTEGER + 1 })).toThrow()
    expect(() => decodeAuthorityAdmissionReceipt({ ...receipt, admission_id: '0'.repeat(64) })).toThrow()
  })

  test('private production root owns the only authority path and rebind is write-free', async () => {
    const first = await runPrivateRoot(0)
    expect(first.lifecycle).toMatchObject({
      status: 'registered', subjects_inserted: 3, receipts_inserted: 3,
      fresh_handle_count: 1, installed_byte_verifications: 6, provider_invocations: 0,
    })
    expect(first.loader_exports).toEqual(['processNextRegisteredReopen', 'runProductionRegisteredLoaderLifecycle'])
    expect(first.connector_registry_exports).not.toContain('ConnectorRegistry')
    expect(first.public_cas_type).toBe('undefined')
    const second = await runPrivateRoot(0)
    expect(second.lifecycle).toMatchObject({ status: 'rebound', subjects_inserted: 0, receipts_inserted: 0 })
    const counts = await db.queryOne<{ subjects: number; receipts: number }>(`
      SELECT
        SUM(CASE WHEN event_type IN (
          'authority.loaded_connector_registered',
          'authority.zero_effect_producer_registered',
          'authority.retry_budget_issuer_registered'
        ) THEN 1 ELSE 0 END) AS subjects,
        SUM(CASE WHEN event_type = 'authority.connector_registry_admission_recorded' THEN 1 ELSE 0 END) AS receipts
      FROM event_log
    `)
    expect(Number(counts?.subjects)).toBe(3)
    expect(Number(counts?.receipts)).toBe(3)
  })

  test('direct call before private rebind is fail-closed with zero product writes', async () => {
    await appendValidReopenSource('not-ready')
    const output = await runPrivateRoot(1, false)
    expect(output.results[0]).toEqual({
      error_name: 'RegisteredLoaderNotReadyError',
      error_code: 'REGISTERED_LOADER_NOT_READY',
    })
    const product = await db.queryOne<{ n: number }>(`
      SELECT COUNT(*) AS n FROM event_log WHERE event_type IN (
        'reply.delivery_reconciliation_resolved',
        'reply.zero_external_effect_attestation_consumed',
        'reply.delivery_reopened'
      )
    `)
    expect(Number(product?.n ?? 0)).toBe(0)
  })

  test('a directly seeded partial subject/receipt pair is quarantined without auto-repair', async () => {
    const registration = REGISTERED_LOADED_CONNECTOR
    await db.execute(
      `INSERT INTO event_log (event_id, event_type, payload) VALUES ($1, $2, $3)`,
      [
        loadedConnectorRegistrationEventId(registration.registration_id, registration.registry_generation),
        'authority.loaded_connector_registered',
        JSON.stringify(registration),
      ],
    )
    const output = await runPrivateRoot(0)
    expect(output.lifecycle).toEqual({
      error_name: 'AuthorityAdmissionError',
      error_code: 'AUTHORITY_ADMISSION_INCOMPLETE',
    })
    const counts = await db.queryOne<{ all_rows: number; receipts: number }>(`
      SELECT COUNT(*) AS all_rows,
        SUM(CASE WHEN event_type = 'authority.connector_registry_admission_recorded' THEN 1 ELSE 0 END) AS receipts
      FROM event_log
    `)
    expect(Number(counts?.all_rows)).toBe(1)
    expect(Number(counts?.receipts ?? 0)).toBe(0)
  })

  test('lower malformed requests cannot starve a later valid private reopen', async () => {
    await appendMalformedRequests(5, 'lower')
    const requestEventId = await appendValidReopenSource('later-valid')
    const output = await runPrivateRoot(1)
    expect(output.results[0]).toMatchObject({
      status: 'reopened',
      selected_request_event_id: requestEventId,
      provider_invocations: 0,
    })
    expect(output.results[0]!.product_event_ids).toHaveLength(4)
    const cursor = await db.queryOne<{ payload: string }>(
      `SELECT payload FROM event_log WHERE event_type = 'authority.reopen_scan_cursor_advanced'`,
    )
    const cursorPayload = JSON.parse(cursor!.payload)
    expect(cursorPayload.scanned_dispositions).toHaveLength(6)
    expect(cursorPayload.scanned_dispositions.slice(0, 5).every(
      (item: { classification_code: string }) => item.classification_code === 'MALFORMED_IMMUTABLE',
    )).toBe(true)
    expect(cursorPayload.scanned_dispositions[5].classification_code).toBe('ELIGIBLE')
  })

  test('130 invalid requests before valid are bounded to three successful invocations', async () => {
    await appendMalformedRequests(130, 'multipage')
    const requestEventId = await appendValidReopenSource('multipage-valid')
    const output = await runPrivateRoot(3)
    expect(output.results.map(result => result.status)).toEqual([
      'scan_advanced_no_eligible',
      'scan_advanced_no_eligible',
      'reopened',
    ])
    expect(output.results[2]!.selected_request_event_id).toBe(requestEventId)
    const cursors = await db.query<{ payload: string }>(
      `SELECT payload FROM event_log WHERE event_type = 'authority.reopen_scan_cursor_advanced' ORDER BY seq ASC`,
    )
    expect(cursors.map(row => JSON.parse(row.payload).scanned_dispositions.length)).toEqual([64, 64, 3])
  })

  test('restart resumes after the durable page end instead of rescanning the first invalid row', async () => {
    await appendMalformedRequests(130, 'restart')
    const requestEventId = await appendValidReopenSource('restart-valid')
    const beforeRestart = await runPrivateRoot(1)
    expect(beforeRestart.results[0]!.status).toBe('scan_advanced_no_eligible')
    const afterRestart = await runPrivateRoot(2)
    expect(afterRestart.lifecycle).toMatchObject({ status: 'rebound', subjects_inserted: 0, receipts_inserted: 0 })
    expect(afterRestart.results.map(result => result.status)).toEqual(['scan_advanced_no_eligible', 'reopened'])
    expect(afterRestart.results[1]!.selected_request_event_id).toBe(requestEventId)
    const cursors = await db.query<{ payload: string }>(
      `SELECT payload FROM event_log WHERE event_type = 'authority.reopen_scan_cursor_advanced' ORDER BY seq ASC`,
    )
    expect(cursors.map(row => JSON.parse(row.payload).scanned_dispositions.length)).toEqual([64, 64, 3])
  })

  test('restart after four-member commit and before cursor replays all four byte-identically', async () => {
    const requestEventId = await appendValidReopenSource('four-before-cursor')
    const committed = await runPrivateRoot(1)
    expect(committed.results[0]!.status).toBe('reopened')
    const durableRows = await db.query<{
      event_id: string
      event_type: string
      seat_id: string | null
      seat_instance_id: string | null
      conversation_id: string | null
      causation_id: string | null
      correlation_id: string | null
      turn_id: string | null
      reply_id: string | null
      claim_epoch: number | null
      payload: string
    }>(`
      SELECT * FROM event_log
      WHERE event_type <> 'authority.reopen_scan_cursor_advanced'
      ORDER BY seq ASC
    `)
    await db.close()
    path = join(dir, 'replayed-without-cursor.db')
    db = new SqliteAdapter(path)
    await ensureEventLogSchema(db)
    for (const row of durableRows) {
      await db.execute(`
        INSERT INTO event_log (
          event_id, event_type, seat_id, seat_instance_id, conversation_id,
          causation_id, correlation_id, turn_id, reply_id, claim_epoch, payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        row.event_id, row.event_type, row.seat_id, row.seat_instance_id,
        row.conversation_id, row.causation_id, row.correlation_id, row.turn_id,
        row.reply_id, row.claim_epoch, row.payload,
      ])
    }
    const replayed = await runPrivateRoot(1)
    expect(replayed.lifecycle).toMatchObject({ status: 'rebound', subjects_inserted: 0, receipts_inserted: 0 })
    expect(replayed.results[0]).toMatchObject({
      status: 'byte_identical_existing',
      selected_request_event_id: requestEventId,
      provider_invocations: 0,
    })
    expect(replayed.results[0]!.product_event_ids).toHaveLength(4)
    const groupCount = await db.queryOne<{ n: number }>(`
      SELECT COUNT(*) AS n FROM event_log WHERE event_type IN (
        'reply.delivery_reconciliation_resolved',
        'reply.zero_external_effect_attestation_consumed',
        'reply.delivery_reopened'
      ) OR (event_type = 'reply.retry_budget_snapshot' AND json_extract(payload, '$.generation') = 2)
    `)
    expect(Number(groupCount?.n ?? 0)).toBe(4)
  })

  test('two callers converge on one four-member group and one linear cursor chain', async () => {
    await appendValidReopenSource('concurrent')
    await runPrivateRoot(0)
    await db.close()
    const spawnCaller = () => Bun.spawn([process.execPath, '-e', `
      import { runProductionRegisteredLoaderLifecycle, processNextRegisteredReopen } from './core/eventlog/registered-loader.ts'
      await runProductionRegisteredLoaderLifecycle()
      console.log(JSON.stringify(await processNextRegisteredReopen()))
    `], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: path, DATABASE_URL: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const callers = [spawnCaller(), spawnCaller()]
    const outputs = await Promise.all(callers.map(async child => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode, stderr).toBe(0)
      return JSON.parse(stdout.trim()) as Record<string, unknown>
    }))
    db = new SqliteAdapter(path)
    expect(outputs.filter(output => output.status === 'reopened' || output.status === 'byte_identical_existing')).toHaveLength(1)
    const product = await db.queryOne<{ n: number }>(`
      SELECT COUNT(*) AS n FROM event_log WHERE event_type IN (
        'reply.delivery_reconciliation_resolved',
        'reply.zero_external_effect_attestation_consumed',
        'reply.retry_budget_snapshot',
        'reply.delivery_reopened'
      ) AND (event_type <> 'reply.retry_budget_snapshot' OR json_extract(payload, '$.generation') = 2)
    `)
    expect(Number(product?.n ?? 0)).toBe(4)
    const cursorRows = await db.query<{ event_id: string; payload: string }>(
      `SELECT event_id, payload FROM event_log WHERE event_type = 'authority.reopen_scan_cursor_advanced' ORDER BY seq ASC`,
    )
    expect(cursorRows.length).toBeGreaterThanOrEqual(1)
    let predecessor = 'GENESIS'
    for (const row of cursorRows) {
      const payload = JSON.parse(row.payload)
      expect(payload.predecessor_cursor_event_id).toBe(predecessor)
      predecessor = row.event_id
    }
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

describe.if(!!POSTGRES_TEST_URL)('registered-loader PostgreSQL boundary', () => {
  test('private no-arg root rebinds and commits/replays one exact four-member group', async () => {
    const { PgAdapter } = await import('../../core/db/pg-adapter')
    const url = POSTGRES_TEST_URL!
    const pg = new PgAdapter(url)
    const suffix = `pg-${randomUUID()}`
    try {
      await appendValidReopenSource(suffix, pg)
    } finally {
      await pg.close()
    }
    const child = Bun.spawn([process.execPath, '-e', `
      import { runProductionRegisteredLoaderLifecycle, processNextRegisteredReopen } from './core/eventlog/registered-loader.ts'
      const lifecycle = await runProductionRegisteredLoaderLifecycle()
      const inserted = await processNextRegisteredReopen()
      console.log(JSON.stringify({ lifecycle, inserted }))
    `], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_COM_DB: 'postgres',
        DATABASE_URL: url,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const output = JSON.parse(stdout.trim())
    expect(output.lifecycle).toMatchObject({ fresh_handle_count: 1, provider_invocations: 0 })
    expect(output.inserted).toMatchObject({
      status: 'reopened',
      selected_request_event_id: `delivery-reconciliation-requested:${suffix}`,
      provider_invocations: 0,
    })
    expect(output.inserted.product_event_ids).toHaveLength(4)
  })
})
