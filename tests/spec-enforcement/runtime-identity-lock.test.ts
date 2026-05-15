#!/usr/bin/env bun
/**
 * Runtime identity lock regression tests.
 *
 * The runtime identity must be script-controlled. LLMs may describe themselves
 * incorrectly, but CLI/MCP execution must not silently switch from the expected
 * agent_id to a config fallback such as `cto`.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI = join(REPO_ROOT, 'cli', 'index.ts')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

function runCli(args: string[], env: Record<string, string>) {
  const result = spawnSync('bun', [CLI, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: '',
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: '/tmp/agent-com-runtime-identity-lock.sqlite',
      ...env,
    },
    encoding: 'utf-8',
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

describe('runtime identity lock', () => {
  test('CLI enforces AGENT_COM_EXPECTED_AGENT_ID for env AGENT_ID', () => {
    expect(CLI_SRC).toContain('AGENT_COM_EXPECTED_AGENT_ID')
    expect(CLI_SRC).toContain('Error [AGENT_ID_MISMATCH]')
    expect(CLI_SRC).toMatch(/return assertExpectedAgentId\(id, command\)/)
  })

  test('CLI also enforces AGENT_COM_EXPECTED_AGENT_ID for --agent-id override', () => {
    expect(CLI_SRC).toMatch(/return assertExpectedAgentId\(args\[idx \+ 1\], command\)/)
  })

  test('status --agent-id cannot bypass AGENT_COM_EXPECTED_AGENT_ID', () => {
    const result = runCli(['status', '--agent-id', 'cto', '--format', 'json'], {
      AGENT_ID: 'codex-cto',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-cto',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Error [AGENT_ID_MISMATCH]')
    expect(result.stderr).toContain('resolved agent_id=cto')
  })

  test('status without agent id remains system-wide and does not require identity assertion', () => {
    const result = runCli(['status', '--format', 'json'], {
      AGENT_ID: '',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-cto',
    })
    expect(result.stderr).not.toContain('AGENT_ID_MISMATCH')
  })

  test('reclaim --agent-id cannot bypass AGENT_COM_EXPECTED_AGENT_ID', () => {
    const result = runCli(['reclaim', '--agent-id', 'cto'], {
      AGENT_ID: 'codex-cto',
      AGENT_COM_EXPECTED_AGENT_ID: 'codex-cto',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Error [AGENT_ID_MISMATCH]')
    expect(result.stderr).toContain('resolved agent_id=cto')
  })

  test('MCP server fails fast when resolved AGENT_ID does not match expected identity', () => {
    expect(SERVER_SRC).toContain('AGENT_COM_EXPECTED_AGENT_ID')
    expect(SERVER_SRC).toContain('ERROR [AGENT_ID_MISMATCH]')
    expect(SERVER_SRC).toMatch(/process\.exit\(2\)/)
  })
})
