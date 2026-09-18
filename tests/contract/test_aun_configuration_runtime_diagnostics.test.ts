import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgAdapter } from '../../core/db/pg-adapter'
import { canonicalConfigurationJson, canonicalDesiredDocument, computeDesiredDigest, normalizeDesiredStateRow } from '../../core/aun-configuration-desired-state'
import { createPostgresTestDatabase } from '../helpers/postgres-test-database'

const repoRoot = join(import.meta.dir, '../..')
const sql = (name: string) => readFileSync(join(repoRoot, 'db/migrations', name), 'utf8')
const legacy = sql('2026-07-26-aun-configuration-reconciliation.up.sql')
const upgrade = sql('2026-09-13-seat-runtime-continuity-diagnostics.up.sql')
const rollback = sql('2026-09-13-seat-runtime-continuity-diagnostics.down.sql')
const projection = { provider_repo_root:'/old/provider',provider_config_root:'/old/config',daemon_checkout:'/old/daemon',
  project:'product-fixture',repository:'fixture/repository',weight:1.0,'😀':'astral','':'private-use' }

async function fixture(run: (db: PgAdapter) => Promise<void>) {
  // A missing explicit test endpoint is an error, never a skip or ambient DB fallback.
  let base = process.env.AGENT_COM_TEST_DATABASE_URL
  if (!base && process.env.CI === 'true') {
    const candidate = process.env.DATABASE_URL
    if (candidate && !/[\r\n]/.test(candidate)) {
      const url = new URL(candidate)
      if (['postgres:', 'postgresql:'].includes(url.protocol) && url.pathname === '/agent_comms_test') base = candidate
    }
  }
  if (!base) throw new Error('EXPLICIT_ISOLATED_POSTGRES_TEST_URL_REQUIRED')
  const database = createPostgresTestDatabase(`seat_diag_${process.pid}_${randomUUID().replaceAll('-','')}`, {AGENT_COM_TEST_DATABASE_URL:base})
  let db: PgAdapter | undefined
  try {
    const migrated = Bun.spawnSync([process.execPath,'--no-env-file','db/migrate.ts'],{
      cwd:repoRoot,env:{PATH:process.env.PATH!,HOME:process.env.HOME!,AGENT_COM_DB:'postgres',DATABASE_URL:database.databaseUrl},stdout:'pipe',stderr:'pipe',
    })
    expect(migrated.exitCode).toBe(0)
    if (migrated.exitCode !== 0) throw new Error('ISOLATED_BASE_MIGRATION_FAILED')
    db = new PgAdapter(database.databaseUrl)
    await db.execute(legacy)
    await run(db)
  } finally { if(db)await db.close();database.drop() }
}
async function seed(db:PgAdapter,agent:string,port:number|null=8801) {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,runtime,profile_enabled,runtime_engine_preference,home_directory,channel_port,
    expected_provider_identity,provider_token_source_ref,ordinary_projection,desired_control_refs,desired_release_commit,desired_release_tree)
    VALUES($1,$1,'bot','TUI',true,$2,$3,$4,'{"account_id":"fixture"}'::jsonb,'secret-ref:fixture/provider',$5::jsonb,$6::jsonb,$7,$8)`,
    [agent,port===null?null:'codex',port===null?null:'/old/'+agent,port,JSON.stringify(projection),JSON.stringify(['fixture:owner','fixture:design','fixture:owner']),'a'.repeat(40),'b'.repeat(40)])
}
async function row(db:PgAdapter,agent:string) { return await db.queryOne<any>('SELECT * FROM agents WHERE agent_id=$1',[agent]) }
async function events(db:PgAdapter,agent:string) { return await db.query<any>('SELECT * FROM aun_configuration_desired_outbox WHERE agent_id=$1 ORDER BY desired_revision',[agent]) }
async function parity(db:PgAdapter,agent:string) {
  const current=await row(db,agent),desired=normalizeDesiredStateRow(current)
  const actual=await db.queryOne<any>(`SELECT aun_canonical_jsonb(aun_configuration_desired_document(a)) AS document,
    encode(digest(convert_to(aun_canonical_jsonb(aun_configuration_desired_document(a)),'UTF8'),'sha256'),'hex') AS digest,
    aun_configuration_complete(a) AS complete FROM agents a WHERE agent_id=$1`,[agent])
  expect(actual?.complete).toBe(true)
  expect(actual?.document).toBe(canonicalConfigurationJson(canonicalDesiredDocument(desired)))
  expect(actual?.digest).toBe(computeDesiredDigest(desired))
  expect(actual?.digest).toBe(current.desired_digest)
  return current
}
async function protectedSnapshot(db:PgAdapter) {
  const tables=['agent_runtime_instances','agent_endpoints','control_plane_leases','message_queue','agent_messages','aun_configuration_observed_state','aun_configuration_restart_requests']
  const result:Record<string,unknown>={}
  for(const table of tables) result[table]=await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)
  result.agents=await db.query(`SELECT to_jsonb(a)-ARRAY['desired_revision','desired_digest','desired_updated_at','desired_updated_by']::text[] AS row FROM agents a ORDER BY agent_id`)
  return result
}
async function seedHistory(db:PgAdapter,agent:string) {
  const runtime=randomUUID(),lease=randomUUID(),message=randomUUID(),old=await row(db,agent)
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_engine,runtime_kind,host_id,session_name,process_id,port,checkout_path,status,metadata)
    VALUES($1,$2,'codex','local_process','fixture-host','fixture-session',12345,47891,'/observed/workspace','running','{"memory_project":"product-fixture"}')`,[runtime,agent])
  await db.execute(`INSERT INTO agent_endpoints(agent_id,endpoint_uri) VALUES($1,'http://127.0.0.1:47891')`,[agent])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at)
    VALUES($1,'runtime_instance',$2::text,'worker',$3,$2::uuid,3,'active',now()+interval '1 hour')`,[lease,runtime,agent])
  await db.execute(`INSERT INTO agent_messages(id,author_id,content,message_type) VALUES($1,$2,'synthetic durable work only','chat')`,[message,agent])
  await db.execute(`INSERT INTO message_queue(agent_id,message_id,payload,status,claimed_by,claimed_at,claim_expires_at,assigned_runtime_instance_id,claimed_runtime_instance_id)
    VALUES($1,$2,'{"fixture":"unfinished"}','in_progress','fixture-worker',now(),now()+interval '1 hour',$3,$3)`,[agent,message,runtime])
  await db.execute(`INSERT INTO aun_configuration_observed_state(host_id,agent_id,observed_revision,observed_desired_digest,candidate_digest,release_commit,release_tree,
    provider_native_digest,launchagent_plist_digest,launchctl_environment_digest,runtime_identity_digest,reconcile_status,lease_id,fencing_token)
    VALUES('fixture-host',$1,$2,$3,$4,$5,$6,$4,$4,$4,$4,'READY',$7,3)`,[agent,old.desired_revision,old.desired_digest,'c'.repeat(64),'a'.repeat(40),'b'.repeat(40),lease])
  await db.execute(`INSERT INTO aun_configuration_restart_requests(host_id,agent_id,to_revision,to_digest,candidate_digest,rollback_artifact_digest,exact_release_commit,exact_release_tree,
    exact_control_refs,lease_id,fencing_token,restart_budget,status) VALUES('fixture-host',$1,$2,$3,$4,$4,$5,$6,'["fixture:owner"]',$7,3,1,'AWAITING_OWNER_DECISION')`,
    [agent,old.desired_revision,old.desired_digest,'c'.repeat(64),'a'.repeat(40),'b'.repeat(40),lease])
}

describe('stable seat desired document PostgreSQL compatibility',()=>{
  test('new enrollment accepts unset/zero diagnostics and SQL/TS stable digest parity',async()=>fixture(async db=>{
    await db.execute(upgrade)
    for(const port of [null,0]) {
      const agent=port===null?'new-unset':'new-zero'
      await seed(db,agent,port)
      const first=await parity(db,agent)
      expect(first.channel_port).toBe(port)
      expect(Number(first.desired_revision)).toBe(1)
      expect(await events(db,agent)).toHaveLength(1)
    }
  }),120000)

  test('populated legacy transition is once-only and preserves runtime, identity, queues and history',async()=>fixture(async db=>{
    for(const agent of ['legacy-one','legacy-two','invalid-digest']) await seed(db,agent)
    await seed(db,'incomplete-authority')
    await db.execute("UPDATE agents SET desired_digest=$2 WHERE agent_id=$1",['invalid-digest','0'.repeat(64)])
    await db.execute("UPDATE agents SET desired_control_refs='[{}]'::jsonb WHERE agent_id='incomplete-authority'")
    await seedHistory(db,'legacy-one')
    const before=await protectedSnapshot(db)
    const previous=new Map<string,any>(),outbox=new Map<string,any[]>()
    for(const agent of ['legacy-one','legacy-two','invalid-digest','incomplete-authority']) {previous.set(agent,await row(db,agent));outbox.set(agent,await events(db,agent))}
    expect(previous.get('incomplete-authority').desired_revision).toBeNull()
    await db.execute(upgrade)
    expect(await protectedSnapshot(db)).toEqual(before)
    for(const agent of ['legacy-one','legacy-two']) {
      const old=previous.get(agent),next=await parity(db,agent),history=await events(db,agent)
      expect(Number(next.desired_revision)).toBe(Number(old.desired_revision)+1)
      expect(next.desired_digest).not.toBe(old.desired_digest)
      expect(next.desired_updated_at).not.toBeNull()
      expect(next.desired_updated_by).toBeTruthy()
      expect(history).toHaveLength(outbox.get(agent)!.length+1)
      expect(history.slice(0,-1)).toEqual(outbox.get(agent))
      expect(history.at(-1).desired_digest).toBe(next.desired_digest)
    }
    for(const agent of ['invalid-digest','incomplete-authority']) {
      expect(await row(db,agent)).toEqual(previous.get(agent))
      expect(await events(db,agent)).toEqual(outbox.get(agent))
    }
    const once=await db.query('SELECT * FROM agents ORDER BY agent_id'),onceEvents=await db.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY agent_id,desired_revision')
    await db.execute(upgrade)
    expect(await db.query('SELECT * FROM agents ORDER BY agent_id')).toEqual(once)
    expect(await db.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY agent_id,desired_revision')).toEqual(onceEvents)
    expect(await protectedSnapshot(db)).toEqual(before)

    const stable=await parity(db,'legacy-one'),stableEvents=await events(db,'legacy-one')
    await db.execute(`UPDATE agents SET runtime_engine_preference='claude-code',home_directory='/new/host/different-basename',channel_port=0,
      canonical_home='/new/home',canonical_workspace='/new/workspace',ordinary_projection=ordinary_projection||$2::jsonb WHERE agent_id=$1`,
      ['legacy-one',JSON.stringify({provider_repo_root:'/new/provider',provider_config_root:'/new/config',daemon_checkout:'/new/daemon'})])
    const observed=await parity(db,'legacy-one')
    expect(observed.desired_digest).toBe(stable.desired_digest)
    expect(observed.desired_revision).toBe(stable.desired_revision)
    expect(observed.desired_updated_at).toEqual(stable.desired_updated_at)
    expect(await events(db,'legacy-one')).toEqual(stableEvents)
    await db.execute("UPDATE agents SET ordinary_communication_enrollment=NOT ordinary_communication_enrollment WHERE agent_id='legacy-one'")
    const changed=await parity(db,'legacy-one')
    expect(Number(changed.desired_revision)).toBe(Number(stable.desired_revision)+1)
    expect(changed.desired_digest).not.toBe(stable.desired_digest)
    expect(await events(db,'legacy-one')).toHaveLength(stableEvents.length+1)
    const changedEvents=await events(db,'legacy-one')
    await db.execute("UPDATE agents SET ordinary_communication_enrollment=ordinary_communication_enrollment WHERE agent_id='legacy-one'")
    expect(await events(db,'legacy-one')).toEqual(changedEvents)
    await expect(db.execute("UPDATE agents SET provider_token_source_ref='literal:sk-fixtureinvalidsecret' WHERE agent_id='legacy-one'")).rejects.toThrow('RAW_SECRET_FORBIDDEN')
    expect(await events(db,'legacy-one')).toEqual(changedEvents)
    expect(()=>normalizeDesiredStateRow(previous.get('invalid-digest'))).toThrow('DESIRED_DIGEST_MISMATCH')
    expect(()=>normalizeDesiredStateRow(previous.get('incomplete-authority'))).toThrow('DESIRED_REVISION_INVALID')
    const preRollback=await db.query('SELECT * FROM agents ORDER BY agent_id')
    await expect(db.execute(rollback)).rejects.toThrow()
    await db.execute('ROLLBACK')
    expect(await db.query('SELECT * FROM agents ORDER BY agent_id')).toEqual(preRollback)
    await parity(db,'legacy-one')
  }),120000)
})
