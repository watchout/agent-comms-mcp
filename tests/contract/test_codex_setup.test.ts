import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf-8')
}

describe('Codex setup contract', () => {
  test('README uses current Codex MCP registry/config shape', () => {
    const src = read('README.md')
    expect(src).toContain('codex mcp add agent-comms')
    expect(src).toContain('[mcp_servers.agent-comms]')
    expect(src).toContain('args = ["run", "--cwd", "/path/to/agent-comms-mcp", "server.ts"]')
    expect(src).not.toContain('[mcp.agent-comms]')
    expect(src).not.toContain('[mcp.agent-comms.env]')
  })

  test('Codex repo instructions require native agent-comms tools', () => {
    const src = read('AGENTS.md')
    expect(src).toContain('mcp__agent-comms__next')
    expect(src).toContain('mcp__agent-comms__send')
    expect(src).toContain('mcp__agent-comms__notify')
    expect(src).toContain('Do not use `mentions`')
  })

  test('install script registers via `codex mcp add` with bun --cwd server.ts', () => {
    const src = read('scripts/install-codex-mcp.sh')
    expect(src).toContain('codex mcp add "$NAME"')
    expect(src).toContain('--env "AGENT_ID=$AGENT_ID"')
    expect(src).toContain('--env "DATABASE_URL=$DATABASE_URL"')
    expect(src).toContain('-- bun run --cwd "$REPO_DIR" server.ts')
  })

  test('Codex runner wraps run-bot with current `codex exec` flags', () => {
    const src = read('scripts/run-codex-bot.sh')
    const expected = 'codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral'
    expect(src).toContain('run-bot.sh')
    expect(src).toContain(expected)
    expect(src).toContain('LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-180}"')
    expect(read('scripts/run-bot.sh')).toContain(expected)
    expect(read('docs/agent-com-message-queue-spec.md')).toContain(expected)
  })
})
