import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

// Task A (incident 2026-05-11 09:00 JST CTO MCP reconnect drift): the agent
// runtime default in server.ts:171 was `'claude-code'`, which caused state-
// daemon to skip the tmux wake path for any agent whose config.json omitted
// `agent.runtime`. The fix flips the default to `'TUI'` so the producer side
// matches the consumer side's check (`core/state-daemon/index.ts:355,437`).
//
// spec: iyasaka-arc/agent-comms-mcp/specs/draft/2026-05-11-runtime-default-tui-fix-instruction.md
// (HEAD `acd0997`, v1.3 — auditor cycle 3 LGTM, CEO (c) directive `2b37d00a`)

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..')
const SERVER_TS = join(REPO_ROOT, 'server.ts')

// Mirror the production literal so T1-T5 exercise the same `??` semantics
// that server.ts uses. The source-code anchor test below pins the literal
// itself.
function resolveRuntime(raw: { agent?: { runtime?: unknown } } | null | undefined): string {
  return ((raw?.agent?.runtime as string | undefined | null) ?? 'TUI') as string
}

describe("Task A — server.ts agent runtime default = 'TUI' (incident 2026-05-11)", () => {
  test('source anchor: server.ts:171 uses TUI default', () => {
    const src = readFileSync(SERVER_TS, 'utf-8')
    expect(src).toContain("runtime: raw.agent?.runtime ?? 'TUI'")
    expect(src).not.toContain("runtime: raw.agent?.runtime ?? 'claude-code'")
  })

  test('T1: agent.runtime undefined → TUI fallback', () => {
    expect(resolveRuntime({ agent: { display_name: 'x' } as any })).toBe('TUI')
  })

  test('T2: agent.runtime = "claude-code" → preserved (nullish only)', () => {
    expect(resolveRuntime({ agent: { runtime: 'claude-code' } })).toBe('claude-code')
  })

  test('T3: agent.runtime = "TUI" → preserved', () => {
    expect(resolveRuntime({ agent: { runtime: 'TUI' } })).toBe('TUI')
  })

  test('T4: agent.runtime = null → TUI fallback', () => {
    expect(resolveRuntime({ agent: { runtime: null } })).toBe('TUI')
  })

  test('T5: agent.runtime = "" (empty string) → preserved (?? is nullish-only)', () => {
    // §2.1 nullish semantics: `??` falls back only on undefined/null; empty
    // string / 0 / false stay intact. T5 pins this against future "use ||"
    // regressions that would silently turn '' into 'TUI'.
    expect(resolveRuntime({ agent: { runtime: '' } })).toBe('')
  })
})
