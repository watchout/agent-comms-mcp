import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createPostgresTestDatabase, derivePostgresTestDatabaseUrls } from '../helpers/postgres-test-database'
import { admissionStatus, admissionTransition, tryBoundedClaim, readAdmissionBinding, admissionBindingFromEnv, deliverBoundedOutbound, type BoundedDiscordRequest } from '../../core/queue-admission'
import { postBoundedDiscordRequest } from '../../adapters/discord'
import { runReceivedQueueWork, finalizeDoneQueueWork } from '../../core/queue-work'
import { receiveTargeted } from '../../bin/aun/receive'

export const stage = process.env.AUN_BOUNDED_TEST_STAGE
if (!['local17', 'private', 'ci'].includes(stage ?? '')) throw new Error('BA_STAGE_REQUIRED')
export const candidateRoot = resolve(import.meta.dir, '../..')

export async function verifyFixtureEndpoint(endpoint:string,major:16|17):Promise<void>{
  const u=new URL(endpoint),socket=u.searchParams.get('host')
  if(!['postgres:','postgresql:'].includes(u.protocol)||!u.pathname.endsWith('_test'))throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  if(socket){
    if(major!==17||socket!==resolve(process.env.AUN_BOUNDED_FIXTURE_ROOT??'','socket')
      ||!socket.startsWith('/private/tmp/aun-bounded-fixture.')||u.searchParams.get('port')!=='55437'||u.username!=='fixture')throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  }else if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==String(major===17?5433:5432)||u.username!=='postgres'
    ||stage!=='ci')throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  const check=new Client({connectionString:derivePostgresTestDatabaseUrls('bounded_probe_test',{AGENT_COM_TEST_DATABASE_URL:endpoint}).maintenanceUrl})
  try{
    await check.connect()
    const r=(await check.query("SELECT current_database() db,current_user AS actor,current_setting('server_version_num')::int version,current_setting('unix_socket_directories') socket,inet_server_port() port")).rows[0]
    expect(r.db).toBe('postgres');expect(r.actor).toBe(u.username)
    expect(r.version).toBeGreaterThanOrEqual(major*10000);expect(r.version).toBeLessThan((major+1)*10000)
    if(socket)expect(r.socket).toBe(socket);else expect(r.port).toBe(5432)
  }finally{await check.end().catch(()=>{})}
}

export async function seedNormalTransport(admin: Client): Promise<void> {
  await admin.query("INSERT INTO channels(id,name,members) VALUES('fixture-channel','bounded fixture',ARRAY['qa','codex-cto','different-consumer']) ON CONFLICT(id) DO NOTHING")
  await admin.query("INSERT INTO agents(agent_id,display_name,agent_type,status,runtime) VALUES('qa','QA','dev','idle','TUI'),('codex-cto','CTO','dev','idle','TUI'),('different-consumer','Projection fixture','dev','idle','TUI') ON CONFLICT(agent_id) DO NOTHING")
  await admin.query("INSERT INTO channel_adapters(channel_id,platform,external_id,metadata) VALUES('fixture-channel','discord','999999999999999999','{\"adapter_owner_agent_id\":\"different-consumer\"}')")
  const connector=(await admin.query("INSERT INTO connector_instances(agent_id,status) VALUES('different-consumer','active') RETURNING connector_instance_id")).rows[0].connector_instance_id
  await admin.query("INSERT INTO connector_credentials(agent_id,connector_instance_id,secret_ref,status) VALUES('different-consumer',$1,'fixture:never-resolve','active')",[connector])
  await admin.query("INSERT INTO channel_connector_bindings(channel_id,connector_instance_id) VALUES('fixture-channel',$1)",[connector])
  await admin.query("INSERT INTO provider_channel_access(provider_channel_id,connector_instance_id,agent_id,capabilities) VALUES('999999999999999999',$1,'different-consumer','{\"message_create\":true}')",[connector])
}

/** Every connection inherits an explicitly supplied isolated versioned endpoint. */
export async function fixture(run: (f: { admin: Client; control: Client; other: Client; executor: Client; runtime: Client; config: any; env: NodeJS.ProcessEnv; prepare: () => Promise<any> }) => Promise<void>) {
  const endpoint = process.env.AGENT_COM_BOUNDED_PG17_TEST_DATABASE_URL
  if (!endpoint) throw new Error('BA_PG17_ENDPOINT_REQUIRED')
  await verifyFixtureEndpoint(endpoint,17)
  const u = new URL(endpoint)
  if (!u.pathname.endsWith('_test') || (!u.searchParams.get('host') && !['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  const name = `ba_${randomUUID().replaceAll('-', '').slice(0, 14)}_test`
  const target = createPostgresTestDatabase(name, { AGENT_COM_TEST_DATABASE_URL: endpoint })
  const admin = new Client({ connectionString: target.databaseUrl })
  const clients: Client[] = []
  try {
    await admin.connect()
    const identity = (await admin.query("SELECT current_database() AS db,current_setting('server_version_num')::integer AS version")).rows[0]
    expect(identity.db).toBe(name); expect(identity.version).toBeGreaterThanOrEqual(170000); expect(identity.version).toBeLessThan(180000)
    const migrated = Bun.spawnSync(['bun', 'run', 'db/migrate.ts'], { cwd: candidateRoot, env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: target.databaseUrl, AGENT_COM_TEST_DATABASE_URL: target.databaseUrl, AGENT_COM_TEST_DATABASE_NAME: name }, stdout: 'pipe', stderr: 'pipe' })
    if (migrated.exitCode !== 0) throw new Error(`BA_MIGRATION_FAILED ${migrated.stderr.toString()}`)
    await admin.query(readFileSync(resolve(candidateRoot, 'db/migrations/2026-09-08-queue-bounded-admission.up.sql'), 'utf8'))
    const roles = { controller: `${name}_c`, executor: `${name}_e`, runtime: `${name}_r` }
    for (const [kind, role] of Object.entries(roles)) {
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS`)
      await admin.query(`GRANT aun_admission_${kind === 'controller' ? 'control' : kind} TO "${role}"`)
      // Representative old application transport rights, never owner/ledger
      // rights. The guard must enforce even with these legacy UPDATE grants.
      const transport = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'queue_admission_%'")).rows
      for (const { tablename } of transport) await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."${tablename}" TO "${role}"`)
      await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
    }
    const controlUrl = new URL(target.databaseUrl); controlUrl.username = roles.controller
    const control = new Client({ connectionString: controlUrl.href }); const other = new Client({ connectionString: target.databaseUrl })
    clients.push(control, other); await control.connect(); await other.connect()
    const executorUrl = new URL(target.databaseUrl); executorUrl.username = roles.executor
    const runtimeUrl = new URL(target.databaseUrl); runtimeUrl.username = roles.runtime
    const executor = new Client({ connectionString: executorUrl.href }); const runtime = new Client({ connectionString: runtimeUrl.href })
    clients.push(executor, runtime); await executor.connect(); await runtime.connect()
    control.on('error', () => {})
    const config = { policy_id: `policy_${name}`, agent_id: 'qa', max_tasks: 2, max_inflight: 1, invocation_max_attempts: 1, finalizer_max_attempts: 1,
      transport: { original_max_posts:1,reply_max_posts:3,waits_ms:[10000,30000],post_timeout_ms:10000,transport_horizon_ms:120000,
        persistence_max_writes:5,persistence_window_ms:20000,host:hostname(),receipt_dir:resolve(process.env.AUN_BOUNDED_FIXTURE_ROOT??'',name) },
      roles, expires_at: new Date(Date.now() + 3600000).toISOString(), source_sha: '0f772883db6f3b50772d3e4b82ce47795091f0a9', cohort_digest: '1'.repeat(64),
      runtime_id: 'fixture-runtime', worker_timeout_seconds: 30, maker: 'fixture-maker', checker: 'fixture-checker',
      guard_digest:(await control.query('SELECT public.aun_admission_capability() AS value')).rows[0].value.guard_digest,
      task_definitions: [1, 2].map(n => ({ ref: `fixture:task${n}`, sender: 'codex-cto', channel_id: 'fixture-channel' })) }
    if (!process.env.AUN_BOUNDED_FIXTURE_ROOT) throw new Error('BA_FIXTURE_ROOT_REQUIRED')
    mkdirSync(config.transport.receipt_dir,{mode:0o700})
    const prepare = async () => {
      await control.query("SET transaction_timeout='1s'"); await control.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      try { await control.query('SELECT public.aun_admission_prepare_lock()'); const res = await control.query('SELECT public.aun_admission_prepare($1::jsonb) AS state', [JSON.stringify(config)]); await control.query('COMMIT'); return res.rows[0].state }
      catch (error) { await control.query('ROLLBACK').catch(() => {}); throw error }
    }
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AGENT_COM_DB: 'postgres',
      DATABASE_URL: executorUrl.href, AGENT_COM_TEST_DATABASE_URL: executorUrl.href, AGENT_COM_TEST_DATABASE_NAME: name,
      AGENT_ID: 'qa', AGENT_COM_EXPECTED_AGENT_ID: 'qa', AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COM_CONVERSATION_CONTROL_PLANE: 'off', AUN_RECEIVE_CLAIM_SOURCE: 'bounded-admission',
      AUN_QUEUE_WORK_EXPECTED_CLAIM_SOURCE: 'bounded-admission', AUN_QUEUE_WORK_INVOCATION_SOURCE: 'bounded-admission',
      AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID: config.runtime_id,
    }
    await run({ admin, control, other, executor, runtime, config, env, prepare })
  } finally {
    for (const client of clients) await client.end().catch(() => {})
    await admin.end().catch(() => {}); target.drop()
  }
}

export const ALL_BOUNDED_CASES = Object.freeze([
  ...Array.from({length:11},(_,i)=>`BA-CORE-F${String(i+1).padStart(2,'0')}`),
  'BA-17-F12-A','BA-17-F12-B','BA-17-F12-C','BA-17-F13-A','BA-17-F13-B','BA-17-F13-C',
  'BA-16-MIGRATION','BA-16-UNSUPPORTED','BA-16-DEFAULT-CLAIM','BA-16-DEFAULT-RETRY',
])
export function boundedCaseIds(selectedStage: string): readonly string[] {
  if (!['local17','private','ci'].includes(selectedStage)) throw new Error('BA_STAGE_REQUIRED')
  return ALL_BOUNDED_CASES.filter(id => selectedStage==='private' ? ['BA-CORE-F08','BA-CORE-F10'].includes(id)
    : !['BA-CORE-F08','BA-CORE-F10'].includes(id) && (selectedStage==='ci' || !id.startsWith('BA-16-')))
}
export function boundedTest(id: string, run: () => Promise<void> | void): void {
  if (!ALL_BOUNDED_CASES.includes(id)) throw new Error('BA_UNKNOWN_CASE')
  if (boundedCaseIds(stage!).includes(id)) test(id,run,30000)
}

export type BoundedFixture = Parameters<Parameters<typeof fixture>[0]>[0]
export const fixtureSha = (s: string) => createHash('sha256').update(s).digest('hex')
export function normalCli(f: BoundedFixture,args: string[],actor='codex-cto'): any {
  const raw=execFileSync(process.execPath,['cli/index.ts',...args],{cwd:candidateRoot,timeout:5000,maxBuffer:1024*1024,
    env:{...f.env,AGENT_ID:actor,AGENT_COM_EXPECTED_AGENT_ID:actor},encoding:'utf8'})
  return JSON.parse(raw)
}
export async function enrollNormalTask(f: BoundedFixture,ordinal: 1|2,content='Inspect existing compatibility and return a concrete finding.') {
  const sent=normalCli(f,['notify','--channel-id','fixture-channel','--mentions','qa','--message-type','instruction','--content',content])
  expect(sent.ok).toBe(true);expect(sent.outbound_queued).toBe(true)
  const q=(await f.admin.query('SELECT * FROM message_queue WHERE agent_id=$1 AND message_id=$2',['qa',sent.message_id])).rows[0]
  const m=(await f.admin.query('SELECT * FROM agent_messages WHERE id=$1',[sent.message_id])).rows[0]
  const state=(await admissionStatus(f.control,f.config.policy_id))!
  const previous=(state.tasks.find(t=>t.ordinal===1) as any)?.acceptance?.evidence_sha256
  const next=await admissionTransition(f.control,state,'enroll',{ordinal,message_id:sent.message_id,definition_ref:`fixture:task${ordinal}`,
    content_sha256:fixtureSha(m.content),payload_sha256:fixtureSha(q.payload),normal_return_ref:'fixture:actual-cli-stdout',
    authority_url:'fixture:owner',authority_sha256:'2'.repeat(64),...(ordinal===2?{predecessor_evidence_sha256:previous}:{})})
  Object.assign(f.env,{AUN_ADMISSION_POLICY_ID:f.config.policy_id,AUN_ADMISSION_CONFIG_DIGEST:next.policy.config_digest,
    AUN_ADMISSION_SOURCE_SHA:f.config.source_sha,AUN_ADMISSION_COHORT_DIGEST:f.config.cohort_digest,AUN_ADMISSION_RUNTIME_ID:f.config.runtime_id,
    AUN_QUEUE_WORK_EXPECTED_RUNTIME_ID:f.config.runtime_id})
  return {sent,q,state:next}
}
export async function startNormalTask(f: BoundedFixture) {
  await seedNormalTransport(f.admin);await f.prepare()
  const enrolled=await enrollNormalTask(f,1)
  await admissionTransition(f.control,enrolled.state,'enable',{})
  await tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env,queueId:String(enrolled.q.id)})
  return enrolled.q
}
export function fixtureResult() {
  return {schema_version:'queue_work_result_v1' as const,ok:true,summary:'A checked negative finding is a valid inspection.',next_action:'reply' as const,
    reply:'Compatibility issue identified from the existing source; no changes made.',evidence:['fixture:inspection-output']}
}
export function fixtureDb(f: BoundedFixture) { return {dialect:'postgres' as const,query:f.executor.query.bind(f.executor)} }
export function hostReplySender(f: BoundedFixture) { return {queue_close_mode:'sender' as const,sendReply:async (input: any)=>{
  const sent=normalCli(f,['send','--content',input.content,'--mentions',input.mention,'--queue-id',input.queue_id,'--message-id',input.message_id,'--queue-work-finalizer','--close'],'qa')
  return {message_id:sent.message_id,queue_closed:sent.work_closed===true}
}} }

/** Actual guarded SQL + pinned SDK, with only the final HTTP wire replaced. */
export async function deliverFixtureProjection(f: BoundedFixture,row: any,onWire:()=>void=()=>{}) {
  const binding=admissionBindingFromEnv(f.env)!
  let now=Date.now(),mono=0,wires=0
  const adapter={prepareBoundedRequest:async(r:any):Promise<BoundedDiscordRequest>=>({delivery_id:`out-${r.id}`,channel_id:r.channel_external_id,
    author_id:'111111111111111111',body:{content:r.content,nonce:`out-${r.id}`,enforce_nonce:true,allowed_mentions:{parse:['users','roles'],replied_user:false}}}),
    sendBoundedRequest:(r:BoundedDiscordRequest,permit:any)=>postBoundedDiscordRequest(r,permit,'fixture-never-network',async()=>{
      wires++;onWire();return new Response(JSON.stringify({id:`${800000000000000000n+BigInt(row.id)}`,channel_id:r.channel_id,author:{id:r.author_id},nonce:r.delivery_id,content:r.body.content}),
        {status:200,headers:{'content-type':'application/json'}})
    })}
  const clock={now:()=>now,monotonic:()=>mono}
  const first=await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
  expect(first.observed_wire_calls).toBe(1)
  now+=1000;mono+=1000
  const second=await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})
  expect(second.status).toBe('SENT');expect(wires).toBe(1)
  now+=2000;mono+=2000
  expect((await deliverBoundedOutbound({db:f.runtime,row,binding,adapter,clock})).status).toBe('SENT')
  expect(wires).toBe(1)
  return (await f.runtime.query('SELECT * FROM outbound_queue WHERE id=$1',[row.id])).rows[0]
}

boundedTest('BA-CORE-F02', async () => {
  await fixture(async ({admin,control,executor,runtime,config,env,prepare}) => {
    await prepare()
    const state=(await admissionStatus(control,config.policy_id))!
    const pins={ AUN_ADMISSION_POLICY_ID:config.policy_id,AUN_ADMISSION_CONFIG_DIGEST:state.policy.config_digest,
      AUN_ADMISSION_SOURCE_SHA:config.source_sha,AUN_ADMISSION_COHORT_DIGEST:config.cohort_digest,AUN_ADMISSION_RUNTIME_ID:config.runtime_id }
    Object.assign(env,pins)
    const binding=admissionBindingFromEnv(env)!
    expect((await readAdmissionBinding(executor,binding,'qa')).policy.status).toBe('PREPARED')
    for (const client of [runtime,executor]) {
      await expect(client.query("UPDATE queue_admission_policies SET status='ENABLED' WHERE policy_id=$1",[config.policy_id])).rejects.toThrow(/permission denied/)
      await expect(client.query("SELECT public.aun_admission_permit($1,'message_queue',NULL,'{}'::jsonb)",[config.policy_id])).rejects.toThrow(/permission denied/)
    }
    const q=(await admin.query("INSERT INTO message_queue(agent_id,message_id,payload) VALUES('qa',$1,'{}') RETURNING id",[randomUUID()])).rows[0]
    await runtime.query("SET aun.admission_permit='forged'")
    await expect(runtime.query("UPDATE message_queue SET status='received',claimed_by='qa' WHERE id=$1 RETURNING payload",[q.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
    await expect(tryBoundedClaim(executor,'qa',{dialect:'postgres',env:{...env,AUN_ADMISSION_SOURCE_SHA:'f'.repeat(40)}})).rejects.toThrow('ADMISSION_LOADED_CONFIG_MISMATCH')
    await expect(tryBoundedClaim(executor,'qa',{dialect:'postgres',env:{...env,AUN_ADMISSION_COHORT_DIGEST:'f'.repeat(64)}})).rejects.toThrow('ADMISSION_LOADED_CONFIG_MISMATCH')
    await expect(tryBoundedClaim({query:async()=>{throw new Error('must not connect')}},'qa',{dialect:'sqlite',env})).rejects.toThrow('ADMISSION_STORAGE_UNSUPPORTED')
    expect(()=>admissionBindingFromEnv({...env,STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION:'1'})).toThrow('ADMISSION_LOADED_CONFIG_INVALID')
    expect(()=>admissionBindingFromEnv({...env,AUN_ADMISSION_CONFIG_DIGEST:undefined})).toThrow('ADMISSION_LOADED_CONFIG_INVALID')
    const trigger=(await admin.query("SELECT tgname FROM pg_trigger WHERE tgrelid='message_queue'::regclass AND tgfoid='aun_admission_queue_guard()'::regprocedure")).rows[0].tgname
    await admin.query(`ALTER TABLE message_queue DISABLE TRIGGER "${trigger}"`)
    await expect(readAdmissionBinding(executor,binding,'qa')).rejects.toThrow('ADMISSION_GUARD_DRIFT')
    await admin.query(`ALTER TABLE message_queue ENABLE TRIGGER "${trigger}"`)
    const before=(await admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
    await admin.query("UPDATE queue_admission_policies SET config=config||'{\"max_tasks\":3}'::jsonb WHERE policy_id=$1",[config.policy_id]).then(
      ()=>{throw new Error('malformed policy accepted')},error=>expect(error.code).toBe('23514'))
    await admin.query("DROP FUNCTION public.aun_admission_capability()")
    await expect(readAdmissionBinding(executor,binding,'qa')).rejects.toThrow('ADMISSION_STORAGE_UNSUPPORTED')
    await expect(runtime.query("UPDATE message_queue SET status='received' WHERE id=$1",[q.id])).rejects.toThrow()
    expect((await admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row).toEqual(before)
  })
})

boundedTest('BA-CORE-F01',async()=>{
  await fixture(async f=>{
    await seedNormalTransport(f.admin)
    const historical=(await f.admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('qa','{\"content\":\"untouched old reminder\"}') RETURNING id")).rows[0]
    const nonqa=(await f.admin.query("INSERT INTO message_queue(agent_id,payload) VALUES('non-qa','{}') RETURNING id")).rows[0]
    await f.prepare()
    const before=(await f.admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[historical.id])).rows[0].row
    // The two legacy shapes (buffered exact ID and direct oldest pending)
    // exercise the database guard with ordinary application UPDATE grants.
    for(const sql of ["UPDATE message_queue SET status='received',claimed_by='qa' WHERE id=$1 RETURNING payload",
      "WITH next AS (SELECT id FROM message_queue WHERE id=$1 AND status='pending' FOR UPDATE SKIP LOCKED) UPDATE message_queue SET status='received',claimed_by='qa' WHERE id IN(SELECT id FROM next) RETURNING payload",
      "UPDATE message_queue SET read_at=clock_timestamp() WHERE id=$1",
      "UPDATE message_queue SET status='skipped' WHERE id=$1",
      "UPDATE message_queue SET status='done' WHERE id=$1"])
      await expect(f.executor.query(sql,[historical.id])).rejects.toThrow('ADMISSION_DIRECT_QUEUE_WRITE_DENIED')
    expect((await f.runtime.query("UPDATE message_queue SET status='received' WHERE id=$1 RETURNING status",[nonqa.id])).rows[0].status).toBe('received')
    const enrolled=await enrollNormalTask(f,1)
    await admissionTransition(f.control,enrolled.state,'enable',{})
    const dry=await receiveTargeted({agentId:'qa',queueId:String(enrolled.q.id),dryRun:true,env:f.env,cwd:candidateRoot})
    expect(dry.ok).toBe(true);expect(dry.summary?.claimed).toBeNull()
    const wrong=await receiveTargeted({agentId:'qa',queueId:String(historical.id),env:f.env,cwd:candidateRoot})
    expect(wrong.ok).toBe(false)
    // Execute the actual source prefix used before the MCP buffer/direct SQL.
    // Only startup/transport is omitted; real PG/common admission remains.
    const source=readFileSync(resolve(candidateRoot,'server.ts'),'utf8')
    const handler=source.slice(source.indexOf("if (name === 'next')"))
    const prefix=handler.slice(handler.indexOf('const bounded = await tryBoundedClaim'),handler.indexOf("await client.query('BEGIN')"))
    expect(prefix).toContain('if (bounded) return')
    expect(prefix).not.toContain('inboxBuffer')
    const script=`import {Client} from 'pg';import {tryBoundedClaim} from './core/queue-admission.ts';
const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();const agentId='qa';
const call=async()=>{${prefix}throw new Error('BA_UNEXPECTED_LEGACY_FALLTHROUGH')};
try{process.stdout.write(JSON.stringify(await call()))}finally{await client.end()}`
    const mcp=JSON.parse(execFileSync(process.execPath,['-e',script],{cwd:candidateRoot,env:f.env,timeout:5000,encoding:'utf8'}))
    expect(JSON.parse(mcp.content[0].text).queue_id).toBe(String(enrolled.q.id))
    const cli=Bun.spawnSync([process.execPath,'cli/index.ts','next'],{cwd:candidateRoot,env:f.env,stdout:'pipe',stderr:'pipe'})
    expect(cli.exitCode).not.toBe(0)
    expect(cli.stderr.toString()+cli.stdout.toString()).toContain('ADMISSION_CLAIM_DENIED')
    expect((await f.admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[historical.id])).rows[0].row).toEqual(before)
    const task=(await admissionStatus(f.executor,f.config.policy_id))!.tasks[0]
    expect(task.stage).toBe('ENROLLED');expect(task.claim_fence?.claimed_by).toBe('qa')
  })
})
