import { expect } from 'bun:test'
import { boundedTest, fixture, startNormalTask, fixtureDb, fixtureResult, hostReplySender, candidateRoot, type BoundedFixture } from './test_queue_bounded_admission.test'
import { admissionBindingFromEnv, admissionStatus, admissionTransition, tryBoundedClaim, deliverBoundedOutbound, authorizeBoundedPost,
  boundedRetryAfter, BoundedReceiptStore, currentBoundedOwner, recoverBoundedReceipt, admissionSha256, type BoundedDiscordRequest } from '../../core/queue-admission'
import { DiscordAdapter, postBoundedDiscordRequest } from '../../adapters/discord'
import { chmodSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { REST } from 'discord.js'
import { runReceivedQueueWork, finalizeDoneQueueWork } from '../../core/queue-work'
import { buildRunQueueWorkPlan, createRuntimeAdapter } from '../../bin/aun/run-queue-work'
import { sweepExpiredClaims } from '../../core/claim-ttl'
import { reclaimSelfOrphanedClaims } from '../../core/inbox-cursor'
import { StateDaemon } from '../../core/state-daemon'
import { FakeAlertSink, FakeClock, FakeMetrics, FakePgListen, FakeTmux } from './state-daemon/fakes'

async function saveFixtureResult(f: Parameters<Parameters<typeof fixture>[0]>[0],qid: string) {
  const workerEnv={...f.env,AUN_QUEUE_WORK_COMMAND:process.execPath,
    AUN_QUEUE_WORK_ARGS_JSON:JSON.stringify(['-e',`if(process.env.DATABASE_URL||process.env.PGPASSWORD)process.exit(9);process.stdout.write(${JSON.stringify(JSON.stringify(fixtureResult()))})`]),
    AUN_QUEUE_WORK_TIMEOUT_MS:'1000'}
  const adapter=createRuntimeAdapter(buildRunQueueWorkPlan({runtime:'command-json',env:workerEnv,cwd:candidateRoot}),workerEnv)
  const run=await runReceivedQueueWork(fixtureDb(f),{queueId:qid,adapter,expectedClaimSource:'bounded-admission'})
  expect(run.ok).toBe(true)
}

async function readyReply(f: BoundedFixture) {
  f.config.runtime_id='command-json'
  const q=await startNormalTask(f);await saveFixtureResult(f,q.id)
  expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
  const task=(await admissionStatus(f.runtime,f.config.policy_id))!.tasks[0]
  const row=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[task.reply_id])).rows[0]
  return {q,row,binding:admissionBindingFromEnv(f.env)!}
}
function fakeSuccessPort(onWire:()=>void) {
  return {prepareBoundedRequest:async(r:any):Promise<BoundedDiscordRequest>=>({delivery_id:`out-${r.id}`,channel_id:r.channel_external_id,
    author_id:'111111111111111111',body:{content:r.content,nonce:`out-${r.id}`,enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}),
    sendBoundedRequest:(r:BoundedDiscordRequest,permit:any)=>postBoundedDiscordRequest(r,permit,'fixture-never-network',async()=>{
      onWire();return new Response(JSON.stringify({id:'222222222222222222',channel_id:r.channel_id,author:{id:r.author_id},nonce:r.delivery_id,content:r.body.content}),
        {status:200,headers:{'content-type':'application/json'}})
    })}
}
async function makeOwnedRetryDue(f: BoundedFixture,rowId: number|string) {
  const owned=(await f.admin.query('SELECT to_jsonb(o) AS row FROM outbound_queue o WHERE id=$1',[rowId])).rows[0].row
  const next=(await f.admin.query("SELECT jsonb_set($1::jsonb,'{next_retry_at}',to_jsonb(clock_timestamp()-interval '1 second')) AS row",[JSON.stringify(owned)])).rows[0].row
  await f.admin.query('BEGIN')
  try{
    await f.admin.query('SELECT public.aun_admission_permit($1,$2,$3::jsonb,$4::jsonb)',[f.config.policy_id,'outbound_queue',JSON.stringify(owned),JSON.stringify(next)])
    await f.admin.query('UPDATE outbound_queue SET next_retry_at=$1 WHERE id=$2',[next.next_retry_at,rowId])
    await f.admin.query("UPDATE queue_admission_policies SET bot_not_before='{}'::jsonb WHERE policy_id=$1",[f.config.policy_id])
    await f.admin.query('COMMIT')
  }catch(e){await f.admin.query('ROLLBACK');throw e}
}

boundedTest('BA-CORE-F05',async()=>{
  for (const mode of ['ok_false','invalid_json','nonzero','timeout','missing_command','uncertain_reservation']) {
    await fixture(async f=>{
      f.config.runtime_id='command-json'
      const q=await startNormalTask(f)
      let invocations=0
      if(mode==='uncertain_reservation') {
        const state=(await admissionStatus(f.executor,f.config.policy_id))!
        await admissionTransition(f.executor,state,'invoke',{ordinal:1,claim_fence:state.tasks[0].claim_fence})
      } else {
        const script=mode==='ok_false'?`process.stdout.write(${JSON.stringify(JSON.stringify({...fixtureResult(),ok:false}))})`
          :mode==='invalid_json'?'process.stdout.write("invalid-json")'
          :mode==='timeout'?'setTimeout(()=>{},10000)':'process.exit(7)'
        const workerEnv={...f.env,AUN_QUEUE_WORK_COMMAND:mode==='missing_command'?'/fixture/no-such-runtime':process.execPath,
          AUN_QUEUE_WORK_ARGS_JSON:JSON.stringify(['-e',script]),AUN_QUEUE_WORK_TIMEOUT_MS:'100'}
        const adapter=createRuntimeAdapter(buildRunQueueWorkPlan({runtime:'command-json',env:workerEnv,cwd:candidateRoot}),workerEnv)
        const invoke=adapter.invoke.bind(adapter)
        adapter.invoke=async (...args)=>{invocations++;return invoke(...args)}
        const result=await runReceivedQueueWork(fixtureDb(f),{queueId:q.id,adapter,expectedClaimSource:'bounded-admission'})
        expect(result.ok).toBe(false)
        expect(invocations).toBe(1)
      }
      let dispatched=0
      const daemon=new StateDaemon({db:f.executor as any,pgListen:new FakePgListen(),tmux:new FakeTmux(),clock:new FakeClock(new Date()),
        metrics:new FakeMetrics(),alert:new FakeAlertSink(),config:{admissionBinding:admissionBindingFromEnv(f.env),agentAllowlist:['qa']},
        queueWorkScheduler:{runReceived:async()=>{dispatched++},runPending:async()=>{dispatched++},runDone:async()=>{dispatched++}}})
      // One explicit fixture sweep, not start(): no listener/interval/monitor.
      ;(daemon as any).status='running'
      await daemon.sweepStale()
      const state=(await admissionStatus(f.executor,f.config.policy_id))!
      expect(state.policy.status).toBe('HALTED')
      expect((state.tasks[0] as any).invocation_attempts).toBe(1)
      expect((state.policy as any).notice_reserved).toBe(true)
      const before=(await f.admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
      await sweepExpiredClaims(fixtureDb(f))
      await reclaimSelfOrphanedClaims(fixtureDb(f),'qa')
      await daemon.sweepStale()
      expect(dispatched).toBe(0)
      await expect(tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env})).rejects.toThrow('ADMISSION_NO_ENROLLED_TASK')
      await expect(f.executor.query("UPDATE message_queue SET status='pending',claimed_by=NULL,claimed_at=NULL,claim_expires_at=NULL WHERE id=$1",[q.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
      expect((await f.admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row).toEqual(before)
      expect((await admissionStatus(f.executor,f.config.policy_id))!.policy.revision).toBe(state.policy.revision)
    })
  }
})

boundedTest('BA-CORE-F06',async()=>{
  for(const failure of ['before_commit','response_lost','reserved_crash']) {
    await fixture(async f=>{
      f.config.runtime_id='command-json'
      const q=await startNormalTask(f)
      await saveFixtureResult(f,q.id)
      let sends=0
      const host=hostReplySender(f)
      const replySender={queue_close_mode:'sender' as const,sendReply:async(input:any)=>{
        sends++
        if(failure==='before_commit')throw new Error('FIXTURE_BEFORE_REPLY_COMMIT')
        await host.sendReply(input)
        throw new Error('FIXTURE_REPLY_COMMITTED_RESPONSE_LOST')
      }}
      if(failure==='reserved_crash') {
        const state=(await admissionStatus(f.executor,f.config.policy_id))!
        await admissionTransition(f.executor,state,'begin_finalize',{ordinal:1,claim_fence:state.tasks[0].claim_fence,result_digest:state.tasks[0].result_digest})
        // New host sees the already consumed reservation, never calls send.
        await expect(finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender})).rejects.toThrow('ADMISSION_FINALIZER_DENIED')
        const current=(await admissionStatus(f.executor,f.config.policy_id))!
        await admissionTransition(f.executor,current,'failure',{reason:'FINALIZER_RESERVATION_UNCERTAIN'})
      } else {
        const outcome=await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender})
        expect(outcome.ok).toBe(false)
        expect(sends).toBe(1)
      }
      const state=(await admissionStatus(f.executor,f.config.policy_id))!
      expect(state.policy.status).toBe('HALTED')
      expect((state.tasks[0] as any).finalizer_attempts).toBe(1)
      expect((state.tasks[0] as any).invocation_attempts).toBe(1)
      const replies=(await f.admin.query('SELECT id FROM agent_messages WHERE reply_to=$1',[q.message_id])).rows
      expect(replies.length).toBe(failure==='response_lost'?1:0)
      if(failure==='response_lost') {
        const reread=await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender})
        expect(reread).toMatchObject({ok:true,code:'ALREADY_REPLIED',replied_with:state.tasks[0].reply_id})
      } else await expect(finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender})).rejects.toThrow('ADMISSION_DENIED')
      expect(sends).toBe(failure==='reserved_crash'?0:1)
      expect((await admissionStatus(f.executor,f.config.policy_id))!.policy.status).toBe('HALTED')
      expect((await f.admin.query('SELECT claimed_by FROM message_queue WHERE id=$1',[q.id])).rows[0].claimed_by).toBe('qa')
    })
  }
  // DR07: real child exits leave locks/receipts in place. Only observed child
  // termination permits explicit fixture recovery of that exact lock.
  for(const crash of ['before_reservation','after_reservation','before_INTENT','after_INTENT','after_RETRYABLE','after_ACK','after_stage1','before_stage2','after_stage2'])await fixture(async f=>{
    const policyBody='fixture policy authority, not a live owner decision'
    f.config.authority={url:'https://github.com/fixture/repo/issues/1#issuecomment-1',sha256:admissionSha256(policyBody)}
    const {row,binding}=await readyReply(f)
    const childPath=`${f.config.transport.receipt_dir}/crash-child.ts`
    const childInput=`${f.config.transport.receipt_dir}/crash-input.json`
    const runtimeUrl=new URL(f.env.DATABASE_URL!);runtimeUrl.username=f.config.roles.runtime
    writeFileSync(childInput,JSON.stringify({row,binding,crash,url:runtimeUrl.href,directory:f.config.transport.receipt_dir}),{mode:0o600})
    writeFileSync(childPath,`
import { Client } from '${candidateRoot}/node_modules/pg/lib/index.js'
import { readFileSync,writeFileSync } from 'node:fs'
import { deliverBoundedOutbound,BoundedReceiptStore } from '${candidateRoot}/core/queue-admission.ts'
import { postBoundedDiscordRequest } from '${candidateRoot}/adapters/discord.ts'
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const client=new Client({connectionString:input.url});await client.connect()
let action='';let wires=0;let now=Date.now();let mono=0
const stop=()=>process.exit(23)
const db={query:async(sql,params)=>{
 if(sql.includes('aun_admission_outbound'))action=params?.[1]??''
 if(action==='claim'&&sql.includes('aun_admission_outbound')&&input.crash==='before_reservation')stop()
 if(action==='backfill'&&sql.includes('aun_admission_outbound')&&input.crash==='before_stage2')stop()
 const result=await client.query(sql,params)
 if(action==='claim'&&sql.includes('aun_admission_outbound')&&input.crash==='after_reservation')stop()
 if(sql==='COMMIT'&&((action==='sent'&&input.crash==='after_stage1')||(action==='backfill'&&input.crash==='after_stage2')))stop()
 return result
}}
const save=BoundedReceiptStore.prototype.write
BoundedReceiptStore.prototype.write=function(r){
 if(r.state==='INTENT'&&input.crash==='before_INTENT')stop()
 save.call(this,r)
 if((r.state==='INTENT'&&input.crash==='after_INTENT')||(r.state==='RETRYABLE'&&input.crash==='after_RETRYABLE')||(r.state==='ACK_PENDING_DB'&&input.crash==='after_ACK'))stop()
}
const adapter={prepareBoundedRequest:async(r)=>({delivery_id:'out-'+r.id,channel_id:r.channel_external_id,author_id:'111111111111111111',
 body:{content:r.content,nonce:'out-'+r.id,enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}),
 sendBoundedRequest:(r,p)=>postBoundedDiscordRequest(r,p,'fixture',async()=>{
 wires++;writeFileSync(input.directory+'/child-wire-count.json',JSON.stringify({wires}),{mode:0o600})
 const status=input.crash==='after_RETRYABLE'?503:200
 return new Response(JSON.stringify(status===200?{id:'222222222222222222',channel_id:r.channel_id,author:{id:r.author_id},nonce:r.delivery_id,content:r.body.content}:{message:'fixture503'}),{status,headers:{'content-type':'application/json'}})
 })}
await deliverBoundedOutbound({db,row:input.row,binding:input.binding,adapter,clock:{now:()=>now,monotonic:()=>mono}})
now+=1000;mono+=1000
await deliverBoundedOutbound({db,row:input.row,binding:input.binding,adapter,clock:{now:()=>now,monotonic:()=>mono}})
await client.end();process.exit(24)
`,{mode:0o600})
    const child=Bun.spawn([process.execPath,childPath,childInput],{cwd:candidateRoot,env:{PATH:process.env.PATH},stdout:'pipe',stderr:'pipe'})
    const exit=await child.exited
    const stderr=await new Response(child.stderr).text()
    writeFileSync(`${f.config.transport.receipt_dir}/crash-stderr.log`,stderr,{mode:0o600})
    expect(exit).toBe(23)
    let parentWire=0;let now=Date.now();let mono=0
    const adapter=fakeSuccessPort(()=>{parentWire++})
    const clock={now:()=>now,monotonic:()=>mono}
    const deliver=()=>deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
    await expect(deliver()).rejects.toThrow('ADMISSION_DELIVERY_OWNER_UNRESOLVED')
    expect(parentWire).toBe(0)
    const lockPath=`${f.config.transport.receipt_dir}/out-${row.id}.lock`
    const prior=JSON.parse(readFileSync(lockPath,'utf8'))
    expect(prior.pid).toBe(child.pid) // Actual child exit is positive end evidence.
    const store=new BoundedReceiptStore(f.config.transport.receipt_dir,currentBoundedOwner(binding.cohortDigest))
    if(crash==='after_ACK'){
      now=Date.now() // End evidence and the recovery clock share the same observed instant.
      const receiptPath=`${f.config.transport.receipt_dir}/out-${row.id}.json`
      const receipt=store.readReceipt(`out-${row.id}`)!
      const endBody=JSON.stringify({ended:true,host:prior.host,pid:prior.pid,start:prior.start,ended_at:new Date(now).toISOString()})
      const endRef={url:'https://github.com/fixture/repo/issues/1#issuecomment-2',sha256:admissionSha256(endBody)}
      const request={policy_id:f.config.policy_id,delivery_id:`out-${row.id}`,receipt_sha256:admissionSha256(readFileSync(receiptPath)),
        request_digest:receipt.request_digest,source_head:f.config.source_sha,recovery_token:'fixture-recovery-1',max_writes:5,window_ms:20000,
        prior_owner_end_evidence:{owner:prior,ref:endRef}}
      const approvalBody=JSON.stringify({...request,decision:'APPROVED',action:'persist-receipt',expires_at:new Date(now+60000).toISOString()})
      const approvalRef={url:'https://github.com/fixture/repo/issues/1#issuecomment-3',sha256:admissionSha256(approvalBody)}
      const recovery={...request,authority_url:approvalRef.url,authority_sha256:approvalRef.sha256}
      const bodies=new Map([[f.config.authority.url,policyBody],[endRef.url,endBody],[approvalRef.url,approvalBody]])
      const readBody=async(ref:any)=>{if(!bodies.has(ref.url))throw Error('fixture unknown source');return bodies.get(ref.url)!}
      const input={db:f.control,state:(await admissionStatus(f.control,f.config.policy_id))!,deliveryId:request.delivery_id,receiptPath,
        recovery,readBody,dryRun:true,clock,sleep:async(ms:number)=>{now+=ms;mono+=ms}}
      expect(await recoverBoundedReceipt(input)).toMatchObject({status:'UNEXECUTED',effect_count:0})
      expect(readFileSync(lockPath,'utf8')).toBe(JSON.stringify(prior))
      for(const invalid of [{...recovery,source_head:'f'.repeat(40)},{...recovery,max_writes:6},{...recovery,recovery_token:['fixture-recovery-1']},{...recovery,extra:true}]){
        await expect(recoverBoundedReceipt({...input,recovery:invalid,dryRun:false})).rejects.toThrow('ADMISSION_RECOVERY_INVALID')
      }
      const restored=await recoverBoundedReceipt({...input,dryRun:false})
      expect(restored).toMatchObject({status:'SENT',persistence_writes:2,provider_post_delta:0,task_invocation_delta:0})
      await expect(recoverBoundedReceipt({...input,dryRun:false})).rejects.toThrow('ADMISSION_RECEIPT_BINDING_MISMATCH')
      expect((await deliver()).status).toBe('SENT');expect(parentWire).toBe(0)
      console.log(JSON.stringify({subcase:'DR06/DR07',crash,db_only_recovery_writes:2,token_replay_writes:0,parent_wire:0,fixture_only:true}))
      return
    }
    store.releaseEndedOwner(`out-${row.id}`,prior)
    const result=await deliver()
    if(crash==='before_reservation'){
      expect(parentWire).toBe(1);expect(result.status).toBe('ACK_PENDING_DB')
    }else if(crash==='after_RETRYABLE'){
      expect(result.status).toBe('RETRY_WAIT');expect(parentWire).toBe(0)
      const receipt=store.readReceipt(`out-${row.id}`)!
      now=receipt.next_not_before!+100;mono=11000
      await makeOwnedRetryDue(f,row.id)
      expect((await deliver()).status).toBe('ACK_PENDING_DB');expect(parentWire).toBe(1)
    }else if(['after_ACK','after_stage1','before_stage2','after_stage2'].includes(crash)){
      expect(parentWire).toBe(0)
      let resumed=result
      for(const advance of [1000,2000,4000]){now+=advance;mono+=advance;resumed=await deliver();expect(parentWire).toBe(0)}
      expect(resumed.status).toBe('SENT')
    }else{
      expect(result.status).toBe('NEEDS_ATTENTION');expect(parentWire).toBe(0)
      expect((await f.runtime.query('SELECT attempts FROM outbound_queue WHERE id=$1',[row.id])).rows[0].attempts).toBe(1)
    }
    console.log(JSON.stringify({subcase:'DR07',crash,actual_child_exit:exit,parent_wire:parentWire,fixture_only:true}))
  })
  // DR01: real PG guards and the locked SDK; provider I/O replaced only at
  // makeRequest. The wrapper still owns one logical result/reply.
  await fixture(async f=>{
    f.config.runtime_id='command-json'
    const q=await startNormalTask(f)
    await saveFixtureResult(f,q.id)
    const finalized=await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})
    expect(finalized.ok).toBe(true)
    const state=(await admissionStatus(f.runtime,f.config.policy_id))!
    const row=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[state.tasks[0].reply_id])).rows[0]
    expect(row.max_attempts).toBe(3)
    let wire=0;let now=Date.now();let mono=0
    const clock={now:()=>now,monotonic:()=>mono}
    const adapter={prepareBoundedRequest:async(r:any):Promise<BoundedDiscordRequest>=>({delivery_id:`out-${r.id}`,channel_id:r.channel_external_id,
      author_id:'111111111111111111',body:{content:r.content,nonce:`out-${r.id}`,enforce_nonce:true,
        allowed_mentions:{parse:['users','roles'],replied_user:false}}}),
      sendBoundedRequest:(r:BoundedDiscordRequest,permit:any)=>postBoundedDiscordRequest(r,permit,'fixture-never-network',async()=>{
        wire++;return new Response(JSON.stringify({id:'222222222222222222',channel_id:r.channel_id,author:{id:r.author_id},
          nonce:r.delivery_id,content:r.body.content}),{status:200,headers:{'content-type':'application/json'}})
      })}
    const binding=admissionBindingFromEnv(f.env)!
    const first=await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
    expect(first).toMatchObject({status:'ACK_PENDING_DB',reserved:1,observed_wire_calls:1})
    expect(wire).toBe(1)
    now+=1000;mono+=1000
    const second=await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
    expect(second.status).toBe('SENT');expect(wire).toBe(1)
    const third=await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
    expect(third.status).toBe('SENT');expect(wire).toBe(1)
    expect((await f.admin.query('SELECT status,attempts,discord_message_id FROM outbound_queue WHERE id=$1',[row.id])).rows[0])
      .toMatchObject({status:'sent',attempts:1,discord_message_id:'222222222222222222'})
    expect((await f.admin.query('SELECT discord_message_id FROM agent_messages WHERE id=$1',[row.message_id])).rows[0].discord_message_id).toBe('222222222222222222')
    expect((await f.admin.query('SELECT count(*)::int AS n FROM agent_messages WHERE reply_to=$1',[q.message_id])).rows[0].n).toBe(1)
    console.log(JSON.stringify({subcase:'DR01',actual_sdk_wire_calls:wire,logical_reply_count:1,task_invocations:1,fixture_only:true}))
  })
  for(const spec of [
    {id:'DR02',statuses:[0,200],waits:[10000]},
    {id:'DR03',statuses:[429,503,200],waits:[12500,30000]},
    {id:'DR04',statuses:[503,503,503],waits:[10000,30000]},
    {id:'DR05',statuses:[403],waits:[]},
  ]) await fixture(async f=>{
    f.config.runtime_id='command-json'
    const q=await startNormalTask(f);await saveFixtureResult(f,q.id)
    expect((await finalizeDoneQueueWork(fixtureDb(f),{queueId:q.id,replySender:hostReplySender(f)})).ok).toBe(true)
    const task=(await admissionStatus(f.runtime,f.config.policy_id))!.tasks[0]
    const row=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[task.reply_id])).rows[0]
    const binding=admissionBindingFromEnv(f.env)!
    let wire=0;let now=Date.now();let mono=0;let preparations=0
    const bodies:string[]=[];const sentAt:number[]=[]
    const clock={now:()=>now,monotonic:()=>mono}
    const adapter={prepareBoundedRequest:async(r:any):Promise<BoundedDiscordRequest>=>{
      preparations++;return {delivery_id:`out-${r.id}`,channel_id:r.channel_external_id,author_id:'111111111111111111',
        body:{content:r.content,nonce:`out-${r.id}`,enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}
    },sendBoundedRequest:(r:BoundedDiscordRequest,permit:any)=>postBoundedDiscordRequest(r,permit,'fixture-never-network',async(_url,init)=>{
      const status=spec.statuses[wire];wire++;sentAt.push(now);bodies.push(String(init.body))
      if(status===0)throw new Error('fixture timeout')
      return new Response(JSON.stringify(status===200?{id:'222222222222222222',channel_id:r.channel_id,author:{id:r.author_id},nonce:r.delivery_id,content:r.body.content}
        :status===429?{retry_after:12.5,global:true,message:'fixture rate limit'}:{message:'fixture error',code:50013}),
        {status,headers:{'content-type':'application/json',...(status===429?{'Retry-After':'0.25'}:{})}})
    })}
    const deliver=()=>deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
    for(let i=0;i<spec.statuses.length;i++){
      const result=await deliver()
      expect(wire).toBe(i+1)
      if(i<spec.waits.length){
        expect(result.status).toBe('RETRY_WAIT')
        expect((await deliver()).status).toBe('RETRY_WAIT');expect(wire).toBe(i+1)
        if(spec.id==='DR03'&&i===0){
          const peer={...f.config,policy_id:`${f.config.policy_id}_peer`,agent_id:'qa-peer'}
          await f.control.query('BEGIN ISOLATION LEVEL READ COMMITTED')
          await f.control.query('SELECT public.aun_admission_prepare_lock()')
          await f.control.query('SELECT public.aun_admission_prepare($1::jsonb)',[JSON.stringify(peer)])
          await f.control.query('COMMIT')
          // The first real 429 supplied this deadline. Move its owner to a
          // second admitted policy to measure the cross-policy SQL max, not
          // merely the first row\'s own next_retry_at.
          await f.admin.query('UPDATE queue_admission_policies SET bot_not_before=(SELECT bot_not_before FROM queue_admission_policies WHERE policy_id=$1) WHERE policy_id=$2',[f.config.policy_id,peer.policy_id])
          await f.admin.query("UPDATE queue_admission_policies SET bot_not_before='{}' WHERE policy_id=$1",[f.config.policy_id])
          const original=(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[q.message_id])).rows[0]
          await expect(deliverBoundedOutbound({db:f.runtime,row:original,binding,adapter:fakeSuccessPort(()=>{wire++}),clock})).rejects.toThrow('ADMISSION_DELIVERY_NOT_DUE')
          expect(wire).toBe(1)
          await f.admin.query("UPDATE queue_admission_policies SET bot_not_before='{}' WHERE policy_id=$1",[peer.policy_id])
        }
        // Deterministic fixture time: move only this owned row's SQL deadline,
        // with the real guard's exact mutation permit. No production clock hook.
        // Before adjustment the real PG reservation must refuse early claiming.
        const owned=(await f.admin.query('SELECT to_jsonb(o) AS row FROM outbound_queue o WHERE id=$1',[row.id])).rows[0].row
        await expect(f.runtime.query('SELECT public.aun_admission_outbound($1,$2,$3::jsonb)',[row.id,'claim',JSON.stringify({
          consumer_agent_id:'different-consumer',source_sha:binding.sourceSha,cohort_digest:binding.cohortDigest,
          owner_token:'early-fixture',owner_host:f.config.transport.host,owner_pid:process.pid,owner_start:'fixture'})])).rejects.toThrow('ADMISSION_DELIVERY_NOT_DUE')
        // Match PostgreSQL's timestamp JSON encoding (+09:00 is not byte-equal
        // to JavaScript's Z), as the production mutation permit requires.
        const next=(await f.admin.query("SELECT jsonb_set($1::jsonb,'{next_retry_at}',to_jsonb(clock_timestamp()-interval '1 second')) AS row",[JSON.stringify(owned)])).rows[0].row
        await f.admin.query('BEGIN')
        try{
          await f.admin.query('SELECT public.aun_admission_permit($1,$2,$3::jsonb,$4::jsonb)',[f.config.policy_id,'outbound_queue',JSON.stringify(owned),JSON.stringify(next)])
          await f.admin.query('UPDATE outbound_queue SET next_retry_at=$1 WHERE id=$2',[next.next_retry_at,row.id])
          await f.admin.query("UPDATE queue_admission_policies SET bot_not_before='{}'::jsonb WHERE policy_id=$1",[f.config.policy_id])
          await f.admin.query('COMMIT')
        }catch(e){await f.admin.query('ROLLBACK');throw e}
        now+=spec.waits[i]+100;mono+=spec.waits[i]+100
      }
    }
    expect(preparations).toBe(1);expect(new Set(bodies).size).toBe(1)
    for(let i=1;i<sentAt.length;i++)expect(sentAt[i]-sentAt[i-1]).toBeGreaterThanOrEqual(spec.waits[i-1])
    expect(wire).toBeLessThanOrEqual(3)
    if(spec.statuses.at(-1)===200){
      now+=1000;mono+=1000;await deliver();expect(wire).toBe(spec.statuses.length)
    }else{
      await deliver();expect(wire).toBe(spec.statuses.length)
      const notices=(await f.admin.query("SELECT id FROM message_queue WHERE agent_id='codex-cto' AND message_id IS NULL AND payload::jsonb->>'policy_id'=$1",[f.config.policy_id])).rows
      expect(notices.length).toBe(1)
    }
    const receipt=JSON.parse(readFileSync(`${f.config.transport.receipt_dir}/out-${row.id}.json`,'utf8'))
    expect(receipt.reservations).toBe(wire);expect(receipt.wire_calls).toBe(wire)
    expect((await admissionStatus(f.runtime,f.config.policy_id))!.tasks[0]).toMatchObject({invocation_attempts:1,finalizer_attempts:1})
    console.log(JSON.stringify({subcase:spec.id,actual_sdk_wire_calls:wire,request_variants:new Set(bodies).size,waits_ms:sentAt.slice(1).map((x,i)=>x-sentAt[i]),fixture_only:true}))
  })
  for(const mode of ['sent_before','sent_commit_response_lost','backfill_before','backfill_commit_response_lost','budget_cap','db_unavailable']){
    await fixture(async f=>{
      const {row,binding}=await readyReply(f)
      let wire=0;let now=Date.now();let mono=0;let failures=0;let action='';let writes=0
      const clock={now:()=>now,monotonic:()=>mono}
      const adapter=fakeSuccessPort(()=>{wire++})
      const db={query:async(sql:string,params?:any[])=>{
        if(sql==='SELECT 1'&&mode==='db_unavailable')throw new Error('fixture DB unavailable after ACK')
        if(sql.includes('aun_admission_outbound')&&['sent','backfill'].includes(params?.[1])){
          action=params![1];writes++
          if((mode==='budget_cap'||mode===`${action}_before`)&&(mode==='budget_cap'||failures===0)){
            failures++;throw new Error('fixture persistence failure before write')
          }
        }
        const result=await f.runtime.query(sql,params)
        if(sql==='COMMIT'&&mode===`${action}_commit_response_lost`&&failures===0){failures++;throw new Error('fixture COMMIT response lost')}
        return result
      }}
      for(const elapsed of [0,1000,3000,7000,15000,20001,30000]){
        now=now-mono+elapsed;mono=elapsed
        await deliverBoundedOutbound({db,row,binding,adapter,clock})
        expect(wire).toBe(1)
      }
      const receipt=JSON.parse(readFileSync(`${f.config.transport.receipt_dir}/out-${row.id}.json`,'utf8'))
      const stored=(await f.runtime.query('SELECT * FROM outbound_queue WHERE id=$1',[row.id])).rows[0]
      expect(writes).toBeLessThanOrEqual(5)
      expect(receipt.wire_calls).toBe(1);expect(receipt.ack.message_id).toBe('222222222222222222')
      if(mode==='budget_cap'){
        expect(writes).toBe(5);expect(receipt.persistence.writes).toBe(5)
        expect(receipt.state).toBe('NEEDS_ATTENTION');expect(receipt.notice_pending).toBe(true)
        expect(stored.status).toBe('claimed')
      }else if(mode==='db_unavailable'){
        expect(writes).toBe(0);expect(receipt.persistence.writes).toBe(0);expect(stored.status).toBe('claimed')
      }else{
        expect(receipt.state).toBe('SENT');expect(receipt.persistence.stage).toBe(2)
        expect(stored.status).toBe('sent');expect(stored.discord_message_id).toBe('222222222222222222')
        expect(failures).toBe(1)
      }
      console.log(JSON.stringify({subcase:'DR06',mode,actual_sdk_wire_calls:wire,persistence_writes:writes,reserved_writes:receipt.persistence.writes,fixture_only:true}))
    })
  }
  await fixture(async f=>{
    const {row,binding}=await readyReply(f)
    let wire=0;let releaseWire!:()=>void;let entered!:()=>void
    const atWire=new Promise<void>(resolve=>{entered=resolve})
    const held=new Promise<void>(resolve=>{releaseWire=resolve})
    const adapter=fakeSuccessPort(()=>{wire++})
    const ordinarySend=adapter.sendBoundedRequest
    adapter.sendBoundedRequest=async(r,permit)=>{entered();await held;return ordinarySend(r,permit)}
    const first=deliverBoundedOutbound({db:f.runtime,row,binding,adapter})
    await atWire
    const lock=`${f.config.transport.receipt_dir}/out-${row.id}.lock`
    utimesSync(lock,new Date(0),new Date(0)) // Age and a 60s stuck tick grant nothing.
    const ownerBefore=readFileSync(lock,'utf8')
    await f.runtime.end() // A lost DB session does not terminate the POST owner.
    await expect(deliverBoundedOutbound({db:f.executor,row,binding,adapter})).rejects.toThrow('ADMISSION_DELIVERY_OWNER_UNRESOLVED')
    expect(readFileSync(lock,'utf8')).toBe(ownerBefore);expect(wire).toBe(0)
    releaseWire();await first;expect(wire).toBe(1)
    const old=JSON.parse(ownerBefore)
    const store=new BoundedReceiptStore(f.config.transport.receipt_dir,currentBoundedOwner(binding.cohortDigest))
    await expect(Promise.resolve().then(()=>store.releaseEndedOwner(`out-${row.id}`,old))).rejects.toThrow('ADMISSION_PRIOR_OWNER_NOT_ENDED')
    await expect(Promise.resolve().then(()=>store.releaseEndedOwner(`out-${row.id}`,{...old,start:'different-process-incarnation'}))).rejects.toThrow('ADMISSION_PRIOR_OWNER_NOT_ENDED')
    await expect(Promise.resolve().then(()=>store.releaseEndedOwner(`out-${row.id}`,{...old,host:'foreign-host'}))).rejects.toThrow('ADMISSION_DELIVERY_OWNER_MISMATCH')
    console.log(JSON.stringify({subcase:'DR08',concurrent_wire:1,db_disconnect_overlap:0,lock_age_steal:0,active_owner_recovery:0,pid_reuse_recovery:0,foreign_owner_recovery:0,fixture_only:true}))
  })
  // DR09: wait parsing and the final actual-wire deadline use deterministic
  // wall/monotonic clocks; SQL early-reservation rejection was measured above.
  expect(boundedRetryAfter('0.1234',0.25)).toBe(250)
  expect(boundedRetryAfter(null,0.0001)).toBe(1)
  for(const bad of [null,NaN,Infinity,-1,{},[],true,'','nonsense'])expect(boundedRetryAfter(null,bad)).toBeNull()
  const deadlineRequest:BoundedDiscordRequest={delivery_id:'out-999',channel_id:'999999999999999999',author_id:'111111111111111111',
    body:{content:'fixture deadline',nonce:'out-999',enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}
  let wall=100000;let monotonic=0;let forbiddenWire=0
  const permit=await authorizeBoundedPost({query:async()=>[]},{id:999,claimed_at:'fixture'},deadlineRequest,currentBoundedOwner('1'.repeat(64)),115000,
    {policyId:'fixture',configDigest:'1'.repeat(64),sourceSha:'0'.repeat(40),cohortDigest:'1'.repeat(64),runtimeId:'fixture'},
    {now:()=>wall,monotonic:()=>monotonic})
  wall=90000;monotonic=6000 // Backward UTC must not extend the original 5s start window.
  const denied=await postBoundedDiscordRequest(deadlineRequest,permit,'fixture',async()=>{forbiddenWire++;throw Error('unreachable')})
  expect(denied.kind).toBe('NEEDS_ATTENTION');expect(forbiddenWire).toBe(0)
  // Actual SDK boundary: malformed success, missing credential and invalid /
  // fractional Retry-After are measured without any provider connection.
  for(const mode of ['bad_json','wrong_id','wrong_channel','wrong_author','wrong_nonce','array_nonce','wrong_content','no_token','malformed_wait','fractional_wait']){
    let wire=0
    const p=await authorizeBoundedPost({query:async()=>[]},{id:999,claimed_at:'fixture'},deadlineRequest,currentBoundedOwner('1'.repeat(64)),Date.now()+60000,
      {policyId:'fixture',configDigest:'1'.repeat(64),sourceSha:'0'.repeat(40),cohortDigest:'1'.repeat(64),runtimeId:'fixture'})
    const body:any={id:'222222222222222222',channel_id:deadlineRequest.channel_id,author:{id:deadlineRequest.author_id},nonce:deadlineRequest.delivery_id,content:deadlineRequest.body.content}
    if(mode==='wrong_id')body.id=[]
    if(mode==='wrong_channel')body.channel_id='333333333333333333'
    if(mode==='wrong_author')body.author.id='333333333333333333'
    if(mode==='wrong_nonce')body.nonce='other'
    if(mode==='array_nonce')body.nonce=[body.nonce]
    if(mode==='wrong_content')body.content='changed'
    const retry=mode.endsWith('_wait')
    const outcome=await postBoundedDiscordRequest(deadlineRequest,p,mode==='no_token'?'':'fixture',async()=>{
      wire++;return new Response(mode==='bad_json'?'not-json':JSON.stringify(retry?{retry_after:mode==='fractional_wait'?0.0001:'invalid',global:false}:body),
        {status:retry?429:200,headers:{'content-type':'application/json'}})
    })
    expect(wire).toBe(mode==='no_token'?0:1)
    expect(outcome.kind).toBe(mode==='fractional_wait'?'RETRYABLE':'NEEDS_ATTENTION')
    if(mode==='fractional_wait')expect((outcome as any).retry_after_ms).toBe(1)
  }
  for(const mode of ['long_retry_after','nonce_horizon','policy_expiry','original_max1'])await fixture(async f=>{
    const {q,row:reply,binding}=await readyReply(f)
    const row=mode==='original_max1'?(await f.runtime.query('SELECT * FROM outbound_queue WHERE message_id=$1',[q.message_id])).rows[0]:reply
    let wire=0,now=Date.now(),mono=0
    const adapter=fakeSuccessPort(()=>{})
    adapter.sendBoundedRequest=(r,p)=>postBoundedDiscordRequest(r,p,'fixture',async()=>{
      wire++;return new Response(JSON.stringify({retry_after:mode==='long_retry_after'?120:0.1,message:'fixture wait'}),{status:429,headers:{'content-type':'application/json'}})
    })
    const deliver=()=>deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock:{now:()=>now,monotonic:()=>mono}})
    const first=await deliver();expect(wire).toBe(1)
    if(mode==='long_retry_after'||mode==='original_max1'){
      expect(first.status).toBe('NEEDS_ATTENTION');await deliver();expect(wire).toBe(1)
    }else{
      expect(first.status).toBe('RETRY_WAIT')
      now+=111000;mono+=111000;await makeOwnedRetryDue(f,row.id)
      if(mode==='policy_expiry')await f.admin.query("UPDATE queue_admission_policies SET expires_at=clock_timestamp()-interval '1 second' WHERE policy_id=$1",[f.config.policy_id])
      if(mode==='policy_expiry')await expect(deliver()).rejects.toThrow('ADMISSION_DENIED')
      else expect((await deliver()).status).toBe('NEEDS_ATTENTION')
      expect(wire).toBe(1)
    }
    expect((await admissionStatus(f.control,f.config.policy_id))!.tasks[0]).toMatchObject({invocation_attempts:1,finalizer_attempts:1})
    console.log(JSON.stringify({subcase:'DR05/DR09/DR12',mode,physical_posts:wire,repeated_task:0,fixture_only:true}))
  })
  console.log(JSON.stringify({subcase:'DR09',fractional_round_up:true,malformed_rejected:9,clock_rollback_wire:0,fixture_only:true}))
  for(const damage of ['corrupt','permissions','symlink'])await fixture(async f=>{
    const {row,binding}=await readyReply(f);let wire=0
    const adapter=fakeSuccessPort(()=>{wire++})
    await deliverBoundedOutbound({db:f.runtime,row,binding,adapter})
    const path=`${f.config.transport.receipt_dir}/out-${row.id}.json`
    const prior=readFileSync(path,'utf8')
    if(damage==='corrupt'){
      const owner=currentBoundedOwner(binding.cohortDigest)
      const store=new BoundedReceiptStore(f.config.transport.receipt_dir,owner)
      for(const field of ['config_digest','request_digest','cohort_digest','source_sha'])for(const value of [[JSON.parse(prior)[field]],42,null,{}]){
        writeFileSync(path,JSON.stringify({...JSON.parse(prior),[field]:value}),{mode:0o600})
        expect(()=>store.readReceipt(`out-${row.id}`)).toThrow('ADMISSION_RECEIPT_INVALID')
      }
      for(const field of ['message_id','channel_id','author_id','response_sha256']){
        const r=JSON.parse(prior);r.ack[field]=[r.ack[field]]
        writeFileSync(path,JSON.stringify(r),{mode:0o600})
        expect(()=>store.readReceipt(`out-${row.id}`)).toThrow('ADMISSION_RECEIPT_INVALID')
      }
      writeFileSync(path,'{"broken":true}',{mode:0o600})
    }
    if(damage==='permissions')chmodSync(path,0o644)
    if(damage==='symlink'){
      const exactFixtureTarget=`${f.config.transport.receipt_dir}/damage-fixture.json`
      writeFileSync(exactFixtureTarget,prior,{mode:0o600});unlinkSync(path);symlinkSync(exactFixtureTarget,path)
    }
    await expect(deliverBoundedOutbound({db:f.runtime,row,binding,adapter})).rejects.toThrow('ADMISSION_RECEIPT_INVALID')
    expect(wire).toBe(1)
    console.log(JSON.stringify({subcase:'DR10',damage,post_damage_wire_delta:0,fixture_only:true}))
  })
  await fixture(async f=>{
    const {row,binding}=await readyReply(f);let wire=0,dbLost=false
    const adapter=fakeSuccessPort(()=>{wire++;dbLost=true})
    const db={query:(sql:string,params?:any[])=>{if(dbLost)throw Error('fixture both stores lost');return f.runtime.query(sql,params)}}
    const save=BoundedReceiptStore.prototype.write
    BoundedReceiptStore.prototype.write=function(r){if(r.ack)throw Error('fixture ACK disk failure');return save.call(this,r)}
    try{
      const outcome=await deliverBoundedOutbound({db,row,binding,adapter})
      expect(outcome).toMatchObject({status:'ACK_STORAGE_UNKNOWN',reserved:1,observed_wire_calls:1})
      await expect(deliverBoundedOutbound({db,row,binding,adapter})).rejects.toThrow('fixture both stores lost')
      expect(wire).toBe(1)
    }finally{BoundedReceiptStore.prototype.write=save}
    dbLost=false
    const resumed=await deliverBoundedOutbound({db,row,binding,adapter})
    expect(resumed.status).toBe('NEEDS_ATTENTION');expect(wire).toBe(1)
    expect((await admissionStatus(f.control,f.config.policy_id))!.policy.status).toBe('HALTED')
    console.log(JSON.stringify({subcase:'DR10',damage:'ACK_disk_and_DB_loss',physical_posts:1,restart_POST_delta:0,delivery_success_claim:false}))
  })
  await fixture(async f=>{
    const {row,binding}=await readyReply(f);let wire=0;let outage=true
    const adapter=fakeSuccessPort(()=>{})
    adapter.sendBoundedRequest=(r,permit)=>postBoundedDiscordRequest(r,permit,'fixture',async()=>{
      wire++;return new Response('{"message":"fixture denied","code":50013}',{status:403,headers:{'content-type':'application/json'}})
    })
    const db={query:async(sql:string,params?:any[])=>{
      if(outage&&sql==='SELECT 1')throw Error('fixture DB down for notice')
      return f.runtime.query(sql,params)
    }}
    await deliverBoundedOutbound({db,row,binding,adapter})
    const count=async()=>(await f.admin.query("SELECT count(*)::int AS n FROM message_queue WHERE agent_id='codex-cto' AND message_id IS NULL AND payload::jsonb->>'policy_id'=$1",[f.config.policy_id])).rows[0].n
    expect(await count()).toBe(0)
    outage=false
    for(let i=0;i<3;i++)await deliverBoundedOutbound({db,row,binding,adapter})
    expect(await count()).toBe(1);expect(wire).toBe(1)
    const notice=(await f.admin.query("SELECT payload::jsonb AS payload FROM message_queue WHERE agent_id='codex-cto' AND message_id IS NULL AND payload::jsonb->>'policy_id'=$1",[f.config.policy_id])).rows[0].payload
    expect(notice.message_type).toBe('system_error');expect(notice.author_id).toBe('system')
    expect((await f.admin.query("SELECT count(*)::int AS n FROM agent_messages WHERE author_id='system'")).rows[0].n).toBe(0)
    console.log(JSON.stringify({subcase:'DR11',notice_rows:1,provider_posts:1,notice_outbound:0,fixture_only:true}))
  })
  // DR12 positive control: the opt-in REST did not reconfigure the ordinary
  // SDK or remove its existing explicit-reference fallback.
  const rest=new REST()
  expect(rest.options.retries).toBe(3);expect(rest.options.rejectOnRateLimit).toBeNull()
  rest.clearHashSweeper();rest.clearHandlerSweeper()
  const ordinary=new DiscordAdapter();let replyCalls=0;let fallbackCalls=0
  const ch:any={id:'999999999999999999',sendTyping:async()=>{},send:async()=>{fallbackCalls++;return{id:'222222222222222222'}},
    messages:{fetch:async()=>({channel:ch,reply:async()=>{replyCalls++;throw Error('fixture ordinary reply failure')}})}}
  ;(ordinary as any).client={channels:{fetch:async()=>ch}}
  expect(await ordinary.sendMessage(ch.id,'ordinary fixture',{replyTo:'333333333333333333'})).toEqual({messageId:'222222222222222222'})
  expect(replyCalls).toBe(1);expect(fallbackCalls).toBe(1)
  console.log(JSON.stringify({subcase:'DR12',ordinary_sdk_retries:3,ordinary_fallback:1,fixture_only:true}))
})
