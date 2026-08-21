import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { runRuntimeMemoryReadyFleetRefresh } from '../../core/runtime-memory-ready-refresher'
import { loadRuntimeMemoryReadyPolicy } from '../../core/runtime-current-resolver'
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-database'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let databaseUrl: string
let scratchDatabase: PostgresTestDatabase | null = null
let pg: Client
const prefix = `sd-c2a-pg-${randomUUID().slice(0, 8)}`

describe('memory-ready refresher PostgreSQL parity', () => {
  beforeAll(async () => {
    scratchDatabase = createPostgresTestDatabase(
      `agent_comms_sd_c2a_${process.pid}_${Date.now()}_test`,
    )
    databaseUrl = scratchDatabase.databaseUrl
    try {
      const migrated = Bun.spawnSync([process.execPath, 'db/migrate.ts'], {
        cwd: repoRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (migrated.exitCode !== 0) {
        throw new Error(`scratch PostgreSQL migration failed: ${migrated.stderr.toString().trim()}`)
      }
      pg = new Client({ connectionString: databaseUrl })
      await pg.connect()
    } catch (error) {
      scratchDatabase.drop()
      scratchDatabase = null
      throw error
    }
  })

  afterAll(async () => {
    try {
      if (pg) await pg.end()
    } finally {
      scratchDatabase?.drop()
    }
  })

  test('records and reads back ready evidence for every eligible seat on migrated PostgreSQL', async () => {
    const now = new Date()
    const ids = [`${prefix}-alpha`, `${prefix}-bravo`]
    for (const [index, agentId] of ids.entries()) {
      const runtimeId = index === 0
        ? 'aaaaaaaa-1111-4111-8111-111111111111'
        : 'bbbbbbbb-2222-4222-8222-222222222222'
      const session = `${agentId}-session`
      const home = `/tmp/${agentId}`
      await pg.query(
        `INSERT INTO agents
           (agent_id, display_name, agent_type, runtime, status, channel_port, metadata,
            home_directory, profile_enabled, profile_revision, profile_source, disabled_at)
         VALUES ($1, $1, 'test', 'codex', $2, $3, $4::jsonb, $5, true, 1, 'fixture', NULL)`,
        [
          agentId,
          index === 0 ? 'idle' : 'busy',
          39_500 + index,
          JSON.stringify({ tmux_session: session, memory_project: 'agent-comms-mcp' }),
          home,
        ],
      )
      await pg.query(
        `INSERT INTO agent_runtime_instances
           (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
            port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
         VALUES ($1::uuid, $2, 'codex', 'local_process', $3, $4, $5, 'fixture-head',
                 'running', $6, $6, '{"source":"server.ts"}'::jsonb)`,
        [runtimeId, agentId, session, 39_500 + index, home, now],
      )
    }

    const report = await runRuntimeMemoryReadyFleetRefresh({
      async query<T = any>(sql: string, params?: any[]) {
        const fleetInventory = sql.includes("status IN ('idle', 'busy')") && sql.includes('ORDER BY agent_id')
        const scopedSql = fleetInventory
          ? sql.replace('ORDER BY agent_id', 'AND agent_id LIKE $1 ORDER BY agent_id')
          : sql
        const scopedParams = fleetInventory ? [`${prefix}-%`] : params
        const result = await pg.query(scopedSql, scopedParams)
        return { rows: result.rows as T[], rowCount: result.rowCount }
      },
    }, {
      denylist: [],
      now,
      policy: loadRuntimeMemoryReadyPolicy(),
    })

    const fixtureSeats = report.seats.filter(row => row.agent_id.startsWith(prefix))
    expect(fixtureSeats).toHaveLength(2)
    expect(fixtureSeats.every(row => row.status === 'ready')).toBe(true)
    const evidence = await pg.query(
      `SELECT agent_id, result_status
         FROM runtime_memory_ready_evidence
        WHERE agent_id LIKE $1
        ORDER BY agent_id`,
      [`${prefix}-%`],
    )
    expect(evidence.rows).toEqual(ids.map(agent_id => ({ agent_id, result_status: 'ready' })))
    expect(report.provider_effects).toBe(0)
    expect(report.discord_visible_sends).toBe(0)
  })
})
