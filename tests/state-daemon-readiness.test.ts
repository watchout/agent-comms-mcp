import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Client } from 'pg'
import type { DbAdapter } from '../core/db'
import { fetchBotStatusFromDb, type BotStatusDbRow } from '../core/bot-status-db'
import { StateDaemon } from '../core/state-daemon'
import {
  buildQueueProcessingReadinessReport,
  buildQueueWakeSmokeReport,
  fingerprintFatalStderr,
  formatQueueProcessingReadinessText,
  inspectStateDaemonRuntime,
  type StateDaemonRuntimeReadiness,
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

function runtimeReadiness(overrides: Partial<StateDaemonRuntimeReadiness> = {}): StateDaemonRuntimeReadiness {
  const base: StateDaemonRuntimeReadiness = {
    label: 'com.agent-comms.state-daemon',
    status: 'ok',
    checked_at: '2026-06-02T00:00:00.000Z',
    launchd: {
      available: true,
      loaded: true,
      running: true,
      state: 'running',
      pid: 123,
      last_exit_status: 0,
    },
    process: {
      pid: 123,
      command: 'bun bin/state-daemon.ts',
      cwd: '/Users/yuji/Developer/agent-comms-mcp',
    },
    paths: {
      program: '/Users/yuji/.bun/bin/bun',
      script: '/Users/yuji/Developer/agent-comms-mcp/bin/state-daemon.ts',
      working_directory: '/Users/yuji/Developer/agent-comms-mcp',
      stdout_path: '/tmp/state.out',
      stderr_path: '/tmp/state.err',
      plist_path: '/Users/yuji/Library/LaunchAgents/com.agent-comms.state-daemon.plist',
    },
    environment: {
      database_url: 'postgresql:///agent_comms?host=/tmp',
      codex_runner_enabled: '1',
      queue_work_scheduler_enabled: null,
      agent_allowlist: null,
      agent_denylist: null,
    },
    stderr: {
      path: '/tmp/state.err',
      exists: true,
      fatal_fingerprint: null,
    },
  }
  return {
    ...base,
    ...overrides,
    launchd: { ...base.launchd, ...(overrides.launchd ?? {}) },
    process: { ...base.process, ...(overrides.process ?? {}) },
    paths: { ...base.paths, ...(overrides.paths ?? {}) },
    environment: { ...base.environment, ...(overrides.environment ?? {}) },
    stderr: { ...base.stderr, ...(overrides.stderr ?? {}) },
  }
}

function botStatusRow(overrides: Partial<BotStatusDbRow> = {}): BotStatusDbRow {
  return {
    agent_id: 'codex-cto',
    status: 'idle',
    last_seen_at: '2026-06-02T00:00:00.000Z',
    heartbeat_ok: true,
    pending_count: 0,
    oldest_pending_at: null,
    newest_pending_at: null,
    active_claim_count: 0,
    oldest_active_claim_at: null,
    health_state: 'healthy',
    agent_last_wake_attempt_at: null,
    pending_last_wake_attempt_at: null,
    latest_wake_progress_at: null,
    queue_wake_state: 'none',
    active_connector_count: 1,
    runtime_linked_connector_count: 1,
    active_endpoint_lease_count: 1,
    endpoint_lease_state: 'ok',
    endpoint_lease_expires_at: '2026-06-02T00:05:00.000Z',
    endpoint_lease_heartbeat_at: '2026-06-02T00:00:00.000Z',
    discord_gateway_reported_count: 1,
    discord_gateway_ready_count: 1,
    discord_gateway_state: 'ready',
    ...overrides,
  }
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
    expect(readiness.environment.codex_runner_enabled).toBeNull()
    expect(readiness.stderr.fatal_fingerprint).toContain('Module not found')
    expect(readiness.status).toBe('degraded')
  })

  test('runtime inspection uses live launchctl environment over plist environment', () => {
    const readiness = inspectStateDaemonRuntime({
      label: 'com.agent-comms.state-daemon',
      plistPath: '/tmp/state-daemon.plist',
      execFileSync: ((cmd: string) => {
        if (cmd === 'launchctl') {
          return [
            'state = running',
            'pid = 123',
            'program = /Users/yuji/.bun/bin/bun',
            'arguments = {',
            '  /Users/yuji/.bun/bin/bun',
            '  /checkout/bin/state-daemon.ts',
            '}',
            'environment = {',
            '  STATE_DAEMON_CODEX_RUNNER_ENABLED => 0',
            '  STATE_DAEMON_AGENT_ALLOWLIST => kodama',
            '  STATE_DAEMON_AGENT_DENYLIST => ceo,test',
            '  DATABASE_URL => postgresql:///agent_comms?host=/tmp',
            '}',
          ].join('\n')
        }
        if (cmd === 'ps') return '123 /Users/yuji/.bun/bin/bun /checkout/bin/state-daemon.ts\n'
        if (cmd === 'lsof') return 'p123\nfcwd\nn/checkout\n'
        throw new Error(`unexpected ${cmd}`)
      }) as any,
      existsSync: ((path: string) => path === '/tmp/state-daemon.plist') as any,
      readFileSync: (() => [
        '<plist><dict><key>EnvironmentVariables</key><dict>',
        '<key>STATE_DAEMON_CODEX_RUNNER_ENABLED</key><string>1</string>',
        '<key>STATE_DAEMON_AGENT_ALLOWLIST</key><string>qa</string>',
        '</dict></dict></plist>',
      ].join('')) as any,
      statSync: (() => ({ size: 0 })) as any,
      getuid: () => 501,
      homedir: () => '/Users/yuji',
    })

    expect(readiness.environment.codex_runner_enabled).toBe('0')
    expect(readiness.environment.agent_allowlist).toBe('kodama')
    expect(readiness.environment.agent_denylist).toBe('ceo,test')
  })
})

describe('#603 queue-processing readiness', () => {
  test('separates healthy transport from stuck queue wake progress', () => {
    const report = buildQueueProcessingReadinessReport([
      botStatusRow({
        agent_id: 'codex-cto',
        pending_count: 2,
        oldest_pending_at: '2026-06-02T00:00:00.000Z',
        queue_wake_state: 'idle_pending_no_wake_progress',
      }),
    ], runtimeReadiness(), { now: new Date('2026-06-02T00:01:00.000Z') })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.transport_readiness.ready).toBe(true)
    expect(report.queue_processing_readiness.ready).toBe(false)
    expect(report.queue_processing_readiness.pending_total).toBe(2)
    expect(report.queue_processing_readiness.blocker_codes).toEqual(['QUEUE_WAKE_STUCK'])
    expect(report.blockers.map((blocker) => blocker.code)).toEqual(['QUEUE_WAKE_STUCK'])
    expect(report.policy).toMatchObject({
      read_only: true,
      no_db_mutation: true,
      no_state_daemon_restart: true,
      no_launchctl_mutation: true,
      no_discord_live_write: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      no_live_smoke: true,
    })
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
  })

  test('separates transport failure from queue-processing readiness', () => {
    const report = buildQueueProcessingReadinessReport([
      botStatusRow(),
    ], runtimeReadiness({
      status: 'unloaded',
      launchd: {
        available: true,
        loaded: false,
        running: false,
        state: null,
        pid: null,
        last_exit_status: null,
      },
      process: {
        pid: null,
        command: null,
        cwd: null,
      },
    }), { now: new Date('2026-06-02T00:02:00.000Z') })

    expect(report.ok).toBe(false)
    expect(report.transport_readiness.ready).toBe(false)
    expect(report.transport_readiness.blocker_codes).toEqual(['STATE_DAEMON_TRANSPORT_NOT_READY'])
    expect(report.queue_processing_readiness.ready).toBe(true)
    expect(report.queue_processing_readiness.blocker_codes).toEqual([])
  })

  test('fails closed when live daemon cannot run or scope target queue agents', () => {
    const report = buildQueueProcessingReadinessReport([
      botStatusRow({
        agent_id: 'check',
        pending_count: 2,
        oldest_pending_at: '2026-06-02T00:00:00.000Z',
      }),
    ], runtimeReadiness({
      environment: {
        database_url: 'postgresql:///agent_comms?host=/tmp',
        codex_runner_enabled: '0',
        queue_work_scheduler_enabled: null,
        agent_allowlist: 'kodama',
        agent_denylist: 'ceo,test',
      },
    }), { now: new Date('2026-06-02T00:02:30.000Z') })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.queue_processing_readiness.runner_enabled).toBe(false)
    expect(report.queue_processing_readiness.agent_scope_blockers).toEqual([{
      agent_id: 'check',
      pending_count: 2,
      active_claim_count: 0,
      blocker_codes: ['STATE_DAEMON_RUNNER_DISABLED', 'STATE_DAEMON_AGENT_NOT_ALLOWLISTED'],
    }])
    expect(report.queue_processing_readiness.blocker_codes).toEqual([
      'STATE_DAEMON_RUNNER_DISABLED',
      'STATE_DAEMON_AGENT_NOT_ALLOWLISTED',
    ])
  })

  test('normalizes current bot_status rows without legacy wake-state fields', () => {
    const row = {
      ...botStatusRow({
        agent_id: 'check',
        pending_count: 2,
      }),
    } as any
    delete row.queue_wake_state
    const report = buildQueueProcessingReadinessReport([row], runtimeReadiness(), {
      now: new Date('2026-06-02T00:02:45.000Z'),
    })
    const text = formatQueueProcessingReadinessText(report)

    expect(report.ok).toBe(true)
    expect(report.queue_processing_readiness.active_claim_total).toBe(0)
    expect(report.queue_processing_readiness.wake_state_counts.pending_observed).toBe(1)
    expect(text).not.toContain('NaN')
    expect(text).toContain('Runners: ready=true')
  })

  test('text formatter exposes both transport and queue readiness without implying live smoke', () => {
    const report = buildQueueProcessingReadinessReport([botStatusRow()], runtimeReadiness(), {
      now: new Date('2026-06-02T00:03:00.000Z'),
    })
    const text = formatQueueProcessingReadinessText(report)

    expect(report.ok).toBe(true)
    expect(text).toContain('Transport: ready=true')
    expect(text).toContain('Queue: ready=true')
    expect(text).toContain('Mutation performed: false')
    expect(text).toContain('Restart performed: false')
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

  test('execute passes when queue row remains visible without TUI wake evidence', async () => {
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
      },
    })

    expect(report.ok).toBe(true)
    expect(report.result).toBe('pass')
    expect(report.smoke.evidence).toContain('message_queue row visible; TUI wake prompt injection disabled')
    expect(Array.from(db.queue.values())[0].status).toBe('pending')
    expect(db.audits).toHaveLength(1)
  })

  // The wake-state classifier (classifyQueueWakeState) was superseded by the
  // endpoint lease read model in NORM-022; its stuck-pattern test was removed
  // with it.
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

  test('execute reports queue visibility evidence without TUI runtime launch', async () => {
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
      expect(report.smoke.evidence).toContain('message_queue row visible; TUI wake prompt injection disabled')
      expect(tmux.sentKeys).toEqual([])

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
      expect(queue.rows[0].last_wake_attempt_at).toBeNull()
      expect(queue.rows[0].done_at).toBeNull()
      expect(queue.rows[0].replied_at).toBeNull()

      const status = await fetchBotStatusFromDb(pg)
      const row = status.get(agent)!
      expect(row.pending_count).toBe(1)
      // active_claim_count / queue_wake_state / latest_wake_progress_at were
      // removed with the wake-state classifier (NORM-022 endpoint lease read
      // model); pending visibility is the remaining DB-truth contract here.
      expect(row.health_state).toBe('healthy')
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
    // active_claim_count / queue_wake_state were removed with the wake-state
    // classifier; busy_active health_state above is the surviving signal that
    // an active claim suppresses wake escalation.
  })
})
