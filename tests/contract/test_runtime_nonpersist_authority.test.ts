import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'
import { runtimeStartupFixture } from '../helpers/runtime-startup-fixture'
import { spawnObservedServer,closeObservedServers } from '../helpers/observed-server-fixture'
import { buildRuntimeInventoryReport } from '../../core/runtime-inventory'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'
import { inspectHostRuntime } from '../../core/host-runtime-observer'
import { bindRuntimeEndpoint, resolveRuntimeEndpoint, releaseRuntimeEndpoint } from '../../core/runtime-endpoint'

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
  // D-OWN-1: acquisition time is history, never incarnation proof.
  await x.f.query("UPDATE control_plane_leases SET acquired_at='2000-01-01T00:00:00Z'")
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId})).ok).toBe(true)
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

test('NP04-e second-resolution OS start never gates acquisition or renewal by a time interval',async()=>{
 const x=await setup();try {
  const inspect:typeof inspectHostRuntime=input=>{
   const actual=inspectHostRuntime(input)
   return {...actual,observations:actual.observations.map(o=>({...o,process_started_at:new Date(Date.parse(o.process_started_at)).toISOString().slice(0,19)+'Z'}))}
  }
  const started=inspect({agentId:x.host.agentId}).observations[0].process_started_at
  const acquired=await heartbeatRuntimeInstance(x.db,x.input,{inspect})
  const before=(await x.f.query('SELECT acquired_at FROM control_plane_leases'))[0].acquired_at
  expect(Number.isFinite(new Date(before).getTime())).toBe(true)
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect})).ok).toBe(true)
  await heartbeatRuntimeInstance(x.db,x.input,{inspect,lease:{leaseId:acquired.endpoint_lease_id!,fencingToken:acquired.endpoint_lease_fencing_token}})
  expect((await x.f.query('SELECT acquired_at FROM control_plane_leases'))[0].acquired_at).toEqual(before)
  const lease={leaseId:acquired.endpoint_lease_id!,fencingToken:acquired.endpoint_lease_fencing_token}
  // Both sides of the historical boundary, including a future grant timestamp.
  for(const timestamp of [new Date(Date.parse(started)-1000),new Date(Date.parse(started)+1000),new Date('2100-01-01')]) {
    await x.f.query('UPDATE control_plane_leases SET acquired_at=$1',[timestamp])
    expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect})).ok).toBe(true)
    expect((await heartbeatRuntimeInstance(x.db,x.input,{inspect,lease})).endpoint_lease_id).toBe(lease.leaseId)
    expect((await x.f.query('SELECT acquired_at FROM control_plane_leases'))[0].acquired_at).toEqual(timestamp)
  }
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


test('NP04 valid UUID replay in a different actual process/workspace fails typed startup with endpoint publication 0 and work 0',async()=>{
 const f=await fixture('postgres',true),agentId=`np-startup-${randomUUID()}`,runtimeId=randomUUID()
 let original:Awaited<ReturnType<typeof runtimeStartupFixture>>|undefined,replacement:typeof original
 try {
  await insert(f,'agents',{agent_id:agentId,display_name:'startup fixture',agent_type:'dev'})
  original=await runtimeStartupFixture({agentId,runtimeId,databaseUrl:f.databaseUrl})
  expect(original.report.status).toBe('READY')
  expect(original.report.prepublishStatus).toBe(503)
  expect(original.report.publications).toBe(1)
  expect(original.report.work).toBe(0)
  expect(original.report.events.indexOf('socket-bound')).toBeLessThan(original.report.events.indexOf('COMMIT'))
  expect(original.report.events.indexOf('COMMIT')).toBeLessThan(original.report.events.indexOf('reauthorized'))
  expect(original.report.events.indexOf('reauthorized')).toBeLessThan(original.report.events.indexOf('endpoint-published'))
  const before=await f.query('SELECT * FROM control_plane_leases')
  expect(before).toHaveLength(1)
  expect(before[0].status).toBe('active')
  await original.close()
  replacement=await runtimeStartupFixture({agentId,runtimeId,databaseUrl:f.databaseUrl})
  console.log(JSON.stringify({case:'NP04-startup-replay-D-OWN-1',original:original.report,replacement:replacement.report,old_lease:before[0]}))
  expect(replacement.report.pid).not.toBe(original.report.pid)
  expect(replacement.dir).not.toBe(original.dir)
  expect(replacement.report.runtimeInstanceId).toBe(runtimeId)
  expect(replacement.report.status).toBe('STARTUP_FAILED')
  expect(replacement.report.errors).toEqual(['RUNTIME_ENDPOINT_REGISTRATION_FAILED','RUNTIME_UUID_ALREADY_REGISTERED'])
  expect(replacement.report.acquisitions).toBe(1)
  expect(replacement.report.prepublishStatus).toBe(503)
  expect(replacement.report.publications).toBe(0)
  expect(replacement.report.work).toBe(0)
  expect(replacement.report.events).toContain('ROLLBACK')
  expect(replacement.report.events).not.toContain('COMMIT')
  expect(await replacement.child.exited).toBe(1)
  await expect(fetch(`http://127.0.0.1:${replacement.report.port}`)).rejects.toThrow()
  expect(await f.query('SELECT * FROM control_plane_leases')).toEqual(before)
  expect(await f.query('SELECT runtime_instance_id FROM agent_runtime_instances')).toEqual([{runtime_instance_id:runtimeId}])
 }finally{await replacement?.close();await original?.close();await f.close()}
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


test('NP04-a/b unique observed UUID and current lease holder are required',async()=>{
 const x=await setup();try {
  await heartbeatRuntimeInstance(x.db,x.input)
  const actual=inspectHostRuntime({agentId:x.host.agentId})
  for(const observations of [actual.observations.map(o=>({...o,runtime_instance_id:randomUUID()})),[...actual.observations,...actual.observations]]) {
    expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId,inspect:()=>({...actual,observations})})).ok).toBe(false)
  }
  for(const patch of [{authority_live:0},{holder_agent_id:'wrong-agent'},{holder_runtime_instance_id:randomUUID()},{fencing_token:0}]) {
    const changed={async query(sql:string,args?:any[]){const result=await x.db.query(sql,args);return {rows:result.rows.map(r=>({...r,...patch}))}}}
    expect((await resolveRuntimeEndpoint(changed,{agentId:x.host.agentId})).ok).toBe(false)
  }
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId})).ok).toBe(true)
  const before=await x.f.query('SELECT * FROM control_plane_leases')
  await expect(x.f.query(`INSERT INTO control_plane_leases
    (lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at,metadata)
    SELECT $1,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token+1,status,expires_at,metadata
    FROM control_plane_leases`,[randomUUID()])).rejects.toThrow('idx_control_plane_leases_active_scope')
  expect(await x.f.query('SELECT * FROM control_plane_leases')).toEqual(before)
  await x.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()-interval '1 second'")
  expect((await resolveRuntimeEndpoint(x.db,{agentId:x.host.agentId})).ok).toBe(false)
 }finally{await x.close()}
},30000)

test('NP04-d pre-effect identity or fence change prevents the published endpoint handler from running',async()=>{
 const x=await setup();let endpoint:ReturnType<typeof bindRuntimeEndpoint>|undefined
 try {
  await heartbeatRuntimeInstance(x.db,x.input)
  let mode='stable',reads=0,observations=0,effects=0
  const db={async query(sql:string,args?:any[]){
    const result=await x.db.query(sql,args)
    return mode==='fence' && ++reads===2?{rows:result.rows.map(r=>({...r,fencing_token:Number(r.fencing_token)+1}))}:result
  }}
  const inspect:typeof inspectHostRuntime=input=>{
    const result=inspectHostRuntime(input)
    return mode==='identity' && ++observations===2?{...result,observations:result.observations.map(o=>({...o,process_id:o.process_id+1}))}:result
  }
  endpoint=bindRuntimeEndpoint({port:0,fetch:()=>{effects++;return new Response('effect')},async authorize(){
    reads=0;observations=0
    return (await resolveRuntimeEndpoint(db,{agentId:x.host.agentId,inspect})).ok
  }})
  await endpoint.publish(async()=>{})
  for(const change of ['identity','fence']) {
    mode=change
    expect((await fetch(endpoint.endpointUri)).status).toBe(503)
    expect(effects).toBe(0)
  }
  mode='stable';expect((await fetch(endpoint.endpointUri)).status).toBe(200);expect(effects).toBe(1)
 }finally{endpoint?.server.stop(true);await x.close()}
},30000)

test('NP04-e resolve paths do not read acquired_at or call process-start interval ownership helpers',()=>{
 for(const name of ['runtime-endpoint','runtime-current-resolver','seat-runtime-selection','runtime-native-authority']) {
  const source=readFileSync(join(import.meta.dir,'../../core',name+'.ts'),'utf8')
  expect(source).not.toMatch(/acquired_at|authorityAcquiredAfterStart|processStartUpperBoundMs/)
 }
 expect(readFileSync(join(import.meta.dir,'../../core/runtime-heartbeat.ts'),'utf8')).not.toMatch(/authorityAcquiredAfterStart|processStartUpperBoundMs/)
})


test('NP04-c actual server UUID replay exits before transports, shared startup and queued work',async()=>{
 const f=await fixture('postgres',true),agentId=`np-server-${randomUUID()}`,runtimeId=randomUUID()
 let original:Awaited<ReturnType<typeof runtimeStartupFixture>>|undefined
 try {
  await insert(f,'agents',{agent_id:agentId,display_name:agentId,agent_type:'dev'})
  original=await runtimeStartupFixture({agentId,runtimeId,databaseUrl:f.databaseUrl})
  expect(original.report.status).toBe('READY')
  await original.close()
  const messageId=randomUUID()
  await insert(f,'agent_messages',{id:messageId,author_id:agentId,content:'owned pending fixture',message_type:'chat'})
  await insert(f,'message_queue',{agent_id:agentId,message_id:messageId,payload:'{}',status:'pending'})
  const beforeLease=await f.query('SELECT * FROM control_plane_leases'),beforeWork=await f.query('SELECT * FROM message_queue')
  for(const disabled of [false,true]) {
  const server=spawnObservedServer(join(import.meta.dir,'../..'),{PATH:process.env.PATH!,LANG:'C',
    AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,AGENT_COMMS_CONFIG:join(original.dir,'absent.json'),
    DATABASE_URL:f.databaseUrl,AGENT_COM_DB:'postgres',AGENT_COM_PG_NOTIFY:'false',
    AGENT_COMMS_TTL_SWEEP_DISABLED:'1',AGENT_COM_LEGACY_DISCORD_GATEWAY:'0',DISCORD_BOT_TOKEN:'',
    AGENT_COM_RUNTIME_HEARTBEAT_DISABLED:disabled?'1':'0'},runtimeId)
  let stderr='';server.stderr!.on('data',chunk=>{stderr+=String(chunk)})
  const code=await new Promise<number|null>((resolve,reject)=>{
    const timer=setTimeout(()=>{server.kill('SIGTERM');reject(Error('REPLAY_SERVER_DID_NOT_STOP'))},15000)
    server.once('close',code=>{clearTimeout(timer);resolve(code)})
  })
  console.log(JSON.stringify({case:'NP04-actual-server-startup',authority_disabled:disabled,exit_code:code,stderr,pending_before:beforeWork.length,
    pending_after:(await f.query('SELECT * FROM message_queue')).length}))
  expect(code).toBe(1)
  expect(stderr).toContain(disabled?'runtime startup failed: Error: RUNTIME_AUTHORITY_DISABLED':
    'runtime startup failed: Error: RUNTIME_ENDPOINT_REGISTRATION_FAILED; cause=RUNTIME_UUID_ALREADY_REGISTERED')
  expect(stderr).not.toContain('SSE server listening')
  expect(stderr).not.toContain('legacy Discord WebSocket disabled')
  expect(await f.query('SELECT * FROM control_plane_leases')).toEqual(beforeLease)
  expect(await f.query('SELECT * FROM message_queue')).toEqual(beforeWork)
  const port=Number(/bridge listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr)?.[1])
  expect(port).toBeGreaterThan(0)
  await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
  }
 }finally{await closeObservedServers();await original?.close();await f.close()}
},30000)

test('NP04-c server startup acquisition precedes every transport and background work entry',()=>{
 const source=readFileSync(join(import.meta.dir,'../../server.ts'),'utf8')
 const barrier=source.indexOf('try {\n  await postConnect()\n} catch (error)')
 expect(barrier).toBeGreaterThan(0)
 for(const entry of ['setInterval(gc, GC_INTERVAL_MS)','httpServer = createServer',';(async () => {\n  // Start pg_notify listener','mcp.connect(transport)']) {
  expect(source.indexOf(entry)).toBeGreaterThan(barrier)
 }
 const registration=source.slice(source.indexOf('async function registerAgent()'),source.indexOf('async function unregisterAgent()'))
 expect(registration.indexOf('await heartbeatRuntimeEvidence(client)')).toBeLessThan(registration.indexOf('pollingDriver.start(AGENT_ID'))
})
