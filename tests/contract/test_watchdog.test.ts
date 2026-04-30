import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { findCrashedAgents, isRateLimited, recordRestart, rateLimit } from '../../bin/aun-watchdog'

// Issue #278 (§E + §G-1) — watchdog daemon behavioral fixtures.
//
// case 7 (positive): a stale heartbeat (last_seen_at older than the
//                   threshold) is detected.
// case 7b: a fresh heartbeat is NOT detected.
// case 7c: status='offline' bots are excluded (operator already
//          acknowledged the offline state).
// case 7d: rate-limit suppresses spam restarts after the per-hour cap.
//
// The end-to-end tmux send-keys path is not exercised here (the test
// host has no bot tmux sessions); we cover the predicate + the
// rate-limit logic directly via the exported helpers.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

dbDescribe('test_watchdog — Issue #278 §E + §G-1 detection + rate limit', () => {
  let client: Client
  const TEST_PREFIX = `test-watchdog-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
    rateLimit.history.clear()
  })

  afterAll(async () => {
    await client.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${TEST_PREFIX}%`])
    await client.end()
  })

  async function seedAgent(opts: { id: string; status: string; lastSeenSecondsAgo: number | null; agentType?: string }): Promise<void> {
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, last_seen_at)
       VALUES ($1, $1, $2, 'mcp', $3,
               CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(secs => $4) END)
       ON CONFLICT (agent_id) DO UPDATE SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at, agent_type = EXCLUDED.agent_type`,
      [opts.id, opts.agentType ?? 'dev', opts.status, opts.lastSeenSecondsAgo],
    )
  }

  test('(case 7) stale heartbeat (last_seen 6 min ago) → flagged crashed', async () => {
    const agentId = `${TEST_PREFIX}-stale`
    await seedAgent({ id: agentId, status: 'busy', lastSeenSecondsAgo: 360 })
    const crashed = await findCrashedAgents(client)
    expect(crashed.some(a => a.agentId === agentId)).toBe(true)
  })

  test('(case 7b) fresh heartbeat (last_seen 30 s ago) → NOT flagged', async () => {
    const agentId = `${TEST_PREFIX}-fresh`
    await seedAgent({ id: agentId, status: 'idle', lastSeenSecondsAgo: 30 })
    const crashed = await findCrashedAgents(client)
    expect(crashed.some(a => a.agentId === agentId)).toBe(false)
  })

  test('(case 7c) status=offline → NOT flagged even when last_seen is stale', async () => {
    const agentId = `${TEST_PREFIX}-offline`
    await seedAgent({ id: agentId, status: 'offline', lastSeenSecondsAgo: 600 })
    const crashed = await findCrashedAgents(client)
    expect(crashed.some(a => a.agentId === agentId)).toBe(false)
  })

  test('agent_type=system (infra bots) is excluded', async () => {
    const agentId = `${TEST_PREFIX}-system`
    await seedAgent({ id: agentId, status: 'busy', lastSeenSecondsAgo: 600, agentType: 'system' })
    const crashed = await findCrashedAgents(client)
    expect(crashed.some(a => a.agentId === agentId)).toBe(false)
  })

  test('(case 7d) rate-limit suppresses restarts after the per-hour cap', () => {
    const agentId = `${TEST_PREFIX}-rate`
    // Default cap is 6/hour. Push 6 fresh recordRestart calls.
    for (let i = 0; i < 6; i++) recordRestart(agentId)
    expect(isRateLimited(agentId)).toBe(true)
    // A different agent stays free.
    expect(isRateLimited(`${agentId}-other`)).toBe(false)
  })

  test('rate-limit window slides — old entries (>1h) drop off', () => {
    const agentId = `${TEST_PREFIX}-window`
    const twoHoursAgo = Date.now() - 7200 * 1000
    rateLimit.history.set(agentId, [twoHoursAgo, twoHoursAgo, twoHoursAgo])
    expect(isRateLimited(agentId)).toBe(false)
    // The check must have purged the stale entries.
    expect(rateLimit.history.get(agentId)?.length ?? 0).toBe(0)
  })
})
