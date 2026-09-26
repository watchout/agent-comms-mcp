import type { RuntimeEndpointDb } from './runtime-endpoint'
import { resolveRuntimeEndpoint } from './runtime-endpoint'

/** Called inside the existing receive transaction, after its routing/readiness gates.
 * Only the current holder's opaque UUID is copied to durable claim authority. */
export async function claimUnboundedRuntimeQueue(db: RuntimeEndpointDb, input: {
  agentId: string; queueId: string | number; ttlSeconds: number
  runtimeInstanceId?: string; payload?: string | null
}) {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1) throw new Error('CLAIM_TTL_INVALID')
  const resolved = await resolveRuntimeEndpoint(db, {agentId: input.agentId, runtimeInstanceId: input.runtimeInstanceId})
  if (!resolved.ok || !resolved.endpoint) throw new Error(`CLAIM_RUNTIME_AUTHORITY_UNAVAILABLE:${resolved.code}`)
  const holder = resolved.endpoint
  const clockResult=await db.query('SELECT clock_timestamp() AS database_now')
  const clock=(Array.isArray(clockResult)?clockResult:clockResult.rows)[0]
  const now = new Date(clock?.database_now ?? '')
  if (!Number.isFinite(now.getTime())) throw new Error('CLAIM_DATABASE_CLOCK_UNAVAILABLE')
  const expires = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString()
  const result = await db.query(
    `UPDATE message_queue SET status='received', read_at=clock_timestamp(), claimed_by=$1,
       claimed_at=clock_timestamp(), claim_expires_at=$2, claimed_runtime_instance_id=$5::uuid,
       payload=COALESCE($6,payload)
     WHERE id=$3 AND agent_id=$1 AND status='pending'
       AND $2 > clock_timestamp()
       AND EXISTS (SELECT 1 FROM control_plane_leases l WHERE l.lease_id=$4
         AND l.lease_scope_type='runtime_instance' AND l.lease_scope_id=$5::text
         AND l.lease_purpose='worker' AND l.holder_agent_id=$1 AND l.holder_runtime_instance_id=$5::uuid
         AND l.fencing_token=$7 AND l.status='active' AND l.expires_at>clock_timestamp())
     RETURNING claimed_by,claimed_at::text AS claimed_at,claim_expires_at::text AS claim_expires_at,
       claimed_runtime_instance_id`,
    [input.agentId,expires,input.queueId,holder.leaseId,holder.runtimeInstanceId,input.payload ?? null,holder.fencingToken],
  )
  const rows=Array.isArray(result)?result:result.rows
  if(rows.length!==1)throw new Error('CLAIM_RUNTIME_FENCE_CHANGED')
  return rows[0]
}
