import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildRuntimeCleanupReport,
  executeRuntimeCleanup,
  parseLsofTcpListeners,
} from '../core/runtime-cleanup'

async function withCleanupDb<T>(seedSql: string, fn: (db: SqliteAdapter, path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-cleanup-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  try {
    migrateSqlite(dbPath)
    const seed = new Database(dbPath)
    seed.exec(seedSql)
    seed.close()
    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter, dbPath)
  } finally {
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runtime cleanup lifecycle', () => {
  test('dry-run is stable and execute cleans observed codex-aun residue without touching active bots', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb(`
      INSERT INTO agents
        (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, profile_enabled)
      VALUES
        ('codex-aun', 'AUN', 'dev', 'TUI', 'offline', '{"tmux_session":"discord-aun","supervisor_type":"tmux"}', 18070, 0),
        ('codex-live', 'Live', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-live","supervisor_type":"tmux"}', 18071, 1);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, port, status, started_at, last_seen_at)
      VALUES
        ('runtime-codex-aun', 'codex-aun', 'codex', 'local_process', 'discord-aun', 4070, 18070, 'active', '2026-05-28T00:00:00Z', '2026-05-28T00:00:00Z'),
        ('runtime-live', 'codex-live', 'codex', 'local_process', 'discord-live', 5071, 18071, 'active', '2026-05-29T07:39:00Z', '2026-05-29T07:39:30Z');
    `, async (db, dbPath) => {
      const observations = {
        now,
        staleMinutes: 15,
        tmuxPanes: [
          { session_name: 'discord-aun', pane_pid: 3070, current_path: '/tmp/codex-aun' },
          { session_name: 'discord-live', pane_pid: 3071, current_path: '/tmp/live' },
        ],
        portListeners: [
          { pid: 4070, port: 18070, command: 'bun' },
          { pid: 5071, port: 18071, command: 'bun' },
        ],
      }
      const first = await buildRuntimeCleanupReport(db, observations)
      const second = await buildRuntimeCleanupReport(db, observations)
      expect(first.plan_hash).toBe(second.plan_hash)
      expect(first.dry_run).toBe(true)

      const aun = first.targets.find((target) => target.agent_id === 'codex-aun')
      const live = first.targets.find((target) => target.agent_id === 'codex-live')
      expect(aun?.classification).toBe('disabled-profile-residue')
      expect(aun?.actions.map((action) => action.kind).sort()).toEqual([
        'kill_process',
        'kill_tmux_session',
        'stop_runtime',
      ])
      expect(live?.classification).toBe('active')
      expect(live?.actions).toEqual([{ kind: 'noop', reason: 'fresh_active_runtime' }])

      const dryDb = new Database(dbPath)
      let row = dryDb.prepare(
        `SELECT status, stopped_at FROM agent_runtime_instances WHERE runtime_instance_id = 'runtime-codex-aun'`,
      ).get() as { status: string; stopped_at: string | null }
      dryDb.close()
      expect(row.status).toBe('active')
      expect(row.stopped_at).toBeNull()

      const killedPids: number[] = []
      const killedSessions: string[] = []
      const executed = await executeRuntimeCleanup(db, {
        ...observations,
        confirmHash: first.plan_hash,
        killProcess: (pid) => killedPids.push(pid),
        killTmuxSession: (session) => killedSessions.push(session),
      })
      expect(executed.plan_hash).toBe(first.plan_hash)
      expect(killedPids).toEqual([4070])
      expect(killedSessions).toEqual(['discord-aun'])

      const checkDb = new Database(dbPath)
      row = checkDb.prepare(
        `SELECT status, stopped_at FROM agent_runtime_instances WHERE runtime_instance_id = 'runtime-codex-aun'`,
      ).get() as { status: string; stopped_at: string | null }
      const liveRow = checkDb.prepare(
        `SELECT status, stopped_at FROM agent_runtime_instances WHERE runtime_instance_id = 'runtime-live'`,
      ).get() as { status: string; stopped_at: string | null }
      const audit = checkDb.prepare(
        `SELECT agent_id, target, detail FROM audit_log WHERE event_type = 'runtime.cleanup_target'`,
      ).get() as { agent_id: string; target: string; detail: string }
      checkDb.close()
      expect(row.status).toBe('stopped')
      expect(row.stopped_at).not.toBeNull()
      expect(liveRow.status).toBe('active')
      expect(liveRow.stopped_at).toBeNull()
      expect(audit.agent_id).toBe('codex-aun')
      expect(audit.target).toBe('agent:codex-aun:disabled-profile-residue')
      expect(JSON.parse(audit.detail)).toMatchObject({
        pid: 4070,
        port: 18070,
        tmux_session: 'discord-aun',
        runtime_instance_id: 'runtime-codex-aun',
      })

      const cleanRerun = await buildRuntimeCleanupReport(db, {
        now,
        staleMinutes: 15,
        tmuxPanes: [{ session_name: 'discord-live', pane_pid: 3071, current_path: '/tmp/live' }],
        portListeners: [{ pid: 5071, port: 18071, command: 'bun' }],
      })
      expect(cleanRerun.summary.cleanup_targets).toBe(0)
      expect(cleanRerun.targets.every((target) => target.classification === 'active')).toBe(true)
    })
  })

  test('execute refuses unknown-risk plans unless explicitly overridden', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb(`
      INSERT INTO agents
        (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, profile_enabled)
      VALUES
        ('stale-live', 'Stale Live', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-stale","supervisor_type":"tmux"}', 18072, 1);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, port, status, started_at, last_seen_at)
      VALUES
        ('runtime-stale-live', 'stale-live', 'codex', 'local_process', 'discord-stale', 6072, 18072, 'active', '2026-05-28T00:00:00Z', '2026-05-28T00:00:00Z');
    `, async (db) => {
      const report = await buildRuntimeCleanupReport(db, {
        now,
        staleMinutes: 15,
        portListeners: [{ pid: 7072, port: 18072, command: 'node' }],
      })
      expect(report.targets[0]?.classification).toBe('unknown-risk')
      expect(report.blockers).toContain('agent:stale-live:stale-heartbeat:unknown-risk')

      const killedPids: number[] = []
      await expect(executeRuntimeCleanup(db, {
        now,
        staleMinutes: 15,
        portListeners: [{ pid: 7072, port: 18072, command: 'node' }],
        confirmHash: report.plan_hash,
        killProcess: (pid) => killedPids.push(pid),
      })).rejects.toThrow('UNKNOWN_RISK_REFUSED')
      expect(killedPids).toEqual([])
    })
  })

  test('disabled/test residue cannot kill a listener owned by an active profile', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb(`
      INSERT INTO agents
        (agent_id, display_name, agent_type, runtime, status, metadata, channel_port, profile_enabled)
      VALUES
        ('active-owner', 'Active Owner', 'dev', 'TUI', 'idle', '{"tmux_session":"discord-active-owner","supervisor_type":"tmux"}', 41234, 1),
        ('disabled-old', 'Disabled Old', 'dev', 'TUI', 'offline', '{"profile_class":"disabled-test","tmux_session":"discord-disabled-old","supervisor_type":"tmux"}', 41234, 0);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id, port, status, started_at, last_seen_at)
      VALUES
        ('runtime-active-owner', 'active-owner', 'codex', 'local_process', 'discord-active-owner', 7777, 41234, 'active', '2026-05-29T07:30:00Z', '2026-05-29T07:39:30Z');
    `, async (db) => {
      const observations = {
        now,
        staleMinutes: 15,
        portListeners: [{ pid: 7777, port: 41234, command: 'bun' }],
      }
      const report = await buildRuntimeCleanupReport(db, observations)
      const active = report.targets.find((target) => target.agent_id === 'active-owner')
      const disabled = report.targets.find((target) => target.agent_id === 'disabled-old')

      expect(active?.classification).toBe('active')
      expect(disabled?.classification).toBe('unknown-risk')
      expect(disabled?.risk).toBe('unknown-risk')
      expect(disabled?.actions).toContainEqual({
        kind: 'noop',
        pid: 7777,
        port: 41234,
        reason: 'disabled_profile_port_listener_has_active_owner',
      })
      expect(disabled?.actions).not.toContainEqual(expect.objectContaining({
        kind: 'kill_process',
        pid: 7777,
      }))
      expect(disabled?.evidence.shared_active_listeners).toEqual([{
        pid: 7777,
        port: 41234,
        owners: ['active-owner'],
        command: 'bun',
      }])
      expect(report.summary.cleanup_targets).toBe(0)
      expect(report.summary.unknown_risk_targets).toBe(1)
      expect(report.blockers).toContain('agent:disabled-old:disabled-profile-residue:unknown-risk')

      const killedPids: number[] = []
      await expect(executeRuntimeCleanup(db, {
        ...observations,
        confirmHash: report.plan_hash,
        killProcess: (pid) => killedPids.push(pid),
      })).rejects.toThrow('UNKNOWN_RISK_REFUSED')
      expect(killedPids).toEqual([])

      const override = await executeRuntimeCleanup(db, {
        ...observations,
        allowUnknownRisk: true,
        confirmHash: report.plan_hash,
        killProcess: (pid) => killedPids.push(pid),
      })
      expect(override.summary.executable_actions).toBe(0)
      expect(killedPids).toEqual([])
    })
  })

  test('parses lsof listener evidence used by cleanup plans', () => {
    expect(parseLsofTcpListeners([
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'bun      4070 yuji   14u  IPv4 123456      0t0  TCP *:18070 (LISTEN)',
    ].join('\n'))).toEqual([{ pid: 4070, port: 18070, command: 'bun' }])
  })
})
