import { describe, expect, test } from 'bun:test'
import { StateDaemon } from '../../../core/state-daemon/index'
import {
  loadAllAgentCommunicationManifestOverridesFromEnv,
  type StateDaemonDeps,
} from '../../../core/state-daemon/types'

function fixture(enforcement: boolean, gateOutcome: 'admit' | 'deny', rowStatus = 'pending') {
  const queries: string[] = []
  const scheduler = { pending: 0, received: 0 }
  let listener: ((payload: string) => void) | null = null
  const deps: StateDaemonDeps = {
    db: {
      async query(sql: string) {
        queries.push(sql)
        if (sql.includes('profile_enabled, disabled_at') && sql.includes('FROM agents')) return {
          rows: [{
            agent_id: 'dev-001', runtime: 'codex', runtime_engine_preference: 'codex',
            status: 'online', profile_enabled: true, disabled_at: null,
          }],
          rowCount: 1,
        }
        if (sql.includes('SELECT members FROM channels WHERE id=$1')) return {
          rows: [{ members: ['dev-001'] }],
          rowCount: 1,
        }
        if (/FROM message_queue mq/.test(sql)) return {
          rows: [{
            id: 8001,
            agent_id: 'dev-001',
            message_id: 'message-8001',
            payload: '{}',
            status: rowStatus,
            claim_expires_at: null,
            created_at: new Date('2026-07-26T00:00:00Z'),
            last_wake_attempt_at: null,
            last_heartbeat_at: null,
            message_type: 'task_request',
            channel_id: 'channel-8001',
          }],
          rowCount: 1,
        }
        return { rows: [], rowCount: 0 }
      },
    },
    pgListen: {
      async listen(_channel, callback) { listener = callback },
      async unlisten() {},
    },
    tmux: { async sessionExists() { return false }, async restartSession() {} },
    queueWorkScheduler: {
      async runPending() { scheduler.pending++ },
      async runReceived() { scheduler.received++ },
    },
    allAgentCommunicationAdmissionGate: {
      decide() {
        return gateOutcome === 'admit'
          ? { outcome: 'admit', manifest_id: 'm1', revision: 1, artifact_digest: 'a'.repeat(64), target_sha256: 'b'.repeat(64) }
          : { outcome: 'deny', code: 'TARGET_DRIFT' }
      },
    },
    clock: { now: () => new Date('2026-07-26T00:00:01Z') },
    metrics: { inc() {}, observe() {}, gaugeSet() {} },
    alert: { async alert() {} },
    config: {
      allAgentCommunicationManifestEnforcementEnabled: enforcement,
      memoryReadyGateEnabled: false,
      pollSweepIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
      botLivenessCheckIntervalMs: 60_000,
      gcIntervalMs: 60_000,
    },
  }
  return { daemon: new StateDaemon(deps), queries, scheduler, listener: () => listener }
}

describe('state-daemon ordinary manifest default-off admission hook', () => {
  test('absent remains default-off while malformed explicit enforcement fails closed', () => {
    expect(loadAllAgentCommunicationManifestOverridesFromEnv({})).toEqual({})
    expect(loadAllAgentCommunicationManifestOverridesFromEnv({
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: '0',
    })).toEqual({ allAgentCommunicationManifestEnforcementEnabled: false })
    expect(loadAllAgentCommunicationManifestOverridesFromEnv({
      STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED: 'typo',
    })).toEqual({ allAgentCommunicationManifestEnforcementEnabled: true })
  })

  test('enabled denial happens before claim, runner, model, effect, or queue mutation', async () => {
    const f = fixture(true, 'deny')
    await f.daemon.start()
    try {
      await f.daemon.__testHandleEvent({
        op: 'INSERT', id: 8001, agent_id: 'dev-001', status: 'pending', claim_expires_at: null,
      })
      expect(f.scheduler).toEqual({ pending: 0, received: 0 })
      expect(f.queries.filter(sql => /\b(UPDATE|INSERT|DELETE)\b/i.test(sql))).toEqual([])
      expect(f.queries.filter(sql => /FROM message_queue mq/.test(sql))).toHaveLength(1)
      expect(f.queries.some(sql => /FROM agents/.test(sql))).toBe(true)
      expect(f.queries.some(sql => /FROM channels/.test(sql))).toBe(true)
    } finally {
      await f.daemon.stop()
    }
  })

  test('disabled default preserves the existing received scheduler path without consulting manifest policy', async () => {
    const f = fixture(false, 'deny', 'received')
    await f.daemon.start()
    try {
      await f.daemon.__testHandleEvent({
        op: 'UPDATE', id: 8001, agent_id: 'dev-001', status: 'received', claim_expires_at: null,
      })
      await Promise.resolve()
      expect(f.scheduler.received).toBe(1)
      expect(f.queries.some(sql => /FROM agents/.test(sql))).toBe(true)
      expect(f.queries.some(sql => /FROM channels/.test(sql))).toBe(true)
      expect(f.queries.filter(sql => /\b(UPDATE|INSERT|DELETE)\b/i.test(sql))).toEqual([])
    } finally {
      await f.daemon.stop()
    }
  })
})
