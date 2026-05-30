import { createHash, randomUUID } from 'node:crypto'
import type { DbAdapter } from './db'
import { buildChannelRegistrationReconcileReport } from './channel-registration-reconcile'

type SqlDialect = 'postgres' | 'sqlite'

/**
 * NORM-060 full-channel smoke runner (#582).
 *
 * Builds DB-backed evidence that each configured internal target channel can run
 * the full lifecycle `inbound -> agent_messages -> message_queue -> claim/processing
 * -> reply/done -> outbound terminal -> audit`, and classifies any gap using the
 * #581 / NORM-050 channel-registration-reconcile failure model (NOT an ad hoc
 * vocabulary).
 *
 * Modes:
 *  - `dry_run` (default): read-only. Observes existing DB rows and classifies the
 *    most recent observed lifecycle per target agent. No mutation.
 *  - `execute` (bounded): requires an explicit confirm hash matching the dry-run
 *    plan (mirrors the reconcile `--execute --confirm <plan_hash>` operator gate).
 *    Injects a controlled probe (normalized inbound `agent_messages` row + one
 *    `message_queue` row per expected target + a `smoke.full_channel_execute`
 *    audit row), then bounded-polls for terminal evidence within `timeoutMs`.
 *    Execute reports top-level channel/failure summary from a post-run evidence
 *    snapshot; the confirmed dry-run plan evidence is retained separately.
 *
 * The eight failure classes are pinned to the #591 contract:
 *  unregistered_channel | missing_member | offline_runtime | no_endpoint_lease |
 *  missing_delivery_owner | send_feedback_mismatch | timeout | duplicate_routing
 */

export type FullChannelSmokeMode = 'dry_run' | 'execute'
export type FullChannelSmokeStatus = 'pass' | 'incomplete' | 'blocked'

export type FullChannelSmokeFailureClass =
  | 'unregistered_channel'
  | 'missing_member'
  | 'offline_runtime'
  | 'no_endpoint_lease'
  | 'missing_delivery_owner'
  | 'send_feedback_mismatch'
  | 'timeout'
  | 'duplicate_routing'

export const FULL_CHANNEL_SMOKE_FAILURE_CLASSES: FullChannelSmokeFailureClass[] = [
  'unregistered_channel',
  'missing_member',
  'offline_runtime',
  'no_endpoint_lease',
  'missing_delivery_owner',
  'send_feedback_mismatch',
  'timeout',
  'duplicate_routing',
]

/** Evidence citation: which DB rows (or missing-row checks) produced a classification. */
export interface FullChannelSmokeEvidence {
  source_table: string
  /** number of matching rows; 0 means a missing-row check produced the classification */
  matched_rows: number
  cite: Record<string, unknown>
  recommended_action?: string
}

export interface FullChannelSmokeFailure {
  failure_class: FullChannelSmokeFailureClass
  channel_id: string
  target_agent_id: string | null
  detail: string
  evidence: FullChannelSmokeEvidence
}

export interface FullChannelSmokeLifecycle {
  inbound_message_id: string | null
  inbound_external_message_id: string | null
  inbound_observed: boolean
  normalized_agent_message: boolean
  queue_row_id: string | null
  queue_status: string | null
  queue_row_count: number
  claim_observed: boolean
  processing_observed: boolean
  terminal_state: string | null
  reply_message_id: string | null
  terminal_reached: boolean
  outbound_message_id: string | null
  outbound_status: string | null
  outbound_consumer_agent_id: string | null
  outbound_consumer_source: string | null
  outbound_projection_source: string | null
  outbound_projection_fallback_reason: string | null
  outbound_delivery_fallback_reason: string | null
  outbound_recipient_token_evidence: boolean
  outbound_direct_consumer_evidence: boolean
  outbound_terminal: boolean
  audit_event_types: string[]
}

export interface FullChannelSmokeTarget {
  agent_id: string
  is_member: boolean
  excluded: boolean
  excluded_reason: 'disabled_profile' | 'test_profile' | 'human_agent_no_queue' | null
  lifecycle: FullChannelSmokeLifecycle
  failures: FullChannelSmokeFailure[]
  status: FullChannelSmokeStatus
}

export interface FullChannelSmokeChannel {
  channel_id: string
  name: string | null
  external_id: string | null
  registered: boolean
  adapter_owner_agent_id: string | null
  member_count: number
  expected_target_agents: string[]
  excluded_agents: string[]
  targets: FullChannelSmokeTarget[]
  failures: FullChannelSmokeFailure[]
  status: FullChannelSmokeStatus
}

export interface FullChannelSmokeUnregisteredChannel {
  external_channel_id: string
  message_count: number
  latest_created_at: string | null
  audit_evidence_rows: number
  recommended_action: string
}

export interface FullChannelSmokeSummary {
  target_channels: number
  passed: number
  incomplete: number
  blocked: number
  excluded_agents: number
  failure_count: number
  failures_by_class: Record<FullChannelSmokeFailureClass, number>
  unregistered_channels: number
}

export interface FullChannelSmokeReport {
  ok: boolean
  mode: FullChannelSmokeMode
  generated_at: string
  run_id: string | null
  plan_hash: string
  error?: 'OPERATOR_APPROVAL_REQUIRED'
  policy: {
    dry_run_default: true
    read_only: boolean
    execute_requires_confirm_plan_hash: true
    consumes_norm_050_failure_model: true
    excludes_disabled_test_by_default: true
    failure_classes: FullChannelSmokeFailureClass[]
    smoke_requires: string[]
  }
  options: {
    provider: string
    window_hours: number
    timeout_ms: number
    include_disabled: boolean
    include_test: boolean
    external_channel_id: string | null
  }
  summary: FullChannelSmokeSummary
  channels: FullChannelSmokeChannel[]
  unregistered_channels: FullChannelSmokeUnregisteredChannel[]
  failures: FullChannelSmokeFailure[]
  execute?: {
    run_id: string
    injected_targets: Array<{ channel_id: string; agent_id: string; message_id: string; queue_row_id: string | null }>
    timed_out_targets: Array<{ channel_id: string; agent_id: string }>
    polls: number
    initial_plan_summary: FullChannelSmokeSummary
    initial_plan_failures: FullChannelSmokeFailure[]
    post_run_summary: FullChannelSmokeSummary
    post_run_failures: FullChannelSmokeFailure[]
  }
}

export interface FullChannelSmokeOptions {
  provider?: string
  windowHours?: number
  externalChannelId?: string | null
  includeDisabled?: boolean
  includeTest?: boolean
  mode?: FullChannelSmokeMode
  confirmPlanHash?: string | null
  timeoutMs?: number
  /** Probe operator identity recorded on injected inbound rows (execute mode). */
  operatorAgentId?: string
  /** Injected clock (ms). Defaults to Date.now. Lets tests pin time. */
  nowMs?: () => number
  /** Injected bounded sleep. Defaults to setTimeout. Lets tests run instantly. */
  sleepMs?: (ms: number) => Promise<void>
  /** SQL dialect for execute-mode array params. Defaults to active adapter env. */
  sqlDialect?: SqlDialect
}

const RECONCILE_ACTION = 'agent-com channel reconcile --provider discord --dry-run'
const CLAIMED_QUEUE_STATUSES = new Set(['received', 'in_progress', 'read', 'done', 'replied'])
const PROCESSING_QUEUE_STATUSES = new Set(['in_progress', 'done', 'replied'])
const TERMINAL_QUEUE_STATUSES = new Set(['done', 'replied'])
const LIVE_RUNTIME_STATUSES = new Set(['active', 'idle', 'online', 'running'])
const ACTIVE_LEASE_PURPOSES = new Set(['inbound', 'outbound', 'worker'])

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

function asCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((v) => v.trim()).filter(Boolean)
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean)
  } catch {}
  return trimmed.split(',').map((v) => v.trim()).filter(Boolean)
}

function isTestAgentId(agentId: string): boolean {
  return /^__.*__$/.test(agentId)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultSqlDialect(): SqlDialect {
  const explicit = process.env.AGENT_COM_DB
  if (explicit === 'sqlite') return 'sqlite'
  if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres'
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite'
}

function stringArrayParam(values: string[], dialect: SqlDialect): unknown {
  return dialect === 'sqlite' ? JSON.stringify(values) : values
}

function buildSyntheticProbeContent(runId: string, channelId: string): string {
  return [
    `NORM-060 full-channel smoke ${runId} for ${channelId}.`,
    'Synthetic probe: no reply is required.',
    'For this claimed queue row, call the agent-comms processing tool for the queue_id, then call the agent-comms done tool for the same queue_id.',
    'Do not send a reply.',
  ].join(' ')
}

function classify(failures: FullChannelSmokeFailure[], incomplete: boolean): FullChannelSmokeStatus {
  if (failures.length > 0) return 'blocked'
  if (incomplete) return 'incomplete'
  return 'pass'
}

/** A table or column may not exist in a partially-migrated env; degrade to [] not throw. */
function missingOptionalSurface(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /(does not exist|no such table|no such column|column .* does not exist)/i.test(message)
}

async function queryOptional<T = any>(db: DbAdapter, sql: string, params?: any[]): Promise<T[]> {
  try {
    return await db.query<T>(sql, params)
  } catch (err) {
    if (missingOptionalSurface(err)) return []
    throw err
  }
}

// --- agent-level evidence maps (queried once, indexed by agent_id) ---

interface AgentEvidence {
  registered: boolean
  live_runtime: boolean
  worker_activity: boolean
  active_lease: boolean
  active_endpoint: boolean
  disabled: boolean
  test: boolean
  human: boolean
}

async function buildAgentEvidence(db: DbAdapter): Promise<Map<string, AgentEvidence>> {
  const map = new Map<string, AgentEvidence>()
  const agents = await queryOptional<any>(
    db,
    `SELECT agent_id, status, agent_type,
            COALESCE(profile_enabled, true) AS profile_enabled,
            disabled_at, metadata
       FROM agents
      ORDER BY agent_id`,
  )
  for (const row of agents) {
    const agentId = String(row.agent_id)
    const metadata = parseJsonObject(row.metadata)
    const disabled =
      row.profile_enabled === false ||
      row.profile_enabled === 0 ||
      row.disabled_at != null ||
      String(row.status ?? '') === 'disabled'
    const test =
      isTestAgentId(agentId) ||
      String(row.agent_type ?? '') === 'test' ||
      metadata.test === true ||
      metadata.is_test === true
    const human = String(row.agent_type ?? '') === 'human'
    map.set(agentId, {
      registered: true,
      live_runtime: false,
      worker_activity: false,
      active_lease: false,
      active_endpoint: false,
      disabled,
      test,
      human,
    })
  }

  const ensure = (agentId: string): AgentEvidence => {
    let entry = map.get(agentId)
    if (!entry) {
      entry = {
        registered: false,
        live_runtime: false,
        worker_activity: false,
        active_lease: false,
        active_endpoint: false,
        disabled: false,
        test: isTestAgentId(agentId),
        human: false,
      }
      map.set(agentId, entry)
    }
    return entry
  }

  const runtimes = await queryOptional<any>(
    db,
    `SELECT agent_id, status, stopped_at FROM agent_runtime_instances`,
  )
  for (const row of runtimes) {
    if (!row.stopped_at && LIVE_RUNTIME_STATUSES.has(String(row.status ?? ''))) {
      ensure(String(row.agent_id)).live_runtime = true
    }
  }

  const workers = await queryOptional<any>(
    db,
    `SELECT agent_id FROM worker_activity WHERE status IN ('running','idle','active')`,
  )
  for (const row of workers) ensure(String(row.agent_id)).worker_activity = true

  const leases = await queryOptional<any>(
    db,
    `SELECT holder_agent_id, lease_purpose
       FROM control_plane_leases
      WHERE status = 'active'
        AND expires_at > $1`,
    [new Date().toISOString()],
  )
  for (const row of leases) {
    const agentId = asString(row.holder_agent_id)
    if (agentId && ACTIVE_LEASE_PURPOSES.has(String(row.lease_purpose ?? ''))) ensure(agentId).active_lease = true
  }

  const endpoints = await queryOptional<any>(
    db,
    `SELECT agent_id FROM agent_endpoints WHERE status = 'active' AND disabled_at IS NULL`,
  )
  for (const row of endpoints) ensure(String(row.agent_id)).active_endpoint = true

  return map
}

/** Channels eligible to deliver outbound: active binding + active connector instance. */
async function buildChannelsWithDeliveryOwner(db: DbAdapter, provider: string): Promise<Set<string>> {
  const rows = await queryOptional<any>(
    db,
    `SELECT DISTINCT b.channel_id AS channel_id
       FROM channel_connector_bindings b
       JOIN connector_instances ci
         ON ci.connector_instance_id = b.connector_instance_id
        AND ci.status IN ('registered','active')
      WHERE b.provider = $1
        AND b.binding_role IN ('outbound','bidirectional')
        AND b.status = 'active'`,
    [provider],
  )
  return new Set(rows.map((row) => String(row.channel_id)))
}

async function queryTargetChannels(
  db: DbAdapter,
  provider: string,
  externalChannelId: string | null,
): Promise<any[]> {
  const params: any[] = [provider]
  let externalFilter = ''
  if (externalChannelId) {
    params.push(externalChannelId)
    externalFilter = `AND ca.external_id = $2`
  }
  return await db.query(
    `SELECT c.id AS channel_id, c.name, c.members, ca.external_id, p.adapter_owner_agent_id,
            p.primary_agent_id, p.outbound_allowlist
       FROM channels c
       JOIN channel_adapters ca
         ON ca.channel_id = c.id
        AND ca.platform = $1
       LEFT JOIN channel_routing_policy p
         ON p.channel_id = c.id
      ${externalFilter}
      ORDER BY c.name, c.id`,
    params,
  )
}

async function queryLatestInbound(
  db: DbAdapter,
  channelId: string,
  provider: string,
  cutoff: string,
): Promise<any | null> {
  return await db.queryOne(
    `SELECT id, channel_id, author_id, discord_message_id, input_mentions, created_at
       FROM agent_messages
      WHERE channel_id = $1
        AND source = $2
        AND direction = 'inbound'
        AND created_at >= $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [channelId, provider, cutoff],
  )
}

interface QueueRowEvidence {
  queueRowId: string | null
  status: string
  count: number
  claimed: boolean
  repliedWith: string | null
}

async function queryQueueRowsForAgent(
  db: DbAdapter,
  messageId: string,
  agentId: string,
): Promise<QueueRowEvidence[]> {
  const rows = await db.query(
    `SELECT status,
            COUNT(*) AS count,
            MAX(id) AS queue_row_id,
            MAX(CASE WHEN claimed_by IS NOT NULL OR claimed_at IS NOT NULL OR read_at IS NOT NULL THEN 1 ELSE 0 END) AS any_claimed,
            MAX(replied_with) AS replied_with
       FROM message_queue
      WHERE message_id = $1
        AND agent_id = $2
      GROUP BY status
      ORDER BY status`,
    [messageId, agentId],
  )
  return rows.map((row: any) => ({
    queueRowId: asString(row.queue_row_id),
    status: String(row.status),
    count: asCount(row.count),
    claimed: asCount(row.any_claimed) > 0,
    repliedWith: asString(row.replied_with),
  }))
}

async function queryOutboundForMessage(db: DbAdapter, messageId: string): Promise<any[]> {
  return await queryOptional<any>(
    db,
    `SELECT consumer_agent_id, consumer_source, channel_external_id, status, last_error,
            projection_source, projection_fallback_reason, delivery_fallback_reason,
            delivery_diagnostics, COUNT(*) AS count
       FROM outbound_queue
      WHERE message_id = $1
      GROUP BY consumer_agent_id, consumer_source, channel_external_id, status, last_error,
               projection_source, projection_fallback_reason, delivery_fallback_reason,
               delivery_diagnostics
      ORDER BY status`,
    [messageId],
  )
}

async function queryAuditEventTypes(
  db: DbAdapter,
  target: string,
  cutoff: string,
): Promise<Map<string, number>> {
  const rows = await queryOptional<any>(
    db,
    `SELECT event_type, COUNT(*) AS count
       FROM audit_log
      WHERE target = $1
        AND created_at >= $2
      GROUP BY event_type`,
    [target, cutoff],
  )
  const map = new Map<string, number>()
  for (const row of rows) map.set(String(row.event_type), asCount(row.count))
  return map
}

function failure(
  failure_class: FullChannelSmokeFailureClass,
  channel_id: string,
  target_agent_id: string | null,
  detail: string,
  evidence: FullChannelSmokeEvidence,
): FullChannelSmokeFailure {
  return { failure_class, channel_id, target_agent_id, detail, evidence }
}

function emptyFailureCounts(): Record<FullChannelSmokeFailureClass, number> {
  return {
    unregistered_channel: 0,
    missing_member: 0,
    offline_runtime: 0,
    no_endpoint_lease: 0,
    missing_delivery_owner: 0,
    send_feedback_mismatch: 0,
    timeout: 0,
    duplicate_routing: 0,
  }
}

function hasRecipientTokenEvidence(row: any): boolean {
  if (String(row.consumer_source ?? '') === 'recipient_token_evidence') return true
  const raw = row.delivery_diagnostics
  if (raw === null || raw === undefined) return false
  if (typeof raw === 'string') return raw.includes('recipient_token_evidence')
  try {
    return JSON.stringify(raw).includes('recipient_token_evidence')
  } catch {
    return false
  }
}

function isDirectProjectionSource(row: any): boolean {
  const source = asString(row.projection_source)
  return source !== null && !source.startsWith('fallback_')
}

function noFallback(value: unknown): boolean {
  return asString(value) === null
}

function directOutboundGaps(row: any): string[] {
  const gaps: string[] = []
  if (!isDirectProjectionSource(row)) gaps.push('projection_source_not_direct')
  if (!noFallback(row.projection_fallback_reason)) gaps.push('projection_fallback_reason_present')
  if (!noFallback(row.delivery_fallback_reason)) gaps.push('delivery_fallback_reason_present')
  if (!hasRecipientTokenEvidence(row)) gaps.push('recipient_token_evidence_missing')
  return gaps
}

function selectExpectedTargets(
  members: string[],
  agentEvidence: Map<string, AgentEvidence>,
  includeDisabled: boolean,
  includeTest: boolean,
): { expected: string[]; excluded: Array<{ agent_id: string; reason: NonNullable<FullChannelSmokeTarget['excluded_reason']> }> } {
  const expected: string[] = []
  const excluded: Array<{ agent_id: string; reason: NonNullable<FullChannelSmokeTarget['excluded_reason']> }> = []
  for (const member of members) {
    const ev = agentEvidence.get(member)
    if (ev?.human) {
      excluded.push({ agent_id: member, reason: 'human_agent_no_queue' })
      continue
    }
    if (ev?.disabled && !includeDisabled) {
      excluded.push({ agent_id: member, reason: 'disabled_profile' })
      continue
    }
    if (ev?.test && !includeTest) {
      excluded.push({ agent_id: member, reason: 'test_profile' })
      continue
    }
    expected.push(member)
  }
  return { expected, excluded }
}

async function evaluateTarget(
  db: DbAdapter,
  channel: { channel_id: string; external_id: string | null },
  agentId: string,
  latest: any | null,
  agentEvidence: Map<string, AgentEvidence>,
  channelsWithDeliveryOwner: Set<string>,
  provider: string,
  cutoff: string,
): Promise<FullChannelSmokeTarget> {
  const ev = agentEvidence.get(agentId)
  const failures: FullChannelSmokeFailure[] = []
  const lifecycle: FullChannelSmokeLifecycle = {
    inbound_message_id: latest?.id ? String(latest.id) : null,
    inbound_external_message_id: asString(latest?.discord_message_id),
    inbound_observed: latest != null,
    normalized_agent_message: latest != null,
    queue_row_id: null,
    queue_status: null,
    queue_row_count: 0,
    claim_observed: false,
    processing_observed: false,
    terminal_state: null,
    reply_message_id: null,
    terminal_reached: false,
    outbound_message_id: null,
    outbound_status: null,
    outbound_consumer_agent_id: null,
    outbound_consumer_source: null,
    outbound_projection_source: null,
    outbound_projection_fallback_reason: null,
    outbound_delivery_fallback_reason: null,
    outbound_recipient_token_evidence: false,
    outbound_direct_consumer_evidence: false,
    outbound_terminal: false,
    audit_event_types: [],
  }

  // --- runtime / lease evidence (independent of inbound observation) ---
  if (!ev?.live_runtime && !ev?.worker_activity) {
    failures.push(
      failure('offline_runtime', channel.channel_id, agentId, 'no live runtime heartbeat or worker activity', {
        source_table: 'agent_runtime_instances',
        matched_rows: 0,
        cite: { agent_id: agentId, live_runtime: false, worker_activity: false },
        recommended_action: 'agent-com runtime inventory --format json',
      }),
    )
  } else if (!ev.active_lease && !ev.active_endpoint) {
    failures.push(
      failure('no_endpoint_lease', channel.channel_id, agentId, 'runtime present but no active endpoint lease can accept receive/send work', {
        source_table: 'control_plane_leases',
        matched_rows: 0,
        cite: { agent_id: agentId, active_lease: false, active_endpoint: false },
        recommended_action: 'agent-com lease ... acquire / verify agent_endpoints',
      }),
    )
  }

  // --- delivery owner (outbound projection eligibility) ---
  if (!channelsWithDeliveryOwner.has(channel.channel_id)) {
    failures.push(
      failure('missing_delivery_owner', channel.channel_id, agentId, 'no connector-backed outbound delivery consumer is eligible for this channel', {
        source_table: 'channel_connector_bindings',
        matched_rows: 0,
        cite: { channel_id: channel.channel_id, provider },
        recommended_action: 'agent-com channel policy sync-connectors --channel ' + channel.channel_id,
      }),
    )
  }

  // --- lifecycle walk (requires an observed inbound message) ---
  if (latest?.id) {
    const messageId = String(latest.id)
    const queueRows = await queryQueueRowsForAgent(db, messageId, agentId)
    const totalRows = queueRows.reduce((sum, r) => sum + r.count, 0)
    lifecycle.queue_row_count = totalRows
    if (totalRows > 0) {
      // pick the most-progressed status for headline
      const headline =
        queueRows.find((r) => TERMINAL_QUEUE_STATUSES.has(r.status)) ??
        queueRows.find((r) => PROCESSING_QUEUE_STATUSES.has(r.status)) ??
        queueRows.find((r) => CLAIMED_QUEUE_STATUSES.has(r.status)) ??
        queueRows[0]
      lifecycle.queue_status = headline.status
      lifecycle.queue_row_id = headline.queueRowId ?? `${messageId}:${agentId}`
      lifecycle.claim_observed = queueRows.some((r) => r.claimed || CLAIMED_QUEUE_STATUSES.has(r.status))
      lifecycle.processing_observed = queueRows.some((r) => PROCESSING_QUEUE_STATUSES.has(r.status))
      const terminal = queueRows.find((r) => TERMINAL_QUEUE_STATUSES.has(r.status))
      lifecycle.terminal_state = terminal?.status ?? null
      lifecycle.terminal_reached = terminal != null
      lifecycle.reply_message_id = terminal?.repliedWith ?? null
    }

    // duplicate_routing: more than one queue row for the same (message, agent) beyond one-row-per-target
    if (totalRows > 1) {
      failures.push(
        failure('duplicate_routing', channel.channel_id, agentId, `${totalRows} message_queue rows for one (message_id, agent_id) target; expected one`, {
          source_table: 'message_queue',
          matched_rows: totalRows,
          cite: { message_id: messageId, agent_id: agentId, statuses: queueRows.map((r) => `${r.status}:${r.count}`) },
        }),
      )
    }

    // outbound + send feedback
    const outboundMessageId = lifecycle.reply_message_id ?? messageId
    lifecycle.outbound_message_id = outboundMessageId
    const outbound = await queryOutboundForMessage(db, outboundMessageId)
    const outboundForAgent = outbound.filter((row) => asString(row.consumer_agent_id) === agentId)
    const legacyNullConsumerOutbound = outbound.filter((row) => row.consumer_agent_id == null)
    const wrongConsumerSentOutbound = outbound.filter((row) => {
      const consumerAgentId = asString(row.consumer_agent_id)
      return String(row.status) === 'sent' && consumerAgentId !== null && consumerAgentId !== agentId
    })
    const relevantOutbound = outboundForAgent.length > 0 ? outboundForAgent : legacyNullConsumerOutbound
    if (relevantOutbound.length > 0 || wrongConsumerSentOutbound.length > 0) {
      const observedSent = relevantOutbound.find((row) => String(row.status) === 'sent')
      const directSent = outboundForAgent.find((row) => String(row.status) === 'sent')
      const wrongConsumerSent = wrongConsumerSentOutbound[0]
      const sent = directSent ?? observedSent ?? wrongConsumerSent
      lifecycle.outbound_status = sent ? 'sent' : String(relevantOutbound[0]?.status ?? wrongConsumerSent?.status)
      if (sent) {
        lifecycle.outbound_consumer_agent_id = asString(sent.consumer_agent_id)
        lifecycle.outbound_consumer_source = asString(sent.consumer_source)
        lifecycle.outbound_projection_source = asString(sent.projection_source)
        lifecycle.outbound_projection_fallback_reason = asString(sent.projection_fallback_reason)
        lifecycle.outbound_delivery_fallback_reason = asString(sent.delivery_fallback_reason)
        lifecycle.outbound_recipient_token_evidence = hasRecipientTokenEvidence(sent)
      }
      const directGaps = directSent ? directOutboundGaps(directSent) : []
      lifecycle.outbound_direct_consumer_evidence = directSent != null && directGaps.length === 0
      lifecycle.outbound_terminal = lifecycle.outbound_direct_consumer_evidence
      if (observedSent && !directSent) {
        failures.push(
          failure('send_feedback_mismatch', channel.channel_id, agentId, 'outbound terminal row lacks explicit direct consumer_agent_id for target agent', {
            source_table: 'outbound_queue',
            matched_rows: asCount(observedSent.count) || 1,
            cite: {
              message_id: outboundMessageId,
              inbound_message_id: messageId,
              reply_message_id: lifecycle.reply_message_id,
              expected_consumer_agent_id: agentId,
              observed_consumer_agent_id: asString(observedSent.consumer_agent_id),
            },
          }),
        )
      }
      if (wrongConsumerSentOutbound.length > 0) {
        const observedConsumers = [...new Set(wrongConsumerSentOutbound.map((row) => asString(row.consumer_agent_id)).filter((v): v is string => v != null))]
        failures.push(
          failure('send_feedback_mismatch', channel.channel_id, agentId, 'outbound sent row targets a different consumer_agent_id; relay/substitute rows are not direct consumer evidence', {
            source_table: 'outbound_queue',
            matched_rows: wrongConsumerSentOutbound.reduce((sum, row) => sum + (asCount(row.count) || 1), 0),
            cite: {
              message_id: outboundMessageId,
              inbound_message_id: messageId,
              reply_message_id: lifecycle.reply_message_id,
              expected_consumer_agent_id: agentId,
              observed_consumer_agent_ids: observedConsumers,
            },
          }),
        )
      }
      if (directSent && directGaps.length > 0) {
        failures.push(
          failure('send_feedback_mismatch', channel.channel_id, agentId, `direct outbound row missing no-relay evidence: ${directGaps.join(',')}`, {
            source_table: 'outbound_queue',
            matched_rows: asCount(directSent.count) || 1,
            cite: {
              message_id: outboundMessageId,
              inbound_message_id: messageId,
              reply_message_id: lifecycle.reply_message_id,
              consumer_agent_id: agentId,
              consumer_source: asString(directSent.consumer_source),
              projection_source: asString(directSent.projection_source),
              projection_fallback_reason: asString(directSent.projection_fallback_reason),
              delivery_fallback_reason: asString(directSent.delivery_fallback_reason),
              recipient_token_evidence: hasRecipientTokenEvidence(directSent),
            },
          }),
        )
      }
      // send_feedback_mismatch: terminal outbound but channel mismatch vs expected external id
      if (directSent && channel.external_id && asString(directSent.channel_external_id) && asString(directSent.channel_external_id) !== channel.external_id) {
        failures.push(
          failure('send_feedback_mismatch', channel.channel_id, agentId, 'outbound row reached terminal state but channel_external_id does not match the target channel', {
            source_table: 'outbound_queue',
            matched_rows: 1,
            cite: {
              message_id: outboundMessageId,
              inbound_message_id: messageId,
              reply_message_id: lifecycle.reply_message_id,
              expected_channel_external_id: channel.external_id,
              observed_channel_external_id: asString(directSent.channel_external_id),
            },
          }),
        )
      }
      // duplicate outbound paths for the same (message, channel)
      const outboundCount = relevantOutbound.reduce((sum, row) => sum + asCount(row.count), 0)
      if (outboundCount > 1) {
        failures.push(
          failure('duplicate_routing', channel.channel_id, agentId, `${outboundCount} outbound_queue rows for one logical target/message`, {
            source_table: 'outbound_queue',
            matched_rows: outboundCount,
            cite: { message_id: outboundMessageId, inbound_message_id: messageId, reply_message_id: lifecycle.reply_message_id, consumer_agent_id: agentId },
          }),
        )
      }
    }

    // audit evidence for send rejections / acl violations -> send_feedback_mismatch signal
    const auditTypes = await queryAuditEventTypes(db, channel.external_id ?? channel.channel_id, cutoff)
    lifecycle.audit_event_types = [...auditTypes.keys()].sort()
    const rejectionEvents = ['send_reject', 'outbound.acl_violation', 'queue_evidence_mismatch', 'owner_handoff.outbound_acl_blocked']
    const observedRejections = rejectionEvents.filter((e) => auditTypes.has(e))
    if (observedRejections.length > 0 && !failures.some((f) => f.failure_class === 'send_feedback_mismatch')) {
      failures.push(
        failure('send_feedback_mismatch', channel.channel_id, agentId, `send-feedback rejection audit observed: ${observedRejections.join(',')}`, {
          source_table: 'audit_log',
          matched_rows: observedRejections.reduce((sum, e) => sum + (auditTypes.get(e) ?? 0), 0),
          cite: { target: channel.external_id ?? channel.channel_id, event_types: observedRejections },
        }),
      )
    }
  }

  const incomplete =
    !lifecycle.inbound_observed ||
    lifecycle.queue_row_count === 0 ||
    !lifecycle.claim_observed ||
    !lifecycle.processing_observed ||
    !lifecycle.terminal_reached ||
    ((lifecycle.terminal_state === 'replied' || lifecycle.reply_message_id != null) && !lifecycle.outbound_terminal)

  return {
    agent_id: agentId,
    is_member: true,
    excluded: false,
    excluded_reason: null,
    lifecycle,
    failures,
    status: classify(failures, incomplete),
  }
}

async function buildChannelReports(
  db: DbAdapter,
  targets: any[],
  agentEvidence: Map<string, AgentEvidence>,
  channelsWithDeliveryOwner: Set<string>,
  options: {
    provider: string
    cutoff: string
    includeDisabled: boolean
    includeTest: boolean
  },
): Promise<FullChannelSmokeChannel[]> {
  const channels: FullChannelSmokeChannel[] = []
  for (const target of targets) {
    const channelId = String(target.channel_id)
    const externalId = asString(target.external_id)
    const members = toStringArray(target.members)
    const { expected, excluded } = selectExpectedTargets(members, agentEvidence, options.includeDisabled, options.includeTest)
    const channelFailures: FullChannelSmokeFailure[] = []

    const latest = await queryLatestInbound(db, channelId, options.provider, options.cutoff)
    const inputMentions = toStringArray(latest?.input_mentions)

    // missing_member: a mention or routing policy principal that is not a channel member
    const policyPrincipals = [asString(target.adapter_owner_agent_id), asString(target.primary_agent_id)].filter(
      (v): v is string => v != null,
    )
    const nonMemberMentions = inputMentions.filter((m) => !members.includes(m))
    const nonMemberPrincipals = policyPrincipals.filter((p) => !members.includes(p))
    const nonMembers = [...new Set([...nonMemberMentions, ...nonMemberPrincipals])]
    if (nonMembers.length > 0) {
      channelFailures.push(
        failure('missing_member', channelId, null, `intended target(s) not in channel membership: ${nonMembers.join(',')}`, {
          source_table: 'channels.members / channel_routing_policy',
          matched_rows: 0,
          cite: { channel_id: channelId, non_member_mentions: nonMemberMentions, non_member_principals: nonMemberPrincipals },
        }),
      )
    }

    const targetRecords: FullChannelSmokeTarget[] = []
    for (const agentId of expected) {
      const record = await evaluateTarget(
        db,
        { channel_id: channelId, external_id: externalId },
        agentId,
        latest,
        agentEvidence,
        channelsWithDeliveryOwner,
        options.provider,
        options.cutoff,
      )
      targetRecords.push(record)
    }
    for (const ex of excluded) {
      targetRecords.push({
        agent_id: ex.agent_id,
        is_member: true,
        excluded: true,
        excluded_reason: ex.reason,
        lifecycle: {
          inbound_message_id: null,
          inbound_external_message_id: null,
          inbound_observed: false,
          normalized_agent_message: false,
          queue_row_id: null,
          queue_status: null,
          queue_row_count: 0,
          claim_observed: false,
          processing_observed: false,
          terminal_state: null,
          reply_message_id: null,
          terminal_reached: false,
          outbound_message_id: null,
          outbound_status: null,
          outbound_consumer_agent_id: null,
          outbound_consumer_source: null,
          outbound_projection_source: null,
          outbound_projection_fallback_reason: null,
          outbound_delivery_fallback_reason: null,
          outbound_recipient_token_evidence: false,
          outbound_direct_consumer_evidence: false,
          outbound_terminal: false,
          audit_event_types: [],
        },
        failures: [],
        status: 'incomplete',
      })
    }

    const channelStatus = classify(
      [...channelFailures, ...targetRecords.flatMap((t) => (t.excluded ? [] : t.failures))],
      targetRecords.some((t) => !t.excluded && t.status === 'incomplete'),
    )

    channels.push({
      channel_id: channelId,
      name: asString(target.name),
      external_id: externalId,
      registered: true,
      adapter_owner_agent_id: asString(target.adapter_owner_agent_id),
      member_count: members.length,
      expected_target_agents: expected,
      excluded_agents: excluded.map((e) => e.agent_id),
      targets: targetRecords,
      failures: channelFailures,
      status: channelStatus,
    })
  }
  return channels
}

function unregisteredChannelFailure(u: FullChannelSmokeUnregisteredChannel): FullChannelSmokeFailure {
  return failure('unregistered_channel', u.external_channel_id, null, 'channel observed inbound but absent from channels/channel_adapters', {
    source_table: 'channels / channel_adapters',
    matched_rows: 0,
    cite: { external_channel_id: u.external_channel_id, inbound_channel_unregistered_audit_rows: u.audit_evidence_rows },
    recommended_action: RECONCILE_ACTION,
  })
}

function summarizeReportState(
  channels: FullChannelSmokeChannel[],
  unregistered: FullChannelSmokeUnregisteredChannel[],
): { summary: FullChannelSmokeSummary; failures: FullChannelSmokeFailure[] } {
  const channelFailures = [
    ...channels.flatMap((c) => c.failures),
    ...channels.flatMap((c) => c.targets.flatMap((t) => (t.excluded ? [] : t.failures))),
  ]
  const unregisteredFailures = unregistered.map(unregisteredChannelFailure)
  const failuresByClass = emptyFailureCounts()
  for (const f of channelFailures) failuresByClass[f.failure_class]++
  failuresByClass.unregistered_channel += unregistered.length

  const excludedAgents = channels.reduce((sum, c) => sum + c.excluded_agents.length, 0)

  return {
    summary: {
      target_channels: channels.length,
      passed: channels.filter((c) => c.status === 'pass').length,
      incomplete: channels.filter((c) => c.status === 'incomplete').length,
      blocked: channels.filter((c) => c.status === 'blocked').length,
      excluded_agents: excludedAgents,
      failure_count: channelFailures.length + unregistered.length,
      failures_by_class: failuresByClass,
      unregistered_channels: unregistered.length,
    },
    failures: [...unregisteredFailures, ...channelFailures],
  }
}

export async function buildFullChannelSmokeReport(
  db: DbAdapter,
  options: FullChannelSmokeOptions = {},
): Promise<FullChannelSmokeReport> {
  const provider = (options.provider ?? 'discord').trim().toLowerCase()
  const windowHours = options.windowHours ?? 168
  const externalChannelId = options.externalChannelId?.trim() || null
  const includeDisabled = options.includeDisabled === true
  const includeTest = options.includeTest === true
  const mode: FullChannelSmokeMode = options.mode === 'execute' ? 'execute' : 'dry_run'
  const timeoutMs = Math.max(0, options.timeoutMs ?? 30_000)
  const nowMs = options.nowMs ?? (() => Date.now())
  const sleepMs = options.sleepMs ?? defaultSleep
  const operatorAgentId = options.operatorAgentId ?? 'codex-aun'
  const sqlDialect = options.sqlDialect ?? defaultSqlDialect()
  const cutoff = new Date(nowMs() - windowHours * 60 * 60 * 1000).toISOString()

  const agentEvidence = await buildAgentEvidence(db)
  const channelsWithDeliveryOwner = await buildChannelsWithDeliveryOwner(db, provider)
  const targets = await queryTargetChannels(db, provider, externalChannelId)

  // --- unregistered channels: consume the #581/NORM-050 reconcile model directly ---
  const unregistered: FullChannelSmokeUnregisteredChannel[] = []
  const reconcile = await buildChannelRegistrationReconcileReport(db, {
    provider,
    windowHours,
    externalChannelId,
    dryRun: true,
  })
  const observedUnregistered = [
    ...reconcile.planned.map((p) => ({ id: p.external_channel_id, count: p.observations.message_count, latest: p.observations.latest_created_at })),
    ...reconcile.skipped
      .filter((s) => s.reason !== 'already_registered')
      .map((s) => ({ id: s.external_channel_id, count: 0, latest: null })),
  ]
  for (const obs of observedUnregistered) {
    const auditRows = await queryOptional<any>(
      db,
      `SELECT COUNT(*) AS count FROM audit_log WHERE event_type = 'inbound.channel_unregistered' AND target = $1`,
      [obs.id],
    )
    unregistered.push({
      external_channel_id: obs.id,
      message_count: obs.count,
      latest_created_at: obs.latest,
      audit_evidence_rows: asCount(auditRows[0]?.count),
      recommended_action: RECONCILE_ACTION,
    })
  }

  // --- evaluate each registered target channel ---
  let channels = await buildChannelReports(db, targets, agentEvidence, channelsWithDeliveryOwner, {
    provider,
    cutoff,
    includeDisabled,
    includeTest,
  })
  const initialPlanState = summarizeReportState(channels, unregistered)
  const injectedTargets: NonNullable<FullChannelSmokeReport['execute']>['injected_targets'] = []
  const timedOutTargets: NonNullable<FullChannelSmokeReport['execute']>['timed_out_targets'] = []

  // --- plan hash over the observed plan (channels + expected targets) ---
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({
        provider,
        window_hours: windowHours,
        external_channel_id: externalChannelId,
        include_disabled: includeDisabled,
        include_test: includeTest,
        channels: channels.map((c) => ({ channel_id: c.channel_id, external_id: c.external_id, expected: c.expected_target_agents })),
        unregistered: unregistered.map((u) => u.external_channel_id),
      }),
    )
    .digest('hex')

  let ok = true
  let error: FullChannelSmokeReport['error']
  let runId: string | null = null
  let executePolls: number | null = null

  if (mode === 'execute') {
    if (options.confirmPlanHash !== planHash) {
      ok = false
      error = 'OPERATOR_APPROVAL_REQUIRED'
    } else {
      runId = `norm060-${randomUUID()}`
      const polls = await runBoundedExecute(db, {
        runId,
        provider,
        channels,
        operatorAgentId,
        timeoutMs,
        nowMs,
        sleepMs,
        sqlDialect,
        injectedTargets,
        timedOutTargets,
      })
      executePolls = polls

      // Re-read after injection/polling so execute reports the final observed
      // lifecycle, not the dry-run snapshot that was only used for approval.
      channels = await buildChannelReports(db, targets, agentEvidence, channelsWithDeliveryOwner, {
        provider,
        cutoff,
        includeDisabled,
        includeTest,
      })

      // Bounded-poll timeouts are post-run failures only when the final
      // evidence snapshot still has not reached terminal state.
      for (const t of timedOutTargets) {
        const channel = channels.find((c) => c.channel_id === t.channel_id)
        const record = channel?.targets.find((r) => r.agent_id === t.agent_id)
        if (record?.lifecycle.terminal_reached) continue
        const fail = failure('timeout', t.channel_id, t.agent_id, `bounded execute probe did not reach terminal evidence within ${timeoutMs}ms`, {
          source_table: 'message_queue',
          matched_rows: 0,
          cite: { run_id: runId, channel_id: t.channel_id, agent_id: t.agent_id, timeout_ms: timeoutMs },
        })
        if (record) {
          record.failures.push(fail)
          record.status = 'blocked'
        } else if (channel) {
          channel.failures.push(fail)
        }
        if (channel) {
          channel.status = classify(
            [...channel.failures, ...channel.targets.flatMap((r) => (r.excluded ? [] : r.failures))],
            channel.targets.some((r) => !r.excluded && r.status === 'incomplete'),
          )
        }
      }
    }
  }

  const finalState = summarizeReportState(channels, unregistered)
  const executeBlock = runId && executePolls != null
    ? {
        run_id: runId,
        injected_targets: injectedTargets,
        timed_out_targets: timedOutTargets,
        polls: executePolls,
        initial_plan_summary: initialPlanState.summary,
        initial_plan_failures: initialPlanState.failures,
        post_run_summary: finalState.summary,
        post_run_failures: finalState.failures,
      }
    : undefined

  return {
    ok,
    mode,
    generated_at: new Date(nowMs()).toISOString(),
    run_id: runId,
    plan_hash: planHash,
    ...(error ? { error } : {}),
    policy: {
      dry_run_default: true,
      read_only: mode === 'dry_run',
      execute_requires_confirm_plan_hash: true,
      consumes_norm_050_failure_model: true,
      excludes_disabled_test_by_default: true,
      failure_classes: FULL_CHANNEL_SMOKE_FAILURE_CLASSES,
      smoke_requires: [
        'agent_messages.source=provider direction=inbound (inbound source evidence)',
        'normalized agent_messages row',
        'message_queue row per expected target agent',
        'claim/received + processing transition evidence',
        'terminal reply/done state evidence',
        'outbound terminal evidence when reply path exercised',
        'explicit consumer_agent_id for intended consumer; consumer_agent_id IS NULL is not direct evidence',
        'wrong-consumer/relay sent rows are explicit send_feedback_mismatch evidence, not direct success',
        'no projection/delivery fallback masking and recipient_token_evidence for the intended consumer',
        'audit evidence for reconcile/registration failures and terminal exceptions',
      ],
    },
    options: {
      provider,
      window_hours: windowHours,
      timeout_ms: timeoutMs,
      include_disabled: includeDisabled,
      include_test: includeTest,
      external_channel_id: externalChannelId,
    },
    summary: finalState.summary,
    channels,
    unregistered_channels: unregistered,
    failures: finalState.failures,
    ...(executeBlock ? { execute: executeBlock } : {}),
  }
}

interface BoundedExecuteContext {
  runId: string
  provider: string
  channels: FullChannelSmokeChannel[]
  operatorAgentId: string
  timeoutMs: number
  nowMs: () => number
  sleepMs: (ms: number) => Promise<void>
  sqlDialect: SqlDialect
  injectedTargets: NonNullable<FullChannelSmokeReport['execute']>['injected_targets']
  timedOutTargets: NonNullable<FullChannelSmokeReport['execute']>['timed_out_targets']
}

/**
 * Bounded execute: inject one controlled probe per channel (normalized inbound
 * agent_messages row + one message_queue row per expected target + a
 * smoke.full_channel_execute audit row), then poll for terminal evidence within
 * `timeoutMs`. Any target not terminal by the deadline is classified `timeout`.
 * Returns the number of poll iterations performed.
 */
async function runBoundedExecute(db: DbAdapter, ctx: BoundedExecuteContext): Promise<number> {
  const POLL_INTERVAL_MS = 1_000
  // 1. inject probes in a single transaction
  const probes: Array<{ channelId: string; messageId: string; agentIds: string[] }> = []
  await db.transaction(async (tx) => {
    for (const channel of ctx.channels) {
      const expected = channel.targets.filter((t) => !t.excluded).map((t) => t.agent_id)
      if (expected.length === 0) continue
      const messageId = randomUUID()
      const content = buildSyntheticProbeContent(ctx.runId, channel.channel_id)
      const metadata = {
        smoke_run_id: ctx.runId,
        norm: 'NORM-060',
        synthetic: true,
        no_reply_required: true,
        expected_terminal_state: 'done',
      }
      const payload = {
        smoke_run_id: ctx.runId,
        content,
        author_id: ctx.operatorAgentId,
        no_reply_required: true,
        expected_terminal_state: 'done',
      }
      await tx.execute(
        `INSERT INTO agent_messages (id, channel_id, source, direction, role, author_id, content, input_mentions, metadata, created_at)
         VALUES ($1, $2, $3, 'inbound', 'user', $4, $5, $6, $7, $8)`,
        [
          messageId,
          channel.channel_id,
          ctx.provider,
          ctx.operatorAgentId,
          content,
          stringArrayParam(expected, ctx.sqlDialect),
          JSON.stringify(metadata),
          new Date(ctx.nowMs()).toISOString(),
        ],
      )
      for (const agentId of expected) {
        await tx.execute(
          `INSERT INTO message_queue (agent_id, message_id, payload, status)
           VALUES ($1, $2, $3, 'pending')`,
          [agentId, messageId, JSON.stringify(payload)],
        )
        ctx.injectedTargets.push({ channel_id: channel.channel_id, agent_id: agentId, message_id: messageId, queue_row_id: null })
      }
      await tx.execute(
        `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
         VALUES ('smoke.full_channel_execute', $1, $2, $3, 'default')`,
        [
          ctx.operatorAgentId,
          channel.channel_id,
          JSON.stringify({ run_id: ctx.runId, provider: ctx.provider, expected_targets: expected, message_id: messageId }),
        ],
      )
      probes.push({ channelId: channel.channel_id, messageId, agentIds: expected })
    }
  })

  // 2. bounded poll for terminal evidence
  const deadline = ctx.nowMs() + ctx.timeoutMs
  const pending = new Set(ctx.injectedTargets.map((t) => `${t.message_id}::${t.agent_id}`))
  let polls = 0
  while (true) {
    polls++
    for (const probe of probes) {
      const rows = await db.query(
        `SELECT agent_id, status FROM message_queue WHERE message_id = $1`,
        [probe.messageId],
      )
      for (const row of rows) {
        const key = `${probe.messageId}::${String(row.agent_id)}`
        if (TERMINAL_QUEUE_STATUSES.has(String(row.status))) pending.delete(key)
      }
    }
    if (pending.size === 0) break
    if (ctx.nowMs() >= deadline) break
    await ctx.sleepMs(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - ctx.nowMs())))
  }

  for (const key of pending) {
    const [messageId, agentId] = key.split('::')
    const probe = probes.find((p) => p.messageId === messageId)
    if (probe) ctx.timedOutTargets.push({ channel_id: probe.channelId, agent_id: agentId })
  }
  return polls
}

export function formatFullChannelSmokeText(report: FullChannelSmokeReport): string {
  const lines = [
    'NORM-060 Full-Channel Smoke',
    `Generated: ${report.generated_at}`,
    `Mode: ${report.mode}${report.run_id ? ` run_id=${report.run_id}` : ''} read_only=${report.policy.read_only}`,
    `Plan hash: ${report.plan_hash}`,
    `Provider: ${report.options.provider} window=${report.options.window_hours}h timeout=${report.options.timeout_ms}ms`,
    `Targets: ${report.summary.target_channels} pass=${report.summary.passed} incomplete=${report.summary.incomplete} blocked=${report.summary.blocked} excluded_agents=${report.summary.excluded_agents}`,
    `Failures: ${report.summary.failure_count} (${Object.entries(report.summary.failures_by_class)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(', ') || 'none'})`,
    '',
  ]
  if (report.error === 'OPERATOR_APPROVAL_REQUIRED') {
    lines.push(`Error: ${report.error}; rerun with --execute --confirm ${report.plan_hash}`, '')
  }
  for (const channel of report.channels) {
    const name = channel.name ?? channel.channel_id
    lines.push(`- ${name} (${channel.channel_id}): ${channel.status} members=${channel.member_count} targets=${channel.expected_target_agents.join(',') || 'none'}`)
    if (channel.excluded_agents.length > 0) lines.push(`  excluded=${channel.excluded_agents.join(',')}`)
    for (const t of channel.targets) {
      if (t.excluded) continue
      const lc = t.lifecycle
      const chain = `inbound=${lc.inbound_observed ? 'y' : 'n'} queue=${lc.queue_row_count} claim=${lc.claim_observed ? 'y' : 'n'} proc=${lc.processing_observed ? 'y' : 'n'} term=${lc.terminal_state ?? 'n'} out=${lc.outbound_status ?? 'n'} direct=${lc.outbound_direct_consumer_evidence ? 'y' : 'n'}`
      const fails = t.failures.map((f) => f.failure_class).join(',') || 'ok'
      lines.push(`    ${t.agent_id}: ${t.status} [${chain}] ${fails}`)
    }
    for (const f of channel.failures) lines.push(`    ! ${f.failure_class}: ${f.detail}`)
  }
  if (report.unregistered_channels.length > 0) {
    lines.push('', 'Unregistered channels:')
    for (const u of report.unregistered_channels) {
      lines.push(`- ${u.external_channel_id}: msgs=${u.message_count} audit=${u.audit_evidence_rows} -> ${u.recommended_action}`)
    }
  }
  if (report.execute?.timed_out_targets.length) {
    lines.push('', 'Timed out targets:')
    for (const t of report.execute.timed_out_targets) lines.push(`- ${t.channel_id}/${t.agent_id}`)
  }
  return `${lines.join('\n')}\n`
}
