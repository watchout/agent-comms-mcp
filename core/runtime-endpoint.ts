import { hostname } from 'node:os'

export type RuntimeEndpointDb = { query: (sql: string, params?: any[]) => Promise<any> }
export interface RuntimeEndpoint {
  runtimeInstanceId: string; agentId: string; hostId: string; port: number; endpointUri: string
  processId: number; leaseId: string; fencingToken: number
  sessionName: string|null; checkoutPath:string|null; lastSeenAt:string
}
export type RuntimeEndpointResolution = { ok: boolean; code: string; endpoint: RuntimeEndpoint | null }
function object(value: any): any {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? {} } catch { return {} }
}
/** An old generated WEBHOOK_PORT is not an explicit request to own that socket. */
export function requestedRuntimePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUN_STATIC_WEBHOOK_PORT
  if (raw === undefined || raw === '') return 0
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error('RUNTIME_STATIC_PORT_INVALID')
  return Number(raw)
}
export function bindRuntimeEndpoint(input: {
  fetch: (request: Request) => Response | Promise<Response>; port?: number
}) {
  const server = Bun.serve({port: input.port ?? 0, hostname: '127.0.0.1', reusePort: false, fetch: input.fetch})
  const port = server.port
  if (!port || port < 1) { server.stop(true); throw new Error('RUNTIME_ENDPOINT_BIND_FAILED') }
  return {server, port, endpointUri: `http://127.0.0.1:${port}`,
    async publish<T>(register: (port: number, uri: string) => Promise<T>): Promise<T> {
      try { return await register(port, `http://127.0.0.1:${port}`) }
      catch (error) { server.stop(true); throw new Error('RUNTIME_ENDPOINT_REGISTRATION_FAILED', {cause: error}) }
    },
  }
}
export async function resolveRuntimeEndpoint(db: RuntimeEndpointDb, input: {
  agentId: string; runtimeInstanceId?: string; hostId?: string; now?: Date
}): Promise<RuntimeEndpointResolution> {
  const read = await db.query(`SELECT r.runtime_instance_id, r.agent_id, r.runtime_kind, r.host_id,
      r.process_id, r.session_name, r.checkout_path, r.port, r.endpoint_uri, r.status AS runtime_status, r.last_seen_at,
      l.lease_id, l.fencing_token, l.holder_agent_id, l.holder_runtime_instance_id,
      l.status AS lease_status, l.expires_at, l.metadata AS lease_metadata
    FROM agent_runtime_instances r JOIN control_plane_leases l
      ON l.lease_scope_type = 'runtime_instance' AND l.lease_scope_id = CAST(r.runtime_instance_id AS TEXT)
      AND l.lease_purpose = 'worker'
    WHERE r.agent_id = $1 ${input.runtimeInstanceId ? 'AND r.runtime_instance_id = $2' : ''}`,
  input.runtimeInstanceId ? [input.agentId, input.runtimeInstanceId] : [input.agentId])
  const rows = Array.isArray(read) ? read : read.rows
  const now = (input.now ?? new Date()).getTime()
  const host = input.hostId ?? hostname()
  const eligible: RuntimeEndpoint[] = []
  for (const row of rows) {
    const m = object(row.lease_metadata)
    const port = Number(row.port), pid = Number(row.process_id)
    if (row.runtime_kind !== 'local_process' || row.host_id !== host || row.agent_id !== input.agentId
      || !['running','active'].includes(row.runtime_status) || row.lease_status !== 'active'
      || !(Date.parse(row.expires_at) > now) || !(Date.parse(row.last_seen_at) <= now)
      || now - Date.parse(row.last_seen_at) > 1_800_000
      || row.holder_agent_id !== row.agent_id || String(row.holder_runtime_instance_id) !== String(row.runtime_instance_id)
      || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(pid) || pid < 2
      || row.endpoint_uri !== `http://127.0.0.1:${port}` || m.endpoint_uri !== row.endpoint_uri
      || Number(m.port) !== port || Number(m.process_id) !== pid
      || !Number.isSafeInteger(Number(row.fencing_token)) || Number(row.fencing_token) < 1) continue
    eligible.push({runtimeInstanceId:String(row.runtime_instance_id),agentId:row.agent_id,hostId:host,
      port,endpointUri:row.endpoint_uri,processId:pid,sessionName:row.session_name??null,checkoutPath:row.checkout_path??null,lastSeenAt:new Date(row.last_seen_at).toISOString(),leaseId:String(row.lease_id),fencingToken:Number(row.fencing_token)})
  }
  if (eligible.length !== 1) return {ok:false, code:eligible.length ? 'RUNTIME_ENDPOINT_AMBIGUOUS' : 'RUNTIME_ENDPOINT_UNAVAILABLE', endpoint:null}
  return {ok:true,code:'RUNTIME_ENDPOINT_RESOLVED',endpoint:eligible[0]}
}
/** Revocation is exact to the runtime holder; stopped instances cannot renew it. */
export async function releaseRuntimeEndpoint(db: RuntimeEndpointDb, input: {agentId:string;runtimeInstanceId:string;processId:number}): Promise<void> {
  await db.query(`UPDATE control_plane_leases SET status = 'released', released_at = now()
    WHERE lease_scope_type = 'runtime_instance' AND lease_scope_id = $1 AND lease_purpose = 'worker'
      AND holder_agent_id = $2 AND holder_runtime_instance_id = $1 AND status = 'active'
      AND CAST(metadata->>'process_id' AS BIGINT) = $3`, [input.runtimeInstanceId,input.agentId,input.processId])
}
