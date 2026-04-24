import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §1.6 / §4.4 retry cap — when the LLM cannot recover from the
// additionalContext re-prompt, the hook must eventually pass so the session
// doesn't get stuck in a block loop. Default RETRY_LIMIT is 3: three
// consecutive blocks, the fourth invocation records a bypass audit entry
// and exits 0. The subsequent successful invocation (send called) must
// reset the counter so a later violation starts at 1 again.
// Instruction: lead-ama PR-C §4.1 (msg id 4ca7298e).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'stop-hook')
const NEGATIVE = join(FIXTURES, 'negative-text-only.jsonl')
const POSITIVE = join(FIXTURES, 'positive.jsonl')

function runHook(payload: { transcript_path: string; session_id: string }, env: Record<string, string>) {
  return spawnSync('/bin/bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

describe('test_stop_hook_retry — N consecutive blocks then bypass, reset on pass', () => {
  let tmpDir: string
  let logDir: string
  let stateDir: string
  let envBase: Record<string, string>

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-retry-'))
    logDir = join(tmpDir, 'logs')
    stateDir = join(tmpDir, 'state')
    envBase = { AUN_LOG_DIR: logDir, AUN_STATE_DIR: stateDir }
  })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('3 consecutive blocks → 4th invocation exits 0 with bypass log entry', () => {
    const sid = 'retry-4'
    const payload = { transcript_path: NEGATIVE, session_id: sid }

    const r1 = runHook(payload, envBase); expect(r1.status).toBe(2)
    const r2 = runHook(payload, envBase); expect(r2.status).toBe(2)
    const r3 = runHook(payload, envBase); expect(r3.status).toBe(2)
    const r4 = runHook(payload, envBase); expect(r4.status).toBe(0)

    const bypass = readFileSync(join(logDir, 'send-enforcement-bypass.log'), 'utf-8')
    // At least one bypass line scoped to this session. Line format:
    // "<iso-ts> | session_id=<sid> turn_count=N limit=M excerpt=..."
    const lines = bypass.split('\n').filter(l => l.includes(`session_id=${sid}`))
    expect(lines.length).toBeGreaterThanOrEqual(1)
    expect(lines[0]).toContain('turn_count=4')
    expect(lines[0]).toContain('limit=3')
  })

  test('a passing turn between blocks resets the counter (new block cycle starts at 1)', () => {
    const sid = 'retry-reset'
    const neg = { transcript_path: NEGATIVE, session_id: sid }
    const pos = { transcript_path: POSITIVE, session_id: sid }

    // 2 blocks, then a pass that should reset the state file, then another
    // block that must be exit 2 (would be exit 0 if state leaked across
    // the pass).
    expect(runHook(neg, envBase).status).toBe(2)
    expect(runHook(neg, envBase).status).toBe(2)
    expect(runHook(pos, envBase).status).toBe(0)
    expect(runHook(neg, envBase).status).toBe(2)
  })
})
