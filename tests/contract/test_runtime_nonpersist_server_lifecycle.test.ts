import { test, expect } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'
import { receiveTargeted } from '../../bin/aun/receive'
import { bootstrapInternal, type BootstrapStageContext } from '../../bin/aun/bootstrap'
import { restartSql } from '../helpers/configuration-contract-fixture'
import { execFileSync } from 'node:child_process'
import { resolveRuntimeEndpoint } from '../../core/runtime-endpoint'

test('NP11/AC-CFG-3 compatible B3 profile → managed start → fresh READY/idempotent READY → restart and claim recovery with no physical writes', async () => {
  const f=await fixture('postgres',false), agent=`boot-${randomUUID()}`
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-server-')))
  const url=new URL(process.env.AGENT_COM_TEST_DATABASE_URL!);url.pathname='/'+f.name
  const db={async query(sql:string,params?:unknown[]){return {rows:await f.query(sql,params)}}}
  const children:Array<ReturnType<typeof Bun.spawn>>=[]
  const logs:Array<Promise<string>>=[]
  try {
    await f.apply();await f.exec(restartSql)
    const repoRoot=join(import.meta.dir,'../..'),repoHead=execFileSync('git',['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8'}).trim()
    const env={PATH:process.env.PATH!,HOME:dir,CODEX_HOME:join(dir,'.codex'),TMPDIR:dir,LANG:'C',DATABASE_URL:url.href,AGENT_COM_DB:'postgres',
      AGENT_ID:agent,AGENT_COM_EXPECTED_AGENT_ID:agent,AGENT_COM_WORKSPACE:dir,AUN_BOOTSTRAP_STATE_ROOT:join(dir,'bootstrap-state')}
    mkdirSync(env.CODEX_HOME)
    const nativeRun=bootstrapInternal.defaultCommandRunner()
    // tmux presence is the only fixture command; profile/gits/OS/DB are real.
    const run:any=async(command:string,args:string[],options:any)=>{
      if(command==='tmux')return {exitCode:0,stdout:'isolated-session',stderr:''}
      const result=await nativeRun(command,args,options)
      if(result.exitCode!==0)console.log(JSON.stringify({case:'NP11-command-failure',command,args,stdout:result.stdout,stderr:result.stderr}))
      return result
    }
    const ports=bootstrapInternal.createDefaultPorts({run,env,home:dir,repoRoot})
    const context={runId:`bootstrap-${randomUUID()}`,agentId:agent,requestedRuntime:'codex',resolvedRuntime:'codex',repoRoot,workspaceRoot:dir,
      repoHead,env,dryRun:false,priorState:{mutations:[],terminal_status:null}} as unknown as BootstrapStageContext
    const b3=await ports.ensureAgentProfile(context)
    expect(b3.ok,JSON.stringify(b3)).toBe(true)
    expect(b3.readinessPredicates?.configuration_desired_state_ready).toBe(true)
    context.priorState.mutations=(b3.mutations??[]) as any
    const desired=(await f.query('SELECT desired_release_commit,desired_release_tree,ordinary_projection FROM agents WHERE agent_id=$1',[agent]))[0]
    expect(desired.desired_release_commit).toBe(repoHead)
    expect(desired.desired_release_tree).toBe(execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repoRoot,encoding:'utf8'}).trim())
    expect(JSON.stringify(desired.ordinary_projection)).not.toContain(dir)
    const b3Again=await ports.ensureAgentProfile(context)
    expect(b3Again.ok,JSON.stringify(b3Again)).toBe(true)
    expect(b3Again.mutations).toEqual([])
    // A synthetic provider parent executes the real managed entry and server.
    // It has no account, token, provider CLI, or outbound adapter configuration.
    copyFileSync(process.execPath,join(dir,'codex'))
    writeFileSync(join(dir,'config.json'),JSON.stringify({agent_id:agent,channels:{},auth:{mode:'off'}}))
    writeFileSync(join(dir,'provider.ts'),`const p=Bun.spawn([${JSON.stringify(process.execPath)},'--no-env-file',${JSON.stringify(join(import.meta.dir,'../../entrypoints/runtime.ts'))}],{cwd:process.cwd(),env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>p.kill(s));process.exit(await p.exited);`)
    const start=async()=>{
      const p=Bun.spawn([join(dir,'codex'),'--no-env-file',join(dir,'provider.ts')],{cwd:dir,
        env:{...env,
          AGENT_ID:agent,AGENT_COM_EXPECTED_AGENT_ID:agent,AGENT_COM_WORKSPACE:dir,AGENT_COMMS_CONFIG:join(dir,'config.json'),
          AGENT_COM_PG_NOTIFY:'false',TTL_SWEEP_DISABLED:'1',AGENT_COM_LEGACY_DISCORD_GATEWAY:'0'},
        stdin:'pipe',stdout:'pipe',stderr:'pipe'})
      children.push(p);logs.push(new Response(p.stderr).text())
      p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'isolated-lifecycle',version:'1'}}})+'\n')
      let lease:any
      for(let i=0;i<100;i++) {
        lease=(await f.query("SELECT * FROM control_plane_leases WHERE holder_agent_id=$1 AND lease_purpose='worker' AND status='active'",[agent]))[0]
        if(lease)break
        if(p.exitCode!==null)throw Error('SERVER_START_FAILED:'+await logs.at(-1))
        await Bun.sleep(100)
      }
      expect(lease).toBeDefined()
      const fresh=await resolveRuntimeEndpoint(db,{agentId:agent})
      expect(fresh.ok).toBe(true)
      if(!fresh.ok)throw Error(fresh.code)
      expect(fresh.endpoint.runtimeInstanceId).toBe(lease.holder_runtime_instance_id)
      return {p,lease}
    }
    const stop=async(p:ReturnType<typeof Bun.spawn>)=>{
      p.kill('SIGTERM')
      const code=await Promise.race([p.exited,Bun.sleep(10000).then(()=>{throw Error('SERVER_STOP_TIMEOUT')})])
      if(code!==0)console.log(JSON.stringify({case:'server-shutdown-failure',stderr:await logs.at(-1)}))
      expect(code).toBe(0)
    }
    const first=await start()
    // Exercise the exact transaction used by B8. Its preceding platform-native
    // plist/MCP readbacks remain fixture evidence; runtime/account observations here are real.
    const nativeReadback={providerNativeDigest:'a'.repeat(64),launchagentPlistDigest:'b'.repeat(64),launchctlEnvironmentDigest:'c'.repeat(64),runtimeIdentityDigest:'d'.repeat(64)}
    await f.exec('DROP TABLE aun_configuration_observed_state')
    const ready=await ports.recordBootstrapConfigurationReady(context,nativeReadback)
    expect(ready?.idempotent).toBe(false);expect(ready?.outboxEventId).toBeTruthy()
    const delivered=(await f.query('SELECT delivered_at,attempt_count FROM aun_configuration_desired_outbox WHERE event_id=$1',[ready!.outboxEventId]))[0]
    expect(delivered.delivered_at).not.toBeNull();expect(delivered.attempt_count).toBe(1)
    for(const status of ['READY','IDEMPOTENT_READY'] as const) {
      context.priorState.terminal_status=status
      expect((await ports.recordBootstrapConfigurationReady(context,nativeReadback))?.idempotent).toBe(true)
    }
    await stop(first.p)
    await expect(ports.recordBootstrapConfigurationReady(context,nativeReadback)).rejects.toThrow('CONFIGURATION_CURRENT_RUNTIME_UNAVAILABLE')
    expect((await f.query('SELECT status FROM control_plane_leases WHERE lease_id=$1',[first.lease.lease_id]))[0].status).toBe('released')
    const channel=randomUUID(),message=randomUUID()
    await insert(f,'channels',{id:channel,name:'restart claim recovery',members:[agent]})
    await insert(f,'agent_messages',{id:message,author_id:agent,channel_id:channel,content:'preserve unfinished work',message_type:'instruction'})
    await insert(f,'message_queue',{agent_id:agent,message_id:message,status:'received',
      payload:JSON.stringify({content:'preserve unfinished work',message_type:'instruction'}),claimed_by:agent,
      claimed_runtime_instance_id:first.lease.holder_runtime_instance_id,claimed_at:'2026-01-01T00:00:00Z',claim_expires_at:'2026-01-01T00:01:00Z'})
    const second=await start()
    expect(second.lease.holder_runtime_instance_id).not.toBe(first.lease.holder_runtime_instance_id)
    let recovered:any
    for(let i=0;i<100;i++) {
      recovered=(await f.query('SELECT id,status,payload FROM message_queue WHERE message_id=$1',[message]))[0]
      if(recovered.status==='pending')break
      await Bun.sleep(50)
    }
    expect(recovered.status).toBe('pending')
    expect(JSON.parse(recovered.payload).content).toBe('preserve unfinished work')
    const received=await receiveTargeted({agentId:agent,queueId:String(recovered.id),env:{PATH:process.env.PATH,DATABASE_URL:url.href,
      AGENT_COM_DB:'postgres',AGENT_ID:agent,AGENT_COM_EXPECTED_AGENT_ID:agent,AGENT_COM_RUNTIME_INSTANCE_ID:second.lease.holder_runtime_instance_id}})
    expect(received.ok,received.stderr+received.stdout).toBe(true)
    expect((await f.query('SELECT claimed_runtime_instance_id FROM message_queue WHERE id=$1',[recovered.id]))[0].claimed_runtime_instance_id)
      .toBe(second.lease.holder_runtime_instance_id)
    await stop(second.p)
    expect((await f.query("SELECT count(*)::int n FROM control_plane_leases WHERE status='active'"))[0].n).toBe(0)
    expect((await f.query('SELECT runtime,status,status_detail,home_directory,channel_port,last_seen_at FROM agents WHERE agent_id=$1',[agent]))[0])
      .toEqual({runtime:null,status:null,status_detail:null,home_directory:null,channel_port:null,last_seen_at:null})
    const anchors=await f.query('SELECT process_id,port,host_id,session_name,checkout_path,endpoint_uri,status FROM agent_runtime_instances WHERE agent_id=$1',[agent])
    expect(anchors.length).toBe(2)
    for(const row of anchors)expect(Object.values(row).every(value=>value===null)).toBe(true)
    const undoReady=await ports.rollbackMutation(context,{kind:'configuration',owner_key:`configuration:${context.runId}:${agent}`,
      rollback_payload:{agent_id:agent,desired_revision:ready!.desiredRevision,desired_digest:ready!.desiredDigest,outbox_event_id:ready!.outboxEventId}} as any)
    expect(undoReady.ok).toBe(true)
    const undoB3=await ports.rollbackMutation(context,context.priorState.mutations.find(m=>m.kind==='configuration_desired')!)
    expect(undoB3.ok,JSON.stringify(undoB3)).toBe(true)
    expect(undoB3.readinessPredicates?.trigger_disable_count).toBe(0)
    const output=await Promise.all(logs)
    expect(output.every(log=>log.includes('registered with logical identity'))).toBe(true)
    expect(output.join('\n')).not.toContain('RUNTIME_OBSERVATION_PERSISTENCE_FORBIDDEN')
    console.log(JSON.stringify({case:'NP11-AC-CFG-3',b3:1,b3_idempotent:1,compatible_release_head:repoHead,ready:1,idempotent_ready:2,missing_runtime_ready_denied:1,observation_table_accesses:0,logical_b3_rollback:1,starts:2,stops:2,restarts:1,recovered_claims:1,provider_invocations:0,external_sends:0,stderr:output}))
  } finally {
    for(const p of children)if(p.exitCode===null){p.kill('SIGTERM');await p.exited}
    rmSync(dir,{recursive:true,force:true});await f.close()
  }
},60000)
