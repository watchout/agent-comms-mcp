import { test, expect } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrateSqlite } from '../../db/migrate-sqlite'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { nativeHostFixture, registerNativeFixtureRuntime, stopNativeFixtures } from '../helpers/seat-native-runtime-fixture'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'
import { evaluateRuntimeMemoryReadyGate, recordVerifiedNativeRuntimeMemoryReady } from '../../core/runtime-memory-ready'

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
    for(const changed of [{...original,project:'foreign'}, {...original,native_delivery:{...original.native_delivery!,provider_started_at:'1970-01-01T00:00:00Z'}}]) {
      expect((await evaluateRuntimeMemoryReadyGate(db,{...input,readNativeProof:async()=>changed})).ok).toBe(false)
    }
    await db.execute(`UPDATE runtime_memory_ready_evidence SET valid_until='2000-01-01T00:00:00Z'`)
    expect((await evaluateRuntimeMemoryReadyGate(db,input)).ok).toBe(false)
    expect(original.native_delivery?.provider_pid).toBe(fixture.observed.provider.pid)
  }finally{await stopNativeFixtures();await db.close();rmSync(dir,{recursive:true,force:true})}
},60000)
