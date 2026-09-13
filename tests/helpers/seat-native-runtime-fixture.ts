import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
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
export async function nativeHostFixture(home:string,workspace:string,agent:string,project:string,session:string,mode:'accepted'|'pending'|'absent'='accepted') {
  const was = await nativeFixtureSource()
  const node=execFileSync('which',['node'],{encoding:'utf8'}).trim()
  const modules=join(was,'dist'),sdk=join(was,'node_modules/@modelcontextprotocol/sdk/dist/esm')
  const holder=join(home,'held-endpoint.ts'),memory=join(home,'native-memory.mjs'),hook=join(home,'native-hook.mjs'),host=join(home,'native-host.mjs'),report=join(home,'native-host.json')
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
    import {spawn} from 'node:child_process';import {writeFileSync,existsSync} from 'node:fs';
    import {SqliteStore} from ${JSON.stringify(join(modules,'stores/sqlite-store.js'))};
    import {observeNativeProcess} from ${JSON.stringify(join(modules,'native-context-delivery.js'))};
    const store=new SqliteStore(process.env.AGENT_MEMORY_DB_PATH);await store.initialize();
    await store.saveTaskState({agent_id:${JSON.stringify(agent)},project:${JSON.stringify(project)},task:'Continue the stable seat task',status:'in_progress',progress:'checkpoint',next_steps:'Run the next bounded fixture step'});await store.close();
    const children=[];process.on('exit',()=>children.forEach(c=>c.kill()));process.on('SIGTERM',()=>process.exit(0));
    const env={...process.env,FIXTURE_PROVIDER_PID:String(process.pid)};
    const held=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(holder)}],{cwd:${JSON.stringify(workspace)},env:{...env,AGENT_ID:${JSON.stringify(agent)},AGENT_COM_EXPECTED_AGENT_ID:${JSON.stringify(agent)},CODEX_THREAD_ID:${JSON.stringify(session)}},stdio:['ignore','pipe','inherit']});children.push(held);
    const endpoint=await new Promise((resolve,reject)=>{held.stdout.once('data',d=>resolve(JSON.parse(String(d))));held.once('error',reject)});
    const native=spawn(process.execPath,[${JSON.stringify(hook)}],{cwd:${JSON.stringify(workspace)},env,stdio:['ignore','pipe','inherit']});children.push(native);
    let content='';native.stdout.on('data',d=>{content+=d.toString()});
    await new Promise((resolve,reject)=>native.on('exit',code=>code===0?resolve():reject(new Error('native hook failed'))));
    if(${JSON.stringify(mode)}==='accepted'&&(!content.includes('Continue the stable seat task')||!content.includes('Run the next bounded fixture step')))throw new Error('actual host input missing');
    const connected=spawn(process.execPath,[${JSON.stringify(memory)}],{cwd:${JSON.stringify(workspace)},env,stdio:['pipe','pipe','inherit']});children.push(connected);
    const ready=${JSON.stringify(join(home,'native-mcp-ready-'))}+connected.pid;
    for(let i=0;!existsSync(ready)&&i<200;i++){if(connected.exitCode!==null)throw new Error('connected native MCP initialization failed');await new Promise(resolve=>setTimeout(resolve,25))}
    if(!existsSync(ready))throw new Error('connected native MCP initialization timeout');
    writeFileSync(${JSON.stringify(report)},JSON.stringify({endpoint,provider:observeNativeProcess(process.pid),connected:connected.pid,content}));
  `)
  const child=Bun.spawn([node,host],{cwd:workspace,env:{PATH:process.env.PATH!,HOME:home,...memoryEnv},stdout:'ignore',stderr:Bun.file(join(home,'native-host.err'))})
  nativeHosts.push(child)
  for(let i=0;!existsSync(report)&&i<200;i++) {if(child.exitCode!==null)throw new Error(readFileSync(join(home,'native-host.err'),'utf8'));await Bun.sleep(50)}
  if(!existsSync(report))throw new Error('native fixture startup timeout')
  const observed=JSON.parse(readFileSync(report,'utf8'))
  const observeProvider:typeof observeSeatProvider=(input)=>{
    const ppid=Number(execFileSync('ps',['-p',String(input.processId),'-o','ppid='],{encoding:'utf8'}).trim())
    const started=new Date(execFileSync('ps',['-p',String(observed.provider.pid),'-o','lstart='],{encoding:'utf8',env:{...process.env,TZ:'UTC'}}).trim()+' UTC').toISOString()
    if(ppid!==observed.provider.pid||started!==observed.provider.startedAt)return null
    const actualEnv=execFileSync('ps',['eww','-p',String(input.processId),'-o','command='],{encoding:'utf8'})
    return observeSeatProvider({...input,providerStartedAt:started,processes:[{pid:input.processId,ppid,command:actualEnv},{pid:ppid,ppid:1,command:'fixture/codex'}]})
  }
  return {node,memory,env:{...memoryEnv,FIXTURE_PROVIDER_PID:String(observed.provider.pid)},observed,observeProvider}
}

export async function registerNativeFixtureRuntime(db:PgAdapter|SqliteAdapter,fixture:Awaited<ReturnType<typeof nativeHostFixture>>,agent:string,project:string,session:string,workspace:string,id:string) {
  const endpoint=fixture.observed.endpoint,uri=`http://127.0.0.1:${endpoint.port}`
  const observation=fixture.observeProvider({agentId:agent,runtimeInstanceId:id,processId:endpoint.pid,sessionName:session,workspace,hostId:hostname()})
  if(!observation)throw new Error('fixture process observation unavailable')
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_engine,runtime_kind,host_id,session_name,process_id,port,endpoint_uri,checkout_path,commit_sha,status,started_at,last_seen_at,metadata)
    VALUES($1,$2,'codex','local_process',$3,$4,$5,$6,$7,$8,$9,'active',$10,$12,$11) ON CONFLICT(runtime_instance_id) DO NOTHING`,
    [id,agent,hostname(),session,endpoint.pid,endpoint.port,uri,workspace,'a'.repeat(40),observation.provider_started_at,JSON.stringify({provider_observation:observation}),new Date().toISOString()])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at,metadata)
    VALUES($1,'runtime_instance',$2,'worker',$3,$6,1,'active',$4,$5) ON CONFLICT(lease_id) DO NOTHING`,
    [id,id,agent,new Date(Date.now()+1800000).toISOString(),JSON.stringify({process_id:endpoint.pid,port:endpoint.port,endpoint_uri:uri}),id])
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
  const fixture=await nativeHostFixture(home,workspace,agent,project,session)
  await registerNativeFixtureRuntime(db,fixture,agent,project,session,workspace,runtimeId)
  const receipt=await readNativeSeatContextReceipt({agentId:agent,project,runtimeInstanceId:runtimeId,
    targetRuntime:'codex',providerPid:fixture.observed.provider.pid,providerStartedAt:fixture.observed.provider.startedAt,
    hostSessionId:session,transport:{command:fixture.node,args:[fixture.memory],env:fixture.env},cwd:workspace}).catch(error=>{
    const diagnostic=join(home,'native-mcp.err');if(existsSync(diagnostic))throw new Error(`native fixture MCP: ${readFileSync(diagnostic,'utf8')}`);throw error
  })
  await recordVerifiedNativeRuntimeMemoryReady(db,{agentId:agent,project,runtimeInstanceId:runtimeId,receipt,observeProvider:fixture.observeProvider})
  return fixture
}
