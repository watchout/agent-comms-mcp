import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildOwnerHandoffDiagnostic,
  recordOwnerHandoffDiagnostic,
} from '../core/owner-handoff-routing'

async function withOwnerHandoffDb<T>(fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-owner-handoff-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES
        ('codex-cto', 'codex-cto', 'lead', 'idle'),
        ('dev-001', 'dev-001', 'dev', 'idle')
    `)
    seed.exec(`INSERT INTO channels (id, name, members) VALUES ('ops-ch', 'ops-ch', '["codex-cto","dev-001"]')`)
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function seedOwnerQueue(db: SqliteAdapter): Promise<number> {
  const messageId = randomUUID()
  await db.execute(
    `INSERT INTO agent_messages (id, channel_id, author_id, content)
     VALUES ($1, 'ops-ch', 'codex-cto', 'handoff payload')`,
    [messageId],
  )
  const rows = await db.query<{ id: number }>(
    `INSERT INTO message_queue (agent_id, message_id, payload, status)
     VALUES ('dev-001', $1, $2, 'pending')
     RETURNING id`,
    [messageId, JSON.stringify({ channel_id: 'ops-ch', content: 'handoff payload' })],
  )
  return Number(rows[0].id)
}

describe('owner handoff routing diagnostics', () => {
  test('accepts actual owner message_queue evidence', async () => {
    await withOwnerHandoffDb(async (db) => {
      await db.execute(
        `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
         VALUES ('ops-ch', $1, 'test-allow')`,
        [JSON.stringify(['codex-cto', 'dev-001'])],
      )
      const queueId = await seedOwnerQueue(db)

      const diagnostic = await buildOwnerHandoffDiagnostic(db, {
        senderAgentId: 'codex-cto',
        intendedRecipientAgentId: 'dev-001',
        queueId,
        githubHandoffUrl: 'https://github.com/watchout/agent-comms-mcp/issues/592#issuecomment-owner',
      })

      expect(diagnostic.ok).toBe(true)
      expect(diagnostic.status).toBe('queued_owner')
      expect(diagnostic.queue).toMatchObject({
        queue_id: queueId,
        agent_id: 'dev-001',
        status: 'pending',
        channel_id: 'ops-ch',
      })
      expect(diagnostic.handoff_evidence?.github_url).toContain('issuecomment-owner')
    })
  })

  test('rejects owner queue evidence when explicit handoff channel differs', async () => {
    await withOwnerHandoffDb(async (db) => {
      const queueId = await seedOwnerQueue(db)

      const diagnostic = await buildOwnerHandoffDiagnostic(db, {
        senderAgentId: 'codex-cto',
        intendedRecipientAgentId: 'dev-001',
        queueId,
        channelId: 'other-ch',
        githubHandoffUrl: 'https://github.com/watchout/agent-comms-mcp/issues/592#issuecomment-owner',
      })

      expect(diagnostic.ok).toBe(false)
      expect(diagnostic.status).toBe('queue_evidence_mismatch')
      expect(diagnostic.channel_id).toBe('other-ch')
      expect(diagnostic.queue).toMatchObject({
        queue_id: queueId,
        agent_id: 'dev-001',
        channel_id: 'ops-ch',
      })
      expect(diagnostic.reason).toContain('belongs to channel ops-ch, not other-ch')

      await recordOwnerHandoffDiagnostic(db, diagnostic)
      const audits = await db.query<any>(
        `SELECT event_type, agent_id, target, detail
           FROM audit_log
          WHERE event_type = 'owner_handoff.route_diagnostic'`,
      )
      expect(audits).toHaveLength(1)
      expect(JSON.parse(audits[0].detail)).toMatchObject({
        status: 'queue_evidence_mismatch',
        sender_agent_id: 'codex-cto',
        intended_recipient_agent_id: 'dev-001',
        channel_id: 'other-ch',
        queue: {
          queue_id: queueId,
          agent_id: 'dev-001',
          channel_id: 'ops-ch',
        },
      })
    })
  })

  test('records blocked owner diagnostics with outbound ACL evidence', async () => {
    await withOwnerHandoffDb(async (db) => {
      await db.execute(
        `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
         VALUES ('ops-ch', $1, 'locked-test-policy')`,
        [JSON.stringify(['codex-cto'])],
      )

      const diagnostic = await buildOwnerHandoffDiagnostic(db, {
        senderAgentId: 'codex-cto',
        intendedRecipientAgentId: 'dev-001',
        channelId: 'ops-ch',
        githubHandoffUrl: 'https://github.com/watchout/agent-comms-mcp/issues/592#issuecomment-owner',
      })
      expect(diagnostic.ok).toBe(false)
      expect(diagnostic.status).toBe('blocked_outbound_acl')
      expect(diagnostic.acl).toMatchObject({
        sender: 'codex-cto',
        intended_recipient: 'dev-001',
        channel_id: 'ops-ch',
        violated_policy: 'channel.outboundAllowlist',
        outbound_allowlist: ['codex-cto'],
        policy_source: 'locked-test-policy',
        violations: ['dev-001'],
      })

      await recordOwnerHandoffDiagnostic(db, diagnostic)
      const audits = await db.query<any>(
        `SELECT event_type, agent_id, target, detail
           FROM audit_log
          WHERE event_type = 'owner_handoff.outbound_acl_blocked'`,
      )
      expect(audits).toHaveLength(1)
      expect(audits[0].agent_id).toBe('codex-cto')
      expect(audits[0].target).toBe('dev-001')
      expect(JSON.parse(audits[0].detail).acl).toMatchObject({
        sender: 'codex-cto',
        intended_recipient: 'dev-001',
        channel_id: 'ops-ch',
        violated_policy: 'channel.outboundAllowlist',
      })
    })
  })

  test('accepts explicit relay or owner policy evidence without owner queue', async () => {
    await withOwnerHandoffDb(async (db) => {
      await db.execute(
        `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
         VALUES ('ops-ch', $1, 'direct-route-blocked')`,
        [JSON.stringify(['codex-cto'])],
      )

      const diagnostic = await buildOwnerHandoffDiagnostic(db, {
        senderAgentId: 'codex-cto',
        intendedRecipientAgentId: 'dev-001',
        channelId: 'ops-ch',
        metadata: {
          owner_handoff: {
            evidence_type: 'relay_policy',
            policy_ref: 'ops-routing#592',
            relay_agent_id: 'codex-cto',
          },
        },
      })

      expect(diagnostic.ok).toBe(true)
      expect(diagnostic.status).toBe('relay_policy')
      expect(diagnostic.acl).toMatchObject({
        sender: 'codex-cto',
        intended_recipient: 'dev-001',
        channel_id: 'ops-ch',
        violated_policy: 'channel.outboundAllowlist',
        outbound_allowlist: ['codex-cto'],
        policy_source: 'direct-route-blocked',
        violations: ['dev-001'],
      })
      expect(diagnostic.relay_policy).toEqual({
        evidence_type: 'relay_policy',
        policy_ref: 'ops-routing#592',
        relay_agent_id: 'codex-cto',
      })
    })
  })

  test('distinguishes GitHub handoff evidence from queued owner evidence', async () => {
    await withOwnerHandoffDb(async (db) => {
      await db.execute(
        `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
         VALUES ('ops-ch', $1, 'test-allow')`,
        [JSON.stringify(['codex-cto', 'dev-001'])],
      )

      const diagnostic = await buildOwnerHandoffDiagnostic(db, {
        senderAgentId: 'codex-cto',
        intendedRecipientAgentId: 'dev-001',
        channelId: 'ops-ch',
        githubHandoffUrl: 'https://github.com/watchout/agent-comms-mcp/issues/592#issuecomment-owner',
      })

      expect(diagnostic.ok).toBe(false)
      expect(diagnostic.status).toBe('handoff_only')
      expect(diagnostic.queue).toBeNull()
      expect(diagnostic.handoff_evidence?.github_url).toContain('issuecomment-owner')
    })
  })
})
