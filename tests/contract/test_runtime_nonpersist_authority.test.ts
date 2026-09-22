import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'
import { buildRuntimeInventoryReport } from '../../core/runtime-inventory'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'
import { evaluateRuntimeMemoryReadyGate } from '../../core/runtime-memory-ready'
import { inspectHostRuntime } from '../../core/host-runtime-observer'
import { processStartUpperBoundMs } from '../../core/process-start-time'
import { resolveRuntimeEndpoint, releaseRuntimeEndpoint } from '../../core/runtime-endpoint'

async function setup() {
  const f=await fixture('postgres',true)
  const host=await nonpersistHostFixture()
  await insert(f,'agents',{agent_id:host.agentId,display_name:'synthetic',agent_type:'dev'})
  const db={async query(sql:string,params:unknown[]=[]){return {rows:await f.query(sql,params)}}}
  const input={agentId:host.agentId,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
    port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir}
  return {f,host,db,input,async close(){await host.close();await f.close()}}
}

test('NP02/04 real UUID acquisition, fenced renewal, and reused valid UUID with surviving lease',async()=>{
 const x=await setup();try {
  const first=await heartbeatRuntimeInstance(x.db,x.input)
  const lease={leaseId:first.endpoint_lease_id!,fencingToken:first.endpoint_lease_fencing_token}
  const before=await x.f.query('SELECT * FROM control_plane_leases')
  await expect(heartbeatRuntimeInstance(x.db,x.input)).rejects.toThrow('RUNTIME_UUID_ALREADY_REGISTERED')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
  await expect(heartbeatRuntimeInstance(x.db,x.input,{lease:{...lease,fencingToken:lease.fencingToken+1}})).rejects.toThrow('RUNTIME_ENDPOINT_FENCE_CHANGED')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
  expect((await heartbeatRuntimeInstance(x.db,x.input,{lease})).endpoint_lease_id).toBe(lease.leaseId)
  const anchor=(await x.f.query('SELECT * FROM agent_runtime_instances'))[0]
  for(const key of ['process_id','port','host_id','checkout_path','runtime_engine','status','started_at'])expect(anchor[key]).toBeNull()
  // A genuine live process carrying a valid former incarnation UUID cannot use
  // an authority grant that precedes this process. No malformed UUID shortcut.
  const started=inspectHostRuntime({agentId:x.host.agentId}).observations[0].process_started_at
  const earlierSameSecond=new Date(Math.floor(Date.parse(started)/1000)*1000).toISOString()
  await x.f.query('UPDATE control_plane_leases SET acquired_at=$1',[earlierSameSecond])
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId})).ok).toBe(false)
 }finally{await x.close()}
},30000)

test('NP03 lease-write failure rolls back the new logical anchor; only the owned socket remains',async()=>{
 const x=await setup();try {
  const broken={async query(sql:string,params:unknown[]=[]){
    if(sql.includes('INSERT INTO control_plane_leases'))throw new Error('injected lease acquisition failure')
    return x.db.query(sql,params)
  }}
  await expect(heartbeatRuntimeInstance(broken,x.input)).rejects.toThrow('injected lease acquisition failure')
  expect(await x.f.query('SELECT * FROM agent_runtime_instances')).toEqual([])
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual([])
  expect(inspectHostRuntime({agentId:x.host.agentId}).observations).toHaveLength(1)
 }finally{await x.close()}
},30000)

test('second-resolution OS start acquisition waits for a provable grant and preserves renewal time',async()=>{
 const x=await setup();try {
  const inspect:typeof inspectHostRuntime=input=>{
   const actual=inspectHostRuntime(input)
   return {...actual,observations:actual.observations.map(o=>({...o,process_started_at:new Date(Date.parse(o.process_started_at)).toISOString().slice(0,19)+'Z'}))}
  }
  const started=inspect({agentId:x.host.agentId}).observations[0].process_started_at
  const acquired=await heartbeatRuntimeInstance(x.db,x.input,{inspect})
  const before=(await x.f.query('SELECT acquired_at FROM control_plane_leases'))[0].acquired_at
  expect(new Date(before).getTime()).toBeGreaterThanOrEqual(processStartUpperBoundMs(started))
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect})).ok).toBe(true)
  await heartbeatRuntimeInstance(x.db,x.input,{inspect,lease:{leaseId:acquired.endpoint_lease_id!,fencingToken:acquired.endpoint_lease_fencing_token}})
  expect((await x.f.query('SELECT acquired_at FROM control_plane_leases'))[0].acquired_at).toEqual(before)
  await x.f.query('UPDATE control_plane_leases SET acquired_at=$1',[new Date(processStartUpperBoundMs(started)-1)])
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect})).ok).toBe(false)
 }finally{await x.close()}
},30000)

test('holder replacement during acquisition rolls back before authority is committed',async()=>{
 const x=await setup();try {
  let reads=0
  const inspect:typeof inspectHostRuntime=input=>{
   const actual=inspectHostRuntime(input)
   return ++reads<4?actual:{...actual,observations:actual.observations.map(o=>({...o,process_id:o.process_id+1}))}
  }
  await expect(heartbeatRuntimeInstance(x.db,x.input,{inspect})).rejects.toThrow('RUNTIME_CURRENT_HOLDER_CHANGED')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual([])
  expect(await x.f.query('SELECT * FROM agent_runtime_instances')).toEqual([])
 }finally{await x.close()}
},30000)

test('NP04 fence replacement during observation and holder change after SQL both deny endpoint resolution',async()=>{
 const x=await setup();try {
  await heartbeatRuntimeInstance(x.db,x.input)
  let authorityReads=0
  const changing={async query(sql:string,params:unknown[]=[]){
    if(sql.includes('SELECT r.runtime_instance_id') && ++authorityReads===2)
      await x.f.query('UPDATE control_plane_leases SET fencing_token=fencing_token+1')
    return x.db.query(sql,params)
  }}
  expect((await resolveRuntimeEndpoint(changing,{agentId:x.host.agentId})).code).toBe('RUNTIME_ENDPOINT_FENCE_CHANGED')
  const real=inspectHostRuntime({agentId:x.host.agentId});let inspections=0
  const changed=()=>++inspections===1?real:{...real,observations:real.observations.map(o=>({...o,process_started_at:'2100-01-01T00:00:00Z'}))}
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect:changed})).code).toBe('RUNTIME_ENDPOINT_HOLDER_CHANGED')
 }finally{await x.close()}
},30000)


test('NP04 SQL-time expiry advances during a transaction and delayed renewal has no effect',async()=>{
 const x=await setup();try {
  const first=await heartbeatRuntimeInstance(x.db,x.input)
  const lease={leaseId:first.endpoint_lease_id!,fencingToken:first.endpoint_lease_fencing_token}
  let originalExpiry:unknown
  const delayed={async query(sql:string,params:unknown[]=[]){
    if(sql.includes('SELECT lease_id, fencing_token, expires_at')) {
      await x.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()+interval '0.03 seconds'")
      const rows=await x.db.query(sql,params);originalExpiry=rows.rows[0].expires_at
      await x.f.query('SELECT pg_sleep(0.06)')
      return rows
    }
    return x.db.query(sql,params)
  }}
  const before=await x.f.query('SELECT * FROM control_plane_leases')
  await expect(heartbeatRuntimeInstance(delayed,x.input,{lease})).rejects.toThrow('RUNTIME_ENDPOINT_LEASE_UNCONFIRMED')
  expect(originalExpiry).toBeDefined()
  // Both the injected expiry and any renewal writes were in the rejected tx.
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
 }finally{await x.close()}
},30000)


test('NP04/06 inventory uses fresh host fields; release requires the acquisition fence and cannot resurrect the old UUID',async()=>{
 const x=await setup();try {
  const acquired=await heartbeatRuntimeInstance(x.db,x.input)
  const lease={leaseId:acquired.endpoint_lease_id!,fencingToken:acquired.endpoint_lease_fencing_token}
  const adapter:any={query:x.f.query}
  const report=await buildRuntimeInventoryReport(adapter)
  expect(report.agents).toHaveLength(1)
  expect(report.agents[0].process_id).toBe(x.host.endpoint.pid)
  expect(report.agents[0].port).toBe(x.host.endpoint.port)
  expect(report.agents[0].runtime_engine).toBe('codex')
  expect(report.agents[0].agent_status).toBe('observed')
  const before=await x.f.query('SELECT * FROM control_plane_leases')
  await expect(releaseRuntimeEndpoint(x.db,x.input)).rejects.toThrow('ACQUISITION_RECEIPT_REQUIRED')
  await expect(releaseRuntimeEndpoint(x.db,{...x.input,lease:{...lease,fencingToken:lease.fencingToken+1}})).rejects.toThrow('FENCE_CHANGED')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
  await releaseRuntimeEndpoint(x.db,{...x.input,lease})
  expect((await x.f.query('SELECT status FROM control_plane_leases'))[0].status).toBe('released')
  await expect(heartbeatRuntimeInstance(x.db,x.input)).rejects.toThrow('UUID_ALREADY_REGISTERED')
  const unavailable=await buildRuntimeInventoryReport(adapter)
  expect(unavailable.agents).toHaveLength(1)
  expect(unavailable.agents[0].process_id).toBeNull()
  expect(unavailable.blockers).toContain(x.host.agentId+':runtime_observation_unavailable')
 }finally{await x.close()}
},30000)


test('NP04 valid UUID replay in a different actual process/workspace denies resolve, admission and renewal with the old lease surviving',async()=>{
 const x=await setup();let oldClosed=false;let replacement:Awaited<ReturnType<typeof nonpersistHostFixture>>|undefined
 try {
  const acquired=await heartbeatRuntimeInstance(x.db,x.input)
  const lease={leaseId:acquired.endpoint_lease_id!,fencingToken:acquired.endpoint_lease_fencing_token}
  const before=await x.f.query('SELECT * FROM control_plane_leases')
  await x.host.close();oldClosed=true
  const replacementSpawnEarliest=Date.now()
  replacement=await nonpersistHostFixture(x.host.runtimeId,x.host.agentId)
  const replacementReady=Date.now()
  expect(replacement.endpoint.pid).not.toBe(x.host.endpoint.pid)
  expect(replacement.dir).not.toBe(x.host.dir)
  const resolution=await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId})
  // Sample only after resolution, so diagnostics cannot age the replacement
  // past the boundary that the immediate replay assertion is exercising.
  const observation=inspectHostRuntime({agentId:x.host.agentId}).observations[0]
  console.log(JSON.stringify({case:'NP04-immediate-replay-diagnostic',replacement_spawn_earliest_ms:replacementSpawnEarliest,replacement_ready_ms:replacementReady,
    acquired_at:before[0].acquired_at,original_pid:x.host.endpoint.pid,replacement_pid:replacement.endpoint.pid,
    original_workspace:x.host.dir,replacement_workspace:replacement.dir,resolution,observation,
    linux:process.platform==='linux'?{pid_stat:readFileSync(`/proc/${replacement.endpoint.pid}/stat`,'utf8'),uptime:readFileSync('/proc/uptime','utf8'),
      btime:readFileSync('/proc/stat','utf8').split('\n').find(line=>line.startsWith('btime '))}:null}))
  expect(resolution.ok).toBe(false)
  let nativeReads=0
  expect((await evaluateRuntimeMemoryReadyGate(x.db,{agent_id:x.host.agentId,project:'fixture-project',readNativeProof:async()=>{nativeReads++;throw new Error('must not read')}})).ok).toBe(false)
  expect(nativeReads).toBe(0)
  const replay={...x.input,processId:replacement.endpoint.pid,port:replacement.endpoint.port,endpointUri:`http://127.0.0.1:${replacement.endpoint.port}`,checkoutPath:replacement.dir}
  await expect(heartbeatRuntimeInstance(x.db,replay)).rejects.toThrow('UUID_ALREADY_REGISTERED')
  await expect(heartbeatRuntimeInstance(x.db,replay,{lease})).rejects.toThrow('INCARNATION_CHANGED')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
 }finally{await replacement?.close();if(!oldClosed)await x.host.close();await x.f.close()}
},30000)


test('NP02/04 SQLite ordinary acquisition, renewal and release use the same physical-free authority contract',async()=>{
 const f=await fixture('sqlite',true),host=await nonpersistHostFixture()
 const adapter=new SqliteAdapter(join(process.env.AUN_NP_FIXTURE_ROOT!,f.name+'.sqlite'))
 const db={async query(sql:string,params:unknown[]=[]){return {rows:await adapter.query(sql,params)}}}
 try {
  await insert(f,'agents',{agent_id:host.agentId,display_name:'sqlite authority',agent_type:'dev'})
  const input={agentId:host.agentId,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,port:host.endpoint.port,
    endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir}
  const initial=await heartbeatRuntimeInstance(db,input)
  const lease={leaseId:initial.endpoint_lease_id!,fencingToken:initial.endpoint_lease_fencing_token}
  expect((await heartbeatRuntimeInstance(db,input,{lease})).endpoint_lease_id).toBe(lease.leaseId)
  expect((await resolveRuntimeEndpoint(db,{agentId:host.agentId})).ok).toBe(true)
  await releaseRuntimeEndpoint(db,{...input,lease})
  expect((await f.query('SELECT status FROM control_plane_leases'))[0].status).toBe('released')
  for(const row of await f.query('SELECT process_id,port,status FROM agent_runtime_instances'))expect(row).toEqual({process_id:null,port:null,status:null})
 }finally{await adapter.close();await host.close();await f.close()}
},30000)
