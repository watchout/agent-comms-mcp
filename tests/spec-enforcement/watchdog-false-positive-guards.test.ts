#!/usr/bin/env bun
/**
 * Spec-enforcement tests for scripts/watchdog.sh false-positive guards
 * (CEO directive 2026-04-09 02:21 JST, Option D).
 *
 * Background:
 *   scripts/watchdog.sh is a 5-minute cron-driven health check that restarts
 *   dead bot tmux sessions. It was disabled by CEO on 2026-04-07 because two
 *   classes of false positive caused a "5-minute restart loop":
 *
 *     (F1) Check 2 (crash pattern detection) grep-matched trigger words like
 *          "killed" / "fatal" / "panic" / "out of memory" anywhere in the
 *          30-line pane scrollback. Normal Claude conversations and CTO debug
 *          commands naturally contain these words, so the word stays pinned in
 *          scrollback and every cron tick re-triggers a restart.
 *
 *     (F2) Check 3b (port liveness) fires when the WEBHOOK_PORT is not LISTEN-
 *          ing, but Claude takes ~5-10 seconds to bind the port at startup. If
 *          watchdog runs during a restart (or post-compaction), the port check
 *          fires and triggers ANOTHER restart — which puts the session back
 *          into the startup window, repeating the loop indefinitely.
 *
 *   CEO approved Option D (combine fixes):
 *     - Comment out Check 2 entirely.
 *     - Add a 60-second grace period to Check 3b using a `.grace` file
 *       (epoch timestamp) written by restart_session. During the grace
 *       window, port liveness check is skipped entirely.
 *
 * These tests are source-level regression guards. They read the shell script
 * and assert the guards are present, so anyone who re-introduces the bug via
 * a stale-main merge or a well-intentioned "fix" will break CI.
 *
 * See also:
 *   - tests/spec-enforcement/anti-regression-pr98.test.ts (the pattern
 *     template this file follows)
 *   - tech-lead/.claude/memory/feedback_spec_as_tests_not_adrs.md
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const WATCHDOG_SOURCE = readFileSync(
  join(REPO_ROOT, 'scripts/watchdog.sh'),
  'utf-8'
)

describe('watchdog Check 2 — crash pattern detection is DISABLED', () => {
  // REGRESSION CLASS: Check 2 word-level grep caused 5-minute restart loops.
  // Trigger words (killed/fatal/panic) persist in pane scrollback from normal
  // Claude conversations and CTO debug commands, re-triggering restart every
  // cron tick. CEO directive 2026-04-09 02:21 JST.
  test('Check 2 comment block indicates it is disabled', () => {
    expect(WATCHDOG_SOURCE).toMatch(/Check 2.*(?:DISABLED|false positives)/i)
  })

  test('Check 2 grep call is not an executable shell statement', () => {
    const lines = WATCHDOG_SOURCE.split('\n')
    for (const line of lines) {
      if (
        line.includes('grep -qiE') &&
        line.includes('panic|fatal')
      ) {
        expect(line.trimStart().startsWith('#')).toBe(true)
      }
    }
  })

  test('Check 2 restart_session call referring to "crash detected" is commented out', () => {
    const lines = WATCHDOG_SOURCE.split('\n')
    for (const line of lines) {
      if (
        line.includes('restart_session') &&
        line.includes('crash detected')
      ) {
        expect(line.trimStart().startsWith('#')).toBe(true)
      }
    }
  })
})

describe('watchdog Check 3b — port liveness has a 60s grace period', () => {
  // REGRESSION CLASS: Check 3b fires when port is not LISTENing, but Claude
  // startup takes ~5-10s to bind the port. Without a grace period, any
  // restart causes the next cron tick to re-kill the still-starting session.
  // 40+ restart loop observed for agent-com-dev on 2026-04-09.
  test('Check 3b block references the grace period', () => {
    const idx = WATCHDOG_SOURCE.indexOf('Check 3b')
    expect(idx).toBeGreaterThan(0)
    const block = WATCHDOG_SOURCE.slice(idx, idx + 2000)
    expect(block).toMatch(/grace.period/i)
  })

  test('Check 3b uses a .grace file with epoch timestamp for grace tracking', () => {
    const idx = WATCHDOG_SOURCE.indexOf('Check 3b')
    const block = WATCHDOG_SOURCE.slice(idx, idx + 2000)
    // Must reference .grace file
    expect(block).toMatch(/\.grace/)
    // Must read the grace file content (epoch timestamp)
    expect(block).toMatch(/cat.*GRACE_FILE|GRACE_FILE/)
  })

  test('Check 3b skips port check when within 60s grace window', () => {
    const idx = WATCHDOG_SOURCE.indexOf('Check 3b')
    const block = WATCHDOG_SOURCE.slice(idx, idx + 2000)
    // Must compare age against 60 seconds
    expect(block).toMatch(/-lt\s+60/)
    // Must skip (continue) during grace period
    expect(block).toMatch(/continue/)
  })

  test('restart_session writes a .grace file', () => {
    // The restart_session function must write a grace file so Check 3b
    // knows to skip port checks for the next 60 seconds.
    const idx = WATCHDOG_SOURCE.indexOf('restart_session()')
    expect(idx).toBeGreaterThan(0)
    const block = WATCHDOG_SOURCE.slice(idx, idx + 1500)
    expect(block).toMatch(/\.grace/)
    expect(block).toMatch(/date \+%s/)
  })
})

describe('watchdog Check 1 / 3 / 4 — the still-active checks must remain', () => {
  // The fixes only touch Check 2 and Check 3b. The other checks (session
  // existence, CMD flag verification, shell-prompt detection) must still
  // run, otherwise the watchdog loses its ability to catch genuine deaths.
  test('Check 1 (tmux session exists) is still executable', () => {
    const lines = WATCHDOG_SOURCE.split('\n')
    const hit = lines.find(
      (l) =>
        l.includes('tmux has-session') &&
        !l.trimStart().startsWith('#')
    )
    expect(hit).toBeDefined()
  })

  test('Check 3 (channel plugin flag in CMD) is still executable', () => {
    const lines = WATCHDOG_SOURCE.split('\n')
    const hit = lines.find(
      (l) =>
        l.includes('dangerously-load-development-channels') &&
        l.includes('grep') &&
        !l.trimStart().startsWith('#')
    )
    expect(hit).toBeDefined()
  })

  test('Check 4 (shell prompt detection) is still executable', () => {
    const lines = WATCHDOG_SOURCE.split('\n')
    const hit = lines.find(
      (l) =>
        l.includes('shell prompt') || l.includes('at shell prompt')
    )
    expect(hit).toBeDefined()
  })
})
