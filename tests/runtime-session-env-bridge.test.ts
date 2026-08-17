import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The heartbeat resolves its session name from AGENT_COM_RUNTIME_SESSION first and from
// TMUX_PANE second. With the key unset, the MCP server inherits TMUX_PANE from the pane
// it was launched in and records a pane identifier such as %1008 as the session name.
// The memory_ready gate compares that against the seat's registered metadata.tmux_session
// and rejects it as session_mismatch, so the runner is never invoked and the seat's queue
// rows are never delivered. Repairing the row by hand does not hold — the heartbeat
// rewrites it every five minutes — so the fix has to be in what the process is started
// with. These tests exercise both startup paths against fixtures.

const REPO = join(import.meta.dir, '..')
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-env-bridge-'))
  roots.push(root)
  return root
}

async function sh(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bash', '-c', script], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

describe('claude seats: sync-mcp-config writes the session into .mcp.json', () => {
  test('AGENT_COM_RUNTIME_SESSION is set to the session name', async () => {
    const dir = workspace()
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'agent-comms': { command: 'bun', args: ['run', '/old/server.ts'], env: { AGENT_ID: 'devauditor' } } },
    }, null, 2))

    const result = await sh(`source scripts/sync-mcp-config.sh && sync_mcp_config discord-auditor '${dir}' devauditor 8797 claude-code`)
    expect(result.code).toBe(0)

    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    const env = written.mcpServers['agent-comms'].env
    expect(env.AGENT_COM_RUNTIME_SESSION).toBe('discord-auditor')
    // The pre-existing keys the helper is responsible for must still be right.
    expect(env.AGENT_ID).toBe('devauditor')
    expect(env.WEBHOOK_PORT).toBe('8797')
  })

  test('an existing wrong value is corrected rather than preserved', async () => {
    const dir = workspace()
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'agent-comms': { command: 'bun', args: ['run', '/old/server.ts'], env: { AGENT_ID: 'devauditor', AGENT_COM_RUNTIME_SESSION: '%1008' } } },
    }, null, 2))

    await sh(`source scripts/sync-mcp-config.sh && sync_mcp_config discord-auditor '${dir}' devauditor 8797 claude-code`)

    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(written.mcpServers['agent-comms'].env.AGENT_COM_RUNTIME_SESSION).toBe('discord-auditor')
  })

  test('unrelated env keys are preserved', async () => {
    const dir = workspace()
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'agent-comms': { command: 'bun', args: ['run', '/old/server.ts'], env: { AGENT_ID: 'devauditor', DISCORD_BOT_TOKEN: 'keep-me' } } },
    }, null, 2))

    await sh(`source scripts/sync-mcp-config.sh && sync_mcp_config discord-auditor '${dir}' devauditor 8797 claude-code`)

    const written = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
    expect(written.mcpServers['agent-comms'].env.DISCORD_BOT_TOKEN).toBe('keep-me')
  })
})

describe('codex seats: restart-bot pins the session on the command line', () => {
  test('the built command carries AGENT_COM_RUNTIME_SESSION', async () => {
    // restart-bot.sh runs top-level setup under `set -euo pipefail` and cannot be
    // sourced in isolation, so the real function definition is extracted from the file
    // and evaluated. This exercises the shipped text rather than a copy of it.
    const result = await sh(
      `eval "$(sed -n '/^build_profile_command()/,/^}/p' scripts/restart-bot.sh)";` +
      ` BUN_BIN=/bin/bun DEFAULT_CMD=claude DEFAULT_AUN_DATABASE_URL=postgresql:///x REPO_ROOT=. ` +
      ` build_profile_command devauditor discord-auditor 8797 codex; printf '%s' "$CLAUDE_CMD"`,
    )
    expect(result.stdout).toContain('mcp_servers.aun.env.AGENT_COM_RUNTIME_SESSION="discord-auditor"')
  })
})
