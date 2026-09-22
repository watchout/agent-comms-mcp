import { test,expect } from 'bun:test'
import { createHash,createHmac,randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { configurationContractFixture,restartSql } from '../helpers/configuration-contract-fixture'
import { nonpersistHostFixture, awaitFixtureAuthorityWindow } from '../helpers/nonpersist-host-fixture'
import { fixture,insert,seed } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { acquireControlPlaneLease } from '../../core/control-plane-leases'
import { buildDefaultAunConfigurationCandidate,resolveConfigurationRuntime } from '../../core/aun-configuration-candidate'
import { AunConfigurationReconciler,configurationEffectAuthorizationDigest } from '../../core/aun-configuration-reconciler'
import { createConfigurationRestartRequest,claimApprovedConfigurationRestartExecution,verifyConfigurationRestartExecutionClaim,
  markConfigurationEventDelivered,recordConfigurationReconcileResult,configurationRestartReceiptAuthorizationDocument,canonicalConfigurationJson } from '../../core/aun-configuration-desired-state'
import { applyConfigurationRestartLogicalSqlite,applyRuntimeObservationNonpersistenceSqlite } from '../../db/migrate-sqlite'

async function currentCandidate(s:Awaited<ReturnType<typeof configurationContractFixture>>,restartRequired=false) {
  const host=await nonpersistHostFixture(randomUUID(),s.desired.agentId)
  try {
  await awaitFixtureAuthorityWindow(host,async()=>(await s.f.query('SELECT clock_timestamp() AS now'))[0].now)
  await insert(s.f,'agent_runtime_instances',{runtime_instance_id:host.runtimeId,agent_id:host.agentId,runtime_kind:'local_process'})
  const lease=await acquireControlPlaneLease(s.db,{scopeType:'runtime_instance',scopeId:host.runtimeId,purpose:'worker',holderAgentId:host.agentId,holderRuntimeInstanceId:host.runtimeId,ttlMs:60000})
  if(!lease.ok)throw Error('fixture lease rejected')
  const observed=await resolveConfigurationRuntime(s.db,host.agentId,host.env,host.dir)
  const candidate=buildDefaultAunConfigurationCandidate({desired:s.desired,observedRuntime:observed,databaseLocatorRef:'env:DATABASE_URL',databaseCredentialRef:'env:DATABASE_URL',
    bunPath:process.execPath,providerRepoRoot:host.dir,providerConfigRoot:observed.providerConfigRoot,serverEntry:'server.ts',daemonCheckout:host.dir,daemonEntry:'state-daemon.ts',restartRequired})
  return {host,observed,candidate}
  }catch(error){await host.close();throw error}
}

test('AC-CFG-1 fresh hostname stays outside candidate, logical scopes and durable records; supplied host is rejected',async()=>{
  const s=await configurationContractFixture();let h:any
  try {
    const c=await currentCandidate(s);h=c.host
    expect(JSON.stringify(c.candidate)).not.toContain(c.observed.observation.host_id)
    expect(JSON.stringify(c.candidate)).not.toMatch(/host_?id|hostname/i)
    const lease=(await s.leases.acquire(s.desired.agentId))!
    expect(lease.lease_scope_id).toBe('configuration-reconciler:cfg-fixture')
    const id=await createConfigurationRestartRequest(s.db,s.request(lease))
    await expect(createConfigurationRestartRequest(s.db,{...s.request(lease),hostId:'forbidden-host'} as any)).rejects.toThrow('PERSISTENCE_FORBIDDEN')
    const row=(await s.f.query('SELECT * FROM aun_configuration_restart_requests WHERE request_id=$1',[id]))[0]
    expect(Object.hasOwn(row,'host_id')).toBe(false)
    expect(row.candidate_digest).toBeNull();expect(row.rollback_artifact_digest).toBeNull()
    expect(JSON.stringify(row)).not.toContain(h.dir)
    console.log(JSON.stringify({case:'AC-CFG-1',hostname_in_candidate:0,host_columns:0,forbidden_host_denied:1}))
  }finally{if(h)await h.close();await s.close()}
},30000)

test('AC-CFG-2 ordinary reconcile delivers existing outbox with logical audit and no observation sink; stale fence cannot deliver',async()=>{
 const s=await configurationContractFixture();let h:any
 try {
  const c=await currentCandidate(s);h=c.host;let applied=0,readbacks=0
  const native={providerNativeDigest:'e'.repeat(64),launchagentPlistDigest:'f'.repeat(64),launchctlEnvironmentDigest:'0'.repeat(64),runtimeIdentityDigest:'1'.repeat(64),driftReasonCodes:[]}
  const projection:any={render:async()=>c.candidate,validate:async()=>({ok:true,reasonCodes:[]}),
    readback:async()=>{readbacks++;return {...native,matchesCandidate:applied===1}},
    applyFenced:async(_c:any,a:any)=>{const ok=await a.verifyCurrent();if(ok)applied++;return {ok,mutated:ok,partial:false,fenceVerifiedAtCommit:ok,authorizationDigest:configurationEffectAuthorizationDigest(a)}}}
  const event=(await s.store.listPendingEvents(100))[0]
  // A dropped history relation proves no SELECT or INSERT dependency remains.
  await s.f.exec('DROP TABLE aun_configuration_observed_state')
  const result=await new AunConfigurationReconciler(s.store,s.leases,projection).reconcileAgent(s.desired.agentId,event)
  expect(result).toMatchObject({status:'READY',eventDelivered:true,applyCount:1,freshNativeReadback:true})
  expect(readbacks).toBe(2)
  const row=(await s.f.query('SELECT * FROM aun_configuration_desired_outbox WHERE event_id=$1',[event.eventId]))[0]
  expect(row.delivered_at).not.toBeNull();expect(row.attempt_count).toBe(1)
  const audit=(await s.f.query("SELECT detail FROM audit_log WHERE event_type='configuration.reconciled'"))[0].detail
  expect(audit.status).toBe('READY');expect(JSON.stringify(audit)).not.toContain(h.dir)
  const lease=(await s.leases.acquire(s.desired.agentId))!
  const state={agentId:s.desired.agentId,desiredRevision:s.desired.desiredRevision,desiredDigest:s.desired.desiredDigest,
    releaseCommit:s.desired.releaseCommit,releaseTree:s.desired.releaseTree,reconcileStatus:'READY' as const,driftReasonCodes:[],
    leaseId:lease.lease_id,fencingToken:lease.fencing_token,holderAgentId:lease.holder_agent_id,holderRuntimeInstanceId:null}
  await s.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=$1",[lease.lease_id])
  expect(await recordConfigurationReconcileResult(s.db,state)).toBe(false)
  expect(await markConfigurationEventDelivered(s.db,event.eventId,event.desiredRevision,event.desiredDigest,state)).toBe(false)
  expect((await s.store.listDueDesiredAgents(100,60000))).toEqual([])
  console.log(JSON.stringify({case:'AC-CFG-2',applies:applied,fresh_readbacks:readbacks,delivered:1,observation_table_accesses:0,stale_completions:0}))
 }finally{if(h)await h.close();await s.close()}
},30000)

test('AC-CFG-4 logical restart insert and authenticated one-shot execution pass; physical fields, ownerless and expired execution fail',async()=>{
 const s=await configurationContractFixture(),secret='isolated-contract-test-secret',prior=process.env.AGENT_COMMS_SECRET
 process.env.AGENT_COMMS_SECRET=secret
 try {
  const lease=(await s.leases.acquire(s.desired.agentId))!,request=s.request(lease)
  const requestId=await createConfigurationRestartRequest(s.db,request)
  for(const key of ['candidateDigest','rollbackArtifactDigest'])await expect(createConfigurationRestartRequest(s.db,{...request,[key]:'f'.repeat(64)} as any)).rejects.toThrow('PERSISTENCE_FORBIDDEN')
  for(const key of ['candidate_digest','rollback_artifact_digest'])await expect(s.f.query(`UPDATE aun_configuration_restart_requests SET ${key}=$1 WHERE request_id=$2`,['f'.repeat(64),requestId])).rejects.toThrow('PERSISTENCE_FORBIDDEN')
  await insert(s.f,'agents',{agent_id:'codex-cto',display_name:'isolated executor',agent_type:'bot'})
  const execution=await acquireControlPlaneLease(s.db,{scopeType:'runtime_instance',scopeId:'configuration-restart:cfg-fixture',purpose:'maintenance',holderAgentId:'codex-cto',ttlMs:60000})
  if(!execution.ok)throw Error('fixture execution lease failed')
  const claimInput={requestId,agentId:request.agentId,toRevision:request.toRevision,toDigest:request.toDigest,
    rollbackReleaseCommit:request.rollbackReleaseCommit,rollbackReleaseTree:request.rollbackReleaseTree,exactReleaseCommit:request.exactReleaseCommit,
    exactReleaseTree:request.exactReleaseTree,exactControlRefs:request.exactControlRefs,executionLeaseId:execution.lease.lease_id,
    executionFencingToken:execution.lease.fencing_token,executorAgentId:'codex-cto'}
  expect(await claimApprovedConfigurationRestartExecution(s.db,claimInput)).toBeNull()
  const channelId=randomUUID(),receiptId=randomUUID(),ownerDecisionRef='fixture:owner-authorized-restart'
  const document=configurationRestartReceiptAuthorizationDocument({...claimInput,channelId,ownerDecisionRef}),content=canonicalConfigurationJson(document),timestamp=Math.floor(Date.now()/1000)
  const signature=createHmac('sha256',secret).update(`codex-cto:${timestamp}:${channelId}:${createHash('sha256').update(content).digest('hex')}`).digest('hex')
  await insert(s.f,'channels',{id:channelId,name:'isolated auth fixture',members:['codex-cto']})
  await insert(s.f,'agent_messages',{id:receiptId,author_id:'codex-cto',channel_id:channelId,content,message_type:'instruction',metadata:JSON.stringify({...document,auth:{signature,timestamp}})})
  await s.f.query("UPDATE aun_configuration_restart_requests SET status='APPROVED',owner_decision_ref=$2,owner_decision_expires_at=clock_timestamp()+interval '1 minute',cto_execution_receipt_ref=$3 WHERE request_id=$1",[requestId,ownerDecisionRef,'aun:agent-message:'+receiptId])
  expect(await claimApprovedConfigurationRestartExecution(s.db,{...claimInput,rollbackReleaseTree:'f'.repeat(40)})).toBeNull()
  const claim=await claimApprovedConfigurationRestartExecution(s.db,claimInput)
  expect(claim).not.toBeNull();expect(await verifyConfigurationRestartExecutionClaim(s.db,claim!)).toBe(true)
  expect(await claimApprovedConfigurationRestartExecution(s.db,claimInput)).toBeNull()
  await s.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=$1",[execution.lease.lease_id])
  expect(await verifyConfigurationRestartExecutionClaim(s.db,claim!)).toBe(false)
  console.log(JSON.stringify({case:'AC-CFG-4',logical_insert:1,authenticated_claim:1,ownerless_denied:1,rollback_mismatch_denied:1,duplicate_execution_denied:1,expired_denied:1,physical_denied:4,restarts:0}))
 }finally{if(prior===undefined)delete process.env.AGENT_COMMS_SECRET;else process.env.AGENT_COMMS_SECRET=prior;await s.close()}
},30000)

test('AC-CFG-5 duplicate logical restart requests converge; a stale holder cannot create another request',async()=>{
 const s=await configurationContractFixture()
 try {
  const lease=(await s.leases.acquire(s.desired.agentId))!,request=s.request(lease)
  const ids=await Promise.all([createConfigurationRestartRequest(s.db,request),createConfigurationRestartRequest(s.db,{...request,requestId:randomUUID()})])
  expect(ids[0]).toBe(ids[1]);expect((await s.f.query('SELECT count(*)::int n FROM aun_configuration_restart_requests'))[0].n).toBe(1)
  await expect(createConfigurationRestartRequest(s.db,{...request,holderAgentId:'foreign-holder'})).rejects.toThrow('FENCE_REJECTED')
  await expect(createConfigurationRestartRequest(s.db,{...request,fencingToken:lease.fencing_token+1})).rejects.toThrow('FENCE_REJECTED')
  await s.f.exec(restartSql)
  expect((await s.f.query('SELECT request_id FROM aun_configuration_restart_requests'))[0].request_id).toBe(ids[0])
  console.log(JSON.stringify({case:'AC-CFG-5',submitted:2,durable_requests:1,foreign_holder_denied:1,wrong_fence_denied:1,idempotent_migration:1}))
 }finally{await s.close()}
},30000)

for(const kind of ['postgres','sqlite'] as const)test(`D-CFG-1 ${kind} preserves existing request history, rejects duplicate migration and physical rewrites`,async()=>{
 if(kind==='postgres') {
  const f=await fixture('postgres',false)
  try {
   await seed(f)
   const prior=(await f.query('SELECT * FROM aun_configuration_restart_requests'))[0]
   await f.query(`INSERT INTO aun_configuration_restart_requests(host_id,agent_id,to_revision,to_digest,candidate_digest,rollback_artifact_digest,exact_release_commit,exact_release_tree,exact_control_refs,lease_id,fencing_token,restart_budget)
     SELECT 'second-host',agent_id,to_revision,to_digest,candidate_digest,rollback_artifact_digest,exact_release_commit,exact_release_tree,exact_control_refs,lease_id,fencing_token,restart_budget FROM aun_configuration_restart_requests`)
   await f.apply()
   await expect(f.exec(restartSql)).rejects.toThrow('LOGICAL_RESTART_CONFLICT');await f.exec('ROLLBACK')
   expect((await f.query('SELECT count(*)::int n FROM aun_configuration_restart_requests'))[0].n).toBe(2)
   await f.query('DELETE FROM aun_configuration_restart_requests WHERE request_id<>$1',[prior.request_id])
   await f.exec(restartSql)
   const after=(await f.query('SELECT * FROM aun_configuration_restart_requests'))[0]
   const {host_id,...preserved}=prior;const {rollback_release_commit,rollback_release_tree,...old}=after
   expect(old).toEqual(preserved);expect(rollback_release_commit).toBeNull();expect(rollback_release_tree).toBeNull()
   await expect(f.query('UPDATE aun_configuration_restart_requests SET candidate_digest=$1',['f'.repeat(64)])).rejects.toThrow('PERSISTENCE_FORBIDDEN')
  }finally{await f.close()}
 }else{
  const db=new Database(':memory:')
  try {
   db.exec(`CREATE TABLE aun_configuration_restart_requests(request_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,agent_id TEXT NOT NULL,to_revision INTEGER NOT NULL,to_digest TEXT NOT NULL,candidate_digest TEXT NOT NULL,rollback_artifact_digest TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'AWAITING_OWNER_DECISION',UNIQUE(host_id,agent_id,to_revision,to_digest,candidate_digest))`)
   db.query("INSERT INTO aun_configuration_restart_requests VALUES('old','old-host','agent',1,'digest','old-candidate','old-artifact','REJECTED')").run()
   db.query("INSERT INTO aun_configuration_restart_requests VALUES('duplicate','second-host','agent',1,'digest','other-candidate','old-artifact','REJECTED')").run()
   const sql="INSERT INTO aun_configuration_restart_requests(request_id,agent_id,to_revision,to_digest,rollback_release_commit,rollback_release_tree) VALUES(?,?,?,?,?,?)"
   const previousMigrationGate=process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED
   process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED='1'
   try {
   expect(()=>applyConfigurationRestartLogicalSqlite(db)).toThrow('LOGICAL_RESTART_CONFLICT')
   expect((db.query('SELECT count(*) n FROM aun_configuration_restart_requests').get() as any).n).toBe(2)
   db.exec("DELETE FROM aun_configuration_restart_requests WHERE request_id='duplicate'")
   applyConfigurationRestartLogicalSqlite(db)
   expect(db.query('SELECT request_id,candidate_digest,rollback_artifact_digest,status FROM aun_configuration_restart_requests').get()).toEqual({request_id:'old',candidate_digest:'old-candidate',rollback_artifact_digest:'old-artifact',status:'REJECTED'})
   expect(db.query('PRAGMA table_info(aun_configuration_restart_requests)').all().some((v:any)=>v.name==='host_id')).toBe(false)
   db.query(sql).run('new','agent',2,'new-digest','a'.repeat(40),'b'.repeat(40))
   expect(()=>db.query(sql).run('no-release','agent',3,'third',null,null)).toThrow('PERSISTENCE_FORBIDDEN')
   expect(()=>db.exec("UPDATE aun_configuration_restart_requests SET candidate_digest='forbidden' WHERE request_id='new'")).toThrow('PERSISTENCE_FORBIDDEN')
   applyRuntimeObservationNonpersistenceSqlite(db);applyConfigurationRestartLogicalSqlite(db)
   } finally {if(previousMigrationGate===undefined)delete process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED;else process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=previousMigrationGate}
   db.query(sql).run('next','agent',3,'next-digest','a'.repeat(40),'b'.repeat(40))
   expect((db.query('SELECT count(*) n FROM aun_configuration_restart_requests').get() as any).n).toBe(3)
  }finally{db.close()}
 }
 console.log(JSON.stringify({case:'restart-migration',kind,history_preserved:1,duplicate_migration_denied:1,physical_rewrite_denied:1}))
},30000)
