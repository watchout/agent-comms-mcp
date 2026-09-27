import { expect, test } from 'bun:test'
import { Client } from 'pg'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { derivePostgresTestDatabaseUrls } from '../helpers/postgres-test-database'
import { admissionStatus, admissionTransition, tryBoundedClaim, readAdmissionBinding, admissionBindingFromEnv, deliverBoundedOutbound, type BoundedDiscordRequest } from '../../core/queue-admission'
import { postBoundedDiscordRequest } from '../../adapters/discord'
import { runReceivedQueueWork, finalizeDoneQueueWork } from '../../core/queue-work'
import { receiveTargeted } from '../../bin/aun/receive'
import { lifecycleTransition } from '../../bin/aun/lifecycle'

export const stage = process.env.AUN_BOUNDED_TEST_STAGE
if (!['local17', 'private', 'ci'].includes(stage ?? '')) throw new Error('BA_STAGE_REQUIRED')
export const candidateRoot = resolve(import.meta.dir, '../..')

export const sanitizeFixtureError = (value: unknown) => String(value)
  .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi, '$1:[REDACTED]@')
  .replace(/(\bpassword=)[^\s]+/gi, '$1[REDACTED]')
export function fixtureEvent(name: string, phase: string, detail: Record<string, unknown> = {}) {
  console.log(JSON.stringify({fixture:name,phase,at:Date.now(),...detail}))
}
async function drainMigrationOutput(stream:ReadableStream<Uint8Array>,name:string,pid:number,channel:'stdout'|'stderr') {
  const directory=resolve(process.env.AUN_BOUNDED_FIXTURE_ROOT!,'migration-logs')
  mkdirSync(directory,{recursive:true,mode:0o700})
  const path=resolve(directory,`${name}.${channel}.log`)
  writeFileSync(path,'',{mode:0o600})
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let total=0,stored=0
  try {
    for(;;){const result=await reader.read();if(result.done)break
      chunks.push(result.value);total+=result.value.byteLength
      const keep=result.value.subarray(0,Math.max(0,16*1024*1024-stored))
      if(keep.byteLength){appendFileSync(path,keep);stored+=keep.byteLength}
    }
    fixtureEvent(name,`migration-${channel}-eof`,{pid,bytes:total,stored_bytes:stored,log_truncated:stored<total})
    return new TextDecoder().decode(Buffer.concat(chunks))
  }catch(error){fixtureEvent(name,`migration-${channel}-rejected`,{pid,message:sanitizeFixtureError(error instanceof Error?error.message:error)});throw error}
  finally{reader.releaseLock()}
}
export function fixtureClients(name: string) {
  const records: Array<{client:Client;connected:boolean;attempted:boolean;settled:boolean;closed:boolean}> = []
  const client = (url:string) => {
    const c = new Client({connectionString:url,connectionTimeoutMillis:1000})
    const record = {client:c,connected:false,attempted:false,settled:false,closed:false}
    records.push(record);fixtureEvent(name,'construct',{client:records.length})
    c.on('error', error=>fixtureEvent(name,'client-error',{code:(error as any).code??null,message:sanitizeFixtureError(error.message)}))
    c.on('end',()=>{record.closed=true;fixtureEvent(name,'client-end')})
    ;(c as any).connection.stream.on('close',()=>{record.closed=true;fixtureEvent(name,'client-close')})
    const connect=c.connect.bind(c)
    c.connect=(async()=>{record.attempted=true;try{await connect();record.connected=true}
      finally{record.settled=true;fixtureEvent(name,'connect-settled',{connected:record.connected})}}) as any
    return c
  }
  const close=async()=>{
    fixtureEvent(name,'close-start',{clients:records.length})
    let endRejected=false
    const ended=Promise.allSettled(records.map(async r=>{
      if(!r.closed)await r.client.end()
      if(!r.attempted)r.closed=true
    })).then(results=>{endRejected=results.some(r=>r.status==='rejected')})
    let timer:ReturnType<typeof setTimeout>|undefined
    const complete=await Promise.race([ended.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),2000)})])
    clearTimeout(timer)
    const forced=!complete
    if(forced){
      for(const r of records)if(!r.closed)(r.client as any).connection.stream.destroy()
      await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(resolve,500)})])
      clearTimeout(timer)
    }
    const unclosed=records.filter(r=>!r.closed).length
    const unsettled=records.filter(r=>r.attempted&&!r.settled).length
    fixtureEvent(name,'close-end',{forced,unclosed,connect_unsettled:records.filter(r=>!r.settled && (r.client as any)._connecting).length})
    if(forced||unclosed||unsettled||endRejected)throw Error('BA_FIXTURE_CLEANUP_FAILED')
  }
  return {client,close}
}
/** Preserve every failure, including a main-path exception before children end. */
export async function settleFixtureWork(main: () => Promise<void>, children: Promise<void>[]): Promise<void> {
  const settled = Promise.allSettled(children)
  const errors: unknown[] = []
  try { await main() } catch (error) { errors.push(error) }
  for (const result of await settled) if (result.status === 'rejected') errors.push(result.reason)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'BA_FIXTURE_WORK_FAILED')
}
/** Complete lazy owned fixtures within the selected existing bound; retain every failure. */
export async function settleIndependentFixtureWork(tasks: Array<() => Promise<void>>, concurrency=2): Promise<void> {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>6)throw Error('BA_FIXTURE_POOL_BOUND_INVALID')
  let cursor=0,active=0,peak=0,completed=0
  const errors: unknown[]=[]
  const worker=async()=>{
    while(cursor<tasks.length){
      const index=cursor++;active++;peak=Math.max(peak,active)
      fixtureEvent('F06-main','unit-start',{index,active})
      try{await tasks[index]()}catch(error){errors.push(error);fixtureEvent('F06-main','unit-error',{index,message:sanitizeFixtureError(error instanceof Error?error.message:String(error))})}
      finally{active--;completed++;fixtureEvent('F06-main','unit-end',{index,active,completed})}
    }
  }
  await settleFixtureWork(worker,Array.from({length:concurrency-1},()=>worker()))
  fixtureEvent('F06-main','all-settled',{registered:tasks.length,completed,active,peak,failures:errors.length})
  if(errors.length===1)throw errors[0]
  if(errors.length>1)throw new AggregateError(errors,'BA_FIXTURE_WORK_FAILED')
}

export async function boundedFixtureDatabase(name:string,endpoint:string) {
  if(!/^(?:ba|ba16)_[a-f0-9]{14}_test$/.test(name))throw Error('BA_OWNED_DATABASE_NAME_REQUIRED')
  const {databaseUrl,maintenanceUrl}=derivePostgresTestDatabaseUrls(name,{AGENT_COM_TEST_DATABASE_URL:endpoint})
  fixtureEvent(name,'createdb-start')
  await new Promise<void>((resolve,reject)=>{
    execFile('createdb',[`--maintenance-db=${maintenanceUrl}`,name],{encoding:'utf8',timeout:2000,killSignal:'SIGTERM',maxBuffer:1024*1024,
      env:{PATH:process.env.PATH,HOME:process.env.HOME,PGCONNECT_TIMEOUT:'2',PGOPTIONS:'-c statement_timeout=2000 -c lock_timeout=1000'}},
      (error,_stdout,stderr)=>{
        if(error){const e=error as any;fixtureEvent(name,'createdb-end',{exit:typeof e.code==='number'?e.code:null,signal:e.signal??null,code:e.code??null})
          reject(Error(`BA_FIXTURE_CREATEDB_FAILED ${sanitizeFixtureError(stderr??e.message)}`))}
        else{fixtureEvent(name,'createdb-end',{exit:0});resolve()}
      })
  })
  return {databaseUrl,drop:()=>new Promise<void>((resolve,reject)=>{
    // Other owned fixtures must process socket I/O while this DB is dropped.
    // Preserve existing child/SQL/lock deadlines and propagate any failure.
    fixtureEvent(name,'dropdb-start')
    execFile('dropdb',[`--maintenance-db=${maintenanceUrl}`,name],{encoding:'utf8',timeout:6000,killSignal:'SIGTERM',
      env:{PATH:process.env.PATH,HOME:process.env.HOME,PGCONNECT_TIMEOUT:'2',PGOPTIONS:'-c statement_timeout=5000 -c lock_timeout=1000'}},
      (error,_stdout,stderr)=>{
        if(error){const e=error as any;fixtureEvent(name,'dropdb-end',{exit:e.code??null,signal:e.signal??null});reject(Error(`BA_FIXTURE_DROPDB_FAILED ${sanitizeFixtureError(stderr||e.message)}`))}
        else{fixtureEvent(name,'dropdb-end',{exit:0});resolve()}
      })
  })}
}

export async function verifyFixtureEndpoint(endpoint:string,major:16|17):Promise<void>{
  const u=new URL(endpoint),socket=u.searchParams.get('host')
  if(!['postgres:','postgresql:'].includes(u.protocol)||!u.pathname.endsWith('_test'))throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  if(socket){
    if(major!==17||socket!==resolve(process.env.AUN_BOUNDED_FIXTURE_ROOT??'','socket')
      ||!socket.startsWith('/private/tmp/aun-bounded-fixture.')||u.searchParams.get('port')!=='55437'||u.username!=='fixture')throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  }else if(!['localhost','127.0.0.1'].includes(u.hostname)||u.port!==String(major===17?5433:5432)||u.username!=='postgres'
    ||stage!=='ci')throw Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  const owned=fixtureClients('probe-'+major)
  const check=owned.client(derivePostgresTestDatabaseUrls('bounded_probe_test',{AGENT_COM_TEST_DATABASE_URL:endpoint}).maintenanceUrl)
  try{
    await check.connect()
    const r=(await check.query("SELECT current_database() db,current_user AS actor,current_setting('server_version_num')::int version,current_setting('unix_socket_directories') socket,inet_server_port() port")).rows[0]
    expect(r.db).toBe('postgres');expect(r.actor).toBe(u.username)
    expect(r.version).toBeGreaterThanOrEqual(major*10000);expect(r.version).toBeLessThan((major+1)*10000)
    if(socket)expect(r.socket).toBe(socket);else expect(r.port).toBe(5432)
  }finally{await owned.close()}
}

export async function seedNormalTransport(admin: Client): Promise<void> {
  await admin.query("INSERT INTO channels(id,name,members) VALUES('fixture-channel','bounded fixture',ARRAY['qa','codex-cto','different-consumer']) ON CONFLICT(id) DO NOTHING")
  await admin.query("INSERT INTO agents(agent_id, display_name, agent_type) VALUES('qa', 'QA', 'dev'),('codex-cto', 'CTO', 'dev'),('different-consumer', 'Projection fixture', 'dev') ON CONFLICT(agent_id) DO NOTHING")
  await admin.query("INSERT INTO channel_adapters(channel_id,platform,external_id,metadata) VALUES('fixture-channel','discord','999999999999999999','{\"adapter_owner_agent_id\":\"different-consumer\"}')")
  const connector=(await admin.query("INSERT INTO connector_instances(agent_id,status) VALUES('different-consumer','active') RETURNING connector_instance_id")).rows[0].connector_instance_id
  await admin.query("INSERT INTO connector_credentials(agent_id,connector_instance_id,secret_ref,status) VALUES('different-consumer',$1,'fixture:never-resolve','active')",[connector])
  await admin.query("INSERT INTO channel_connector_bindings(channel_id,connector_instance_id) VALUES('fixture-channel',$1)",[connector])
  await admin.query("INSERT INTO provider_channel_access(provider_channel_id,connector_instance_id,agent_id,capabilities) VALUES('999999999999999999',$1,'different-consumer','{\"message_create\":true}')",[connector])
}

/** Every connection inherits an explicitly supplied isolated versioned endpoint. */
export async function fixture(run: (f: { admin: Client; control: Client; other: Client; executor: Client; runtime: Client; config: any; env: NodeJS.ProcessEnv; prepare: () => Promise<any>; roleUrls: Record<string,string>; client: (url:string)=>Client }) => Promise<void>) {
  const phases: Array<{phase:string;milliseconds:number;queries:number}> = []
  let phase='endpoint',phaseStarted=performance.now(),queryCount=0
  const nextPhase=(name:string)=>{const now=performance.now();phases.push({phase,milliseconds:now-phaseStarted,queries:queryCount});phase=name;phaseStarted=now;queryCount=0}
  const endpoint = process.env.AGENT_COM_BOUNDED_PG17_TEST_DATABASE_URL
  if (!endpoint) throw new Error('BA_PG17_ENDPOINT_REQUIRED')
  await verifyFixtureEndpoint(endpoint,17)
  nextPhase('create_database')
  const u = new URL(endpoint)
  if (!u.pathname.endsWith('_test') || (!u.searchParams.get('host') && !['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('BA_ISOLATED_ENDPOINT_REQUIRED')
  const name = `ba_${randomUUID().replaceAll('-', '').slice(0, 14)}_test`
  const target = await boundedFixtureDatabase(name, endpoint)
  const owned = fixtureClients(name)
  const client=(url:string)=>{
    const c=owned.client(url),query=c.query.bind(c)
    // Count without changing the original return value/callback/Promise behavior.
    c.query=((...args:any[])=>{queryCount++;return (query as any)(...args)}) as any
    return c
  }
  const admin = client(target.databaseUrl)
  let originalError: unknown
  nextPhase('connect_admin')
  fixtureEvent(name,'setup-start')
  try {
    await admin.connect()
    const identity = (await admin.query("SELECT current_database() AS db,current_setting('server_version_num')::integer AS version")).rows[0]
    expect(identity.db).toBe(name); expect(identity.version).toBeGreaterThanOrEqual(170000); expect(identity.version).toBeLessThan(180000)
    nextPhase('migration')
    fixtureEvent(name,'migration-start')
    const migrated = Bun.spawn(['bun', 'run', 'db/migrate.ts'], { cwd: candidateRoot, env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: target.databaseUrl, AGENT_COM_TEST_DATABASE_URL: target.databaseUrl, AGENT_COM_TEST_DATABASE_NAME: name }, stdout: 'pipe', stderr: 'pipe' })
    // Start both drains before awaiting the child; preserve every settlement.
    fixtureEvent(name,'migration-spawn',{pid:migrated.pid,parent_pid:process.pid})
    const migrationOut = drainMigrationOutput(migrated.stdout,name,migrated.pid,'stdout')
    const migrationErr = drainMigrationOutput(migrated.stderr,name,migrated.pid,'stderr')
    const exited=migrated.exited.then(exit=>{fixtureEvent(name,'migration-exited',{pid:migrated.pid,exit});return exit},error=>{fixtureEvent(name,'migration-exit-rejected',{pid:migrated.pid,message:sanitizeFixtureError(error instanceof Error?error.message:error)});throw error})
    const [migrationExit,migrationStdout,migrationStderr] = await Promise.allSettled([exited,migrationOut,migrationErr] as const)
    const migrationErrors: unknown[] = [migrationExit,migrationStdout,migrationStderr].flatMap(r=>r.status==='rejected'?[r.reason]:[])
    fixtureEvent(name,'migration-end',{pid:migrated.pid,exit:migrationExit.status==='fulfilled'?migrationExit.value:null,
      stdout_eof:migrationStdout.status==='fulfilled',stderr_eof:migrationStderr.status==='fulfilled'})
    if(migrationExit.status==='fulfilled'&&migrationExit.value!==0) migrationErrors.push(new Error(`BA_MIGRATION_FAILED ${migrationStderr.status==='fulfilled'?sanitizeFixtureError(migrationStderr.value):'stderr stream failed'}`))
    if(migrationErrors.length===1)throw migrationErrors[0]
    if(migrationErrors.length>1)throw new AggregateError(migrationErrors,'BA_MIGRATION_FAILED')
    nextPhase('schema_security')
    // db/migrate.ts supports the old schema without this optional topology.
    expect((await admin.query("SELECT to_regclass('public.fleet_runtime_queue_observation_active') AS relation")).rows[0].relation).toBeNull()
    await admin.query(readFileSync(resolve(candidateRoot, 'db/migrations/2026-08-16-fleet-runtime-queue-observation-v2.up.sql'), 'utf8'))
    await admin.query(readFileSync(resolve(candidateRoot, 'db/migrations/2026-09-08-queue-bounded-admission.up.sql'), 'utf8'))
    const observation=(await admin.query("SELECT t.tgtype::int AS type,t.tgenabled AS enabled,p.prosecdef AS definer FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='public.message_queue'::regclass AND t.tgname='fleet_runtime_queue_agent_revision_v2'")).rows
    expect(observation).toEqual([{type:29,enabled:'O',definer:false}])
    expect((await admin.query("SELECT rolcanlogin,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='aun_admission_owner'")).rows[0])
      .toEqual({rolcanlogin:false,rolsuper:false,rolcreaterole:false,rolbypassrls:false})
    expect((await admin.query("SELECT has_table_privilege('aun_admission_owner','fleet_runtime_queue_observation_active','SELECT') AS epoch_read,has_table_privilege('aun_admission_owner','fleet_runtime_queue_agent_revisions','SELECT,INSERT,UPDATE') AS revisions,has_table_privilege('aun_admission_owner','fleet_runtime_queue_agent_revisions','DELETE') AS delete_revision,has_sequence_privilege('aun_admission_owner','fleet_runtime_queue_observation_epoch_seq','USAGE') AS sequence_usage")).rows[0])
      .toEqual({epoch_read:true,revisions:true,delete_revision:false,sequence_usage:false})
    const roles = { controller: `${name}_c`, executor: `${name}_e`, runtime: `${name}_r` }
    const passwords = Object.fromEntries(Object.keys(roles).map(kind=>[kind,randomBytes(24).toString('hex')]))
    nextPhase('role_provision')
    await admin.query("SET password_encryption='scram-sha-256'")
    const transport = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'queue_admission_%'")).rows
    const transportTargets=transport.map(({tablename})=>`public."${String(tablename).replaceAll('"','""')}"`).join(',')
    for (const [kind, role] of Object.entries(roles)) {
      if(!/^[a-f0-9]{48}$/.test(passwords[kind]))throw Error('BA_PASSWORD_INVALID')
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEROLE NOBYPASSRLS PASSWORD '${passwords[kind]}'`)
      await admin.query(`GRANT aun_admission_${kind === 'controller' ? 'control' : kind} TO "${role}"`)
      // Representative old application transport rights, never owner/ledger
      // rights. The guard must enforce even with these legacy UPDATE grants.
      if(transportTargets)await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${transportTargets} TO "${role}"`)
      await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
    }
    const roleUrls=Object.fromEntries(Object.entries(roles).map(([kind,role])=>{const url=new URL(target.databaseUrl);url.username=role;url.password=passwords[kind];return [kind,url.href]}))
    const executorUrl=new URL(roleUrls.executor)
    nextPhase('role_connections_and_checks')
    const control=client(roleUrls.controller),other=client(target.databaseUrl),executor=client(roleUrls.executor),runtime=client(roleUrls.runtime)
    await Promise.all([control.connect(),other.connect(),executor.connect(),runtime.connect()])
    for(const [kind,c] of [['controller',control],['executor',executor],['runtime',runtime]] as const){
      expect((await c.query("SELECT current_user actor,rolsuper,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0])
        .toEqual({actor:roles[kind],rolsuper:false,rolcreaterole:false,rolbypassrls:false})
      expect((await admin.query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' scram FROM pg_authid WHERE rolname=$1",[roles[kind]])).rows[0].scram).toBe(true)
      expect((await admin.query("SELECT pg_has_role($1,'aun_admission_owner','MEMBER') AS owner_member",[roles[kind]])).rows[0].owner_member).toBe(false)
    }
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
    nextPhase('body')
    fixtureEvent(name,'setup-end');fixtureEvent(name,'body-start')
    await run({ admin, control, other, executor, runtime, config, env, prepare, roleUrls, client })
    fixtureEvent(name,'body-end')
  } catch(error) { originalError=error; throw error } finally {
    try{nextPhase('close_connections');await owned.close();nextPhase('drop_database');await target.drop()}
    catch(cleanup){throw new AggregateError([...(originalError?[originalError]:[]),cleanup],'BA_FIXTURE_CLEANUP_FAILED')}
    finally{nextPhase('done');console.log('BA_FIXTURE_PHASES '+JSON.stringify({database:name,phases,query_count:phases.reduce((n,p)=>n+p.queries,0),measurement:'inclusive wall time; query-count and phase-clock bookkeeping included; no instrumentation-free baseline claimed'}))}
  }
}

if(stage!=='private')test('bounded fixture transport GRANT is privilege-equivalent to original per-table grants',async()=>{
  await fixture(async f=>{
    const roles=Object.values(f.config.roles) as string[]
    const tables=(await f.admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'queue_admission_%' ORDER BY tablename")).rows
    const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"'
    const snapshot=async()=>{
      const relations=(await f.admin.query(`SELECT r.rolname,c.relname,c.relkind,p.privilege,
        CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,p.privilege)
          ELSE has_table_privilege(r.oid,c.oid,p.privilege) END AS allowed
        FROM pg_roles r CROSS JOIN pg_class c
        CROSS JOIN LATERAL unnest(CASE WHEN c.relkind='S' THEN ARRAY['USAGE','SELECT','UPDATE']
          ELSE ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] END) AS p(privilege)
        WHERE r.rolname=ANY($1::text[]) AND c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','S')
        ORDER BY r.rolname,c.relname,c.relkind,p.privilege`,[roles])).rows
      const memberships=(await f.admin.query(`SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolbypassrls,r.rolcanlogin,
        member.rolname AS inherited_role,m.admin_option FROM pg_roles r LEFT JOIN pg_auth_members m ON m.member=r.oid
        LEFT JOIN pg_roles member ON member.oid=m.roleid WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname,member.rolname`,[roles])).rows
      const acl=(await f.admin.query(`SELECT c.relname,c.relkind,x.grantor,x.grantee,x.privilege_type,x.is_grantable
        FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) x JOIN pg_roles r ON r.oid=x.grantee
        WHERE c.relnamespace='public'::regnamespace AND r.rolname=ANY($1::text[])
        ORDER BY c.relname,c.relkind,x.grantee,x.privilege_type,x.grantor,x.is_grantable`,[roles])).rows
      return {relations,memberships,acl}
    }
    const batched=await snapshot()
    // Remove the tested direct transport grants, then independently execute
    // the previous per-table procedure. Membership and sequence grants stay put.
    for(const role of roles)for(const {tablename} of tables)await f.admin.query(`REVOKE SELECT,INSERT,UPDATE,DELETE ON public.${quote(tablename)} FROM ${quote(role)}`)
    for(const role of roles)for(const {tablename} of tables)await f.admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${quote(tablename)} TO ${quote(role)}`)
    const original=await snapshot()
    expect(batched).toEqual(original)
    expect(roles.length).toBe(3)
    expect(tables.length).toBeGreaterThan(0)
    console.log('BA_TRANSPORT_PRIVILEGE_EQUIVALENCE '+JSON.stringify({database:f.config.policy_id,roles:roles.length,tables:tables.length,
      relation_privileges:batched.relations.length,explicit_acl_entries:batched.acl.length,
      batch_sha256:fixtureSha(JSON.stringify(batched)),original_sha256:fixtureSha(JSON.stringify(original)),
      enumeration_queries_before:3,enumeration_queries_after:1,transport_grant_queries_before:3*tables.length,transport_grant_queries_after:3,
      all_public_relations_sequences_memberships_and_explicit_ACL_equal:true}))
  })
},30000)

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
export function boundedTest(id: string, run: () => Promise<void> | void, timeoutMs = 30000): void {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error("BA_FIXTURE_TEST_TIMEOUT_INVALID")
  if (!ALL_BOUNDED_CASES.includes(id)) throw new Error('BA_UNKNOWN_CASE')
  if (boundedCaseIds(stage!).includes(id)) test(id,run,timeoutMs)
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

async function verifyObservationOwnerDependencies() {
  await fixture(async f=>{
    const up=readFileSync(resolve(candidateRoot,'db/migrations/2026-09-08-queue-bounded-admission.up.sql'),'utf8')
    const observationBytes=async()=> (await f.admin.query("SELECT (SELECT jsonb_agg(to_jsonb(a)) FROM fleet_runtime_queue_observation_active a) AS active,(SELECT jsonb_agg(to_jsonb(r) ORDER BY agent_id) FROM fleet_runtime_queue_agent_revisions r) AS revisions")).rows[0]
    const beforeRemoval=await observationBytes()
    await f.admin.query(readFileSync(resolve(candidateRoot,'db/migrations/2026-09-08-queue-bounded-admission.down.sql'),'utf8'))
    expect((await f.admin.query("SELECT has_table_privilege('aun_admission_owner','fleet_runtime_queue_observation_active','SELECT') AS epoch_read,has_table_privilege('aun_admission_owner','fleet_runtime_queue_agent_revisions','SELECT,INSERT,UPDATE') AS revisions")).rows[0])
      .toEqual({epoch_read:false,revisions:false})
    expect(await observationBytes()).toEqual(beforeRemoval)
    await f.admin.query(up)
    const topologyNegatives=[
      'ALTER SEQUENCE fleet_runtime_queue_observation_epoch_seq RENAME TO missing_epoch',
      'ALTER TABLE fleet_runtime_queue_observation_active RENAME TO missing_active',
      'ALTER TABLE fleet_runtime_queue_agent_revisions RENAME TO missing_revisions',
      'ALTER FUNCTION fleet_runtime_bump_queue_agent_revision_v2() RENAME TO missing_bump',
      'DROP TRIGGER fleet_runtime_queue_agent_revision_v2 ON message_queue',
      'ALTER TABLE message_queue DISABLE TRIGGER fleet_runtime_queue_agent_revision_v2',
      'ALTER FUNCTION fleet_runtime_bump_queue_agent_revision_v2() SECURITY DEFINER',
      'DELETE FROM fleet_runtime_queue_observation_active',
    ]
    for(const mutation of topologyNegatives){
      await f.admin.query('BEGIN')
      try{
        await f.admin.query(mutation)
        await expect(f.admin.query(up),mutation).rejects.toThrow('ADMISSION_OBSERVATION_TOPOLOGY_INVALID')
      }finally{await f.admin.query('ROLLBACK')}
      expect(await observationBytes()).toEqual(beforeRemoval)
    }
    await seedNormalTransport(f.admin);await f.prepare()
    const enrolled=await enrollNormalTask(f,1)
    await admissionTransition(f.control,enrolled.state,'enable',{})
    const revision=async()=>Number((await f.admin.query("SELECT r.revision FROM fleet_runtime_queue_agent_revisions r JOIN fleet_runtime_queue_observation_active a USING(migration_epoch) WHERE r.agent_id='qa'")).rows[0].revision)
    const snapshot=async()=>({
      queue:(await f.admin.query('SELECT to_jsonb(q) AS row FROM message_queue q WHERE id=$1',[enrolled.q.id])).rows[0].row,
      policy:(await f.admin.query('SELECT to_jsonb(p) AS row FROM queue_admission_policies p WHERE policy_id=$1',[f.config.policy_id])).rows[0].row,
      task:(await f.admin.query('SELECT to_jsonb(t) AS row FROM queue_admission_tasks t WHERE policy_id=$1',[f.config.policy_id])).rows[0].row,
      observation:await observationBytes(),
    })
    const baseline=await revision(),beforeClaim=await snapshot()
    const missingGrants=[['fleet_runtime_queue_observation_active','SELECT'],
      ...['SELECT','INSERT','UPDATE'].map(privilege=>['fleet_runtime_queue_agent_revisions',privilege])]
    for(const [table,privilege] of missingGrants){
      await f.admin.query(`REVOKE ${privilege} ON public.${table} FROM aun_admission_owner`)
      try{
        await expect(tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env,queueId:String(enrolled.q.id)}))
          .rejects.toThrow(`permission denied for table ${table}`)
        expect(await snapshot()).toEqual(beforeClaim)
      }finally{await f.admin.query(`GRANT ${privilege} ON public.${table} TO aun_admission_owner`)}
    }
    await tryBoundedClaim(f.executor,'qa',{dialect:'postgres',env:f.env,queueId:String(enrolled.q.id)})
    expect(await revision()).toBe(baseline+1)
    let invocations=0
    const adapter={runtime_id:f.config.runtime_id,capabilities:{},execution_timeout_ms:1000,invoke:async()=>{
      invocations++;expect(await revision()).toBe(baseline+2)
      expect((await admissionStatus(f.executor,f.config.policy_id))!.tasks[0]).toMatchObject({stage:'INVOKING',invocation_attempts:1})
      return fixtureResult()
    }}
    expect((await runReceivedQueueWork(fixtureDb(f),{queueId:enrolled.q.id,adapter,expectedClaimSource:'bounded-admission'})).ok).toBe(true)
    expect(invocations).toBe(1);expect(await revision()).toBe(baseline+3)
    expect((await admissionStatus(f.executor,f.config.policy_id))!.tasks[0]).toMatchObject({stage:'RESULT_SAVED',invocation_attempts:1})
    expect((await f.admin.query('SELECT status FROM message_queue WHERE id=$1',[enrolled.q.id])).rows[0].status).toBe('done')
    console.log(JSON.stringify({subcase:'I4-OWNER-OBSERVATION-DEPENDENCIES',topology_negative_cases:topologyNegatives.length,
      missing_grants_atomic_refusal:missingGrants.length,revision_baseline:baseline,claim_revision:baseline+1,invoke_revision:baseline+2,result_revision:baseline+3,
      owner_login:false,owner_membership:false,caller_legacy_transport_grants:true,old_schema_installation:true,down_preserves_observation:true}))
  })
}

boundedTest('BA-CORE-F02', async () => {
  await verifyObservationOwnerDependencies()
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

async function verifyCompletedHistoryPrepare() {
  await fixture(async f=>{
    await seedNormalTransport(f.admin)
    const message=randomUUID()
    await f.admin.query("INSERT INTO agent_messages(id,channel_id,author_id,content,message_type) VALUES($1,'fixture-channel','codex-cto','Explicitly close this fixture without reply','request')",[message])
    const q=(await f.admin.query("INSERT INTO message_queue(agent_id,message_id,payload,status,created_at,claimed_by,claimed_at,claim_expires_at) VALUES('qa',$1,'{}','received',clock_timestamp()-interval '3 seconds','qa',clock_timestamp()-interval '2 seconds',clock_timestamp()+interval '1 minute') RETURNING id",[message])).rows[0]
    const closed=await lifecycleTransition('record-no-reply',{agentId:'qa',queueId:String(q.id),reason:'explicit fixture lifecycle closure',env:f.env,cwd:candidateRoot})
    expect(closed.ok,closed.stderr).toBe(true)
    const saved=(await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
    expect(saved.status).toBe('done');expect(saved.claimed_by).toBe('qa')
    const payload=JSON.parse(saved.payload)
    expect(payload.terminal_baton.source).toBe('record_no_reply_command')
    // Explicitly reproduce supported JS-time-after-BEGIN/SQL-now() ordering.
    await f.admin.query("UPDATE message_queue SET done_at=($2::jsonb->'terminal_baton'->>'set_at')::timestamptz-interval '25 milliseconds' WHERE id=$1",[q.id,JSON.stringify(payload)])
    const original=(await f.admin.query('SELECT to_jsonb(q) row FROM message_queue q WHERE id=$1',[q.id])).rows[0].row
    const rowBytes=()=>f.admin.query('SELECT to_jsonb(q) row FROM message_queue q ORDER BY id')
    let negativeCases=0
    const reject=async(label:string)=>{
      negativeCases++
      const before=(await rowBytes()).rows
      await expect(f.prepare(),label).rejects.toThrow('ADMISSION_AFFECTED_WORK_PRESENT')
      expect((await rowBytes()).rows,label+' preserves history').toEqual(before)
      expect((await f.admin.query('SELECT count(*)::int n FROM queue_admission_policies')).rows[0].n).toBe(0)
    }
    const variants:Array<[string,any]>=[
      ['missing baton',{}],['marker alone',{terminal_baton:{no_reply_required:true}}],
      ['legacy daemon prose closure',{terminal_baton:{...payload.terminal_baton,set_by:'state_daemon',source:'deterministic_no_reply_policy'}}],
      ['foreign closer',{terminal_baton:{...payload.terminal_baton,set_by:'foreign'}}],
      ['wrong source',{terminal_baton:{...payload.terminal_baton,source:'deterministic_no_reply_policy'}}],
      ['malformed timestamp',{terminal_baton:{...payload.terminal_baton,set_at:'invalid'}}],
      ['future baton',{terminal_baton:{...payload.terminal_baton,set_at:'2099-01-01T00:00:00Z'}}],
      ['pending finalizer',{...payload,runner_result:{schema_version:'queue_work_result_v1',ok:true,next_action:'reply'}}],
      ['retry error',{...payload,runner_error:{retryable:true}}],
      ['undischarged execution',{...payload,queue_work_execution:{runtime_id:'old'}}],
      ['finalizer error',{...payload,finalizer_error:{code:'SEND_FAILED'}}],
    ]
    for(const [label,value]of variants){await f.admin.query('UPDATE message_queue SET payload=$2 WHERE id=$1',[q.id,JSON.stringify(value)]);await reject(label)}
    await f.admin.query("UPDATE message_queue SET payload='{' WHERE id=$1",[q.id]);await reject('malformed JSON')
    await f.admin.query('UPDATE message_queue SET payload=$2 WHERE id=$1',[q.id,original.payload])
    for(const status of ['received','in_progress']){await f.admin.query('UPDATE message_queue SET status=$2 WHERE id=$1',[q.id,status]);await reject('active '+status)}
    await f.admin.query("UPDATE message_queue SET status='done',claim_expires_at=NULL WHERE id=$1",[q.id]);await reject('partial claim tuple')
    await f.admin.query('UPDATE message_queue SET claim_expires_at=$2 WHERE id=$1',[q.id,original.claim_expires_at])
    const outbound=(await f.admin.query("INSERT INTO outbound_queue(message_id,status,agent_id,channel_external_id,content) VALUES($1,'pending','codex-cto','999999999999999999','fixture pending projection') RETURNING id",[message])).rows[0]
    await reject('active original projection');await f.admin.query('DELETE FROM outbound_queue WHERE id=$1',[outbound.id])
    const run=randomUUID(),probeMessage=randomUUID(),sent=new Date(Date.now()-2000).toISOString(),claimed=new Date(Date.now()-1000).toISOString(),done=new Date(Date.now()-500).toISOString()
    const content=`[AUN-N1-SLO-PROBE/v1]:${run}:qa`,schema='aun-n1-slo-probe/v1'
    const probePayload={schema_version:schema,message_type:'probe',run_id:run,from:'qa',to:'qa',content,no_op:true}
    const n1={schema_version:schema,run_id:run,agent_id:'qa',runtime_instance_id:randomUUID(),lease_id:randomUUID(),observation_window_ms:5000,outcome:'success',failure_type:null,failure_stage:null,sent_at:sent,claimed_at:claimed,closed_at:done,rtt_ms:1500,provider_effect_count:0,discord_visible_send_count:0}
    await f.admin.query("INSERT INTO channels(id,name,members) VALUES('pdca-daily','fixture N1',ARRAY['qa'])")
    await f.admin.query("INSERT INTO agent_messages(id,channel_id,author_id,author_bot,content,message_type,metadata,source,direction,role,created_at) VALUES($1,'pdca-daily','qa',true,$2,'probe',$3,'agent-comms','internal','system',$4)",[probeMessage,content,JSON.stringify({n1_slo:n1}),sent])
    const probe=(await f.admin.query("INSERT INTO message_queue(agent_id,message_id,payload,status,created_at,done_at) VALUES('qa',$1,$2,'done',$3,$4) RETURNING id",[probeMessage,JSON.stringify(probePayload),sent,done])).rows[0]
    for(const [label,delta]of [['run mismatch',{run_id:randomUUID()}],['nonzero effect',{provider_effect_count:1}],['probe retry',{outcome:'retry_exhausted'}],['missing close',{closed_at:null}],['probe error',{failure_type:'RETRY_EXHAUSTED'}]] as const){
      await f.admin.query('UPDATE agent_messages SET metadata=$2 WHERE id=$1',[probeMessage,JSON.stringify({n1_slo:{...n1,...delta}})]);await reject(label)
    }
    await f.admin.query('UPDATE agent_messages SET metadata=$2 WHERE id=$1',[probeMessage,JSON.stringify({n1_slo:n1})])
    await f.admin.query('UPDATE message_queue SET payload=$2 WHERE id=$1',[probe.id,JSON.stringify({...probePayload,to:'foreign'})]);await reject('foreign probe recipient')
    await f.admin.query('UPDATE message_queue SET payload=$2 WHERE id=$1',[probe.id,JSON.stringify(probePayload)])
    const cleared=(await f.admin.query("INSERT INTO message_queue(agent_id,message_id,payload,status,created_at,done_at) VALUES('qa',$1,$2,'done',$3,$4) RETURNING id",[randomUUID(),original.payload,original.created_at,original.done_at])).rows[0]
    await f.admin.query("INSERT INTO message_queue(agent_id,payload,status,claimed_by,claimed_at) VALUES('non-qa','{}','in_progress','non-qa',clock_timestamp())")
    const before=(await rowBytes()).rows
    expect((await f.prepare()).status).toBe('PREPARED')
    expect((await rowBytes()).rows).toEqual(before)
    expect([q.id,probe.id,cleared.id]).toHaveLength(3)
    console.log(JSON.stringify({subcase:'I2-PREPARE-COMPLETED-HISTORY',explicit_lifecycle_retained_claim:1,explicit_lifecycle_clear_claim:1,joined_N1_success:1,negative_cases:negativeCases,history_unchanged:true,legacy_daemon_baton_denied:true}))
  })
}

boundedTest('BA-CORE-F01',async()=>{
  await verifyCompletedHistoryPrepare()
  await fixture(async f=>{
    const wrongUrl=new URL(f.roleUrls.executor);wrongUrl.password=randomBytes(24).toString('hex')
    const negative=fixtureClients('wrong-password'),wrongPasswordClient=negative.client(wrongUrl.href)
    const started=Date.now()
    try{
      const outcome=await wrongPasswordClient.connect().then(()=>({code:null}),error=>({code:error.code}))
      if(stage==='ci')expect(outcome.code).toBe('28P01')
      else expect(outcome.code).toBeNull()
      fixtureEvent('wrong-password','auth-result',{status:outcome.code==='28P01'?'SCRAM_REJECTED':'AUTH_MODE_NOT_SCRAM',code:outcome.code})
    }finally{await negative.close();expect(Date.now()-started).toBeLessThan(3500)}
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
const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:1000});await client.connect();const agentId='qa';
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

// Scheduling failures cannot discard other independent fixture outcomes.
if(stage!=='private'){
test('I10 independent fixture workers retain every failure and never exceed two',async()=>{
  let active=0,peak=0,release!:()=>void,entered!:()=>void
  const atTwo=new Promise<void>(resolve=>{entered=resolve})
  const barrier=new Promise<void>(resolve=>{release=resolve})
  const visits:number[]=[];const first=Error('first fixture failure'),last=Error('late fixture failure')
  const running=settleIndependentFixtureWork([0,1,2,3].map(id=>async()=>{
    active++;peak=Math.max(peak,active);visits.push(id)
    if(active===2)entered()
    try{if(id<2)await barrier;if(id===0)throw first;if(id===3)throw last}
    finally{active--}
  }))
  const settled=running.then(()=>null,error=>error)
  await atTwo;expect(visits).toEqual([0,1]);expect(active).toBe(2)
  release();const error=await settled
  expect(visits).toEqual([0,1,2,3]);expect(active).toBe(0);expect(peak).toBe(2)
  expect(error).toBeInstanceOf(AggregateError);expect(error.errors).toEqual([first,last])
})

test('I10 exclusive fault waits for main and A09 settlement and preserves both failures',async()=>{
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve})
  let exclusive=false,lateSettled=false
  const early=Error('main failed'),late=Error('A09 failed')
  const parallel=settleFixtureWork(async()=>{throw early},[(async()=>{await barrier;lateSettled=true;throw late})()])
  const result=settleFixtureWork(async()=>{
    await Promise.allSettled([parallel]);expect(lateSettled).toBe(true);exclusive=true
  },[parallel]).then(()=>null,error=>error)
  await Promise.resolve();expect(exclusive).toBe(false);release()
  const error=await result;expect(exclusive).toBe(true);expect(error.errors).toEqual([early,late])
})
}

// A released A09 slot must admit queued main work while other slots stay busy.
if(stage!=='private')test('I12 shared six-slot pool reuses released slots and settles all before exclusive failure',async()=>{
  const release:Array<()=>void>=[]
  const barriers=Array.from({length:8},(_,i)=>new Promise<void>(resolve=>{release[i]=resolve}))
  let startedSix!:()=>void,startedSeven!:()=>void
  const six=new Promise<void>(resolve=>{startedSix=resolve}),seven=new Promise<void>(resolve=>{startedSeven=resolve})
  let active=0,peak=0,exclusive=false;const visits:number[]=[],ended:number[]=[]
  const early=Error('first A09 failed'),late=Error('last main failed'),exclusiveError=Error('exclusive fault failed')
  const parallel=settleIndependentFixtureWork(Array.from({length:8},(_,id)=>async()=>{
    visits.push(id);active++;peak=Math.max(peak,active)
    if(visits.length===6)startedSix();if(visits.length===7)startedSeven()
    try{await barriers[id];if(id===0)throw early;if(id===7)throw late}
    finally{active--;ended.push(id)}
  }),6)
  const result=settleFixtureWork(async()=>{
    await Promise.allSettled([parallel]);expect(ended.length).toBe(8);expect(active).toBe(0);exclusive=true;throw exclusiveError
  },[parallel]).then(()=>null,error=>error)
  await six;expect(visits).toEqual([0,1,2,3,4,5]);expect(active).toBe(6);expect(exclusive).toBe(false)
  release[0]();await seven;expect(visits).toEqual([0,1,2,3,4,5,6]);expect(active).toBe(6);expect(exclusive).toBe(false)
  for(const unblock of release)unblock()
  const error=await result;expect(peak).toBe(6);expect(ended.length).toBe(8);expect(exclusive).toBe(true)
  expect(error).toBeInstanceOf(AggregateError);expect(error.errors[0]).toBe(exclusiveError)
  expect(error.errors[1]).toBeInstanceOf(AggregateError);expect(error.errors[1].errors).toEqual([early,late])
})
