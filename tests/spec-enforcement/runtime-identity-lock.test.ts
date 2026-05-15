#!/usr/bin/env bun
/**
 * Runtime identity lock regression tests.
 *
 * The runtime identity must be script-controlled. LLMs may describe themselves
 * incorrectly, but CLI/MCP execution must not silently switch from the expected
 * agent_id to a config fallback such as `cto`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('runtime identity lock', () => {
  test('CLI enforces AGENT_COM_EXPECTED_AGENT_ID for env AGENT_ID', () => {
    expect(CLI_SRC).toContain('AGENT_COM_EXPECTED_AGENT_ID')
    expect(CLI_SRC).toContain('Error [AGENT_ID_MISMATCH]')
    expect(CLI_SRC).toMatch(/return assertExpectedAgentId\(id, command\)/)
  })

  test('CLI also enforces AGENT_COM_EXPECTED_AGENT_ID for --agent-id override', () => {
    expect(CLI_SRC).toMatch(/return assertExpectedAgentId\(args\[idx \+ 1\], command\)/)
  })

  test('MCP server fails fast when resolved AGENT_ID does not match expected identity', () => {
    expect(SERVER_SRC).toContain('AGENT_COM_EXPECTED_AGENT_ID')
    expect(SERVER_SRC).toContain('ERROR [AGENT_ID_MISMATCH]')
    expect(SERVER_SRC).toMatch(/process\.exit\(2\)/)
  })
})
