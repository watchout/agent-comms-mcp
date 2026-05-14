/**
 * ADR-050 fixture (6c) — spec §13.5.1 normative statement is wake-daemon.
 *
 * Reads docs/agent-com-message-queue-spec.md and asserts:
 *   - §13.5.1 declares "Primary: wake-daemon" (with tmux send-keys reference)
 *   - the normative section (everything before "## 改訂履歴") contains 0
 *     occurrences of the legacy API tokens (UnixSignalBus / waitForSignal /
 *     bus.signal). The Changelog history section retains the original
 *     entries verbatim for provenance and is intentionally excluded from
 *     the count.
 *
 * Real file read (not by-construction) so the assertion fails if the spec
 * drifts back to the old description.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SPEC_PATH = resolve(REPO_ROOT, 'docs', 'agent-com-message-queue-spec.md')

function loadSpec(): string {
  return readFileSync(SPEC_PATH, 'utf-8')
}

function normativeSection(spec: string): string {
  const idx = spec.indexOf('## 改訂履歴')
  if (idx < 0) throw new Error('spec is missing the "## 改訂履歴" boundary marker')
  return spec.slice(0, idx)
}

describe('ADR-050 §6c — spec §13.5.1 primary is wake-daemon', () => {
  test('§13.5.1 declares Primary: wake-daemon (tmux send-keys)', () => {
    const spec = loadSpec()
    // Find the section header
    const header = spec.indexOf('### 13.5.1 メッセージ配信メカニズム')
    expect(header).toBeGreaterThan(0)
    // Slice to the next ### or ## boundary
    const tail = spec.slice(header)
    const nextSection = tail.search(/\n##+ /m)
    const section = nextSection > 0 ? tail.slice(0, nextSection) : tail

    expect(section).toMatch(/Primary:\s*wake-daemon/)
    expect(section).toMatch(/tmux send-keys/)
    expect(section).not.toMatch(/UnixSignalBus/)
    expect(section).not.toMatch(/waitForSignal/)
    expect(section).not.toMatch(/bus\.signal/)
  })

  test('normative spec body (pre-Changelog) has 0 mentions of legacy API tokens', () => {
    const norm = normativeSection(loadSpec())
    const tokens = ['UnixSignalBus', 'waitForSignal', 'bus.signal']
    for (const t of tokens) {
      expect(norm.includes(t)).toBe(false)
    }
  })

  test('changelog records the ADR-050 reflection', () => {
    const spec = loadSpec()
    const idx = spec.indexOf('## 改訂履歴')
    const changelog = spec.slice(idx)
    expect(changelog).toMatch(/ADR-050/)
  })
})
