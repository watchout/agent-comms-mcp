import { inspectHostRuntime, type HostRuntimeInspector } from './host-runtime-observer'
import { hostname } from 'node:os'

export type RuntimeEndpointDb = { query: (sql: string, params?: any[]) => Promise<any> }
export interface RuntimeEndpoint {
  runtimeInstanceId: string; agentId: string; hostId: string; port: number; endpointUri: string
  processId: number; processStartedAt: string; leaseId: string; fencingToken: number
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
  fetch: (request: Request) => Response | Promise<Response>; port?: number; authorize?: () => Promise<boolean>
}) {
  let published=false
  const server = Bun.serve({port: input.port ?? 0, hostname: '127.0.0.1', reusePort: false, async fetch(request) {
    if(!published || !input.authorize || !await input.authorize().catch(()=>false)) return new Response('Runtime authority unavailable',{status:503})
    return input.fetch(request)
  }})
  const port = server.port
  if (!port || port < 1) { server.stop(true); throw new Error('RUNTIME_ENDPOINT_BIND_FAILED') }
  return {server, port, endpointUri: `http://127.0.0.1:${port}`,
    async publish<T>(register: (port: number, uri: string) => Promise<T>): Promise<T> {
      try { const result=await register(port, `http://127.0.0.1:${port}`);
        if(!input.authorize || !await input.authorize()) throw new Error('RUNTIME_ENDPOINT_POST_COMMIT_UNVERIFIED')
        published=true; return result }
      catch (error) { published=false; server.stop(true); throw new Error('RUNTIME_ENDPOINT_REGISTRATION_FAILED', {cause: error}) }
    },
  }
}
export async function resolveRuntimeEndpoint(db: RuntimeEndpointDb, input: {
  agentId: string; runtimeInstanceId?: string; hostId?: string; now?: Date; inspect?: HostRuntimeInspector
}): Promise<RuntimeEndpointResolution> {
  const fail=(code:string):RuntimeEndpointResolution=>({ok:false,code,endpoint:null})
  const authoritySql=`SELECT r.runtime_instance_id,r.agent_id,r.runtime_kind,
      l.lease_id,l.fencing_token,l.holder_agent_id,l.holder_runtime_instance_id,
      CASE WHEN l.status = 'active' AND l.expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS authority_live
      FROM agent_runtime_instances r JOIN control_plane_leases l
        ON l.lease_scope_type = 'runtime_instance' AND l.lease_scope_id = CAST(r.runtime_instance_id AS TEXT)
          AND l.lease_purpose = 'worker' AND l.status = 'active'
      WHERE r.agent_id = $1`
  const readAuthority=async()=>{const read=await db.query(authoritySql,[input.agentId]);return Array.isArray(read)?read:read.rows}
  let rows:any[]
  try {rows=await readAuthority()} catch {return fail('RUNTIME_ENDPOINT_AUTHORITY_UNAVAILABLE')}
  const observed=(input.inspect ?? inspectHostRuntime)({agentId:input.agentId,runtimeInstanceId:input.runtimeInstanceId,expectedHost:input.hostId})
  if(observed.reasonCode!=='OBSERVED') return fail('RUNTIME_ENDPOINT_UNAVAILABLE')
  const eligible:RuntimeEndpoint[]=[]
  for(const o of observed.observations) {
    const matches=rows.filter(r=>String(r.runtime_instance_id)===o.runtime_instance_id && r.agent_id===input.agentId
      && r.runtime_kind==='local_process' && r.holder_agent_id===input.agentId
      && String(r.holder_runtime_instance_id)===o.runtime_instance_id && Number(r.authority_live)===1
      && Number.isSafeInteger(Number(r.fencing_token)) && Number(r.fencing_token)>0)
    if(matches.length!==1) return fail('RUNTIME_ENDPOINT_HOLDER_UNVERIFIED')
    const r=matches[0]
    eligible.push({runtimeInstanceId:o.runtime_instance_id,agentId:input.agentId,hostId:o.host_id,port:o.port,
      endpointUri:o.endpoint_uri,processId:o.process_id,processStartedAt:o.process_started_at,leaseId:String(r.lease_id),fencingToken:Number(r.fencing_token),
      sessionName:o.session_name,checkoutPath:o.workspace,lastSeenAt:o.observed_at})
  }
  if(eligible.length!==1) return fail(eligible.length?'RUNTIME_ENDPOINT_AMBIGUOUS':'RUNTIME_ENDPOINT_UNAVAILABLE')
  try {
    const current=await readAuthority(), selected=eligible[0]
    const holders=current.filter((r:any)=>String(r.runtime_instance_id)===selected.runtimeInstanceId && r.agent_id===input.agentId
      && r.holder_agent_id===input.agentId && String(r.holder_runtime_instance_id)===selected.runtimeInstanceId
      && Number(r.authority_live)===1 && String(r.lease_id)===selected.leaseId && Number(r.fencing_token)===selected.fencingToken)
    if(holders.length!==1)return fail('RUNTIME_ENDPOINT_FENCE_CHANGED')
  }catch{return fail('RUNTIME_ENDPOINT_AUTHORITY_UNAVAILABLE')}
  return {ok:true,code:'RUNTIME_ENDPOINT_RESOLVED',endpoint:eligible[0]}
}
/** Revocation is exact to the runtime holder; stopped instances cannot renew it. */
export async function releaseRuntimeEndpoint(db: RuntimeEndpointDb, input: {agentId:string;runtimeInstanceId:string;processId:number}): Promise<void> {
  const resolved=await resolveRuntimeEndpoint(db,input)
  if(!resolved.ok || resolved.endpoint?.processId!==input.processId) throw new Error('RUNTIME_RELEASE_HOLDER_UNVERIFIED')
  await db.query(`UPDATE control_plane_leases SET status = 'released', released_at = CURRENT_TIMESTAMP
    WHERE lease_id = $1 AND fencing_token = $2 AND holder_agent_id = $3
      AND holder_runtime_instance_id = $4 AND status = 'active' AND expires_at > CURRENT_TIMESTAMP`,
    [resolved.endpoint.leaseId,resolved.endpoint.fencingToken,input.agentId,input.runtimeInstanceId])
}
