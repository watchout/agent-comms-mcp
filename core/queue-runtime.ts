export interface QueueDaemonStatusOptions {
  staleSeconds?: number
}

export interface QueueDaemonStatusReport {
  ok: true
  generated_at: string
  daemon: {
    liveness_source: 'message_queue_observation'
    last_wake_attempt_at: string | null
    last_claim_heartbeat_at: string | null
    note: string
  }
  queue: {
    status_counts: Record<string, number>
    pending_count: number
    active_claim_count: number
    expired_claim_count: number
    stale_pending_count: number
    retired_or_offline_pending_count: number
    oldest_pending_at: string | null
  }
}

export interface QueueSmokeReadiness {
  ok: true
  dry_run: true
  agent_id: string
  safe_to_execute: boolean
  blockers: string[]
  checks: {
    agent_exists: boolean
    pending_count: number
    active_claim_count: number
    expired_claim_count: number
  }
  execute_command: string
}

export interface BootstrapQueueSmokeReport {
  ok: boolean
  run_id: string
  queue_id: string | null
  message_id: string
  enqueue_count: number
  claim_count: number
  terminal_outcome_count: number
  duplicate_effect_count: number
  external_effect_count: number
  final_status: string | null
  observer_pid: number
  consumer_pids: number[]
  claim_source: string
  runtime_instance_id: string
  reason_codes: string[]
}

export interface BootstrapQueueSmokeConsumerEvidence {
  pids: number[]
  exit_codes: number[]
  stdout_digests: string[]
}

export interface BootstrapQueueSmokeEnvelope {
  run_id: string
  queue_id: string
  message_id: string
  agent_id: string
  runtime_instance_id: string
  claim_source: string
  observer_pid: number
  created_at: string
  effect_baseline: {
    outbound: number
    d1_invocations: number
    d1_deliveries: number
  }
}

type BootstrapSmokeDb = {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>
  execute(sql: string, params?: any[]): Promise<{ rowCount: number }>
  transaction<T>(fn: (tx: BootstrapSmokeDb) => Promise<T>): Promise<T>
}

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

function isoOrNull(value: unknown): string | null {
  if (!value) return null
  const d = new Date(value as any)
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(value)
}

function formatSqlTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '+00')
}

async function oneNumber(db: Queryable, sql: string, params?: unknown[]): Promise<number> {
  const res = await db.query(sql, params)
  return Number(res.rows[0]?.count ?? res.rows[0]?.n ?? 0)
}

export async function buildQueueDaemonStatusReport(
  db: Queryable,
  options: QueueDaemonStatusOptions = {},
): Promise<QueueDaemonStatusReport> {
  const staleSeconds =
    Number.isFinite(options.staleSeconds) && (options.staleSeconds ?? 0) >= 0
      ? Number(options.staleSeconds)
      : 15 * 60
  const cutoff = formatSqlTimestamp(new Date(Date.now() - staleSeconds * 1000))

  const counts = await db.query(
    `SELECT status, count(*)::int AS count
       FROM message_queue
      GROUP BY status
      ORDER BY status`,
  )
  const aggregate = await db.query(
    `SELECT max(last_wake_attempt_at) AS last_wake_attempt_at,
            max(last_heartbeat_at) AS last_claim_heartbeat_at,
            min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
            count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
            count(*) FILTER (WHERE status IN ('received', 'in_progress'))::int AS active_claim_count,
            count(*) FILTER (
              WHERE status IN ('received', 'in_progress')
                AND claim_expires_at IS NOT NULL
                AND claim_expires_at < now()
            )::int AS expired_claim_count,
            count(*) FILTER (
              WHERE status = 'pending'
                AND created_at < $1
            )::int AS stale_pending_count
       FROM message_queue`,
    [cutoff],
  )
  const retiredOrOffline = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue mq
       LEFT JOIN agents a ON a.agent_id = mq.agent_id
      WHERE mq.status = 'pending'
        AND (
          a.agent_id IS NULL
          OR a.status = 'offline'
          OR a.metadata->>'retired' = 'true'
        )`,
  )

  const agg = aggregate.rows[0] ?? {}
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    daemon: {
      liveness_source: 'message_queue_observation',
      last_wake_attempt_at: isoOrNull(agg.last_wake_attempt_at),
      last_claim_heartbeat_at: isoOrNull(agg.last_claim_heartbeat_at),
      note: 'state_daemon has no dedicated heartbeat table yet; this reports the latest DB-visible wake/claim heartbeat evidence.',
    },
    queue: {
      status_counts: counts.rows.reduce((acc: Record<string, number>, row: any) => {
        acc[row.status] = Number(row.count)
        return acc
      }, {}),
      pending_count: Number(agg.pending_count ?? 0),
      active_claim_count: Number(agg.active_claim_count ?? 0),
      expired_claim_count: Number(agg.expired_claim_count ?? 0),
      stale_pending_count: Number(agg.stale_pending_count ?? 0),
      retired_or_offline_pending_count: retiredOrOffline,
      oldest_pending_at: isoOrNull(agg.oldest_pending_at),
    },
  }
}

export async function buildQueueSmokeReadiness(
  db: Queryable,
  agentId: string,
): Promise<QueueSmokeReadiness> {
  const agent = await db.query(
    `SELECT agent_id FROM agents WHERE agent_id = $1 LIMIT 1`,
    [agentId],
  )
  const pending = await oneNumber(
    db,
    `SELECT count(*)::int AS count FROM message_queue WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  )
  const active = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue
      WHERE agent_id = $1 AND status IN ('received', 'in_progress')`,
    [agentId],
  )
  const expired = await oneNumber(
    db,
    `SELECT count(*)::int AS count
       FROM message_queue
      WHERE agent_id = $1
        AND status IN ('received', 'in_progress')
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at < now()`,
    [agentId],
  )

  const blockers: string[] = []
  if (agent.rows.length === 0) blockers.push('agent_not_registered')
  if (active > 0) blockers.push('agent_has_active_claim')
  if (expired > 0) blockers.push('agent_has_expired_claim')

  return {
    ok: true,
    dry_run: true,
    agent_id: agentId,
    safe_to_execute: blockers.length === 0,
    blockers,
    checks: {
      agent_exists: agent.rows.length > 0,
      pending_count: pending,
      active_claim_count: active,
      expired_claim_count: expired,
    },
    execute_command: `agent-com queue smoke --agent-id ${agentId} --execute`,
  }
}

/** Producer boundary for the bootstrap smoke. It may only enqueue. */
export async function enqueueBootstrapQueueSmoke(
  db: BootstrapSmokeDb,
  input: { agentId: string; runId: string; messageId: string; runtimeInstanceId: string; observerPid: number; now?: Date },
): Promise<BootstrapQueueSmokeEnvelope> {
  const createdAt = (input.now ?? new Date()).toISOString()
  const claimSource = `aun-bootstrap:${input.runId}:${input.runtimeInstanceId}`
  const count = async (table: string) => Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0)
  const effectBaseline = {
    outbound: await count('outbound_queue').catch(() => 0),
    d1_invocations: await count('shirube_d1_invocations').catch(() => 0),
    d1_deliveries: await count('shirube_d1_effect_deliveries').catch(() => 0),
  }
  const inserted = await db.transaction(async (tx) => tx.query<{ id: string | number }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, $4)
         RETURNING id`,
        [
          input.agentId,
          input.messageId,
          JSON.stringify({
            schema_version: 'shirube-v3/aun-bootstrap-queue-smoke/v1',
            bootstrap_run_id: input.runId,
            agent_id: input.agentId,
            runtime_instance_id: input.runtimeInstanceId,
            observer_pid: input.observerPid,
            required_claim_source: claimSource,
            author_id: 'aun-bootstrap',
            message_type: 'report',
            content: 'Deterministic AUN bootstrap queue smoke. No external action is required.',
            next_action: 'none',
            protected_effect_allowed: false,
            no_reply_required: true,
          }),
          createdAt,
        ],
      ))
  const queueId = String(inserted[0]?.id ?? '')
  if (!queueId) throw new Error('queue insert returned no id')
  return {
    run_id: input.runId,
    queue_id: queueId,
    message_id: input.messageId,
    agent_id: input.agentId,
    runtime_instance_id: input.runtimeInstanceId,
    claim_source: claimSource,
    observer_pid: input.observerPid,
    created_at: createdAt,
    effect_baseline: effectBaseline,
  }
}

function parsePayload(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return value as Record<string, any>
  try { return JSON.parse(String(value ?? '{}')) } catch { return {} }
}

function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const text = String(value ?? '')
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  return new Date(normalized).getTime()
}

/** Observer boundary. It performs no queue lifecycle transition. */
export async function observeBootstrapQueueSmoke(
  db: BootstrapSmokeDb,
  envelope: BootstrapQueueSmokeEnvelope,
  consumer: BootstrapQueueSmokeConsumerEvidence,
): Promise<BootstrapQueueSmokeReport> {
  const rows = await db.query<any>(
    `SELECT id, message_id, payload, status, created_at, claimed_by, claimed_at,
            claim_expires_at, done_at
       FROM message_queue
      WHERE id = $1 AND agent_id = $2 AND message_id = $3`,
    [envelope.queue_id, envelope.agent_id, envelope.message_id],
  )
  const row = rows[0]
  const payload = parsePayload(row?.payload)
  const claimSource = String(payload?.receive_claim?.source ?? '')
  const terminalBaton = payload?.terminal_baton
  const duplicateRows = await db.query<{ n: string | number }>(
    'SELECT count(*) AS n FROM message_queue WHERE agent_id = $1 AND message_id = $2',
    [envelope.agent_id, envelope.message_id],
  ).catch(() => [{ n: rows.length }])
  const outboundRows = await db.query<{ n: string | number }>(
    'SELECT count(*) AS n FROM outbound_queue WHERE message_id = $1',
    [envelope.message_id],
  ).catch(() => [{ n: 0 }])
  const count = async (table: string) => Number((await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n ?? 0)
  const effectAfter = {
    outbound: await count('outbound_queue').catch(() => envelope.effect_baseline.outbound),
    d1_invocations: await count('shirube_d1_invocations').catch(() => envelope.effect_baseline.d1_invocations),
    d1_deliveries: await count('shirube_d1_effect_deliveries').catch(() => envelope.effect_baseline.d1_deliveries),
  }
  const enqueueCount = Number(duplicateRows[0]?.n ?? 0)
  const claimCount = row?.claimed_by === envelope.agent_id && row?.claimed_at ? 1 : 0
  const terminalCount = row?.status === 'done' && row?.done_at && terminalBaton?.no_reply_required === true ? 1 : 0
  const createdMs = timestampMs(row?.created_at ?? envelope.created_at)
  const doneMs = timestampMs(terminalBaton?.set_at ?? row?.done_at)
  const terminalWithinDeadline = Number.isFinite(createdMs) && Number.isFinite(doneMs)
    && doneMs >= createdMs && doneMs - createdMs <= 30_000
  const externalEffectCount = Number(outboundRows[0]?.n ?? 0)
    + Math.max(0, effectAfter.outbound - envelope.effect_baseline.outbound)
    + Math.max(0, effectAfter.d1_invocations - envelope.effect_baseline.d1_invocations)
    + Math.max(0, effectAfter.d1_deliveries - envelope.effect_baseline.d1_deliveries)
  const distinctConsumers = [...new Set(consumer.pids.filter((pid) => Number.isInteger(pid) && pid > 0))]
  const consumerOk = consumer.exit_codes.length === 3
    && consumer.exit_codes.every((code) => code === 0)
    && distinctConsumers.length > 0
    && !distinctConsumers.includes(envelope.observer_pid)
  const identityOk = claimSource === envelope.claim_source
    && payload?.bootstrap_run_id === envelope.run_id
    && payload?.runtime_instance_id === envelope.runtime_instance_id
    && payload?.agent_id === envelope.agent_id
  const ok = enqueueCount === 1
    && claimCount === 1
    && terminalCount === 1
    && terminalWithinDeadline
    && externalEffectCount === 0
    && consumerOk
    && identityOk
  const reasonCodes: string[] = []
  if (enqueueCount !== 1) reasonCodes.push('NO_GO_QUEUE_ENQUEUE')
  if (claimCount !== 1 || !consumerOk || !identityOk) reasonCodes.push('NO_GO_QUEUE_ORDINARY_RECEIVE_UNPROVEN')
  if (terminalCount !== 1 || !terminalWithinDeadline) reasonCodes.push('NO_GO_SMOKE_NOT_TERMINAL')
  if (externalEffectCount !== 0) reasonCodes.push('NO_GO_DUPLICATE_EFFECT')
  return {
    ok,
    run_id: envelope.run_id,
    queue_id: envelope.queue_id,
    message_id: envelope.message_id,
    enqueue_count: enqueueCount,
    claim_count: claimCount,
    terminal_outcome_count: terminalCount,
    duplicate_effect_count: Math.max(0, enqueueCount - 1),
    external_effect_count: externalEffectCount,
    final_status: row?.status ?? null,
    observer_pid: envelope.observer_pid,
    consumer_pids: distinctConsumers,
    claim_source: claimSource,
    runtime_instance_id: envelope.runtime_instance_id,
    reason_codes: reasonCodes,
  }
}

/**
 * Test/fixture composition of the separated producer, ordinary consumer, and
 * observer boundaries. Production bootstrap opens a fresh DB connection for
 * each boundary rather than calling this convenience wrapper.
 */
export async function runBootstrapQueueSmoke(
  db: BootstrapSmokeDb,
  input: {
    agentId: string
    runId: string
    messageId: string
    runtimeInstanceId: string
    observerPid: number
    consume: (envelope: BootstrapQueueSmokeEnvelope) => Promise<BootstrapQueueSmokeConsumerEvidence>
    now?: Date
  },
): Promise<BootstrapQueueSmokeReport> {
  const envelope = await enqueueBootstrapQueueSmoke(db, input)
  const consumer = await input.consume(envelope)
  return observeBootstrapQueueSmoke(db, envelope, consumer)
}
