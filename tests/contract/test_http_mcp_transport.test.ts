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
const PORT_BLOCK_START = 12000
const PORT_BLOCK_END = 18000
const PORT_BLOCK_STRIDE = 8
const SERVER_PORT_OFFSETS = [0, 2, 4] as const
const WEBHOOK_PORT_OFFSET = 1000
const PREFIX = `sd-test-httpmcp-${process.pid}`
const BOT_A = `${PREFIX}-a`
const BOT_B = `${PREFIX}-b`

const TOKENS: Record<string, string> = {
  [BOT_A]: `tok-${randomUUID()}`,
  [BOT_B]: `tok-${randomUUID()}`,
}

type PortReservation = { stop(closeActiveConnections?: boolean): Promise<void> }
type ProcessDiagnostics = {
  stderr: string
  spawnError: string | null
  exited: Promise<void>
}

function reservePort(port: number): PortReservation {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    reusePort: false,
    fetch() { return new Response('', { status: 503 }) },
  })
}

function reserveInitialCandidate(): { base: number; reservation: PortReservation } {
  for (let base = PORT_BLOCK_START; base <= PORT_BLOCK_END; base += PORT_BLOCK_STRIDE) {
    try {
      return { base, reservation: reservePort(base) }
    } catch {}
  }
  throw new Error(`no candidate port available in ${PORT_BLOCK_START}-${PORT_BLOCK_END}`)
}

async function reservePortBlock(start: number): Promise<{ base: number; reservations: Map<number, PortReservation> }> {
  candidate: for (let base = start; base <= PORT_BLOCK_END; base += PORT_BLOCK_STRIDE) {
    const reservations = new Map<number, PortReservation>()
    for (const offset of SERVER_PORT_OFFSETS) {
      for (const port of [base + offset, base + offset + WEBHOOK_PORT_OFFSET]) {
        try {
          reservations.set(port, reservePort(port))
        } catch {
          await Promise.all([...reservations.values()].map((reservation) => reservation.stop(true)))
          continue candidate
        }
      }
    }
    return { base, reservations }
  }
  throw new Error(`no six-port server block available in ${start}-${PORT_BLOCK_END + WEBHOOK_PORT_OFFSET + 4}`)
}

let BLOCKED_CANDIDATE_PORT = 0
let HTTP_PORT = 0
let portReservations = new Map<number, PortReservation>()

async function releaseReservedPair(port: number): Promise<void> {
  const released: PortReservation[] = []
  for (const reservedPort of [port, port + WEBHOOK_PORT_OFFSET]) {
    const reservation = portReservations.get(reservedPort)
    if (!reservation) throw new Error(`missing reservation for child-server port ${reservedPort}`)
    released.push(reservation)
    portReservations.delete(reservedPort)
  }
  await Promise.all(released.map((reservation) => reservation.stop(true)))
}

async function releaseRemainingReservations(): Promise<void> {
  const remaining = [...portReservations.values()]
  portReservations.clear()
  await Promise.all(remaining.map((reservation) => reservation.stop(true)))
}

const processDiagnostics = new WeakMap<ChildProcess, ProcessDiagnostics>()
let serverProc: ChildProcess | null = null
let pg: PgClient

function bootServerWith(extraEnv: Record<string, string>, port: number): ChildProcess {
  const proc = spawn('bun', ['run', 'server.ts'], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COM_EXPECTED_AGENT_ID: `${PREFIX}-stdio`,
      AGENT_COMMS_PORT: String(port),
      WEBHOOK_PORT: String(port + WEBHOOK_PORT_OFFSET),
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      AGENT_COM_RUNTIME_HEARTBEAT_DISABLED: '1',
      DATABASE_URL,
      DISCORD_BOT_TOKEN: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let resolveExited!: () => void
  const diagnostics: ProcessDiagnostics = {
    stderr: '',
    spawnError: null,
    exited: new Promise<void>((resolve) => { resolveExited = resolve }),
  }
  processDiagnostics.set(proc, diagnostics)
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    diagnostics.stderr = `${diagnostics.stderr}${chunk}`.slice(-16_000)
  })
  proc.once('error', (err) => {
    diagnostics.spawnError = String(err)
    resolveExited()
  })
  proc.once('exit', () => resolveExited())
  return proc
}

function processFailure(proc: ChildProcess, label: string, port: number): Error {
  const diagnostics = processDiagnostics.get(proc)
  return new Error(
    `${label} failed on port ${port}: exit=${proc.exitCode ?? 'null'} signal=${proc.signalCode ?? 'null'}` +
    `${diagnostics?.spawnError ? ` spawn_error=${diagnostics.spawnError}` : ''}` +
    `\nstderr:\n${diagnostics?.stderr || '(empty)'}`,
  )
}

async function waitHealth(
  proc: ChildProcess,
  port: number,
  headers: Record<string, string> = {},
  label = 'server /health',
): Promise<void> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const diagnostics = processDiagnostics.get(proc)
    if (proc.exitCode !== null || proc.signalCode !== null || diagnostics?.spawnError) {
      throw processFailure(proc, label, port)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw processFailure(proc, `${label} never became ready`, port)
}

async function stopServer(proc: ChildProcess | null, timeoutMs = 8000): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const diagnostics = processDiagnostics.get(proc)
  if (!diagnostics) throw new Error('missing child-process diagnostics')
  proc.kill('SIGTERM')
  const exited = await Promise.race([
    diagnostics.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])
  if (exited) return
  proc.kill('SIGKILL')
  const killed = await Promise.race([
    diagnostics.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
  ])
  if (!killed) throw processFailure(proc, 'server did not terminate', -1)
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
  // Reserve every port used by the three child servers up front. Keeping
  // future pairs reserved prevents earlier localhost connections from taking
  // them as ephemeral client ports. The deliberate first-port blocker proves
  // that selection advances to a complete free block instead of trusting a
  // random pick.
  const blockedCandidate = reserveInitialCandidate()
  const selectedPorts = await reservePortBlock(blockedCandidate.base)
    .finally(() => blockedCandidate.reservation.stop(true))
  BLOCKED_CANDIDATE_PORT = blockedCandidate.base
  HTTP_PORT = selectedPorts.base
  portReservations = selectedPorts.reservations

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

  await releaseReservedPair(HTTP_PORT)
  serverProc = bootServerWith({ AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1' }, HTTP_PORT)
  await waitHealth(serverProc, HTTP_PORT)
}, 30000)

afterAll(async () => {
  await stopServer(serverProc)
  await releaseRemainingReservations()
  if (pg) {
    await pg.query(`DELETE FROM message_queue WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agent_messages WHERE author_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agent_identity_keys WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM audit_log WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
    await pg.end()
  }
})

describe('deterministic child-server port fixture', () => {
  test('skips a deliberately occupied initial candidate and selects the next complete block', () => {
    expect(HTTP_PORT).toBeGreaterThan(BLOCKED_CANDIDATE_PORT)
    expect((HTTP_PORT - BLOCKED_CANDIDATE_PORT) % PORT_BLOCK_STRIDE).toBe(0)
  })
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
  let PORT = 0
  let proc: ChildProcess | null = null

  beforeAll(async () => {
    PORT = HTTP_PORT + 2
    await releaseReservedPair(PORT)
    proc = bootServerWith({}, PORT)
    await waitHealth(proc, PORT)
  }, 30000)

  afterAll(async () => {
    await stopServer(proc)
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
  let PORT = 0
  const SHARED = `shared-${randomUUID()}`
  let proc: ChildProcess | null = null

  beforeAll(async () => {
    PORT = HTTP_PORT + 4
    await releaseReservedPair(PORT)
    proc = bootServerWith({
      AGENT_COMMS_EXPERIMENTAL_HTTP_MCP: '1',
      AGENT_COMMS_HTTP_MCP_IDENTITY: 'spike-bot-id',
      AUTH_TOKEN: SHARED,
      AUTH_SKIP_LOCALHOST: 'false',
    }, PORT)
    await waitHealth(proc, PORT, { Authorization: `Bearer ${SHARED}` }, 'spike-mode server /health')
  }, 30000)

  afterAll(async () => {
    await stopServer(proc)
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

describe('established-session credential re-validation (ARC review 4489519640)', () => {
  async function openSession(botId: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKENS[botId]}`,
      },
      body: initBody(),
    })
    expect(res.status).toBe(200)
    const sid = res.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()
    return sid!
  }

  function sessionRequest(sid: string, headers: Record<string, string>, method = 'POST'): Promise<Response> {
    return fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
        ...headers,
      },
      ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list' }) } : {}),
    })
  }

  test('session id alone (missing bearer) → 401, session stays alive', async () => {
    const sid = await openSession(BOT_B)
    try {
      const res = await sessionRequest(sid, {})
      expect(res.status).toBe(401)
      expect((await res.json()).code).toBe('IDENTITY_CREDENTIAL_REQUIRED')

      // The hijack attempt did not kill the legitimate session.
      const ok = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` })
      expect(ok.status).toBe(200)
    } finally {
      await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` }, 'DELETE')
    }
  })

  test('unknown/revoked bearer on an established session → 401', async () => {
    const sid = await openSession(BOT_B)
    try {
      const res = await sessionRequest(sid, { Authorization: 'Bearer not-a-real-token' })
      expect(res.status).toBe(401)
      expect((await res.json()).code).toBe('IDENTITY_NOT_BOUND')
    } finally {
      await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` }, 'DELETE')
    }
  })

  test("another bot's VALID bearer on this session → 403 SESSION_OWNER_MISMATCH", async () => {
    const sid = await openSession(BOT_B)
    try {
      const res = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_A]}` })
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('SESSION_OWNER_MISMATCH')
    } finally {
      await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` }, 'DELETE')
    }
  })

  test('correct bearer: requests AND termination work; termination without bearer is refused', async () => {
    const sid = await openSession(BOT_B)

    const ok = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` })
    expect(ok.status).toBe(200)

    // DELETE without credential must NOT terminate the session.
    const badDelete = await sessionRequest(sid, {}, 'DELETE')
    expect(badDelete.status).toBe(401)
    const stillAlive = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` })
    expect(stillAlive.status).toBe(200)

    // DELETE with the owner's credential terminates; the id is then 404.
    const goodDelete = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` }, 'DELETE')
    expect([200, 204]).toContain(goodDelete.status)
    const afterDelete = await sessionRequest(sid, { Authorization: `Bearer ${TOKENS[BOT_B]}` })
    expect(afterDelete.status).toBe(404)
  })
})
