import { inspectNativeHostRuntime, sameNativeHostRuntime, type NativeHostRuntimeInspector, type NativeHostRuntimeObservation } from './host-runtime-observer'

export const NATIVE_RUNTIME_KIND = 'deterministic-s0' as const
type LogicalDb = {query:(sql:string,params?:any[])=>Promise<any>}
export type NativeRuntimeAuthority = {
  ok:boolean
  code:'NATIVE_AUTHORITY_READY'|'NATIVE_AUTHORITY_ABSENT'|'NATIVE_AUTHORITY_UNAVAILABLE'|'NATIVE_AUTHORITY_AMBIGUOUS'
  observation:NativeHostRuntimeObservation|null
  runtimeInstanceId?:string
  sourceCommit?:string
  sourceTree?:string
  leaseId?:string
  fencingToken?:number
}
function object(value:any):Record<string,any> {
  if(typeof value==='string') {try{return JSON.parse(value)}catch{return {}}}
  return value && typeof value==='object'?value:{}
}
/** D-S0-1: no saved physical fields or LLM observation participate in selection. */
export async function resolveNativeRuntimeAuthority(db:LogicalDb,input:{agentId:string;inspect?:NativeHostRuntimeInspector}):Promise<NativeRuntimeAuthority> {
  const fail=(code:NativeRuntimeAuthority['code']='NATIVE_AUTHORITY_UNAVAILABLE'):NativeRuntimeAuthority=>({ok:false,code,observation:null})
  const read=async()=>{
    const result=await db.query(`SELECT r.runtime_instance_id,r.agent_id,r.commit_sha,r.metadata,
      l.lease_id,l.holder_agent_id,l.holder_runtime_instance_id,l.fencing_token,
      l.metadata AS authority_metadata,
      CASE WHEN l.status='active' AND l.expires_at>clock_timestamp() THEN 1 ELSE 0 END AS authority_live
      FROM agent_runtime_instances r JOIN control_plane_leases l
        ON l.lease_scope_type='runtime_instance' AND l.lease_scope_id=CAST(r.runtime_instance_id AS TEXT)
        AND l.lease_purpose='maintenance'
      WHERE r.agent_id=$1`,[input.agentId])
    return (Array.isArray(result)?result:result.rows).filter((r:any)=>object(r.authority_metadata).native_runtime_kind===NATIVE_RUNTIME_KIND)
  }
  try {
    const rows=await read()
    if(!rows.length)return fail('NATIVE_AUTHORITY_ABSENT')
    const active=rows.filter((r:any)=>Number(r.authority_live)===1)
    if(active.length>1)return fail('NATIVE_AUTHORITY_AMBIGUOUS')
    if(active.length!==1)return fail()
    const row=active[0],build=object(row.metadata)
    if(row.agent_id!==input.agentId || row.holder_agent_id!==input.agentId
      || String(row.holder_runtime_instance_id)!==String(row.runtime_instance_id)
      || !Number.isSafeInteger(Number(row.fencing_token)) || Number(row.fencing_token)<1
      || !/^[0-9a-f]{40}$/.test(row.commit_sha??'') || build.source_commit!==row.commit_sha
      || !/^[0-9a-f]{40}$/.test(build.source_tree??''))return fail()
    const inspect=input.inspect??inspectNativeHostRuntime
    const first=inspect({agentId:input.agentId})
    if(first.reasonCode!=='OBSERVED' || first.observations.length!==1)return fail(first.observations.length>1?'NATIVE_AUTHORITY_AMBIGUOUS':undefined)
    const observed=first.observations[0]
    if(observed.agent_id!==input.agentId || observed.runtime_instance_id!==String(row.runtime_instance_id))return fail()
    const after=(await read()).filter((r:any)=>Number(r.authority_live)===1)
    if(after.length!==1)return fail()
    const current=after[0]
    for(const key of ['runtime_instance_id','agent_id','commit_sha','lease_id','holder_agent_id','holder_runtime_instance_id','fencing_token']) {
      if(String(current[key])!==String(row[key]))return fail()
    }
    if(object(current.metadata).source_commit!==build.source_commit || object(current.metadata).source_tree!==build.source_tree)return fail()
    const final=inspect({agentId:input.agentId})
    if(final.reasonCode!=='OBSERVED'||final.observations.length!==1||!sameNativeHostRuntime(observed,final.observations[0]))return fail()
    return {ok:true,code:'NATIVE_AUTHORITY_READY',observation:final.observations[0],runtimeInstanceId:String(row.runtime_instance_id),
      sourceCommit:row.commit_sha,sourceTree:build.source_tree,leaseId:String(row.lease_id),fencingToken:Number(row.fencing_token)}
  } catch {return fail()}
}
