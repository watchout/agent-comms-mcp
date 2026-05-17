import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf-8')
}

describe('test_aun_mcp_namespace_compat — canonical aun namespace plus legacy aliases', () => {
  test('PreToolUse gate pins canonical and both legacy namespaces for every inbox tool', () => {
    const src = read('hooks/pre-tool-use-inbox-gate.ts')
    for (const ns of ['aun', 'agent_comms', 'agent-comms']) {
      expect(src).toContain(`'${ns}'`)
    }
    for (const tool of ['next', 'send', 'notify', 'skip', 'fail', 'reclaim']) {
      expect(src).toContain(`'${tool}'`)
    }
    expect(src).toContain('mcp__aun__${tool}')
    expect(src).toContain('mcp__${ns}__${tool}')
  })

  test('Stop-hook send enforcement accepts canonical and legacy send/notify names', () => {
    const src = read('hooks/aun-send-tool-enforcement.sh')
    for (const tool of ['send', 'notify']) {
      expect(src).toContain(`mcp__aun__${tool}`)
      expect(src).toContain(`mcp__agent_comms__${tool}`)
      expect(src).toContain(`mcp__agent-comms__${tool}`)
    }
  })

  test('operator prompts prefer canonical next and document legacy aliases', () => {
    for (const path of [
      'hooks/auto-next.sh',
      'hooks/aun-session-start-drain.sh',
      'hooks/aun-session-start-self-kick.sh',
      'hooks/claim-close-enforcement.ts',
    ]) {
      const src = read(path)
      expect(src).toContain('mcp__aun__next')
      expect(src).toContain('mcp__agent_comms__next')
      expect(src).toContain('mcp__agent-comms__next')
    }
  })

  test('registration runbook covers Codex, Claude, smoke plan, rollback, and forbidden mutations', () => {
    const doc = read('docs/operations/aun-mcp-registration.md')
    for (const required of [
      'Canonical MCP server registration name for new sessions: `aun`',
      'Canonical tool namespace for new sessions: `mcp__aun__*`',
      'mcp__agent_comms__*',
      'mcp__agent-comms__*',
      '~/.codex/config.toml',
      'codex mcp add aun',
      '~/.claude.json',
      '<repo>/.mcp.json',
      'claude mcp add --scope user',
      'Fresh `aun` direct delivery',
      'Legacy alias behavior',
      'Do not mutate production DB identity rows',
      'Remove the rollback alias after migration',
    ]) {
      expect(doc).toContain(required)
    }
  })
})
