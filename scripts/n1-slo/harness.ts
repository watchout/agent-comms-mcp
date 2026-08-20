import { randomUUID } from 'node:crypto'

export const N1_PROBE_MESSAGE_TYPE = 'probe' as const
export const N1_PROBE_SCHEMA_VERSION = 'aun-n1-slo-probe/v1' as const
export const N1_REPORT_SCHEMA_VERSION = 'aun-n1-slo-report/v1' as const
export const N1_ACTIVE_SEAT_QUERY_VERSION = 'agents-idle-busy-valid-runtime-endpoint-lease/v2' as const
export const N1_PROBE_PREFIX = '[AUN-N1-SLO-PROBE/v1]'
export const N1_OBSERVATION_WINDOW_MS = 5_000
export const N1_PROBE_PRIORITY = -1_000_000

export interface N1Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>
}

export interface N1ActiveSeat {
  agent_id: string
  runtime_instance_id: string
  lease_id: string
  lease_expires_at: string
}

export type N1FailureStage = 'claim' | 'close'

export interface N1SeatResult {
  agent_id: string
  runtime_instance_id: string
  lease_id: string
  message_id: string
  queue_id: string
  sent_at: string
  claimed_at: string | null
  closed_at: string
  rtt_ms: number
  outcome: 'success' | 'retry_exhausted'
  failure_type: 'RETRY_EXHAUSTED' | null
  failure_stage: N1FailureStage | null
  observation_window_ms: number
}

export interface N1MeasurementReport {
  schema_version: typeof N1_REPORT_SCHEMA_VERSION
  report_id: string
  run_id: string
  generated_at: string
  source_commit: string
  control_source: 'https://github.com/watchout/agent-comms-mcp/issues/602'
  active_seat_query_version: typeof N1_ACTIVE_SEAT_QUERY_VERSION
  observation_window_ms: number
  verdict: 'PASS' | 'FAIL' | 'NO_DATA'
  summary: {
    active_seat_count: number
    success_count: number
    failure_count: number
    success_rate: number | null
    p50_rtt_ms: number | null
    p95_rtt_ms: number | null
    max_rtt_ms: number | null
  }
  effects: {
    internal_probe_rows_created: number
    terminal_done_rows: number
    residual_nonterminal_probe_rows: number
    outbound_queue_rows: number
    provider_effect_count: 0
    discord_visible_send_count: number
  }
  results: N1SeatResult[]
}

interface ProbeRef {
  runId: string
  agentId: string
  runtimeInstanceId: string
  leaseId: string
  messageId: string
  queueId: string
  content: string
  sentAt: string
  observationWindowMs: number
  startedMonotonicMs: number
}

interface ProbeState {
  status: string
  claimed_at: string | null
  done_at: string | null
}

export interface N1ProbeProcessorContext {
  probe: Readonly<ProbeRef>
  claim(): Promise<boolean>
  close(): Promise<boolean>
}

export type N1ProbeProcessor = (context: N1ProbeProcessorContext) => Promise<void>

export interface RunN1MeasurementOptions {
  sourceCommit: string
  runId?: string
  observationWindowMs?: number
  pollIntervalMs?: number
  now?: () => Date
  monotonicNow?: () => number
  sleep?: (ms: number) => Promise<void>
  processor?: N1ProbeProcessor
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)
  return Number(sorted[index]!.toFixed(3))
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function listCanonicalActiveSeats(
  db: N1Queryable,
  observedAt: Date = new Date(),
): Promise<N1ActiveSeat[]> {
  const result = await db.query(
    `SELECT DISTINCT ON (a.agent_id)
            a.agent_id,
            ri.runtime_instance_id::text AS runtime_instance_id,
            lease.lease_id::text AS lease_id,
            lease.expires_at
       FROM agents a
       JOIN control_plane_leases lease
         ON lease.holder_agent_id = a.agent_id
        AND lease.lease_scope_type = 'runtime_instance'
        AND lease.lease_purpose = 'worker'
        AND lease.status = 'active'
        AND lease.expires_at > $1
       JOIN agent_runtime_instances ri
         ON ri.runtime_instance_id = lease.holder_runtime_instance_id
        AND ri.runtime_instance_id::text = lease.lease_scope_id
        AND ri.agent_id = a.agent_id
      WHERE a.status IN ('idle', 'busy')
      ORDER BY a.agent_id, lease.expires_at DESC, lease.fencing_token DESC`,
    [observedAt.toISOString()],
  )
  return result.rows.map(row => ({
    agent_id: String(row.agent_id),
    runtime_instance_id: String(row.runtime_instance_id),
    lease_id: String(row.lease_id),
    lease_expires_at: iso(row.expires_at),
  }))
}

async function inTransaction<T>(db: N1Queryable, operation: () => Promise<T>): Promise<T> {
  await db.query('BEGIN')
  try {
    const result = await operation()
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function sendProbe(
  db: N1Queryable,
  seat: N1ActiveSeat,
  runId: string,
  observationWindowMs: number,
  monotonicNow: () => number,
): Promise<ProbeRef> {
  const messageId = randomUUID()
  const content = `${N1_PROBE_PREFIX}:${runId}:${seat.agent_id}`
  const metadata = {
    n1_slo: {
      schema_version: N1_PROBE_SCHEMA_VERSION,
      run_id: runId,
      agent_id: seat.agent_id,
      runtime_instance_id: seat.runtime_instance_id,
      lease_id: seat.lease_id,
      observation_window_ms: observationWindowMs,
      outcome: 'pending',
      provider_effect_count: 0,
      discord_visible_send_count: 0,
    },
  }
  const payload = {
    schema_version: N1_PROBE_SCHEMA_VERSION,
    message_type: N1_PROBE_MESSAGE_TYPE,
    run_id: runId,
    from: seat.agent_id,
    to: seat.agent_id,
    content,
    no_op: true,
  }
  const startedMonotonicMs = monotonicNow()
  return await inTransaction(db, async () => {
    const insertedMessage = await db.query(
      `INSERT INTO agent_messages
         (id, channel_id, author_id, author_bot, content, message_type,
          metadata, source, direction, role)
       VALUES ($1, NULL, $2, true, $3, $4, $5::jsonb, 'agent-comms', 'internal', 'system')
       RETURNING created_at`,
      [messageId, seat.agent_id, content, N1_PROBE_MESSAGE_TYPE, JSON.stringify(metadata)],
    )
    const insertedQueue = await db.query(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING
       RETURNING id::text AS id`,
      [seat.agent_id, messageId, JSON.stringify(payload), N1_PROBE_PRIORITY],
    )
    if (insertedMessage.rows.length !== 1 || insertedQueue.rows.length !== 1) {
      throw new Error('N1_PROBE_SEND_NOT_INSERTED')
    }
    return {
      runId,
      agentId: seat.agent_id,
      runtimeInstanceId: seat.runtime_instance_id,
      leaseId: seat.lease_id,
      messageId,
      queueId: String(insertedQueue.rows[0]!.id),
      content,
      sentAt: iso(insertedMessage.rows[0]!.created_at),
      observationWindowMs,
      startedMonotonicMs,
    }
  })
}

async function claimProbe(db: N1Queryable, probe: ProbeRef): Promise<boolean> {
  const result = await db.query(
    `UPDATE message_queue mq
        SET status = 'received',
            read_at = clock_timestamp(),
            claimed_by = $3,
            claimed_at = clock_timestamp(),
            claim_expires_at = clock_timestamp() + ($4::int * interval '1 millisecond')
       FROM agent_messages am
      WHERE mq.id = $1::bigint
        AND mq.message_id = $2
        AND mq.agent_id = $3
        AND mq.status = 'pending'
        AND am.id::text = mq.message_id
        AND am.message_type = 'probe'
        AND am.author_id = mq.agent_id
        AND am.content = $5
        AND am.metadata->'n1_slo'->>'schema_version' = $6
        AND am.metadata->'n1_slo'->>'run_id' = $7
      RETURNING mq.id`,
    [probe.queueId, probe.messageId, probe.agentId, probe.observationWindowMs, probe.content, N1_PROBE_SCHEMA_VERSION, probe.runId],
  )
  return result.rows.length === 1
}

async function closeProbe(db: N1Queryable, probe: ProbeRef): Promise<boolean> {
  const result = await db.query(
    `UPDATE message_queue mq
        SET status = 'done',
            done_at = clock_timestamp(),
            claimed_by = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL
       FROM agent_messages am
      WHERE mq.id = $1::bigint
        AND mq.message_id = $2
        AND mq.agent_id = $3
        AND mq.status = 'received'
        AND mq.claimed_by = $3
        AND am.id::text = mq.message_id
        AND am.message_type = 'probe'
        AND am.author_id = mq.agent_id
        AND am.content = $4
        AND am.metadata->'n1_slo'->>'schema_version' = $5
        AND am.metadata->'n1_slo'->>'run_id' = $6
      RETURNING mq.id`,
    [probe.queueId, probe.messageId, probe.agentId, probe.content, N1_PROBE_SCHEMA_VERSION, probe.runId],
  )
  return result.rows.length === 1
}

const defaultProcessor: N1ProbeProcessor = async ({ claim, close }) => {
  if (!await claim()) return
  await close()
}

async function readProbeState(db: N1Queryable, probe: ProbeRef): Promise<ProbeState> {
  const result = await db.query(
    `SELECT mq.status, mq.claimed_at, mq.done_at
       FROM message_queue mq
       JOIN agent_messages am ON am.id::text = mq.message_id
      WHERE mq.id = $1::bigint
        AND mq.message_id = $2
        AND mq.agent_id = $3
        AND am.message_type = 'probe'
        AND am.author_id = mq.agent_id
        AND am.content = $4
        AND am.metadata->'n1_slo'->>'schema_version' = $5
        AND am.metadata->'n1_slo'->>'run_id' = $6`,
    [probe.queueId, probe.messageId, probe.agentId, probe.content, N1_PROBE_SCHEMA_VERSION, probe.runId],
  )
  if (result.rows.length !== 1) throw new Error('N1_PROBE_ROW_NOT_FOUND')
  const row = result.rows[0]!
  return {
    status: String(row.status),
    claimed_at: row.claimed_at ? iso(row.claimed_at) : null,
    done_at: row.done_at ? iso(row.done_at) : null,
  }
}

async function observeProbe(
  db: N1Queryable,
  probe: ProbeRef,
  monotonicNow: () => number,
  sleep: (ms: number) => Promise<void>,
  pollIntervalMs: number,
): Promise<{ state: ProbeState; exhausted: boolean }> {
  const deadline = probe.startedMonotonicMs + probe.observationWindowMs
  let state = await readProbeState(db, probe)
  while (state.status !== 'done' && monotonicNow() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - monotonicNow())))
    state = await readProbeState(db, probe)
  }
  return { state, exhausted: state.status !== 'done' || monotonicNow() > deadline }
}

async function finalizeProbeMetadata(
  db: N1Queryable,
  probe: ProbeRef,
  result: N1SeatResult,
): Promise<void> {
  const n1Slo = {
    schema_version: N1_PROBE_SCHEMA_VERSION,
    run_id: probe.runId,
    agent_id: probe.agentId,
    runtime_instance_id: probe.runtimeInstanceId,
    lease_id: probe.leaseId,
    observation_window_ms: probe.observationWindowMs,
    outcome: result.outcome,
    failure_type: result.failure_type,
    failure_stage: result.failure_stage,
    sent_at: result.sent_at,
    claimed_at: result.claimed_at,
    closed_at: result.closed_at,
    rtt_ms: result.rtt_ms,
    provider_effect_count: 0,
    discord_visible_send_count: 0,
  }
  await db.query(
    `UPDATE agent_messages
        SET metadata = jsonb_build_object('n1_slo', $2::jsonb)
      WHERE id = $1::uuid
        AND message_type = 'probe'
        AND author_id = $3
        AND content = $4`,
    [probe.messageId, JSON.stringify(n1Slo), probe.agentId, probe.content],
  )
}

async function cleanupProbeToDone(db: N1Queryable, probe: ProbeRef): Promise<ProbeState> {
  await db.query(
    `UPDATE message_queue mq
        SET status = 'done',
            done_at = COALESCE(mq.done_at, clock_timestamp()),
            claimed_by = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            replied_with = NULL
       FROM agent_messages am
      WHERE mq.id = $1::bigint
        AND mq.message_id = $2
        AND mq.agent_id = $3
        AND am.id::text = mq.message_id
        AND am.message_type = 'probe'
        AND am.author_id = mq.agent_id
        AND am.content = $4
        AND am.metadata->'n1_slo'->>'schema_version' = $5
        AND am.metadata->'n1_slo'->>'run_id' = $6`,
    [probe.queueId, probe.messageId, probe.agentId, probe.content, N1_PROBE_SCHEMA_VERSION, probe.runId],
  )
  return await readProbeState(db, probe)
}

async function runSeatProbe(
  db: N1Queryable,
  seat: N1ActiveSeat,
  runId: string,
  options: Required<Pick<RunN1MeasurementOptions,
    'observationWindowMs' | 'pollIntervalMs' | 'monotonicNow' | 'sleep' | 'processor'>>,
): Promise<N1SeatResult> {
  const probe = await sendProbe(db, seat, runId, options.observationWindowMs, options.monotonicNow)
  try {
    let claimedAt: string | null = null
    void options.processor({
      probe,
      claim: async () => {
        const claimed = await claimProbe(db, probe)
        if (claimed) claimedAt = (await readProbeState(db, probe)).claimed_at
        return claimed
      },
      close: () => closeProbe(db, probe),
    }).catch(() => {})

    const observation = await observeProbe(
      db,
      probe,
      options.monotonicNow,
      options.sleep,
      options.pollIntervalMs,
    )
    const finalState = observation.exhausted
      ? await cleanupProbeToDone(db, probe)
      : observation.state
    const rttMs = Number(Math.max(0, options.monotonicNow() - probe.startedMonotonicMs).toFixed(3))
    const result: N1SeatResult = {
      agent_id: seat.agent_id,
      runtime_instance_id: seat.runtime_instance_id,
      lease_id: seat.lease_id,
      message_id: probe.messageId,
      queue_id: probe.queueId,
      sent_at: probe.sentAt,
      claimed_at: claimedAt ?? observation.state.claimed_at,
      closed_at: finalState.done_at ?? new Date().toISOString(),
      rtt_ms: rttMs,
      outcome: observation.exhausted ? 'retry_exhausted' : 'success',
      failure_type: observation.exhausted ? 'RETRY_EXHAUSTED' : null,
      failure_stage: observation.exhausted
        ? (observation.state.status === 'pending' ? 'claim' : 'close')
        : null,
      observation_window_ms: probe.observationWindowMs,
    }
    await finalizeProbeMetadata(db, probe, result)
    return result
  } catch (error) {
    try {
      await cleanupProbeToDone(db, probe)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'N1_PROBE_CLEANUP_FAILED')
    }
    throw error
  }
}

async function readRunEffects(db: N1Queryable, runId: string): Promise<N1MeasurementReport['effects']> {
  const result = await db.query(
    `WITH probes AS (
       SELECT am.id::text AS message_id
         FROM agent_messages am
        WHERE am.message_type = 'probe'
          AND am.metadata->'n1_slo'->>'schema_version' = $1
          AND am.metadata->'n1_slo'->>'run_id' = $2
     )
     SELECT
       (SELECT count(*)::int FROM probes) AS probe_count,
       (SELECT count(*)::int FROM message_queue mq JOIN probes p USING (message_id)
         WHERE mq.status = 'done') AS done_count,
       (SELECT count(*)::int FROM message_queue mq JOIN probes p USING (message_id)
         WHERE mq.status <> 'done') AS residual_count,
       (SELECT count(*)::int FROM outbound_queue oq JOIN probes p USING (message_id)) AS outbound_count,
       (SELECT count(*)::int FROM outbound_queue oq JOIN probes p USING (message_id)
         WHERE oq.status = 'sent' OR oq.discord_message_id IS NOT NULL) AS discord_count`,
    [N1_PROBE_SCHEMA_VERSION, runId],
  )
  const row = result.rows[0] ?? {}
  return {
    internal_probe_rows_created: Number(row.probe_count ?? 0),
    terminal_done_rows: Number(row.done_count ?? 0),
    residual_nonterminal_probe_rows: Number(row.residual_count ?? 0),
    outbound_queue_rows: Number(row.outbound_count ?? 0),
    provider_effect_count: 0,
    discord_visible_send_count: Number(row.discord_count ?? 0),
  }
}

export async function runN1Measurement(
  db: N1Queryable,
  options: RunN1MeasurementOptions,
): Promise<N1MeasurementReport> {
  if (!/^[0-9a-f]{40}$/i.test(options.sourceCommit)) throw new Error('N1_SOURCE_COMMIT_REQUIRED')
  const observationWindowMs = options.observationWindowMs ?? N1_OBSERVATION_WINDOW_MS
  if (!Number.isInteger(observationWindowMs) || observationWindowMs <= 0) {
    throw new Error('N1_OBSERVATION_WINDOW_INVALID')
  }
  const pollIntervalMs = options.pollIntervalMs ?? Math.min(50, observationWindowMs)
  const now = options.now ?? (() => new Date())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const sleep = options.sleep ?? sleepDefault
  const processor = options.processor ?? defaultProcessor
  const runId = options.runId ?? randomUUID()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('N1_RUN_ID_INVALID')
  }
  const seats = await listCanonicalActiveSeats(db, now())
  const results: N1SeatResult[] = []
  for (const seat of seats) {
    results.push(await runSeatProbe(db, seat, runId, {
      observationWindowMs,
      pollIntervalMs,
      monotonicNow,
      sleep,
      processor,
    }))
  }
  const effects = await readRunEffects(db, runId)
  if (effects.residual_nonterminal_probe_rows !== 0) throw new Error('N1_PROBE_RESIDUE_DETECTED')
  if (effects.outbound_queue_rows !== 0 || effects.discord_visible_send_count !== 0) {
    throw new Error('N1_PROTECTED_EFFECT_FENCE_VIOLATION')
  }
  const successful = results.filter(result => result.outcome === 'success')
  const rtts = successful.map(result => result.rtt_ms).sort((a, b) => a - b)
  const failureCount = results.length - successful.length
  return {
    schema_version: N1_REPORT_SCHEMA_VERSION,
    report_id: `EV-AUN-602-N1-SLO-MEASUREMENT-${runId}`,
    run_id: runId,
    generated_at: now().toISOString(),
    source_commit: options.sourceCommit.toLowerCase(),
    control_source: 'https://github.com/watchout/agent-comms-mcp/issues/602',
    active_seat_query_version: N1_ACTIVE_SEAT_QUERY_VERSION,
    observation_window_ms: observationWindowMs,
    verdict: results.length === 0 ? 'NO_DATA' : failureCount === 0 ? 'PASS' : 'FAIL',
    summary: {
      active_seat_count: results.length,
      success_count: successful.length,
      failure_count: failureCount,
      success_rate: results.length === 0 ? null : Number((successful.length / results.length).toFixed(6)),
      p50_rtt_ms: percentile(rtts, 0.5),
      p95_rtt_ms: percentile(rtts, 0.95),
      max_rtt_ms: rtts.length === 0 ? null : Number(rtts[rtts.length - 1]!.toFixed(3)),
    },
    effects,
    results,
  }
}
