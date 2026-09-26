import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { StateDaemon, evaluateStateDaemonAutomaticProcessingEligibility } from '../../core/state-daemon'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './state-daemon/fakes'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'

test('NP02/04/08 daemon eligibility and claim renewal work with NULL physical rows and reject a changed fence',async()=>{
 const f=await fixture('postgres',true),host=await nonpersistHostFixture()
 let daemon:StateDaemon|undefined
 try {
  const db:any={async query(sql:string,params:unknown[]=[]){const rows=await f.query(sql,params);return {rows,rowCount:rows.length}}}
  await insert(f,'agents',{agent_id:host.agentId,display_name:'daemon fixture',agent_type:'dev',profile_enabled:true})
  const channel=randomUUID(),message=randomUUID()
  await insert(f,'channels',{id:channel,name:'private',members:[host.agentId]})
  await heartbeatRuntimeInstance(db,{agentId:host.agentId,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
    port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir})
  expect((await evaluateStateDaemonAutomaticProcessingEligibility(db,{agentId:host.agentId,channelId:channel})).ok).toBe(true)
  await insert(f,'agent_messages',{id:message,author_id:host.agentId,channel_id:channel,content:'private unfinished',message_type:'chat'})
  await insert(f,'message_queue',{agent_id:host.agentId,message_id:message,payload:'{}',status:'in_progress',claimed_by:host.agentId,
    claimed_at:new Date().toISOString(),claim_expires_at:new Date(Date.now()+30000).toISOString(),claimed_runtime_instance_id:host.runtimeId})
  let replace=false
  const guardedDb:any={async query(sql:string,params:unknown[]=[]){
    if(replace && sql.startsWith('UPDATE message_queue SET claim_expires_at')) {
      await f.query('UPDATE control_plane_leases SET fencing_token=fencing_token+1')
      replace=false
    }
    return db.query(sql,params)
  }}
  const tmux=new FakeTmux()
  daemon=new StateDaemon({db:guardedDb,pgListen:new FakePgListen(),tmux,clock:new FakeClock(new Date()),metrics:new FakeMetrics(),alert:new FakeAlertSink(),
    config:{agentIdPrefix:host.agentId,claimTtlSec:120,pollSweepIntervalMs:3600000,heartbeatIntervalMs:3600000}})
  await daemon.start()
  const before=await f.query('SELECT * FROM message_queue')
  expect((await daemon.refreshClaims()).refreshed).toBe(1)
  const renewed=await f.query('SELECT * FROM message_queue')
  expect(new Date(renewed[0].claim_expires_at).getTime()).toBeGreaterThan(new Date(before[0].claim_expires_at).getTime())
  expect(renewed[0].claimed_at).toEqual(before[0].claimed_at)
  expect(renewed[0].claimed_runtime_instance_id).toBe(host.runtimeId)
  replace=true
  expect((await daemon.refreshClaims()).refreshed).toBe(0)
  expect(await f.query('SELECT * FROM message_queue')).toEqual(renewed)
  await f.query("UPDATE control_plane_leases SET status='released'")
  expect((await evaluateStateDaemonAutomaticProcessingEligibility(db,{agentId:host.agentId,channelId:channel})).ok).toBe(false)
  expect((await daemon.refreshClaims()).refreshed).toBe(0)
  for(const row of await f.query('SELECT runtime,status,last_seen_at FROM agents'))expect(row).toEqual({runtime:null,status:null,last_seen_at:null})
  expect(tmux.sentKeys).toEqual([]);expect(tmux.restarts).toEqual([])
 }finally{await daemon?.stop();await host.close();await f.close()}
},30000)
