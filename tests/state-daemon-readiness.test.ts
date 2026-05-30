import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import type { DbAdapter } from '../core/db'
import { classifyQueueWakeState, fetchBotStatusFromDb } from '../core/bot-status-db'
import { StateDaemon } from '../core/state-daemon'
import {
  buildQueueWakeSmokeReport,
  fingerprintFatalStderr,
  inspectStateDaemonRuntime,
} from '../core/state-daemon-readiness'
import {
  FakeAlertSink,
  FakeClock,
  FakeMetrics,
  FakePgListen,
  FakeTmux,
  PgDBClient,
} from './contract/state-daemon/fakes'
import { cleanAll, makeAgentId, openClient, seedAgent, seedQueueRow } from './contract/state-daemon/seed'

class PgClientAdapter implements DbAdapter {
  constructor(private readonly client: Client) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const result = await this.client.query(sql, params)
    return result.rows as T[]
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null
  }

  async execute(sql: string, params?: any[]): Promise<{ rowCount: number }> {
    const result = await this.client.query(sql, params)
    return { rowCount: result.rowCount ?? 0 }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN')
    try {
      const result = await fn(this)
      await this.client.query('COMMIT')
      return result
    } catch (err) {
      await this.client.query('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {}
}

class FakeSmokeDb implements DbAdapter {
  agents = new Map<string, any>()
  queue = new Map<string, any>()
  audits: any[] = []
  nextId = 1

  constructor(agentId = '__queue_wake_smoke__') {
    this.agents.set(agentId, {
      agent_id: agentId,
      runtime: 'TUI',
      status: 'idle',
      metadata: JSON.stringify({ tmux_session: `${agentId}-tmux` }),
      last_wake_attempt_at: null,
    })
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    if (sql.includes('FROM agents') && sql.includes('WHERE agent_id = $1') && sql.includes('runtime')) {
      const row = this.agents.get(params?.[0])
      return (row ? [row] : []) as T[]
    }
    if (sql.includes('COUNT(id) FILTER') && sql.includes('FROM message_queue')) {
      const agentId = params?.[0]
      const rows = Array.from(this.queue.values()).filter((row) => row.agent_id === agentId)
      return [{
        pending_count: rows.filter((row) => row.status === 'pending').length,
        active_claim_count: rows.filter((row) => ['received', 'in_progress'].includes(row.status) && row.claimed_by === row.agent_id).length,
      }] as T[]
    }
    if (sql.includes('INSERT INTO message_queue')) {
      const id = String(this.nextId++)
      const row = {
        id,
        agent_id: params?.[0],
        message_id: params?.[1],
        payload: params?.[2],
        status: 'pending',
        created_at: params?.[3],
        last_wake_attempt_at: null,
        read_at: null,
        claimed_by: null,
        claimed_at: null,
      }
      this.queue.set(id, row)
      return [{ id, created_at: row.created_at }] as T[]
    }
    if (sql.includes('FROM message_queue') && sql.includes('WHERE id = $1')) {
      const row = this.queue.get(String(params?.[0]))
      return (row ? [row] : []) as T[]
    }
    if (sql.includes('SELECT last_wake_attempt_at FROM agents')) {
      const row = this.agents.get(params?.[0])
      return [{ last_wake_attempt_at: row?.last_wake_attempt_at ?? null }] as T[]
    }
    if (sql.includes('FROM audit_log')) return this.audits as T[]
    return []
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null
  }

  async execute(sql: string, params?: any[]): Promise<{ rowCount: number }> {
    if (sql.includes('INSERT INTO audit_log')) {
      this.audits.push({
        event_type: params?.[0],
        agent_id: params?.[1],
        target: params?.[2],
        detail: params?.[3],
      })
      return { rowCount: 1 }
    }
    return { rowCount: 0 }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    return fn(this)
  }

  async close(): Promise<void> {}
}

describe('state-daemon readiness diagnostics', () => {
  test('fatal stderr fingerprint detects launchd module resolution failures', () => {
    expect(fingerprintFatalStderr('error: Module not found "/tmp/missing/bin/state-daemon.ts"'))
      .toContain('Module not found')
  })

  test('runtime inspection separates launchd/state-daemon readiness from bot port health', () => {
    const readiness = inspectStateDaemonRuntime({
      label: 'com.agent-comms.state-daemon',
      plistPath: '/tmp/state-daemon.plist',
      execFileSync: ((cmd: string, args: string[]) => {
        if (cmd === 'launchctl') {
          return [
            'state = running',
            'pid = 123',
            'last exit status = 1',
            'program = /Users/yuji/.bun/bin/bun',
            'working directory = /private/tmp/agent-comms-state-daemon',
            'stdout path = /tmp/state.out',
            'stderr path = /tmp/state.err',
            'arguments = {',
            '  /Users/yuji/.bun/bin/bun',
            '  /private/tmp/agent-comms-state-daemon/bin/state-daemon.ts',
            '}',
          ].join('\n')
        }
        if (cmd === 'ps') return '123 /Users/yuji/.bun/bin/bun /private/tmp/agent-comms-state-daemon/bin/state-daemon.ts\n'
        if (cmd === 'lsof') return 'p123\nfcwd\nn/private/tmp/agent-comms-state-daemon\n'
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
      }) as any,
      existsSync: ((path: string) => path === '/tmp/state-daemon.plist' || path === '/tmp/state.err') as any,
      readFileSync: ((path: string) => {
        if (path === '/tmp/state.err') return 'fatal: Module not found /private/tmp/agent-comms-state-daemon/bin/state-daemon.ts\n'
        return '<plist><dict><key>EnvironmentVariables</key><dict><key>DATABASE_URL</key><string>postgresql:///agent_comms?host=/tmp</string></dict></dict></plist>'
      }) as any,
      statSync: (() => ({ size: 120 })) as any,
      getuid: () => 501,
      homedir: () => '/Users/yuji',
    })

    expect(readiness.launchd.loaded).toBe(true)
    expect(readiness.launchd.running).toBe(true)
    expect(readiness.process.pid).toBe(123)
    expect(readiness.paths.script).toContain('bin/state-daemon.ts')
    expect(readiness.process.cwd).toBe('/private/tmp/agent-comms-state-daemon')
    expect(readiness.stderr.fatal_fingerprint).toContain('Module not found')
    expect(readiness.status).toBe('degraded')
  })
})

describe('queue wake smoke', () => {
  test('dry-run reports approval hash without inserting a row', async () => {
    const db = new FakeSmokeDb()
    const report = await buildQueueWakeSmokeReport(db, {
      mode: 'dry_run',
      nowMs: () => Date.parse('2026-05-30T00:00:00Z'),
    })

    expect(report.ok).toBe(true)
    expect(report.result).toBe('not_run')
    expect(report.plan_hash).toHaveLength(12)
    expect(report.policy.calls_manual_next).toBe(false)
    expect(report.policy.terminalizes_existing_rows).toBe(false)
    expect(db.queue.size).toBe(0)
  })

  test('execute passes when state-daemon wake evidence advances within the bounded poll', async () => {
    const db = new FakeSmokeDb()
    let now = Date.parse('2026-05-30T00:00:00Z')
    const dryRun = await buildQueueWakeSmokeReport(db, {
      mode: 'dry_run',
      timeoutMs: 2_000,
      pollMs: 500,
      nowMs: () => now,
    })
    const report = await buildQueueWakeSmokeReport(db, {
      mode: 'execute',
      confirmPlanHash: dryRun.plan_hash,
      timeoutMs: 2_000,
      pollMs: 500,
      nowMs: () => now,
      sleepMs: async (ms) => {
        now += ms
        const row = Array.from(db.queue.values())[0]
        if (row) row.last_wake_attempt_at = new Date(now).toISOString()
        const agent = db.agents.get('__queue_wake_smoke__')
        if (agent) agent.last_wake_attempt_at = new Date(now).toISOString()
      },
    })

    expect(report.ok).toBe(true)
    expect(report.result).toBe('pass')
    expect(report.smoke.evidence).toContain('message_queue.last_wake_attempt_at advanced')
    expect(Array.from(db.queue.values())[0].status).toBe('pending')
    expect(db.audits).toHaveLength(1)
  })

  test('stuck-pattern classifier flags idle pending without wake progress and busy suppression', () => {
    expect(classifyQueueWakeState({
      pending_count: 1,
      oldest_pending_at: new Date(Date.now() - 60_000).toISOString(),
      active_claim_count: 0,
      health_state: 'healthy',
      latest_wake_progress_at: null,
    })).toBe('idle_pending_no_wake_progress')

    expect(classifyQueueWakeState({
      pending_count: 3,
      oldest_pending_at: new Date().toISOString(),
      active_claim_count: 1,
      health_state: 'busy_active',
      latest_wake_progress_at: new Date().toISOString(),
    })).toBe('busy_active_pending_growth')
  })
})

describe('queue wake smoke integration evidence', () => {
  let pg: Client

  beforeAll(async () => {
    pg = await openClient()
  })

  afterAll(async () => {
    if (pg) {
      await cleanAll(pg)
      await pg.end()
    }
  })

  beforeEach(async () => {
    await cleanAll(pg)
  })

  test('execute observes a real state-daemon wake after inserting its diagnostic row', async () => {
    const agent = makeAgentId('queue-smoke')
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      status: 'idle',
      last_seen_at: new Date(),
      tmux_session: `${agent}-session`,
    })

    let now = Date.parse('2026-05-30T00:00:00Z')
    const clock = new FakeClock(new Date(now))
    const tmux = new FakeTmux()
    const metrics = new FakeMetrics()
    const alert = new FakeAlertSink()
    const daemon = new StateDaemon({
      db: new PgDBClient(pg),
      pgListen: new FakePgListen(),
      tmux,
      clock,
      metrics,
      alert,
      config: { agentIdPrefix: 'sd-test-' },
    })
    const adapter = new PgClientAdapter(pg)
    const dryRun = await buildQueueWakeSmokeReport(adapter, {
      agentId: agent,
      mode: 'dry_run',
      timeoutMs: 2_000,
      pollMs: 500,
      nowMs: () => now,
    })

    await daemon.start()
    try {
      let handled = false
      const report = await buildQueueWakeSmokeReport(adapter, {
        agentId: agent,
        mode: 'execute',
        confirmPlanHash: dryRun.plan_hash,
        timeoutMs: 2_000,
        pollMs: 500,
        nowMs: () => now,
        sleepMs: async (ms) => {
          now += ms
          clock.advance(ms)
          if (handled) return

          const rows = await pg.query<{ id: number; status: string; claim_expires_at: Date | null }>(
            `SELECT id, status, claim_expires_at
               FROM message_queue
              WHERE agent_id = $1
              ORDER BY id DESC
              LIMIT 1`,
            [agent],
          )
          const row = rows.rows[0]
          if (!row) return
          handled = true
          await daemon.__testHandleEvent({
            op: 'INSERT',
            id: row.id,
            agent_id: agent,
            status: row.status,
            claim_expires_at: row.claim_expires_at,
          })
        },
      })

      expect(report.ok).toBe(true)
      expect(report.result).toBe('pass')
      expect(report.smoke.evidence).toContain('message_queue.last_wake_attempt_at advanced')
      expect(report.smoke.evidence).toContain('agents.last_wake_attempt_at advanced')
      expect(tmux.sentKeys).toEqual([{
        session: `${agent}-session`,
        payload: 'Call the agent-comms next tool now. Do not call inbox.\n',
      }])
      expect(metrics.countInc('state_daemon_wake_actions_total', { result: 'ok' })).toBe(1)

      const queue = await pg.query<{
        status: string
        last_wake_attempt_at: Date | null
        done_at: Date | null
        replied_at: Date | null
      }>(
        `SELECT status, last_wake_attempt_at, done_at, replied_at
           FROM message_queue
          WHERE id = $1`,
        [report.smoke.queue_id],
      )
      expect(queue.rows[0].status).toBe('pending')
      expect(queue.rows[0].last_wake_attempt_at).not.toBeNull()
      expect(queue.rows[0].done_at).toBeNull()
      expect(queue.rows[0].replied_at).toBeNull()

      const status = await fetchBotStatusFromDb(pg)
      const row = status.get(agent)!
      expect(row.pending_count).toBe(1)
      expect(row.active_claim_count).toBe(0)
      expect(row.queue_wake_state).toBe('wake_attempt_recorded')
      expect(row.latest_wake_progress_at).not.toBeNull()
    } finally {
      await daemon.stop()
    }
  })

  test('bot-status DB truth exposes busy active claims suppressing pending wake growth', async () => {
    const agent = makeAgentId('busy-growth')
    const now = new Date()
    await seedAgent(pg, {
      agent_id: agent,
      runtime: 'TUI',
      status: 'busy',
      last_seen_at: now,
      tmux_session: `${agent}-session`,
    })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'in_progress',
      claimed_by: agent,
      claimed_at: now,
      claim_expires_at: new Date(now.getTime() + 60_000),
      created_at: now,
    })
    await seedQueueRow(pg, {
      agent_id: agent,
      status: 'pending',
      created_at: now,
    })

    const status = await fetchBotStatusFromDb(pg)
    const row = status.get(agent)!
    expect(row.health_state).toBe('busy_active')
    expect(row.pending_count).toBe(1)
    expect(row.active_claim_count).toBe(1)
    expect(row.queue_wake_state).toBe('busy_active_pending_growth')
  })
})
