import { expect } from 'bun:test'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { admissionStatus, admissionTransition, tryBoundedClaim, readAdmissionBinding, admissionBindingFromEnv, selectBoundedOutbound } from '../../core/queue-admission'
import { runReceivedQueueWork, finalizeDoneQueueWork, queueWorkClaimResultFenceMismatches } from '../../core/queue-work'

import { fixture, stage, candidateRoot, fixtureClients, boundedFixtureDatabase, fixtureEvent, sanitizeFixtureError, seedNormalTransport, boundedTest, normalCli, fixtureSha, deliverFixtureProjection, verifyFixtureEndpoint, fixtureResult, startNormalTask, fixtureDb, enrollNormalTask } from './test_queue_bounded_admission.test'
import { sweepExpiredClaims } from '../../core/claim-ttl'
import { receiveTargeted } from '../../bin/aun/receive'
import { unboundedOutboundPredicate } from '../../core/queue-admission'

async function fixture16(run:(f:{admin:Client;env:NodeJS.ProcessEnv;migrate:()=>void})=>Promise<void>){
  const endpoint=process.env.AGENT_COM_BOUNDED_PG16_TEST_DATABASE_URL
  if(!endpoint)throw Error('BA_PG16_ENDPOINT_REQUIRED')
  await verifyFixtureEndpoint(endpoint,16)
  const name=`ba16_${randomUUID().replaceAll('-','').slice(0,14)}_test`
  const target=boundedFixtureDatabase(name,endpoint)
  const owned=fixtureClients(name),admin=owned.client(target.databaseUrl)
  let originalError:unknown
  const env={PATH:process.env.PATH,HOME:process.env.HOME,AGENT_ID:'qa',AGENT_COM_EXPECTED_AGENT_ID:'qa',AGENT_COM_DB:'postgres',
    DATABASE_URL:target.databaseUrl,AGENT_COM_TEST_DATABASE_URL:target.databaseUrl,AGENT_COM_TEST_DATABASE_NAME:name,AGENT_COM_PG_NOTIFY:'false'}
  const migrate=()=>{
    const child=Bun.spawnSync([process.execPath,'db/migrate.ts'],{cwd:candidateRoot,env,stdout:'pipe',stderr:'pipe'})
    if(child.exitCode!==0)throw Error(`BA_PG16_MIGRATION_FAILED ${child.stderr.toString()}`)
  }
  try{await admin.connect();migrate();await run({admin,env,migrate})}
  catch(error){originalError=error;throw error}
  finally{try{await owned.close();target.drop()}catch(cleanup){throw new AggregateError([...(originalError?[originalError]:[]),cleanup],'BA_FIXTURE_CLEANUP_FAILED')}}
}

boundedTest('BA-16-MIGRATION',async()=>fixture16(async({admin,migrate})=>{
  const q=(await admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('ordinary','{\"keep\":true}') RETURNING id")).rows[0]
  const before=(await admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
  const sql=readFileSync(resolve(candidateRoot,'db/migrations/2026-09-08-queue-bounded-admission.up.sql'),'utf8')
  await admin.query(sql);await admin.query(sql);migrate()
  expect((await admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row).toEqual(before)
  expect((await admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n).toBe(0)
  expect((await admin.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'aun_ba_%'")).rows[0].n).toBe(0)
  expect((await admin.query("SELECT current_setting('server_version_num')::int version,current_setting('transaction_timeout',true) timeout")).rows[0]).toMatchObject({timeout:null})
}))

boundedTest('BA-16-UNSUPPORTED',async()=>fixture16(async({admin,env})=>{
  const before=(await admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n
  await expect(admin.query('SELECT public.aun_admission_prepare_lock()')).rejects.toThrow('ADMISSION_STORAGE_UNSUPPORTED')
  await expect(admin.query("SELECT public.aun_admission_prepare('{}'::jsonb)")).rejects.toThrow('ADMISSION_STORAGE_UNSUPPORTED')
  const boundedEnv={...env,AUN_ADMISSION_POLICY_ID:'fixture-unsupported',AUN_ADMISSION_CONFIG_DIGEST:'1'.repeat(64),AUN_ADMISSION_SOURCE_SHA:'0'.repeat(40),AUN_ADMISSION_COHORT_DIGEST:'1'.repeat(64),AUN_ADMISSION_RUNTIME_ID:'fixture'}
  await expect(tryBoundedClaim(admin,'qa',{dialect:'postgres',env:boundedEnv})).rejects.toThrow('ADMISSION_STORAGE_UNSUPPORTED')
  expect((await admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n).toBe(before)
  expect(await tryBoundedClaim(admin,'qa',{dialect:'postgres',env})).toBeNull()
}))

boundedTest('BA-16-DEFAULT-CLAIM',async()=>fixture16(async f=>{
  await seedNormalTransport(f.admin)
  const first=(await f.admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('qa','{\"content\":\"ordinary first\"}') RETURNING id")).rows[0]
  const second=(await f.admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('qa','{\"content\":\"ordinary second\"}') RETURNING id")).rows[0]
  expect(normalCli(f as any,['next'],'qa').queue_id).toBe(String(first.id))
  const targeted=await receiveTargeted({agentId:'qa',queueId:String(second.id),env:f.env,cwd:candidateRoot})
  expect(targeted.ok).toBe(true);expect(targeted.summary?.claimed?.queue_id).toBe(String(second.id))
  expect((await f.admin.query("SELECT count(*)::int n FROM message_queue WHERE status='received'")).rows[0].n).toBe(2)
  expect((await f.admin.query('SELECT count(*)::int n FROM queue_admission_tasks')).rows[0].n).toBe(0)
}))

boundedTest('BA-16-DEFAULT-RETRY',async()=>fixture16(async f=>{
  await seedNormalTransport(f.admin)
  const expired=(await f.admin.query("INSERT INTO message_queue(agent_id,payload,status,claimed_by,claimed_at,claim_expires_at) VALUES('qa','{}','received','qa',clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute') RETURNING id")).rows[0]
  expect(await sweepExpiredClaims({dialect:'postgres',query:f.admin.query.bind(f.admin)})).toBe(1)
  expect((await f.admin.query('SELECT status,claimed_by FROM message_queue WHERE id=$1',[expired.id])).rows[0]).toEqual({status:'pending',claimed_by:null})
  await f.admin.query('DELETE FROM message_queue WHERE id=$1',[expired.id])
  const sent=normalCli(f as any,['notify','--channel-id','fixture-channel','--mention','qa','--content','Inspect ordinary retry.'])
  const source='state-daemon-queue-work-scheduler'
  Object.assign(f.env,{AUN_RECEIVE_CLAIM_SOURCE:source,AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE:source,AUN_QUEUE_WORK_INVOCATION_SOURCE:source,AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID:'fixture'})
  const selected=(await f.admin.query('SELECT id FROM message_queue WHERE agent_id=$1 AND message_id=$2',['qa',sent.message_id])).rows[0]
  const received=await receiveTargeted({agentId:'qa',queueId:String(selected.id),env:f.env,cwd:candidateRoot})
  fixtureEvent('BA-16-DEFAULT-RETRY','receive',{outcome:received})
  expect(received.ok).toBe(true)
  expect(received.summary?.claimed?.queue_id).toBe(String(selected.id))
  const claimed={queue_id:String(selected.id)}
  const claimResultFence={expectedClaimSource:source,expectedRuntimeId:'fixture'}
  const db={dialect:'postgres' as const,query:f.admin.query.bind(f.admin)}
  let invokes=0,sends=0
  expect((await runReceivedQueueWork(db,{queueId:claimed.queue_id,expectedClaimSource:source,invocationSource:source,requireClaimFence:true,adapter:{runtime_id:'fixture',capabilities:{},invoke:async()=>{invokes++;return fixtureResult()}}})).ok).toBe(true)
  const host={queue_close_mode:'sender' as const,sendReply:async(input:any)=>{
    sends++;if(sends===1)throw Error('fixture ordinary finalizer temporary failure')
    let r:any
    try{r=normalCli(f as any,['send','--content',input.content,'--mentions',input.mention,'--queue-id',input.queue_id,'--message-id',input.message_id,'--queue-work-finalizer','--close'],'qa');fixtureEvent('BA-16-DEFAULT-RETRY','host-child',{exit:0,stdout:r})}
    catch(error){const e=error as any;fixtureEvent('BA-16-DEFAULT-RETRY','host-child',{exit:e.status??null,stdout:sanitizeFixtureError(e.stdout??''),stderr:sanitizeFixtureError(e.stderr??e.message)});throw error}
    return {message_id:r.message_id,queue_closed:r.work_closed===true}
  }}
  const row=(await f.admin.query('SELECT *,clock_timestamp() database_now FROM message_queue WHERE id=$1',[claimed.queue_id])).rows[0]
  const payload=JSON.parse(row.payload)
  const mismatches=queueWorkClaimResultFenceMismatches({row,payload,...claimResultFence})
  fixtureEvent('BA-16-DEFAULT-RETRY','actual-fence',{receive_claim:payload.receive_claim,execution:payload.queue_work_execution,result:payload.runner_result,mismatches})
  expect(mismatches).toEqual([])
  expect(queueWorkClaimResultFenceMismatches({row,payload,...claimResultFence,expectedClaimSource:'wrong'})).toContain('receive_claim.source')
  const first=await finalizeDoneQueueWork(db,{queueId:claimed.queue_id,replySender:host,claimResultFence})
  fixtureEvent('BA-16-DEFAULT-RETRY','finalize-first',{outcome:first})
  expect(first.ok).toBe(false)
  const second=await finalizeDoneQueueWork(db,{queueId:claimed.queue_id,replySender:host,claimResultFence})
  fixtureEvent('BA-16-DEFAULT-RETRY','finalize-second',{outcome:second})
  expect(second.ok).toBe(true)
  expect(invokes).toBe(1);expect(sends).toBe(2)
  const out=(await f.admin.query('SELECT * FROM outbound_queue WHERE message_id=$1',[sent.message_id])).rows[0]
  expect(out.max_attempts).toBe(5);expect(out.delivery_diagnostics.some((x:any)=>x.code==='AUN_BOUNDED_ADMISSION')).toBe(false)
  const ordinary=await f.admin.query(`UPDATE outbound_queue SET status='claimed',attempts=attempts+1,claimed_at=clock_timestamp() WHERE id=$1 AND ${unboundedOutboundPredicate('outbound_queue','postgres')} RETURNING attempts`,[out.id])
  expect(ordinary.rows[0].attempts).toBe(1)
  await f.admin.query("UPDATE outbound_queue SET status='pending',claimed_at=NULL,next_retry_at=clock_timestamp() WHERE id=$1",[out.id])
  expect((await f.admin.query('SELECT status FROM outbound_queue WHERE id=$1',[out.id])).rows[0].status).toBe('pending')
}))
if (stage !== 'private') {
  boundedTest('BA-17-F12-A', async () => {
    await fixture(async ({ admin, other, prepare }) => {
      const row = (await admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('qa','{}') RETURNING id")).rows[0]
      await other.query('BEGIN')
      await other.query("UPDATE message_queue SET status='received',claimed_by='qa',claimed_at=clock_timestamp() WHERE id=$1", [row.id])
      await expect(prepare()).rejects.toThrow('ADMISSION_PREPARE_BUSY')
      await other.query('COMMIT')
      const before = (await admin.query('SELECT to_jsonb(q) AS data FROM message_queue q WHERE id=$1', [row.id])).rows[0].data
      await expect(prepare()).rejects.toThrow('ADMISSION_AFFECTED_WORK_PRESENT')
      expect((await admin.query('SELECT to_jsonb(q) AS data FROM message_queue q WHERE id=$1', [row.id])).rows[0].data).toEqual(before)
      expect((await admin.query('SELECT count(*)::integer AS n FROM queue_admission_policies')).rows[0].n).toBe(0)
    })
  })
  boundedTest('BA-17-F12-B', async () => {
    for (const isolation of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
      await fixture(async ({ admin, other, prepare }) => {
        const row = (await admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('qa','{}') RETURNING id")).rows[0]
        // Parse before BEGIN: parsing an UPDATE inside the old transaction
        // itself retains RowExclusiveLock and belongs to F12-A's busy branch.
        await other.query("PREPARE legacy_claim(bigint) AS UPDATE message_queue SET status='received',claimed_by='qa' WHERE id=$1 RETURNING payload")
        await other.query(`BEGIN ISOLATION LEVEL ${isolation}`)
        await other.query('SELECT id FROM message_queue WHERE id=$1 FOR UPDATE', [row.id])
        await prepare()
        if (!/^\d+$/.test(String(row.id))) throw new Error('fixture bigint invalid')
        await expect(other.query(`EXECUTE legacy_claim(${row.id})`)).rejects.toThrow(/ADMISSION_|serialize/)
        await other.query('ROLLBACK')
        expect((await admin.query('SELECT status FROM message_queue WHERE id=$1', [row.id])).rows[0].status).toBe('pending')
        await expect(admin.query("UPDATE message_queue SET status='received' WHERE id=$1", [row.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
      })
    }
  })
  boundedTest('BA-17-F13-B', async () => {
    await fixture(async ({ admin, control, other, config, prepare }) => {
      await prepare()
      const mid = randomUUID()
      await admin.query('BEGIN')
      await admin.query("INSERT INTO agent_messages(id,channel_id,author_id,content,metadata) VALUES($1,'fixture-channel','codex-cto','fixture task',$2)", [mid, JSON.stringify({ mentions: ['qa'] })])
      const qid = (await admin.query("INSERT INTO message_queue(agent_id,message_id,payload) VALUES('qa',$1,$2) RETURNING id", [mid, JSON.stringify({ content: 'fixture task', author_id: 'codex-cto', channel_id: 'fixture-channel' })])).rows[0].id
      const oid = (await admin.query("INSERT INTO outbound_queue(message_id,agent_id,consumer_agent_id,channel_external_id,content) VALUES($1,'codex-cto','different-consumer','fixture-channel','fixture task') RETURNING id", [mid])).rows[0].id
      await admin.query('COMMIT')
      const held = (await other.query('SELECT * FROM outbound_queue WHERE id=$1', [oid])).rows[0]
      expect(held.attempts).toBe(0); expect(held.max_attempts).toBe(1)
      expect(held.delivery_diagnostics).toContainEqual(expect.objectContaining({ code: 'AUN_BOUNDED_ADMISSION', policy_id: config.policy_id, original_queue_id: Number(qid), gate: 'HOLD_ENROLL' }))
      await expect(other.query("UPDATE outbound_queue SET status='claimed',attempts=attempts+1 WHERE id=$1", [oid])).rejects.toThrow('ADMISSION_DIRECT_PROJECTION_WRITE_DENIED')
      for(const sql of ["UPDATE outbound_queue SET next_retry_at=clock_timestamp()+interval '10 seconds',last_error='429' WHERE id=$1",
        "UPDATE outbound_queue SET status='pending',attempts=0,claimed_at=NULL WHERE id=$1",
        "DELETE FROM outbound_queue WHERE id=$1"])
        await expect(other.query(sql,[oid])).rejects.toThrow('ADMISSION_DIRECT_PROJECTION_WRITE_DENIED')
      expect((await other.query('SELECT status FROM outbound_queue WHERE id=$1', [oid])).rows[0].status).toBe('pending')
      const state = (await control.query('SELECT public.aun_admission_status($1) AS state', [config.policy_id])).rows[0].state
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      const payload = (await admin.query('SELECT payload FROM message_queue WHERE id=$1', [qid])).rows[0].payload
      await control.query('SELECT public.aun_admission_transition($1,$2,$3,$4,$5)', [config.policy_id, state.policy.revision, state.policy.config_digest, 'enroll', JSON.stringify({
        ordinal: 1, message_id: mid, definition_ref: 'fixture:task1', content_sha256: sha('fixture task'), payload_sha256: sha(payload), normal_return_ref: 'fixture:normal-return', authority_url: 'fixture:owner', authority_sha256: '2'.repeat(64),
      })])
      expect((await control.query('SELECT public.aun_admission_status($1) AS state', [config.policy_id])).rows[0].state.tasks[0].stage).toBe('ENROLLED')
    })
    await fixture(async f=>{
      const q=await startNormalTask(f)
      expect((await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter:{runtime_id:f.config.runtime_id,capabilities:{},execution_timeout_ms:1000,invoke:async()=>fixtureResult()},expectedClaimSource:'bounded-admission'})).ok).toBe(true)
      let state=(await admissionStatus(f.executor,f.config.policy_id))!
      await admissionTransition(f.executor,state,'begin_finalize',{ordinal:1,claim_fence:state.tasks[0].claim_fence,result_digest:state.tasks[0].result_digest})
      const args=['send','--content',fixtureResult().reply,'--mentions','codex-cto','--queue-id',String(q.id),'--message-id',q.message_id,'--queue-work-finalizer','--close']
      const script=`process.argv=[process.execPath,'cli/index.ts',...${JSON.stringify(args)}];const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(chunk,...rest)=>{let v;try{v=JSON.parse(String(chunk))}catch{};if(v?.ok===true&&v.message_id){process.stderr.write('BA_REPLY_COMMITTED\\n');process.stdin.once('data',()=>{write(chunk,...rest);process.stdin.pause()});return true}if(v?.ok===false)process.stderr.write(JSON.stringify(v));return write(chunk,...rest)};await import('./cli/index.ts')`
      const child=spawn(process.execPath,['-e',script],{cwd:candidateRoot,env:f.env,stdio:['pipe','pipe','pipe']})
      let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>{stdout+=s})
      const exited=new Promise<number|null>(resolve=>child.once('exit',resolve))
      try{
        await new Promise<void>((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('BA_REPLY_BARRIER_TIMEOUT')),4000)
          child.stderr.on('data',s=>{stderr+=s;if(stderr.includes('BA_REPLY_COMMITTED')){clearTimeout(timer);resolve()}})
          child.once('exit',code=>{clearTimeout(timer);if(!stderr.includes('BA_REPLY_COMMITTED'))reject(Error(`BA_REPLY_EARLY_EXIT_${code} ${stderr}`))})
        })
        expect(stdout).toBe('')
        state=(await admissionStatus(f.control,f.config.policy_id))!
        expect(state.tasks[0].stage).toBe('REPLIED')
        const reply=(await f.other.query('SELECT * FROM outbound_queue WHERE message_id=$1',[state.tasks[0].reply_id])).rows[0]
        expect(reply.agent_id).toBe('qa');expect(reply.consumer_agent_id).toBe('different-consumer')
        expect(reply.attempts).toBe(0);expect(reply.max_attempts).toBe(3)
        expect(reply.delivery_diagnostics).toContainEqual(expect.objectContaining({kind:'reply',gate:'HOLD_REPLY_COMMIT',original_message_id:q.message_id}))
        await expect(f.runtime.query("UPDATE outbound_queue SET status='claimed',attempts=attempts+1 WHERE id=$1 RETURNING *",[reply.id])).rejects.toThrow('ADMISSION_DIRECT_PROJECTION_WRITE_DENIED')
        child.stdin.end('release\n');expect(await exited).toBe(0)
        expect(JSON.parse(stdout).message_id).toBe(reply.message_id)
        expect((await f.other.query('SELECT count(*)::int n FROM agent_messages WHERE reply_to=$1',[q.message_id])).rows[0].n).toBe(1)
      }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited}}
    })
  })
  boundedTest('BA-17-F13-C', async () => {
    await fixture(async f => {
      const { admin, control, executor, runtime, config, env, prepare }=f
      await seedNormalTransport(admin)
      await prepare()
      const cli = async (args: string[], actor: string) => {
        const child = Bun.spawn(['bun', 'cli/index.ts', ...args], { cwd: candidateRoot,
          env: { ...env, AGENT_ID: actor, AGENT_COM_EXPECTED_AGENT_ID: actor }, stdout: 'pipe', stderr: 'pipe' })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if (code !== 0) throw new Error(`BA_NORMAL_CLI_FAILED ${code} ${err} ${out}`)
        return JSON.parse(out)
      }
      const msg = await cli(['notify','--channel-id','fixture-channel','--mentions','qa','--message-type','instruction','--content','Inspect the existing compatibility finding and report evidence.'], 'codex-cto')
      expect(msg.ok).toBe(true); expect(msg.message_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(msg.outbound_queued).toBe(true)
      const q = (await admin.query('SELECT * FROM message_queue WHERE message_id=$1 AND agent_id=$2', [msg.message_id, 'qa'])).rows[0]
      const m = (await admin.query('SELECT * FROM agent_messages WHERE id=$1', [msg.message_id])).rows[0]
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      let state = (await admissionStatus(control, config.policy_id))!
      state = await admissionTransition(control, state, 'enroll', { ordinal:1, message_id:msg.message_id,
        definition_ref:'fixture:task1', content_sha256:sha(m.content), payload_sha256:sha(q.payload), normal_return_ref:'fixture:actual-cli-stdout',
        authority_url:'fixture:owner', authority_sha256:'2'.repeat(64) })
      state = await admissionTransition(control, state, 'enable', {})
      Object.assign(env, { AUN_ADMISSION_POLICY_ID:config.policy_id, AUN_ADMISSION_CONFIG_DIGEST:state.policy.config_digest,
        AUN_ADMISSION_SOURCE_SHA:config.source_sha,AUN_ADMISSION_COHORT_DIGEST:config.cohort_digest,AUN_ADMISSION_RUNTIME_ID:config.runtime_id })
      expect((await readAdmissionBinding(executor,admissionBindingFromEnv(env)!,'qa')).policy.config_digest).toBe(state.policy.config_digest)
      const outbound=await selectBoundedOutbound(runtime,'different-consumer',env)
      expect(outbound?.message_id).toBe(msg.message_id)
      expect(outbound.attempts).toBe(0)
      const original=await deliverFixtureProjection(f,outbound)
      expect((await admin.query('SELECT discord_message_id FROM agent_messages WHERE id=$1',[msg.message_id])).rows[0].discord_message_id).toBe(original.discord_message_id)
      const claimed = await tryBoundedClaim(executor, 'qa', { dialect:'postgres',env,queueId:String(q.id) })
      expect(claimed?.queue_id).toBe(String(q.id))
      const db = { dialect:'postgres' as const, query:executor.query.bind(executor) }
      let calls = 0
      const run = await runReceivedQueueWork(db, { queueId:q.id, expectedClaimSource:'bounded-admission',
        adapter:{ runtime_id:config.runtime_id,capabilities:{},execution_timeout_ms:1000,invoke:async () => {
          calls++; return { schema_version:'queue_work_result_v1',ok:true,summary:'Negative compatibility finding is an inspection result.',next_action:'reply',reply:'Inspection found a compatibility gap; no changes were made.',evidence:['fixture:inspection-output'] }
        } } })
      expect(run.ok).toBe(true); expect(calls).toBe(1)
      const finalized = await finalizeDoneQueueWork(db, { queueId:q.id, replySender:{ queue_close_mode:'sender',sendReply:async input => {
        const result = await cli(['send','--content',input.content,'--mentions',input.mention!,'--queue-id',input.queue_id,'--message-id',input.message_id!,'--queue-work-finalizer','--close'],'qa')
        return { message_id:result.message_id, queue_closed:result.work_closed === true }
      } } })
      const after = (await admissionStatus(control, config.policy_id))!
      if (!finalized.ok) throw new Error(JSON.stringify({ finalized, halt: (after.policy as any).halt_code }))
      expect(finalized.ok).toBe(true)
      expect(after.tasks[0].stage).toBe('REPLIED')
      const projectedReply=await selectBoundedOutbound(runtime,'different-consumer',env)
      expect(projectedReply?.message_id).toBe(after.tasks[0].reply_id)
      expect(projectedReply.delivery_diagnostics).toContainEqual(expect.objectContaining({kind:'reply',original_message_id:msg.message_id,gate:'HOLD_REPLY_COMMIT'}))
      expect(projectedReply.attempts).toBe(0);expect(projectedReply.max_attempts).toBe(3)
      await deliverFixtureProjection(f,projectedReply)
      expect(await selectBoundedOutbound(runtime,'different-consumer',env)).toBeNull()
      expect((await admin.query('SELECT status,claimed_by FROM message_queue WHERE id=$1',[q.id])).rows[0]).toEqual({status:'replied',claimed_by:'qa'})
      expect(calls).toBe(1)
      const acceptedState=(await admissionStatus(control,config.policy_id))!,task=acceptedState.tasks[0]
      const configBefore=JSON.stringify(acceptedState.policy.config),envBefore=JSON.stringify(env)
      await admissionTransition(control,acceptedState,'accept',{ordinal:1,checker:config.checker,source_sha:config.source_sha,result_digest:task.result_digest,
        reply_id:task.reply_id,message_id:task.message_id,authority_url:'fixture:independent',authority_sha256:'2'.repeat(64),evidence_sha256:'3'.repeat(64),
        predicate_status:'VERIFIED_PASS',acceptance_kind:'independent_task_acceptance',shirube_event_ref:'fixture:accepted-1'})
      const second=await enrollNormalTask(f,2)
      expect(JSON.stringify(second.state.policy.config)).toBe(configBefore);expect(JSON.stringify(env)).toBe(envBefore)
      const secondProjection=await selectBoundedOutbound(runtime,'different-consumer',env)
      expect(secondProjection.message_id).toBe(second.sent.message_id)
      expect((await deliverFixtureProjection(f,secondProjection)).attempts).toBe(1)
      const unbound=(await admin.query("INSERT INTO outbound_queue(message_id,agent_id,consumer_agent_id,channel_external_id,content) VALUES('unrelated-default','other','different-consumer','fixture-channel','ordinary') RETURNING *")).rows[0]
      expect(unbound.max_attempts).toBe(5)
      expect((await runtime.query("UPDATE outbound_queue SET status='claimed',attempts=attempts+1 WHERE id=$1 RETURNING attempts",[unbound.id])).rows[0].attempts).toBe(1)
    })
  })
}

boundedTest('BA-17-F12-C',async()=>{
  await fixture(async f=>{
    const q=(await f.admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('non-qa','{}') RETURNING id")).rows[0]
    await f.control.query("SET transaction_timeout='1s'")
    await f.control.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await f.control.query('SELECT public.aun_admission_prepare_lock()')
    await f.control.query('SELECT public.aun_admission_prepare($1::jsonb)',[JSON.stringify(f.config)])
    await f.control.query('ROLLBACK')
    expect((await f.admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n).toBe(0)
    expect((await f.other.query("UPDATE message_queue SET status='received' WHERE id=$1 RETURNING status",[q.id])).rows[0].status).toBe('received')
    await expect(f.control.query('SELECT public.aun_admission_prepare($1::jsonb)',[JSON.stringify(f.config)])).rejects.toThrow('ADMISSION_PREPARE_LOCKS_REQUIRED')
    await f.control.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    await expect(f.control.query('SELECT public.aun_admission_prepare_lock()')).rejects.toThrow('ADMISSION_PREPARE_DEADLINE_REQUIRED')
    await f.control.query('ROLLBACK')
    const url=new URL(f.roleUrls.controller)
    const interrupted=f.client(url.href);interrupted.on('error',()=>{})
    let disconnected=false
    const disconnectedEvent=new Promise<void>(resolve=>interrupted.once('end',()=>{disconnected=true;resolve()}))
    await interrupted.connect()
    try {
      await interrupted.query("SET transaction_timeout='1s'")
      await interrupted.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await interrupted.query('SELECT public.aun_admission_prepare_lock()')
      // Actual server transaction_timeout releases the global first-deny
      // reservation. No application timer or forced backend termination.
      const started=Date.now()
      const killed=interrupted.query('SELECT pg_sleep(2)').then(()=>false,()=>true)
      await f.other.query("SET statement_timeout='2500ms'")
      expect((await f.other.query("UPDATE message_queue SET status='pending' WHERE id=$1 RETURNING status",[q.id])).rows[0].status).toBe('pending')
      expect(await killed).toBe(true);await disconnectedEvent;expect(Date.now()-started).toBeLessThan(2500)
      expect((await f.admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n).toBe(0)
    } finally {if(!disconnected)await interrupted.end().catch(()=>{})}
    await f.prepare()
    expect((await f.other.query("UPDATE message_queue SET status='received' WHERE id=$1 RETURNING status",[q.id])).rows[0].status).toBe('received')
  })
})

boundedTest('BA-CORE-F03',async()=>{
  await fixture(async f=>{
    await seedNormalTransport(f.admin);await f.prepare()
    const sent=normalCli(f,['notify','--channel-id','fixture-channel','--mentions','qa','--message-type','instruction','--content','Inspect existing source.'])
    const q=(await f.admin.query('SELECT * FROM message_queue WHERE message_id=$1',[sent.message_id])).rows[0]
    const m=(await f.admin.query('SELECT * FROM agent_messages WHERE id=$1',[sent.message_id])).rows[0]
    let state=(await admissionStatus(f.control,f.config.policy_id))!
    const bind={ordinal:1,message_id:sent.message_id,definition_ref:'fixture:task1',content_sha256:fixtureSha(m.content),payload_sha256:fixtureSha(q.payload),normal_return_ref:'fixture:actual-cli-stdout',authority_url:'fixture:owner',authority_sha256:'2'.repeat(64)}
    await expect(f.executor.query("UPDATE message_queue SET status='received' WHERE id=$1",[q.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
    for(const delta of [{message_id:randomUUID()},{message_id:'foreign-existing-id'},{content_sha256:'0'.repeat(64)},{payload_sha256:'0'.repeat(64)},{definition_ref:'fixture:wrong'},{normal_return_ref:''},{ordinal:3},{ordinal:2}]) {
      await expect(admissionTransition(f.control,state,'enroll',{...bind,...delta})).rejects.toThrow('ADMISSION_')
    }
    await expect(f.executor.query('UPDATE agent_messages SET content=$1 WHERE id=$2',['mutated',sent.message_id])).rejects.toThrow('ADMISSION_')
    const url=new URL(f.roleUrls.controller)
    const second=f.client(url.href);await second.connect()
    try {
      const enrollments=await Promise.allSettled([admissionTransition(f.control,state,'enroll',bind),admissionTransition(second,state,'enroll',bind)])
      expect(enrollments.filter(x=>x.status==='fulfilled')).toHaveLength(1)
      expect(enrollments.filter(x=>x.status==='rejected')).toHaveLength(1)
    } finally {await second.end()}
    state=(await admissionStatus(f.control,f.config.policy_id))!
    await expect(admissionTransition(f.control,state,'enroll',bind)).rejects.toThrow('ADMISSION_ENROLL_REPLAY')
    state=await admissionTransition(f.control,state,'enable',{})
    Object.assign(f.env,{AUN_ADMISSION_POLICY_ID:f.config.policy_id,AUN_ADMISSION_CONFIG_DIGEST:state.policy.config_digest,AUN_ADMISSION_SOURCE_SHA:f.config.source_sha,AUN_ADMISSION_COHORT_DIGEST:f.config.cohort_digest,AUN_ADMISSION_RUNTIME_ID:f.config.runtime_id})
    const claimant=f.client(f.env.DATABASE_URL!);await claimant.connect()
    try {
      const claims=await Promise.allSettled([tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env}),tryBoundedClaim(claimant,'qa',{dialect:'postgres',env:f.env})])
      expect(claims.filter(x=>x.status==='fulfilled')).toHaveLength(1)
      expect(claims.filter(x=>x.status==='rejected')).toHaveLength(1)
    } finally {await claimant.end()}
    state=(await admissionStatus(f.executor,f.config.policy_id))!
    expect(state.tasks).toHaveLength(1)
    state=await admissionTransition(f.executor,state,'invoke',{ordinal:1,claim_fence:state.tasks[0].claim_fence})
    await expect(admissionTransition(f.executor,state,'invoke',{ordinal:1,claim_fence:state.tasks[0].claim_fence})).rejects.toThrow('ADMISSION_INVOCATION_DENIED')
    expect((await f.admin.query("SELECT count(*)::int n FROM message_queue WHERE agent_id='qa' AND status IN ('received','in_progress')")).rows[0].n).toBe(1)
    expect((state.tasks[0] as any).invocation_attempts).toBe(1)
  })
})

boundedTest('BA-17-F13-A',async()=>{
  await fixture(async f=>{
    await seedNormalTransport(f.admin);await f.prepare()
    const content=`Frozen normal task ${randomUUID()}`
    const args=['notify','--channel-id','fixture-channel','--mention','qa','--message-type','instruction','--content',content]
    // Test-only I/O barrier around the actual CLI entrypoint: no send/DB
    // implementation replacement. COMMIT has returned; its genuine ID has
    // not been written to normal stdout until this fixture releases stdin.
    const wrapper=`process.argv=[process.execPath,'cli/index.ts',...${JSON.stringify(args)}];
const write=process.stdout.write.bind(process.stdout);
process.stdout.write=(chunk,...rest)=>{let value;try{value=JSON.parse(String(chunk))}catch{}
if(value?.ok&&value.message_id){process.stderr.write('BA_COMMIT_BEFORE_STDOUT\\n');process.stdin.once('data',()=>{write(chunk,...rest);process.stdin.pause()});return true}
return write(chunk,...rest)};
await import('./cli/index.ts');`
    const child=spawn(process.execPath,['-e',wrapper],{cwd:candidateRoot,env:{...f.env,AGENT_ID:'codex-cto',AGENT_COM_EXPECTED_AGENT_ID:'codex-cto'},stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8')
    child.stdout.on('data',chunk=>{stdout+=chunk})
    const exit=new Promise<number|null>(resolve=>child.once('exit',resolve))
    try {
      await new Promise<void>((resolve,reject)=>{
        const deadline=setTimeout(()=>reject(new Error(`BA_NOTIFY_BARRIER_TIMEOUT ${stderr}`)),4000)
        child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.includes('BA_COMMIT_BEFORE_STDOUT')){clearTimeout(deadline);resolve()}})
        child.once('error',error=>{clearTimeout(deadline);reject(error)})
        child.once('exit',code=>{clearTimeout(deadline);if(!stderr.includes('BA_COMMIT_BEFORE_STDOUT'))reject(new Error(`BA_NOTIFY_EXIT_${code} ${stderr}`))})
      })
      expect(stdout).toBe('')
      const message=(await f.other.query('SELECT id FROM agent_messages WHERE content=$1',[content])).rows[0]
      const out=(await f.other.query('SELECT * FROM outbound_queue WHERE message_id=$1',[message.id])).rows[0]
      expect(out.agent_id).toBe('codex-cto');expect(out.consumer_agent_id).toBe('different-consumer')
      expect(out.attempts).toBe(0);expect(out.max_attempts).toBe(1)
      expect(out.delivery_diagnostics).toContainEqual(expect.objectContaining({code:'AUN_BOUNDED_ADMISSION',gate:'HOLD_ENROLL',kind:'original'}))
      await expect(f.runtime.query("UPDATE outbound_queue SET status='claimed',attempts=attempts+1 WHERE id=$1 RETURNING *",[out.id])).rejects.toThrow('ADMISSION_DIRECT_PROJECTION_WRITE_DENIED')
      expect((await admissionStatus(f.control,f.config.policy_id))!.tasks).toHaveLength(0)
      child.stdin.end('release\n')
      expect(await exit).toBe(0)
      expect(JSON.parse(stdout).message_id).toBe(message.id)
      expect((await f.other.query('SELECT attempts,status FROM outbound_queue WHERE id=$1',[out.id])).rows[0]).toEqual({attempts:0,status:'pending'})
    } finally { if(child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');await exit} }
    const missing=randomUUID()
    await expect(f.admin.query("INSERT INTO agent_messages(id,channel_id,author_id,content,metadata) VALUES($1,'fixture-channel','codex-cto','missing fanout','{\"mentions\":[\"qa\"]}')",[missing])).rejects.toThrow('ADMISSION_REQUIRED_FANOUT_MISSING')
    expect((await f.admin.query('SELECT id FROM agent_messages WHERE id=$1',[missing])).rows).toHaveLength(0)
    const reordered=randomUUID()
    await f.admin.query('BEGIN')
    await f.admin.query("INSERT INTO outbound_queue(message_id,agent_id,consumer_agent_id,channel_external_id,content) VALUES($1,'codex-cto','different-consumer','fixture-channel','reordered')",[reordered])
    await f.admin.query("INSERT INTO agent_messages(id,channel_id,author_id,content,metadata) VALUES($1,'fixture-channel','codex-cto','reordered','{\"mentions\":[\"qa\"]}')",[reordered])
    await f.admin.query("INSERT INTO message_queue(agent_id,message_id,payload) VALUES('qa',$1,'{}')",[reordered])
    await f.admin.query('COMMIT')
    const reorderedOut=(await f.admin.query('SELECT * FROM outbound_queue WHERE message_id=$1',[reordered])).rows[0]
    expect(reorderedOut.attempts).toBe(0);expect(reorderedOut.max_attempts).toBe(1)
    expect(reorderedOut.delivery_diagnostics).toContainEqual(expect.objectContaining({code:'AUN_BOUNDED_ADMISSION',gate:'HOLD_ENROLL'}))
    await expect(f.admin.query("INSERT INTO outbound_queue(message_id,agent_id,consumer_agent_id,channel_external_id,content) VALUES($1,'codex-cto','different-consumer','fixture-channel','duplicate')",[reordered])).rejects.toThrow(/unique|duplicate/)
  })
})
