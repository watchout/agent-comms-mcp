#!/usr/bin/env bun
/**
 * Source-pin tests for `scripts/run-bot.sh` — preserved across the
 * UnixSignalBus removal (ADR-050). Originally lived in
 * `tests/message-bus.test.ts` alongside the UnixSignalBus behavioural
 * suite; relocated here so the legacy-bus tests can be deleted without
 * losing coverage on:
 *
 *   - lost-wake-up fix (PR #217 cycle 2): SIGUSR1 trap + flag-tracked
 *     wake, background sleep + wait, kill on early return.
 *   - end-to-end runner flow (spec §5.3): LLM_CMD invocation shape, jq
 *     extraction of next-payload fields, `agent-com send` invocation,
 *     and explicit `LLM_FAILED` fail path (v2.1.0; no implicit skip).
 *
 * These pins remain valid because run-bot.sh continues to install the
 * SIGUSR1 trap as a local wake-up hint (the de jure primary wake path
 * is wake-daemon tmux send-keys per ADR-050; the trap is harmless
 * defence-in-depth — if it disappears in a future refactor the runner
 * still works, but the original lost-wake-up failure mode is what these
 * pins guard against).
 */
import { describe, test, expect } from 'bun:test'

const fs = require('node:fs') as typeof import('node:fs')
const path = require('node:path') as typeof import('node:path')
const script = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'run-bot.sh'),
  'utf-8',
)

describe('spec §5.3 — run-bot.sh lost-wake-up fix (source pin)', () => {
  test('trap sets SIGNAL_RECEIVED=1 on SIGUSR1 (flag-tracked)', () => {
    expect(script).toContain(`trap 'SIGNAL_RECEIVED=1' USR1`)
  })

  test('loop body checks SIGNAL_RECEIVED before entering the sleep', () => {
    const signalGuardIdx = script.indexOf(`if [ "$SIGNAL_RECEIVED" = "1" ]`)
    const sleepIdx = script.indexOf(`sleep "$WAIT_SECONDS" &`)
    expect(signalGuardIdx).toBeGreaterThan(-1)
    expect(sleepIdx).toBeGreaterThan(signalGuardIdx)
  })

  test('uses background sleep + wait so SIGUSR1 can interrupt', () => {
    expect(script).toContain('sleep "$WAIT_SECONDS" &')
    expect(script).toContain('wait "$SLEEP_PID"')
  })

  test('kills the pending sleep if wait was interrupted by SIGUSR1', () => {
    expect(script).toContain('kill "$SLEEP_PID"')
  })
})

describe('spec §5.3 — run-bot.sh end-to-end flow (source pin)', () => {
  test('LLM_CMD env var defaults to `claude --print`', () => {
    expect(script).toContain('LLM_CMD="${LLM_CMD:-claude --print}"')
  })

  test('extracts content / reply_chain / message_id / from from the next JSON', () => {
    expect(script).toContain(`jq -r '.content // ""'`)
    expect(script).toContain(`jq -r '.reply_chain // "[]"'`)
    expect(script).toContain(`jq -r '.message_id // ""'`)
    expect(script).toContain(`jq -r '.from // ""'`)
  })

  test('pipes the context through $LLM_CMD (unquoted for multi-token commands)', () => {
    expect(script).toMatch(/echo -e "\$full_context"\s*\|\s*timeout "\$LLM_TIMEOUT_SECONDS"\s*\$LLM_CMD/)
  })

  test('calls `agent-com send` with --reply-to + --mentions when the LLM produced output', () => {
    expect(script).toContain(`cli/index.ts" send`)
    expect(script).toContain('--content "$response"')
    expect(script).toContain('--reply-to "$message_id"')
    expect(script).toContain('--mentions "$from"')
  })

  test('fails the row with LLM_FAILED when LLM exits non-zero or empty (v2.1.0 spec §5.3)', () => {
    expect(script).toMatch(/if \[ "\$llm_exit" -ne 0 \] \|\| \[ -z "\$response" \]/)
    expect(script).toContain('--reason LLM_FAILED')
    expect(script).toContain('LLM failed')
  })
})
