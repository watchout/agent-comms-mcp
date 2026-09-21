import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { durableMemoryMetadata } from '../../core/runtime-durable-data'
import { recordRuntimeMemoryReadyEvidence } from '../../core/runtime-memory-ready'

for(const kind of ['postgres','sqlite'] as const)test(`NP01/10 ${kind} typed logical columns reject an observation hidden in an allowed key`,async()=>{
 const f=await fixture(kind,true)
 try {
  const agent='typed-fixture',id=randomUUID()
  await insert(f,'agents',{agent_id:agent,display_name:agent,agent_type:'dev'})
  const input={agent_id:agent,project:'typed-project',runtime_instance_id:id,expected_agent_id:agent,
   completed_at:new Date().toISOString(),valid_until:new Date(Date.now()+60000).toISOString(),
   result_status:'failed',failure_reason:'MEMORY_CONTEXT_RECOVERY_REQUIRED',source:'fixture',metadata:'{}'}
  await insert(f,'runtime_memory_ready_evidence',input)
  const before=await f.query('SELECT * FROM runtime_memory_ready_evidence')
  for(const key of ['source','failure_reason','evidence_log_id','checkout_commit_sha']) {
   await expect(insert(f,'runtime_memory_ready_evidence',{...input,[key]:'/observed/process/path'})).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
   await expect(f.query(`UPDATE runtime_memory_ready_evidence SET ${key}=$1`,['/observed/process/path'])).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
   expect(await f.query('SELECT * FROM runtime_memory_ready_evidence')).toEqual(before)
  }
  await f.query("UPDATE runtime_memory_ready_evidence SET failure_reason='MEMORY_ORIGINAL_UNAVAILABLE'")
  expect((await f.query('SELECT failure_reason FROM runtime_memory_ready_evidence'))[0].failure_reason).toBe('MEMORY_ORIGINAL_UNAVAILABLE')
 }finally{await f.close()}
},30000)

test('NP01 machine-field serializer rejects before SQL without altering original operator text',async()=>{
 let writes=0
 const db={async query(){writes++;return []}}
 const input={agent_id:'typed',project:'typed-project',runtime_instance_id:randomUUID(),expected_agent_id:'typed',
  session_name:'synthetic',port:12345,recovery_command:'synthetic',result_status:'failed' as const,
  completed_at:new Date().toISOString(),valid_until:new Date(Date.now()+60000).toISOString(),source:'fixture'}
 for(const key of ['source','failure_reason','evidence_log_id','checkout_commit_sha'])
   await expect(recordRuntimeMemoryReadyEvidence(db,{...input,[key]:'/observed/process/path'})).rejects.toThrow('MEMORY_DURABLE_FIELD_INVALID')
 expect(writes).toBe(0)
 expect(durableMemoryMetadata({reason:'Owner original mentions /path and PID 123.'}).reason).toBe('Owner original mentions /path and PID 123.')
})
