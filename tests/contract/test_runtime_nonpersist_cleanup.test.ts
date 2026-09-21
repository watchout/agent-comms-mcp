import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { buildRuntimeCleanupReport, executeRuntimeCleanup } from '../../core/runtime-cleanup'
import { inspectHostRuntime } from '../../core/host-runtime-observer'
import { durableRuntimeMetadata } from '../../core/runtime-durable-data'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'

async function setup() {
 const f=await fixture('postgres',true),host=await nonpersistHostFixture()
 await insert(f,'agents',{agent_id:host.agentId,display_name:'disabled fixture',agent_type:'dev',profile_enabled:false})
 await insert(f,'agent_runtime_instances',{runtime_instance_id:host.runtimeId,agent_id:host.agentId,runtime_kind:'local_process',
   runtime_engine:null,status:null,started_at:null,metadata:JSON.stringify(durableRuntimeMetadata())})
 const db:any={dialect:'postgres',query:f.query,execute:async(sql:string,values:any[])=>{await f.query(sql,values);return {rowCount:1}}}
 const options={portListeners:[{pid:host.endpoint.pid,port:host.endpoint.port,command:'bun'}]}
 return {f,host,db,options,async close(){await host.close();await f.close()}}
}

test('NP04/08 cleanup denies unknown work, changed PID start, active lease and DB failure before any kill',async()=>{
 const x=await setup();try {
  let kills=0
  const initial=await buildRuntimeCleanupReport(x.db,x.options)
  expect(initial.summary.executable_actions).toBeGreaterThan(0)
  const message=randomUUID()
  await insert(x.f,'agent_messages',{id:message,author_id:x.host.agentId,content:'unfinished fixture',message_type:'chat'})
  await insert(x.f,'message_queue',{message_id:message,agent_id:x.host.agentId,payload:'{}',status:'in_progress'})
  await expect(executeRuntimeCleanup(x.db,{...x.options,confirmHash:initial.plan_hash,killProcess:()=>{kills++}})).rejects.toThrow('ACTIVE_OR_UNKNOWN_WORK')
  await x.f.query("UPDATE message_queue SET status='done' WHERE message_id=$1",[message])
  const unreadable={...x.db,query:async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM message_queue'))throw new Error('injected queue read unavailable')
    return x.f.query(sql,values)
  }}
  await expect(executeRuntimeCleanup(unreadable,{...x.options,confirmHash:initial.plan_hash,killProcess:()=>{kills++}})).rejects.toThrow('queue read unavailable')
  const fresh=inspectHostRuntime({agentId:x.host.agentId});let inspections=0
  const changed=()=>++inspections<=1?fresh:{...fresh,observations:fresh.observations.map(o=>({...o,process_started_at:'2100-01-01T00:00:00Z'}))}
  await expect(executeRuntimeCleanup(x.db,{...x.options,inspect:changed,confirmHash:initial.plan_hash,killProcess:()=>{kills++}})).rejects.toThrow('HOLDER_CHANGED')
  const failed={...x.db,query:async(sql:string,values:unknown[])=>{
    if(sql.includes('FROM agent_runtime_instances'))throw new Error('injected anchor read unavailable')
    return x.f.query(sql,values)
  }}
  await expect(buildRuntimeCleanupReport(failed,x.options)).rejects.toThrow('anchor read unavailable')
  await insert(x.f,'control_plane_leases',{lease_scope_type:'runtime_instance',lease_scope_id:x.host.runtimeId,lease_purpose:'worker',
    holder_agent_id:x.host.agentId,holder_runtime_instance_id:x.host.runtimeId,fencing_token:1,status:'active',expires_at:'2099-01-01T00:00:00Z',metadata:JSON.stringify(durableRuntimeMetadata())})
  expect((await buildRuntimeCleanupReport(x.db,x.options)).summary.executable_actions).toBe(0)
  expect(kills).toBe(0)
  expect((await x.f.query('SELECT status FROM message_queue'))[0].status).toBe('done')
 }finally{await x.close()}
},30000)

test('NP04/08 cleanup plan binds process start; expired holder stops exactly once without physical persistence',async()=>{
 const x=await setup();try {
  const first=await buildRuntimeCleanupReport(x.db,x.options)
  const fresh=inspectHostRuntime({agentId:x.host.agentId})
  const changed=()=>({...fresh,observations:fresh.observations.map(o=>({...o,process_started_at:'2100-01-01T00:00:00Z'}))})
  expect((await buildRuntimeCleanupReport(x.db,{...x.options,inspect:changed})).plan_hash).not.toBe(first.plan_hash)
  const before=await x.f.query('SELECT * FROM agent_runtime_instances')
  const pids:number[]=[]
  await executeRuntimeCleanup(x.db,{...x.options,confirmHash:first.plan_hash,killProcess:async pid=>{
    pids.push(pid);expect(pid).toBe(x.host.endpoint.pid)
    process.kill(pid,'SIGTERM')
    await x.host.child.exited
  }})
  expect(pids).toEqual([x.host.endpoint.pid])
  expect(await x.f.query('SELECT * FROM agent_runtime_instances')).toEqual(before)
  const audit=JSON.stringify(await x.f.query('SELECT target,detail FROM audit_log'))
  expect(audit).not.toContain(x.host.dir)
  expect(audit).not.toContain(String(x.host.endpoint.port))
  expect((await buildRuntimeCleanupReport(x.db)).summary.executable_actions).toBe(0)
 }finally{await x.close()}
},30000)

test('NP08 orphan kill-only and observation timeout never authorize an unbound process',async()=>{
 const x=await setup();try {
  const unknown=()=>({observations:[],reasonCode:'HOST_OBSERVATION_DEADLINE'})
  const report=await buildRuntimeCleanupReport(x.db,{...x.options,inspect:unknown})
  expect(report.summary.executable_actions).toBe(0)
  expect(report.summary.unknown_risk_targets).toBeGreaterThan(0)
  let kills=0
  await executeRuntimeCleanup(x.db,{...x.options,inspect:unknown,confirmHash:report.plan_hash,allowUnknownRisk:true,killProcess:()=>{kills++}})
  expect(kills).toBe(0)
 }finally{await x.close()}
},30000)
