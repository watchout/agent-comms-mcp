import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { refreshChannelPolicyDbSnapshot, resetChannelPolicyCache } from '../core/channel-policy'
import { resolvePhase5 } from '../core/routing/server-integration'

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
    seed.exec(`INSERT INTO channels (id, name, members) VALUES ('acl-ch', 'acl-ch', '["target-b"]')`)
    seed.exec(`
      INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
      VALUES ('acl-ch', '["sender-a","target-b"]', 'test-mcp-policy')
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
  test('resolvePhase5 ignores a permissive legacy allowlist and exposes channels.members violations', async () => {
    await withAclDb(async () => {
      const phase5 = resolvePhase5({
        sender: 'sender-a',
        channel_id: 'acl-ch',
        mentions: ['target-b'],
        content: 'blocked',
        isKnownAgent: (id) => ['sender-a', 'target-b'].includes(id),
      })

      expect(phase5 && !phase5.ok ? phase5 : null).toMatchObject({
        ok: false,
        error: 'CHANNEL_MEMBERSHIP_VIOLATION',
        intended_recipients: ['target-b'],
        violations: ['sender-a'],
      })
    })
  })

  test('server send and notify membership branches record durable DB-authority audit evidence', () => {
    const src = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')
    const sendIdx = src.indexOf("if (name === 'send')")
    const notifyIdx = src.indexOf("if (name === 'notify')")
    const quoteIdx = src.indexOf("if (name === 'quote')", notifyIdx)
    const sendBody = src.slice(sendIdx, notifyIdx)
    const notifyBody = src.slice(notifyIdx, quoteIdx === -1 ? src.length : quoteIdx)
    const authority = readFileSync(join(REPO_ROOT, 'core', 'communication-authority.ts'), 'utf8')

    expect(sendBody).toContain("writeMcpCommunicationAuthorityViolationAudit(")
    expect(sendBody).toContain("'send'")
    expect(sendBody).toContain('formatCommunicationAuthorityViolation(detail)')
    expect(notifyBody).toContain("writeMcpCommunicationAuthorityViolationAudit(")
    expect(notifyBody).toContain("'notify'")
    expect(notifyBody).toContain('formatCommunicationAuthorityViolation(detail)')
    expect(src).toContain("'channel.membership_violation'")
    expect(authority).toContain("OUTBOUND_ALLOWLIST_COMPATIBILITY_STATUS = 'DEPRECATED_NON_AUTHORITATIVE'")
  })
})
