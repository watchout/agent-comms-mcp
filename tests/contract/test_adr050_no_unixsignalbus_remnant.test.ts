/**
 * ADR-050 fixture (6a) — UnixSignalBus 関連 import / 使用が code base に存在しない.
 *
 * Pin invariant 1 from the impl PR instruction: a `grep -rE
 * 'UnixSignalBus|waitForSignal|bus\\.signal'` over the runtime source tree
 * (core/, bin/, adapters/, scripts/, server.ts) returns ZERO hits. Tests
 * and docs are intentionally excluded — the contract is about the runtime
 * code path, not historical references in changelogs / ADR text / tests
 * that may legitimately quote the old API name.
 *
 * Real grep via spawnSync against the working tree (not by-construction:
 * the filesystem is the source of truth for the assertion, so a future
 * accidental re-import of the deleted module is caught here, not silently
 * by tsc).
 */
import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const PATTERNS = ['UnixSignalBus', 'waitForSignal', 'bus\\.signal']
const TARGETS = ['core', 'bin', 'adapters', 'scripts', 'server.ts']

describe('ADR-050 §6a — no UnixSignalBus / waitForSignal / bus.signal in runtime code', () => {
  test('grep -rE returns 0 hits across core/ bin/ adapters/ scripts/ server.ts', () => {
    const presentTargets = TARGETS.filter((t) => existsSync(resolve(REPO_ROOT, t)))
    expect(presentTargets.length).toBeGreaterThan(0)

    const result = spawnSync(
      'grep',
      ['-rEn', PATTERNS.join('|'), ...presentTargets],
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    )
    // grep exit code: 0 = matches found (FAIL), 1 = no match (PASS),
    // 2 = error. We expect 1 (clean tree).
    if (result.status === 0) {
      throw new Error(
        `ADR-050 invariant 1 violated — UnixSignalBus / waitForSignal / bus.signal still referenced:\n${result.stdout}`,
      )
    }
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe('')
  })

  test('the deleted module file core/message-bus.ts no longer exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'core', 'message-bus.ts'))).toBe(false)
  })

  test('the deleted test tests/message-bus.test.ts no longer exists', () => {
    expect(existsSync(resolve(REPO_ROOT, 'tests', 'message-bus.test.ts'))).toBe(false)
  })
})
