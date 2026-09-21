import * as hostObserver from '../core/host-runtime-observer'
import { unitRuntimeObservation } from './helpers/logical-runtime-unit-fixture'
import { describe, expect, test, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildRuntimeCleanupReport,
  executeRuntimeCleanup,
  parseLsofTcpListeners,
} from '../core/runtime-cleanup'

async function withCleanupDb<T>(seed: {sql: string; observations: hostObserver.HostRuntimeObservation[]}, fn: (db: SqliteAdapter, path: string, observations: hostObserver.HostRuntimeObservation[]) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-comms-cleanup-'))
  const dbPath = join(dir, 'agent-comms.db')
  let adapter: SqliteAdapter | null = null
  const hostSpy=spyOn(hostObserver,'inspectHostRuntime').mockImplementation(input=>{
    const found=seed.observations.filter(o=>o.agent_id===input.agentId && (!input.runtimeInstanceId || o.runtime_instance_id===input.runtimeInstanceId))
    return {reasonCode:found.length?'OBSERVED':'NO_LIVE_RUNTIME',observations:found}
  })
  try {
    migrateSqlite(dbPath)
    const seedDb = new Database(dbPath)
    seedDb.exec(seed.sql)
    seedDb.close()
    adapter = new SqliteAdapter(dbPath)
    return await fn(adapter, dbPath, seed.observations)
  } finally {
    hostSpy.mockRestore()
    await adapter?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runtime cleanup lifecycle', () => {
  test('dry-run is stable and execute cleans observed codex-aun residue without touching active bots', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb({observations:[unitRuntimeObservation("codex-aun",{"runtime_instance_id": "runtime-codex-aun", "session_name": "discord-aun", "process_id": 4070, "port": 18070, "process_started_at": "2026-05-28T00:00:00Z", "observed_at": "2026-05-28T00:00:00Z"}),unitRuntimeObservation("codex-live",{"runtime_instance_id": "runtime-live", "session_name": "discord-live", "process_id": 5071, "port": 18071, "process_started_at": "2026-05-29T07:39:00Z", "observed_at": "2026-05-29T07:39:30Z"})],sql:`
      INSERT INTO agents
        (agent_id, display_name, agent_type, metadata, profile_enabled)
      VALUES
        ('codex-aun', 'AUN', 'dev', '{}', 0),
        ('codex-live', 'Live', 'dev', '{}', 1);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_kind)
      VALUES
        ('runtime-codex-aun', 'codex-aun', 'local_process'),
        ('runtime-live', 'codex-live', 'local_process');
    `}, async (db, dbPath, observed) => {
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
      expect(aun?.actions.filter(action=>action.kind!=='noop').map(action=>action.kind)).toEqual(['kill_process'])
      expect(aun?.actions.some(action=>action.kind==='kill_tmux_session')).toBe(false)
      expect(live?.classification).toBe('active')
      expect(live?.actions).toEqual([{ kind: 'noop', reason: 'fresh_active_runtime' }])

      const dryDb = new Database(dbPath)
      let row = dryDb.prepare(
        `SELECT status, stopped_at FROM agent_runtime_instances WHERE runtime_instance_id = 'runtime-codex-aun'`,
      ).get() as { status: string; stopped_at: string | null }
      dryDb.close()
      expect(row.status).toBeNull()
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
      expect(killedSessions).toEqual([])

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
      expect(row.status).toBeNull()
      expect(row.stopped_at).toBeNull()
      expect(liveRow.status).toBeNull()
      expect(liveRow.stopped_at).toBeNull()
      expect(audit.agent_id).toBe('codex-aun')
      expect(audit.target).toBe('runtime-codex-aun')
      expect(JSON.parse(audit.detail)).toMatchObject({
        classification: 'disabled-profile-residue',
        runtime_instance_id: 'runtime-codex-aun',
      })

      expect(audit.detail).not.toContain('4070')
      expect(audit.detail).not.toContain('discord-aun')
      observed.splice(observed.findIndex(o=>o.agent_id==='codex-aun'),1)
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
    await withCleanupDb({observations:[unitRuntimeObservation("stale-live",{"runtime_instance_id": "runtime-stale-live", "session_name": "discord-stale", "process_id": 6072, "port": 18072, "process_started_at": "2026-05-28T00:00:00Z", "observed_at": "2026-05-28T00:00:00Z"})],sql:`
      INSERT INTO agents
        (agent_id, display_name, agent_type, metadata, profile_enabled)
      VALUES
        ('stale-live', 'Stale Live', 'dev', '{}', 1);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_kind)
      VALUES
        ('runtime-stale-live', 'stale-live', 'local_process');
    `}, async (db) => {
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
    await withCleanupDb({observations:[unitRuntimeObservation("active-owner",{"runtime_instance_id": "runtime-active-owner", "session_name": "discord-active-owner", "process_id": 7777, "port": 41234, "process_started_at": "2026-05-29T07:30:00Z", "observed_at": "2026-05-29T07:39:30Z"})],sql:`
      INSERT INTO agents
        (agent_id, display_name, agent_type, metadata, profile_enabled)
      VALUES
        ('active-owner', 'Active Owner', 'dev', '{}', 1),
        ('disabled-old', 'Disabled Old', 'dev', '{"profile_class": "disabled-test"}', 0);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_kind)
      VALUES
        ('runtime-active-owner', 'active-owner', 'local_process');
    `}, async (db) => {
      const observations = {
        now,
        staleMinutes: 15,
        portListeners: [{ pid: 7777, port: 41234, command: 'bun' }],
      }
      const report = await buildRuntimeCleanupReport(db, observations)
      const active = report.targets.find((target) => target.agent_id === 'active-owner')
      const disabled = report.targets.find((target) => target.agent_id === 'disabled-old')

      expect(active?.classification).toBe('active')
      expect(disabled).toBeUndefined() // A profile port alone is no runtime residue.
      expect(active?.port).toBe(41234)
      expect(active?.actions).toEqual([{kind:'noop',reason:'fresh_active_runtime'}])
      expect(report.summary.cleanup_targets).toBe(0)
      expect(report.summary.unknown_risk_targets).toBe(0)
      const killedPids: number[] = []
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

  test('orphan listener pass treats active runtime port and pid ownership as unknown-risk', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb({observations:[unitRuntimeObservation("active-owner",{"runtime_instance_id": "runtime-active-owner", "session_name": "discord-active-owner", "process_id": 7777, "port": 2222, "process_started_at": "2026-05-29T07:30:00Z", "observed_at": "2026-05-29T07:39:30Z"})],sql:`
      INSERT INTO agents
        (agent_id, display_name, agent_type, metadata, profile_enabled)
      VALUES
        ('active-owner', 'Active Owner', 'dev', '{}', 1);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_kind)
      VALUES
        ('runtime-active-owner', 'active-owner', 'local_process');
    `}, async (db) => {
      const observations = {
        now,
        staleMinutes: 15,
        portListeners: [{ pid: 7777, port: 2222, command: 'bun' }],
      }
      const report = await buildRuntimeCleanupReport(db, observations)
      const listener = report.targets.find(target => target.agent_id === 'active-owner')
      expect(listener?.classification).toBe('active')
      expect(listener?.port).toBe(2222)
      expect(listener?.actions).toEqual([{kind:'noop',reason:'fresh_active_runtime'}])
      expect(report.targets.some(target => target.port === 1111)).toBe(false)
      expect(report.summary.cleanup_targets).toBe(0)
      expect(report.summary.unknown_risk_targets).toBe(0)
      const killedPids: number[] = []
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

  test('orphan listener pass protects active runtime listener while disabled residue cleanup remains scoped', async () => {
    const now = new Date('2026-05-29T07:40:00Z')
    await withCleanupDb({observations:[unitRuntimeObservation("active-owner",{"runtime_instance_id": "runtime-active-owner", "session_name": "discord-active-owner", "process_id": 7777, "port": 2222, "process_started_at": "2026-05-29T07:30:00Z", "observed_at": "2026-05-29T07:39:30Z"}),unitRuntimeObservation("disabled-old",{"runtime_instance_id": "runtime-disabled-old", "session_name": "discord-disabled-old", "process_id": 8888, "port": 3333, "process_started_at": "2026-05-28T00:00:00Z", "observed_at": "2026-05-28T00:00:00Z"})],sql:`
      INSERT INTO agents
        (agent_id, display_name, agent_type, metadata, profile_enabled)
      VALUES
        ('active-owner', 'Active Owner', 'dev', '{}', 1),
        ('disabled-old', 'Disabled Old', 'dev', '{}', 0);

      INSERT INTO agent_runtime_instances
        (runtime_instance_id, agent_id, runtime_kind)
      VALUES
        ('runtime-active-owner', 'active-owner', 'local_process'),
        ('runtime-disabled-old', 'disabled-old', 'local_process');
    `}, async (db) => {
      const observations = {
        now,
        staleMinutes: 15,
        portListeners: [
          { pid: 7777, port: 2222, command: 'bun' },
          { pid: 8888, port: 3333, command: 'bun' },
        ],
      }
      const report = await buildRuntimeCleanupReport(db, observations)
      const listener = report.targets.find((target) => target.agent_id === 'active-owner')
      const disabled = report.targets.find((target) => target.agent_id === 'disabled-old')

      expect(listener?.classification).toBe('active')
      expect(listener?.actions).not.toContainEqual(expect.objectContaining({
        kind: 'kill_process',
        pid: 7777,
      }))
      expect(disabled?.classification).toBe('disabled-profile-residue')
      expect(disabled?.actions).toContainEqual({
        kind: 'kill_process',
        pid: 8888,
        port: 3333,
        reason: 'fresh_owned_disabled_runtime',
      })
      expect(report.summary.cleanup_targets).toBe(1)
      expect(report.summary.unknown_risk_targets).toBe(0)

      const killedPids: number[] = []
      const override = await executeRuntimeCleanup(db, {
        ...observations,
        allowUnknownRisk: true,
        confirmHash: report.plan_hash,
        killProcess: (pid) => killedPids.push(pid),
      })
      expect(override.summary.executable_actions).toBe(1)
      expect(killedPids).toEqual([8888])
    })
  })

  test('active lease or foreign host prevents disabled-profile cleanup from stopping the actual holder',async()=>{
    await withCleanupDb({observations:[unitRuntimeObservation("seat",{"runtime_instance_id": "held", "session_name": "seat-session", "process_id": 123, "port": 19999, "observed_at": "2026-09-13T00:00:00Z"})],sql:`INSERT INTO agents(agent_id, display_name, agent_type, profile_enabled) VALUES('seat', 'Seat', 'dev', 0);
      INSERT INTO agent_runtime_instances(runtime_instance_id, agent_id, runtime_kind)
      VALUES('held', 'seat', 'local_process');`}, async (db,_path,observed)=>{
      const options={now:new Date('2026-09-13T01:00:00Z'),portListeners:[{pid:123,port:19999}],tmuxPanes:[]}
      observed[0]={...observed[0],host_id:'foreign-host'}
      expect((await buildRuntimeCleanupReport(db,options)).summary.executable_actions).toBe(0)
      observed[0]={...observed[0],host_id:hostname()}
      await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at)
        VALUES('held-lease','runtime_instance','held','worker','seat','held',1,'active','2099-01-01T00:00:00Z')`)
      expect((await buildRuntimeCleanupReport(db,options)).summary.executable_actions).toBe(0)
    })
  })
  test('parses lsof listener evidence used by cleanup plans', () => {
    expect(parseLsofTcpListeners([
      'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'bun      4070 yuji   14u  IPv4 123456      0t0  TCP *:18070 (LISTEN)',
    ].join('\n'))).toEqual([{ pid: 4070, port: 18070, command: 'bun' }])
  })
})
