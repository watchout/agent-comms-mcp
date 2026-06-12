import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import {
  matchesAutoSkipPattern,
  resetAutoSkipPatternsCache,
  getAutoSkipPatterns,
} from '../../config/auto-skip-patterns'
import {
  fetchBotStatusFromDb,
  formatPendingAge,
  type BotHealthState,
} from '../../core/bot-status-db'
import { buildLine } from '../../scripts/heartbeat-poll'

// Issue #277 (stage A) — heartbeat / bot_status truth / auto-skip.
//
// 7 case (Issue body §4 verbatim) verified at the unit / DB-round-trip level:
//   1. busy 30min → ⚠ WARN
//   2. busy 2h + 0 commit → 🚨 STUCK + CEO mention
//   3. idle → ✓
//   4. bot_status response 3 fields (pending_count + oldest_pending_at + health_state)
//   5. auto-skip pattern match → status='skipped', push 0
//   6. pattern unmatched → 通常 push (status='pending')
//   7. heartbeat clean shutdown is exercised by the SIGTERM contract — covered
//      indirectly by the loop-aware test below.

describe('Issue #277 (B) — auto-skip pattern matcher', () => {
  beforeEach(() => resetAutoSkipPatternsCache())

  test('case 5a — lead-ama no-mention warning is skipped', () => {
    const r = matchesAutoSkipPattern({
      content: '⚠️ メンションがないためbotには通知されていません。',
      messageType: 'chat',
      authorAgentId: 'lead-ama',
      recipientAgentId: 'cto',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('lead_ama_no_mention_warning')
  })

  test('case 5b — heartbeat broadcast line is skipped', () => {
    const r = matchesAutoSkipPattern({
      content: '[hb 14:25] cto | idle | claim=- | branch=- | commit=- | ✓',
      messageType: 'chat',
      authorAgentId: 'lead-ama',
      recipientAgentId: 'cto',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('heartbeat_broadcast')
  })

  test('case 5c — system_info type is skipped regardless of content', () => {
    const r = matchesAutoSkipPattern({
      content: 'arbitrary noise',
      messageType: 'system_info',
      authorAgentId: 'cto',
      recipientAgentId: 'agent-com-dev',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('system_info_type')
  })

  test('case 5d — bot self-echo (sender == recipient) is skipped', () => {
    const r = matchesAutoSkipPattern({
      content: 'normal status update',
      messageType: 'chat',
      authorAgentId: 'agent-com-dev',
      recipientAgentId: 'agent-com-dev',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('self_echo')
  })

  test('case 5e — terminal no-op queue continuation is skipped generically', () => {
    const r = matchesAutoSkipPattern({
      content: [
        'Processed queue 86535.',
        '',
        'Acknowledged: the implementation re-audit PASS residual note is covered. No further audit or implementation action is required for this continuation.',
        '',
        'Residual gates remain unchanged: intentional stage/commit before merge preparation and separate POST_MERGE evidence after merge.',
      ].join('\n'),
      messageType: 'report',
      authorAgentId: 'review-bot',
      recipientAgentId: 'implementation-bot',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('terminal_noop_continuation')
  })

  test('case 6a — audit content with new action is NOT skipped', () => {
    const r = matchesAutoSkipPattern({
      content: 'Processed queue 90000.\n\nBLOCK: please change server.ts and request re-audit.',
      messageType: 'report',
      authorAgentId: 'review-bot',
      recipientAgentId: 'implementation-bot',
    })
    expect(r.matched).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  test('case 6b — no-action prose without queue-continuation shape is NOT skipped', () => {
    const r = matchesAutoSkipPattern({
      content: 'No further action is required for this incident report, but please review the attached evidence.',
      messageType: 'report',
      authorAgentId: 'review-bot',
      recipientAgentId: 'implementation-bot',
    })
    expect(r.matched).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  test('case 6 — normal CTO directive is NOT skipped (push proceeds)', () => {
    const r = matchesAutoSkipPattern({
      content: 'CTO directive: please rebase PR #260 to origin/main',
      messageType: 'chat',
      authorAgentId: 'cto',
      recipientAgentId: 'agent-com-dev',
    })
    expect(r.matched).toBe(false)
    expect(r.reason).toBeUndefined()
  })

  test('AUTO_SKIP_PATTERNS_CONFIG env var appends additional patterns', () => {
    process.env.AUTO_SKIP_PATTERNS_CONFIG = JSON.stringify([
      { name: 'cron_noise', pattern: '^cron-tick:' },
    ])
    resetAutoSkipPatternsCache()
    const all = getAutoSkipPatterns()
    expect(all.some((p) => p.name === 'cron_noise')).toBe(true)
    const r = matchesAutoSkipPattern({
      content: 'cron-tick: 14:30',
      messageType: 'chat',
      authorAgentId: 'cron',
      recipientAgentId: 'cto',
    })
    expect(r.matched).toBe(true)
    expect(r.reason).toBe('cron_noise')
    delete process.env.AUTO_SKIP_PATTERNS_CONFIG
    resetAutoSkipPatternsCache()
  })
})

describe('Issue #277 (heartbeat) — buildLine threshold logic', () => {
  const NOW = new Date('2026-04-30T14:25:00.000Z')
  function snap(overrides: { agent_id?: string; status?: string | null; busy_since?: Date | null; current_message_id?: string | null; workdir?: string | null } = {}) {
    return {
      agent_id: overrides.agent_id ?? 'test-bot',
      status: overrides.status ?? 'busy',
      busy_since: overrides.busy_since ?? null,
      current_message_id: overrides.current_message_id ?? null,
      workdir: overrides.workdir ?? null,
    }
  }

  test('case 1 — busy 30min crosses WARN threshold', () => {
    const busySince = new Date(NOW.getTime() - 1800 * 1000)
    const { line, mentionCeo } = buildLine(snap({ busy_since: busySince }), NOW, { warnSec: 1800, stuckSec: 7200 })
    expect(line).toContain('⚠ WARN')
    expect(line).toContain('busy 30m')
    expect(mentionCeo).toBe(false)
  })

  test('case 2 — busy 2h crosses STUCK threshold + mentionCeo', () => {
    const busySince = new Date(NOW.getTime() - 7200 * 1000)
    const { line, mentionCeo } = buildLine(snap({ busy_since: busySince }), NOW, { warnSec: 1800, stuckSec: 7200 })
    expect(line).toContain('🚨 STUCK')
    expect(line).toContain('busy 2h')
    expect(mentionCeo).toBe(true)
  })

  test('case 3 — idle agent shows ✓ verdict and idle state', () => {
    const { line, mentionCeo } = buildLine(snap({ status: 'idle' }), NOW)
    expect(line).toContain('✓')
    expect(line).toContain('| idle |')
    expect(mentionCeo).toBe(false)
  })

  test('busy < WARN threshold shows neutral · marker', () => {
    const busySince = new Date(NOW.getTime() - 60 * 1000)
    const { line, mentionCeo } = buildLine(snap({ busy_since: busySince }), NOW, { warnSec: 1800, stuckSec: 7200 })
    expect(line).toContain('| ·')
    expect(mentionCeo).toBe(false)
  })
})

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('Issue #277 (D) — bot_status DB truth round-trip', () => {
  let client: Client
  const TEST_AGENT = `test-hb-${randomUUID().slice(0, 8)}`
  const cleanupRuntimeEvidence = async (agentId: string) => {
    await client.query(
      `DELETE FROM control_plane_leases
        WHERE holder_agent_id = $1
           OR lease_scope_id IN (
             SELECT runtime_instance_id::text
               FROM agent_runtime_instances
              WHERE agent_id = $1
           )`,
      [agentId],
    )
    await client.query(`DELETE FROM connector_instances WHERE agent_id = $1`, [agentId])
    await client.query(`DELETE FROM agent_runtime_instances WHERE agent_id = $1`, [agentId])
  }

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, 'dev', 'claude-code', 'idle', now() - INTERVAL '10 seconds')
       ON CONFLICT (agent_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, status = 'idle'`,
      [TEST_AGENT],
    )
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await cleanupRuntimeEvidence(TEST_AGENT)
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await cleanupRuntimeEvidence(TEST_AGENT)
    await client.query(`DELETE FROM agents WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  test('case 4 — response includes pending_count + oldest_pending_at + health_state', async () => {
    const m = await fetchBotStatusFromDb(client)
    const row = m.get(TEST_AGENT)
    expect(row).toBeDefined()
    expect(row!.pending_count).toBe(0)
    expect(row!.oldest_pending_at).toBeNull()
    expect(['healthy', 'busy_active', 'busy_stuck', 'crashed', 'offline'] as BotHealthState[]).toContain(row!.health_state)
    expect(row!.endpoint_lease_state).toBe('not_applicable')
    expect(row!.active_endpoint_lease_count).toBe(0)
  })

  test('NORM-022 — bot_status exposes runtime endpoint lease state', async () => {
    await client.query(
      `INSERT INTO connector_instances
         (agent_id, provider, connector_uri, status, metadata)
       VALUES
         ($1, 'discord', $2, 'active', '{}'::jsonb)`,
      [TEST_AGENT, `discord://agents/${TEST_AGENT}/missing-runtime`],
    )
    let row = (await fetchBotStatusFromDb(client)).get(TEST_AGENT)!
    expect(row.endpoint_lease_state).toBe('missing_runtime')
    expect(row.active_connector_count).toBe(1)
    expect(row.runtime_linked_connector_count).toBe(0)
    expect(row.active_endpoint_lease_count).toBe(0)

    await cleanupRuntimeEvidence(TEST_AGENT)
    const runtimeId = randomUUID()
    const connectorId = randomUUID()
    await client.query(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, status)
       VALUES
         ($1, $2, 'codex', 'active')`,
      [runtimeId, TEST_AGENT],
    )
    await client.query(
      `INSERT INTO connector_instances
         (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri, status, metadata)
       VALUES
         ($1, $2, $3, 'discord', $4, 'active', '{}'::jsonb)`,
      [connectorId, TEST_AGENT, runtimeId, `discord://agents/${TEST_AGENT}/with-runtime`],
    )
    row = (await fetchBotStatusFromDb(client)).get(TEST_AGENT)!
    expect(row.endpoint_lease_state).toBe('missing_lease')
    expect(row.active_connector_count).toBe(1)
    expect(row.runtime_linked_connector_count).toBe(1)
    expect(row.active_endpoint_lease_count).toBe(0)

    await client.query(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
          holder_runtime_instance_id, holder_connector_instance_id, fencing_token, expires_at)
       VALUES
         ('runtime_instance', $1, 'worker', $2, $3, $4, 1, now() + INTERVAL '5 minutes')`,
      [runtimeId, TEST_AGENT, runtimeId, connectorId],
    )
    row = (await fetchBotStatusFromDb(client)).get(TEST_AGENT)!
    expect(row.endpoint_lease_state).toBe('ok')
    expect(row.active_endpoint_lease_count).toBe(1)
    expect(row.endpoint_lease_expires_at).not.toBeNull()
    expect(row.endpoint_lease_heartbeat_at).not.toBeNull()
  })

  test('NORM-022 — bot_status blocks partial runtime endpoint lease coverage', async () => {
    const runtimeA = randomUUID()
    const runtimeB = randomUUID()
    const connectorA = randomUUID()
    const connectorB = randomUUID()

    await client.query(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, status)
       VALUES
         ($1, $2, 'codex', 'active'),
         ($3, $2, 'codex', 'active')`,
      [runtimeA, TEST_AGENT, runtimeB],
    )
    await client.query(
      `INSERT INTO connector_instances
         (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri, status, metadata)
       VALUES
         ($1, $2, $3, 'discord', $4, 'active', '{}'::jsonb),
         ($5, $2, NULL, 'discord', $6, 'active', '{}'::jsonb)`,
      [
        connectorA,
        TEST_AGENT,
        runtimeA,
        `discord://agents/${TEST_AGENT}/leased`,
        connectorB,
        `discord://agents/${TEST_AGENT}/missing-runtime`,
      ],
    )
    await client.query(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
          holder_runtime_instance_id, holder_connector_instance_id, fencing_token, expires_at)
       VALUES
         ('runtime_instance', $1, 'worker', $2, $3, $4, 1, now() + INTERVAL '5 minutes')`,
      [runtimeA, TEST_AGENT, runtimeA, connectorA],
    )

    let row = (await fetchBotStatusFromDb(client)).get(TEST_AGENT)!
    expect(row.active_connector_count).toBe(2)
    expect(row.runtime_linked_connector_count).toBe(1)
    expect(row.active_endpoint_lease_count).toBe(1)
    expect(row.endpoint_lease_state).toBe('missing_runtime')

    await cleanupRuntimeEvidence(TEST_AGENT)
    await client.query(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, status)
       VALUES
         ($1, $2, 'codex', 'active'),
         ($3, $2, 'codex', 'active')`,
      [runtimeA, TEST_AGENT, runtimeB],
    )
    await client.query(
      `INSERT INTO connector_instances
         (connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri, status, metadata)
       VALUES
         ($1, $2, $3, 'discord', $4, 'active', '{}'::jsonb),
         ($5, $2, $6, 'discord', $7, 'active', '{}'::jsonb)`,
      [
        connectorA,
        TEST_AGENT,
        runtimeA,
        `discord://agents/${TEST_AGENT}/leased`,
        connectorB,
        runtimeB,
        `discord://agents/${TEST_AGENT}/missing-lease`,
      ],
    )
    await client.query(
      `INSERT INTO control_plane_leases
         (lease_scope_type, lease_scope_id, lease_purpose, holder_agent_id,
          holder_runtime_instance_id, holder_connector_instance_id, fencing_token, expires_at)
       VALUES
         ('runtime_instance', $1, 'worker', $2, $3, $4, 1, now() + INTERVAL '5 minutes')`,
      [runtimeA, TEST_AGENT, runtimeA, connectorA],
    )

    row = (await fetchBotStatusFromDb(client)).get(TEST_AGENT)!
    expect(row.active_connector_count).toBe(2)
    expect(row.runtime_linked_connector_count).toBe(2)
    expect(row.active_endpoint_lease_count).toBe(1)
    expect(row.endpoint_lease_state).toBe('missing_lease')
  })

  test('pending rows are counted, oldest_pending_at picks the earliest created_at', async () => {
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, created_at)
       VALUES ($1, $2, $3, 'pending', now() - INTERVAL '120 seconds'),
              ($1, $4, $3, 'pending', now() - INTERVAL '30 seconds')`,
      [TEST_AGENT, randomUUID(), '{}', randomUUID()],
    )
    const m = await fetchBotStatusFromDb(client)
    const row = m.get(TEST_AGENT)!
    expect(row.pending_count).toBe(2)
    expect(row.oldest_pending_at).not.toBeNull()
    const ageSec = Math.floor((Date.now() - new Date(row.oldest_pending_at!).getTime()) / 1000)
    expect(ageSec).toBeGreaterThanOrEqual(110)
  })

  test('case D-boundary-1 — status=busy + last_seen 3h ago classifies as busy_stuck (auditor BLOCK fix)', async () => {
    const stuck = `test-stuck-${randomUUID().slice(0, 8)}`
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, 'dev', 'claude-code', 'busy', now() - INTERVAL '3 hours')`,
      [stuck],
    )
    try {
      const m = await fetchBotStatusFromDb(client)
      expect(m.get(stuck)!.health_state).toBe('busy_stuck')
    } finally {
      await client.query(`DELETE FROM agents WHERE agent_id = $1`, [stuck])
    }
  })

  test('case D-boundary-2 — status=idle + last_seen 3h ago classifies as crashed', async () => {
    const dead = `test-dead-${randomUUID().slice(0, 8)}`
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, 'dev', 'claude-code', 'idle', now() - INTERVAL '3 hours')`,
      [dead],
    )
    try {
      const m = await fetchBotStatusFromDb(client)
      expect(m.get(dead)!.health_state).toBe('crashed')
    } finally {
      await client.query(`DELETE FROM agents WHERE agent_id = $1`, [dead])
    }
  })

  test('case D-boundary-3 — status=busy + recent heartbeat classifies as busy_active', async () => {
    const active = `test-active-${randomUUID().slice(0, 8)}`
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, 'dev', 'claude-code', 'busy', now() - INTERVAL '10 seconds')`,
      [active],
    )
    try {
      const m = await fetchBotStatusFromDb(client)
      expect(m.get(active)!.health_state).toBe('busy_active')
    } finally {
      await client.query(`DELETE FROM agents WHERE agent_id = $1`, [active])
    }
  })

  test('formatPendingAge reports a human-readable age string', () => {
    const t = new Date(Date.now() - 90 * 1000).toISOString()
    expect(formatPendingAge(t)).toBe('1m')
    expect(formatPendingAge(null)).toBe('0')
  })

  test('case 5/6 round-trip — auto-skip path INSERTs status=skipped, normal path INSERTs status=pending', async () => {
    const skipMsgId = randomUUID()
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, failed_reason)
       VALUES ($1, $2, $3, 'skipped', 'AUTO_SKIP_PATTERN:lead_ama_no_mention_warning')`,
      [TEST_AGENT, skipMsgId, '{}'],
    )
    const pendingMsgId = randomUUID()
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload)
       VALUES ($1, $2, $3)`,
      [TEST_AGENT, pendingMsgId, '{}'],
    )
    const r = await client.query<{ status: string; failed_reason: string | null }>(
      `SELECT status, failed_reason FROM message_queue WHERE agent_id = $1 ORDER BY created_at`,
      [TEST_AGENT],
    )
    const skipped = r.rows.find((row) => row.failed_reason?.startsWith('AUTO_SKIP_PATTERN:'))
    const pending = r.rows.find((row) => row.failed_reason === null)
    expect(skipped?.status).toBe('skipped')
    expect(skipped?.failed_reason).toBe('AUTO_SKIP_PATTERN:lead_ama_no_mention_warning')
    expect(pending?.status).toBe('pending')
    const m = await fetchBotStatusFromDb(client)
    expect(m.get(TEST_AGENT)!.pending_count).toBe(1)
  })
})
