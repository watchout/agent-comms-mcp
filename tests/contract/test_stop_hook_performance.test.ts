import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
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
  return ms
}

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
