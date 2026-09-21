import { test, expect } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrateSqlite } from '../../db/migrate-sqlite'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { nativeHostFixture, registerNativeFixtureRuntime, stopNativeFixtures } from '../helpers/seat-native-runtime-fixture'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'
import { evaluateRuntimeMemoryReadyGate, recordRuntimeMemoryReadyEvidence, recordVerifiedNativeRuntimeMemoryReady } from '../../core/runtime-memory-ready'

test('NP07 actual native pipe original is re-read; AUN persists logical proof only and stale/copied proof never admits',async()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-native-'))),file=join(dir,'aun.db')
  const agent=`np-native-${randomUUID()}`,project='np-native-project',runtimeId=randomUUID(),session=`np-session-${randomUUID()}`
  migrateSqlite(file)
  const db=new SqliteAdapter(file)
  try{
    await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,metadata,profile_enabled) VALUES($1,$1,'dev',$2,1)`,
      [agent,JSON.stringify({memory_project:project})])
    const fixture=await nativeHostFixture(dir,dir,agent,project,session,'accepted',runtimeId)
    await registerNativeFixtureRuntime(db,fixture,agent,project,session,dir,runtimeId)
    let reads=0
    const readProof=async()=>{reads++;return readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:runtimeId,targetRuntime:'codex',
      providerPid:fixture.observed.provider.pid,providerStartedAt:fixture.observed.provider.startedAt,hostSessionId:session,
      transport:{command:fixture.node,args:[fixture.memory],env:fixture.env},cwd:dir,
      env:{PATH:process.env.PATH!,LANG:'C',...fixture.env}})}
    const original=await readProof()
    expect(original.completed_at).toBe(original.native_delivery!.delivered_at)
    expect((await readProof()).completed_at).toBe(original.completed_at)
    await recordVerifiedNativeRuntimeMemoryReady(db,{agentId:agent,project,runtimeInstanceId:runtimeId,receipt:original,
      inspect:fixture.inspect,observeProvider:fixture.observeProvider,readNativeProof:readProof})
    const input={agent_id:agent,project,requested_runtime_kind:'local_process',inspect:fixture.inspect,readNativeProof:readProof}
    const before=reads,good=await evaluateRuntimeMemoryReadyGate(db,input)
    expect(good.ok).toBe(true);expect(reads).toBeGreaterThan(before)
    const saved=await db.query<any>('SELECT * FROM runtime_memory_ready_evidence')
    expect(saved).toHaveLength(1)
    for(const key of ['session_name','port','checkout_path','recovery_command','evidence_path'])expect(saved[0][key]).toBeNull()
    const metadata=JSON.parse(saved[0].metadata)
    expect(metadata.seat_context_proof.runtime_instance_id).toBe(runtimeId)
    expect(metadata.seat_context_receipt).toBeUndefined();expect(metadata.native_delivery).toBeUndefined()
    expect(JSON.stringify(saved)).not.toContain(dir)
    expect(JSON.stringify(saved)).not.toContain(String(fixture.observed.endpoint.port))
    // A valid saved row alone is insufficient when the original transport fails.
    expect((await evaluateRuntimeMemoryReadyGate(db,{...input,readNativeProof:async()=>{throw new Error('original unavailable')}})).ok).toBe(false)
    // Re-reading an actual receipt with a changed project or provider-start is rejected.
    for(const changed of [{...original,project:'foreign'}, {...original,native_delivery:{...original.native_delivery!,provider_pid:fixture.observed.provider.pid+1}}, {...original,native_delivery:{...original.native_delivery!,provider_started_at:'1970-01-01T00:00:00Z'}}, {...original,completed_at:'2100-01-01T00:00:00Z'}]) {
      expect((await evaluateRuntimeMemoryReadyGate(db,{...input,readNativeProof:async()=>changed})).ok).toBe(false)
    }
    // Expiry after the initial SQL read, while real native I/O is pending,
    // must be rechecked before returning admission.
    expect((await evaluateRuntimeMemoryReadyGate(db,{...input,readNativeProof:async()=>{
      const receipt=await readProof()
      await db.execute(`UPDATE runtime_memory_ready_evidence SET valid_until='2000-01-01T00:00:00Z'`)
      return receipt
    }})).ok).toBe(false)
    await db.execute(`UPDATE runtime_memory_ready_evidence SET valid_until='2000-01-01T00:00:00Z'`)

    expect((await evaluateRuntimeMemoryReadyGate(db,input)).ok).toBe(false)
    expect(original.native_delivery?.provider_pid).toBe(fixture.observed.provider.pid)
    const timestamp=new Date().toISOString(),expires=new Date(Date.now()+60000).toISOString()
    const bypass={actor:'fixture-owner',reason:'Scoped repair retains original /operator/text.',timestamp,
      expires_at:expires,target:{agent_id:agent},queue_scope:{agent_id:agent,queue_ids:[1,3],statuses:['pending','received'],action_kinds:['invoke']}}
    await recordRuntimeMemoryReadyEvidence(db,{agent_id:agent,project,runtime_instance_id:runtimeId,expected_agent_id:agent,
      session_name:session,port:fixture.observed.endpoint.port,recovery_command:'explicit_operator_bypass',
      result_status:'bypassed',source:'explicit_operator_bypass',completed_at:timestamp,valid_until:expires,metadata:bypass})
    const storedBypass=JSON.parse((await db.query<any>("SELECT metadata FROM runtime_memory_ready_evidence WHERE result_status='bypassed'"))[0].metadata)
    expect(storedBypass.target).toEqual(bypass.target);expect(storedBypass.queue_scope).toEqual(bypass.queue_scope)
    expect(storedBypass.reason).toBe(bypass.reason)
    for(const [queue,status,action,allowed] of [[1,'pending','invoke',true],[3,'received','invoke',true],[2,'pending','invoke',false],[1,'done','invoke',false],[1,'pending','delete',false]] as const) {
      const gate=await evaluateRuntimeMemoryReadyGate(db,{...input,queue_scope:{queue_id:queue,status,action_kind:action},readNativeProof:async()=>{throw new Error('bypass must not call native')}})
      expect(gate.ok).toBe(allowed)
    }

  }finally{await stopNativeFixtures();await db.close();rmSync(dir,{recursive:true,force:true})}
},60000)


for(const mode of ['absent','pending'] as const)test(`NP07 real native ${mode} original cannot produce a receipt`,async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-native-negative-')))
 const agent=`np-negative-${randomUUID()}`,project='np-native-negative',id=randomUUID(),session=`np-session-${randomUUID()}`
 try {
  const fixture=await nativeHostFixture(dir,dir,agent,project,session,mode,id)
  await expect(readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:id,targetRuntime:'codex',
    providerPid:fixture.observed.provider.pid,providerStartedAt:fixture.observed.provider.startedAt,hostSessionId:session,
    transport:{command:fixture.node,args:[fixture.memory],env:fixture.env},cwd:dir,
    env:{PATH:process.env.PATH!,LANG:'C',...fixture.env}})).rejects.toThrow()
 }finally{await stopNativeFixtures();rmSync(dir,{recursive:true,force:true})}
},30000)
