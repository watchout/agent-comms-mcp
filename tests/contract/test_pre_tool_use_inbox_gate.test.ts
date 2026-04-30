import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'

// Issue #278 cycle 3 (CEO directive 3, action 3) — PreToolUse inbox gate.
//
// Two cases mirror the dispatch must-fix list:
//   - gate fires: pending row + non-allow-list tool → exit 2 + re-prompt JSON
//                 mentioning the inbox state.
//   - drain unblocks: same agent, pending=0 → exit 0, empty stdout.
//
// The wrapper is invoked as a child process so each case sees the live
// runner + DB query path, not just a unit-tested predicate.

const DATABASE_URL = process.env.DATABASE_URL
const dbDescribe = DATABASE_URL ? describe : describe.skip

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const WRAPPER = join(REPO_ROOT, 'hooks/aun-pre-tool-use-inbox-gate.sh')

dbDescribe('test_pre_tool_use_inbox_gate — Issue #278 cycle 3', () => {
  let client: Client
  const TEST_AGENT = `test-gate-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
  })

  beforeEach(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
  })

  afterAll(async () => {
    await client.query(`DELETE FROM message_queue WHERE agent_id = $1`, [TEST_AGENT])
    await client.end()
  })

  function runGate(toolName: string): { stdout: string; status: number | null } {
    const env = {
      ...process.env as Record<string, string>,
      AGENT_ID: TEST_AGENT,
      DATABASE_URL: DATABASE_URL!,
    }
    const r = spawnSync('bash', [WRAPPER], {
      env,
      encoding: 'utf-8',
      input: JSON.stringify({ tool_name: toolName, tool_input: {} }),
    })
    return { stdout: r.stdout, status: r.status }
  }

  async function seedPending(): Promise<void> {
    await client.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status)
       VALUES ($1, $2, $3, 'pending')`,
      [TEST_AGENT, randomUUID(), JSON.stringify({ author_id: 'x', content: 'msg', message_type: 'chat' })],
    )
  }

  test('(gate fires) pending row present + non-allow-list tool → exit 2 + INBOX_GATE re-prompt', async () => {
    await seedPending()
    const r = runGate('Bash')
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('INBOX_GATE')
    expect(r.stdout).toContain('mcp__agent-comms__next')
    expect(r.stdout).toContain('1 unread')
  })

  test('(drain unblocks) pending=0 + non-allow-list tool → exit 0, empty stdout', async () => {
    // No seed → pending=0
    const r = runGate('Bash')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  test('(allow-list) inbox-management tools are NEVER gated, even with a pending row', async () => {
    await seedPending()
    for (const tool of [
      'mcp__agent-comms__next',
      'mcp__agent-comms__send',
      'mcp__agent-comms__notify',
      'mcp__agent-comms__skip',
      'mcp__agent-comms__fail',
      'mcp__agent-comms__reclaim',
    ]) {
      const r = runGate(tool)
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })
})
