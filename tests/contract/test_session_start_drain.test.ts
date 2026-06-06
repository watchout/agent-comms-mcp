import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resetAutoSkipPatternsCache } from '../../config/auto-skip-patterns'

// Issue #278 (F) — SessionStart drain hook behavioral fixture.
//
// This file exercises the bun TS runner directly (not the shell
// wrapper) so we can assert on the post-drain DB state row by row.
// Cases mirror Issue #278 §4 extension:
//   case 10 — pending=10, limit=5, half noise → 5 drained, 3 skipped, 2 unmatched
//   case 12 — pending=0 → no-op
//   case 14 — runner only touches latest N; older tail untouched
//
// The runner is invoked as a child process so AGENT_ID / DATABASE_URL /
// AGENT_COMMS_DRAIN_LIMIT can be set per case without polluting the
// test process env.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const RUNNER = join(REPO_ROOT, 'hooks/session-start-drain.ts')
const MEMORY_READY_MIGRATION = join(REPO_ROOT, 'db/migrations/2026-06-06-runtime-memory-ready-evidence.up.sql')
let memoryReadyMigrationApplied = false

async function ensureMemoryReadySchema(client: Client): Promise<void> {
  if (memoryReadyMigrationApplied) return
  await client.query(readFileSync(MEMORY_READY_MIGRATION, 'utf-8'))
  memoryReadyMigrationApplied = true
}

async function cleanupMemoryReadyAgent(client: Client, agentId: string): Promise<void> {
  await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [agentId])
  await client.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id = $1`, [agentId])
  await client.query(`DELETE FROM agent_runtime_instances WHERE agent_id = $1`, [agentId])
  await client.query(`DELETE FROM agents WHERE agent_id = $1`, [agentId])
}

async function seedMemoryReadyAgent(client: Client, agentId: string, agentType = 'dev'): Promise<void> {
  await ensureMemoryReadySchema(client)
  const runtimeId = randomUUID()
  const port = 30_000 + Number.parseInt(runtimeId.slice(0, 4), 16) % 20_000
  const sessionName = `${agentId}-memory-ready-session`
  const checkoutPath = `/tmp/${agentId}-memory-ready`
  await client.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id = $1`, [agentId])
  await client.query(`DELETE FROM agent_runtime_instances WHERE agent_id = $1`, [agentId])
  await client.query(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, channel_port,
        metadata, profile_revision, profile_source, home_directory)
     VALUES ($1, $1, $2, 'mcp', 'idle', $3, $4::jsonb, 1, 'legacy', $5)
     ON CONFLICT (agent_id) DO UPDATE SET
       agent_type = EXCLUDED.agent_type,
       runtime = EXCLUDED.runtime,
       status = EXCLUDED.status,
       channel_port = EXCLUDED.channel_port,
       metadata = EXCLUDED.metadata,
       profile_revision = 1,
       profile_source = 'legacy',
       home_directory = EXCLUDED.home_directory`,
    [agentId, agentType, port, JSON.stringify({ tmux_session: sessionName }), checkoutPath],
  )
  await client.query(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, port,
        checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
     VALUES ($1, $2, 'mcp', 'local_process', $3, $4,
             $5, 'session-drain-test-head', 'running',
             '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z',
             '{"source":"session-start-drain-test"}'::jsonb)`,
    [runtimeId, agentId, sessionName, port, checkoutPath],
  )
  await client.query(
    `INSERT INTO runtime_memory_ready_evidence
       (agent_id, project, runtime_instance_id, profile_revision, profile_source,
        session_name, port, expected_agent_id, checkout_path, checkout_commit_sha,
        recovery_command, result_status, completed_at, evidence_path, evidence_log_id,
        valid_until, source, metadata)
     VALUES
       ($1, 'agent-comms-mcp', $2, 1, 'legacy',
        $3, $4, $1, $5, 'session-drain-test-head',
        'test:mcp__wasurezu__recover_context', 'ready', '2026-06-01T00:00:02.000Z',
        '/tmp/session-start-drain-memory-ready.json', 'session-start-drain-memory-ready',
        '2099-01-01T00:00:00.000Z', 'agent_memory_boot_recovery',
        '{"fixture":true}'::jsonb)`,
    [agentId, runtimeId, sessionName, port, checkoutPath],
  )
}

dbDescribe('test_session_start_drain — F-2 bounded read scope', () => {
  let client: Client
  const TEST_AGENT = `test-drain-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await ensureMemoryReadySchema(client)
    resetAutoSkipPatternsCache()
  })

  beforeEach(async () => {
    await cleanupMemoryReadyAgent(client, TEST_AGENT)
    await seedMemoryReadyAgent(client, TEST_AGENT)
    seedCounter = 0
  })

  afterAll(async () => {
    await cleanupMemoryReadyAgent(client, TEST_AGENT)
    await client.end()
  })

  function runDrainHook(limit: number | null = null): { stdout: string; stderr: string; status: number | null } {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      AGENT_ID: TEST_AGENT,
      DATABASE_URL: DATABASE_URL!,
    }
    if (limit !== null) env.AGENT_COMMS_DRAIN_LIMIT = String(limit)
    const r = spawnSync('bun', [RUNNER], { env, encoding: 'utf-8' })
    return { stdout: r.stdout, stderr: r.stderr, status: r.status }
  }

  let seedCounter = 0
  async function seed(content: string, messageType = 'chat', authorId = 'someone'): Promise<string> {
    const messageId = randomUUID()
    const payload = JSON.stringify({ author_id: authorId, content, message_type: messageType, source: 'agent-comms', ts: new Date().toISOString() })
    // Issue #278 §F drain orders rows by created_at DESC — bun test
    // can run multiple inserts in the same millisecond, so explicitly
    // age each seed by `seedCounter` ms backwards. Larger counter ⇒
    // older row, so seed-order doubles as age-order from oldest first.
    seedCounter++
    const ageOffsetMs = 10_000 - seedCounter
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES ($1, $2, $3, 'pending', 0, now() - make_interval(secs => $4 / 1000.0))`,
      [TEST_AGENT, messageId, payload, ageOffsetMs],
    )
    return messageId
  }

  async function statusOf(messageId: string): Promise<{ status: string; failed_reason: string | null }> {
    const r = await client.query<{ status: string; failed_reason: string | null }>(
      `SELECT status, failed_reason FROM message_queue WHERE message_id = $1`,
      [messageId],
    )
    return r.rows[0]
  }

  test('(case 12) pending=0 → no-op, drained=0', () => {
    const r = runDrainHook()
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('drained=0')
  })

  test('missing memory-ready evidence blocks session-start drain without touching pending rows', async () => {
    const messageId = await seed('actionable row waits for memory')
    await client.query(`DELETE FROM runtime_memory_ready_evidence WHERE agent_id=$1`, [TEST_AGENT])

    const r = runDrainHook()
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('memory_ready blocked reason=missing_evidence')
    expect(r.stderr).toContain('drained=0')
    expect((await statusOf(messageId)).status).toBe('pending')
  })

  test.skip('TODO #338 sub-PR 9 v0.9 schema (case 10) pending=10 with limit=5, mix → drained=5, only matched skipped, unmatched stay pending', async () => {
    // 10 pending rows, half are auto-skip-pattern noise. Only the
    // newest 5 are drained (ORDER BY created_at DESC LIMIT 5). Within
    // the drained slice, auto-skip-matching rows flip to skipped;
    // unmatched rows stay pending so the LLM turn picks them up.
    // Older 5 rows stay pending regardless (out of slice).
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      // Older 5 — alternate noise / chat
      ids.push(await seed(i % 2 === 0 ? '[hb 12:00] ...' : `older-${i}`))
    }
    for (let i = 0; i < 5; i++) {
      // Newer 5 — alternate noise / chat
      ids.push(await seed(i % 2 === 0 ? '⚠️ メンションがないため' : `newer-${i}`))
    }
    const r = runDrainHook(5)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('drained=5')
    // Older 5 untouched (LIMIT 5 + ORDER BY created_at DESC means
    // newest first; older tail is not in the drained slice).
    for (let i = 0; i < 5; i++) {
      expect((await statusOf(ids[i])).status).toBe('pending')
    }
    // Newer 5: ids[5+k] maps to the k-th iteration of the inner loop,
    // and the inner loop seeds noise on even k (0,2,4) / chat on odd k
    // (1,3). So ids[5], ids[7], ids[9] are noise → skipped and ids[6],
    // ids[8] are chat → pending.
    for (let outerIdx = 5; outerIdx < 10; outerIdx++) {
      const innerK = outerIdx - 5
      const row = await statusOf(ids[outerIdx])
      if (innerK % 2 === 0) {
        expect(row.status).toBe('skipped')
        expect(row.failed_reason).toMatch(/^AUTO_SKIP_PATTERN:/)
      } else {
        expect(row.status).toBe('pending')
      }
    }
  })

  test('(case 14) older rows beyond the limit window are NOT touched (mid-task fetch forbidden)', async () => {
    // Issue #278 §F-3 forbids context-bypass via mid-task auto-fetch.
    // The drain hook only ever touches the head of the queue (newest
    // N) so a long-running stale row in the middle stays exactly
    // where the operator left it.
    const oldNoise = await seed('⚠️ メンションがないため (very old)')
    // Push 6 newer rows so the limit=5 slice excludes the old one.
    const newer: string[] = []
    for (let i = 0; i < 6; i++) {
      newer.push(await seed(`fresh-${i}`))
    }
    const r = runDrainHook(5)
    expect(r.status).toBe(0)
    // The old noise row is beyond the LIMIT 5 ORDER BY created_at DESC
    // window; it must remain pending. (Without this guarantee, the
    // sweeper / TTL boundary would interact with the drain window
    // unpredictably.)
    expect((await statusOf(oldNoise)).status).toBe('pending')
  })

  test('AGENT_COMMS_DRAIN_LIMIT env override caps the drained slice', async () => {
    for (let i = 0; i < 3; i++) {
      await seed(`row-${i}`)
    }
    const r = runDrainHook(2)
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('drained=2')
  })
})

// Issue #278 (F-3) — role-differential drain scope.
//
// When neither the per-agent nor the global env override is set, the
// runner picks a default based on the agent's role:
//   - lead-bot (lead-* prefix or agent_type='lead'): large cap (100)
//   - dev / org / human (agent_type='dev' | 'org' | 'human'): N=5
//   - infra (agent_type='system' | 'infra'): 0 (drain disabled)
//   - unknown / missing row: spec default (5)
//
// Cases mirror Issue #278 §4 ext case 13 (lead vs dev differential).
dbDescribe('test_session_start_drain — F-3 role-differential scope', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await ensureMemoryReadySchema(client)
  })

  afterAll(async () => {
    await client.end()
  })

  // Helper — register a probe agent with a given agent_type, seed N
  // pending chat rows, run the drain runner without env overrides,
  // and return the runner stdout/stderr/status.
  async function setupAndRun(opts: { agentType: string; agentIdPrefix: string; seedCount: number }): Promise<{ agentId: string; result: { stdout: string; stderr: string; status: number | null } }> {
    const agentId = `${opts.agentIdPrefix}-${randomUUID().slice(0, 8)}`
    await seedMemoryReadyAgent(client, agentId, opts.agentType)
    let counter = 0
    for (let i = 0; i < opts.seedCount; i++) {
      counter++
      const ageMs = 60_000 - counter
      await client.query(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, now() - make_interval(secs => $4 / 1000.0))`,
        [agentId, randomUUID(), JSON.stringify({ author_id: 'someone', content: `r${i}`, message_type: 'chat' }), ageMs],
      )
    }

    const env = { ...process.env as Record<string, string>, AGENT_ID: agentId, DATABASE_URL: DATABASE_URL! }
    // Strip any inherited overrides so the role default is what the
    // runner falls back to.
    delete env.AGENT_COMMS_DRAIN_LIMIT
    for (const k of Object.keys(env)) {
      if (k.startsWith('AGENT_COMMS_DRAIN_LIMIT_')) delete env[k]
    }
    const r = spawnSync('bun', [RUNNER], { env, encoding: 'utf-8' })
    return { agentId, result: { stdout: r.stdout, stderr: r.stderr, status: r.status } }
  }

  async function cleanup(agentId: string): Promise<void> {
    await cleanupMemoryReadyAgent(client, agentId)
  }

  test('lead-bot (lead-* prefix) drains the full backlog (cap=100, plenty of headroom)', async () => {
    const { agentId, result } = await setupAndRun({ agentType: 'org', agentIdPrefix: 'lead-test', seedCount: 12 })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('drained=12')
    await cleanup(agentId)
  })

  test('dev-bot drains only the spec default N=5', async () => {
    const { agentId, result } = await setupAndRun({ agentType: 'dev', agentIdPrefix: 'dev-test', seedCount: 8 })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('drained=5')
    await cleanup(agentId)
  })

  test('org / C-suite bot drains only the spec default N=5', async () => {
    const { agentId, result } = await setupAndRun({ agentType: 'org', agentIdPrefix: 'cto-test', seedCount: 8 })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('drained=5')
    await cleanup(agentId)
  })

  test('infra (agent_type=system) drain is disabled (drained=0 even with backlog)', async () => {
    const { agentId, result } = await setupAndRun({ agentType: 'system', agentIdPrefix: 'infra-test', seedCount: 8 })
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('drained=0')
    await cleanup(agentId)
  })

  test('per-agent env override beats role default (lead-* with limit=2 → 2 drained)', async () => {
    const agentId = `lead-override-${randomUUID().slice(0, 8)}`
    await seedMemoryReadyAgent(client, agentId, 'org')
    let counter = 0
    for (let i = 0; i < 6; i++) {
      counter++
      await client.query(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, now() - make_interval(secs => $4))`,
        [agentId, randomUUID(), JSON.stringify({ author_id: 'someone', content: `r${i}`, message_type: 'chat' }), counter],
      )
    }
    const overrideKey = `AGENT_COMMS_DRAIN_LIMIT_${agentId.replace(/-/g, '_').toUpperCase()}`
    const env = { ...process.env as Record<string, string>, AGENT_ID: agentId, DATABASE_URL: DATABASE_URL!, [overrideKey]: '2' }
    const r = spawnSync('bun', [RUNNER], { env, encoding: 'utf-8' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('drained=2')
    await cleanupMemoryReadyAgent(client, agentId)
  })
})
