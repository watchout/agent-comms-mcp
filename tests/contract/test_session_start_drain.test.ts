import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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

dbDescribe('test_session_start_drain — F-2 bounded read scope', () => {
  let client: Client
  const TEST_AGENT = `test-drain-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    resetAutoSkipPatternsCache()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    seedCounter = 0
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
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

  test('(case 10) pending=10 with limit=5, mix → drained=5, only matched skipped, unmatched stay pending', async () => {
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
