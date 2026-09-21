/** D2 positive projections: observations are caller-memory only. Never persist a
 * whole provider/native receipt, an argv, path, liveness or a renamed snapshot. */
export const RUNTIME_NONPERSISTENCE_VERSION = 'aun-runtime-nonpersistence/v1' as const
const logicalRuntimeKeys = ['bootstrap_run_id','mcp_runtime_instance_id','source_commit','source_tree'] as const
export function durableRuntimeMetadata(value: Record<string, unknown> = {}): Record<string, unknown> {
  const out:Record<string,unknown>={schema_version:RUNTIME_NONPERSISTENCE_VERSION}
  for(const key of logicalRuntimeKeys) if(typeof value[key]==='string') out[key]=value[key]
  return out
}
export function durableMemoryMetadata(value: Record<string, unknown> = {}): Record<string,unknown> {
  const out:Record<string,unknown>={schema_version:RUNTIME_NONPERSISTENCE_VERSION}
  const receipt=value.seat_context_receipt as Record<string,unknown>|undefined
  if(receipt && typeof receipt==='object') {
    const proof:Record<string,unknown>={}
    for(const key of ['agent_id','project','runtime_instance_id','pack_id','work_digest','invocation_digest','completed_at']) {
      if(typeof receipt[key]==='string') proof[key]=receipt[key]
    }
    out.seat_context_proof=proof
  }
  // Explicit operator bypass remains a separate authority contract. Its scope
  // contains logical queue IDs/actions only; never arbitrary nested metadata.
  for(const key of ['actor','reason','timestamp','target_agent','target_agent_id','expires_at','expiry','expiry_at']) {
    if(typeof value[key]==='string') out[key]=value[key]
  }
  if(value.queue_scope && typeof value.queue_scope==='object') {
    const scope:Record<string,unknown>={}
    for(const key of ['queue_id','status','action_kind']) {
      const v=(value.queue_scope as Record<string,unknown>)[key]
      if(typeof v==='string'||typeof v==='number') scope[key]=v
    }
    out.queue_scope=scope
  }
  return out
}
