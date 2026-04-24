import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §2.2 fail-safe — the hook must never stop the bot. Any error
// encountered in its own execution (missing transcript, malformed JSONL,
// empty stdin, missing payload fields, jq absent) produces exit 0 with an
// audit entry in ~/.aun/logs/send-enforcement-errors.log.
// Instruction: lead-ama PR-C §4.1 / §3.3 / §1.8 (msg id 4ca7298e).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')

function runHook(payloadRaw: string, env: Record<string, string>) {
  return spawnSync('/bin/bash', [HOOK], {
    input: payloadRaw,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
}

describe('test_stop_hook_failsafe — any hook error → exit 0 + errors.log entry', () => {
  let tmpDir: string
  let logDir: string
  let stateDir: string
  let env: Record<string, string>

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-fs-'))
    logDir = join(tmpDir, 'logs')
    stateDir = join(tmpDir, 'state')
    env = { AUN_LOG_DIR: logDir, AUN_STATE_DIR: stateDir }
  })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('missing transcript_path file → exit 0 + errors log entry', () => {
    const r = runHook(
      JSON.stringify({ transcript_path: '/nonexistent/transcript.jsonl', session_id: 'fs-missing' }),
      env,
    )
    expect(r.status).toBe(0)
    const logPath = join(logDir, 'send-enforcement-errors.log')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf-8')).toContain('not a file')
  })

  test('malformed JSONL transcript → exit 0 + errors log entry', () => {
    const broken = join(tmpDir, 'broken.jsonl')
    writeFileSync(broken, 'this is not json\nalso not json\n')
    const r = runHook(
      JSON.stringify({ transcript_path: broken, session_id: 'fs-broken' }),
      env,
    )
    expect(r.status).toBe(0)
    expect(readFileSync(join(logDir, 'send-enforcement-errors.log'), 'utf-8')).toContain('jq summary failed')
  })

  test('empty stdin payload → exit 0 + errors log entry', () => {
    const r = runHook('', env)
    expect(r.status).toBe(0)
    expect(readFileSync(join(logDir, 'send-enforcement-errors.log'), 'utf-8')).toContain('empty stdin payload')
  })

  test('payload without transcript_path field → exit 0 + errors log entry', () => {
    const r = runHook(JSON.stringify({ session_id: 'fs-nopath' }), env)
    expect(r.status).toBe(0)
    expect(readFileSync(join(logDir, 'send-enforcement-errors.log'), 'utf-8')).toContain('missing transcript_path')
  })
})
