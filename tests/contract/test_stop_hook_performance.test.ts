import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Spec §2.3 / §4.7 performance — Stop hook fires on every assistant turn,
// so latency must stay under 100 ms p95 even when the transcript is huge.
// The hook only reads a tail chunk (default 64 KiB), so full-file size
// should not affect timings.
//
// The fixture is generated on-the-fly: ~10 MB of filler assistant turns
// followed by the real negative-text-only scenario so the hook still
// exercises the blocking path (exit 2 + additionalContext). That matches
// the worst-case latency: full jq summary + state writes + block emission.
// Instruction: lead-ama PR-C §4.1 / §2.3 (msg id 4ca7298e).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const HOOK = join(REPO_ROOT, 'hooks', 'aun-send-tool-enforcement.sh')
const BLOCK_CONTEXT = 'ERROR: Your previous assistant turn did not invoke mcp__aun__send or mcp__aun__notify. You received a message via <channel source="agent-comms">, you MUST reply through the tool — NOT via stdout, NOT via built-in SendMessage. Invoke mcp__aun__send (pass channel_id from the inbound tag) now. Legacy aliases mcp__agent_comms__send / mcp__agent_comms__notify and mcp__agent-comms__send / mcp__agent-comms__notify are accepted during migration.'

function generateLargeTranscript(path: string, targetBytes: number): void {
  // Filler turns that the hook will skip over (truncated first line on tail
  // read). We still produce valid JSONL so that any tail alignment still
  // parses. The final two lines replicate the negative-text-only scenario
  // — a channel-tag user turn followed by a text-only assistant turn.
  const filler: string[] = []
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'filler '.repeat(32) }],
    },
  })
  let total = 0
  const real = [
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: '<channel source="agent-comms" channel_id="pilot-test-perf" message_id="perf-msg">slow transcript test</channel>',
        }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'no reply, just text' }],
      },
    }),
  ]
  const realBytes = real.reduce((n, l) => n + l.length + 1, 0)
  while (total < targetBytes - realBytes) {
    filler.push(line)
    total += line.length + 1
  }
  writeFileSync(path, filler.concat(real).join('\n') + '\n')
}

function runHookTimed(payload: { transcript_path: string; session_id: string }, env: Record<string, string>): number {
  const start = performance.now()
  const r = spawnSync('/bin/bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  const ms = performance.now() - start
  // Sanity: with a negative scenario in the tail we must still block, and
  // with a >64 KiB tail the hook must not error out on the truncated first
  // line. If status drifts to 0 we've lost the tail parse.
  expect(r.status).toBe(2)
  expect(JSON.parse(r.stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: BLOCK_CONTEXT },
  })
  return ms
}

describe('stop-hook summary transport preserves text and exemption semantics', () => {
  let tmpDir: string
  let env: Record<string, string>

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-summary-'))
    env = { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') }
  })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test.each([
    ['multiline', '\nfalse\t0\t0\n<channel source="agent-comms">日本語 \\ "quoted"</channel>\n\n', 2],
    ['no-tag', '\ntrue\t1\t1\nordinary user text\n', 0],
    ['empty', '', 0],
  ])('%s user text remains data, not summary fields', (sid, text, expectedStatus) => {
    const transcript = join(tmpDir, `${sid}.jsonl`)
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text }] }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'no tool invocation' }] }),
    ].join('\n') + '\n')
    const payload = JSON.stringify({ transcript_path: transcript, session_id: sid })
    const invoke = () => spawnSync('/bin/bash', [HOOK], {
      input: payload, encoding: 'utf-8', env: { ...process.env, ...env },
    })
    const result = invoke()
    expect(result.status).toBe(expectedStatus)
    if (expectedStatus === 0) {
      expect(result.stdout).toBe('')
      expect(readFileSync(join(env.AUN_STATE_DIR, `${sid}.count`), 'utf-8')).toBe('0')
    } else {
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(BLOCK_CONTEXT)
      expect(invoke().status).toBe(2)
      expect(invoke().status).toBe(2)
      expect(invoke().status).toBe(0)
      const excerpt = text.replace(/\n+$/, '').replace(/\n/g, ' ').slice(0, 200)
      expect(readFileSync(join(env.AUN_LOG_DIR, 'send-enforcement-bypass.log'), 'utf-8'))
        .toContain(`excerpt=${excerpt}\n`)
    }
  })
})

describe('test_stop_hook_performance — 10 MB transcript → p95 < 100 ms', () => {
  let tmpDir: string
  let transcript: string
  let env: Record<string, string>

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stop-hook-perf-'))
    transcript = join(tmpDir, 'large.jsonl')
    generateLargeTranscript(transcript, 10 * 1024 * 1024)
    // Verify fixture really is ~10 MB so we're not inadvertently testing
    // a small-file path.
    expect(statSync(transcript).size).toBeGreaterThanOrEqual(10 * 1024 * 1024 - 2048)
    env = { AUN_LOG_DIR: join(tmpDir, 'logs'), AUN_STATE_DIR: join(tmpDir, 'state') }
  })
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  test('p95 latency over 20 runs is under 100 ms', () => {
    const N = 20
    const durations: number[] = []
    for (let i = 0; i < N; i++) {
      // Fresh session_id per run so retry state doesn't accumulate and
      // short-circuit to exit 0 on the 4th+ invocation.
      durations.push(runHookTimed(
        { transcript_path: transcript, session_id: `perf-${i}` },
        env,
      ))
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(0.95 * N) - 1] ?? durations[durations.length - 1]
    // Tail-chunk + jq path should comfortably finish under 100 ms; we log
    // the measured timings so a PR reviewer can see the distribution.
    // eslint-disable-next-line no-console
    console.log(`[perf] durations ms: min=${durations[0].toFixed(1)} p50=${durations[Math.floor(N/2)].toFixed(1)} p95=${p95.toFixed(1)} max=${durations[durations.length-1].toFixed(1)}`)
    expect(p95).toBeLessThan(100)
  })
})
