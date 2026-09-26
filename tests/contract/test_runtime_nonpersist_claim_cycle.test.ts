import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { receiveTargeted } from '../../bin/aun/receive'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'
import { runReceivedQueueWork, finalizeDoneQueueWork, type LlmRuntimeAdapter } from '../../core/queue-work'
import { claimUnboundedRuntimeQueue } from '../../core/runtime-queue-claim'
import { StateDaemon } from '../../core/state-daemon'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './state-daemon/fakes'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'
import { SqliteAdapter } from '../../core/db'
import { join } from 'node:path'

test('NP02/08 receive new claim → refresh → done → finalize binds the actual incarnation; replacement cannot execute or finish old work', async () => {
  const f=await fixture('postgres',true), agent=`claim-${randomUUID()}`
  let host=await nonpersistHostFixture(randomUUID(),agent), daemon:StateDaemon|undefined
  const db={dialect:'postgres' as const,async query<T>(sql:string,params?:unknown[]) {const rows=await f.query(sql,params);return {rows:rows as T[],rowCount:rows.length}}}
  const url=new URL(process.env.AGENT_COM_TEST_DATABASE_URL!);url.pathname='/'+f.name
  let invocations=0,sends=0
  const adapter:LlmRuntimeAdapter={runtime_id:'isolated-recorder',capabilities:{input:'stdin_prompt',output:'schema_json',supportsBareMode:false,supportsResume:false,supportsToolAllowlist:false,supportsSandbox:false,supportsUsageMetadata:false},
    async invoke(){invocations++;return {schema_version:'queue_work_result_v1',ok:true,summary:'isolated completion',next_action:'close'}}}
  const register=()=>heartbeatRuntimeInstance(db,{agentId:agent,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
    port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir})
  try {
    await insert(f,'agents',{agent_id:agent,display_name:'private claim',agent_type:'dev',profile_enabled:true})
    await register()
    const channel=randomUUID()
    await insert(f,'channels',{id:channel,name:'private claim',members:[agent]})
    const queued=async()=>{
      const message=randomUUID()
      await insert(f,'agent_messages',{id:message,author_id:agent,channel_id:channel,content:'isolated instruction',message_type:'instruction'})
      await insert(f,'message_queue',{agent_id:agent,message_id:message,status:'pending',payload:JSON.stringify({content:'isolated instruction',message_type:'instruction',reply_contract:{required:false}})})
      return (await f.query('SELECT id FROM message_queue WHERE message_id=$1',[message]))[0].id
    }
    const claim=async(id:number)=>{
      const result=await receiveTargeted({agentId:agent,queueId:String(id),env:{PATH:process.env.PATH,DATABASE_URL:url.href,
        AGENT_COM_DB:'postgres',AGENT_ID:agent,AGENT_COM_EXPECTED_AGENT_ID:agent,AGENT_COM_RUNTIME_INSTANCE_ID:host.runtimeId,AGENT_COMMS_CLAIM_TTL_SEC:'120'}})
      expect(result.ok,result.stderr+result.stdout).toBe(true)
      const row=(await f.query('SELECT * FROM message_queue WHERE id=$1',[id]))[0]
      expect(row.claimed_runtime_instance_id).toBe(host.runtimeId)
      expect(row.claimed_by).toBe(agent)
      return row
    }
    daemon=new StateDaemon({db,pgListen:new FakePgListen(),tmux:new FakeTmux(),clock:new FakeClock(new Date()),metrics:new FakeMetrics(),alert:new FakeAlertSink(),
      config:{agentIdPrefix:agent,pollSweepIntervalMs:3600000,heartbeatIntervalMs:3600000}})
    await daemon.start()
    const first=await queued();await claim(first)
    expect((await daemon.refreshClaims()).refreshed).toBe(1)
    expect((await runReceivedQueueWork(db,{queueId:first,adapter,runtimeInstanceId:host.runtimeId})).code).toBe('DONE')
    const result=JSON.parse((await f.query('SELECT payload FROM message_queue WHERE id=$1',[first]))[0].payload).runner_result
    expect(result.claim_fence.runtime_instance_id).toBe(host.runtimeId)
    expect((await finalizeDoneQueueWork(db,{queueId:first,runtimeInstanceId:host.runtimeId})).code).toBe('CLOSED')

    const done=await queued();await claim(done)
    expect((await runReceivedQueueWork(db,{queueId:done,adapter})).code).toBe('DONE')
    const received=await queued();await claim(received)
    const inFlight=await queued();await claim(inFlight)
    const oldId=host.runtimeId
    const interrupted=await runReceivedQueueWork(db,{queueId:inFlight,adapter:{...adapter,async invoke(){
      invocations++;await host.close();host=await nonpersistHostFixture(randomUUID(),agent);await register()
      return {schema_version:'queue_work_result_v1',ok:true,summary:'late old completion',next_action:'close'}
    }}})
    expect(interrupted.code).toBe('CLAIM_OWNERSHIP_LOST')
    const replacementRun=await runReceivedQueueWork(db,{queueId:received,adapter,runtimeInstanceId:host.runtimeId})
    expect(replacementRun.code).toBe('CLAIM_NOT_OWNED')
    const replacementFinalize=await finalizeDoneQueueWork(db,{queueId:done,runtimeInstanceId:host.runtimeId,
      replySender:{async sendReply(){sends++;return {}}}})
    expect(replacementFinalize.code).toBe('TERMINAL_EVIDENCE_INVALID')
    expect(sends).toBe(0)
    const refresh=await daemon.refreshClaims()
    expect(refresh.refreshed).toBe(0);expect(refresh.skipped).toBe(2)
    const stale=(await f.query('SELECT status,payload,claimed_runtime_instance_id FROM message_queue WHERE id=$1',[inFlight]))[0]
    expect(stale.status).toBe('in_progress');expect(stale.claimed_runtime_instance_id).toBe(oldId)
    expect(JSON.parse(stale.payload).runner_result).toBeUndefined()
    const fresh=await queued();await claim(fresh)
    expect((await daemon.refreshClaims()).refreshed).toBe(1)
    expect((await runReceivedQueueWork(db,{queueId:fresh,adapter,runtimeInstanceId:host.runtimeId})).code).toBe('DONE')
    expect((await finalizeDoneQueueWork(db,{queueId:fresh,runtimeInstanceId:host.runtimeId})).code).toBe('CLOSED')
    const race=await queued()
    await f.query('BEGIN')
    const revoked={async query(sql:string,params?:unknown[]){
      if(sql.startsWith('UPDATE message_queue'))await f.query("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id=$1",[host.runtimeId])
      return db.query(sql,params)
    }}
    await expect(claimUnboundedRuntimeQueue(revoked,{agentId:agent,queueId:race,ttlSeconds:30})).rejects.toThrow('CLAIM_RUNTIME_FENCE_CHANGED')
    await f.query('ROLLBACK')
    expect((await f.query('SELECT status FROM message_queue WHERE id=$1',[race]))[0].status).toBe('pending')
    expect((await f.query('SELECT status,status_detail,channel_port,last_seen_at FROM agents WHERE agent_id=$1',[agent]))[0])
      .toEqual({status:null,status_detail:null,channel_port:null,last_seen_at:null})
    console.log(JSON.stringify({case:'ordinary-claim-incarnation-cycle',recorded_invocations:invocations,provider_invocations:0,external_sends:sends,
      successful_claims:5,replacement_denials:3,claim_race_denials:1}))
  } finally {await daemon?.stop();await host.close();await f.close()}
},60000)

test('NP02/08 SQLite logical claim SQL and incarnation-bound done/finalize use the normal adapter',async()=>{
  const f=await fixture('sqlite',true),agent=`sqlite-claim-${randomUUID()}`
  const host=await nonpersistHostFixture(randomUUID(),agent)
  const sqlite=new SqliteAdapter(join(process.env.AUN_NP_FIXTURE_ROOT!,f.name+'.sqlite'))
  const db={dialect:'sqlite' as const,async query<T>(sql:string,params?:unknown[]){const rows=await sqlite.query<T>(sql,params);return {rows,rowCount:rows.length}}}
  try {
    await insert(f,'agents',{agent_id:agent,display_name:agent,agent_type:'dev',profile_enabled:true})
    await heartbeatRuntimeInstance(db,{agentId:agent,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
      port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir})
    const message=randomUUID()
    await insert(f,'agent_messages',{id:message,author_id:agent,content:'private SQLite work',message_type:'instruction'})
    await insert(f,'message_queue',{agent_id:agent,message_id:message,status:'pending',payload:JSON.stringify({content:'private SQLite work',reply_contract:{required:false}})})
    const row=(await f.query('SELECT id FROM message_queue WHERE message_id=$1',[message]))[0]
    await db.query('BEGIN')
    const claim=await claimUnboundedRuntimeQueue(db,{agentId:agent,queueId:row.id,ttlSeconds:120})
    await db.query('COMMIT')
    expect(claim.claimed_runtime_instance_id).toBe(host.runtimeId)
    const adapter:LlmRuntimeAdapter={runtime_id:'private-sqlite-recorder',capabilities:{input:'stdin_prompt',output:'schema_json',supportsBareMode:false,supportsResume:false,supportsToolAllowlist:false,supportsSandbox:false,supportsUsageMetadata:false},
      async invoke(){return {schema_version:'queue_work_result_v1',ok:true,summary:'done',next_action:'close'}}}
    expect((await runReceivedQueueWork(db,{queueId:row.id,adapter,runtimeInstanceId:host.runtimeId})).code).toBe('DONE')
    expect((await finalizeDoneQueueWork(db,{queueId:row.id,runtimeInstanceId:host.runtimeId})).code).toBe('CLOSED')
    expect((await f.query('SELECT status,claimed_runtime_instance_id FROM message_queue WHERE id=$1',[row.id]))[0])
      .toEqual({status:'replied',claimed_runtime_instance_id:host.runtimeId})
  }finally {await sqlite.close();await host.close();await f.close()}
},20000)
