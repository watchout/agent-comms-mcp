/**
 * ADR-050 fixture (6b) — agent-comms inbound pipeline succeeds without
 * any /tmp/agent-com-*.pid file present (post-UnixSignalBus removal).
 *
 * Real handler invocation: wires `handleInboundMessage()` against a real
 * Postgres `DATABASE_URL`, runs an end-to-end inbound message through
 * persistInboundDelivery (Step 7b + 7d) and verifies that:
 *   - one message_queue row is committed
 *   - the call returns successfully
 *   - no PID file is created or required
 *   - no warning / error is emitted about a missing PID file
 *
 * Skipped without DATABASE_URL (per dispatch fixture spec). When set,
 * runs against the configured PG instance with a probe agent_id so it
 * does not contaminate fleet traffic.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import {
  handleInboundMessage,
  setInboundReceiverDeps,
  type InboundReceiverDeps,
} from '../../adapters/inbound-receiver'

const HAS_DB = !!process.env.DATABASE_URL

describe.skipIf(!HAS_DB)('ADR-050 §6b — bot inbound pipeline starts without PID file', () => {
  const probeAgent = `adr050-probe-${randomUUID().slice(0, 8)}`
  const probeChannel = `adr050-ch-${randomUUID().slice(0, 8)}`
  let pg: Client

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL! })
    await pg.connect()
    // Register the probe agent + channel + membership so routeInbound can
    // resolve a real push target.
    await pg.query(
      `INSERT INTO agents (agent_id, display_name, status, agent_type, runtime)
         VALUES ($1, $1, 'online', 'agent', 'bun')
         ON CONFLICT (agent_id) DO UPDATE SET status = 'online'`,
      [probeAgent],
    )
    await pg.query(
      `INSERT INTO channels (channel_id, name, kind)
         VALUES ($1, $1, 'group')
         ON CONFLICT (channel_id) DO NOTHING`,
      [probeChannel],
    )
    await pg.query(
      `INSERT INTO channel_members (channel_id, agent_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [probeChannel, probeAgent],
    )
    await pg.query(
      `INSERT INTO channel_adapters (channel_id, platform, external_id)
         VALUES ($1, 'discord', $1)
         ON CONFLICT DO NOTHING`,
      [probeChannel],
    )
  })

  afterAll(async () => {
    if (pg) {
      await pg.query(`DELETE FROM message_queue WHERE agent_id = $1`, [probeAgent]).catch(() => {})
      await pg.query(`DELETE FROM agent_messages WHERE author_id = $1 OR author_id LIKE 'adr050-%'`, [probeAgent]).catch(() => {})
      await pg.query(`DELETE FROM channel_members WHERE channel_id = $1`, [probeChannel]).catch(() => {})
      await pg.query(`DELETE FROM channel_adapters WHERE channel_id = $1`, [probeChannel]).catch(() => {})
      await pg.query(`DELETE FROM channels WHERE channel_id = $1`, [probeChannel]).catch(() => {})
      await pg.query(`DELETE FROM agents WHERE agent_id = $1`, [probeAgent]).catch(() => {})
      await pg.end()
    }
  })

  test('no PID files for the probe agent on disk before / after run', async () => {
    // Before: no PID file created by the new code path
    const before = existsSync(`/tmp/agent-com-${probeAgent}.pid`)
    expect(before).toBe(false)

    // Wire deps and invoke the real handler.
    const stderrChunks: string[] = []
    const deps: InboundReceiverDeps = {
      agentId: probeAgent,
      authMode: 'off',
      databaseUrl: process.env.DATABASE_URL!,
      receiverPipelineBots: new Set(),
      processedIds: new Map(),
      tryGetDb: async () => ({
        query: async (sql: string, params?: any[]) => {
          const r = await pg.query(sql, params)
          return { rows: r.rows, rowCount: r.rowCount ?? null }
        },
      }),
      coreDbAdapter: async () => ({
        query: async (sql: string, params?: any[]) => {
          const r = await pg.query(sql, params)
          return { rows: r.rows }
        },
      }) as any,
      saveMessage: async (msg) => {
        const id = randomUUID()
        await pg.query(
          `INSERT INTO agent_messages (id, channel_id, thread_id, author_id, content, message_type, source, direction, role)
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'in'), COALESCE($9, 'user'))`,
          [
            id,
            msg.channel_id,
            msg.thread_id ?? null,
            msg.author_id,
            msg.content,
            msg.message_type ?? 'chat',
            msg.source ?? 'agent-comms',
            msg.direction ?? 'in',
            msg.role ?? 'user',
          ],
        )
        return id
      },
      validateIncomingAuth: () => ({ valid: true }),
      buildQuoteBlock: async () => null,
      updateActiveThread: async () => {},
      hashCode: (s: string) => s.length,
      mcpPush: undefined,
      stderrSink: (chunk: string) => stderrChunks.push(chunk),
    }
    setInboundReceiverDeps(deps)

    const externalMessageId = `adr050-${randomUUID().slice(0, 12)}`
    await handleInboundMessage({
      receiverAgentId: probeAgent,
      externalChannelId: probeChannel,
      externalMessageId,
      authorExternalId: 'adr050-author',
      authorName: 'Probe',
      authorIsBot: false,
      content: 'adr-050 smoke',
      timestamp: new Date(),
      platform: 'discord',
      mentions: [probeAgent],
    })

    // PID file MUST NOT exist after the handler runs (post-ADR-050 there is
    // no code path that writes one).
    const after = existsSync(`/tmp/agent-com-${probeAgent}.pid`)
    expect(after).toBe(false)

    // No stderr complaint about PID files / signals being missing.
    const stderr = stderrChunks.join('')
    expect(stderr.toLowerCase()).not.toContain('pid file')
    expect(stderr).not.toMatch(/UnixSignalBus/)
    expect(stderr).not.toMatch(/bus\.signal/)

    // The message_queue row is committed (the wake-daemon would now pick it
    // up; here we only assert the row reached the queue).
    const q = await pg.query(
      `SELECT count(*)::int AS n FROM message_queue WHERE agent_id = $1`,
      [probeAgent],
    )
    expect(q.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  test('no /tmp/agent-com-*.pid files left lying around for the probe', () => {
    // Defensive: after the test no probe-named PID file should exist.
    const stragglers = readdirSync('/tmp')
      .filter((f) => f.startsWith(`agent-com-${probeAgent}`) && f.endsWith('.pid'))
    expect(stragglers).toEqual([])
  })
})
