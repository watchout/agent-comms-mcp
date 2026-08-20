import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-database'
import {
  N1_OBSERVATION_WINDOW_MS,
  N1_ONLINE_SEAT_QUERY_VERSION,
  N1_PROBE_MESSAGE_TYPE,
  N1_PROBE_PREFIX,
  listCanonicalOnlineSeats,
  runN1Measurement,
  type N1MeasurementReport,
} from '../../scripts/n1-slo/harness'
import { publishN1Report, renderN1ReportComment, sha256 } from '../../scripts/n1-slo/publisher'
import {
  N1_LAUNCH_AGENT_INTERVAL_SECONDS,
  buildN1LaunchAgentPlan,
  renderN1LaunchAgentPlist,
  validateN1LaunchAgentPlan,
} from '../../scripts/n1-slo/launchagent'
import { resolveExplicitDatabaseUrl } from '../../scripts/n1-slo/run'

const REPO_ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const SCRATCH_BASE_URL = process.env.AGENT_COM_TEST_DATABASE_URL
  ?? (process.env.GITHUB_ACTIONS === 'true'
    ? 'postgresql://postgres:postgres@localhost:5432/postgres'
    : 'postgresql:///postgres?host=/tmp')
const SOURCE_COMMIT = 'a'.repeat(40)
let scratch: PostgresTestDatabase
let db: Client

function scratchDatabaseName(): string {
  return `n1_slo_test_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

async function seedSeat(input: {
  agentId: string
  agentStatus?: string
  leaseStatus?: string
  expiresAt?: string
  purpose?: string
}): Promise<{ runtimeId: string; leaseId: string }> {
  const runtimeId = randomUUID()
  const leaseId = randomUUID()
  await db.query(
    `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status)
     VALUES ($1, $1, 'bot', 'codex', $2)`,
    [input.agentId, input.agentStatus ?? 'online'],
  )
  await db.query(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, endpoint_uri, status, last_seen_at)
     VALUES ($1, $2, 'codex', 'local_process', $3, 'running', now())`,
    [runtimeId, input.agentId, `http://127.0.0.1/${input.agentId}`],
  )
  await db.query(
    `INSERT INTO control_plane_leases
       (lease_id, lease_scope_type, lease_scope_id, lease_purpose,
        holder_agent_id, holder_runtime_instance_id, fencing_token, status, expires_at)
     VALUES ($1, 'runtime_instance', $2::uuid::text, $3, $4, $2::uuid, 1, $5, $6::timestamptz)`,
    [
      leaseId,
      runtimeId,
      input.purpose ?? 'worker',
      input.agentId,
      input.leaseStatus ?? 'active',
      input.expiresAt ?? '2099-01-01T00:00:00.000Z',
    ],
  )
  return { runtimeId, leaseId }
}

async function seedBusinessMessage(agentId: string): Promise<string> {
  const messageId = randomUUID()
  await db.query(
    `INSERT INTO agent_messages (id, author_id, content, message_type)
     VALUES ($1, 'business-author', 'real business work', 'instruction')`,
    [messageId],
  )
  await db.query(
    `INSERT INTO message_queue (agent_id, message_id, payload, status, priority)
     VALUES ($1, $2, '{"business":true}', 'pending', 100)`,
    [agentId, messageId],
  )
  return messageId
}

beforeAll(async () => {
  // The maintenance URL is explicit (local socket, test override, or the
  // repository's fixed Actions service) and cannot inherit ambient DATABASE_URL.
  scratch = createPostgresTestDatabase(scratchDatabaseName(), {
    AGENT_COM_TEST_DATABASE_URL: SCRATCH_BASE_URL,
    DATABASE_URL: undefined,
  })
  const migrated = Bun.spawnSync([process.execPath, 'db/migrate.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: scratch.databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (migrated.exitCode !== 0) {
    throw new Error(`scratch migration failed: ${migrated.stderr.toString()}`)
  }
  db = new Client({ connectionString: scratch.databaseUrl })
  await db.connect()
})

beforeEach(async () => {
  await db.query(`TRUNCATE TABLE
    outbound_queue, message_queue, agent_messages, control_plane_leases,
    agent_runtime_instances, agents RESTART IDENTITY CASCADE`)
})

afterAll(async () => {
  await db?.end()
  scratch?.drop()
})

describe('N1 communication SLO harness (isolated PostgreSQL scratch DB)', () => {
  test('canonical online-seat query requires agents.status=online and a valid runtime endpoint worker lease', async () => {
    const live = await seedSeat({ agentId: 'live-seat' })
    await seedSeat({ agentId: 'offline-seat', agentStatus: 'offline' })
    await seedSeat({ agentId: 'expired-seat', expiresAt: '2000-01-01T00:00:00.000Z' })
    await seedSeat({ agentId: 'released-seat', leaseStatus: 'released' })
    await seedSeat({ agentId: 'presence-only-seat', purpose: 'presence' })

    const seats = await listCanonicalOnlineSeats(db, new Date('2026-08-20T00:00:00.000Z'))

    expect(seats).toEqual([{
      agent_id: 'live-seat',
      runtime_instance_id: live.runtimeId,
      lease_id: live.leaseId,
      lease_expires_at: '2099-01-01T00:00:00.000Z',
    }])
  })

  test('self-issued no-op probe completes send→claim→close without consuming business work or creating outbound effects', async () => {
    await seedSeat({ agentId: 'probe-seat' })
    const businessMessageId = await seedBusinessMessage('probe-seat')

    const report = await runN1Measurement(db, { sourceCommit: SOURCE_COMMIT })

    expect(report.verdict).toBe('PASS')
    expect(report.online_seat_query_version).toBe(N1_ONLINE_SEAT_QUERY_VERSION)
    expect(report.observation_window_ms).toBe(N1_OBSERVATION_WINDOW_MS)
    expect(report.summary).toMatchObject({ online_seat_count: 1, success_count: 1, failure_count: 0, success_rate: 1 })
    expect(report.effects).toEqual({
      internal_probe_rows_created: 1,
      terminal_done_rows: 1,
      residual_nonterminal_probe_rows: 0,
      outbound_queue_rows: 0,
      provider_effect_count: 0,
      discord_visible_send_count: 0,
    })

    const probe = (await db.query(
      `SELECT am.author_id, am.content, am.message_type, am.metadata,
              mq.agent_id, mq.status, mq.priority, mq.claimed_by, mq.claimed_at, mq.claim_expires_at
         FROM agent_messages am JOIN message_queue mq ON mq.message_id = am.id::text
        WHERE am.id::text = $1`,
      [report.results[0]!.message_id],
    )).rows[0]!
    expect(probe.author_id).toBe('probe-seat')
    expect(probe.agent_id).toBe('probe-seat')
    expect(probe.message_type).toBe(N1_PROBE_MESSAGE_TYPE)
    expect(probe.content.startsWith(`${N1_PROBE_PREFIX}:`)).toBe(true)
    expect(probe.status).toBe('done')
    expect(Number(probe.priority)).toBeLessThan(0)
    expect(probe.claimed_by).toBeNull()
    expect(probe.claimed_at).toBeNull()
    expect(probe.claim_expires_at).toBeNull()
    expect(probe.metadata.n1_slo.outcome).toBe('success')

    const business = (await db.query(
      `SELECT status, priority FROM message_queue WHERE message_id = $1`,
      [businessMessageId],
    )).rows[0]!
    expect(business).toMatchObject({ status: 'pending', priority: 100 })
  })

  test('an unclaimed probe records typed RETRY_EXHAUSTED and cleanup leaves zero nonterminal residue', async () => {
    await seedSeat({ agentId: 'silent-claim-seat' })
    const report = await runN1Measurement(db, {
      sourceCommit: SOURCE_COMMIT,
      observationWindowMs: 25,
      pollIntervalMs: 5,
      processor: async () => {},
    })

    expect(report.verdict).toBe('FAIL')
    expect(report.results[0]).toMatchObject({
      outcome: 'retry_exhausted',
      failure_type: 'RETRY_EXHAUSTED',
      failure_stage: 'claim',
      observation_window_ms: 25,
    })
    expect(report.effects.residual_nonterminal_probe_rows).toBe(0)
    expect(report.effects.terminal_done_rows).toBe(1)
    const row = (await db.query(
      `SELECT mq.status, mq.claimed_by, am.metadata
         FROM message_queue mq JOIN agent_messages am ON am.id::text = mq.message_id
        WHERE mq.message_id = $1`,
      [report.results[0]!.message_id],
    )).rows[0]!
    expect(row.status).toBe('done')
    expect(row.claimed_by).toBeNull()
    expect(row.metadata.n1_slo).toMatchObject({
      outcome: 'retry_exhausted',
      failure_type: 'RETRY_EXHAUSTED',
      failure_stage: 'claim',
    })
  })

  test('a claimed but unclosed probe records close-stage RETRY_EXHAUSTED and is terminally cleaned', async () => {
    await seedSeat({ agentId: 'silent-close-seat' })
    const report = await runN1Measurement(db, {
      sourceCommit: SOURCE_COMMIT,
      observationWindowMs: 25,
      pollIntervalMs: 5,
      processor: async ({ claim }) => { await claim() },
    })

    expect(report.results[0]).toMatchObject({
      outcome: 'retry_exhausted',
      failure_type: 'RETRY_EXHAUSTED',
      failure_stage: 'close',
    })
    expect(report.results[0]!.claimed_at).not.toBeNull()
    expect(report.effects).toMatchObject({ terminal_done_rows: 1, residual_nonterminal_probe_rows: 0, outbound_queue_rows: 0 })
  })

  test('machine publisher is pinned to issue #602, verifies returned body, and never calls a Discord/provider endpoint', async () => {
    await seedSeat({ agentId: 'publisher-seat' })
    const report = await runN1Measurement(db, { sourceCommit: SOURCE_COMMIT, runId: randomUUID() })
    const body = renderN1ReportComment(report)
    const calls: Array<{ url: string; method: string; body: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
      if (method === 'GET' && url.includes('?per_page=')) return new Response(JSON.stringify([]), { status: 200 })
      if (method === 'GET') return new Response(JSON.stringify({
        body,
        html_url: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-999',
      }), { status: 200 })
      return new Response(JSON.stringify({
        body,
        html_url: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-999',
        url: 'https://api.github.com/repos/watchout/agent-comms-mcp/issues/comments/999',
      }), { status: 201 })
    }) as typeof fetch

    const receipt = await publishN1Report(report, { token: 'fixture-token', fetchImpl })

    expect(receipt).toEqual({
      ok: true,
      comment_url: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-999',
      raw_body_sha256: sha256(body),
      idempotent_readback: false,
    })
    expect(calls).toHaveLength(3)
    expect(calls.filter(call => call.method === 'POST').every(call => call.url.includes('/repos/watchout/agent-comms-mcp/issues/602/comments'))).toBe(true)
    expect(calls.some(call => /discord|fleet-runtime/i.test(call.url))).toBe(false)
  })

  test('periodic LaunchAgent follows report-only pattern without embedding DB/provider/Discord secrets', () => {
    const plan = buildN1LaunchAgentPlan({
      repoRoot: '/opt/agent-comms-mcp',
      bunPath: '/opt/bun/bin/bun',
      databaseConfig: '/Users/test/.agent-comms/config.json',
      githubTokenFile: '/Users/test/.config/n1/github.token',
      launchAgentsDir: '/Users/test/Library/LaunchAgents',
      logDir: '/Users/test/.agent-comms/logs',
    })
    const plist = renderN1LaunchAgentPlist(plan)

    expect(validateN1LaunchAgentPlan(plan)).toEqual([])
    expect(plan.startIntervalSeconds).toBe(N1_LAUNCH_AGENT_INTERVAL_SECONDS)
    expect(plan.programArguments).toContain('--publish')
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).not.toContain('DATABASE_URL')
    expect(plist).not.toContain('DISCORD_TOKEN')
    expect(plist).not.toContain('FLEET_RUNTIME')
    expect(plist).not.toContain('fixture-token')
  })

  test('runtime database selection fails closed instead of reading ambient DATABASE_URL', () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql:///agent_comms'
    try {
      expect(() => resolveExplicitDatabaseUrl({})).toThrow('exactly one')
      expect(resolveExplicitDatabaseUrl({ databaseUrl: scratch.databaseUrl })).toBe(scratch.databaseUrl)
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = original
    }
  })

  test('zero eligible seats produces an explicit NO_DATA report with zero effects', async () => {
    const report: N1MeasurementReport = await runN1Measurement(db, { sourceCommit: SOURCE_COMMIT })
    expect(report.verdict).toBe('NO_DATA')
    expect(report.summary.online_seat_count).toBe(0)
    expect(report.effects).toMatchObject({
      internal_probe_rows_created: 0,
      terminal_done_rows: 0,
      residual_nonterminal_probe_rows: 0,
      outbound_queue_rows: 0,
      provider_effect_count: 0,
      discord_visible_send_count: 0,
    })
  })
})
