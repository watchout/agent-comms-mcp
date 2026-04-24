import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §4.2 negative:
//   (a) text-only assistant turn + channel tag user turn → exit 2 with
//       additionalContext matching §1.5 verbatim.
//   (b) built-in SendMessage tool_use only (no mcp__agent-comms__*) → exit 2,
//       additionalContext must state "NOT via built-in SendMessage".
//
// §1.5 additionalContext text is a merge gate — the test asserts the exact
// substring that the spec / instruction both quote, so any drift is caught.
// Instruction: lead-ama PR-C §4.1 (msg id 4ca7298e / 3ea997fe).

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

describe('test_stop_hook_negative — channel tag + no send/notify → block', () => {
  let tmpDir: string
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-neg-')) })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('text-only assistant turn after channel tag → exit 2 + §1.5 additionalContext verbatim', () => {
    const r = runHook(
      { transcript_path: join(FIXTURES, 'negative-text-only.jsonl'), session_id: 'neg-text' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(2)

    const parsed = JSON.parse(r.stdout ?? '')
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('Stop')

    const ctx = parsed.hookSpecificOutput?.additionalContext ?? ''
    // §1.5 key substrings — drift on any of these is a regression.
    expect(ctx).toContain('ERROR:')
    expect(ctx).toContain('mcp__agent-comms__send')
    expect(ctx).toContain('mcp__agent-comms__notify')
    expect(ctx).toContain('<channel source="agent-comms">')
    expect(ctx).toContain('NOT via stdout')
    expect(ctx).toContain('NOT via built-in SendMessage')
    expect(ctx).toContain('Invoke mcp__agent-comms__send')
  })

  test('built-in SendMessage only (no mcp__agent-comms__*) → exit 2 + NOT via built-in', () => {
    const r = runHook(
      { transcript_path: join(FIXTURES, 'negative-sendmessage.jsonl'), session_id: 'neg-sm' },
      { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') },
    )
    expect(r.status).toBe(2)

    const parsed = JSON.parse(r.stdout ?? '')
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? ''
    expect(ctx).toContain('NOT via built-in SendMessage')
  })
})
