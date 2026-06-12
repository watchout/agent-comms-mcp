/**
 * ADR-029R Spike B + C — daemon restart/reconnect + end-to-end DB queue canary.
 *
 * Spike B acceptance (ARC ACK):
 *  - same bot_id reconnect closes/replaces the prior connection deterministically
 *  - restart with ≥2 bots connected: clients recover without stale duplicate sessions
 *  - restart loses no pending queue rows (frozen requirement 6)
 *  - no duplicate Discord/native adapter ownership: the /mcp path creates no
 *    Discord clients at all (recorded in the result doc; nothing to own here)
 *
 * Spike C acceptance (ARC ACK):
 *  - A sends to B (real notify tool), B claims with next, marks processing,
 *    replies with send, and the queue row reaches a terminal state with
 *    correct target identity. Evidence: queue id, message_id, target agent_id,
 *    status transitions, claimed_by, read_at/claimed_at/replied_at.
 *  - Pending rows / ACKs are NOT treated as delivery evidence.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client as PgClient } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const HTTP_PORT = 39800 + Math.floor(Math.random() * 150)
const WEBHOOK_PORT = HTTP_PORT + 1200
const PREFIX = `sd-test-httpbc-${process.pid}`
const BOT_A = `${PREFIX}-a`
const BOT_B = `${PREFIX}-b`
const CANARY_CHANNEL = `${PREFIX}-channel`

let serverProc: ChildProcess | null = null
let pg: PgClient

function bootServer(): ChildProcess {
  return spawn('bun', ['run', 'server.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COM_EXPECTED_AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COMMS_PORT: String(HTTP_PORT),
      WEBHOOK_PORT: String(WEBHOOK_PORT),
      AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1',
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      AGENT_COM_RUNTIME_HEARTBEAT_DISABLED: '1',
      DATABASE_URL,
      DISCORD_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

async function waitForHealth(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server /health never became ready')
}

async function waitForExit(proc: ChildProcess, timeoutMs = 8000): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), timeoutMs)
    proc.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function connectClient(botId: string): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${botId}`))
  const client = new McpClient({ name: `spike-bc-${botId}`, version: '0.0.1' })
  await client.connect(transport)
  return { client, transport }
}

function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

beforeAll(async () => {
  pg = new PgClient({ connectionString: DATABASE_URL })
  await pg.connect()
  for (const id of [BOT_A, BOT_B]) {
    await pg.query(
      `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status, last_seen_at, registered_at)
       VALUES ($1, 'default', $1, 'dev', 'TUI', 'idle', now(), now())
       ON CONFLICT (agent_id) DO UPDATE SET status='idle', last_seen_at=now()`,
      [id],
    )
  }
  await pg.query(
    `INSERT INTO channels (id, org_id, type, name, members, created_by)
     VALUES ($1, 'default', 'channel', $1, ARRAY[$2, $3], $2)
     ON CONFLICT (id) DO NOTHING`,
    [CANARY_CHANNEL, BOT_A, BOT_B],
  )
  await pg.query(
    `INSERT INTO channel_routing_policy (channel_id, outbound_allowlist, policy_source)
     VALUES ($1, $2::jsonb, 'db')
     ON CONFLICT (channel_id) DO UPDATE SET outbound_allowlist = EXCLUDED.outbound_allowlist`,
    [CANARY_CHANNEL, JSON.stringify([BOT_A, BOT_B])],
  )
  serverProc = bootServer()
  await waitForHealth()
}, 30000)

afterAll(async () => {
  serverProc?.kill('SIGTERM')
  if (pg) {
    await pg.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agent_messages WHERE author_id LIKE $1 OR channel_id = $2`, [`${PREFIX}%`, CANARY_CHANNEL])
    await pg.query(`DELETE FROM channel_routing_policy WHERE channel_id = $1`, [CANARY_CHANNEL])
    await pg.query(`DELETE FROM channels WHERE id = $1`, [CANARY_CHANNEL])
    await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.end()
  }
})

describe('ADR-029R Spike B — restart / reconnect', () => {
  test('same bot_id reconnect deterministically replaces the prior session', async () => {
    const first = await connectClient(BOT_B)
    const firstSessionId = first.transport.sessionId
    expect(firstSessionId).toBeTruthy()

    const second = await connectClient(BOT_B)
    try {
      // New session works.
      const tools = await second.client.listTools()
      expect(tools.tools.length).toBeGreaterThan(0)

      // Old session is gone server-side: direct POST with the old session id
      // is rejected (400 unknown/expired session).
      const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${BOT_B}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': firstSessionId!,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
      })
      expect(res.status).toBe(400)
    } finally {
      await second.transport.terminateSession().catch(() => {})
      await second.client.close()
      await first.client.close().catch(() => {})
    }
  })

  test('daemon restart: ≥2 connected bots recover with fresh sessions, no stale duplicates, no pending rows lost', async () => {
    const a1 = await connectClient(BOT_A)
    const b1 = await connectClient(BOT_B)
    const oldSessionA = a1.transport.sessionId
    expect((await a1.client.listTools()).tools.length).toBeGreaterThan(0)
    expect((await b1.client.listTools()).tools.length).toBeGreaterThan(0)

    // Pending row seeded BEFORE the restart — must survive (frozen req 6).
    const seeded = await pg.query(
      `INSERT INTO message_queue (agent_id, payload, status)
       VALUES ($1, $2, 'pending') RETURNING id`,
      [BOT_B, JSON.stringify({ channel_id: CANARY_CHANNEL, author_id: BOT_A, content: 'survives restart', message_type: 'instruction' })],
    )
    const survivorQueueId = String(seeded.rows[0].id)

    // Restart the daemon.
    serverProc!.kill('SIGTERM')
    await waitForExit(serverProc!)
    serverProc = bootServer()
    await waitForHealth()

    // Old session ids are rejected after restart.
    const stale = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${BOT_A}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': oldSessionA!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }),
    })
    expect(stale.status).toBe(400)

    // Both bots re-establish fresh sessions and work.
    const a2 = await connectClient(BOT_A)
    const b2 = await connectClient(BOT_B)
    try {
      expect((await a2.client.listTools()).tools.length).toBeGreaterThan(0)
      expect((await b2.client.listTools()).tools.length).toBeGreaterThan(0)

      // The pending row survived the restart and is still claimable.
      const row = await pg.query(`SELECT status FROM message_queue WHERE id = $1`, [survivorQueueId])
      expect(row.rows[0].status).toBe('pending')
    } finally {
      await a2.transport.terminateSession().catch(() => {})
      await b2.transport.terminateSession().catch(() => {})
      await a2.client.close()
      await b2.client.close()
      await a1.client.close().catch(() => {})
      await b1.client.close().catch(() => {})
      await pg.query(`DELETE FROM message_queue WHERE id = $1`, [survivorQueueId])
    }
  }, 40000)
})

describe('ADR-029R Spike C — end-to-end DB queue canary over HTTP MCP', () => {
  test('A notify → B next/processing → B send reply → terminal state with full evidence', async () => {
    const a = await connectClient(BOT_A)
    const b = await connectClient(BOT_B)
    try {
      // A sends to B with the REAL notify tool.
      const notifyResult = await a.client.callTool({
        name: 'notify',
        arguments: {
          channel_id: CANARY_CHANNEL,
          content: `[spike-c] canary work item for ${BOT_B}`,
          mention: BOT_B,
        },
      })
      const notifyText = textOf(notifyResult)
      const messageId = notifyText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0]
      expect(messageId).toBeTruthy()

      // Queue row exists for B (pending — explicitly NOT yet delivery evidence).
      const queued = await pg.query(
        `SELECT id, status FROM message_queue WHERE message_id = $1 AND agent_id = $2`,
        [messageId, BOT_B],
      )
      expect(queued.rows.length).toBe(1)
      const queueId = String(queued.rows[0].id)
      expect(queued.rows[0].status).toBe('pending')

      // B claims with the REAL next tool. claimed_by is asserted here, at
      // claim time — reply finalization clears the claim columns by design.
      const nextText = textOf(await b.client.callTool({ name: 'next', arguments: {} }))
      expect(nextText).toContain(queueId)
      const midFlight = await pg.query(
        `SELECT status, claimed_by, read_at, claimed_at FROM message_queue WHERE id = $1`,
        [queueId],
      )
      expect(midFlight.rows[0].status).toBe('received')
      expect(midFlight.rows[0].claimed_by).toBe(BOT_B)
      expect(midFlight.rows[0].read_at).not.toBeNull()
      expect(midFlight.rows[0].claimed_at).not.toBeNull()

      // B marks processing.
      await b.client.callTool({ name: 'processing', arguments: { queue_id: queueId } })

      // B replies with the REAL send tool (reply_to = A's message).
      await b.client.callTool({
        name: 'send',
        arguments: {
          content: `[spike-c] canary reply from ${BOT_B}`,
          reply_to: messageId!,
          mention: BOT_A,
        },
      })

      // Terminal state with full ARC evidence fields.
      const final = await pg.query(
        `SELECT id, message_id, agent_id, status, claimed_by, read_at, claimed_at, replied_at, replied_with
           FROM message_queue WHERE id = $1`,
        [queueId],
      )
      const row = final.rows[0]
      expect(row.status).toBe('replied')
      expect(row.agent_id).toBe(BOT_B)
      expect(row.replied_at).not.toBeNull()
      expect(row.replied_with).not.toBeNull()

      // The reply itself reached A's queue (A is the next hop's target).
      const replyQueued = await pg.query(
        `SELECT agent_id, status FROM message_queue WHERE message_id::text = $1 AND agent_id = $2`,
        [String(row.replied_with), BOT_A],
      )
      expect(replyQueued.rows.length).toBe(1)
    } finally {
      await a.transport.terminateSession().catch(() => {})
      await b.transport.terminateSession().catch(() => {})
      await a.client.close()
      await b.client.close()
    }
  }, 30000)
})
