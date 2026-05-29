import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { refreshChannelPolicyDbSnapshot, resetChannelPolicyCache } from '../core/channel-policy'
import { resolvePhase5 } from '../core/routing/server-integration'
import {
  buildOutboundAclViolationDetail,
  recordOutboundAclViolation,
} from '../core/outbound-acl-diagnostic'

const REPO_ROOT = new URL('..', import.meta.url).pathname

async function withAclDb<T>(fn: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-mcp-acl-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(`
      INSERT INTO agents (agent_id, display_name, agent_type, status)
      VALUES
        ('sender-a', 'sender-a', 'dev', 'idle'),
        ('target-b', 'target-b', 'dev', 'idle')
    `)
    seed.exec(`INSERT INTO channels (id, name, members) VALUES ('acl-ch', 'acl-ch', '["sender-a","target-b"]')`)
    seed.exec(`
      INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('acl-ch', '["target-b"]', 'test-mcp-policy')
    `)
    seed.close()

    adapter = new SqliteAdapter(dbPath)
    resetChannelPolicyCache()
    await refreshChannelPolicyDbSnapshot({
      async query(sql: string, params?: unknown[]) {
        return { rows: await adapter!.query(sql, params as any[]) }
      },
    })
    return await fn(adapter)
  } finally {
    resetChannelPolicyCache()
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('MCP outbound ACL diagnostics', () => {
  test('resolvePhase5 exposes canonical recipients for durable ACL evidence', async () => {
    await withAclDb(async (db) => {
      const phase5 = resolvePhase5({
        sender: 'sender-a',
        channel_id: 'acl-ch',
        mentions: ['target-b'],
        content: 'blocked',
        isKnownAgent: (id) => ['sender-a', 'target-b'].includes(id),
      })

      expect(phase5 && !phase5.ok ? phase5 : null).toMatchObject({
        ok: false,
        error: 'OUTBOUND_ACL_VIOLATION',
        intended_recipients: ['target-b'],
        violations: ['sender-a'],
      })

      if (!phase5 || phase5.ok || phase5.error !== 'OUTBOUND_ACL_VIOLATION') {
        throw new Error('expected outbound ACL violation')
      }

      const detail = await buildOutboundAclViolationDetail(
        db as any,
        'notify',
        'sender-a',
        'acl-ch',
        phase5.intended_recipients ?? [],
        phase5.violations ?? [],
      )
      expect(detail).toEqual({
        operation: 'notify',
        sender: 'sender-a',
        intended_recipients: ['target-b'],
        channel_id: 'acl-ch',
        violated_policy: 'channel.outboundAllowlist',
        outbound_allowlist: ['target-b'],
        policy_source: 'test-mcp-policy',
        violations: ['sender-a'],
      })

      await recordOutboundAclViolation(db as any, detail)
      const audits = await db.query<any>(
        `SELECT event_type, agent_id, target, detail
           FROM audit_log
          WHERE event_type = 'outbound.acl_violation'`,
      )
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        agent_id: 'sender-a',
        target: 'acl-ch',
      })
      expect(JSON.parse(audits[0].detail)).toMatchObject(detail)
    })
  })

  test('server send and notify ACL branches record durable audit evidence', () => {
    const src = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')
    const sendIdx = src.indexOf("if (name === 'send')")
    const notifyIdx = src.indexOf("if (name === 'notify')")
    const quoteIdx = src.indexOf("if (name === 'quote')", notifyIdx)
    const sendBody = src.slice(sendIdx, notifyIdx)
    const notifyBody = src.slice(notifyIdx, quoteIdx === -1 ? src.length : quoteIdx)
    const helper = readFileSync(join(REPO_ROOT, 'core', 'outbound-acl-diagnostic.ts'), 'utf8')

    expect(sendBody).toContain("writeMcpOutboundAclViolationAudit(")
    expect(sendBody).toContain("'send'")
    expect(sendBody).toContain('formatOutboundAclViolation(detail)')
    expect(notifyBody).toContain("writeMcpOutboundAclViolationAudit(")
    expect(notifyBody).toContain("'notify'")
    expect(notifyBody).toContain('formatOutboundAclViolation(detail)')
    expect(helper).toContain("'outbound.acl_violation'")
  })
})
