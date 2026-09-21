import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateDaemon } from '../../core/state-daemon'
import { inspectHostRuntime } from '../../core/host-runtime-observer'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './state-daemon/fakes'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { createReadyNativeRuntimeWithDb, stopNativeFixtures } from '../helpers/seat-native-runtime-fixture'

test('NP07/08 normal daemon pending path re-reads real native original on private PostgreSQL; missing original/observer/lease dispatch zero', async () => {
  const f = await fixture('postgres', true)
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aun-np-scheduler-native-')))
  const agent = `np-scheduler-${randomUUID()}`, runtimeId = randomUUID(), project = 'agent-comms-mcp'
  let daemon: StateDaemon | undefined
  try {
    await insert(f, 'agents', {agent_id: agent, display_name: 'private scheduler', agent_type: 'dev',
      profile_enabled: true, metadata: JSON.stringify({memory_project: project})})
    const adapter: any = {query: f.query, execute: async (sql: string, params?: unknown[]) => ({rowCount: (await f.query(sql, params)).length})}
    const native = await createReadyNativeRuntimeWithDb(adapter, home, agent, runtimeId)
    const channel = randomUUID()
    await insert(f, 'channels', {id: channel, name: 'private scheduler', members: [agent]})
    const calls: unknown[] = [], metrics = new FakeMetrics(), tmux = new FakeTmux()
    let originalAvailable = true, observerAvailable = true, reads = 0, inspections = 0
    daemon = new StateDaemon({
      db: {async query<T>(sql: string, params?: unknown[]) {const rows = await f.query(sql, params); return {rows: rows as T[], rowCount: rows.length}}},
      pgListen: new FakePgListen(), tmux, clock: new FakeClock(new Date()), metrics, alert: new FakeAlertSink(),
      queueWorkScheduler: {async runPending(input) {calls.push(input)}},
      runtimeInspector: input => {inspections++; return observerAvailable ? inspectHostRuntime(input) : {reasonCode: 'OBSERVATION_TIMEOUT', observations: []}},
      readNativeProof: async () => {
        reads++
        if (!originalAvailable) throw new Error('private fixture original unavailable')
        return readNativeSeatContextReceipt({agentId: agent, project, runtimeInstanceId: runtimeId,
          targetRuntime: 'codex', providerPid: native.observed.provider.pid, providerStartedAt: native.observed.provider.startedAt,
          hostSessionId: `${agent}-session`, transport: {command: native.node, args: [native.memory], env: native.env},
          env: {PATH: process.env.PATH!, LANG: 'C', ...native.env}, cwd: home})
      },
      config: {agentIdPrefix: agent, pollSweepIntervalMs: 3600000, heartbeatIntervalMs: 3600000},
    })
    await daemon.start()
    const dispatch = async () => {
      const message = randomUUID()
      await insert(f, 'agent_messages', {id: message, author_id: agent, channel_id: channel, content: 'private instruction', message_type: 'instruction'})
      await insert(f, 'message_queue', {agent_id: agent, message_id: message, status: 'pending',
        payload: JSON.stringify({message_type: 'instruction', content: 'private instruction'})})
      const [row] = await f.query('SELECT id FROM message_queue WHERE message_id=$1', [message])
      await daemon!.__testHandleEvent({op: 'INSERT', id: Number(row.id), agent_id: agent, status: 'pending', claim_expires_at: null})
    }
    await dispatch()
    expect(calls).toHaveLength(1)
    expect(reads).toBe(1)
    expect(inspections).toBeGreaterThan(3)
    originalAvailable = false
    await dispatch()
    expect(reads).toBe(2)
    expect(calls).toHaveLength(1)
    originalAvailable = true
    observerAvailable = false
    await dispatch()
    expect(reads).toBe(2)
    expect(calls).toHaveLength(1)
    observerAvailable = true
    await f.query("UPDATE control_plane_leases SET status='released' WHERE holder_agent_id=$1", [agent])
    await dispatch()
    expect(calls).toHaveLength(1)
    const [profile] = await f.query('SELECT runtime,status,channel_port,last_seen_at FROM agents WHERE agent_id=$1', [agent])
    expect(profile).toEqual({runtime: null, status: null, channel_port: null, last_seen_at: null})
    const [proof] = await f.query('SELECT session_name,port,checkout_path,metadata FROM runtime_memory_ready_evidence WHERE agent_id=$1', [agent])
    expect(proof.session_name).toBeNull(); expect(proof.port).toBeNull(); expect(proof.checkout_path).toBeNull()
    expect(JSON.stringify(proof.metadata)).not.toContain(home)
    expect(JSON.stringify(proof.metadata)).not.toContain('native_delivery')
    expect(tmux.sentKeys).toEqual([]); expect(tmux.restarts).toEqual([])
    // Runner boundary is a recorder: this proves admission, not LLM execution or finalization.
    console.log(JSON.stringify({case: 'native-scheduler-admission', native_reads: reads, dispatched: calls.length,
      denied: 3, provider_invocations: 0, observer_calls: inspections}))
  } finally {
    await daemon?.stop(); await stopNativeFixtures(); await f.close(); rmSync(home, {recursive: true, force: true})
  }
}, 60000)
