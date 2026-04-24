import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §4.3 exempt — three static checks (no LLM judgement). Each
// exempt condition must independently produce exit 0 with no stdout.
// Instruction: lead-ama PR-C §4.1 (msg id 4ca7298e).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures', 'stop-hook')

function runHook(payload: { transcript_path: string; session_id: string }, env: Record<string, string>) {
  return spawnSync('/bin/bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

describe('test_stop_hook_exempt — static exempt rules all pass without blocking', () => {
  let tmpDir: string
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-exempt-')) })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('§1.4 rule 1 — last user turn has no <channel source="agent-comms"> tag → exempt', () => {
    const r = runHook(
      { transcript_path: join(FIXTURES, 'exempt-no-tag.jsonl'), session_id: 'ex-1' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })

  test('§1.4 rule 2 — no prior assistant turn (session just started) → exempt', () => {
    const r = runHook(
      { transcript_path: join(FIXTURES, 'exempt-initial.jsonl'), session_id: 'ex-2' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })

  test('§1.4 rule 3 — prior assistant turn already invoked send/notify → pass', () => {
    // exempt-prior-send.jsonl has send in the first assistant turn and a
    // text-only assistant turn after the tool_result. This is the multi-
    // assistant-turn shape §1.4 rule 3 exempts.
    const r = runHook(
      { transcript_path: join(FIXTURES, 'exempt-prior-send.jsonl'), session_id: 'ex-3' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })
})
