/**
 * ADR-029R PR 5 — seed-workspace-identity tool contract.
 *
 * The seeded state must satisfy the Phase 1 resolver end-to-end: after
 * --execute, resolveAgentIdentity() on the seeded workspace succeeds; the
 * tool is dry-run by default, idempotent, and never creates agents.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as PgClient } from 'pg'
import { resolveAgentIdentity } from '../../core/identity-resolver'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const PREFIX = `sd-test-seedws-${process.pid}`
const AGENT = `${PREFIX}-bot`

let pg: PgClient
let workspaceDir: string

function runSeed(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['scripts/seed-workspace-identity.ts', ...args], {
    cwd: `${import.meta.dir}/../..`,
    encoding: 'utf-8',
    env: { ...process.env, DATABASE_URL },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

beforeAll(async () => {
  pg = new PgClient({ connectionString: DATABASE_URL })
  await pg.connect()
  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'seedws-')))
  await pg.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status)
     VALUES ($1, 'default', $1, 'dev', 'TUI', 'idle') ON CONFLICT (agent_id) DO NOTHING`,
    [AGENT],
  )
})

afterAll(async () => {
  await pg.query(`DELETE FROM agent_workspace_bindings WHERE agent_id LIKE $1`, [`${PREFIX}%`])
  await pg.query(`DELETE FROM agent_workspaces WHERE workspace_id LIKE $1`, [`ws-${PREFIX}%`])
  await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
  await pg.end()
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('seed-workspace-identity', () => {
  test('dry-run by default: reports the plan, writes nothing', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--project', 'seed-test'])
    expect(r.status).toBe(0)
    const plan = JSON.parse(r.stdout)
    expect(plan.dry_run).toBe(true)

    expect(existsSync(join(workspaceDir, '.agent', 'identity.json'))).toBe(false)
    const ws = await pg.query(`SELECT 1 FROM agent_workspaces WHERE local_path = $1`, [workspaceDir])
    expect(ws.rows.length).toBe(0)
  })

  test('refuses unknown agents (never creates them)', () => {
    const r = runSeed(['--agent-id', `${PREFIX}-ghost`, '--workspace', workspaceDir, '--execute'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not present in agents')
  })

  test('--execute seeds rows + declaration, and the Phase 1 resolver then succeeds end-to-end', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--project', 'seed-test', '--execute'])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result.seeded).toBe(true)

    expect(existsSync(join(workspaceDir, '.agent', 'identity.json'))).toBe(true)

    const db = {
      query: async (sql: string, params?: unknown[]) => {
        const res = await pg.query(sql, params as any[])
        return { rows: res.rows }
      },
    }
    const resolved = await resolveAgentIdentity(db, { cwd: workspaceDir, env: {}, mode: 'fleet' })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.agent_id).toBe(AGENT)
      expect(resolved.project).toBe('seed-test')
      expect(resolved.source).toBe('workspace_declaration')
    }
  })

  test('idempotent: re-running --execute succeeds and keeps the binding active', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--execute'])
    expect(r.status).toBe(0)
    const binding = await pg.query(
      `SELECT active FROM agent_workspace_bindings b
        JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
       WHERE b.agent_id = $1 AND w.local_path = $2`,
      [AGENT, workspaceDir],
    )
    expect(binding.rows.length).toBe(1)
    expect(binding.rows[0].active).toBe(true)
  })
})
