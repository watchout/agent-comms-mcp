import { expect } from 'bun:test'
import { publishNativeFixtureReport } from '../helpers/seat-native-runtime-fixture'
import { sanitizeFixtureError, boundedTest, fixture, startNormalTask, fixtureDb, fixtureResult, hostReplySender, candidateRoot, fixtureEvent, settleFixtureWork, settleIndependentFixtureWork, type BoundedFixture } from './test_queue_bounded_admission.test'
import { admissionBindingFromEnv, admissionStatus, admissionTransition, tryBoundedClaim, deliverBoundedOutbound, authorizeBoundedPost,
  boundedRetryAfter, BoundedReceiptStore, currentBoundedOwner, recoverBoundedReceipt, admissionSha256, type BoundedDiscordRequest } from '../../core/queue-admission'
import { DiscordAdapter, postBoundedDiscordRequest } from '../../adapters/discord'
import { chmodSync, existsSync, lstatSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
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

// A09 barriers exist only in owned test children. No production hook, polling
// daemon, fake process-end identity or provider connection is introduced.
async function ownerRecoveryFixture(cut: 'acquired'|'unlinked'|'closed'|'races') {
  await fixture(async f=>{
    const policyBody='A09 isolated fixture authority; never live authority'
    f.config.authority={url:'https://github.com/fixture/repo/issues/1#issuecomment-1',sha256:admissionSha256(policyBody)}
    const {row,binding}=await readyReply(f),directory=f.config.transport.receipt_dir,id=`out-${row.id}`
    const runtimeUrl=new URL(f.roleUrls.runtime)
    const controlUrl=new URL(f.roleUrls.controller)
    const script=`${directory}/a09-child.ts`,inputPath=`${directory}/a09-input.json`
    writeFileSync(script,`
import { Client } from '${candidateRoot}/node_modules/pg/lib/index.js'
import { Database,constants as sqliteConstants } from 'bun:sqlite'
import { existsSync,readFileSync,writeFileSync,lstatSync,renameSync,openSync,closeSync,rmSync } from 'node:fs'
import { BoundedReceiptStore,currentBoundedOwner,deliverBoundedOutbound,recoverBoundedReceipt } from '${candidateRoot}/core/queue-admission.ts'
const i=JSON.parse(readFileSync(process.argv[2],'utf8')),mode=process.argv[3],tag=process.argv[4]||mode
const client=new Client({connectionString:i.url,connectionTimeoutMillis:1000});await client.connect()
const publishNativeFixtureReport = ${publishNativeFixtureReport.toString()}
const mark=(name,value={})=>publishNativeFixtureReport(i.directory+'/'+tag+'-'+name+'.json',{at:Date.now(),pid:process.pid,...value})

let clientClosed=false,clientClose:Promise<void>|undefined
client.on('error',error=>mark('db-error',{code:error.code||null}))
client.on('end',()=>{clientClosed=true;mark('db-end')})
client.connection.stream.on('close',()=>{clientClosed=true;mark('db-close')})
const closeClient=()=>{
 if(clientClose)return clientClose
 clientClose=(async()=>{
  mark('db-close-start')
  let timer
  const done=client.end().then(()=>true)
  const settled=await Promise.race([done,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),2000)})])
  clearTimeout(timer)
  if(!settled){client.connection.stream.destroy();await Promise.race([done,new Promise(resolve=>{timer=setTimeout(resolve,500)})]);clearTimeout(timer);mark('db-close-failed',{closed:clientClosed});throw Error('A09_FIXTURE_DB_CLOSE_TIMEOUT')}
  mark('db-close-settled',{closed:clientClosed})
 })()
 return clientClose
}

const barrier=name=>{mark(name);const until=Date.now()+8000;while(!existsSync(i.directory+'/'+tag+'-'+name+'.go')){
 if(Date.now()>until)throw Error('A09_BARRIER_TIMEOUT '+name);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2)}}
const store=new BoundedReceiptStore(i.directory,currentBoundedOwner(i.binding.cohortDigest));const main=i.directory+'/'+i.id+'.reap.sqlite'
const snapshot=()=>Object.fromEntries([main,main+'-journal'].filter(existsSync).map(path=>{const s=lstatSync(path);return[path,{dev:s.dev,ino:s.ino,size:s.size,mode:s.mode&511,uid:s.uid,nlink:s.nlink}]}))
if(mode==='seed'){
 const { postBoundedDiscordRequest } = await import('${candidateRoot}/adapters/discord.ts')
 const save=BoundedReceiptStore.prototype.write;BoundedReceiptStore.prototype.write=function(r){save.call(this,r);if(r.ack)process.exit(23)}
 const adapter={prepareBoundedRequest:async(r)=>({delivery_id:i.id,channel_id:r.channel_external_id,author_id:'111111111111111111',
 body:{content:r.content,nonce:i.id,enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}),
 sendBoundedRequest:(r,p)=>postBoundedDiscordRequest(r,p,'fixture',async()=>new Response(JSON.stringify({id:'222222222222222222',channel_id:r.channel_id,author:{id:r.author_id},nonce:i.id,content:r.body.content}),{status:200,headers:{'content-type':'application/json'}}))}
 await deliverBoundedOutbound({db:client,row:i.row,binding:i.binding,adapter});process.exit(24)
}
const before=store.readReceipt(i.id);mark('pre-read',{receipt:before})
if(mode==='missing-nofollow')sqliteConstants.SQLITE_OPEN_NOFOLLOW=0
if(mode==='wrong-uid')process.getuid=()=>i.fixture_uid+1
const run=Database.prototype.run,read=store.read.bind(store),sync=store.syncParent.bind(store),reap=store.releaseEndedOwner.bind(store)
Database.prototype.run=function(sql,...args){const result=run.call(this,sql,...args);if(sql==='BEGIN EXCLUSIVE'){
 mark('journal',{files:snapshot(),bun:Bun.version,sqlite:this.query('SELECT sqlite_version() AS v').get().v})
 if(mode==='acquired')process.exit(23)
 if(mode==='inode-drift'){renameSync(main,i.directory+'/replaced-main');writeFileSync(main,'',{mode:0o600})}
 }return result}
store.read=function(path){const result=read(path);if(path.endsWith('.lock')&&mode==='held')barrier('fresh-read');return result}
store.syncParent=function(){sync();if(mode==='unlinked'&&!existsSync(i.directory+'/'+i.id+'.lock')){mark('cut',{files:snapshot()});process.exit(23)}}
try{
 if(mode==='before-guard'||mode==='concurrent-create')barrier('before-guard')
 if(mode==='lost-db-held'){await closeClient();store.read=function(path){const result=read(path);if(path.endsWith('.lock'))barrier('fresh-read');return result}}
 if(mode==='recover'){
  const lock=BoundedReceiptStore.prototype.lock
  if(tag.startsWith('stale'))BoundedReceiptStore.prototype.lock=function(id){barrier('before-lock');return lock.call(this,id)}
  const bodies=new Map(i.bodies)
  const result=await recoverBoundedReceipt({db:client,state:i.state,deliveryId:i.id,receiptPath:i.directory+'/'+i.id+'.json',
   recovery:i.recovery,readBody:async ref=>bodies.get(ref.url),dryRun:false,sleep:async()=>{}})
  mark('result',{result})
 }else{
  reap(i.id,i.prior)
  if(mode==='closed'){mark('cut',{files:snapshot()});process.exit(23)}
  if(mode==='race-lock')barrier('before-lock')
  const release=store.lock(i.id)
  const fresh=store.readReceipt(i.id);fresh.persistence.recovery_tokens.push('fixture-owner-'+tag);store.write(fresh)
  const lockStat=lstatSync(i.directory+'/'+i.id+'.lock')
  mark('owner',{owner:store.owner,files:snapshot(),owner_file:{dev:lockStat.dev,ino:lockStat.ino,uid:lockStat.uid,mode:lockStat.mode&511,size:lockStat.size}})
  if(mode==='winner'||mode==='held'||mode==='before-guard'||mode==='race-lock'||mode==='lost-db-held'||mode==='concurrent-create')barrier('new-owner')
  release();mark('result',{status:'released'})
 }
}catch(e){mark('error',{code:e.code||e.message})}
await closeClient();process.exit(0)
`,{mode:0o600})
    const base:any={row,binding,directory,id,url:runtimeUrl.href}
    writeFileSync(inputPath,JSON.stringify(base),{mode:0o600})
    const children:ReturnType<typeof Bun.spawn>[]=[]
    const childCommands=new Map<number,string[]>()
    const launch=(mode:string,tag=mode,path=inputPath)=>{
      const argv=[process.execPath,script,path,mode,tag]
      const p=Bun.spawn(argv,{cwd:candidateRoot,env:{PATH:process.env.PATH,LC_ALL:'C'},stdout:'pipe',stderr:'pipe'})
      children.push(p);childCommands.set(p.pid,argv);return p
    }
    const wait=async(path:string)=>{
      const until=Date.now()+9000
      while(!existsSync(path)){if(Date.now()>until)throw Error(`A09_PARENT_BARRIER_TIMEOUT ${path}`);await new Promise(r=>setTimeout(r,2))}
      return JSON.parse(readFileSync(path,'utf8'))
    }
    const marker=(tag:string,name:string)=>`${directory}/${tag}-${name}.json`
    const go=(tag:string,name:string)=>writeFileSync(`${directory}/${tag}-${name}.go`,'go',{mode:0o600})
    const end=async(p:ReturnType<typeof Bun.spawn>,expected=0)=>{
      fixtureEvent('A09','child-wait',{pid:p.pid,expected})
      const timer=setTimeout(()=>p.kill(),10000)
      try{
        const exit=await p.exited,stderr=await new Response(p.stderr).text()
        writeFileSync(`${directory}/child-${p.pid}.stderr.log`,stderr,{mode:0o600})
        writeFileSync(`${directory}/child-${p.pid}.receipt.json`,JSON.stringify({argv:childCommands.get(p.pid),pid:p.pid,exit,finished:Date.now(),stderr_sha256:admissionSha256(stderr)}),{mode:0o600})
        fixtureEvent('A09','child-ended',{pid:p.pid,exit})
        expect(exit,stderr).toBe(expected);return exit
      }
      finally{clearTimeout(timer)}
    }
    try{
      const seeded=launch('seed');await end(seeded,23)
      const receiptPath=`${directory}/${id}.json`,lockPath=`${directory}/${id}.lock`
      const raw=readFileSync(receiptPath,'utf8'),prior=JSON.parse(readFileSync(lockPath,'utf8'))
      expect(prior.pid).toBe(seeded.pid)
      const receipt=JSON.parse(raw),endBody=JSON.stringify({ended:true,host:prior.host,pid:prior.pid,start:prior.start,ended_at:new Date().toISOString()})
      const endRef={url:'https://github.com/fixture/repo/issues/1#issuecomment-2',sha256:admissionSha256(endBody)}
      const request={policy_id:f.config.policy_id,delivery_id:id,receipt_sha256:admissionSha256(raw),request_digest:receipt.request_digest,
        source_head:f.config.source_sha,recovery_token:'a09-recovery',max_writes:5,window_ms:20000,prior_owner_end_evidence:{owner:prior,ref:endRef}}
      const approval=JSON.stringify({...request,decision:'APPROVED',action:'persist-receipt',expires_at:new Date(Date.now()+60000).toISOString()})
      const approvalRef={url:'https://github.com/fixture/repo/issues/1#issuecomment-3',sha256:admissionSha256(approval)}
      const recovery={...request,authority_url:approvalRef.url,authority_sha256:approvalRef.sha256}
      const bodies=new Map([[f.config.authority.url,policyBody],[endRef.url,endBody],[approvalRef.url,approval]])
      const state=(await admissionStatus(f.control,f.config.policy_id))!
      Object.assign(base,{prior,recovery,bodies:[...bodies],state,url:controlUrl.href})
      writeFileSync(inputPath,JSON.stringify(base),{mode:0o600})
      if(cut==='races'){
        const dbSnapshot=async()=>JSON.stringify((await f.admin.query("SELECT (SELECT jsonb_agg(to_jsonb(o)) FROM outbound_queue o) outbound,(SELECT jsonb_agg(to_jsonb(t)) FROM queue_admission_tasks t) tasks,(SELECT jsonb_agg(to_jsonb(q)) FROM message_queue q) queue")).rows)
        const dbBefore=await dbSnapshot()
        // Each schedule has isolated files but the same actual ended owner and
        // durable receipt; children open distinct connections to this fixture DB.
        for(const order of ['AB','BA'])for(const schedule of ['held','before-guard','race-lock','lost-db-held','concurrent-create']){
          const sub=`${directory}/${order}-${schedule}`;mkdirSync(sub,{mode:0o700})
          writeFileSync(`${sub}/${id}.json`,raw,{mode:0o600})
          if(schedule!=='race-lock')writeFileSync(`${sub}/${id}.lock`,JSON.stringify(prior),{mode:0o600})
          const path=`${sub}/input.json`;writeFileSync(path,JSON.stringify({...base,directory:sub}),{mode:0o600})
          const a=order[0],b=order[1]
          let winnerTag=a
          const m=(tag:string,name:string)=>`${sub}/${tag}-${name}.json`
          const release=(tag:string,name:string)=>writeFileSync(`${sub}/${tag}-${name}.go`,'go',{mode:0o600})
          if(schedule==='concurrent-create'){
            const first=launch(schedule,a,path),second=launch(schedule,b,path)
            await Promise.all([wait(m(a,'before-guard')),wait(m(b,'before-guard'))])
            expect(existsSync(`${sub}/${id}.reap.sqlite`)).toBe(false)
            release(a,'before-guard');release(b,'before-guard')
            const deadline=Date.now()+9000
            while(!existsSync(m(a,'new-owner'))&&!existsSync(m(b,'new-owner'))&&!(existsSync(m(a,'error'))&&existsSync(m(b,'error')))){
              if(Date.now()>deadline)throw Error('A09_NO_CREATION_WINNER')
              await new Promise(resolve=>setTimeout(resolve,2))
            }
            if(existsSync(m(a,'error'))&&existsSync(m(b,'error'))){
              // Two zero-timeout upgrades may both decline safely. They are
              // not guaranteed a winner; no automatic retry is inferred.
              await Promise.all([end(first),end(second)])
              for(const tag of [a,b])expect((await wait(m(tag,'error'))).code).toBe('ADMISSION_RECOVERY_BUSY')
              expect(readFileSync(`${sub}/${id}.lock`,'utf8')).toBe(JSON.stringify(prior))
              expect(readFileSync(`${sub}/${id}.json`,'utf8')).toBe(raw)
              const fresh=new BoundedReceiptStore(sub,currentBoundedOwner(binding.cohortDigest))
              fresh.releaseEndedOwner(id,prior)
              const unlock=fresh.lock(id),updated=fresh.readReceipt(id)!
              updated.persistence.recovery_tokens.push(`fixture-owner-${a}`);fresh.write(updated);unlock()
            }else{
              const win=existsSync(m(a,'new-owner'))?a:b
              winnerTag=win;const loser=win===a?b:a
              const err=await wait(m(loser,'error'))
              expect(['ADMISSION_RECOVERY_BUSY','ADMISSION_DELIVERY_OWNER_MISMATCH']).toContain(err.code)
              release(win,'new-owner');await Promise.all([end(first),end(second)])
            }
          }else if(schedule==='before-guard'){
            const second=launch('before-guard',b,path);await wait(m(b,'before-guard'))
            const first=launch('winner',a,path);await wait(m(a,'new-owner'))
            const winner=readFileSync(`${sub}/${id}.lock`,'utf8');release(b,'before-guard');await end(second)
            expect((await wait(m(b,'error'))).code).toBe('ADMISSION_DELIVERY_OWNER_MISMATCH')
            expect(readFileSync(`${sub}/${id}.lock`,'utf8')).toBe(winner);release(a,'new-owner');await end(first)
          }else if(schedule==='race-lock'){
            const first=launch(schedule,a,path);await wait(m(a,'before-lock'))
            const second=launch(schedule,b,path);await wait(m(b,'before-lock'))
            release(a,'before-lock');await wait(m(a,'new-owner'));release(b,'before-lock');await end(second)
            expect((await wait(m(b,'error'))).code).toBe('ADMISSION_DELIVERY_OWNER_UNRESOLVED')
            release(a,'new-owner');await end(first)
          }else{
            const first=launch(schedule,a,path);await wait(m(a,'fresh-read'))
            const journal=await wait(m(a,'journal'));expect(Object.keys(journal.files).some(x=>x.endsWith('-journal'))).toBe(true)
            const second=launch('winner',b,path);await end(second)
            expect((await wait(m(b,'error'))).code).toBe('ADMISSION_RECOVERY_BUSY')
            expect(readFileSync(`${sub}/${id}.lock`,'utf8')).toBe(JSON.stringify(prior))
            release(a,'fresh-read');await wait(m(a,'new-owner'));release(a,'new-owner');await end(first)
          }
          const saved=JSON.parse(readFileSync(`${sub}/${id}.json`,'utf8'))
          expect(saved.persistence.recovery_tokens).toEqual([`fixture-owner-${winnerTag}`])
          for(const tag of [a,b])expect((await wait(m(tag,'pre-read'))).receipt).toEqual(receipt)
          console.log(JSON.stringify({subcase:'A09',schedule,order,actual_two_processes:true,receipt_sha256:admissionSha256(raw),provider_posts:0,task_invocations:0}))
        }
        // Actual filesystem damage is isolated per case; no production mutex
        // cleanup/repair API is used. Valid cold journal is a positive control.
        for(const damage of ['clean-reopen','cold-journal','corrupt','directory','symlink','hardlink','mode','oversize',
          'journal-mode','journal-symlink','journal-hardlink','journal-oversize','wal','shm','extra']){
          const sub=`${directory}/file-${damage}`;mkdirSync(sub,{mode:0o700})
          const main=`${sub}/${id}.reap.sqlite`,journal=`${main}-journal`,lock=`${sub}/${id}.lock`,saved=`${sub}/${id}.json`
          writeFileSync(lock,JSON.stringify(prior),{mode:0o600});writeFileSync(saved,raw,{mode:0o600})
          const put=(path:string,data:string|Buffer='')=>writeFileSync(path,data,{mode:0o600})
          if(damage==='directory')mkdirSync(main,{mode:0o700})
          else if(damage==='symlink'){put(`${sub}/target`);symlinkSync(`${sub}/target`,main)}
          else put(main,damage==='corrupt'?'not SQLite':damage==='oversize'?Buffer.alloc(16385):'')
          if(damage==='hardlink')linkSync(main,`${sub}/main-alias`)
          if(damage==='mode')chmodSync(main,0o644)
          if(damage==='cold-journal')put(journal)
          if(damage==='journal-mode'){put(journal);chmodSync(journal,0o644)}
          if(damage==='journal-symlink'){put(`${sub}/target`);symlinkSync(`${sub}/target`,journal)}
          if(damage==='journal-hardlink'){put(journal);linkSync(journal,`${sub}/journal-alias`)}
          if(damage==='journal-oversize')put(journal,Buffer.alloc(131073))
          if(['wal','shm','extra'].includes(damage))put(`${main}-${damage}`)
          const store=new BoundedReceiptStore(sub,currentBoundedOwner(binding.cohortDigest))
          if(damage==='clean-reopen'||damage==='cold-journal'){
            const inode=lstatSync(main).ino;store.releaseEndedOwner(id,prior);store.releaseEndedOwner(id,prior)
            expect(lstatSync(main).ino).toBe(inode);expect(existsSync(lock)).toBe(false)
          }else{
            expect(()=>store.releaseEndedOwner(id,prior)).toThrow('ADMISSION_RECOVERY_MUTEX_INVALID')
            expect(readFileSync(lock,'utf8')).toBe(JSON.stringify(prior))
          }
          expect(readFileSync(saved,'utf8')).toBe(raw)
          console.log(JSON.stringify({subcase:'A09',file_case:damage,positive:['clean-reopen','cold-journal'].includes(damage),provider_posts:0,task_invocations:0}))
        }
        for(const mode of ['missing-nofollow','wrong-uid','inode-drift']){
          const sub=`${directory}/file-${mode}`;mkdirSync(sub,{mode:0o700})
          writeFileSync(`${sub}/${id}.lock`,JSON.stringify(prior),{mode:0o600});writeFileSync(`${sub}/${id}.json`,raw,{mode:0o600})
          const path=`${sub}/input.json`;writeFileSync(path,JSON.stringify({...base,directory:sub,fixture_uid:process.getuid!()}),{mode:0o600})
          const child=launch(mode,mode,path);await end(child)
          const err=await wait(`${sub}/${mode}-error.json`)
          expect(err.code).toBe(mode==='wrong-uid'?'ADMISSION_RECEIPT_DIRECTORY_INVALID':'ADMISSION_RECOVERY_MUTEX_INVALID')
          expect(readFileSync(`${sub}/${id}.lock`,'utf8')).toBe(JSON.stringify(prior));expect(readFileSync(`${sub}/${id}.json`,'utf8')).toBe(raw)
          console.log(JSON.stringify({subcase:'A09',file_case:mode,fixture_api_fault:true,owner_receipt_delta:0}))
        }
        expect(await dbSnapshot()).toBe(dbBefore)
        console.log(JSON.stringify({subcase:'A09',pre_recovery_db_delta:0,provider_posts:0,task_invocations:0}))
        // Real recovery B has read the old receipt; A persists and releases;
        // B's later O_EXCL cannot admit the stale receipt/token overwrite.
        for(const order of ['AB','BA']){
          const currentRaw=readFileSync(receiptPath,'utf8'),token=`a09-race-${order}`
          const currentRequest={...request,receipt_sha256:admissionSha256(currentRaw),recovery_token:token}
          const currentApproval=JSON.stringify({...currentRequest,decision:'APPROVED',action:'persist-receipt',expires_at:new Date(Date.now()+60000).toISOString()})
          const currentRecovery={...currentRequest,authority_url:approvalRef.url,authority_sha256:admissionSha256(currentApproval)}
          bodies.set(approvalRef.url,currentApproval)
          const currentState=(await admissionStatus(f.control,f.config.policy_id))!
          const path=`${directory}/stale-${order}.json`
          writeFileSync(path,JSON.stringify({...base,recovery:currentRecovery,state:currentState,bodies:[...bodies]}),{mode:0o600})
          const tag=`stale-${order}`,stale=launch('recover',tag,path);await wait(marker(tag,'before-lock'))
          const input={db:f.control,state:currentState,deliveryId:id,receiptPath,recovery:currentRecovery,readBody:async(ref:any)=>bodies.get(ref.url)!,dryRun:false}
          const result=await recoverBoundedReceipt(input)
          expect(result).toMatchObject({status:'SENT',provider_post_delta:0,task_invocation_delta:0})
          const winner=readFileSync(receiptPath,'utf8');go(tag,'before-lock');await end(stale)
          expect((await wait(marker(tag,'error'))).code).toBe('ADMISSION_RECEIPT_BINDING_MISMATCH')
          expect(readFileSync(receiptPath,'utf8')).toBe(winner)
          await expect(recoverBoundedReceipt(input)).rejects.toThrow('ADMISSION_RECEIPT_BINDING_MISMATCH')
          console.log(JSON.stringify({subcase:'A09',schedule:'completed-before-stale-O_EXCL',order,receipt_preserved:true,token_replay_writes:0}))
        }
      }else{
        const crashed=launch(cut);await end(crashed,23)
        const journal=await wait(marker(cut,'journal'))
        expect(Object.keys(journal.files).some(path=>path.endsWith('-journal'))).toBe(true)
        expect(journal.bun).toBe(Bun.version);expect(journal.sqlite).toMatch(/^3\./)
        expect(readFileSync(receiptPath,'utf8')).toBe(raw)
        expect(existsSync(lockPath)).toBe(cut==='acquired')
        const before=readdirSync(directory).filter(x=>x.startsWith(`${id}.reap.sqlite`)).map(name=>{
          const path=`${directory}/${name}`,st=lstatSync(path);return{path,dev:st.dev,ino:st.ino,mode:st.mode&0o777,uid:st.uid,size:st.size,sha256:admissionSha256(readFileSync(path))}
        })
        const input={db:f.control,state,deliveryId:id,receiptPath,recovery,readBody:async(ref:any)=>bodies.get(ref.url)!,dryRun:false}
        expect(await recoverBoundedReceipt(input)).toMatchObject({status:'SENT',persistence_writes:2,provider_post_delta:0,task_invocation_delta:0})
        expect(lstatSync(`${directory}/${id}.reap.sqlite`).ino).toBe(before.find(x=>x.path.endsWith('.sqlite'))!.ino)
        expect(JSON.parse(readFileSync(receiptPath,'utf8')).persistence.recovery_tokens).toEqual(['a09-recovery'])
        await expect(recoverBoundedReceipt(input)).rejects.toThrow('ADMISSION_RECEIPT_BINDING_MISMATCH')
        console.log(JSON.stringify({subcase:'A09',cut,actual_child_exit:23,bun:journal.bun,sqlite:journal.sqlite,platform:process.platform,
          engine_journal_observed:true,files_before_reopen:before,actual_recovery_writes:2,provider_posts:0,task_invocations:0}))
      }
    }finally{
      for(const child of children)if(child.exitCode===null){child.kill();await child.exited}
    }
  })
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

export async function withA09Fixtures(main: Array<() => Promise<void>>): Promise<void> {
  const a09=['acquired','unlinked','closed','races'].map(cut=>()=>ownerRecoveryFixture(cut as any))
  await settleIndependentFixtureWork([...a09,...main],6)
}


// I17: workers reconstruct complete cases from this file. Their budget is a
// strict remainder of the one parent F06 deadline; this is not a new case cap.
const f06WorkerCase=process.env.AUN_F06_WORKER_CASE
const f06WorkerDeadline=Number(process.env.AUN_F06_WORKER_DEADLINE)
const f06SourceFiles=['tests/contract/test_queue_bounded_retry.test.ts','tests/contract/test_queue_bounded_admission.test.ts','tests/contract/test_queue_bounded_admission_postgres.test.ts']
function f06SourceBinding():string {
  return admissionSha256(JSON.stringify(f06SourceFiles.map(path=>[path,admissionSha256(readFileSync(`${candidateRoot}/${path}`,'utf8'))])))
}
const f06WorkerKeys=['AUN_F06_WORKER_CASE','AUN_F06_WORKER_DEPTH','AUN_F06_WORKER_DEADLINE','AUN_F06_WORKER_SOURCE']
const f06WorkerInputs=f06WorkerKeys.filter(key=>process.env[key]!==undefined)
if(f06WorkerInputs.length && (f06WorkerInputs.length!==4||!f06WorkerCase||process.env.AUN_F06_WORKER_DEPTH!=='1'||!Number.isSafeInteger(f06WorkerDeadline)
  ||f06WorkerDeadline<=Date.now()||f06WorkerDeadline>Date.now()+30000
  ||process.env.AUN_F06_WORKER_SOURCE!==f06SourceBinding()))throw new Error('F06_WORKER_INPUT_DENIED')
const f06WorkerTimeout=f06WorkerCase?Math.max(1,Math.min(30000,f06WorkerDeadline-Date.now())):30000
const f06MainNames=[
  ...['before_commit','response_lost','reserved_crash'].map(x=>`finalizer:${x}`),
  ...['before_reservation','after_reservation','before_INTENT','after_INTENT','after_RETRYABLE','after_ACK','after_stage1','before_stage2','after_stage2'].map(x=>`DR07:${x}`),
  'DR01', 'DR02','DR03','DR04','DR05',
  ...['sent_before','sent_commit_response_lost','backfill_before','backfill_commit_response_lost','budget_cap','db_unavailable'].map(x=>`DR06:${x}`),
  'DR08',...['long_retry_after','nonce_horizon','policy_expiry','original_max1'].map(x=>`horizon:${x}`),
  ...['corrupt','permissions','symlink'].map(x=>`damage:${x}`),'DR11',
]
type F06Case={id:string;run:()=>Promise<void>;callback_sha256:string}
async function runF06Worker(entry:F06Case,deadline:number,root:string,source:string):Promise<void> {
  const remaining=deadline-Date.now();if(remaining<=0)throw new Error(`F06_PARENT_DEADLINE:${entry.id}`)
  const prefix=`${root}/${entry.id.replace(/[^a-zA-Z0-9_-]/g,'_')}`
  const argv=[process.execPath,'--no-env-file','test',f06SourceFiles[0],'--test-name-pattern','^BA-CORE-F06$',
    '--timeout',String(remaining),'--reporter=junit',`--reporter-outfile=${prefix}.xml`]
  const child=Bun.spawn(argv,{cwd:candidateRoot,env:{...process.env,AUN_F06_WORKER_CASE:entry.id,AUN_F06_WORKER_DEPTH:'1',
    AUN_F06_WORKER_DEADLINE:String(deadline),AUN_F06_WORKER_SOURCE:source},stdout:'pipe',stderr:'pipe'})
  fixtureEvent(entry.id,'case-worker-spawn',{pid:child.pid,deadline,remaining,callback_sha256:entry.callback_sha256,source_sha256:source})
  // Start both drains at spawn, keep genuine exit and EOF/rejection separately.
  const out=new Response(child.stdout).text().then(text=>{writeFileSync(`${prefix}.stdout.log`,text);fixtureEvent(entry.id,'case-worker-stdout-eof',{pid:child.pid});return text})
  const err=new Response(child.stderr).text().then(text=>{writeFileSync(`${prefix}.stderr.log`,text);fixtureEvent(entry.id,'case-worker-stderr-eof',{pid:child.pid});return text})
  const exited=child.exited.then(code=>{fixtureEvent(entry.id,'case-worker-exit',{pid:child.pid,code,signal:child.signalCode});return code})
  const settled=await Promise.allSettled([exited,out,err])
  const failed=settled.filter(x=>x.status==='rejected') as PromiseRejectedResult[]
  if(failed.length)throw new AggregateError(failed.map(x=>x.reason),`F06_WORKER_LIFECYCLE:${entry.id}`)
  const code=(settled[0] as PromiseFulfilledResult<number>).value
  const stdout=(settled[1] as PromiseFulfilledResult<string>).value
  const stderr=(settled[2] as PromiseFulfilledResult<string>).value
  const phaseLines=stdout.split('\n').filter(line=>line.startsWith('BA_FIXTURE_PHASES '))
  const phaseDiagnostics=phaseLines.slice(0,8).map(line=>JSON.parse(line.slice('BA_FIXTURE_PHASES '.length)))
  fixtureEvent(entry.id,'case-worker-diagnostics',{pid:child.pid,source_sha256:source,callback_sha256:entry.callback_sha256,
    fixture_count:phaseLines.length,truncated:phaseLines.length>8,fixtures:phaseDiagnostics})
  if(code!==0||child.signalCode)throw new Error(`F06_WORKER_EXIT:${entry.id}:${code}:${child.signalCode}:${sanitizeFixtureError(stderr.slice(-4000))}`)
  const xml=readFileSync(`${prefix}.xml`,'utf8')
  const cases=[...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)]
  const selected=cases.filter(m=>/\bname="BA-CORE-F06"/.test(m[1])&&!/<skipped\b/.test(m[2]??''))
  const assertions=selected.length===1?Number(selected[0][1].match(/\bassertions="(\d+)"/)?.[1]):0
  if(selected.length!==1||!Number.isInteger(assertions)||assertions<1||/<(?:failure|error)\b/.test(xml)
    ||cases.some(m=>!selected.includes(m)&&!/<skipped\b/.test(m[2]??'')))throw new Error(`F06_WORKER_JUNIT_DENIED:${entry.id}`)
  const markers=stdout.split('\n').filter(line=>line.startsWith('F06_CASE_COMPLETE ')).map(line=>JSON.parse(line.slice(18)))
  if(markers.length!==1||markers[0].id!==entry.id||markers[0].source_sha256!==source
    ||markers[0].callback_sha256!==entry.callback_sha256||markers[0].depth!==1)throw new Error(`F06_WORKER_COMPLETION_DENIED:${entry.id}`)
  fixtureEvent(entry.id,'case-worker-accepted',{pid:child.pid,selected_tests:1,assertions,
    junit_sha256:admissionSha256(xml),stdout_sha256:admissionSha256(stdout),stderr_sha256:admissionSha256(stderr),...markers[0]})
}

boundedTest('BA-CORE-F06',async()=>{
  const deadline=f06WorkerCase?f06WorkerDeadline:Date.now()+30000
  const source=f06SourceBinding()
  fixtureEvent('F06','start',{pid:process.pid})
  const independent: F06Case[]=[]
  const exclusive: F06Case[]=[]
  const queueFixture=(run:Parameters<typeof fixture>[0])=>{const id=f06MainNames[independent.length];if(!id)throw new Error('F06_REGISTRY_OVERFLOW');independent.push({id,run:()=>fixture(run),callback_sha256:admissionSha256(run.toString())})}
  const queueExclusiveFixture=(run:Parameters<typeof fixture>[0])=>{exclusive.push({id:'DR10:exclusive',run:()=>fixture(run),callback_sha256:admissionSha256(run.toString())})}
  // Register owned callbacks before starting the shared six-slot pool.
  for(const failure of ['before_commit','response_lost','reserved_crash']) {
    queueFixture(async f=>{
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
  for(const crash of ['before_reservation','after_reservation','before_INTENT','after_INTENT','after_RETRYABLE','after_ACK','after_stage1','before_stage2','after_stage2'])queueFixture(async f=>{
    const policyBody='fixture policy authority, not a live owner decision'
    f.config.authority={url:'https://github.com/fixture/repo/issues/1#issuecomment-1',sha256:admissionSha256(policyBody)}
    const {row,binding}=await readyReply(f)
    const childPath=`${f.config.transport.receipt_dir}/crash-child.ts`
    const childInput=`${f.config.transport.receipt_dir}/crash-input.json`
    const runtimeUrl=new URL(f.roleUrls.runtime)
    writeFileSync(childInput,JSON.stringify({row,binding,crash,url:runtimeUrl.href,directory:f.config.transport.receipt_dir}),{mode:0o600})
    writeFileSync(childPath,`
import { Client } from '${candidateRoot}/node_modules/pg/lib/index.js'
import { appendFileSync,readFileSync,writeFileSync } from 'node:fs'
import { deliverBoundedOutbound,BoundedReceiptStore } from '${candidateRoot}/core/queue-admission.ts'
import { postBoundedDiscordRequest } from '${candidateRoot}/adapters/discord.ts'
const input=JSON.parse(readFileSync(process.argv[2],'utf8'));const client=new Client({connectionString:input.url,connectionTimeoutMillis:1000});await client.connect()
let action='';let wires=0;let now=Date.now();let mono=0
const childStage=(phase,detail={})=>appendFileSync(input.directory+'/crash-stages.jsonl',JSON.stringify({at:Date.now(),pid:process.pid,phase,crash:input.crash,...detail})+'\\n',{mode:0o600})
const stop=()=>{childStage('exit-request',{code:23});process.exit(23)}
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
 childStage('write-entry',{state:r.state})
 if(r.state==='INTENT'&&input.crash==='before_INTENT')stop()
 save.call(this,r)
 childStage('write-return',{state:r.state})
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
    fixtureEvent('DR07','spawn',{crash,pid:child.pid})
    const stdoutDone=new Response(child.stdout).text().then(value=>{fixtureEvent('DR07','stdout-eof',{crash,pid:child.pid,bytes:Buffer.byteLength(value)});return value},error=>{fixtureEvent('DR07','stdout-rejected',{crash,pid:child.pid,message:sanitizeFixtureError(error instanceof Error?error.message:error)});throw error})
    const stderrDone=new Response(child.stderr).text().then(value=>{fixtureEvent('DR07','stderr-eof',{crash,pid:child.pid,bytes:Buffer.byteLength(value)});return value},error=>{fixtureEvent('DR07','stderr-rejected',{crash,pid:child.pid,message:sanitizeFixtureError(error instanceof Error?error.message:error)});throw error})
    const exited=child.exited.then(value=>{fixtureEvent('DR07','parent-exited',{crash,pid:child.pid,exit:value});return value},error=>{fixtureEvent('DR07','parent-exit-rejected',{crash,pid:child.pid,message:sanitizeFixtureError(error instanceof Error?error.message:error)});throw error})
    const [childExit,childStdout,childStderr]=await Promise.allSettled([exited,stdoutDone,stderrDone] as const)
    const childErrors: unknown[]=[childExit,childStdout,childStderr].flatMap(r=>r.status==='rejected'?[r.reason]:[])
    if(childStdout.status==='fulfilled')writeFileSync(`${f.config.transport.receipt_dir}/crash-stdout.log`,childStdout.value,{mode:0o600})
    if(childStderr.status==='fulfilled')writeFileSync(`${f.config.transport.receipt_dir}/crash-stderr.log`,childStderr.value,{mode:0o600})
    if(childErrors.length===1)throw childErrors[0]
    if(childErrors.length>1)throw new AggregateError(childErrors,'BA_CRASH_CHILD_FAILED')
    const exit=childExit.status==='fulfilled'?childExit.value:null
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
  queueFixture(async f=>{
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
  ]) queueFixture(async f=>{
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
        // SQL records its real deadline after fixture wall time was sampled.
        // Synchronize both fixture clocks with that actual durable deadline.
        const persisted=JSON.parse(readFileSync(`${f.config.transport.receipt_dir}/out-${row.id}.json`,'utf8'))
        if(persisted.state!=='RETRYABLE'||typeof persisted.next_not_before!=='number'
          ||!Number.isFinite(persisted.next_not_before))throw new Error('I11_INVALID_PERSISTED_RETRY_DEADLINE')
        const previousWall=now,previousMono=mono
        const nextWall=Math.max(now+spec.waits[i],persisted.next_not_before)
        const delta=nextWall-now
        now=nextWall;mono+=delta
        console.log(JSON.stringify({subcase:'I11-RETRY-CLOCK',id:spec.id,step:i,previousWall,previousMono,
          requiredWait:spec.waits[i],persistedDeadline:persisted.next_not_before,now,mono,delta}))
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
    queueFixture(async f=>{
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
  queueFixture(async f=>{
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
  if(!f06WorkerCase){
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
  }
  for(const mode of ['long_retry_after','nonce_horizon','policy_expiry','original_max1'])queueFixture(async f=>{
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
  if(!f06WorkerCase)console.log(JSON.stringify({subcase:'DR09',fractional_round_up:true,malformed_rejected:9,clock_rollback_wire:0,fixture_only:true}))
  for(const damage of ['corrupt','permissions','symlink'])queueFixture(async f=>{
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
  queueExclusiveFixture(async f=>{
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
  queueFixture(async f=>{
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
  if(!f06WorkerCase){
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
  }
  if(independent.length!==32||exclusive.length!==1||new Set(f06MainNames).size!==32)throw new Error('F06_REGISTRY_INCOMPLETE')
  const a09: F06Case[]=['acquired','unlinked','closed','races'].map(cut=>({id:`A09:${cut}`,
    run:()=>ownerRecoveryFixture(cut as any),callback_sha256:admissionSha256(ownerRecoveryFixture.toString())}))
  const registry=[...a09,...independent,...exclusive]
  if(f06WorkerCase){
    const selected=registry.filter(entry=>entry.id===f06WorkerCase)
    if(selected.length!==1)throw new Error('F06_CASE_SELECTOR_DENIED')
    await selected[0].run()
    console.log('F06_CASE_COMPLETE '+JSON.stringify({id:selected[0].id,source_sha256:source,
      callback_sha256:selected[0].callback_sha256,depth:1}))
  }else{
    const root=`${process.env.AUN_BOUNDED_FIXTURE_ROOT}/f06-workers-${process.pid}-${Date.now()}`;mkdirSync(root,{recursive:true,mode:0o700})
    writeFileSync(`${root}/registry.json`,JSON.stringify({source_sha256:source,deadline,cases:registry.map(({id,callback_sha256})=>({id,callback_sha256}))},null,2)+'\n')
    fixtureEvent('F06','case-registry',{root,source_sha256:source,deadline,cases:registry.map(({id,callback_sha256})=>({id,callback_sha256}))})
    const parallel=settleIndependentFixtureWork([...a09,...independent].map(entry=>()=>runF06Worker(entry,deadline,root,source)),6)
    await settleFixtureWork(async()=>{
      await Promise.allSettled([parallel])
      await settleIndependentFixtureWork(exclusive.map(entry=>()=>runF06Worker(entry,deadline,root,source)))
    },[parallel])
  }
  fixtureEvent('F06','end',{pid:process.pid,worker_case:f06WorkerCase??null})
},f06WorkerTimeout)
