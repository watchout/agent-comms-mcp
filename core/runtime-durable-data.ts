/** D2 positive projections: observations are caller-memory only. Never persist a
 * whole provider/native receipt, an argv, path, liveness or a renamed snapshot. */
export const RUNTIME_NONPERSISTENCE_VERSION = 'aun-runtime-nonpersistence/v1' as const
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const logicalRuntimeKeys = ['bootstrap_run_id','mcp_runtime_instance_id','source_commit','source_tree'] as const
export function durableRuntimeMetadata(value: Record<string, unknown> = {}): Record<string, unknown> {
  const out:Record<string,unknown>={schema_version:RUNTIME_NONPERSISTENCE_VERSION}
  for(const key of logicalRuntimeKeys) if(value[key]!==undefined) {
    const v=value[key]
    const pattern=key.startsWith('source_')?/^[0-9a-f]{40}$/:key==='bootstrap_run_id'?/^bootstrap-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/:uuid
    if(typeof v!=='string'||!pattern.test(v)) throw new Error('RUNTIME_LOGICAL_METADATA_INVALID')
    out[key]=v
  }
  return out
}
export function durableMemoryMetadata(value: Record<string, unknown> = {}): Record<string,unknown> {
  const out:Record<string,unknown>={schema_version:RUNTIME_NONPERSISTENCE_VERSION}
  if(value.bootstrap_run_id!==undefined) out.bootstrap_run_id=durableRuntimeMetadata({bootstrap_run_id:value.bootstrap_run_id}).bootstrap_run_id
  const receipt=value.seat_context_receipt as Record<string,unknown>|undefined
  if(receipt!==undefined) {
    if(!receipt || typeof receipt!=='object' || Array.isArray(receipt)) throw new Error('MEMORY_LOGICAL_PROOF_INVALID')
    const proof:Record<string,string>={}
    for(const key of ['agent_id','project','runtime_instance_id','pack_id','work_digest','invocation_digest','completed_at']) {
      if(typeof receipt[key]!=='string' || !receipt[key])throw new Error('MEMORY_LOGICAL_PROOF_INVALID')
      proof[key]=receipt[key] as string
    }
    const prefix=`restart_pack:${proof.agent_id}:${proof.project}:`
    if(!uuid.test(proof.runtime_instance_id) || !proof.pack_id.startsWith(prefix)
      || !/^\d+$/.test(proof.pack_id.slice(prefix.length))
      || !/^[0-9a-f]{64}$/.test(proof.work_digest) || !/^[0-9a-f]{64}$/.test(proof.invocation_digest)
      || !/^\d{4}-\d\d-\d\dT/.test(proof.completed_at) || !Number.isFinite(Date.parse(proof.completed_at))) throw new Error('MEMORY_LOGICAL_PROOF_INVALID')
    out.seat_context_proof=proof
  }
  // Explicit operator bypass remains a separate authority contract. Its scope
  // contains logical queue IDs/actions only; never arbitrary nested metadata.
  for(const key of ['actor','reason','timestamp','target_agent','target_agent_id','expires_at','expiry','expiry_at']) {
    if(typeof value[key]==='string') out[key]=value[key]
  }
  if(value.target!==undefined) {
    if(!value.target || typeof value.target!=='object' || Array.isArray(value.target)
      || Object.keys(value.target).some(k=>k!=='agent_id') || typeof (value.target as any).agent_id!=='string') throw new Error('BYPASS_TARGET_INVALID')
    out.target={agent_id:(value.target as any).agent_id}
  }
  if(value.queue_scope!==undefined) {
    if(!value.queue_scope || typeof value.queue_scope!=='object' || Array.isArray(value.queue_scope)) throw new Error('BYPASS_SCOPE_INVALID')
    const allowed=['queue_id','queue_ids','status','statuses','action_kind','action_kinds','agent_id','target_agent','target_agent_id']
    if(Object.keys(value.queue_scope).some(k=>!allowed.includes(k))) throw new Error('BYPASS_SCOPE_UNSUPPORTED_CONSTRAINT')
    const scope:Record<string,unknown>={}
    for(const key of allowed) {
      const v=(value.queue_scope as Record<string,unknown>)[key]
      if(v===undefined)continue
      if(typeof v==='string'||typeof v==='number') scope[key]=v
      else if(Array.isArray(v) && v.every(item=>typeof item==='string'||typeof item==='number')) scope[key]=[...v]
      else throw new Error('BYPASS_SCOPE_INVALID')
    }
    out.queue_scope=scope
  }
  return out
}
