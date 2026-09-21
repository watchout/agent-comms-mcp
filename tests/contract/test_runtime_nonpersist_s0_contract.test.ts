import { test,expect } from 'bun:test'
import { fixture,insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nativeProcessFixture } from '../helpers/native-process-fixture'
import { acquireControlPlaneLease } from '../../core/control-plane-leases'
import { PgAdapter } from '../../core/db/pg-adapter'
import { inspectNativeHostRuntime } from '../../core/host-runtime-observer'
import { resolveNativeRuntimeAuthority,NATIVE_RUNTIME_KIND } from '../../core/runtime-native-authority'
import { readV2NativeFrozenEnabledSet } from '../../core/runtime-inventory'

async function setup() {
  const f=await fixture('postgres',true)
  const url=new URL(process.env.AGENT_COM_TEST_DATABASE_URL!);url.pathname='/'+f.name
  const db=new PgAdapter(url.href),hosts:Array<Awaited<ReturnType<typeof nativeProcessFixture>>>=[]
  const enroll=async()=>{
    const host=await nativeProcessFixture();hosts.push(host)
    await insert(f,'agents',{agent_id:host.agentId,display_name:'native fixture',agent_type:'bot',profile_enabled:true,
      metadata:JSON.stringify({profile_class:'production',profile_class_source_ref:'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759277196',
        profile_class_source_sha256:'01f2259457e1b5c605a500c1db474bcaf374d5d9f0ab48a4e57192914e01a82b',profile_class_plan_sha256:'b'.repeat(64)})})
    await insert(f,'agent_runtime_instances',{runtime_instance_id:host.runtimeId,agent_id:host.agentId,runtime_kind:'local_process',commit_sha:'a'.repeat(40),
      metadata:JSON.stringify({schema_version:'aun-runtime-nonpersistence/v1',source_commit:'a'.repeat(40),source_tree:'b'.repeat(40)})})
    const lease=await acquireControlPlaneLease(db,{scopeType:'runtime_instance',scopeId:host.runtimeId,purpose:'maintenance',ttlMs:60000,
      holderAgentId:host.agentId,holderRuntimeInstanceId:host.runtimeId,metadata:{native_runtime_kind:NATIVE_RUNTIME_KIND}})
    if(!lease.ok)throw new Error('NATIVE_FIXTURE_LEASE_FAILED')
    return {host,lease:lease.lease}
  }
  return {f,db,enroll,hosts,async close(){for(const host of hosts)await host.close();await db.close();await f.close()}}
}

test('AC-S0-1 native selection uses logical build + lease + real socket; physical history is never queried',async()=>{
  const s=await setup()
  try {
    const a=await s.enroll(),b=await s.enroll(),queries:string[]=[]
    const tap={async query(sql:string,args?:any[]){queries.push(sql);return s.db.query(sql,args)}} as PgAdapter
    const selected=await readV2NativeFrozenEnabledSet(tap,{inspect:()=>{throw new Error('LLM_OBSERVER_FORBIDDEN')}})
    expect(selected).toHaveLength(2)
    expect(selected.map(r=>r.runtime_engine)).toEqual([NATIVE_RUNTIME_KIND,NATIVE_RUNTIME_KIND])
    expect(new Set(selected.map(r=>r.runtime_instance_id))).toEqual(new Set([a.host.runtimeId,b.host.runtimeId]))
    expect(queries.join('\n')).not.toMatch(/\b(runtime_engine|stopped_at|last_seen_at|checkout_path|aun_configuration_observed_state)\b/)
    expect(queries.filter(q=>/FROM agent_runtime_instances/.test(q)).join('\n')).not.toMatch(/r\.status/)
    await s.f.query('UPDATE agent_runtime_instances SET commit_sha=$1 WHERE runtime_instance_id=$2',['c'.repeat(40),a.host.runtimeId])
    await expect(readV2NativeFrozenEnabledSet(tap,{inspect:()=>{throw new Error('LLM_OBSERVER_FORBIDDEN')}})).rejects.toThrow('NATIVE_AUTHORITY_UNAVAILABLE')
    console.log(JSON.stringify({case:'AC-S0-1',selected:2,build_mismatch_denied:1,physical_reads:0,provider_invocations:0}))
  }finally{await s.close()}
},30000)

test('AC-S0-2 expire, changed fence and actual replacement deny S0 dispatch with no history fallback',async()=>{
  const s=await setup()
  try {
    const {host,lease}=await s.enroll();let calls=0
    const dispatch=async(db=s.db)=>{const proof=await resolveNativeRuntimeAuthority(db,{agentId:host.agentId});if(proof.ok)calls++;return proof}
    expect((await dispatch()).ok).toBe(true);expect(calls).toBe(1)
    await s.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=$1",[lease.lease_id])
    expect((await dispatch()).code).toBe('NATIVE_AUTHORITY_UNAVAILABLE');expect(calls).toBe(1)
    await s.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()+interval '1 minute' WHERE lease_id=$1",[lease.lease_id])
    let reads=0
    const changing={async query(sql:string,args?:any[]){const rows=await s.db.query(sql,args);if(++reads===1)await s.f.query('UPDATE control_plane_leases SET fencing_token=fencing_token+1 WHERE lease_id=$1',[lease.lease_id]);return rows}} as PgAdapter
    expect((await dispatch(changing)).code).toBe('NATIVE_AUTHORITY_UNAVAILABLE');expect(calls).toBe(1)
    await host.close()
    const replacement=await nativeProcessFixture(host.agentId);s.hosts.push(replacement)
    expect((await dispatch()).code).toBe('NATIVE_AUTHORITY_UNAVAILABLE');expect(calls).toBe(1)
    console.log(JSON.stringify({case:'AC-S0-2',admitted:1,expire_denied:1,fence_denied:1,replacement_denied:1,denied_dispatches:0,provider_invocations:0}))
  }finally{await s.close()}
},30000)

test('AC-S0-3 plain Bun needs no provider identity; missing logical marker never invents one',async()=>{
  const s=await setup()
  try {
    const {host,lease}=await s.enroll()
    const observed=inspectNativeHostRuntime({agentId:host.agentId})
    expect(observed.reasonCode).toBe('OBSERVED')
    expect(observed.observations).toHaveLength(1)
    expect(Object.hasOwn(observed.observations[0],'provider')).toBe(false)
    expect(Object.hasOwn(observed.observations[0],'provider_pid')).toBe(false)
    expect((await resolveNativeRuntimeAuthority(s.db,{agentId:host.agentId})).ok).toBe(true)
    await s.f.query("UPDATE control_plane_leases SET metadata='{}'::jsonb WHERE lease_id=$1",[lease.lease_id])
    const denied=await resolveNativeRuntimeAuthority(s.db,{agentId:host.agentId})
    expect(denied.code).toBe('NATIVE_AUTHORITY_ABSENT');expect(denied.ok).toBe(false)
    console.log(JSON.stringify({case:'AC-S0-3',provider_free_positive:1,missing_marker_denied:1,provider_names_generated:0,provider_invocations:0}))
  }finally{await s.close()}
},30000)
