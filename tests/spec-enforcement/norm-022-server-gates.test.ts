import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')

function toolBody(name: string): string {
  const start = SERVER_SRC.indexOf(`if (name === '${name}')`)
  if (start < 0) throw new Error(`tool ${name} not found`)
  const next = SERVER_SRC.indexOf("\n  if (name === '", start + 1)
  return SERVER_SRC.slice(start, next === -1 ? undefined : next)
}

describe('NORM-022 server destructive action gates', () => {
  test('restart_bot checks endpoint lease evidence before restartBotSession', () => {
    const body = toolBody('restart_bot')
    expect(body).toContain('loadEndpointLeaseStatus()')
    expect(body).toContain('destructiveLifecycleGateFailure(entry, endpointStatus.get(entry.agentId))')
    expect(body.indexOf('destructiveLifecycleGateFailure')).toBeLessThan(body.indexOf('restartBotSession(entry)'))
  })

  test('watchdog_check checks endpoint lease evidence before auto restart', () => {
    const body = toolBody('watchdog_check')
    expect(body).toContain('loadEndpointLeaseStatus()')
    expect(body).toContain('destructiveLifecycleGateFailure(entry, endpointStatus.get(entry.agentId))')
    expect(body.indexOf('destructiveLifecycleGateFailure')).toBeLessThan(body.indexOf('restartBotSession(entry)'))
  })

  test('cleanup_ports checks endpoint lease evidence before killing port owners', () => {
    const body = toolBody('cleanup_ports')
    expect(body).toContain('loadEndpointLeaseStatus()')
    expect(body).toContain('evaluateCleanupPort(entry, endpointStatus.get(entry.agentId)')
    expect(body.indexOf('evaluateCleanupPort')).toBeLessThan(body.indexOf('killPidsOnPort(entry.port, false)'))
    expect(body).not.toContain('tmuxHasSession(entry.session)')
  })
})
