import { describe,test,expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fixture,insert,seed,snapshot,digest,upgrade,repo } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const version='aun-runtime-nonpersistence/v1'
for(const kind of ['postgres','sqlite'] as const)describe(kind+' runtime observation non-persistence',()=>{
 test('legacy rows and every runtime FK survive; reapply does not rewrite history; logical work still advances',async()=>{
  const f=await fixture(kind);try {
   const ids=await seed(f),before=await snapshot(f)
   await f.apply();const after=await snapshot(f);expect(after).toEqual(before)
   await f.apply();expect(await snapshot(f)).toEqual(before)
   for(const [table,col] of [['message_queue','assigned_runtime_instance_id'],['message_queue','claimed_runtime_instance_id'],['control_plane_leases','holder_runtime_instance_id'],['connector_instances','runtime_instance_id'],['worker_activity','runtime_instance_id'],['outbound_queue','claimed_runtime_instance_id']])expect((await f.query(`SELECT ${col} value FROM ${table}`))[0].value).toBe(ids.runtime)
   await f.query("UPDATE message_queue SET status='done',done_at=$1 WHERE agent_id='fixture-agent'",['2026-09-21T02:00:00Z'])
   await f.query("UPDATE control_plane_leases SET status='released',released_at=$1 WHERE lease_id=$2",['2026-09-21T02:00:00Z',ids.lease])
   expect((await f.query('SELECT fencing_token FROM control_plane_leases'))[0].fencing_token).toBeOneOf([7,'7'])
   await f.query("UPDATE agents SET display_name='logical-new' WHERE agent_id='fixture-agent'")
   expect((await f.query('SELECT runtime,status,home_directory FROM agents'))[0]).toEqual({runtime:'codex',status:'busy',home_directory:'/historical/workspace'})
   console.log(JSON.stringify({case:'legacy-preservation',kind,before_sha256:digest(before),after_sha256:digest(after),runtime_fk_assertions:6,reapply:'UNCHANGED',logical_queue_and_lease:'PASS'}))
  }finally{await f.close()}
 })
 test('new logical anchor has NULL physical defaults; old writers and nested/aliased copies reject',async()=>{
  const f=await fixture(kind);try{
   const ids=await seed(f);await f.apply()
   const anchor=randomUUID();await insert(f,'agent_runtime_instances',{runtime_instance_id:anchor,agent_id:'fixture-agent',runtime_kind:'local_process',metadata:JSON.stringify({schema_version:version,source_commit:'a'.repeat(40)})})
   const row=(await f.query('SELECT runtime_engine,status,started_at,port,process_id,host_id,checkout_path FROM agent_runtime_instances WHERE runtime_instance_id=$1',[anchor]))[0]
   expect(Object.values(row).every(v=>v===null)).toBe(true)
   await insert(f,'runtime_memory_ready_evidence',{agent_id:'fixture-agent',project:'fixture-project',runtime_instance_id:anchor,expected_agent_id:'fixture-agent',result_status:'ready',completed_at:'2026-09-21T00:00:00Z',valid_until:'2099-01-01T00:00:00Z',source:'fixture',metadata:JSON.stringify({schema_version:version,seat_context_proof:{agent_id:'fixture-agent',project:'fixture-project',runtime_instance_id:anchor,work_digest:'b'.repeat(64)}})})
   const rejected=[
    ()=>insert(f,'agent_runtime_instances',{runtime_instance_id:randomUUID(),agent_id:'fixture-agent',runtime_engine:'codex'}),
    ()=>f.query('UPDATE agent_runtime_instances SET port=45556 WHERE runtime_instance_id=$1',[ids.runtime]),
    ()=>f.query('UPDATE agent_runtime_instances SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,renamed_snapshot:{value:'base64-physical-tuple'}}),anchor]),
    ()=>f.query('UPDATE agent_runtime_instances SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,source_commit:'/encoded/provider/path'}),anchor]),
    ()=>f.query('UPDATE agent_runtime_instances SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,mcp_runtime_instance_id:'-'.repeat(36)}),anchor]),
    ()=>f.query('UPDATE agent_runtime_instances SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,'seat_context_proof.agent_id':'alias'}),anchor]),
    ()=>f.query('UPDATE runtime_memory_ready_evidence SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,seat_context_proof:{work_digest:'/observed/pid/123'}}),anchor]),
    ()=>f.query("UPDATE agents SET metadata=$1 WHERE agent_id='fixture-agent'",[JSON.stringify({memory_project:'fixture-project'})]),
    ()=>f.query('UPDATE runtime_memory_ready_evidence SET metadata=$1 WHERE runtime_instance_id=$2',[JSON.stringify({schema_version:version,seat_context_proof:{agent_id:'fixture-agent',native_delivery:{provider_pid:3}}}),anchor]),
    ()=>f.query('UPDATE control_plane_leases SET metadata=$1 WHERE lease_id=$2',[JSON.stringify({schema_version:version,foo:{port:9}}),ids.lease]),
    ()=>f.query("UPDATE agents SET metadata=$1 WHERE agent_id='fixture-agent'",[JSON.stringify({provider_observation:{pid:999},memory_project:'fixture-project'})]),
    ()=>f.query("UPDATE agent_workspaces SET local_path='/new/path' WHERE workspace_id='logical-workspace'"),
    ()=>insert(f,'audit_log',{event_type:'runtime.memory_ready_identity',target:anchor,detail:JSON.stringify({code:'WRONG_IDENTITY',error:'/process/path:4000'})}),
    ()=>insert(f,'audit_log',{event_type:'runtime.cleanup_target',target:'listener:123:456:abc',detail:JSON.stringify({risk:'none'})}),
    ()=>insert(f,'event_log',{event_id:randomUUID(),event_type:'reply.failed',payload:JSON.stringify({kind:'retryable',error:'http://127.0.0.1:4'})}),
   ]
   for(const attempt of rejected){const before=await snapshot(f);await expect(attempt()).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN');expect(await snapshot(f)).toEqual(before)}
   await insert(f,'audit_log',{event_type:'runtime.cleanup_target',target:anchor,detail:JSON.stringify({dry_run:true,classification:'owned',risk:'none',runtime_instance_id:anchor,action_kinds:['stop']})})
   await insert(f,'event_log',{event_id:randomUUID(),event_type:'reply.failed',payload:JSON.stringify({kind:'retryable',code:'DELIVERY_RETRYABLE_FAILURE'})})
   await insert(f,'agent_messages',{id:randomUUID(),author_id:'fixture-agent',content:'Owner request: codex PID 42 /tmp/workspace port 9911 must remain literal.',message_type:'chat'})
   console.log(JSON.stringify({case:'guards-and-null-anchor',kind,rejected_cases:rejected.length,logical_audit_event_and_owner_content:'PRESERVED'}))
  }finally{await f.close()}
 })
 test('injected migration failure rolls back schema, every legacy row and FK',async()=>{
  const f=await fixture(kind);try{
   await seed(f)
   if(kind==='sqlite') {f.db!.exec('PRAGMA foreign_keys=OFF');await f.query("UPDATE outbound_queue SET claimed_runtime_instance_id='00000000-0000-0000-0000-000000000099'");f.db!.exec('PRAGMA foreign_keys=ON')}
   const before=await snapshot(f)
   if(kind==='postgres'){await expect(f.exec(upgrade.replace('COMMIT;','SELECT 1/0;\nCOMMIT;'))).rejects.toThrow('division by zero');await f.exec('ROLLBACK')}
   else await expect(f.apply()).rejects.toThrow('FOREIGN_KEY_CHECK_FAILED')
   expect(await snapshot(f)).toEqual(before)
   // The old NOT NULL contract must still be present after rollback.
   await expect(insert(f,'runtime_memory_ready_evidence',{agent_id:'fixture-agent',project:'p',runtime_instance_id:randomUUID(),expected_agent_id:'fixture-agent',result_status:'ready',completed_at:'2026-09-21T00:00:00Z',valid_until:'2099-01-01T00:00:00Z',source:'fixture'})).rejects.toThrow()
   console.log(JSON.stringify({case:'rollback',kind,before_sha256:digest(before),after_sha256:digest(await snapshot(f)),schema_restored:true}))
  }finally{await f.close()}
 })
 test('fresh schema accepts a physical-free anchor and preserves ordinary lease metadata',async()=>{
  const f=await fixture(kind,true);try{
   await insert(f,'agents',{agent_id:'fresh-agent',display_name:'fresh',agent_type:'bot',channel_port:0})
   const id=randomUUID();await insert(f,'agent_runtime_instances',{runtime_instance_id:id,agent_id:'fresh-agent',runtime_kind:'local_process',metadata:JSON.stringify({schema_version:version})})
   await insert(f,'control_plane_leases',{lease_id:randomUUID(),lease_scope_type:'queue_partition',lease_scope_id:'logical-queue',lease_purpose:'worker',holder_agent_id:'fresh-agent',holder_runtime_instance_id:id,fencing_token:1,status:'active',expires_at:'2099-01-01T00:00:00Z',metadata:JSON.stringify({logical_partition:'queue-a'})})
   const scope={queue_ids:[1,'2'],statuses:['pending'],action_kinds:['work'],agent_id:'fresh-agent'}
   const authority={schema_version:version,bootstrap_run_id:'bootstrap-'+randomUUID(),actor:'owner',reason:'Owner authored /path 45555 must be preserved.',timestamp:'2026-09-21T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',target:{agent_id:'fresh-agent'},queue_scope:scope}
   await insert(f,'runtime_memory_ready_evidence',{agent_id:'fresh-agent',project:'p',runtime_instance_id:id,expected_agent_id:'fresh-agent',result_status:'bypassed',completed_at:'2026-09-21T00:00:00Z',valid_until:'2099-01-01T00:00:00Z',source:'fixture',metadata:JSON.stringify(authority)})
   const stored=(await f.query('SELECT metadata FROM runtime_memory_ready_evidence'))[0].metadata
   expect(typeof stored==='string'?JSON.parse(stored):stored).toEqual(authority)
   await expect(insert(f,'event_log',{event_id:randomUUID(),event_type:'reply.failed',payload:JSON.stringify({kind:'retryable',code:'/encoded/path/with/port'})})).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
   expect((await f.query('SELECT runtime_engine,status,started_at FROM agent_runtime_instances'))[0]).toEqual({runtime_engine:null,status:null,started_at:null})
  }finally{await f.close()}
 })
})
test('PostgreSQL old physical-writing rollback is explicitly refused',async()=>{const f=await fixture('postgres');try{await seed(f);await f.apply();const before=await snapshot(f);await expect(f.exec(readFileSync(join(repo,'db/migrations/2026-09-21-runtime-observation-nonpersistence.down.sql'),'utf8'))).rejects.toThrow('AUN_NONPERSISTENCE_ROLLBACK_INCOMPATIBLE');expect(await snapshot(f)).toEqual(before)}finally{await f.close()}})

test('desired-state trigger cannot recopy physical values; stable policy still advances once',async()=>{
 const f=await fixture('postgres');try{
  await seed(f);await f.apply()
  const before=(await f.query("SELECT desired_revision,desired_digest FROM agents WHERE agent_id='fixture-agent'"))[0]
  const history=await f.query('SELECT * FROM aun_configuration_desired_outbox')
  await expect(f.query("UPDATE agents SET home_directory='/new/runtime/path' WHERE agent_id='fixture-agent'")).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
  await expect(f.query("UPDATE agents SET ordinary_projection=$1 WHERE agent_id='fixture-agent'",[JSON.stringify({nested:{provider_repo_root:'/new/runtime/path'}})])).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
  expect((await f.query("SELECT desired_revision,desired_digest FROM agents WHERE agent_id='fixture-agent'"))[0]).toEqual(before)
  expect(await f.query('SELECT * FROM aun_configuration_desired_outbox')).toEqual(history)
  await f.query("UPDATE agents SET ordinary_projection=$1 WHERE agent_id='fixture-agent'",[JSON.stringify({project:'logical-project',weight:2})])
  expect(Number((await f.query("SELECT desired_revision FROM agents WHERE agent_id='fixture-agent'"))[0].desired_revision)).toBe(Number(before.desired_revision)+1)
  expect(await f.query('SELECT * FROM aun_configuration_desired_outbox')).toHaveLength(history.length+1)
  const snapshotBefore=await snapshot(f)
  await expect(f.query("UPDATE aun_configuration_observed_state SET candidate_digest=$1 WHERE agent_id='fixture-agent'",['2'.repeat(64)])).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
  await expect(f.query("INSERT INTO aun_configuration_observed_state SELECT 'new-host',agent_id,observed_revision,observed_desired_digest,candidate_digest,release_commit,release_tree,provider_native_digest,launchagent_plist_digest,launchctl_environment_digest,runtime_identity_digest,reconcile_status,drift_reason_codes,lease_id,fencing_token,observed_at FROM aun_configuration_observed_state")).rejects.toThrow('AUN_RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
  expect(await snapshot(f)).toEqual(snapshotBefore)
 }finally{await f.close()}
})
