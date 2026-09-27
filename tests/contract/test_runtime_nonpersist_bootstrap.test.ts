import { test, expect } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { migrateSqlite } from '../../db/migrate-sqlite'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { bootstrapInternal, type BootstrapStageContext } from '../../bin/aun/bootstrap'
import { nativeHostFixture, registerNativeFixtureRuntime, stopNativeFixtures } from '../helpers/seat-native-runtime-fixture'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'

test('NP01/07 B5 creates sealed and ordinary native readiness from a NULL physical anchor and preserves the seat',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-bootstrap-'))),file=join(dir,'aun.db')
 const agent=`np-b5-${randomUUID()}`,project='np-b5-project',id=randomUUID(),session=`np-session-${randomUUID()}`
 migrateSqlite(file);const db=new SqliteAdapter(file)
 try {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,profile_enabled,metadata) VALUES($1,$1,'dev',1,$2)`,[agent,JSON.stringify({memory_project:project})])
  const native=await nativeHostFixture(dir,dir,agent,project,session,'accepted',id)
  await registerNativeFixtureRuntime(db,native,agent,project,session,dir,id)
  const before=await db.query('SELECT * FROM agents')
  const profile=(await db.query<any>('SELECT * FROM agents'))[0]
  const env={PATH:process.env.PATH!,LANG:'C',AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:file,AGENT_MEMORY_PROJECT:project,
    AUN_BOOTSTRAP_PROVIDER_PID:String(native.observed.provider.pid)}
  const readProof=async(input:{runtimeInstanceId:string})=>readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:input.runtimeInstanceId,targetRuntime:'codex',
    providerPid:native.observed.provider.pid,providerStartedAt:native.observed.provider.startedAt,hostSessionId:session,
    transport:{command:native.node,args:[native.memory],env:native.env},cwd:dir,env:{PATH:process.env.PATH!,LANG:'C',...native.env}})
  const run:any=async(command:string,args:string[])=>{
    if(command===process.execPath && args.join(' ').includes('agent profile get'))return {exitCode:0,stdout:JSON.stringify({profile}),stderr:''}
    if(command==='codex' && args.slice(0,2).join(' ')==='mcp get')return {exitCode:0,stdout:JSON.stringify({enabled:true,transport:{type:'stdio',command:native.node,args:[native.memory],env:native.env}}),stderr:''}
    throw new Error('Unexpected bootstrap fixture command: '+command+' '+args.join(' '))
  }
  const ports=bootstrapInternal.createDefaultPorts({run,env,home:dir,repoRoot:dir,observeProvider:native.observeProvider,readNativeProof:readProof})
  const context={runId:`bootstrap-${randomUUID()}`,agentId:agent,requestedRuntime:'codex',resolvedRuntime:'codex',repoRoot:dir,workspaceRoot:dir,
    repoHead:'a'.repeat(40),env,dryRun:false,priorState:{mutations:[]}} as BootstrapStageContext
  const result=await ports.ensureMemoryReadiness(context)
  if(!result.ok)console.log(JSON.stringify(result))
  expect(result.ok).toBe(true)
  expect(await db.query('SELECT * FROM agents')).toEqual(before)
  const runtimes=await db.query<any>('SELECT * FROM agent_runtime_instances')
  expect(runtimes).toHaveLength(2)
  for(const runtime of runtimes)for(const key of ['process_id','port','runtime_engine','session_name','checkout_path','status'])expect(runtime[key]).toBeNull()
  const evidence=await db.query<any>('SELECT * FROM runtime_memory_ready_evidence')
  expect(evidence).toHaveLength(2)
  for(const row of evidence)expect(JSON.parse(row.metadata).seat_context_proof.runtime_instance_id).toBe(row.runtime_instance_id)
  expect(JSON.stringify(evidence)).not.toContain(dir)
 }finally{await stopNativeFixtures();await db.close();rmSync(dir,{recursive:true,force:true})}
},60000)
