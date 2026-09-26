import type { Client } from 'pg'
import { resolveSeatProvider } from './seat-runtime-selection'
import { resolveRuntimeEndpoint } from './runtime-endpoint'
import type { HostRuntimeInspector } from './host-runtime-observer'

export type BotHealthState =
  | 'unknown'
  | 'healthy'
  | 'busy_active'
  | 'busy_stuck'
  | 'crashed'
  | 'offline'

export interface BotStatusDbRow {
  agent_id: string
  agent_type: string | null
  profile_enabled: boolean | null
  disabled_at: string | null
  runtime: string | null
  observed_runtime_provider: string | null
  runtime_engine_preference: string | null
  status: string | null
  last_seen_at: string | null
  heartbeat_ok: boolean
  pending_count: number
  oldest_pending_at: string | null
  active_claim_count: number
  typed_failed_count: number
  health_state: BotHealthState
  active_connector_count: number
  runtime_linked_connector_count: number
  active_endpoint_lease_count: number
  endpoint_lease_state: 'not_applicable' | 'missing_runtime' | 'missing_lease' | 'ok'
  endpoint_lease_expires_at: string | null
  endpoint_lease_heartbeat_at: string | null
}

/** Queue/identity are durable. Runtime health is composed only after fresh OS + fence checks. */
const QUERY = `
WITH queue_status AS (
 SELECT mq.agent_id,
 COUNT(mq.id) FILTER (WHERE mq.status='pending') AS pending_count,
 MIN(mq.created_at) FILTER (WHERE mq.status='pending') AS oldest_pending_at,
 COUNT(mq.id) FILTER (WHERE mq.status IN ('received','in_progress') AND mq.claimed_by=mq.agent_id) AS active_claim_count,
 COUNT(mq.id) FILTER (WHERE mq.status='failed' AND mq.failed_reason IN ('WAKE_INVOCATION_RETRY_EXHAUSTED','QUEUE_WORK_RUNNER_ERROR_RETRY_EXHAUSTED')) AS typed_failed_count
 FROM message_queue mq GROUP BY mq.agent_id
)
SELECT a.agent_id,a.agent_type,a.profile_enabled,a.disabled_at,
 COALESCE(q.pending_count,0) AS pending_count,q.oldest_pending_at,
 COALESCE(q.active_claim_count,0) AS active_claim_count,COALESCE(q.typed_failed_count,0) AS typed_failed_count,
 (SELECT COUNT(*) FROM connector_instances ci WHERE ci.agent_id=a.agent_id AND ci.status='active') AS active_connector_count,
 (SELECT array_agg(ci.runtime_instance_id::text) FROM connector_instances ci WHERE ci.agent_id=a.agent_id AND ci.status='active') AS connector_runtime_ids
 FROM agents a LEFT JOIN queue_status q ON q.agent_id=a.agent_id
`

function parseCount(value: string | number): number {
  return typeof value === 'string' ? parseInt(value, 10) : value
}

export async function fetchBotStatusFromDb(client: Client, options:{inspect?:HostRuntimeInspector}={}): Promise<Map<string, BotStatusDbRow>> {
  const result = await client.query<{
    agent_id: string
    agent_type: string | null
    profile_enabled: boolean | null
    disabled_at: Date | null
    runtime: string | null
    runtime_engine_preference: string | null
    status: string | null
    typed_failed_count: string | number
    last_seen_at: Date | null
    heartbeat_ok: boolean
    pending_count: string | number
    oldest_pending_at: Date | null
    active_claim_count: string | number
    health_state: BotHealthState
    connector_runtime_ids?: Array<string|null>
    active_connector_count: string | number
    runtime_linked_connector_count: string | number
    active_endpoint_lease_count: string | number
    endpoint_lease_state: BotStatusDbRow['endpoint_lease_state']
    endpoint_lease_expires_at: Date | null
    endpoint_lease_heartbeat_at: Date | null
  }>(QUERY)
  const map = new Map<string, BotStatusDbRow>()
  for (const row of result.rows) {
    const provider=await resolveSeatProvider(client,{agentId:row.agent_id,inspect:options.inspect})
    const endpoint=provider.ok ? await resolveRuntimeEndpoint(client,{agentId:row.agent_id,
      runtimeInstanceId:provider.observation?.runtime_instance_id,inspect:options.inspect}) : null
    const observed=provider.ok && endpoint?.ok ? provider.observation : null
    const claims=parseCount(row.active_claim_count)
    const connectors=row.connector_runtime_ids ?? []
    const linked=connectors.filter(id=>id!==null).length
    const covered=observed?connectors.filter(id=>id===observed.runtime_instance_id).length:0
    const connectorCount=parseCount(row.active_connector_count)
    const coverageState=connectorCount>linked?'missing_runtime':connectorCount>covered?'missing_lease':endpoint?.ok?'ok':'missing_runtime'

    map.set(row.agent_id, {
      agent_id: row.agent_id,
      agent_type: row.agent_type ?? null,
      profile_enabled: row.profile_enabled ?? null,
      disabled_at: row.disabled_at ? row.disabled_at.toISOString() : null,
      runtime: observed?.provider ?? null,
      observed_runtime_provider: observed?.provider ?? null,
      runtime_engine_preference: null,
      status: observed ? (claims>0?'busy':'online') : 'unknown',
      typed_failed_count: parseCount(row.typed_failed_count),
      last_seen_at: observed?.observed_at ?? null,
      heartbeat_ok: Boolean(observed),
      pending_count: parseCount(row.pending_count),
      oldest_pending_at: row.oldest_pending_at ? row.oldest_pending_at.toISOString() : null,
      active_claim_count: parseCount(row.active_claim_count),
      health_state: observed ? (claims>0?'busy_active':'healthy') : 'unknown',
      active_connector_count: parseCount(row.active_connector_count),
      runtime_linked_connector_count: linked,
      active_endpoint_lease_count: endpoint?.ok ? Math.max(connectorCount?0:1,covered) : 0,
      endpoint_lease_state: coverageState,
      endpoint_lease_expires_at: null,
      endpoint_lease_heartbeat_at: null,
    })
  }
  return map
}

export function formatPendingAge(oldestPendingAt: string | null): string {
  if (!oldestPendingAt) return '0'
  const ageMs = Date.now() - new Date(oldestPendingAt).getTime()
  const sec = Math.floor(ageMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return `${hr}h${min % 60}m`
}
