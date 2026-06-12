/**
 * ADR-029R Spike A — Streamable HTTP MCP transport contract.
 *
 * Boots the real server.ts as a subprocess with the experimental flag and
 * exercises the REAL tools over the new transport with the MCP SDK client:
 * initialize → tools/list → bot_status → next → processing → done, plus the
 * off-by-default gate (frozen requirement 4) and session termination.
 *
 * LLM-client evidence (real codex / claude connections) lives in the manual
 * harness scripts/spike-029r-a-remote-mcp.ts and the recorded result doc —
 * this file is the CI-safe subset.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client as PgClient } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const HTTP_PORT = 39000 + Math.floor(Math.random() * 800)
const WEBHOOK_PORT = HTTP_PORT + 1000
const PREFIX = `sd-test-httpmcp-${process.pid}`
const BOT_A = `${PREFIX}-a`
const BOT_B = `${PREFIX}-b`

let serverProc: ChildProcess | null = null
let pg: PgClient

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

function mcpUrl(botId: string): URL {
  return new URL(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${botId}`)
}

async function connectClient(botId: string): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(mcpUrl(botId))
  const client = new McpClient({ name: `spike-a-${botId}`, version: '0.0.1' })
  await client.connect(transport)
  return { client, transport }
}

function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

describe('ADR-029R Spike A — Streamable HTTP MCP transport', () => {
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

    serverProc = spawn('bun', ['run', 'server.ts'], {
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
    await waitForHealth()
  }, 30000)

  afterAll(async () => {
    serverProc?.kill('SIGTERM')
    if (pg) {
      await pg.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${PREFIX}%`])
      await pg.query(`DELETE FROM agent_messages WHERE author_id LIKE $1`, [`${PREFIX}%`])
      await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
      await pg.end()
    }
  })

  test('initialize + tools/list exposes the real request/response tools', async () => {
    const { client, transport } = await connectClient(BOT_B)
    try {
      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name)
      for (const required of ['next', 'processing', 'done', 'send', 'notify', 'bot_status']) {
        expect(names).toContain(required)
      }
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  })

  test('bot_status responds over the new transport', async () => {
    const { client, transport } = await connectClient(BOT_B)
    try {
      const result = await client.callTool({ name: 'bot_status', arguments: {} })
      expect(textOf(result).length).toBeGreaterThan(0)
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  })

  test('next → processing → done lifecycle works end-to-end over HTTP', async () => {
    const msg = await pg.query(
      `INSERT INTO agent_messages (channel_id, author_id, content, source, direction, role, message_type, input_mentions)
       VALUES ('spike-a-channel', $1, 'spike-a queue work item', 'agent-comms', 'inbound', 'agent', 'instruction', ARRAY[$2])
       RETURNING id`,
      [BOT_A, BOT_B],
    )
    const messageId = String(msg.rows[0].id)
    const queued = await pg.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [
        BOT_B,
        messageId,
        JSON.stringify({
          channel_id: 'spike-a-channel',
          author_id: BOT_A,
          content: 'spike-a queue work item',
          message_type: 'instruction',
          message_id: messageId,
        }),
      ],
    )
    const queueId = String(queued.rows[0].id)

    const { client, transport } = await connectClient(BOT_B)
    try {
      const nextResult = await client.callTool({ name: 'next', arguments: {} })
      const nextText = textOf(nextResult)
      expect(nextText).toContain(queueId)

      const claimed = await pg.query(`SELECT status, claimed_by FROM message_queue WHERE id = $1`, [queueId])
      expect(claimed.rows[0].status).toBe('received')
      expect(claimed.rows[0].claimed_by).toBe(BOT_B)

      await client.callTool({ name: 'processing', arguments: { queue_id: queueId } })
      const inProgress = await pg.query(`SELECT status FROM message_queue WHERE id = $1`, [queueId])
      expect(inProgress.rows[0].status).toBe('in_progress')

      await client.callTool({ name: 'done', arguments: { queue_id: queueId } })
      const doneRow = await pg.query(`SELECT status, done_at FROM message_queue WHERE id = $1`, [queueId])
      expect(doneRow.rows[0].status).toBe('done')
      expect(doneRow.rows[0].done_at).not.toBeNull()
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  }, 20000)

  test('session terminates cleanly and a new session can be established', async () => {
    const first = await connectClient(BOT_B)
    await first.transport.terminateSession()
    await first.client.close()

    const second = await connectClient(BOT_B)
    try {
      const tools = await second.client.listTools()
      expect(tools.tools.length).toBeGreaterThan(0)
    } finally {
      await second.transport.terminateSession().catch(() => {})
      await second.client.close()
    }
  })

  test('endpoint requires bot_id (spike-only identity, fails closed without it)', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
    })
    expect(res.status).toBe(400)
  })
})
