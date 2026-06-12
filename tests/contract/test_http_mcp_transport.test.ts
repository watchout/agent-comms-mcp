/**
 * ADR-029R — Streamable HTTP MCP transport contract (PR 4 productionized).
 *
 * Default identity mode is BINDING: the bearer credential IS the identity
 * (sha256 → agent_identity_keys), bot_id is derived, mismatching claims fail
 * closed. The spike-era bot_id query identity survives only behind an
 * explicit AGENT_COMMS_HTTP_MCP_IDENTITY=spike-bot-id opt-in (dev/test).
 *
 * Covers: real tools over HTTP, queue lifecycle, identity binding positive +
 * negative cases, off-by-default gate (frozen req 4), deterministic
 * stale/unknown session semantics (404, incl. stale initialize).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client as PgClient } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const HTTP_PORT = 39000 + Math.floor(Math.random() * 700)
const PREFIX = `sd-test-httpmcp-${process.pid}`
const BOT_A = `${PREFIX}-a`
const BOT_B = `${PREFIX}-b`

const TOKENS: Record<string, string> = {
  [BOT_A]: `tok-${randomUUID()}`,
  [BOT_B]: `tok-${randomUUID()}`,
}

let serverProc: ChildProcess | null = null
let pg: PgClient

function bootServerWith(extraEnv: Record<string, string>, port: number): ChildProcess {
  return spawn('bun', ['run', 'server.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COM_EXPECTED_AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COMMS_PORT: String(port),
      WEBHOOK_PORT: String(port + 1000),
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      AGENT_COM_RUNTIME_HEARTBEAT_DISABLED: '1',
      DATABASE_URL,
      DISCORD_BOT_TOKEN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

async function waitHealth(port: number): Promise<void> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server /health never became ready')
}

function initBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'contract', version: '0' } },
  })
}

async function connectClient(botId: string, port = HTTP_PORT): Promise<{ client: McpClient; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKENS[botId]}` } },
  })
  const client = new McpClient({ name: `contract-${botId}`, version: '0.0.1' })
  await client.connect(transport)
  return { client, transport }
}

function textOf(result: any): string {
  return (result?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

async function seedBearerKey(client: PgClient, agentId: string, token: string): Promise<void> {
  const fingerprint = createHash('sha256').update(token).digest('hex')
  await client.query(
    `INSERT INTO agent_identity_keys (agent_id, key_type, public_key, fingerprint, status, metadata)
     VALUES ($1, 'bearer-sha256', 'bearer-token-sha256', $2, 'active', '{"purpose":"contract-test"}')
     ON CONFLICT (fingerprint) DO NOTHING`,
    [agentId, fingerprint],
  )
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
    await seedBearerKey(pg, id, TOKENS[id])
  }

  serverProc = bootServerWith({ AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1' }, HTTP_PORT)
  await waitHealth(HTTP_PORT)
}, 30000)

afterAll(async () => {
  serverProc?.kill('SIGTERM')
  if (pg) {
    await pg.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agent_messages WHERE author_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agent_identity_keys WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM audit_log WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.end()
  }
})

describe('identity binding mode (default) — credential IS the identity', () => {
  test('bound bearer initializes; identity derived without bot_id; binding audit-logged', async () => {
    const { client, transport } = await connectClient(BOT_B)
    try {
      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name)
      for (const required of ['next', 'processing', 'done', 'send', 'notify', 'bot_status']) {
        expect(names).toContain(required)
      }
      const audit = await pg.query(
        `SELECT 1 FROM audit_log WHERE event_type = 'http_mcp.identity_bound' AND agent_id = $1`,
        [BOT_B],
      )
      expect(audit.rows.length).toBeGreaterThan(0)
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  })

  test('missing bearer → 401, unknown bearer → 401, no session created', async () => {
    const missing = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: initBody(),
    })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('mcp-session-id')).toBeNull()

    const unknown = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token',
      },
      body: initBody(),
    })
    expect(unknown.status).toBe(401)
  })

  test('bot_id claim mismatching the bound credential → 403 fail-closed; matching claim → ok', async () => {
    const mismatch = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${BOT_A}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
      },
      body: initBody(),
    })
    expect(mismatch.status).toBe(403)

    const match = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp?bot_id=${BOT_B}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
      },
      body: initBody(),
    })
    expect(match.status).toBe(200)
    const sid = match.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()
    await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid!, Authorization: `Bearer ${TOKENS[BOT_B]}` },
    })
  })

  test('revoked credential → 401', async () => {
    const revokedToken = `tok-revoked-${randomUUID()}`
    await seedBearerKey(pg, BOT_A, revokedToken)
    await pg.query(
      `UPDATE agent_identity_keys SET status='revoked', revoked_at=now() WHERE fingerprint = $1`,
      [createHash('sha256').update(revokedToken).digest('hex')],
    )
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${revokedToken}`,
      },
      body: initBody(),
    })
    expect(res.status).toBe(401)
  })
})

describe('real tools over the bound transport', () => {
  test('next → processing → done lifecycle with derived identity', async () => {
    const msg = await pg.query(
      `INSERT INTO agent_messages (channel_id, author_id, content, source, direction, role, message_type, input_mentions)
       VALUES ('pr4-channel', $1, 'pr4 queue work item', 'agent-comms', 'inbound', 'agent', 'instruction', ARRAY[$2])
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
        JSON.stringify({ channel_id: 'pr4-channel', author_id: BOT_A, content: 'pr4 queue work item', message_type: 'instruction', message_id: messageId }),
      ],
    )
    const queueId = String(queued.rows[0].id)

    const { client, transport } = await connectClient(BOT_B)
    try {
      const nextText = textOf(await client.callTool({ name: 'next', arguments: {} }))
      expect(nextText).toContain(queueId)
      const claimed = await pg.query(`SELECT status, claimed_by FROM message_queue WHERE id = $1`, [queueId])
      expect(claimed.rows[0].status).toBe('received')
      expect(claimed.rows[0].claimed_by).toBe(BOT_B)

      await client.callTool({ name: 'processing', arguments: { queue_id: queueId } })
      await client.callTool({ name: 'done', arguments: { queue_id: queueId } })
      const doneRow = await pg.query(`SELECT status, done_at FROM message_queue WHERE id = $1`, [queueId])
      expect(doneRow.rows[0].status).toBe('done')
      expect(doneRow.rows[0].done_at).not.toBeNull()
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  }, 20000)
})

describe('deterministic session semantics (ADR-029R PR4 constraint)', () => {
  test('unknown mcp-session-id → 404 SESSION_NOT_FOUND', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
        'mcp-session-id': randomUUID(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('SESSION_NOT_FOUND')
  })

  test('stale INITIALIZE (init request carrying a dead session id) → 404, then fresh init works', async () => {
    const stale = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
        'mcp-session-id': randomUUID(),
      },
      body: initBody(),
    })
    expect(stale.status).toBe(404)

    const fresh = await connectClient(BOT_B)
    try {
      expect((await fresh.client.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      await fresh.transport.terminateSession().catch(() => {})
      await fresh.client.close()
    }
  })

  test('terminated session id → 404 on subsequent use', async () => {
    const first = await connectClient(BOT_B)
    const sid = first.transport.sessionId!
    await first.transport.terminateSession()
    await first.client.close()

    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('health exposes source identity and per-session states (frozen reqs 3+5)', () => {
  test('/health carries repo_path, git_sha, startup_command, pid, started_at and live http sessions', async () => {
    const { client, transport } = await connectClient(BOT_B)
    try {
      const health = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/health`)).json()
      expect(health.source.pid).toBeGreaterThan(0)
      expect(typeof health.source.repo_path).toBe('string')
      expect(health.source.git_sha.length).toBeGreaterThan(0)
      expect(health.source.startup_command).toContain('server.ts')
      expect(health.source.started_at).toBeTruthy()
      expect(health.http_mcp.identity_mode).toBe('binding')
      const session = health.http_mcp.sessions.find((s: any) => s.bot_id === BOT_B)
      expect(session).toBeTruthy()
      expect(session.connected_at).toBeTruthy()
      expect(session.last_activity).toBeTruthy()
    } finally {
      await transport.terminateSession().catch(() => {})
      await client.close()
    }
  })
})

describe('ARC gate — /mcp is off by default (no experimental flag)', () => {
  const PORT = HTTP_PORT + 2
  let proc: ChildProcess | null = null

  beforeAll(async () => {
    proc = bootServerWith({}, PORT)
    await waitHealth(PORT)
  }, 30000)

  afterAll(() => {
    proc?.kill('SIGTERM')
  })

  test('initialize POST to /mcp does not reach the MCP endpoint when the flag is off', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[BOT_B]}`,
      },
      body: initBody(),
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })
})

describe('spike-bot-id mode requires explicit opt-in (dev/test only)', () => {
  const PORT = HTTP_PORT + 4
  const SHARED = `shared-${randomUUID()}`
  let proc: ChildProcess | null = null

  beforeAll(async () => {
    proc = bootServerWith({
      AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1',
      AGENT_COMMS_HTTP_MCP_IDENTITY: 'spike-bot-id',
      AUTH_TOKEN: SHARED,
      AUTH_SKIP_LOCALHOST: 'false',
    }, PORT)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { Authorization: `Bearer ${SHARED}` } })
        if (res.ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('spike-mode server never became ready')
  }, 30000)

  afterAll(() => {
    proc?.kill('SIGTERM')
  })

  test('shared AUTH_TOKEN + bot_id works only in explicit spike mode', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp?bot_id=${BOT_B}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${SHARED}`,
      },
      body: initBody(),
    })
    expect(res.status).toBe(200)
    const sid = res.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()
    await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid!, Authorization: `Bearer ${SHARED}` },
    })
  })

  test('missing bot_id in spike mode → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${SHARED}`,
      },
      body: initBody(),
    })
    expect(res.status).toBe(400)
  })
})
