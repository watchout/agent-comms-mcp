import { symlinkSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { inspectHostRuntime } from '../../core/host-runtime-observer'
import { durableRuntimeMetadata } from '../../core/runtime-durable-data'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { observeSeatProvider } from '../../core/seat-runtime-selection'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'
import { recordVerifiedNativeRuntimeMemoryReady } from '../../core/runtime-memory-ready'

// Cross-repository integration uses the explicitly selected, built Was candidate.
// Only the harmless Node host's provider classification is injected. PID/start,
// parentage, held socket, native stdout pipe, stored hook receipt and MCP are real.
const nativeHosts: Array<ReturnType<typeof Bun.spawn>> = []
let preparedWas: Promise<string> | undefined
async function nativeFixtureSource(): Promise<string> {
  const explicit = process.env.AUN_TEST_WASUREZU_ROOT
  if (explicit) {
    if (!existsSync(join(explicit, 'dist/native-context-delivery.js'))) throw new Error('AUN_TEST_WASUREZU_ROOT_BUILT_CANDIDATE_REQUIRED')
    return explicit
  }
  if (!preparedWas) preparedWas = (async () => {
    const parent = process.env.RUNNER_TEMP
    if (process.env.CI !== 'true' || !parent || !isAbsolute(parent) || !existsSync(parent)) {
      throw new Error('EXPLICIT_PRIVATE_CI_NATIVE_FIXTURE_PARENT_REQUIRED')
    }
    const output = join(mkdtempSync(join(realpathSync(parent), 'aun-native-supply-')), 'built-root')
    const child = Bun.spawn(['bash', join(import.meta.dir, '../../scripts/prepare-seat-continuity-test-wasurezu.sh')], {
      env: {...process.env, AUN_TEST_WASUREZU_OUTPUT: output}, stdout: 'inherit', stderr: 'inherit',
    })
    if (await child.exited !== 0) throw new Error('PINNED_NATIVE_FIXTURE_BUILD_FAILED')
    const root = readFileSync(output, 'utf8').trim()
    if (!isAbsolute(root) || !existsSync(join(root, 'dist/native-context-delivery.js'))) throw new Error('PINNED_NATIVE_FIXTURE_BUILD_OUTPUT_INVALID')
    return root
  })()
  return preparedWas
}
/** A report becomes readable only after its complete bytes have been closed. */
export function publishNativeFixtureReport(report: string, payload: unknown,
  io = {openSync, writeFileSync, closeSync, renameSync, rmSync}) {
  const staging = `${report}.pending`
  let fd: number | null = io.openSync(staging, 'wx', 0o600)
  try {
    io.writeFileSync(fd, JSON.stringify(payload))
    io.closeSync(fd)
    fd = null
    io.renameSync(staging, report)
  } finally {
    if (fd !== null) io.closeSync(fd)
    io.rmSync(staging, {force: true})
  }
}

export async function nativeHostFixture(home:string,workspace:string,agent:string,project:string,session:string,mode:'accepted'|'pending'|'absent'='accepted',runtimeId:string=randomUUID()) {
  const was = await nativeFixtureSource()
  const node=execFileSync('which',['node'],{encoding:'utf8'}).trim()
  const modules=join(was,'dist'),sdk=join(was,'node_modules/@modelcontextprotocol/sdk/dist/esm')
  const fixtureProvider=join(home,'codex');symlinkSync(realpathSync(node),fixtureProvider)
  const holder=join(home,'server.ts'),memory=join(home,'native-memory.mjs'),hook=join(home,'native-hook.mjs'),host=join(home,'native-host.mjs'),report=join(home,'native-host.json')
  const memoryEnv={TZ:'UTC',AGENT_MEMORY_DB_TYPE:'sqlite',AGENT_MEMORY_DB_PATH:join(home,'memory.db'),AGENT_MEMORY_AGENT_ID:agent,AGENT_MEMORY_PROJECT:project}
  writeFileSync(holder,"const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});console.log(JSON.stringify({pid:process.pid,port:server.port}));")
  writeFileSync(memory,`
    import {writeFileSync as writeDiagnostic} from 'node:fs';
    process.on('uncaughtException',error=>{writeDiagnostic(${JSON.stringify(join(home,'native-mcp.err'))},String(error));process.exit(1)});
    import {McpServer} from ${JSON.stringify(join(sdk,'server/mcp.js'))};
    import {StdioServerTransport} from ${JSON.stringify(join(sdk,'server/stdio.js'))};
    import {registerNativeContextDeliveryTool,observeNativeProcess} from ${JSON.stringify(join(modules,'native-context-delivery.js'))};
    import {SqliteStore} from ${JSON.stringify(join(modules,'stores/sqlite-store.js'))};
    const store=new SqliteStore(process.env.AGENT_MEMORY_DB_PATH);await store.initialize();
    const server=new McpServer({name:'native-boundary-fixture',version:'1'});
    registerNativeContextDeliveryTool(server,store,process.env.AGENT_MEMORY_AGENT_ID,()=>observeNativeProcess(Number(process.env.FIXTURE_PROVIDER_PID)));
    await server.connect(new StdioServerTransport());
    writeDiagnostic(${JSON.stringify(join(home,'native-mcp-ready-'))}+process.pid,'connected');
  `)
  writeFileSync(hook,`
    import {beginNativeContextAttempt,nativeAttemptSeed,observeNativeProcess,writeNativeContextResult} from ${JSON.stringify(join(modules,'native-context-delivery.js'))};
    import {runCodexSessionStart,resolveCodexStoreBinding} from ${JSON.stringify(join(modules,'codex-session-start.js'))};
    const binding={agent_id:${JSON.stringify(agent)},project:${JSON.stringify(project)},workspace:${JSON.stringify(workspace)},binding_source_ref:'fixture:trusted-invocation',max_tokens:1800,max_bytes:8192,timeout_ms:5000};
    const raw=JSON.stringify({session_id:${JSON.stringify(session)},cwd:binding.workspace,transcript_path:'/missing/fixture.jsonl',model:'fixture',permission_mode:'default',hook_event_name:'SessionStart',source:'startup'});
    const seed=nativeAttemptSeed({binding,rawInput:raw,runtime:'codex',storeBinding:resolveCodexStoreBinding(),adapter:{id:'native-pipe-fixture',version:'1'}});
    const target={schema_version:'kusabi-runtime-event-target/v1',manifest_id:'native-pipe-fixture',build:{commit_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),artifact_sha256:'c'.repeat(64)},configuration:{config_sha256:'d'.repeat(64),trust_fingerprint_sha256:'e'.repeat(64)},storage:{backend:'sqlite',binding_sha256:seed.store_binding.binding_sha256}};
    const observe=()=>observeNativeProcess(process.ppid);
    if(${JSON.stringify(mode)}==='absent')process.exit(0);
    const handle=await beginNativeContextAttempt({evidence:seed,runtime:'codex',observeAncestor:observe,emission:{target,timeoutMs:5000}});
    if(${JSON.stringify(mode)}==='pending')process.exit(0);
    const result=await runCodexSessionStart(raw,binding);
    const receipt=await writeNativeContextResult({result,runtime:'codex',handle,observeProvider:observe});
    if(!receipt)throw new Error('native receipt missing:'+JSON.stringify({handle,evidence:result.evidence,work:result.native_work_digest}));
  `)
  writeFileSync(host,`
    import {spawn} from 'node:child_process';import {openSync,writeFileSync,closeSync,renameSync,rmSync,existsSync} from 'node:fs';
    const publishNativeFixtureReport = ${publishNativeFixtureReport.toString()};
    import {SqliteStore} from ${JSON.stringify(join(modules,'stores/sqlite-store.js'))};
    import {observeNativeProcess} from ${JSON.stringify(join(modules,'native-context-delivery.js'))};
    const store=new SqliteStore(process.env.AGENT_MEMORY_DB_PATH);await store.initialize();
    await store.saveTaskState({agent_id:${JSON.stringify(agent)},project:${JSON.stringify(project)},task:'Continue the stable seat task',status:'in_progress',progress:'checkpoint',next_steps:'Run the next bounded fixture step'});await store.close();
    console.error('fixture:store-ready');const children=[];process.on('exit',()=>children.forEach(c=>c.kill()));process.on('SIGTERM',()=>process.exit(0));
    const env={...process.env,FIXTURE_PROVIDER_PID:String(process.pid)};
    const held=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(holder)}],{cwd:${JSON.stringify(workspace)},env:{...env,AGENT_ID:${JSON.stringify(agent)},AGENT_COM_EXPECTED_AGENT_ID:${JSON.stringify(agent)},CODEX_THREAD_ID:${JSON.stringify(session)}},stdio:['ignore','pipe','inherit']});children.push(held);
    const endpoint=await new Promise((resolve,reject)=>{held.stdout.once('data',d=>resolve(JSON.parse(String(d))));held.once('error',reject)});
    console.error('fixture:endpoint-ready');const native=spawn(process.execPath,[${JSON.stringify(hook)}],{cwd:${JSON.stringify(workspace)},env,stdio:['ignore','pipe','inherit']});children.push(native);
    let content='';native.stdout.on('data',d=>{content+=d.toString()});
    await new Promise((resolve,reject)=>native.on('exit',code=>code===0?resolve():reject(new Error('native hook failed'))));
    if(${JSON.stringify(mode)}==='accepted'&&(!content.includes('Continue the stable seat task')||!content.includes('Run the next bounded fixture step')))throw new Error('actual host input missing');
    console.error('fixture:hook-complete');const connected=spawn(process.execPath,[${JSON.stringify(memory)}],{cwd:${JSON.stringify(workspace)},env,stdio:['pipe','pipe','inherit']});children.push(connected);
    const ready=${JSON.stringify(join(home,'native-mcp-ready-'))}+connected.pid;
    for(let i=0;!existsSync(ready)&&i<200;i++){if(connected.exitCode!==null)throw new Error('connected native MCP initialization failed');await new Promise(resolve=>setTimeout(resolve,25))}
    if(!existsSync(ready))throw new Error('connected native MCP initialization timeout');
    publishNativeFixtureReport(${JSON.stringify(report)},{endpoint,provider:observeNativeProcess(process.pid),connected:connected.pid,content});
  `)
  const child=Bun.spawn([fixtureProvider,host],{cwd:workspace,env:{PATH:process.env.PATH!,LANG:'C',TMPDIR:home,CODEX_HOME:home,CODEX_THREAD_ID:session,AGENT_COM_RUNTIME_INSTANCE_ID:runtimeId,AGENT_COM_WORKSPACE:workspace,AGENT_COM_RUNTIME_SESSION:session,...memoryEnv},stdout:'ignore',stderr:Bun.file(join(home,'native-host.err'))})
  nativeHosts.push(child)
  for(let i=0;!existsSync(report)&&i<200;i++) {if(child.exitCode!==null)throw new Error(readFileSync(join(home,'native-host.err'),'utf8'));await Bun.sleep(50)}
  if(!existsSync(report))throw new Error('native fixture startup timeout: '+readFileSync(join(home,'native-host.err'),'utf8'))
  const observed=JSON.parse(readFileSync(report,'utf8'))
  const observeProvider:typeof observeSeatProvider=(input)=>{
    const ppid=Number(execFileSync('ps',['-p',String(input.processId),'-o','ppid='],{encoding:'utf8'}).trim())
    const started=new Date(execFileSync('ps',['-p',String(observed.provider.pid),'-o','lstart='],{encoding:'utf8',env:{PATH:process.env.PATH!,LANG:'C',TZ:'UTC'}}).trim()+' UTC').toISOString()
    if(ppid!==observed.provider.pid||started!==observed.provider.startedAt)return null
    const actualEnv=execFileSync('ps',['eww','-p',String(input.processId),'-o','command='],{encoding:'utf8'})
    return observeSeatProvider({...input,providerStartedAt:started,processes:[{pid:input.processId,ppid,command:actualEnv},{pid:ppid,ppid:1,command:'fixture/codex'}]})
  }
  return {runtimeId,inspect:inspectHostRuntime,node,memory,env:{...memoryEnv,FIXTURE_PROVIDER_PID:String(observed.provider.pid)},observed,observeProvider}
}

export async function registerNativeFixtureRuntime(db:PgAdapter|SqliteAdapter,fixture:Awaited<ReturnType<typeof nativeHostFixture>>,agent:string,project:string,session:string,workspace:string,id:string) {
  if(id!==fixture.runtimeId)throw new Error('FIXTURE_UUID_MUST_BE_BOUND_BEFORE_EXEC')
  const seen=inspectHostRuntime({agentId:agent,runtimeInstanceId:id,logicalWorkspace:workspace})
  if(seen.reasonCode!=='OBSERVED'||seen.observations.length!==1) throw new Error('fixture process observation unavailable:'+seen.reasonCode)
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind,runtime_engine,status,started_at,metadata)
    VALUES($1,$2,'local_process',NULL,NULL,NULL,$3) ON CONFLICT(runtime_instance_id) DO NOTHING`,
    [id,agent,JSON.stringify(durableRuntimeMetadata({source_commit:'a'.repeat(40)}))])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at,metadata)
    VALUES($1,'runtime_instance',$5,'worker',$2,$1,1,'active',clock_timestamp(),$3,$4) ON CONFLICT(lease_id) DO NOTHING`,
    [id,agent,new Date(Date.now()+1800000).toISOString(),JSON.stringify(durableRuntimeMetadata()),id])

}

export async function stopNativeFixtures() {
  while (nativeHosts.length) { const child=nativeHosts.pop()!; child.kill(); await child.exited }
}

/** Queue caller fixtures obtain readiness through actual native input and the normal verifier. */
export async function createReadyNativeRuntime(dbPath:string,home:string,agent:string,runtimeId:string) {
  const db=new SqliteAdapter(dbPath)
  try { return await createReadyNativeRuntimeWithDb(db,home,agent,runtimeId) }
  finally {await db.close()}
}

export async function createReadyNativeRuntimeWithDb(db:PgAdapter|SqliteAdapter,home:string,agent:string,runtimeId:string) {
  const project='agent-comms-mcp',session=`${agent}-session`
  const workspace=realpathSync(home)
  const fixture=await nativeHostFixture(home,workspace,agent,project,session,'accepted',runtimeId)
  await registerNativeFixtureRuntime(db,fixture,agent,project,session,workspace,runtimeId)
  const receipt=await readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:runtimeId,
    targetRuntime:'codex',providerPid:fixture.observed.provider.pid,providerStartedAt:fixture.observed.provider.startedAt,
    hostSessionId:session,transport:{command:fixture.node,args:[fixture.memory],env:fixture.env},env:{PATH:process.env.PATH!,LANG:'C',...fixture.env},cwd:workspace}).catch(error=>{
    const diagnostic=join(home,'native-mcp.err');if(existsSync(diagnostic))throw new Error(`native fixture MCP: ${readFileSync(diagnostic,'utf8')}`);throw error
  })
  await recordVerifiedNativeRuntimeMemoryReady(db,{agentId:agent,project,runtimeInstanceId:runtimeId,receipt,observeProvider:fixture.observeProvider,inspect:fixture.inspect,readNativeProof:async()=>readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:runtimeId,targetRuntime:'codex',providerPid:fixture.observed.provider.pid,providerStartedAt:fixture.observed.provider.startedAt,hostSessionId:session,transport:{command:fixture.node,args:[fixture.memory],env:fixture.env},env:{PATH:process.env.PATH!,LANG:'C',...fixture.env},cwd:workspace})})
  return fixture
}
