import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'sync-mcp-config.sh')

function runSync(dir: string, runtime: string, agentId = 'agent-mem-dev'): { status: number; stderr: string } {
  const script = [
    'set -euo pipefail',
    `SCRIPT_DIR=${JSON.stringify(join(REPO_ROOT, 'scripts'))}`,
    `source ${JSON.stringify(SCRIPT)}`,
    `sync_mcp_config "agent-mem-dev" ${JSON.stringify(dir)} ${JSON.stringify(agentId)} "39130" ${JSON.stringify(runtime)}`,
  ].join('\n')
  const r = spawnSync('bash', ['-lc', script], { encoding: 'utf-8' })
  return { status: r.status ?? -1, stderr: r.stderr ?? '' }
}

describe('shared .mcp.json owner-safe restore/restart sync', () => {
  test('Codex command-line override profile does not overwrite shared .mcp.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-owner-codex-'))
    try {
      const file = join(dir, '.mcp.json')
      const before = JSON.stringify({
        'x-agent-comms-owner': 'wasurezu',
        mcpServers: {
          'agent-comms': {
            command: 'bun',
            args: ['run', '/shared/agent-memory/server.ts'],
            env: { AGENT_ID: 'wasurezu', WEBHOOK_PORT: '8797' },
          },
        },
      }, null, 2) + '\n'
      writeFileSync(file, before)

      const r = runSync(dir, 'codex')

      expect(r.status).toBe(0)
      expect(r.stderr).toContain('shared .mcp.json not mutated')
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('owner mismatch is held instead of overwritten for Claude profile sync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-owner-claude-'))
    try {
      const file = join(dir, '.mcp.json')
      const before = JSON.stringify({
        'x-agent-comms-owner': 'wasurezu',
        mcpServers: {
          'agent-comms': {
            command: 'bun',
            args: ['run', '/shared/agent-memory/server.ts'],
            env: { AGENT_ID: 'wasurezu', WEBHOOK_PORT: '8797' },
          },
        },
      }, null, 2) + '\n'
      writeFileSync(file, before)

      const r = runSync(dir, 'claude-code')

      expect(r.status).toBe(0)
      expect(r.stderr).toContain('does not match agent-mem-dev/agent-mem-dev; skipping')
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
