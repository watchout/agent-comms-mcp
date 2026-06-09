import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter, toLegacy } from '../core/db'
import {
  reconcileDiscordDeliveryCredentialPromotion,
  type DiscordTokenIdentityVerifier,
} from '../core/discord-credential-promotion'
import { resolveEffectiveDeliveryOwner } from '../core/outbound-projection'

let tmpDir: string
let dbPath: string
let adapter: SqliteAdapter

const agentId = 'codex-cto'
const channelId = 'main'
const providerSubjectId = '123456789012345678'

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'discord-credential-promotion-'))
  dbPath = join(tmpDir, 'test.db')
  migrateSqlite(dbPath)
  adapter = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await adapter.close()
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function seedDeliveryFixture(options: {
  connectorStatus?: 'registered' | 'active'
  credentialStatus?: 'registered' | 'active'
  withWriteAccess?: boolean
}) {
  const connectorInstanceId = randomUUID()
  const credentialId = randomUUID()
  const providerIdentityId = randomUUID()
  const channelBindingId = randomUUID()
  const providerChannelAccessId = randomUUID()
  const db = new Database(dbPath)
  try {
    db.prepare(`
      INSERT INTO agents (
        agent_id,
        display_name,
        agent_type,
        status,
        provider_token_source_ref,
        expected_provider_identity
      ) VALUES (?, ?, 'dev', 'idle', 'local-env:TEST_DISCORD_TOKEN', ?)
    `).run(agentId, agentId, JSON.stringify({ provider: 'discord', subject_id: providerSubjectId }))
    db.prepare(`INSERT INTO channels (id, name, members) VALUES (?, ?, ?)`)
      .run(channelId, channelId, JSON.stringify([agentId]))
    db.prepare(`INSERT INTO channel_adapters (channel_id, platform, external_id) VALUES (?, 'discord', ?)`)
      .run(channelId, 'discord-main')
    db.prepare(`
      INSERT INTO connector_instances (
        connector_instance_id,
        agent_id,
        provider,
        connector_kind,
        transport,
        connector_uri,
        status,
        trust_status
      ) VALUES (?, ?, 'discord', 'chat_adapter', 'discord_gateway', ?, ?, 'local')
    `).run(
      connectorInstanceId,
      agentId,
      `discord://agents/${agentId}`,
      options.connectorStatus ?? 'registered',
    )
    db.prepare(`
      INSERT INTO connector_credentials (
        credential_id,
        provider,
        agent_id,
        connector_instance_id,
        credential_kind,
        secret_ref,
        status,
        trust_status,
        source
      ) VALUES (?, 'discord', ?, ?, 'bot_token', 'local-env:TEST_DISCORD_TOKEN', ?, 'local', 'test')
    `).run(credentialId, agentId, connectorInstanceId, options.credentialStatus ?? 'registered')
    db.prepare(`
      INSERT INTO agent_provider_identities (
        provider_identity_id,
        agent_id,
        provider,
        provider_subject_id,
        status,
        trust_status,
        source
      ) VALUES (?, ?, 'discord', ?, 'expected', 'unverified', 'test')
    `).run(providerIdentityId, agentId, providerSubjectId)
    if (options.withWriteAccess) {
      db.prepare(`
        INSERT INTO channel_connector_bindings (
          channel_binding_id,
          channel_id,
          provider,
          connector_instance_id,
          binding_role,
          priority,
          status
        ) VALUES (?, ?, 'discord', ?, 'outbound', 10, 'active')
      `).run(channelBindingId, channelId, connectorInstanceId)
      db.prepare(`
        INSERT INTO provider_channel_access (
          provider_channel_access_id,
          provider,
          provider_channel_id,
          connector_instance_id,
          agent_id,
          capabilities,
          status,
          trust_status,
          source
        ) VALUES (?, 'discord', 'discord-main', ?, ?, ?, 'active', 'local', 'test')
      `).run(
        providerChannelAccessId,
        connectorInstanceId,
        agentId,
        JSON.stringify({ message_create: true }),
      )
    }
  } finally {
    db.close()
  }
  return {
    connectorInstanceId,
    credentialId,
    providerIdentityId,
    channelBindingId,
    providerChannelAccessId,
  }
}

async function statusRows() {
  const rows = await adapter.query<any>(`
    SELECT ci.status AS connector_status,
           ci.trust_status AS connector_trust_status,
           cc.status AS credential_status,
           cc.trust_status AS credential_trust_status,
           cc.last_verified_at
      FROM connector_instances ci
      JOIN connector_credentials cc
        ON cc.connector_instance_id = ci.connector_instance_id
     WHERE ci.agent_id = $1
  `, [agentId])
  return rows[0]
}

describe('Discord delivery credential promotion', () => {
  test('does not promote registered credentials without channel write evidence', async () => {
    seedDeliveryFixture({ withWriteAccess: false })
    let verifierCalled = false
    const verifier: DiscordTokenIdentityVerifier = async () => {
      verifierCalled = true
      return { ok: true, providerSubjectId }
    }

    const result = await reconcileDiscordDeliveryCredentialPromotion(toLegacy(adapter), {
      agentId,
      actor: 'test-reconcile',
      env: { TEST_DISCORD_TOKEN: 'secret-token' },
      verifyTokenIdentity: verifier,
    })

    expect(result.promoted).toBe(false)
    expect(result.reason).toBe('provider_write_access_missing')
    expect(verifierCalled).toBe(false)
    expect(await statusRows()).toMatchObject({
      connector_status: 'registered',
      credential_status: 'registered',
    })
    const audits = await adapter.query<any>(
      `SELECT * FROM audit_log WHERE event_type = 'connector_credential.delivery_promotion'`,
    )
    expect(audits).toHaveLength(0)
  })

  test('promotes only when token identity and write capability evidence both match', async () => {
    const fixture = seedDeliveryFixture({ withWriteAccess: true })
    const mismatch = await reconcileDiscordDeliveryCredentialPromotion(toLegacy(adapter), {
      agentId,
      actor: 'test-reconcile',
      env: { TEST_DISCORD_TOKEN: 'secret-token' },
      verifyTokenIdentity: async () => ({
        ok: false,
        providerSubjectId: '000000000000000000',
        evidence: { provider_api: 'test.discord.users.@me', identity_resolved: true },
      }),
    })
    expect(mismatch).toMatchObject({
      ok: false,
      promoted: false,
      reason: 'token_identity_mismatch',
      expectedProviderSubjectId: providerSubjectId,
      observedProviderSubjectId: '000000000000000000',
    })
    expect(await statusRows()).toMatchObject({
      connector_status: 'registered',
      credential_status: 'registered',
    })
    expect(await adapter.query<any>(
      `SELECT * FROM audit_log WHERE event_type = 'connector_credential.delivery_promotion'`,
    )).toHaveLength(0)

    const verifier: DiscordTokenIdentityVerifier = async (input) => {
      expect(input.expectedProviderSubjectId).toBe(providerSubjectId)
      expect(input.token).toBe('secret-token')
      return {
        ok: true,
        providerSubjectId,
        evidence: { provider_api: 'test.discord.users.@me', identity_resolved: true },
      }
    }

    const result = await reconcileDiscordDeliveryCredentialPromotion(toLegacy(adapter), {
      agentId,
      actor: 'test-reconcile',
      env: { TEST_DISCORD_TOKEN: 'secret-token' },
      verifyTokenIdentity: verifier,
      now: () => new Date('2026-06-10T00:00:00.000Z'),
    })

    expect(result).toMatchObject({
      ok: true,
      promoted: true,
      reason: 'promoted',
      connectorInstanceId: fixture.connectorInstanceId,
      credentialId: fixture.credentialId,
      channelBindingId: fixture.channelBindingId,
      providerChannelAccessId: fixture.providerChannelAccessId,
      expectedProviderSubjectId: providerSubjectId,
      observedProviderSubjectId: providerSubjectId,
    })
    expect(await statusRows()).toMatchObject({
      connector_status: 'active',
      connector_trust_status: 'verified',
      credential_status: 'active',
      credential_trust_status: 'verified',
    })

    const audits = await adapter.query<any>(
      `SELECT event_type, agent_id, target, detail FROM audit_log WHERE event_type = 'connector_credential.delivery_promotion'`,
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      event_type: 'connector_credential.delivery_promotion',
      agent_id: 'test-reconcile',
      target: agentId,
    })
    const detail = JSON.parse(audits[0].detail)
    expect(detail).toMatchObject({
      actor: 'test-reconcile',
      promoted_at: '2026-06-10T00:00:00.000Z',
      target_agent_id: agentId,
      evidence: {
        token_identity: {
          expected_provider_subject_id: providerSubjectId,
          observed_provider_subject_id: providerSubjectId,
          token_source: 'local-env:TEST_DISCORD_TOKEN',
        },
        channel_write_capability: {
          channel_binding_id: fixture.channelBindingId,
          provider_channel_access_id: fixture.providerChannelAccessId,
          capability_keys: ['message_create'],
        },
      },
    })
    expect(JSON.stringify(detail)).not.toContain('secret-token')
  })

  test('promotion path recovers delivery eligibility after registered downgrade', async () => {
    const fixture = seedDeliveryFixture({ withWriteAccess: true })
    const db = toLegacy(adapter)
    const before = await resolveEffectiveDeliveryOwner(db, {
      channelId,
      senderAgentId: agentId,
    })
    expect(before.ok).toBe(false)

    await reconcileDiscordDeliveryCredentialPromotion(db, {
      agentId,
      actor: 'test-reconcile',
      env: { TEST_DISCORD_TOKEN: 'secret-token' },
      verifyTokenIdentity: async () => ({
        ok: true,
        providerSubjectId,
        evidence: { provider_api: 'test.discord.users.@me' },
      }),
    })

    const after = await resolveEffectiveDeliveryOwner(db, {
      channelId,
      senderAgentId: agentId,
    })
    expect(after).toMatchObject({
      ok: true,
      source: 'sender_direct',
      consumerAgentId: agentId,
      connectorInstanceId: fixture.connectorInstanceId,
      credentialId: fixture.credentialId,
      credentialStatus: 'active',
      channelBindingId: fixture.channelBindingId,
      providerChannelAccessId: fixture.providerChannelAccessId,
    })
  })
})
