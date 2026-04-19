#!/usr/bin/env bun
/**
 * Phase C v2.1.0 PR 2/3 — scripts/run-bot.sh §5.3-§5.4 安定動作 source-pin.
 *
 * Shell behaviour is hard to assert without booting a real bot + real queue
 * (each test would need a fresh PG DB, a seeded message_queue row, and a
 * pretend LLM). Instead these tests pin the *contract* in the script's
 * source text. When the 10 scope items below disappear or are renamed, the
 * offending test is the regression signal — even before post-merge dev smoke.
 *
 * Scope items (CTO msg 1495567020803096770):
 *   (1) signal coalescing (drain loop)
 *   (2) graceful shutdown (SIGTERM/SIGINT, SHUTDOWN=1, consume-前 check)
 *   (3) LLM 失敗 → 明示 fail LLM_FAILED
 *   (4) send retry + 上限 fail (2/4/8s, max 3, SEND_FAILED_AFTER_N_RETRIES)
 *   (5) bot-to-bot loop detection (reply_chain self-count, LOOP_DETECTED)
 *   (6) LLM timeout wrap (LLM_TIMEOUT_SECONDS default 120)
 *   (7) heartbeat background fork + EXIT kill
 *   (8) consumer 排他 (PID kill -0 alive check)
 *   (9) AGENT_ID validation (^[a-z0-9][a-z0-9_-]{0,63}$)
 *  (10) LLM prompt template (CORE_RULES + USER_RULES)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'run-bot.sh'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// (1) signal coalescing — drain loop consumes until waiting=0 before sleeping
// ─────────────────────────────────────────────────────────────────────────────
describe('(1) signal coalescing — drain inner loop', () => {
  test('main loop contains an inner while that breaks on waiting=0', () => {
    // The outer loop runs `wait` on SIGUSR1; the inner loop runs `next` until
    // the queue is drained. Nesting matters — a flat loop re-enters the sleep
    // between every message and re-introduces the "1 signal = 1 message" bug.
    expect(SCRIPT).toMatch(/while true; do[\s\S]*?while true; do[\s\S]*?if \[ "\$\{waiting:-0\}" = "0" \]; then[\s\S]*?break/)
  })
  test('drain loop calls `next` directly (no sleep between consumes)', () => {
    // A stray `sleep` inside the drain would defeat the coalescing gain.
    const drainMatch = SCRIPT.match(/while true; do[\s\S]*?\n\s*done\n\s*# ── end drain loop/)
    expect(drainMatch).toBeTruthy()
    // Inner drain body should not contain a long `sleep "$WAIT_SECONDS"` call
    // — the wait-fallback lives OUTSIDE the drain.
    expect(drainMatch?.[0]).not.toContain('sleep "$WAIT_SECONDS"')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) graceful shutdown — SHUTDOWN=1 flag checked BEFORE consuming a new row
// ─────────────────────────────────────────────────────────────────────────────
describe('(2) graceful shutdown — SIGTERM/SIGINT → SHUTDOWN=1, consume-前 check', () => {
  test('trap sets SHUTDOWN=1 on SIGTERM/SIGINT', () => {
    expect(SCRIPT).toMatch(/trap 'SHUTDOWN=1' TERM INT/)
  })
  test('outer loop checks SHUTDOWN before entering the drain', () => {
    expect(SCRIPT).toMatch(/if \[ "\$SHUTDOWN" = "1" \]; then[\s\S]{0,200}?exit 0/)
  })
  test('drain loop checks SHUTDOWN before popping each new message', () => {
    // The shutdown check must happen BEFORE `next` so we never pop a row we
    // won't process. Pin both the check and its location relative to `next`.
    const shutdownIdx = SCRIPT.indexOf(`if [ "$SHUTDOWN" = "1" ]; then
      echo "[run-bot] shutdown during drain`)
    const nextIdx = SCRIPT.indexOf('bun "$PROJECT_DIR/cli/index.ts" next')
    expect(shutdownIdx).toBeGreaterThan(-1)
    expect(nextIdx).toBeGreaterThan(shutdownIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (3) LLM 失敗 → agent-com fail --reason LLM_FAILED (暗黙 skip 廃止)
// ─────────────────────────────────────────────────────────────────────────────
describe('(3) LLM 失敗 → 明示 fail LLM_FAILED', () => {
  test('captures LLM exit via `|| llm_exit=$?`', () => {
    // Using `response=$(...) || llm_exit=$?` is how we capture the pipeline
    // exit code without tripping `set -e` when the LLM fails / times out.
    expect(SCRIPT).toMatch(/response=\$\(.*?\)\s+\|\|\s+llm_exit=\$\?/)
  })
  test('non-zero exit OR empty response triggers `agent-com fail --reason LLM_FAILED`', () => {
    expect(SCRIPT).toMatch(/if \[ "\$llm_exit" -ne 0 \] \|\| \[ -z "\$response" \]/)
    // The fail CLI call MUST reference both the in-flight message_id and the
    // reason literal, and the loop should `continue` afterwards so we don't
    // also enter the send branch for the same iteration.
    expect(SCRIPT).toMatch(/cli\/index\.ts" fail[\s\S]*?--reason LLM_FAILED/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (4) send retry + 上限 fail — 2/4/8s backoff, max 3, SEND_FAILED_AFTER_N_RETRIES
// ─────────────────────────────────────────────────────────────────────────────
describe('(4) send retry backoff + 上限 fail', () => {
  test('MAX_SEND_RETRIES=3 pinned', () => {
    expect(SCRIPT).toMatch(/MAX_SEND_RETRIES=3/)
  })
  test('retry loop iterates over attempts 1 2 3', () => {
    expect(SCRIPT).toMatch(/for attempt in 1 2 3; do/)
  })
  test('backoff delays are 2 / 4 / 8 seconds', () => {
    expect(SCRIPT).toMatch(/1\) sleep 2 ;;/)
    expect(SCRIPT).toMatch(/2\) sleep 4 ;;/)
    expect(SCRIPT).toMatch(/3\) sleep 8 ;;/)
  })
  test('retries exhausted → fail SEND_FAILED_AFTER_N_RETRIES', () => {
    expect(SCRIPT).toMatch(/if \[ "\$send_ok" != "1" \]/)
    expect(SCRIPT).toMatch(/--reason SEND_FAILED_AFTER_N_RETRIES/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (5) bot-to-bot loop detection — jq self count vs MAX_SELF_IN_CHAIN
// ─────────────────────────────────────────────────────────────────────────────
describe('(5) bot-to-bot loop detection', () => {
  test('MAX_SELF_IN_CHAIN env with default 3', () => {
    expect(SCRIPT).toMatch(/MAX_SELF_IN_CHAIN="\$\{MAX_SELF_IN_CHAIN:-3\}"/)
  })
  test('self-count uses jq on reply_chain with --arg a "$AGENT_ID"', () => {
    expect(SCRIPT).toMatch(/jq --arg a "\$AGENT_ID"/)
    expect(SCRIPT).toMatch(/\.reply_chain\[\]\?\s*\|\s*select\(\.from == \$a\)/)
  })
  test('threshold check fails with LOOP_DETECTED before the LLM call', () => {
    // LOOP_DETECTED must fire BEFORE the LLM invocation so we don't pay
    // compute on a doomed loop. Pin the relative ordering.
    const loopCheckIdx = SCRIPT.indexOf('LOOP_DETECTED (self=')
    const llmIdx = SCRIPT.indexOf('timeout "$LLM_TIMEOUT_SECONDS"')
    expect(loopCheckIdx).toBeGreaterThan(-1)
    expect(llmIdx).toBeGreaterThan(loopCheckIdx)
    expect(SCRIPT).toMatch(/--reason LOOP_DETECTED/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (6) LLM timeout — `timeout "$LLM_TIMEOUT_SECONDS" $LLM_CMD`
// ─────────────────────────────────────────────────────────────────────────────
describe('(6) LLM timeout wrap', () => {
  test('LLM_TIMEOUT_SECONDS default 120', () => {
    expect(SCRIPT).toMatch(/LLM_TIMEOUT_SECONDS="\$\{LLM_TIMEOUT_SECONDS:-120\}"/)
  })
  test('LLM invocation is wrapped in `timeout "$LLM_TIMEOUT_SECONDS"`', () => {
    expect(SCRIPT).toMatch(/\|\s*timeout "\$LLM_TIMEOUT_SECONDS"\s*\$LLM_CMD/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (7) heartbeat — background fork + EXIT kill
// ─────────────────────────────────────────────────────────────────────────────
describe('(7) heartbeat background fork', () => {
  test('subshell runs `agent-com heartbeat` every 30s in the background', () => {
    // The subshell loop must run in background (`&`) so the main loop isn't
    // blocked by `wait`. We also sleep 30 between calls.
    expect(SCRIPT).toMatch(/\(\s*\n\s*while true; do[\s\S]*?cli\/index\.ts" heartbeat[\s\S]*?sleep 30[\s\S]*?done\s*\n\s*\)\s*&/)
  })
  test('HEARTBEAT_PID captured and killed in EXIT cleanup', () => {
    expect(SCRIPT).toContain('HEARTBEAT_PID=$!')
    // cleanup() wrapper must kill HEARTBEAT_PID so a crashed run-bot.sh
    // doesn't leak the heartbeat child.
    expect(SCRIPT).toMatch(/cleanup\(\)[\s\S]*?kill "\$HEARTBEAT_PID"/)
    expect(SCRIPT).toMatch(/trap cleanup EXIT/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (8) consumer 排他 — PID alive check via kill -0
// ─────────────────────────────────────────────────────────────────────────────
describe('(8) consumer 排他 (PID alive check)', () => {
  test('startup reads existing PID and probes with `kill -0`', () => {
    expect(SCRIPT).toMatch(/existing_pid=\$\(cat "\$PID_FILE"/)
    expect(SCRIPT).toMatch(/kill -0 "\$existing_pid"/)
  })
  test('live PID rejects the new runner with exit 1', () => {
    expect(SCRIPT).toMatch(/another run-bot\.sh is running[\s\S]*?exit 1/)
  })
  test('stale PID file is overwritten silently', () => {
    expect(SCRIPT).toMatch(/stale PID file/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (9) AGENT_ID validation — ^[a-z0-9][a-z0-9_-]{0,63}$
// ─────────────────────────────────────────────────────────────────────────────
describe('(9) AGENT_ID validation', () => {
  test('regex `^[a-z0-9][a-z0-9_-]{0,63}$` is enforced at startup', () => {
    expect(SCRIPT).toMatch(/if ! \[\[ "\$AGENT_ID" =~ \^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$ \]\]/)
  })
  test('invalid AGENT_ID exits 1 with a specific error', () => {
    expect(SCRIPT).toMatch(/invalid AGENT_ID[\s\S]*?exit 1/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (10) LLM prompt template — CORE_RULES + USER_RULES prefix
// ─────────────────────────────────────────────────────────────────────────────
describe('(10) LLM prompt template (CORE_RULES + USER_RULES)', () => {
  test('CORE_RULES defines mention / 1900 char / no AI disclaimer invariants', () => {
    // Verbatim substrings of the CORE_RULES literal — if any is dropped, the
    // system prompt silently loses a mandatory invariant.
    expect(SCRIPT).toContain('CORE_RULES')
    expect(SCRIPT).toContain('元送信者 agent_id')
    expect(SCRIPT).toContain('1900 文字以下')
    expect(SCRIPT).toContain('AI disclaimer 禁止')
  })
  test('USER_RULES reads from AGENT_COM_SYSTEM_PROMPT env', () => {
    expect(SCRIPT).toMatch(/USER_RULES="\$\{AGENT_COM_SYSTEM_PROMPT:-\}"/)
  })
  test('full_context prepends CORE_RULES before inbound context', () => {
    expect(SCRIPT).toContain('full_context="${CORE_RULES}"')
    // Inbound context (From / Reply chain / Message) is appended afterwards.
    expect(SCRIPT).toMatch(/full_context="\$\{full_context\}[\s\S]{0,80}From: \$\{from\}/)
  })
})
