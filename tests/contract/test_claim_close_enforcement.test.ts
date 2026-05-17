import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

// Issue #278 (§C + §G-3) — Stop hook v8 claim-close enforcement.
//
// case 6 — claim 残存 → exit 2 + re-prompt; claim close → exit 0.
// case 17 (G-3) — retry-limit reached → audit_log row + bypass log,
//                 escalation outbound enqueued. Re-fire on the same
//                 (agent_id, session_id) deduplicates.
//
// The runner is invoked as a child process with isolated AUN_STATE_DIR /
// AUN_LOG_DIR so each test owns its retry counter and bypass log.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const WRAPPER = join(REPO_ROOT, 'hooks/aun-claim-close-enforcement.sh')

dbDescribe('test_claim_close_enforcement — Stop hook v8 + G-3 escalation', () => {
  let client: Client
  let tmp: string
  const TEST_AGENT = `test-stop-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aun-claim-close-'))
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(`DELETE FROM audit_log WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  function runHook(sessionId: string): { stdout: string; stderr: string; status: number | null } {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      AGENT_ID: TEST_AGENT,
      DATABASE_URL: DATABASE_URL!,
      AUN_STATE_DIR: join(tmp, 'state'),
      AUN_LOG_DIR: join(tmp, 'logs'),
      AUN_STOP_HOOK_RETRY_LIMIT: '3',
    }
    const r = spawnSync('bash', [WRAPPER], {
      env,
      encoding: 'utf-8',
      input: JSON.stringify({ transcript_path: '/tmp/none', session_id: sessionId }),
    })
    return { stdout: r.stdout, stderr: r.stderr, status: r.status }
  }

  async function seedClaim(): Promise<{ id: number }> {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    const r = await client.query<{ id: number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES ($1, $2, $3, 'read', $1, now(), now() + interval '30 seconds')
       RETURNING id`,
      [TEST_AGENT, randomUUID(), JSON.stringify({ author_id: 'x', content: 'test', message_type: 'chat' })],
    )
    return { id: r.rows[0].id }
  }

  test('(case 6a) no claim, no pending → pass (exit 0)', async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    const r = runHook(`s-${randomUUID().slice(0, 8)}`)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    rmSync(tmp, { recursive: true, force: true })
  })

  test.skip('TODO #338 sub-PR 9 v0.9 schema (case 6b) open claim → exit 2 + open_claim re-prompt JSON', async () => {
    await seedClaim()
    const r = runHook(`s-${randomUUID().slice(0, 8)}`)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('open per-row claim')
    expect(r.stdout).toContain('mcp__aun__send')
    expect(r.stdout).toContain('mcp__agent_comms__*')
    expect(r.stdout).toContain('mcp__agent-comms__*')
    rmSync(tmp, { recursive: true, force: true })
  })

  test('(case 6c) pending only (no claim) → exit 2 + pending re-prompt JSON', async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status)
       VALUES ($1, $2, $3, 'pending')`,
      [TEST_AGENT, randomUUID(), JSON.stringify({ author_id: 'x', content: 'p', message_type: 'chat' })],
    )
    const r = runHook(`s-${randomUUID().slice(0, 8)}`)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('pending message_queue')
    expect(r.stdout).toContain('mcp__aun__next')
    expect(r.stdout).toContain('mcp__agent_comms__next')
    expect(r.stdout).toContain('mcp__agent-comms__next')
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    rmSync(tmp, { recursive: true, force: true })
  })

  test.skip('TODO #338 sub-PR 9 v0.9 schema (case 17) retry limit (3) reached → 4th attempt passes + bypass.log + audit_log row', async () => {
    const claim = await seedClaim()
    const session = `s-${randomUUID().slice(0, 8)}`

    // Attempts 1..3 must block.
    for (let i = 1; i <= 3; i++) {
      const r = runHook(session)
      expect(r.status).toBe(2)
    }
    // Attempt 4 must pass (escalation path).
    const r4 = runHook(session)
    expect(r4.status).toBe(0)

    // Bypass log line written.
    const bypassLog = join(tmp, 'logs/claim-close-bypass.log')
    expect(existsSync(bypassLog)).toBe(true)
    const bypassContent = readFileSync(bypassLog, 'utf-8')
    expect(bypassContent).toContain(`agent=${TEST_AGENT}`)
    expect(bypassContent).toContain(`claim_ids=[${claim.id}]`)

    // audit_log row exists for this (agent, session) — escalation evidence.
    const audit = await client.query(
      `SELECT detail FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2`,
      [TEST_AGENT, session],
    )
    expect(audit.rows.length).toBe(1)

    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(`DELETE FROM audit_log WHERE agent_id = $1 AND detail->>'session_id' = $2`, [TEST_AGENT, session])
    rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  test.skip('TODO #338 sub-PR 9 v0.9 schema (cycle 2) simultaneous multi-claim set — adding a new claim mid-session changes claim_key + resets retry counter', async () => {
    // Issue #278 cycle 2 (auditor BLOCK 2 verbatim): the dedup key is
    // a SHA-256 hash over the SET of open claim ids, not the latest
    // single claim. Holding {A} and then expanding to {A,B} must
    // produce a different claim_key — the new set deserves its own
    // retry budget.
    const session = `s-${randomUUID().slice(0, 8)}`

    // Seed claim A and accumulate 2 blocks (no escalation yet).
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    const a = await client.query<{ id: number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES ($1, $2, $3, 'read', $1, now(), now() + interval '30 seconds')
       RETURNING id`,
      [TEST_AGENT, randomUUID(), JSON.stringify({ author_id: 'x', content: 'A', message_type: 'chat' })],
    )
    const claimA = a.rows[0].id
    runHook(session)
    runHook(session)

    // Now ALSO seed claim B — the open-claim set becomes {A,B}.
    const b = await client.query<{ id: number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, claim_expires_at)
       VALUES ($1, $2, $3, 'read', $1, now(), now() + interval '30 seconds')
       RETURNING id`,
      [TEST_AGENT, randomUUID(), JSON.stringify({ author_id: 'x', content: 'B', message_type: 'chat' })],
    )
    const claimB = b.rows[0].id

    // First Stop on the {A,B} set must NOT immediately escalate —
    // it's a fresh claim_key (different SHA-256 over the new set),
    // so its counter starts at 0.
    expect(runHook(session).status).toBe(2)
    runHook(session)
    runHook(session)
    runHook(session) // 4th block on the {A,B} set → escalation.

    const audit = await client.query<{ open_claim_ids: string[]; claim_key: string }>(
      `SELECT detail->'open_claim_ids' AS open_claim_ids,
              detail->>'claim_key' AS claim_key
         FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2`,
      [TEST_AGENT, session],
    )
    // Exactly one escalation row for this session, and its
    // open_claim_ids reflects the FULL set, not just one claim.
    expect(audit.rows.length).toBe(1)
    const ids = audit.rows[0].open_claim_ids
    expect(ids).toContain(String(claimA))
    expect(ids).toContain(String(claimB))
    expect(audit.rows[0].claim_key).toMatch(/^open=[0-9a-f]{16}$/)

    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(`DELETE FROM audit_log WHERE agent_id = $1 AND detail->>'session_id' = $2`, [TEST_AGENT, session])
    rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  test('(cycle 2) basename is a SHA-256 hex prefix — collision-safe path key', async () => {
    // Pre-cycle-2 path was `safeBaseName(agent)__safeBaseName(session)__safeBaseName(ckey)`
    // which let crafted session_ids match concatenations from a
    // different (agent, session) tuple. Cycle 2 hashes the triple
    // with SHA-256 and uses the 32-hex prefix as the basename, so
    // basename collision is cryptographically infeasible AND the
    // raw inputs never appear in the filename.
    await seedClaim()
    const session = 'collide__test__id'
    runHook(session)
    const fs = require('node:fs')
    const names = fs.readdirSync(join(tmp, 'state'))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      // No raw inputs leak into the basename.
      expect(name).not.toContain(session)
      expect(name).not.toContain(TEST_AGENT)
      // 32-hex prefix + extension shape.
      expect(name).toMatch(/^[0-9a-f]{32}\.(count|escalated)$/)
    }

    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    rmSync(tmp, { recursive: true, force: true })
  })

  test.skip('TODO #338 sub-PR 9 v0.9 schema (cycle 1 BLOCK 2) escalation key is (agent_id, session_id, claim_id-set) — new claim resets retry budget', async () => {
    // Issue #278 cycle 1 (auditor BLOCK 2): a fresh claim within the
    // same Claude session must be eligible for its own retry counter
    // and its own escalation. The legacy session_id-only key would
    // either bypass the new claim's escalation or accumulate retries
    // across unrelated claims; the (agent_id, session_id, claim_key)
    // key isolates them.
    const session = `s-${randomUUID().slice(0, 8)}`

    // First claim — block 3 times, then escalate.
    const claim1 = await seedClaim()
    for (let i = 0; i < 3; i++) runHook(session)
    runHook(session) // 4th: escalates claim1.
    let audit = await client.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2`,
      [TEST_AGENT, session],
    )
    expect(audit.rows[0].n).toBe(1)

    // Close claim1, open claim2 in the SAME session.
    await client.query(
      `UPDATE message_queue SET status = 'replied', replied_at = now() WHERE id = $1`,
      [claim1.id],
    )
    const claim2 = await seedClaim()

    // First Stop with claim2 must NOT trigger immediate escalation —
    // its (agent, session, claim_key) counter starts at 0.
    const r1 = runHook(session)
    expect(r1.status).toBe(2)

    // claim2 needs its own 3 blocks before the 4th passes.
    runHook(session)
    runHook(session)
    runHook(session) // 4th block-cycle on claim2 → exit 0 + escalation.

    audit = await client.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2`,
      [TEST_AGENT, session],
    )
    expect(audit.rows[0].n).toBe(2)

    // Cycle 2: the per-claim key is a SHA-256 hash over the open claim
    // id-set; a single-claim set still hashes (it's not the literal id).
    // We pin both audit rows have a distinct, well-formed key.
    const detail = await client.query<{ claim_key: string | null }>(
      `SELECT detail->>'claim_key' AS claim_key FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2
        ORDER BY created_at`,
      [TEST_AGENT, session],
    )
    expect(detail.rows[0].claim_key).toMatch(/^open=[0-9a-f]{16}$/)
    expect(detail.rows[1].claim_key).toMatch(/^open=[0-9a-f]{16}$/)
    expect(detail.rows[0].claim_key).not.toBe(detail.rows[1].claim_key)

    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(`DELETE FROM audit_log WHERE agent_id = $1 AND detail->>'session_id' = $2`, [TEST_AGENT, session])
    rmSync(tmp, { recursive: true, force: true })
  }, 30_000)

  test.skip('TODO #338 sub-PR 9 v0.9 schema — escalation dedupe — repeated post-limit calls only fire one audit_log row + one bypass line', async () => {
    await seedClaim()
    const session = `s-${randomUUID().slice(0, 8)}`
    for (let i = 1; i <= 3; i++) runHook(session)
    runHook(session)  // 4th: escalates
    runHook(session)  // 5th: still over limit, must NOT re-escalate
    runHook(session)  // 6th: same

    const audit = await client.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE event_type = 'stop_hook.escalation' AND agent_id = $1
          AND detail->>'session_id' = $2`,
      [TEST_AGENT, session],
    )
    expect(audit.rows[0].n).toBe(1)

    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.query(`DELETE FROM audit_log WHERE agent_id = $1 AND detail->>'session_id' = $2`, [TEST_AGENT, session])
    rmSync(tmp, { recursive: true, force: true })
  }, 30_000)
})
