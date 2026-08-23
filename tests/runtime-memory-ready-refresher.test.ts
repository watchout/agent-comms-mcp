import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { runRuntimeMemoryReadyFleetRefresh } from '../core/runtime-memory-ready-refresher'
import { parseRuntimeMemoryReadyPolicy } from '../core/runtime-current-resolver'

let tmp: string
let db: SqliteAdapter
const now = new Date('2026-08-21T00:10:00.000Z')
const policy = parseRuntimeMemoryReadyPolicy(JSON.stringify({
  schema_version: 'runtime-memory-ready-policy/v1',
  default_liveness_ttl_ms: 1_800_000,
  default_reap_ttl_ms: 86_400_000,
  backoff: { base_ms: 30_000, cap_ms: 1_800_000 },
  groups: [{ runtime_kind: 'local_process', source: 'server.ts', heartbeat_interval_ms: 300_000 }],
}), '/tmp/runtime-memory-ready-policy.refresher.test.json')

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memory-ready-refresher-'))
  const dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
})

afterEach(async () => {
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function seedSeat(agentId: string, status: 'idle' | 'busy' = 'idle'): Promise<void> {
  await db.execute(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, channel_port, metadata,
        home_directory, profile_enabled, disabled_at)
     VALUES ($1, $1, 'dev', 'codex', $2, 39001, $3, $4, 1, NULL)`,
    [agentId, status, JSON.stringify({ tmux_session: `${agentId}-session` }), `/tmp/${agentId}`],
  )
  await db.execute(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
        port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
     VALUES ($1, $2, 'codex', 'local_process', $3, 39001, $4, 'head', 'running', $5, $5, $6)`,
    [`runtime-${agentId}`, agentId, `${agentId}-session`, `/tmp/${agentId}`, now.toISOString(), JSON.stringify({ source: 'server.ts' })],
  )
}

describe('memory-ready fleet refresher', () => {
  test('returns N/N terminal results and isolates one seat failure', async () => {
    await seedSeat('alpha', 'idle')
    await seedSeat('bravo', 'busy')
    await seedSeat('denied', 'idle')
    const visited: string[] = []

    const report = await runRuntimeMemoryReadyFleetRefresh(db as any, {
      denylist: ['denied'],
      now,
      policy,
      resolveProject: async (_db, agentId) => ({
        agent_id: agentId,
        project: agentId,
        workspace_path: `/tmp/${agentId}`,
        source: 'canonical_workspace',
      }),
      refreshSeat: async ({ resolution }) => {
        visited.push(resolution.agent_id)
        if (resolution.agent_id === 'alpha') throw new Error('fixture failure')
        return { evidence_id: 42, evidence_log_id: 'fixture-log' }
      },
    })

    expect(visited).toEqual(['alpha', 'bravo'])
    expect(report.ok).toBe(false)
    expect(report.summary).toEqual({
      inventory: 3,
      eligible: 2,
      ready: 1,
      failed: 1,
      skipped: 1,
      terminal_results: 3,
    })
    expect(report.seats.map(row => [row.agent_id, row.status, row.reason])).toEqual([
      ['alpha', 'failed', 'SEAT_REFRESH_ERROR'],
      ['bravo', 'ready', 'READY'],
      ['denied', 'skipped', 'DENYLISTED'],
    ])
    expect(report.provider_effects).toBe(0)
    expect(report.discord_visible_sends).toBe(0)
  })

  test('dry-run records every unresolved seat instead of silently omitting it', async () => {
    await seedSeat('healthy')
    await seedSeat('broken')
    await db.execute(`UPDATE agent_runtime_instances SET session_name='wrong' WHERE agent_id='broken'`)

    const report = await runRuntimeMemoryReadyFleetRefresh(db as any, {
      denylist: [],
      now,
      dryRun: true,
      policy,
      resolveProject: async (_db, agentId) => ({
        agent_id: agentId,
        project: agentId,
        workspace_path: `/tmp/${agentId}`,
        source: 'canonical_workspace',
      }),
    })

    expect(report.summary.inventory).toBe(2)
    expect(report.summary.terminal_results).toBe(2)
    expect(report.seats).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'healthy', status: 'dry_run_ready' }),
      expect.objectContaining({
        agent_id: 'broken',
        status: 'failed',
        reason: 'REGISTRATION_PROFILE_MISMATCH',
        runtime_instance_id: 'runtime-broken',
        details: expect.objectContaining({
          repair_signal: 'RUNTIME_REGISTRATION_PROFILE_CORRECTION_REQUIRED',
          registration_profile_mismatch: expect.objectContaining({
            current: true,
            handling: 'WARN_ONLY_CURRENT_FALLBACK',
          }),
        }),
      }),
    ]))
  })
})
