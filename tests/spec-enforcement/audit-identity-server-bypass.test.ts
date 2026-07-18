import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf8')

function between(startNeedle: string, endNeedle: string): string {
  const start = SERVER_SRC.indexOf(startNeedle)
  if (start < 0) throw new Error(`start not found: ${startNeedle}`)
  const end = SERVER_SRC.indexOf(endNeedle, start + startNeedle.length)
  return SERVER_SRC.slice(start, end < 0 ? undefined : end)
}

describe('audit identity server bypass guards', () => {
  test('MCP direct DM rejects disabled or historical recipients before DM channel auto-create', () => {
    const body = between("if (prefix === 'agent')", '// Resolve DM channel')

    expect(body).toContain('historical_only')
    expect(body).toContain('new_work_allowed')
    expect(body).toContain('isRoutableAgentRow(agentR.rows[0])')
    expect(body).toContain("code: 'AGENT_NOT_ROUTABLE'")
  })

  test('MCP send/notify known-agent lists use routable registry, not raw cache', () => {
    const sendPhase5 = between('// UNKNOWN_AGENT reject: real routable agent registry lookup.', 'const phase5 = resolvePhase5({')
    const notifyPhase5 = between('// Phase 5 cleanup — notify wiring', 'const phase5 = resolvePhase5({')
    const mentionValidation = between('// Mentions validation: existence check', '// Rate limit')

    expect(sendPhase5).toContain('refreshRoutableAgentCache()')
    expect(notifyPhase5).toContain('refreshRoutableAgentCache()')
    expect(mentionValidation).toContain('refreshRoutableAgentCache()')
    expect(SERVER_SRC).toContain("phase5.error === 'AGENT_NOT_ROUTABLE'")
  })
})
