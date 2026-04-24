import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §4.1 positive: assistant turn contains `mcp__agent-comms__send` (or
// notify) tool_use → exit 0, no stdout.
// Spec file: specs/draft/2026-04-25-send-tool-enforcement-hook-spec-v7.md
// Instruction: lead-ama PR-C §4.1 merge gate (msg id 4ca7298e).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'stop-hook', 'positive.jsonl')

function runHook(payload: { transcript_path: string; session_id: string }, env: Record<string, string>) {
  return spawnSync('/bin/bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

describe('test_stop_hook_positive — send/notify tool_use present → pass', () => {
  let tmpDir: string
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-pos-')) })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('assistant tool_use mcp__agent-comms__send → exit 0, stdout empty', () => {
    const r = runHook(
      { transcript_path: FIXTURE, session_id: 'pos-send' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })

  test('assistant tool_use mcp__agent-comms__notify → exit 0', () => {
    const r = runHook(
      {
        transcript_path: join(REPO_ROOT, 'tests', 'fixtures', 'stop-hook', 'positive-notify.jsonl'),
        session_id: 'pos-notify',
      },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(0)
    expect((r.stdout ?? '').trim()).toBe('')
  })
})
