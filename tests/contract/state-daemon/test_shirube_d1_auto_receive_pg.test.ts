import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { runAunRuntimeV2 } from '../../../core/aun-runtime-v2'
import {
  QUEUE_WORK_RESULT_VERSION,
  runReceivedQueueWork,
  type LlmRuntimeAdapter,
  type QueueWorkDb,
  type QueueWorkResult,
} from '../../../core/queue-work'
import { computeD1AuthorizationDigest } from '../../../core/shirube-d1-execution-adapter'
import {
  SHIRUBE_D1_RUNTIME_BINDING_VERSION,
  computeShirubeD1InvocationKey,
  type ShirubeD1RuntimeBinding,
} from '../../../core/shirube-d1-runtime'
import { makeDeliveryFixture } from '../../aun-k3/delivery-fixture'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const BASE_DATABASE_URL = process.env.AGENT_COM_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const tempDirs: string[] = []
const schemas: Array<{ base: Client; name: string }> = []

afterEach(async () => {
  while (schemas.length > 0) {
    const fixture = schemas.pop()!
    try { await fixture.base.query(`DROP SCHEMA IF EXISTS "${fixture.name}" CASCADE`) } catch {}
    try { await fixture.base.end() } catch {}
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function guardedBaseUrl(): string {
  if (!BASE_DATABASE_URL) throw new Error('AGENT_COM_TEST_DATABASE_URL is required')
  const parsed = new URL(BASE_DATABASE_URL)
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!/(?:test|fixture|shirube)/i.test(databaseName)) {
    throw new Error(`refusing non-test PostgreSQL database: ${databaseName}`)
  }
  return BASE_DATABASE_URL
}

function scopedUrl(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl)
  parsed.searchParams.set('options', `-c search_path=${schema},public`)
  return parsed.toString()
}

async function fixture(label: string): Promise<{ client: Client; url: string }> {
  const baseUrl = guardedBaseUrl()
  const schema = `d1_pg_${label}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  if (!/^[a-z0-9_]+$/.test(schema)) throw new Error(`unsafe schema: ${schema}`)
  const base = new Client({ connectionString: baseUrl })
  await base.connect()
  await base.query(`CREATE SCHEMA "${schema}"`)
  schemas.push({ base, name: schema })
  const url = scopedUrl(baseUrl, schema)
  const migration = spawnSync('bun', ['db/migrate.ts'], {
    cwd: ROOT,
    env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (migration.status !== 0) {
    throw new Error(`isolated PG migration failed: ${migration.stderr || migration.stdout}`)
  }
  const client = new Client({ connectionString: url })
  await client.connect()
  return { client, url }
}

function pgQueueDb(client: Client): QueueWorkDb {
  return {
    dialect: 'postgres',
    async query<T = any>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params)
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 }
    },
  }
}

async function insertReceivedLeaseRow(client: Client, suffix: string) {
  const inserted = await client.query<{
    id: string
    claimed_at: Date
    claim_expires_at: Date
  }>(
    `INSERT INTO message_queue (
       agent_id, message_id, payload, status, priority, created_at,
       claimed_by, claimed_at, claim_expires_at, last_heartbeat_at
     ) VALUES (
       'dev-001', $1, $2, 'received', 1, clock_timestamp(),
       'dev-001', date_trunc('milliseconds', clock_timestamp()),
       clock_timestamp() + INTERVAL '700 milliseconds', clock_timestamp()
     )
     RETURNING id::text, claimed_at, claim_expires_at`,
    [
      `lockwait-${suffix}-${randomUUID()}`,
      JSON.stringify({
        content: `lock wait ${suffix}`,
        author_id: 'lockwait-fixture',
        message_type: 'phase_handoff',
        receive_claim: { source: 'aun-runtime-v2' },
      }),
    ],
  )
  return inserted.rows[0]
}

const directCapabilities = {
  input: 'stdin_prompt',
  output: 'schema_json',
  supportsBareMode: true,
  supportsResume: false,
  supportsToolAllowlist: false,
  supportsSandbox: false,
  supportsUsageMetadata: false,
} as const

function directResult(): QueueWorkResult {
  return {
    schema_version: QUEUE_WORK_RESULT_VERSION,
    ok: true,
    summary: 'lock-wait regression result',
    reply: null,
    evidence: [],
    next_action: 'close',
  }
}

function authorization() {
  const unsigned = {
    control_source: 'https://github.com/watchout/ai-dev-framework/issues/556',
    handoff_id: 'CH-ACM-887-D1-AUTO-RECEIVE-CORRECTIVE-001-A2',
    exact_base_sha: 'bbc975a897fb57ee56f264902c10e69a97893108',
    allowed_paths: [
      'bin/aun/runtime-v2.ts',
      'core/aun-runtime-v2.ts',
      'core/queue-work.ts',
      'core/state-daemon/index.ts',
      'tests/aun-runtime-v2.test.ts',
      'tests/queue-work.test.ts',
      'tests/state-daemon-queue-work-scheduler.test.ts',
      'tests/contract/state-daemon/test_shirube_d1_auto_receive_pg.test.ts',
    ],
  }
  return { ...unsigned, authorization_digest: computeD1AuthorizationDigest(unsigned) }
}

function evidence() {
  return {
    adapter_head_sha: 'b'.repeat(40),
    independent_audit_ref: 'https://github.com/watchout/agent-comms-mcp/pull/891#issuecomment-audit',
    qa_ref: 'https://github.com/watchout/agent-comms-mcp/pull/891#issuecomment-qa',
    check_ref: 'https://github.com/watchout/agent-comms-mcp/pull/891#issuecomment-check',
    cto_go_ref: 'https://github.com/watchout/agent-comms-mcp/pull/891#issuecomment-cto',
  }
}

async function insertD1Queue(client: Client, agentState: 'missing' | 'offline' | 'ready') {
  if (agentState !== 'missing') {
    await client.query(
      `INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, metadata, profile_enabled)
       VALUES ('dev-001', 'dev-001', 'dev', 'codex', $1, '{}'::jsonb, true)`,
      [agentState === 'ready' ? 'idle' : 'offline'],
    )
  }
  const idResult = await client.query<{ id: string }>(
    `SELECT nextval(pg_get_serial_sequence('message_queue', 'id'))::text AS id`,
  )
  const queueId = idResult.rows[0].id
  const messageId = randomUUID()
  const target = {
    repository: 'watchout/agent-comms-mcp',
    agent_id: 'dev-001',
    control_source: authorization().control_source,
  }
  const binding: ShirubeD1RuntimeBinding = {
    schema_version: SHIRUBE_D1_RUNTIME_BINDING_VERSION,
    target,
    authorization: authorization(),
    activation_evidence: evidence(),
    allowed_effects: ['external_send'],
  }
  const invocationKey = computeShirubeD1InvocationKey(binding, queueId, 'external_send')
  const delivery = makeDeliveryFixture('provider_ack', `shirube-d1-pg-${queueId}`, 'fixture-mcp', `d1:${invocationKey}`)
  binding.external_event = {
    eventId: `d1:reply-enqueued:${invocationKey}`,
    eventType: 'reply.enqueued',
    seatId: delivery.unit.sender_seat_id,
    conversationId: delivery.unit.conversation_id,
    causationId: delivery.unit.causation_id,
    correlationId: delivery.unit.correlation_id,
    turnId: delivery.unit.turn_id,
    replyId: `d1:${invocationKey}`,
    payload: delivery.unit,
    loaded_registration: delivery.registration,
  }
  const payload = JSON.stringify({
    content: delivery.unit.content.text,
    author_id: 'external-target',
    message_type: 'phase_handoff',
    reply_contract: { required: true },
    shirube_v4_d1: binding,
  })
  return {
    queueId,
    invocationKey,
    binding,
    async insert() {
      await client.query(
        `INSERT INTO channels (id, name, type, members)
         VALUES ('d1-pg-channel', 'd1-pg-channel', 'channel', ARRAY['dev-001']::text[])
         ON CONFLICT (id) DO UPDATE SET members=EXCLUDED.members`,
      )
      await client.query(
        `INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, source)
         VALUES ($1::uuid, 'd1-pg-channel', 'external-target', 'D1 PostgreSQL fixture', 'phase_handoff', 'fixture')`,
        [messageId],
      )
      await client.query(
        `INSERT INTO message_queue (id, agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, 'dev-001', $2, $3, 'pending', 1, clock_timestamp())`,
        [queueId, messageId, payload],
      )
    },
  }
}

interface DaemonProcess {
  child: ChildProcess
  stdout: string
  stderr: string
}

function runnerScript(): string {
  return [
    "const { appendFileSync } = await import('node:fs');",
    "appendFileSync(process.env.D1_FIXTURE_COUNTER_FILE, 'started\\n');",
    'await Bun.sleep(Number(process.env.D1_FIXTURE_DELAY_MS));',
    "process.stdout.write(JSON.stringify({schema_version:'queue_work_result_v1',ok:true,",
    "summary:'pg production composition',reply:process.env.D1_FIXTURE_REPLY_TEXT,",
    "evidence:['semantic_outcome=reply','outcome_reason=pg_production_composition'],next_action:'reply'}));",
  ].join('')
}

function daemonEnv(input: {
  databaseUrl: string
  binding: ShirubeD1RuntimeBinding
  counterFile: string
  delayMs: number
  timeoutMs: number
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_COM_DB: 'postgres',
    DATABASE_URL: input.databaseUrl,
    STATE_DAEMON_POLL_SWEEP_INTERVAL_MS: '50',
    STATE_DAEMON_HEARTBEAT_INTERVAL_MS: '50',
    STATE_DAEMON_CLAIM_TTL_SEC: '1',
    STATE_DAEMON_BOT_LIVENESS_CHECK_INTERVAL_MS: '60000',
    STATE_DAEMON_GC_INTERVAL_MS: '60000',
    STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '0',
    SHIRUBE_D1_ENABLED: '1',
    SHIRUBE_D1_KILL_SWITCH: '0',
    SHIRUBE_D1_TARGET_ALLOWLIST: JSON.stringify([input.binding.target]),
    SHIRUBE_D1_AUTHORIZATION_DIGEST: input.binding.authorization.authorization_digest,
    SHIRUBE_D1_ADAPTER_HEAD_SHA: input.binding.activation_evidence.adapter_head_sha,
    SHIRUBE_D1_AUDIT_REF: input.binding.activation_evidence.independent_audit_ref,
    SHIRUBE_D1_QA_REF: input.binding.activation_evidence.qa_ref,
    SHIRUBE_D1_CHECK_REF: input.binding.activation_evidence.check_ref,
    SHIRUBE_D1_CTO_GO_REF: input.binding.activation_evidence.cto_go_ref,
    STATE_DAEMON_SHIRUBE_D1_RUNTIME: 'command-json',
    AUN_RUNTIME_V2_CLAIM_TTL_SECONDS: '1',
    AUN_QUEUE_WORK_TIMEOUT_MS: String(input.timeoutMs),
    AUN_QUEUE_WORK_COMMAND: 'bun',
    AUN_QUEUE_WORK_ARGS_JSON: JSON.stringify(['-e', runnerScript()]),
    D1_FIXTURE_COUNTER_FILE: input.counterFile,
    D1_FIXTURE_DELAY_MS: String(input.delayMs),
    D1_FIXTURE_REPLY_TEXT: input.binding.external_event?.payload.content.text ?? '',
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

async function startDaemon(env: NodeJS.ProcessEnv): Promise<DaemonProcess> {
  const state: DaemonProcess = {
    child: spawn('bun', ['bin/state-daemon.ts'], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    stdout: '',
    stderr: '',
  }
  state.child.stdout!.on('data', (chunk: Buffer) => { state.stdout += chunk.toString() })
  state.child.stderr!.on('data', (chunk: Buffer) => { state.stderr += chunk.toString() })
  await waitFor(() => state.stderr.includes('[state-daemon] started'), 8_000)
  return state
}

async function stopDaemon(proc: DaemonProcess, crash = false): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return
  const exited = new Promise<void>((resolvePromise) => proc.child.once('exit', () => resolvePromise()))
  if (crash) process.kill(-proc.child.pid!, 'SIGKILL')
  else proc.child.kill('SIGTERM')
  await Promise.race([
    exited,
    Bun.sleep(8_000).then(() => { throw new Error(`daemon failed to exit: ${proc.stderr}`) }),
  ])
}

function runnerStarts(path: string): number {
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8').split('\n').filter((line) => line === 'started').length
}

function metricCount(proc: DaemonProcess, name: string, labels: Record<string, string>): number {
  let total = 0
  for (const line of proc.stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed.metric?.name !== name) continue
      if (Object.entries(labels).every(([key, value]) => parsed.metric?.labels?.[key] === value)) {
        total += Number(parsed.metric.value ?? 0)
      }
    } catch {}
  }
  return total
}

async function queueStatus(client: Client, queueId: string): Promise<string | null> {
  const row = await client.query<{ status: string }>('SELECT status FROM message_queue WHERE id = $1', [queueId])
  return row.rows[0]?.status ?? null
}

async function assertSingleDurableEffect(client: Client, queueId: string, invocationKey: string): Promise<void> {
  const claim = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM shirube_d1_claims')
  const invocation = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM shirube_d1_invocations WHERE invocation_key = $1',
    [invocationKey],
  )
  const delivery = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM shirube_d1_effect_deliveries WHERE invocation_key = $1 AND status = \'completed\'',
    [invocationKey],
  )
  const event = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM event_log WHERE event_type = 'reply.enqueued' AND reply_id = $1`,
    [`d1:${invocationKey}`],
  )
  const terminal = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM message_queue WHERE id = $1 AND status = 'replied'`,
    [queueId],
  )
  expect(Number(claim.rows[0].n)).toBe(1)
  expect(Number(invocation.rows[0].n)).toBe(1)
  expect(Number(delivery.rows[0].n)).toBe(1)
  expect(Number(event.rows[0].n)).toBe(1)
  expect(Number(terminal.rows[0].n)).toBe(1)
}

describe('Shirube D1 state-daemon PostgreSQL production-composition lease safety', () => {
  test('missing/offline DB targets are blocked before claim, runner, or external effect', async () => {
    if (!BASE_DATABASE_URL) {
      expect(process.env.AGENT_COM_TEST_DATABASE_URL).toBeUndefined()
      expect(process.env.DATABASE_URL).toBeUndefined()
      return
    }
    for (const agentState of ['missing', 'offline'] as const) {
      const { client, url } = await fixture(agentState)
      const dir = mkdtempSync(join(tmpdir(), `shirube-d1-pg-${agentState}-`))
      tempDirs.push(dir)
      const counterFile = join(dir, 'runner-starts.log')
      let daemon: DaemonProcess | null = null
      try {
        const prepared = await insertD1Queue(client, agentState)
        const env = daemonEnv({
          databaseUrl: url,
          binding: prepared.binding,
          counterFile,
          delayMs: 10,
          timeoutMs: 5_000,
        })
        daemon = await startDaemon(env)
        // The only work trigger is the queue INSERT/trigger notification.
        await prepared.insert()
        await waitFor(() => daemon!.stderr.includes('DB automatic-processing authority blocked'))
        await stopDaemon(daemon)

        expect(await queueStatus(client, prepared.queueId)).toBe('pending')
        expect(runnerStarts(counterFile)).toBe(0)
        expect(metricCount(daemon, 'state_daemon_shirube_d1_auto_receive_total', { result: 'started' })).toBe(0)
        expect(metricCount(daemon, 'state_daemon_automatic_processing_blocked_total', {
          reason: agentState === 'missing' ? 'AGENT_NOT_ENROLLED' : 'RUNTIME_NOT_READY',
        })).toBeGreaterThan(0)
        expect(Number((await client.query<{ n: string }>('SELECT count(*)::text AS n FROM shirube_d1_claims')).rows[0].n)).toBe(0)
        expect(Number((await client.query<{ n: string }>('SELECT count(*)::text AS n FROM shirube_d1_invocations')).rows[0].n)).toBe(0)
        expect(Number((await client.query<{ n: string }>('SELECT count(*)::text AS n FROM shirube_d1_effect_deliveries')).rows[0].n)).toBe(0)
      } finally {
        if (daemon) await stopDaemon(daemon).catch(() => {})
        await client.end()
      }
    }
  }, 35_000)

  test('crash stops renewal, then exactly one expiry reclaim reaches one terminal durable effect', async () => {
    if (!BASE_DATABASE_URL) {
      expect(process.env.AGENT_COM_TEST_DATABASE_URL).toBeUndefined()
      expect(process.env.DATABASE_URL).toBeUndefined()
      return
    }
    const { client, url } = await fixture('crash')
    const dir = mkdtempSync(join(tmpdir(), 'shirube-d1-pg-crash-'))
    tempDirs.push(dir)
    const counterFile = join(dir, 'runner-starts.log')
    let first: DaemonProcess | null = null
    let restarted: DaemonProcess | null = null
    try {
      const prepared = await insertD1Queue(client, 'ready')
      const firstEnv = daemonEnv({
        databaseUrl: url,
        binding: prepared.binding,
        counterFile,
        delayMs: 10_000,
        timeoutMs: 20_000,
      })
      first = await startDaemon(firstEnv)
      await prepared.insert()
      await waitFor(async () => (
        runnerStarts(counterFile) === 1 && await queueStatus(client, prepared.queueId) === 'in_progress'
      ))
      await stopDaemon(first, true)
      const stoppedLease = await client.query<{ claim_expires_at: Date }>(
        'SELECT claim_expires_at FROM message_queue WHERE id = $1',
        [prepared.queueId],
      )
      await Bun.sleep(250)
      const unchangedLease = await client.query<{ claim_expires_at: Date }>(
        'SELECT claim_expires_at FROM message_queue WHERE id = $1',
        [prepared.queueId],
      )
      expect(unchangedLease.rows[0].claim_expires_at.toISOString()).toBe(
        stoppedLease.rows[0].claim_expires_at.toISOString(),
      )
      await waitFor(async () => {
        const row = await client.query<{ expired: boolean }>(
          'SELECT claim_expires_at < clock_timestamp() AS expired FROM message_queue WHERE id = $1',
          [prepared.queueId],
        )
        return row.rows[0]?.expired === true
      })

      restarted = await startDaemon(daemonEnv({
        databaseUrl: url,
        binding: prepared.binding,
        counterFile,
        delayMs: 50,
        timeoutMs: 5_000,
      }))
      try {
        await waitFor(() => queueStatus(client, prepared.queueId).then((status) => status === 'replied'))
      } catch (error) {
        const row = await client.query('SELECT status, claimed_by, claimed_at, claim_expires_at FROM message_queue WHERE id = $1', [prepared.queueId])
        throw new Error(JSON.stringify({ error: String(error), row: row.rows[0], stdout: restarted.stdout.slice(-4_000), stderr: restarted.stderr.slice(-4_000) }))
      }
      await stopDaemon(restarted)

      expect(runnerStarts(counterFile)).toBe(2)
      expect(metricCount(first, 'state_daemon_shirube_d1_auto_receive_total', { result: 'terminal' })).toBe(0)
      expect(metricCount(restarted, 'state_daemon_shirube_d1_auto_receive_total', { result: 'restart_reclaim' })).toBe(1)
      expect(metricCount(restarted, 'state_daemon_shirube_d1_auto_receive_total', { result: 'terminal' })).toBe(1)
      expect(restarted.stderr).not.toContain('[state-daemon] ALERT:')
      await assertSingleDurableEffect(client, prepared.queueId, prepared.invocationKey)
    } finally {
      if (first) await stopDaemon(first, true).catch(() => {})
      if (restarted) await stopDaemon(restarted).catch(() => {})
      await client.end()
    }
  }, 25_000)

  test('row-lock waits past expiry write neither runner_result nor runner_error nor terminal state', async () => {
    if (!BASE_DATABASE_URL) {
      expect(process.env.AGENT_COM_TEST_DATABASE_URL).toBeUndefined()
      expect(process.env.DATABASE_URL).toBeUndefined()
      return
    }
    const { client, url } = await fixture('lockwait_terminal')
    const locker = new Client({ connectionString: url })
    await locker.connect()
    let lockerTransactionOpen = false
    try {
      for (const mode of ['result', 'error'] as const) {
        const row = await insertReceivedLeaseRow(client, mode)
        let enteredAdapter!: () => void
        const adapterEntered = new Promise<void>((resolvePromise) => { enteredAdapter = resolvePromise })
        let releaseAdapter!: () => void
        const adapterGate = new Promise<void>((resolvePromise) => { releaseAdapter = resolvePromise })
        const adapter: LlmRuntimeAdapter = {
          runtime_id: `lockwait-${mode}`,
          capabilities: directCapabilities,
          async invoke() {
            enteredAdapter()
            await adapterGate
            if (mode === 'error') throw new Error('lockwait fixture failure')
            return directResult()
          },
        }

        const outcomePromise = runReceivedQueueWork(pgQueueDb(client), {
          queueId: row.id,
          adapter,
          claimFence: {
            claimedBy: 'dev-001',
            claimedAt: row.claimed_at.toISOString(),
          },
        })
        const entered = await Promise.race([
          adapterEntered.then(() => ({ entered: true as const })),
          outcomePromise.then((outcome) => ({ entered: false as const, outcome })),
        ])
        if (!entered.entered) throw new Error(`worker exited before adapter: ${JSON.stringify(entered.outcome)}`)

        await locker.query('BEGIN')
        lockerTransactionOpen = true
        await locker.query('SELECT id FROM message_queue WHERE id = $1 FOR UPDATE', [row.id])
        releaseAdapter()
        await waitFor(async () => {
          const expired = await locker.query<{ expired: boolean }>(
            'SELECT claim_expires_at < clock_timestamp() AS expired FROM message_queue WHERE id = $1',
            [row.id],
          )
          return expired.rows[0]?.expired === true
        })
        await locker.query('COMMIT')
        lockerTransactionOpen = false

        const outcome = await outcomePromise
        expect(outcome).toMatchObject({ ok: false, code: 'CLAIM_OWNERSHIP_LOST' })
        const persisted = await client.query<{
          status: string
          done_at: Date | null
          replied_at: Date | null
          payload: string
        }>(
          'SELECT status, done_at, replied_at, payload FROM message_queue WHERE id = $1',
          [row.id],
        )
        const payload = JSON.parse(persisted.rows[0].payload)
        expect(persisted.rows[0].status).toBe('in_progress')
        expect(persisted.rows[0].done_at).toBeNull()
        expect(persisted.rows[0].replied_at).toBeNull()
        expect(payload.runner_result).toBeUndefined()
        expect(payload.runner_error).toBeUndefined()
      }
    } finally {
      if (lockerTransactionOpen) await locker.query('ROLLBACK').catch(() => {})
      await locker.end()
      await client.end()
    }
  }, 15_000)

  test('lease renewal waiting past expiry cannot resurrect the exact claim', async () => {
    if (!BASE_DATABASE_URL) {
      expect(process.env.AGENT_COM_TEST_DATABASE_URL).toBeUndefined()
      expect(process.env.DATABASE_URL).toBeUndefined()
      return
    }
    const { client, url } = await fixture('lockwait_renewal')
    const locker = new Client({ connectionString: url })
    await locker.connect()
    let lockerTransactionOpen = false
    let releasePromise: Promise<void> | null = null
    let lockedExpiry: Date | null = null
    let leaseLockArmed = true
    try {
      const inserted = await client.query<{ id: string; message_id: string; created_at: Date }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ('dev-001', $1, $2, 'pending', 1, clock_timestamp())
         RETURNING id::text, message_id, created_at`,
        [
          `lockwait-renewal-${randomUUID()}`,
          JSON.stringify({
            content: 'renewal lock wait',
            author_id: 'lockwait-fixture',
            message_type: 'phase_handoff',
          }),
        ],
      )
      const queueId = inserted.rows[0].id
      const db: QueueWorkDb = {
        dialect: 'postgres',
        async query<T = any>(sql: string, params?: unknown[]) {
          const compact = sql.replace(/\s+/g, ' ').trim()
          if (
            leaseLockArmed
            && compact.startsWith('SELECT id FROM message_queue')
            && compact.includes('agent_id = $2')
            && compact.includes('FOR UPDATE')
          ) {
            leaseLockArmed = false
            await locker.query('BEGIN')
            lockerTransactionOpen = true
            const locked = await locker.query<{ claim_expires_at: Date }>(
              'SELECT claim_expires_at FROM message_queue WHERE id = $1 FOR UPDATE',
              [params?.[0]],
            )
            lockedExpiry = locked.rows[0].claim_expires_at
            releasePromise = (async () => {
              await waitFor(async () => {
                const expired = await locker.query<{ expired: boolean }>(
                  'SELECT claim_expires_at < clock_timestamp() AS expired FROM message_queue WHERE id = $1',
                  [params?.[0]],
                )
                return expired.rows[0]?.expired === true
              })
              await locker.query('COMMIT')
              lockerTransactionOpen = false
            })()
          }
          const result = await client.query(sql, params)
          return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 }
        },
      }
      let invoked = 0
      const outcome = await runAunRuntimeV2(db, {
        agentId: 'dev-001',
        queueId,
        messageId: inserted.rows[0].message_id,
        createdAfter: inserted.rows[0].created_at.toISOString(),
        claimTtlSeconds: 1,
        finalize: true,
        adapter: {
          runtime_id: 'must-not-run-after-expired-renewal',
          capabilities: directCapabilities,
          execution_timeout_ms: 5_000,
          supportsAbort: true,
          async invoke() {
            invoked += 1
            return directResult()
          },
        },
        d1Runtime: {
          policy: { enabled: true, kill_switch: false },
          allowsAgent(agentId: string | null) { return agentId === 'dev-001' },
          isEnrolledAgent(agentId: string | null) { return agentId === 'dev-001' },
          async prepareFinalizationSenders() { throw new Error('must not finalize') },
        } as any,
        env: {} as NodeJS.ProcessEnv,
      })
      if (releasePromise) await releasePromise

      expect(outcome).toMatchObject({
        ok: false,
        code: 'RUNNER_FAILED',
        runner: {
          ok: false,
          code: 'EXECUTION_ABORTED',
          detail: 'D1_EXECUTION_CLAIM_OWNERSHIP_LOST',
        },
      })
      expect(invoked).toBe(0)
      const persisted = await client.query<{
        status: string
        claim_expires_at: Date
        expired: boolean
        payload: string
      }>(
        `SELECT status, claim_expires_at,
                claim_expires_at < clock_timestamp() AS expired,
                payload
           FROM message_queue
          WHERE id = $1`,
        [queueId],
      )
      expect(persisted.rows[0].status).toBe('received')
      expect(persisted.rows[0].expired).toBe(true)
      expect(persisted.rows[0].claim_expires_at.toISOString()).toBe(lockedExpiry?.toISOString())
      const payload = JSON.parse(persisted.rows[0].payload)
      expect(payload.runner_result).toBeUndefined()
      expect(payload.runner_error).toBeUndefined()
    } finally {
      if (releasePromise) await releasePromise.catch(() => {})
      if (lockerTransactionOpen) await locker.query('ROLLBACK').catch(() => {})
      await locker.end()
      await client.end()
    }
  }, 15_000)
})
