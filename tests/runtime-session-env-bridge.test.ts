import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, buildStartLaunchArgv } from '../bin/aun/start'

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
    expect(env.WEBHOOK_PORT).toBe('0')
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

  test('the aun alias retains identity while removing a legacy fixed port', async () => {
    const dir = workspace()
    const config = join(dir, '.mcp.json')
    writeFileSync(config, JSON.stringify({ mcpServers: {
      aun: { command: 'bun', args: ['run', '/old/server.ts'], env: {
        AGENT_ID: 'devauditor', WEBHOOK_PORT: '8797', AUN_WEBHOOK_PORT: '8897',
      } },
      wasurezu: { command: 'node', args: ['/unchanged/memory.js'] },
    } }))
    const result = await sh(`source scripts/sync-mcp-config.sh && sync_mcp_config discord-auditor '${dir}' devauditor 8797 claude-code`)
    expect(result.code).toBe(0)
    const written = JSON.parse(readFileSync(config, 'utf8'))
    expect(Object.keys(written.mcpServers)).toEqual(['aun', 'wasurezu'])
    expect(written.mcpServers.aun.env).toMatchObject({
      AGENT_ID: 'devauditor', AGENT_COM_EXPECTED_AGENT_ID: 'devauditor',
      AGENT_COM_RUNTIME_SESSION: 'discord-auditor', WEBHOOK_PORT: '0',
    })
    expect(written.mcpServers.aun.env.AUN_WEBHOOK_PORT).toBeUndefined()
    expect(written.mcpServers.wasurezu).toEqual({ command: 'node', args: ['/unchanged/memory.js'] })
  })
})

describe('codex seats: restart-bot pins the session on the command line', () => {
  test('the built command carries AGENT_COM_RUNTIME_SESSION', async () => {
    const dir = workspace()
    // restart-bot now uses this canonical detached launch plan. Resolve an explicit
    // cold-start intent with a read-only seat fixture; no native CLI is spawned.
    const result = await start({ agentId: 'devauditor', project: 'fixture-project',
      runtime: 'codex', cwd: dir, home: dir, spawn: false, checkSignatures: false,
      env: { HOME: dir, AGENT_COM_RUNTIME_SESSION: 'discord-auditor' },
      db: { query: async (sql: string) => sql.includes('FROM agents')
        ? [{ agent_id: 'devauditor', profile_enabled: true, disabled_at: null, metadata: {} }] : [] } as any,
    })
    expect(result.ok).toBe(true)
    expect(result.spawned).toBe(false)
    const command = buildStartLaunchArgv(result)
    expect(command).toContain('AGENT_COM_RUNTIME_SESSION=discord-auditor')
    expect(command).toContain('mcp_servers.aun.env.AGENT_COM_RUNTIME_SESSION="discord-auditor"')
    expect(command).toContain('mcp_servers.aun.env.WEBHOOK_PORT="0"')
    expect(command.join(' ')).not.toContain('WEBHOOK_PORT="8797"')
    expect(readFileSync(join(REPO, 'scripts/restart-bot.sh'), 'utf8')).toContain('buildStartLaunchArgv(result)')
  })
})
