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

  test('(case 6b) open claim → exit 2 + open_claim re-prompt JSON', async () => {
    await seedClaim()
    const r = runHook(`s-${randomUUID().slice(0, 8)}`)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('open per-row claim')
    expect(r.stdout).toContain('mcp__agent-comms__send')
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
    expect(r.stdout).toContain('mcp__agent-comms__next')
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    rmSync(tmp, { recursive: true, force: true })
  })

  test('(case 17) retry limit (3) reached → 4th attempt passes + bypass.log + audit_log row', async () => {
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
    expect(bypassContent).toContain(`claim_id=${claim.id}`)

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

  test('escalation dedupe — repeated post-limit calls only fire one audit_log row + one bypass line', async () => {
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
