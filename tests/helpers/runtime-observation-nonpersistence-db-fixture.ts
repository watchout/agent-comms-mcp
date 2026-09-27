import { Database } from 'bun:sqlite'
import { Client } from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, realpathSync, mkdtempSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { applyRuntimeObservationNonpersistenceSqlite } from '../../db/migrate-sqlite'

export const baseline='174c04e7db86b5fbc89c4bce08dbe48583c5ffac'
export const repo=join(import.meta.dir,'../..')
export const upgrade=readFileSync(join(repo,'db/migrations/2026-09-21-runtime-observation-nonpersistence.up.sql'),'utf8')
export const digest=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex')
export type Fixture={kind:'postgres'|'sqlite',query:(sql:string,values?:unknown[])=>Promise<any[]>,exec:(sql:string)=>Promise<void>,apply:()=>Promise<void>,close:()=>Promise<void>,db?:Database,name:string,databaseUrl:string}
const gate={AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED:'1'}
function fixtureEnv(extra:Record<string,string>) {return {PATH:process.env.PATH!,LANG:'C',...gate,...extra}}
export async function fixture(kind:'postgres'|'sqlite',fresh=false):Promise<Fixture> {
 const raw=process.env.AGENT_COM_TEST_DATABASE_URL
 if(!raw)throw Error('EXPLICIT_OWNED_FIXTURE_REQUIRED')
 const url=new URL(raw)
 // Public PR Checks owns disposable PostgreSQL services. Admit only that explicit
 // CI binding, never an ambient DATABASE_URL or arbitrary remote database.
 const ci=process.env.CI==='true' && process.env.GITHUB_ACTIONS==='true'
   && process.env.GITHUB_REPOSITORY==='watchout/agent-comms-mcp'
   && !!process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP)
   && ['postgres:','postgresql:'].includes(url.protocol)
   && ['localhost','127.0.0.1'].includes(url.hostname) && !url.search
   && url.username==='postgres' && url.password==='postgres'
   && ((url.port==='5432' && url.pathname==='/agent_comms_test')
     || (url.port==='5433' && url.pathname==='/agent_comms_bounded17_test'))
 if(ci && !process.env.AUN_NP_FIXTURE_ROOT)process.env.AUN_NP_FIXTURE_ROOT=mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP!),'aun-np-db-'))
 const root=process.env.AUN_NP_FIXTURE_ROOT
 if(!root || (ci
   ? dirname(realpathSync(root))!==realpathSync(process.env.RUNNER_TEMP!) || !/^aun-np-db-[A-Za-z0-9_-]+$/.test(root.split('/').at(-1)!)
   : !/^\/private\/tmp\/aun-(?:np-db|independent-pg)-[A-Za-z0-9_-]+$/.test(realpathSync(root))))throw Error('EXPLICIT_OWNED_FIXTURE_REQUIRED')
 if(!ci && (url.username!=='fixture'||url.password||url.hostname!=='localhost'||realpathSync(url.searchParams.get('host')??'')!==join(realpathSync(root),'socket')))throw Error('PRIVATE_SOCKET_FIXTURE_ONLY')
 const name='np_'+randomUUID().replaceAll('-','')+'_test'
 let pg:Client|undefined,db:Database|undefined,admin:Client|undefined
 const oldSqlite=Bun.spawnSync(['git','show',`${baseline}:db/migrate-sqlite.ts`],{cwd:repo,stdout:'pipe',stderr:'pipe'})
 const oldPg=Bun.spawnSync(['git','show',`${baseline}:db/migrate.ts`],{cwd:repo,stdout:'pipe',stderr:'pipe'})
 if(oldSqlite.exitCode||oldPg.exitCode)throw Error('FIXED_BASELINE_UNAVAILABLE')
 const oldSqlitePath=join(root,'legacy-migrate-sqlite.ts'),oldPgPath=join(root,'legacy-migrate.ts')
 writeFileSync(oldSqlitePath,oldSqlite.stdout.toString().replace("'./destructive-migration-gate'",JSON.stringify(join(repo,'db/destructive-migration-gate.ts'))))
 writeFileSync(oldPgPath,oldPg.stdout.toString().replace("'pg'",JSON.stringify(join(repo,'node_modules/pg/lib/index.js'))).replace("'./migrate-sqlite'",JSON.stringify(oldSqlitePath)).replace("'./destructive-migration-gate'",JSON.stringify(join(repo,'db/destructive-migration-gate.ts'))).replaceAll("join(import.meta.dir, 'migrations/",`join(${JSON.stringify(join(repo,'db'))}, 'migrations/`))
 const file=join(root,name+'.sqlite')
 let target:string
 if(kind==='postgres') {
   admin=new Client({connectionString:raw});await admin.connect()
   const id=(await admin.query("SELECT current_database() db,current_user actor,current_setting('server_version') version,current_setting('unix_socket_directories') socket,current_setting('listen_addresses') listen")).rows[0]
   console.log(JSON.stringify({case:'fixture-identity',kind,name,...id}))
   if(ci ? id.actor!=='postgres'||!/^1[67]\./.test(id.version)||id.db!==url.pathname.slice(1)
     : id.actor!=='fixture'||!id.version.startsWith('17.')||id.socket!==join(root,'socket')||id.listen!=='')throw Error('FIXTURE_IDENTITY_MISMATCH')
   await admin.query(`CREATE DATABASE ${name}`)
   const next=new URL(raw);next.pathname='/'+name;target=next.href
 } else target=file
 const cmd=[process.execPath,'--no-env-file',fresh?join(repo,kind==='sqlite'?'db/migrate-sqlite.ts':'db/migrate.ts'):oldPgPath]
 const env=fixtureEnv(kind==='postgres'?{AGENT_COM_DB:'postgres',DATABASE_URL:target,AGENT_COM_TEST_DATABASE_URL:target}:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:target,DATABASE_URL:raw,AGENT_COM_TEST_DATABASE_URL:raw})
 const migrated=Bun.spawnSync(cmd,{cwd:repo,env,stdout:'pipe',stderr:'pipe',timeout:25000})
 writeFileSync(join(root,name+'.migration.stdout.log'),migrated.stdout);writeFileSync(join(root,name+'.migration.stderr.log'),migrated.stderr)
 if(migrated.exitCode!==0){if(admin){await admin.query(`DROP DATABASE ${name}`);await admin.end()}throw Error('FIXTURE_BASE_MIGRATION_FAILED:'+migrated.exitCode+'\n'+migrated.stdout+'\n'+migrated.stderr)}
 if(kind==='postgres'){pg=new Client({connectionString:target});await pg.connect()}
 else {db=new Database(target);db.exec('PRAGMA foreign_keys=ON')}
 const query=async(sql:string,values:unknown[]=[])=>pg?(await pg.query(sql,values)).rows:db!.query(sql.replace(/\$\d+/g,'?')).all(...values as any[])
 const exec=async(sql:string)=>{if(pg)await pg.query(sql);else db!.exec(sql)}
 if(!fresh&&kind==='postgres') {
   await exec(readFileSync(join(repo,'db/migrations/2026-07-26-aun-configuration-reconciliation.up.sql'),'utf8'))
   await exec(readFileSync(join(repo,'db/migrations/2026-09-13-seat-runtime-continuity-diagnostics.up.sql'),'utf8'))
 }
 // SQLite EventLog is normally installed by its own existing schema owner.
 // This fixture uses that exact base table before DB guard installation.
 if(kind==='sqlite')await exec(`CREATE TABLE IF NOT EXISTS event_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,occurred_at TEXT NOT NULL DEFAULT(datetime('now')),seat_id TEXT,seat_instance_id TEXT,conversation_id TEXT,causation_id TEXT,correlation_id TEXT,turn_id TEXT,reply_id TEXT,claim_epoch INTEGER,payload TEXT NOT NULL DEFAULT '{}')`)
 return {kind,name,databaseUrl:target,query,exec,db,apply:async()=>{if(pg)await pg.query(upgrade);else {const previous=process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED;process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED='1';try{applyRuntimeObservationNonpersistenceSqlite(db!)}finally{if(previous===undefined)delete process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED;else process.env.AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=previous}}},close:async()=>{if(pg)await pg.end();if(db)db.close();if(admin){await admin.query(`DROP DATABASE ${name}`);await admin.end()}}}
}
export async function insert(f:Fixture,table:string,value:Record<string,unknown>) {
 const keys=Object.keys(value);await f.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(value))
}
export async function seed(f:Fixture) {
 const ids={runtime:randomUUID(),lease:randomUUID(),message:randomUUID(),connector:randomUUID(),activity:randomUUID()}
 await insert(f,'agents',{agent_id:'fixture-agent',display_name:'fixture',agent_type:'bot',runtime:'codex',status:'busy',home_directory:'/historical/workspace',channel_port:45555,metadata:JSON.stringify({provider_observation:{pid:1234},memory_project:'fixture-project'})})
 await insert(f,'agent_workspaces',{workspace_id:'logical-workspace',name:'fixture',local_path:'/historical/workspace',metadata:JSON.stringify({runtime_checkout_path:'/historical/workspace'})})
 await insert(f,'agent_runtime_instances',{runtime_instance_id:ids.runtime,agent_id:'fixture-agent',workspace_id:'logical-workspace',runtime_engine:'codex',runtime_kind:'local_process',host_id:'historical-host',session_name:'old-session',process_id:1234,port:45555,checkout_path:'/historical/workspace',endpoint_uri:'http://127.0.0.1:45555',status:'running',metadata:JSON.stringify({provider_observation:{pid:1234},bootstrap_run_id:'legacy-bootstrap'})})
 await insert(f,'control_plane_leases',{lease_id:ids.lease,lease_scope_type:'runtime_instance',lease_scope_id:ids.runtime,lease_purpose:'worker',holder_agent_id:'fixture-agent',holder_runtime_instance_id:ids.runtime,fencing_token:7,status:'active',expires_at:'2099-01-01T00:00:00Z',metadata:JSON.stringify({port:45555})})
 await insert(f,'connector_instances',{connector_instance_id:ids.connector,agent_id:'fixture-agent',runtime_instance_id:ids.runtime,provider:'discord',metadata:JSON.stringify({nested:{pid:1234}})})
 await insert(f,'agent_messages',{id:ids.message,author_id:'fixture-agent',content:'Owner task mentions PID 1234, /tmp/path, port 45555 and codex; keep this text exactly.',message_type:'chat'})
 await insert(f,'message_queue',{agent_id:'fixture-agent',message_id:ids.message,payload:'{"logical_task":"unfinished"}',status:'in_progress',claimed_by:'fixture-owner',claimed_at:'2026-09-21T00:00:00Z',claim_expires_at:'2099-01-01T00:00:00Z',assigned_runtime_instance_id:ids.runtime,claimed_runtime_instance_id:ids.runtime})
 await insert(f,'outbound_queue',{message_id:ids.message,agent_id:'fixture-agent',channel_external_id:'fixture-channel',content:'Unchanged durable reply.',claimed_runtime_instance_id:ids.runtime})
 await insert(f,'worker_activity',{activity_id:ids.activity,agent_id:'fixture-agent',runtime_instance_id:ids.runtime,lease_id:ids.lease,summary:'logical unfinished work'})
 await insert(f,'runtime_memory_ready_evidence',{agent_id:'fixture-agent',project:'fixture-project',runtime_instance_id:ids.runtime,session_name:'old-session',port:45555,expected_agent_id:'fixture-agent',checkout_path:'/historical/workspace',recovery_command:'old command',result_status:'ready',completed_at:'2026-09-21T00:00:00Z',evidence_path:'/old/evidence',valid_until:'2099-01-01T00:00:00Z',source:'fixture',metadata:JSON.stringify({seat_context_receipt:{native_delivery:{provider_pid:1234}}})})
 await insert(f,'audit_log',{event_type:'runtime.cleanup_target',agent_id:'fixture-agent',target:'listener:45555:1234:old',detail:JSON.stringify({pid:1234,actions:[{path:'/old/workspace'}]})})
 await insert(f,'event_log',{event_id:randomUUID(),event_type:'reply.failed',payload:JSON.stringify({kind:'retryable',error:'old /path endpoint 45555'})})
 if(f.kind==='postgres') {
   const a=(await f.query("SELECT desired_revision,desired_digest,desired_release_commit,desired_release_tree FROM agents WHERE agent_id='fixture-agent'"))[0]
   await insert(f,'aun_configuration_observed_state',{host_id:'historical-host',agent_id:'fixture-agent',observed_revision:a.desired_revision,observed_desired_digest:a.desired_digest,candidate_digest:'c'.repeat(64),release_commit:a.desired_release_commit,release_tree:a.desired_release_tree,provider_native_digest:'d'.repeat(64),launchagent_plist_digest:'e'.repeat(64),launchctl_environment_digest:'f'.repeat(64),runtime_identity_digest:'1'.repeat(64),reconcile_status:'READY',lease_id:ids.lease,fencing_token:7})
   await insert(f,'aun_configuration_restart_requests',{host_id:'historical-host',agent_id:'fixture-agent',to_revision:a.desired_revision,to_digest:a.desired_digest,candidate_digest:'c'.repeat(64),rollback_artifact_digest:'d'.repeat(64),exact_release_commit:a.desired_release_commit,exact_release_tree:a.desired_release_tree,exact_control_refs:'["fixture:owner"]',lease_id:ids.lease,fencing_token:7,restart_budget:1})
 }
 return ids
}
export async function snapshot(f:Fixture) {
 const out:Record<string,unknown>={}
 for(const table of ['agents','agent_workspaces','agent_runtime_instances','control_plane_leases','connector_instances','agent_messages','message_queue','outbound_queue','worker_activity','runtime_memory_ready_evidence','audit_log','event_log',...(f.kind==='postgres'?['aun_configuration_desired_outbox','aun_configuration_observed_state','aun_configuration_restart_requests']:[])]) {
   const rows=await f.query(`SELECT * FROM ${table}`);out[table]=rows.map(r=>JSON.stringify(r)).sort()
 }
 return out
}
