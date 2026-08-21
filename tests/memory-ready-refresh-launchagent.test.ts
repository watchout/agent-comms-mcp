import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main, renderMemoryReadyRefreshLaunchAgent } from '../scripts/operator/memory-ready-refresh-launchagent'

const tempDirs: string[] = []
afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('memory-ready refresh LaunchAgent template', () => {
  test('renders repo-owned paths and preserves the exact supplied denylist', () => {
    const rendered = renderMemoryReadyRefreshLaunchAgent({
      repoRoot: '/tmp/agent-comms-mcp',
      bunPath: '/tmp/bin/bun',
      databaseUrl: 'postgresql:///scratch?host=/tmp',
      denylist: 'ceo,dev-001',
      logRoot: '/tmp/logs',
    })
    expect(rendered.content).toContain('/tmp/agent-comms-mcp/scripts/operator/memory-ready-refresh.ts')
    expect(rendered.content).toContain('/tmp/agent-comms-mcp/config/runtime-memory-ready-policy.json')
    expect(rendered.content).toContain('<string>ceo,dev-001</string>')
    expect(rendered.content).toContain('<string>postgresql:///scratch?host=/tmp</string>')
    expect(rendered.content).not.toMatch(/__[A-Z0-9_]+__/)
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('install validates the plist and preserves a rollback copy', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'memory-ready-launchagent-'))
    tempDirs.push(temp)
    const output = join(temp, 'refresh.plist')
    const prior = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>prior</string></dict></plist>\n'
    writeFileSync(output, prior)

    expect(await main([
      'install',
      '--repo-root', '/tmp/agent-comms-mcp',
      '--database-url', 'postgresql:///scratch?host=/tmp',
      '--denylist', 'ceo,dev-001',
      '--log-root', join(temp, 'logs'),
      '--output', output,
      '--execute',
    ])).toBe(0)
    expect(readFileSync(output, 'utf8')).toContain('com.agent-comms.operator.memory-ready-refresh')
    const rollback = readdirSync(temp).filter(name => name.startsWith('refresh.plist.rollback-'))
    expect(rollback).toHaveLength(1)
    expect(existsSync(join(temp, rollback[0]))).toBe(true)
    expect(readFileSync(join(temp, rollback[0]), 'utf8')).toBe(prior)
  })
})
