import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrap, bootstrapInternal } from '../../bin/aun/bootstrap'
import type { BootstrapExecutionPorts, BootstrapStageContext } from '../../bin/aun/bootstrap-types'
import { PgAdapter } from '../../core/db/pg-adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import {
  DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID,
  parseStateDaemonLaunchAgentPlist,
  renderStateDaemonLaunchAgentPlist,
  STATE_DAEMON_PLIST_NAME,
  type StateDaemonRestorePlan,
} from '../../core/state-daemon/launchagent'
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../helpers/postgres-test-database'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { observeSeatProvider } from '../../core/seat-runtime-selection'

// Cross-repository integration uses the explicitly selected, built Was candidate.
// Only the harmless Node host's provider classification is injected. PID/start,
// parentage, held socket, native stdout pipe, stored hook receipt and MCP are real.
const nativeHosts: Array<ReturnType<typeof Bun.spawn>> = []
async function nativeHostFixture(home:string,workspace:string,agent:string,project:string,session:string,mode:'accepted'|'pending'|'absent'='accepted') {
  const was = process.env.AUN_TEST_WASUREZU_ROOT
  if (!was || !existsSync(join(was,'dist/native-context-delivery.js'))) throw new Error('AUN_TEST_WASUREZU_ROOT_BUILT_CANDIDATE_REQUIRED')
  const node=execFileSync('which',['node'],{encoding:'utf8'}).trim()
  const modules=join(was,'dist'),sdk=join(was,'node_modules/@modelcontextprotocol/sdk/dist/esm')
  const holder=join(home,'held-endpoint.ts'),memory=join(home,'native-memory.mjs'),hook=join(home,'native-hook.mjs'),host=join(home,'native-host.mjs'),report=join(home,'native-host.json')
  const memoryEnv={AGENT_MEMORY_DB_TYPE:'sqlite',AGENT_MEMORY_DB_PATH:join(home,'memory.db'),AGENT_MEMORY_AGENT_ID:agent,AGENT_MEMORY_PROJECT:project}
  writeFileSync(holder,"const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('fixture')});console.log(JSON.stringify({pid:process.pid,port:server.port}));")
  writeFileSync(memory,`
    import {McpServer} from ${JSON.stringify(join(sdk,'server/mcp.js'))};
    import {StdioServerTransport} from ${JSON.stringify(join(sdk,'server/stdio.js'))};
    import {registerNativeContextDeliveryTool,observeNativeProcess} from ${JSON.stringify(join(modules,'native-context-delivery.js'))};
    import {SqliteStore} from ${JSON.stringify(join(modules,'stores/sqlite-store.js'))};
    const store=new SqliteStore(process.env.AGENT_MEMORY_DB_PATH);await store.initialize();
    const server=new McpServer({name:'native-boundary-fixture',version:'1'});
    registerNativeContextDeliveryTool(server,store,process.env.AGENT_MEMORY_AGENT_ID,()=>observeNativeProcess(Number(process.env.FIXTURE_PROVIDER_PID)));
    await server.connect(new StdioServerTransport());
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
    import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
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
    writeFileSync(${JSON.stringify(report)},JSON.stringify({endpoint,provider:observeNativeProcess(process.pid),connected:connected.pid,content}));
  `)
  const child=Bun.spawn([node,host],{cwd:workspace,env:{PATH:process.env.PATH!,HOME:home,...memoryEnv},stdout:'ignore',stderr:Bun.file(join(home,'native-host.err'))})
  nativeHosts.push(child)
  for(let i=0;!existsSync(report)&&i<200;i++) {if(child.exitCode!==null)throw new Error(readFileSync(join(home,'native-host.err'),'utf8'));await Bun.sleep(50)}
  if(!existsSync(report))throw new Error('native fixture startup timeout')
  const observed=JSON.parse(readFileSync(report,'utf8'))
  const observeProvider:typeof observeSeatProvider=(input)=>{
    const ppid=Number(execFileSync('ps',['-p',String(input.processId),'-o','ppid='],{encoding:'utf8'}).trim())
    const started=new Date(execFileSync('ps',['-p',String(observed.provider.pid),'-o','lstart='],{encoding:'utf8'}).trim()).toISOString()
    if(ppid!==observed.provider.pid||started!==observed.provider.startedAt)return null
    const actualEnv=execFileSync('ps',['eww','-p',String(input.processId),'-o','command='],{encoding:'utf8'})
    return observeSeatProvider({...input,providerStartedAt:started,processes:[{pid:input.processId,ppid,command:actualEnv},{pid:ppid,ppid:1,command:'fixture/codex'}]})
  }
  return {node,memory,env:{...memoryEnv,FIXTURE_PROVIDER_PID:String(observed.provider.pid)},observed,observeProvider}
}

async function registerNativeFixtureRuntime(db:PgAdapter|SqliteAdapter,fixture:Awaited<ReturnType<typeof nativeHostFixture>>,agent:string,project:string,session:string,workspace:string,id:string) {
  const endpoint=fixture.observed.endpoint,uri=`http://127.0.0.1:${endpoint.port}`
  const observation=fixture.observeProvider({agentId:agent,runtimeInstanceId:id,processId:endpoint.pid,sessionName:session,workspace,hostId:hostname()})
  if(!observation)throw new Error('fixture process observation unavailable')
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_engine,runtime_kind,host_id,session_name,process_id,port,endpoint_uri,checkout_path,commit_sha,status,started_at,last_seen_at,metadata)
    VALUES($1,$2,'codex','local_process',$3,$4,$5,$6,$7,$8,$9,'active',$10,now(),$11) ON CONFLICT(runtime_instance_id) DO NOTHING`,
    [id,agent,hostname(),session,endpoint.pid,endpoint.port,uri,workspace,'a'.repeat(40),observation.provider_started_at,JSON.stringify({provider_observation:observation})])
  await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at,metadata)
    VALUES($1,'runtime_instance',$2,'worker',$3,$6,1,'active',$4,$5) ON CONFLICT(lease_id) DO NOTHING`,
    [id,id,agent,new Date(Date.now()+1800000).toISOString(),JSON.stringify({process_id:endpoint.pid,port:endpoint.port,endpoint_uri:uri}),id])
}

const roots: string[] = []
const postgresDatabases: PostgresTestDatabase[] = []
const launchctlSafePrint = (pid: number) => `pid = ${pid}
SHIRUBE_D1_ENABLED => 0
SHIRUBE_D1_KILL_SWITCH => 1
SHIRUBE_D1_TARGET_ALLOWLIST => []
STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED => 0
`
afterEach(async () => {
  while(nativeHosts.length) {const child=nativeHosts.pop()!;child.kill();await child.exited}
  while (postgresDatabases.length) postgresDatabases.pop()!.drop()
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('aun bootstrap clean-host journal', () => {
  test('B5-TARGET-AUTHORITY-001 uses only the validated target pane process tree when the controller differs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-target-tmux-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const dbPath = join(home, 'target.db')
    writeFileSync(dbPath, 'profile-readback-fixture')
    const env: Record<string, string> = {
      HOME: home,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: dbPath,
      AUN_BOOTSTRAP_CHANNEL_PORT: '8801',
      AUN_BOOTSTRAP_TMUX_SESSION: 'misell',
      AUN_BOOTSTRAP_TMUX_PANE: '%52',
      TMUX: '/private/tmp/tmux-controller/default,62097,4',
      TMUX_PANE: '%9',
      CODEX_SANDBOX: 'workspace-write',
    }
    const profile = {
      runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
      channel_port: 8801, tmux_session: 'misell', profile_enabled: true, profile_revision: 2,
    }
    const tmuxCalls: string[] = []
    let profileSetCalls = 0
    const run = async (command: string, args: string[]) => {
      const joined = args.join(' ')
      if (command === 'tmux') {
        tmuxCalls.push(joined)
        if (joined === '-V') return { exitCode: 0, stdout: 'tmux 3.6a\n', stderr: '' }
        if (joined === 'has-session -t =misell') return { exitCode: 0, stdout: '', stderr: '' }
        if (joined === 'display-message -p -t %52 #S') return { exitCode: 0, stdout: 'misell\n', stderr: '' }
        if (joined === 'display-message -p -t %52 #{pane_id}') return { exitCode: 0, stdout: '%52\n', stderr: '' }
        if (joined === 'display-message -p -t %52 #{pane_pid}') return { exitCode: 0, stdout: '7311\n', stderr: '' }
        if (joined === 'display-message -p #S') return { exitCode: 0, stdout: 'discord-aun\n', stderr: '' }
      }
      if (command === process.execPath && joined.includes('agent profile get')) {
        return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
      }
      if (command === process.execPath && joined === '--version') return { exitCode: 0, stdout: '1.3.11\n', stderr: '' }
      if (command === 'node' && joined === '--version') return { exitCode: 0, stdout: 'v20.20.0\n', stderr: '' }
      if (command === 'git' && joined === '--version') return { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '' }
      if (command === 'launchctl' && joined === 'help') return { exitCode: 0, stdout: 'launchctl help\n', stderr: '' }
      if (command === 'codex' && joined === '--version') return { exitCode: 0, stdout: 'codex-cli 1.0.0\n', stderr: '' }
      if (command === 'ps' && joined === '-axo pid=,ppid=,command=') {
        return {
          exitCode: 0,
          stdout: '62097 1 /Applications/Codex.app/controller/codex\n7311 1 /bin/zsh\n7312 7311 /usr/local/bin/codex\n',
          stderr: '',
        }
      }
      if (command === 'ps') return { exitCode: 0, stdout: '1 /Applications/Codex.app/controller/codex\n', stderr: '' }
      if (command === process.execPath && joined.includes('agent profile set')) profileSetCalls++
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
    }
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
    const baseContext = {
      runId: 'target-tmux', agentId: 'misell', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), env,
      priorState: { mutations: [] } as any,
    } satisfies Omit<BootstrapStageContext, 'dryRun'>

    const preflight = await ports.dependencyPreflight({ ...baseContext, dryRun: true })
    expect(preflight.ok).toBe(true)
    expect(env.AUN_BOOTSTRAP_TMUX_SESSION).toBe('misell')
    expect(env.AUN_BOOTSTRAP_TMUX_PANE).toBe('%52')
    expect(env.AUN_BOOTSTRAP_PROVIDER_PID).toBe('7312')
    expect(tmuxCalls).not.toContain('display-message -p #S:#I.#P')

    for (const dryRun of [true, false]) {
      const outcome = await ports.ensureAgentProfile({ ...baseContext, dryRun })
      expect(outcome.ok).toBe(true)
      expect(outcome.evidenceRefs?.some((ref) => ref.startsWith('tmux-explicit-target:'))).toBe(true)
    }
    expect(tmuxCalls.filter((call) => call === 'has-session -t =misell')).toHaveLength(3)
    expect(tmuxCalls.filter((call) => call === 'display-message -p -t %52 #S')).toHaveLength(3)
    expect(tmuxCalls.filter((call) => call === 'display-message -p -t %52 #{pane_id}')).toHaveLength(3)
    expect(tmuxCalls.filter((call) => call === 'display-message -p -t %52 #{pane_pid}')).toHaveLength(1)
    expect(tmuxCalls).not.toContain('display-message -p #S')
    expect(profileSetCalls).toBe(0)
  })

  test('B5-TARGET-AUTHORITY-EXECUTABLE-001 rejects non-provider executables whose arguments or paths mention a provider', async () => {
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const fixtures = [
      { name: 'argument', command: '/usr/local/bin/node /work/codex/helper.js' },
      { name: 'directory', command: '/work/claude/node --mode helper' },
    ]

    for (const fixture of fixtures) {
      const home = mkdtempSync(join(tmpdir(), `aun-bootstrap-target-executable-${fixture.name}-`))
      roots.push(home)
      const dbPath = join(home, 'target.db')
      writeFileSync(dbPath, 'profile-readback-fixture')
      const env: Record<string, string> = {
        HOME: home,
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        AUN_BOOTSTRAP_CHANNEL_PORT: '8801',
        AUN_BOOTSTRAP_TMUX_SESSION: 'misell',
        AUN_BOOTSTRAP_TMUX_PANE: '%52',
        TMUX: '/private/tmp/tmux-controller/default,62097,4',
        TMUX_PANE: '%9',
        CODEX_SANDBOX: 'workspace-write',
      }
      const profile = {
        runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
        channel_port: 8801, tmux_session: 'misell', profile_enabled: true, profile_revision: 2,
      }
      const run = async (command: string, args: string[]) => {
        const joined = args.join(' ')
        if (command === 'tmux') {
          if (joined === '-V') return { exitCode: 0, stdout: 'tmux 3.6a\n', stderr: '' }
          if (joined === 'has-session -t =misell') return { exitCode: 0, stdout: '', stderr: '' }
          if (joined === 'display-message -p -t %52 #S') return { exitCode: 0, stdout: 'misell\n', stderr: '' }
          if (joined === 'display-message -p -t %52 #{pane_id}') return { exitCode: 0, stdout: '%52\n', stderr: '' }
          if (joined === 'display-message -p -t %52 #{pane_pid}') return { exitCode: 0, stdout: '7311\n', stderr: '' }
        }
        if (command === process.execPath && joined.includes('agent profile get')) {
          return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
        }
        if (command === process.execPath && joined === '--version') return { exitCode: 0, stdout: '1.3.11\n', stderr: '' }
        if (command === 'node' && joined === '--version') return { exitCode: 0, stdout: 'v20.20.0\n', stderr: '' }
        if (command === 'git' && joined === '--version') return { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '' }
        if (command === 'launchctl' && joined === 'help') return { exitCode: 0, stdout: 'launchctl help\n', stderr: '' }
        if (command === 'ps' && joined === '-axo pid=,ppid=,command=') {
          return {
            exitCode: 0,
            stdout: `62097 1 /Applications/Codex.app/controller/codex\n7311 1 /bin/zsh\n7312 7311 ${fixture.command}\n`,
            stderr: '',
          }
        }
        if (command === 'ps') return { exitCode: 0, stdout: '1 /Applications/Codex.app/controller/codex\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
      }
      const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
      const context = {
        runId: `target-executable-${fixture.name}`, agentId: 'misell', requestedRuntime: 'codex', resolvedRuntime: 'codex',
        repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), env, dryRun: true,
        priorState: { mutations: [] } as any,
      } satisfies BootstrapStageContext

      const preflight = await ports.dependencyPreflight(context)
      expect(preflight.ok).toBe(false)
      expect(preflight.reasonCodes).toEqual(['NO_GO_IDENTITY_MISMATCH'])
      expect(preflight.evidenceRefs?.some((ref) => ref.startsWith('runtime-authority:target_process_unresolved:'))).toBe(true)
      expect(env.AUN_BOOTSTRAP_PROVIDER_PID).toBeUndefined()
    }
  })

  test('B3 fails closed before profile mutation when the explicit pane is outside the target session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-target-tmux-mismatch-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const dbPath = join(home, 'target.db')
    writeFileSync(dbPath, 'profile-readback-fixture')
    const env = {
      HOME: home,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: dbPath,
      AUN_BOOTSTRAP_CHANNEL_PORT: '8801',
      AUN_BOOTSTRAP_TMUX_SESSION: 'misell',
      AUN_BOOTSTRAP_TMUX_PANE: '%52',
      TMUX: '/private/tmp/tmux-controller/default,62097,4',
      TMUX_PANE: '%9',
    }
    const profile = {
      runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
      channel_port: 8801, tmux_session: 'misell', profile_enabled: true, profile_revision: 2,
    }
    const tmuxCalls: string[] = []
    let profileSetCalls = 0
    const run = async (command: string, args: string[]) => {
      const joined = args.join(' ')
      if (command === 'tmux') {
        tmuxCalls.push(joined)
        if (joined === 'has-session -t =misell') return { exitCode: 0, stdout: '', stderr: '' }
        if (joined === 'display-message -p -t %52 #S') return { exitCode: 0, stdout: 'discord-aun\n', stderr: '' }
        if (joined === 'display-message -p -t %52 #{pane_id}') return { exitCode: 0, stdout: '%52\n', stderr: '' }
      }
      if (command === process.execPath && joined.includes('agent profile get')) {
        return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
      }
      if (command === process.execPath && joined.includes('agent profile set')) profileSetCalls++
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
    }
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
    const baseContext = {
      runId: 'target-tmux-mismatch', agentId: 'misell', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), env,
      priorState: { mutations: [] } as any,
    } satisfies Omit<BootstrapStageContext, 'dryRun'>

    for (const dryRun of [true, false]) {
      const outcome = await ports.ensureAgentProfile({ ...baseContext, dryRun })
      expect(outcome.ok).toBe(false)
      expect(outcome.reasonCodes).toEqual(['NO_GO_IDENTITY_MISMATCH'])
      expect(outcome.evidenceRefs?.some((ref) => ref.startsWith('tmux-explicit-target:'))).toBe(true)
    }
    expect(tmuxCalls.filter((call) => call === 'has-session -t =misell')).toHaveLength(2)
    expect(tmuxCalls).not.toContain('display-message -p #S')
    expect(profileSetCalls).toBe(0)
  })

  test('B5-ROLLBACK-001 stops only the current-run receipt and preserves ordinary runtime identity and status', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-b5-rollback-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const dbPath = join(home, 'b5-rollback.db')
    const env = {
      ...process.env,
      HOME: home,
      AUN_HOME: join(home, '.aun'),
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: dbPath,
    } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
    const profile = Bun.spawnSync([
      process.execPath, 'cli/index.ts', 'agent', 'profile', 'set', 'b5-rollback',
      '--runtime', 'TUI', '--runtime-engine', 'codex', '--home-directory', repoRoot,
      '--channel-port', '8812', '--tmux-session', 'b5-session', '--enabled', 'true', '--execute',
    ], { cwd: repoRoot, env })
    expect(profile.exitCode).toBe(0)
    const db = new SqliteAdapter(dbPath)
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
          process_id, port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
       VALUES ($1, $2, 'codex', 'local_process', 'b5-session', 7000, 8812, $3, $4, 'active', now(), now(), $5)`,
      ['ordinary-b5', 'b5-rollback', repoRoot, 'a'.repeat(40), JSON.stringify({ owner: 'ordinary-runtime' })],
    )
    await db.execute(
      `INSERT INTO agent_runtime_instances
         (runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name,
          process_id, port, checkout_path, commit_sha, status, started_at, last_seen_at, metadata)
       VALUES ($1, $2, 'codex', 'bootstrap_bound_provider', 'b5-session', 7312, 8812, $3, $4, 'running', now(), now(), $5)`,
      ['bootstrap-b5', 'b5-rollback', repoRoot, 'a'.repeat(40), JSON.stringify({ bootstrap_run_id: 'b5-rollback-run' })],
    )
    const runtimeProjection = `SELECT runtime_instance_id, agent_id, runtime_engine, runtime_kind, session_name, process_id,
                                      port, checkout_path, commit_sha, status, metadata
                                 FROM agent_runtime_instances WHERE runtime_instance_id = $1 AND agent_id = $2`
    const ordinaryBefore = await db.queryOne<any>(runtimeProjection, ['ordinary-b5', 'b5-rollback'])
    const ports = bootstrapInternal.createDefaultPorts({
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'not used' }),
      env,
      home,
      repoRoot,
    })
    const context = {
      runId: 'b5-rollback-run', agentId: 'b5-rollback', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
    } satisfies BootstrapStageContext
    const outcome = await ports.rollbackMutation(context, {
      mutation_id: 'b5-rollback-mutation', stage: 'B5_MEMORY_READINESS', kind: 'memory_readiness',
      owner_key: 'memory:b5-rollback-run:bootstrap-b5:none', before_digest: bootstrapDigest(ordinaryBefore),
      intended_after_digest: 'receipt', actual_after_digest: 'receipt',
      rollback_action: 'expire run-owned memory evidence and stop only a run-owned runtime receipt',
      rollback_status: 'not_run',
      rollback_payload: {
        runtime_instance_id: 'bootstrap-b5', runtime_created: true, evidence_id: null,
        bootstrap_run_id: 'b5-rollback-run',
        runtime_before_identities: [{ runtime_instance_id: 'ordinary-b5', row_digest: bootstrapDigest(ordinaryBefore) }],
      },
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.readinessPredicates).toMatchObject({
      rollback_verified: true,
      preexisting_runtime_unchanged: true,
    })
    const ordinaryAfter = await db.queryOne<any>(runtimeProjection, ['ordinary-b5', 'b5-rollback'])
    const bootstrapAfter = await db.queryOne<any>('SELECT status FROM agent_runtime_instances WHERE runtime_instance_id = $1', ['bootstrap-b5'])
    expect(bootstrapDigest(ordinaryAfter)).toBe(bootstrapDigest(ordinaryBefore))
    expect(bootstrapAfter?.status).toBe('stopped')
    await db.close()
  })

  test('B5-CONCURRENCY-001, B5-FINAL-TUPLE-READBACK-001, and B5-INCREMENTAL-BINDING-001 bind readback and reject every authoritative tuple drift', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'aun-bootstrap-b5-concurrency-')))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const databaseName = `aun_bootstrap_b5_concurrency_${process.pid}_${Date.now()}`
    const postgresDatabase = createPostgresTestDatabase(databaseName)
    postgresDatabases.push(postgresDatabase)
    const databaseUrl = postgresDatabase.databaseUrl
    const native=await nativeHostFixture(home,repoRoot,'b5-concurrency','b5-concurrency-project','b5-session')
    const baseEnv = {
      ...process.env,
      HOME: home,
      AUN_HOME: join(home, '.aun'),
      AGENT_COM_DB: 'postgres',
      DATABASE_URL: databaseUrl,
      AGENT_MEMORY_PROJECT: 'b5-concurrency-project',
      AUN_BOOTSTRAP_CHANNEL_PORT: '8812',
      AUN_BOOTSTRAP_PROVIDER_PID: String(native.observed.provider.pid),
    } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env: baseEnv }).exitCode).toBe(0)
    const profileSet = Bun.spawnSync([
      process.execPath, 'cli/index.ts', 'agent', 'profile', 'set', 'b5-concurrency',
      '--runtime', 'TUI', '--runtime-engine', 'codex', '--home-directory', repoRoot,
      '--channel-port', '8812', '--tmux-session', 'b5-session', '--enabled', 'true', '--execute',
    ], { cwd: repoRoot, env: baseEnv })
    expect(profileSet.exitCode).toBe(0)
    const db = new PgAdapter(databaseUrl)
    await registerNativeFixtureRuntime(db,native,'b5-concurrency','b5-concurrency-project','b5-session',repoRoot,'ba000000-0000-4000-8000-000000000001')
    const storedProfile = await db.queryOne<any>(
      `SELECT profile_revision, profile_source FROM agents WHERE agent_id = $1`,
      ['b5-concurrency'],
    )
    await db.close()
    const profile = {
      runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
      channel_port: 8812, tmux_session: 'b5-session', profile_enabled: true,
      profile_revision: Number(storedProfile?.profile_revision), profile_source: storedProfile?.profile_source,
    }
    let ordinaryHeartbeatAdvances = 0
    let providerTransportDrift = false
    const run = async (command: string, args: string[]) => {
      const joined = args.join(' ')
      if (command === process.execPath && joined.includes('agent profile get')) {
        return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
      }
      if (command === 'codex' && joined === 'mcp get wasurezu --json') {
        const heartbeatDb = new PgAdapter(databaseUrl)
        try {
          await heartbeatDb.execute(
            `UPDATE agent_runtime_instances
                SET last_seen_at = now()
              WHERE runtime_instance_id = $1
                AND agent_id = $2
                AND runtime_kind = 'local_process'`,
            ['ba000000-0000-4000-8000-000000000001', 'b5-concurrency'],
          )
          ordinaryHeartbeatAdvances++
        } finally {
          await heartbeatDb.close()
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            enabled: true,
            transport: {
              type: 'stdio', command: native.node,
              args: [native.memory,...(providerTransportDrift?['drift']:[])], env: native.env,
            },
          }),
          stderr: '',
        }
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
    }
    const runGate = async (runId: string) => {
      const env = { ...baseEnv }
      const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot, observeProvider:native.observeProvider })
      const context = {
        runId, agentId: 'b5-concurrency', requestedRuntime: 'codex', resolvedRuntime: 'codex',
        repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
        priorState: { mutations: [] } as any,
      } as BootstrapStageContext
      const outcome = await ports.ensureMemoryReadiness(context)
      return { context, outcome, ports }
    }
    const outcomes = await Promise.all([runGate('b5-concurrent-a'), runGate('b5-concurrent-b')])
    for (const runResult of outcomes) expect(runResult.outcome).toMatchObject({ ok: true })
    const createReadback = new PgAdapter(databaseUrl)
    const activeAfterCreate = await createReadback.query<any>(
      `SELECT runtime_instance_id, runtime_kind, status FROM agent_runtime_instances
        WHERE agent_id = $1 AND status IN ('running', 'active') ORDER BY runtime_instance_id`,
      ['b5-concurrency'],
    )
    await createReadback.close()
    const createdReceipts = activeAfterCreate.filter((row) => row.runtime_kind === 'bootstrap_bound_provider')
    expect(createdReceipts).toHaveLength(1)

    const reuseRun = await runGate('b5-reuse-after-heartbeat')
    expect(reuseRun.outcome.ok).toBe(true)
    expect(reuseRun.outcome.mutation).toBeDefined()

    const expectedReceipt = {
      runtime_kind: 'bootstrap_bound_provider', runtime_engine: 'codex', session_name: 'b5-session',
      process_id: native.observed.provider.pid, port: native.observed.endpoint.port, checkout_path: repoRoot, commit_sha: 'a'.repeat(40),
    }
    const driftCases = [
      { id: 'runtime_kind', values: { ...expectedReceipt, runtime_kind: 'local_process' } },
      { id: 'runtime_engine', values: { ...expectedReceipt, runtime_engine: 'claude' } },
      { id: 'session_name', values: { ...expectedReceipt, session_name: 'drifted-session' } },
      { id: 'process_id', values: { ...expectedReceipt, process_id: 9999 } },
      { id: 'port', values: { ...expectedReceipt, port: 9999 } },
      { id: 'checkout_path', values: { ...expectedReceipt, checkout_path: join(home, 'drifted-checkout') } },
      { id: 'commit_sha', values: { ...expectedReceipt, commit_sha: 'b'.repeat(40) } },
    ]
    const driftDb = new PgAdapter(databaseUrl)
    const writeReceiptTuple = async (values: typeof expectedReceipt) => driftDb.execute(
      `UPDATE agent_runtime_instances
          SET runtime_kind = $2, runtime_engine = $3, session_name = $4, process_id = $5,
              port = $6, checkout_path = $7, commit_sha = $8
        WHERE runtime_instance_id = $1`,
      [createdReceipts[0].runtime_instance_id, values.runtime_kind, values.runtime_engine,
        values.session_name, values.process_id, values.port, values.checkout_path, values.commit_sha],
    )
    const rejectedDrifts: string[] = []
    try {
      for (const drift of driftCases) {
        await writeReceiptTuple(drift.values)
        const outcome = await reuseRun.ports.revalidateStage!(
          {
            ...reuseRun.context,
            priorState: { mutations: [reuseRun.outcome.mutation] } as any,
          },
          'B5_MEMORY_READINESS',
        )
        expect(outcome.ok).toBe(false)
        expect(outcome.reasonCodes).toContain('NO_GO_POST_MUTATION_READBACK')
        rejectedDrifts.push(drift.id)
      }
      expect(rejectedDrifts).toEqual(driftCases.map((drift) => drift.id))
      await writeReceiptTuple(expectedReceipt)
      const restoredReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          priorState: { mutations: [reuseRun.outcome.mutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(restoredReadback.ok).toBe(true)

      const unboundSameHeadReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          priorState: { mutations: [] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(unboundSameHeadReadback.ok).toBe(true)

      const successorRepoRoot = join(home, 'successor-release')
      mkdirSync(successorRepoRoot)
      const incrementalReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [reuseRun.outcome.mutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(incrementalReadback.ok).toBe(true)
      expect(incrementalReadback.evidenceRefs).toContain(
        `memory-runtime-binding:bound_runtime_receipt:${reuseRun.outcome.mutation?.rollback_payload?.runtime_tuple_digest}`,
      )

      const unboundIncrementalReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(unboundIncrementalReadback.ok).toBe(false)

      const wrongDigestMutation = structuredClone(reuseRun.outcome.mutation!)
      wrongDigestMutation.rollback_payload = {
        ...wrongDigestMutation.rollback_payload,
        runtime_tuple_digest: '0'.repeat(64),
      }
      const wrongDigestReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [wrongDigestMutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(wrongDigestReadback.ok).toBe(false)
      expect(wrongDigestReadback.reasonCodes).toContain('NO_GO_POST_MUTATION_READBACK')

      const wrongAgentReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          agentId: 'b5-concurrency-foreign',
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [reuseRun.outcome.mutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(wrongAgentReadback.ok).toBe(false)

      const wrongEvidenceMutation = structuredClone(reuseRun.outcome.mutation!)
      wrongEvidenceMutation.rollback_payload = {
        ...wrongEvidenceMutation.rollback_payload,
        evidence_id: '999999999',
      }
      const wrongEvidenceReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [wrongEvidenceMutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(wrongEvidenceReadback.ok).toBe(false)

      await driftDb.execute(
        `UPDATE agent_runtime_instances SET status = 'stopped'
          WHERE runtime_instance_id = $1`,
        [createdReceipts[0].runtime_instance_id],
      )
      const inactiveReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [reuseRun.outcome.mutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(inactiveReadback.ok).toBe(false)
      await driftDb.execute(
        `UPDATE agent_runtime_instances SET status = 'running'
          WHERE runtime_instance_id = $1`,
        [createdReceipts[0].runtime_instance_id],
      )

      providerTransportDrift = true
      const transportMismatchReadback = await reuseRun.ports.revalidateStage!(
        {
          ...reuseRun.context,
          repoRoot: successorRepoRoot,
          repoHead: 'b'.repeat(40),
          priorState: { mutations: [reuseRun.outcome.mutation] } as any,
        },
        'B5_MEMORY_READINESS',
      )
      expect(transportMismatchReadback.ok).toBe(false)
      providerTransportDrift = false
    } finally {
      await driftDb.close()
    }

    const readback = new PgAdapter(databaseUrl)
    const active = await readback.query<any>(
      `SELECT runtime_instance_id, runtime_kind, session_name, process_id, port,
              checkout_path, commit_sha, status, metadata
         FROM agent_runtime_instances
        WHERE agent_id = $1 AND status IN ('running', 'active') ORDER BY runtime_instance_id`,
      ['b5-concurrency'],
    )
    expect(active.filter((row) => row.runtime_kind === 'bootstrap_bound_provider')).toEqual([
      expect.objectContaining({
        runtime_instance_id: createdReceipts[0].runtime_instance_id,
        runtime_kind: 'bootstrap_bound_provider',
        status: 'running',
      }),
    ])
    expect(active.filter((row) => row.runtime_kind === 'local_process')).toEqual([
      { runtime_instance_id: 'ba000000-0000-4000-8000-000000000001', runtime_kind: 'local_process', status: 'active' },
    ].map((row) => expect.objectContaining(row)))
    expect(ordinaryHeartbeatAdvances).toBeGreaterThanOrEqual(7)
    await readback.close()
  }, 30000)

  test('live Codex account-root observation survives stale, absent and symlinked profile metadata', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-bootstrap-root-db-')))
    roots.push(home)
    const codexRoot = join(home, '.codex')
    mkdirSync(codexRoot, { mode: 0o700 })
    const wrongRoot = join(home, '.wrong-codex')
    mkdirSync(wrongRoot, { mode: 0o700 })
    const wrongConfig = join(wrongRoot, 'config.toml')
    writeFileSync(wrongConfig, 'wrong-profile-must-remain-byte-identical\n', { mode: 0o640 })
    const wrongBefore = { bytes: readFileSync(wrongConfig), stat: statSync(wrongConfig) }
    const databaseName = `aun_bootstrap_root_${process.pid}_${Date.now()}`
    const postgresDatabase = createPostgresTestDatabase(databaseName)
    postgresDatabases.push(postgresDatabase)
    const databaseUrl = postgresDatabase.databaseUrl
    const repoRoot = join(import.meta.dir, '..', '..')
    const env = { ...process.env, HOME: home, DATABASE_URL: databaseUrl, AGENT_COM_DB: 'postgres' } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
    expect(Bun.spawnSync([
      'psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f',
      join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql'),
    ], { cwd: repoRoot, env }).exitCode).toBe(0)
    const db = new PgAdapter(databaseUrl)
    await db.execute(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime, metadata,
         runtime_engine_preference, ordinary_projection
       ) VALUES ($1, $2, 'bot', 'TUI', $3::jsonb, 'codex', $4::jsonb)`,
      ['root-authority', 'Root authority fixture', JSON.stringify({ codex_home: codexRoot }), JSON.stringify({ provider_config_root: codexRoot })],
    )
    const native=await nativeHostFixture(home,repoRoot,'root-authority','root-project','root-session')
    await registerNativeFixtureRuntime(db,native,'root-authority','root-project','root-session',repoRoot,randomUUID())
    const observeRoot={observeProvider:native.observeProvider,run:async(_command:string,args:string[])=>({exitCode:0,stdout:args.includes('lstart=')?native.observed.provider.startedAt:`/fixture/codex HOME=${home} CODEX_HOME=${codexRoot}`,stderr:''})}
    const exact = await bootstrapInternal.resolveProviderRootAuthority({
      ...observeRoot,agentId: 'root-authority', requestedRuntime: 'codex', env: { ...env, CODEX_HOME: wrongRoot }, home, repoRoot,
    })
    expect(exact.ok).toBe(true)
    if (!exact.ok) throw new Error('expected exact root authority')
    expect(exact.authority).toMatchObject({
      existingTarget: true,
      canonicalSourceField: 'observed_provider_process',
      canonicalRoot: codexRoot,
      projectionMatches: true,
      callerMismatch: true,
    })
    const wrongAfter = statSync(wrongConfig)
    expect(readFileSync(wrongConfig).equals(wrongBefore.bytes)).toBe(true)
    expect({ dev: wrongAfter.dev, ino: wrongAfter.ino, mode: wrongAfter.mode & 0o777, size: wrongAfter.size })
      .toEqual({ dev: wrongBefore.stat.dev, ino: wrongBefore.stat.ino, mode: wrongBefore.stat.mode & 0o777, size: wrongBefore.stat.size })
    await db.execute(`UPDATE agents SET ordinary_projection = $2::jsonb WHERE agent_id = $1`, [
      'root-authority', JSON.stringify({ provider_config_root: '/tmp/conflict' }),
    ])
    const conflict = await bootstrapInternal.resolveProviderRootAuthority({
      ...observeRoot,agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(conflict).toMatchObject({ok:true,authority:{canonicalRoot:codexRoot}})
    await db.execute(`UPDATE agents SET metadata = '{}'::jsonb WHERE agent_id = $1`, ['root-authority'])
    const missing = await bootstrapInternal.resolveProviderRootAuthority({
      ...observeRoot,agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(missing).toMatchObject({ok:true,authority:{canonicalRoot:codexRoot}})
    const symlinkRoot = join(home, '.codex-link')
    symlinkSync(codexRoot, symlinkRoot)
    await db.execute(
      `UPDATE agents SET metadata = jsonb_build_object('codex_home', $2::text), ordinary_projection = jsonb_build_object('provider_config_root', $2::text)
        WHERE agent_id = $1`,
      ['root-authority', symlinkRoot],
    )
    const ambiguous = await bootstrapInternal.resolveProviderRootAuthority({
      ...observeRoot,agentId: 'root-authority', requestedRuntime: 'codex', env, home, repoRoot,
    })
    expect(ambiguous).toMatchObject({ok:true,authority:{canonicalRoot:codexRoot}})
    const noCurrent=await bootstrapInternal.resolveProviderRootAuthority({agentId:'root-authority',requestedRuntime:'codex',env,home,repoRoot,observeProvider:()=>null})
    expect(noCurrent).toMatchObject({ok:false,reasonCode:'NO_GO_PROVIDER_ROOT_AUTHORITY_MISSING'})
    await db.close()
  }, 30_000)

  test('B3 preserves existing seat authority and outbox despite stale runtime projection', async () => {
    const home = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'aun-bootstrap-b3-hold-')))
    roots.push(home)
    const codexRoot = join(home, '.codex')
    mkdirSync(codexRoot, { mode: 0o700 })
    const databaseName = `aun_bootstrap_b3_${process.pid}_${Date.now()}`
    const postgresDatabase = createPostgresTestDatabase(databaseName)
    postgresDatabases.push(postgresDatabase)
    const databaseUrl = postgresDatabase.databaseUrl
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const env = {
      ...process.env,
      HOME: home, AUN_HOME: join(home, '.aun'), DATABASE_URL: databaseUrl, AGENT_COM_DB: 'postgres',
      AUN_BOOTSTRAP_CHANNEL_PORT: '8801', AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex',
    } as Record<string, string>
    expect(Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env }).exitCode).toBe(0)
    expect(Bun.spawnSync([
      'psql', databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f',
      join(repoRoot, 'db', 'migrations', '2026-07-26-aun-configuration-reconciliation.up.sql'),
    ], { cwd: repoRoot, env }).exitCode).toBe(0)
    const profileSet = Bun.spawnSync([
      process.execPath, 'cli/index.ts', 'agent', 'profile', 'set', 'b3-held',
      '--runtime', 'TUI', '--runtime-engine', 'codex', '--home-directory', repoRoot,
      '--channel-port', '8801', '--tmux-session', 'b3-session', '--enabled', 'true', '--execute',
    ], { cwd: repoRoot, env })
    expect(profileSet.exitCode).toBe(0)
    const db = new PgAdapter(databaseUrl)
    await db.execute(
      `UPDATE agents SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{codex_home}', to_jsonb($2::text), true),
                         canonical_workspace = $4,
                         canonical_home = $5,
                         supervisor_identity = 'launchd:com.agent-comms.state-daemon',
                         ordinary_communication_enrollment = true,
                         ordinary_projection = $3::jsonb,
                         desired_release_commit = $6,
                         desired_release_tree = $7,
                         desired_control_refs = $8::jsonb
        WHERE agent_id = $1`,
      [
        'b3-held', codexRoot,
        JSON.stringify({
          owner: 'continuous-reconciler', provider_repo_root: repoRoot, provider_config_root: codexRoot,
          daemon_checkout: join(home, '.agent-comms', 'state-daemon', 'releases', 'c'.repeat(40)),
          schema_version: 'aun-configuration-projection/v1',
        }),
        repoRoot, home, 'c'.repeat(40), 'd'.repeat(40),
        JSON.stringify(['https://github.com/watchout/agent-comms-mcp/issues/887#preexisting-fixture']),
      ],
    )
    const preAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-held'])
    const preOutbox = await db.query<any>(
      `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
      ['b3-held'],
    )
    const run = async (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => {
      const joined = args.join(' ')
      if (command === 'git' && joined === 'rev-parse HEAD^{tree}') return { exitCode: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' }
      if (command === 'tmux') return { exitCode: 0, stdout: 'b3-session\n', stderr: '' }
      if (command === process.execPath && args[0] === 'cli/index.ts') {
        const child = Bun.spawn([command, ...args], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        return { exitCode, stdout, stderr }
      }
      return { exitCode: 1, stdout: '', stderr: `unexpected ${command} ${joined}` }
    }
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })
    const context: BootstrapStageContext = {
      runId: 'b3-held-run', agentId: 'b3-held', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
      providerRootAuthority: {
        existingTarget: true, canonicalSourceField: 'metadata.codex_home', canonicalRoot: codexRoot,
        canonicalRootDigest: bootstrapDigest(codexRoot), canonicalRealpathDigest: bootstrapDigest(codexRoot),
        projectionMatches: true, callerMismatch: false,
      },
    }
    const outcome = await ports.ensureAgentProfile(context)
    expect(outcome.ok).toBe(true)
    expect(outcome.mutation).toBeUndefined()
    expect(outcome.mutations).toBeUndefined()
    const finalAgent = await db.queryOne<any>(`SELECT to_jsonb(a) AS row FROM agents a WHERE agent_id = $1`, ['b3-held'])
    const finalOutbox = await db.query<any>(
      `SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o WHERE agent_id = $1 ORDER BY event_id`,
      ['b3-held'],
    )
    expect(bootstrapDigest(finalAgent?.row)).toBe(bootstrapDigest(preAgent?.row))
    expect(bootstrapDigest(finalOutbox.map((item) => item.row))).toBe(bootstrapDigest(preOutbox.map((item) => item.row)))
    await db.close()
  }, 30_000)

  test('ordinary native memory CLI establishes local readiness and receive without shared bootstrap effects', async () => {
    const home=realpathSync(mkdtempSync(join(tmpdir(),'aun-native-cli-')));roots.push(home)
    const repoRoot=realpathSync(join(import.meta.dir,'../..'))
    const fixtureDb=createPostgresTestDatabase(`native_cli_${process.pid}_${Date.now()}`);postgresDatabases.push(fixtureDb)
    const env={...process.env,HOME:home,AGENT_COM_DB:'postgres',DATABASE_URL:fixtureDb.databaseUrl} as Record<string,string>
    expect(Bun.spawnSync([process.execPath,'--no-env-file','db/migrate.ts'],{cwd:repoRoot,env}).exitCode).toBe(0)
    const db=new PgAdapter(fixtureDb.databaseUrl)
    try {
      await db.execute(readFileSync(join(repoRoot,'db/migrations/2026-07-26-aun-configuration-reconciliation.up.sql'),'utf8'))
      await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,runtime,profile_enabled,status) VALUES('preserved-seat','Preserved','bot','TUI',true,'idle')`)
      await db.execute(`INSERT INTO message_queue(agent_id,message_id,status,claimed_by,claimed_at,payload) VALUES('preserved-seat',$1,'in_progress','preserved-seat',now(),'{}')`,[randomUUID()])
      const snapshot=async()=>bootstrapDigest({
        agents:await db.query('SELECT to_jsonb(a) AS row FROM agents a ORDER BY agent_id'),
        queues:await db.query('SELECT to_jsonb(q) AS row FROM message_queue q ORDER BY id'),
        runtimes:await db.query('SELECT to_jsonb(r) AS row FROM agent_runtime_instances r ORDER BY runtime_instance_id'),
        leases:await db.query('SELECT to_jsonb(l) AS row FROM control_plane_leases l ORDER BY lease_id'),
        outbox:await db.query('SELECT to_jsonb(o) AS row FROM aun_configuration_desired_outbox o ORDER BY event_id'),
        newMigration:await db.queryOne("SELECT to_regprocedure('aun_configuration_legacy_desired_document(agents)') AS function"),
      })
      for(const scenario of [{mode:'accepted',durableProject:true},{mode:'accepted',durableProject:false},{mode:'pending',durableProject:true},{mode:'absent',durableProject:true}] as const) {
        const {mode,durableProject}=scenario,key=`${mode}-${durableProject}`
        const agent=`native-cli-${key}`,project='stable-cli-project',session=`session-${key}`,runtimeId=randomUUID()
        const localHome=join(home,key);mkdirSync(localHome);mkdirSync(join(localHome,'.codex'));mkdirSync(join(localHome,'bin'))
        const native=await nativeHostFixture(localHome,repoRoot,agent,project,session,mode)
        await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type,runtime,profile_enabled,status,runtime_engine_preference,metadata)
          VALUES($1,$1,'bot','TUI',true,'idle','claude-code',$2)`,[agent,JSON.stringify(durableProject?{memory_project:project}:{})])
        await registerNativeFixtureRuntime(db,native,agent,project,session,repoRoot,runtimeId)
        const queue=await db.queryOne<any>(`INSERT INTO message_queue(agent_id,message_id,status,payload) VALUES($1,$2,'pending',$3) RETURNING id`,
          [agent,randomUUID(),JSON.stringify({author_id:'aun-bootstrap',message_type:'instruction',content:'fixture native ready receive',next_action:'none',no_reply_required:true})])
        const configCalls=join(localHome,'config-calls'),codex=join(localHome,'bin','codex'),wrapper=join(localHome,'native-cli.ts')
        writeFileSync(codex,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(configCalls)},'get\\n');console.log(${JSON.stringify(JSON.stringify({enabled:true,transport:{type:'stdio',command:native.node,args:[native.memory],env:native.env}}))});`);chmodSync(codex,0o755)
        // Execute the actual CLI dispatcher in its own process. Only classification
        // of the real harmless Node host is injected; PID/start/root/pipe/lease and
        // registered Wasurezu lookup all remain actual observations.
        writeFileSync(wrapper,`
          import {mock} from 'bun:test';import {execFileSync} from 'node:child_process';
          const mod=await import(${JSON.stringify(join(repoRoot,'core/seat-runtime-selection.ts'))});
          const observe=mod.observeSeatProvider,readRoot=mod.readObservedProviderRoot;
          const provider=${JSON.stringify(native.observed.provider)};
          mock.module(${JSON.stringify(join(repoRoot,'core/seat-runtime-selection.ts'))},()=>({...mod,
            observeSeatProvider:(input)=>{
              const ppid=Number(execFileSync('ps',['-p',String(input.processId),'-o','ppid='],{encoding:'utf8'}).trim());
              const start=new Date(execFileSync('ps',['-p',String(provider.pid),'-o','lstart='],{encoding:'utf8'}).trim()).toISOString();
              if(ppid!==provider.pid||start!==provider.startedAt)return null;
              const actual=execFileSync('ps',['eww','-p',String(input.processId),'-o','command='],{encoding:'utf8'});
              return observe({...input,providerStartedAt:start,processes:[{pid:input.processId,ppid,command:actual},{pid:ppid,ppid:1,command:'/fixture/codex'}]});
            },
            readObservedProviderRoot:(run,input)=>readRoot(async(command,args,options)=>{
              const r=await run(command,args,options);if(command==='ps'&&args.includes('eww'))r.stdout=r.stdout.replace(/^\\s*\\S+/,'/fixture/codex');return r;
            },input)
          }));
          const {runAsync}=await import(${JSON.stringify(join(repoRoot,'bin/aun.ts'))});
          process.exit(await runAsync([process.execPath,'aun',...process.argv.slice(2)]));
        `)
        const cliEnv={...env,HOME:localHome,PATH:`${join(localHome,'bin')}:${env.PATH}`,AGENT_ID:agent,AGENT_COM_EXPECTED_AGENT_ID:agent,
          AGENT_MEMORY_AGENT_ID:'foreign-controller',AGENT_MEMORY_PROJECT:'foreign-controller-project',AGENT_COMMS_MEMORY_READY_PROJECT:project,AUN_RECEIVE_CLAIM_SOURCE:'native-cli-fixture'}
        const invoke=async(args:string[],ordinary=false)=>{
          const child=Bun.spawn([process.execPath,'--no-env-file',ordinary?join(repoRoot,'bin/aun.ts'):wrapper,...args],{cwd:repoRoot,env:cliEnv,stdout:'pipe',stderr:'pipe'})
          const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {code,stdout,stderr,pid:child.pid}
        }
        const before=await snapshot()
        const plan=await invoke(['memory-ready-bootstrap','--agent-id',agent,'--dry-run'])
        expect(plan.code).toBe(0);expect(JSON.parse(plan.stdout)).toMatchObject({dry_run:true,native_receipt_checked:false,mutation_performed:false})
        expect(existsSync(configCalls)).toBe(false);expect(await snapshot()).toBe(before)
        expect(JSON.parse(plan.stdout).plan.project).toBe(durableProject?project:null)
        const foreign=await invoke(['memory-ready-bootstrap','--agent-id',agent,'--runtime-instance-id',randomUUID()])
        expect(foreign.code).toBe(1);expect(JSON.parse(foreign.stdout).reason).toBe('MEMORY_EXPECTATION_MISMATCH:runtime_instance')
        expect(await snapshot()).toBe(before)
        const wrongProject=await invoke(['memory-ready-bootstrap','--agent-id',agent,'--project','foreign-project'])
        expect(wrongProject.code).toBe(1);expect(JSON.parse(wrongProject.stdout).mutation_performed).toBe(false)
        expect(await snapshot()).toBe(before)
        const ready=await invoke(['memory-ready-bootstrap','--agent-id',agent])
        if(mode==='accepted'&&ready.code!==0)console.error('NATIVE_CLI_RESULT',ready)
        expect(ready.code).toBe(mode==='accepted'?0:1)
        expect(await snapshot()).toBe(before)
        const evidence=await db.query<any>('SELECT * FROM runtime_memory_ready_evidence WHERE agent_id=$1',[agent])
        expect(evidence).toHaveLength(mode==='accepted'?1:0)
        const receive=await invoke(['receive-actionable','--agent-id',agent,'--queue-id',String(queue.id)],true)
        expect(receive.code).toBe(mode==='accepted'?0:1)
        if(mode==='accepted') {
          expect(JSON.parse(ready.stdout)).toMatchObject({mutation_performed:true,native_receipt_checked:true,memory_ready:{ok:true,runtime_instance_id:runtimeId}})
          expect(evidence[0].runtime_instance_id).toBe(runtimeId)
          expect(evidence[0].metadata.seat_context_receipt.native_delivery.provider_pid).toBe(native.observed.provider.pid)
          expect(evidence[0].metadata.seat_context_receipt.native_delivery.project).toBe(project)
          expect((await db.queryOne<any>('SELECT status,claimed_by FROM message_queue WHERE id=$1',[queue.id]))).toMatchObject({status:'received',claimed_by:agent})
          await db.execute("UPDATE control_plane_leases SET expires_at=now()-interval '1 second' WHERE lease_id=$1",[runtimeId])
          const stale=await invoke(['memory-ready-bootstrap','--agent-id',agent])
          expect(stale.code).toBe(1);expect(JSON.parse(stale.stdout).mutation_performed).toBe(false)
          expect((await db.query<any>('SELECT id FROM runtime_memory_ready_evidence WHERE agent_id=$1',[agent]))).toHaveLength(1)
        } else {
          expect(JSON.parse(ready.stdout)).toMatchObject({mutation_performed:false,reason:'MEMORY_NATIVE_CONTEXT_IDENTITY_MISMATCH'})
          expect((await db.queryOne<any>('SELECT status FROM message_queue WHERE id=$1',[queue.id]))?.status).toBe('pending')
        }
        expect(existsSync(join(localHome,'Library/LaunchAgents'))).toBe(false)
        expect(existsSync(join(localHome,'.aun/bootstrap'))).toBe(false)
      }
      expect((await db.queryOne<any>("SELECT status,claimed_by FROM message_queue WHERE agent_id='preserved-seat'"))).toMatchObject({status:'in_progress',claimed_by:'preserved-seat'})
      expect((await db.queryOne<any>("SELECT to_regprocedure('aun_configuration_legacy_desired_document(agents)') AS function"))?.function).toBeNull()
    } finally {await db.close()}
  },30_000)

  for (const fixture of ['sqlite-new', 'sqlite-existing', 'postgres'] as const) test(`real default ${fixture} path performs genuine MCP recovery and separate-process ordinary receive`, async () => {
    const backend = fixture === 'postgres' ? 'postgres' : 'sqlite'
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'aun-bootstrap-default-sqlite-')))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const native=await nativeHostFixture(home,repoRoot,'clean-default','bootstrap-clean-project','clean-session')
    const ordinaryRuntimeId=randomUUID()
    const dbPath = join(home, 'agent-com.db')
    let sqlitePrestate: Buffer | null = null
    if (fixture === 'sqlite-existing') {
      const seeded = Bun.spawnSync([
        'sqlite3', dbPath,
        "PRAGMA journal_mode=DELETE; CREATE TABLE pre_bootstrap_marker (value TEXT NOT NULL); INSERT INTO pre_bootstrap_marker VALUES ('preserve-exactly');",
      ])
      expect(seeded.exitCode).toBe(0)
      sqlitePrestate = readFileSync(dbPath)
    }
    const databaseName = backend === 'postgres' ? `aun_bootstrap_${process.pid}_${Date.now()}` : null
    const postgresDatabase = databaseName ? createPostgresTestDatabase(databaseName) : null
    if (postgresDatabase) postgresDatabases.push(postgresDatabase)
    const databaseUrl = postgresDatabase?.databaseUrl
    const env = {
      ...process.env,
      HOME: home,
      AUN_HOME: join(home, '.aun'),
      AGENT_COM_DB: backend,
      AGENT_COM_SQLITE_PATH: dbPath,
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      AGENT_MEMORY_PROJECT: 'bootstrap-clean-project',
      CODEX_SANDBOX: 'workspace-write',
      AUN_BOOTSTRAP_PROVIDER_PID:String(native.observed.provider.pid),
    } as Record<string, string>
    if (databaseUrl) {
      const migrated = Bun.spawnSync([process.execPath, 'db/migrate.ts'], { cwd: repoRoot, env })
      expect(migrated.exitCode).toBe(0)
    }
    let aunRegistered = false
    let daemonLoaded = false
    let queueReceiveCount = 0
    let syntheticPid = 50_000
    const stateDaemonRestoreCalls: string[][] = []
    const stateDaemonReadinessCalls: string[][] = []
    const nativeTuple = () => JSON.stringify({
      name: 'aun', enabled: true,
      transport: {
        type: 'stdio', command: realpathSync(process.execPath),
        args: ['run', '--cwd', realpathSync(repoRoot), join(realpathSync(repoRoot), 'server.ts')],
        env: {
          AGENT_ID: 'clean-default', AGENT_COM_EXPECTED_AGENT_ID: 'clean-default',
          ...(databaseUrl
            ? { DATABASE_URL: databaseUrl }
            : { AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: realpathSync(dbPath) }),
          AGENT_COM_PG_NOTIFY: 'false', AGENT_COMMS_TTL_SWEEP_DISABLED: '1', AUN_WEBHOOK_PORT: '0',
        },
      },
    })
    const run = async (command: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }) => {
      const joined = args.join(' ')
      if (command === 'git' && joined === 'rev-parse HEAD') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', pid: ++syntheticPid }
      if (command === 'git' && joined === 'status --porcelain') return { exitCode: 0, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'git' && joined === '--version') return { exitCode: 0, stdout: 'git version 2.50.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'node') return { exitCode: 0, stdout: 'v20.20.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'tmux' && joined.includes('#S:#I.#P')) return { exitCode: 0, stdout: 'clean-session:%1\n', stderr: '', pid: ++syntheticPid }
      if (command === 'tmux') return { exitCode: 0, stdout: 'clean-session\n', stderr: '', pid: ++syntheticPid }
      if (command === 'launchctl' && joined === 'help') return { exitCode: 0, stdout: 'launchctl help\n', stderr: '', pid: ++syntheticPid }
      if (command === 'launchctl' && args[0] === 'print') return daemonLoaded
        ? { exitCode: 0, stdout: launchctlSafePrint(4242), stderr: '', pid: ++syntheticPid }
        : { exitCode: 3, stdout: '', stderr: 'Could not find service', pid: ++syntheticPid }
      if (command === 'launchctl' && args[0] === 'bootout') {
        daemonLoaded = false
        return { exitCode: 0, stdout: 'booted out\n', stderr: '', pid: ++syntheticPid }
      }
      if (command === 'lsof') return { exitCode: 1, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'ps' && args.includes('lstart=')) return {exitCode:0,stdout:native.observed.provider.startedAt,stderr:''}
      if (command === 'ps' && args.includes('eww')) return {exitCode:0,stdout:`/fixture/codex HOME=${home} CODEX_HOME=${join(home,'.codex')}`,stderr:''}
      if (command === 'ps') return { exitCode: 1, stdout: '', stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && joined === '--version') return { exitCode: 0, stdout: 'codex-cli 1.0.0\n', stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && joined === 'mcp get wasurezu --json') {
        return { exitCode: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', command: native.node, args: [native.memory], env: native.env } }), stderr: '', pid: ++syntheticPid }
      }
      if (command === 'codex' && joined === 'mcp get aun --json') return aunRegistered
        ? { exitCode: 0, stdout: nativeTuple(), stderr: '', pid: ++syntheticPid }
        : { exitCode: 1, stdout: '', stderr: 'MCP server aun not found', pid: ++syntheticPid }
      if (command === 'codex' && joined === 'mcp list --json') return { exitCode: 0, stdout: JSON.stringify(aunRegistered ? [{ name: 'aun', enabled: true }] : []), stderr: '', pid: ++syntheticPid }
      if (command === 'codex' && args.slice(0, 3).join(' ') === 'mcp add aun') {
        mkdirSync(options.env.CODEX_HOME, { recursive: true, mode: 0o700 })
        aunRegistered = true
        return { exitCode: 0, stdout: 'added', stderr: '', pid: ++syntheticPid }
      }
      if (command === 'codex' && joined === 'mcp remove aun') {
        aunRegistered = false
        return { exitCode: 0, stdout: 'removed', stderr: '', pid: ++syntheticPid }
      }
      if (command === process.execPath && args[0] === '--version') return { exitCode: 0, stdout: '1.3.11\n', stderr: '', pid: ++syntheticPid }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        stateDaemonRestoreCalls.push([...args])
        const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
        mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
        const plan: StateDaemonRestorePlan = {
          commit: 'a'.repeat(40), restoreRoot: join(home, '.agent-comms', 'state-daemon', 'checkouts'),
          checkoutPath: repoRoot, entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'),
          logsDir: join(home, 'logs'), buildOutfile: join(home, 'state-daemon'), plistPath,
          tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
          databaseUrl: databaseUrl || 'postgresql:///agent_comms?host=/tmp', extraEnv: {},
        }
        writeFileSync(plistPath, renderStateDaemonLaunchAgentPlist(plan, {
          AGENT_ID: 'state_daemon', SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
          SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
        }))
        daemonLoaded = true
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '', pid: ++syntheticPid }
      }
      if (command === process.execPath && joined.includes('state-daemon readiness')) {
        stateDaemonReadinessCalls.push([...args])
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, expected_agent_id: DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID }), stderr: '', pid: ++syntheticPid }
      }
      const useRealCli = command === process.execPath && (
        args[0] === 'db/migrate.ts'
        || (args[0] === 'cli/index.ts' && args[1] === 'agent')
        || args[0] === 'bin/aun.ts'
      )
      if (useRealCli) {
        if (args[0] === 'bin/aun.ts' && args[1] === 'receive') queueReceiveCount++
        const child = Bun.spawn([command, ...args], { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        if(exitCode===0 && args[0]==='cli/index.ts' && args.includes('set')) {
          const fixtureDb=backend==='postgres'?new PgAdapter(databaseUrl!):new SqliteAdapter(dbPath)
          try {await registerNativeFixtureRuntime(fixtureDb,native,'clean-default','bootstrap-clean-project','clean-session',repoRoot,ordinaryRuntimeId)} finally {await fixtureDb.close()}
        }
        return { exitCode, stdout, stderr, pid: child.pid }
      }
      return { exitCode: 1, stdout: '', stderr: `unhandled fake command: ${command} ${joined}`, pid: ++syntheticPid }
    }

    const input = { agentId: 'clean-default', runtime: 'codex' as const, home, repoRoot, workspaceRoot: repoRoot, env }
    const first = await bootstrap(input, { run, observeProvider:native.observeProvider })
    if(first.status!=='READY') console.error('CLEAN_HOST_RESULT',JSON.stringify(first))
    expect(first.status).toBe('READY')
    expect(first.readiness_predicates).toMatchObject({ genuine_mcp_recovery: true, queue_progress_ready: true })
    expect(queueReceiveCount).toBe(1)
    expect(stateDaemonRestoreCalls).toHaveLength(1)
    expect(stateDaemonRestoreCalls[0]).toContain('--bootstrap-safe-defaults')
    expect(stateDaemonRestoreCalls[0]).not.toContain('--agent-allowlist')
    expect(stateDaemonRestoreCalls[0]).not.toContain('--configuration-reconciler-enabled')
    expect(stateDaemonRestoreCalls[0]).not.toContain('clean-default')
    const restoredDaemon = parseStateDaemonLaunchAgentPlist(readFileSync(
      join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME),
      'utf8',
    ))
    expect(restoredDaemon.environmentVariables.AGENT_ID).toBe(DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID)
    expect(restoredDaemon.environmentVariables.STATE_DAEMON_AGENT_ALLOWLIST).toBeUndefined()
    expect(restoredDaemon.environmentVariables.STATE_DAEMON_CONFIGURATION_RECONCILER_ENABLED).toBeUndefined()
    expect(stateDaemonReadinessCalls.length).toBeGreaterThanOrEqual(1)
    expect(stateDaemonReadinessCalls.every((args) => args.includes(DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID))).toBe(true)
    expect(stateDaemonReadinessCalls.flat()).not.toContain('clean-default')

    const contentionMessageId = randomUUID()
    const contentionDb = backend === 'postgres' ? new PgAdapter(databaseUrl!) : new SqliteAdapter(dbPath)
    const inserted = await contentionDb.query<{ id: string | number }>(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
       VALUES ($1, $2, $3, 'pending', 0, now()) RETURNING id`,
      ['clean-default', contentionMessageId, JSON.stringify({
        author_id: 'aun-bootstrap', message_type: 'instruction', content: 'bounded two-consumer contention probe',
        next_action: 'none', protected_effect_allowed: false, no_reply_required: true,
      })],
    )
    const contentionQueueId = String(inserted[0]!.id)
    await contentionDb.close()
    const contentionEnv = {
      ...env,
      AGENT_ID: 'clean-default',
      AGENT_COM_EXPECTED_AGENT_ID: 'clean-default',
      AUN_RECEIVE_CLAIM_SOURCE: `aun-bootstrap-contention:${first.run_id}`,
    }
    const invokeCli = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, 'bin/aun.ts', ...args], {
        cwd: repoRoot, env: contentionEnv, stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      return { pid: child.pid, stdout, stderr, exitCode }
    }
    const competitors = await Promise.all([
      invokeCli(['receive', '--agent-id', 'clean-default', '--queue-id', contentionQueueId]),
      invokeCli(['receive', '--agent-id', 'clean-default', '--queue-id', contentionQueueId]),
    ])
    expect(competitors.filter((result) => result.exitCode === 0)).toHaveLength(1)
    expect(new Set(competitors.map((result) => result.pid)).size).toBe(2)
    const contentionReadback = backend === 'postgres' ? new PgAdapter(databaseUrl!) : new SqliteAdapter(dbPath)
    const claimed = await contentionReadback.queryOne<any>(
      'SELECT status, claimed_by, claimed_at, payload FROM message_queue WHERE id = $1',
      [contentionQueueId],
    )
    expect(claimed?.status).toBe('received')
    expect(claimed?.claimed_by).toBe('clean-default')
    expect(JSON.parse(String(claimed?.payload)).receive_claim?.source).toBe(contentionEnv.AUN_RECEIVE_CLAIM_SOURCE)
    await contentionReadback.close()
    expect((await invokeCli(['processing', '--agent-id', 'clean-default', '--queue-id', contentionQueueId])).exitCode).toBe(0)
    expect((await invokeCli([
      'record-no-reply', '--agent-id', 'clean-default', '--queue-id', contentionQueueId,
      '--reason', `aun-bootstrap-no-effect:${first.run_id}:contention`,
    ])).exitCode).toBe(0)

    const second = await bootstrap(input, { run, observeProvider:native.observeProvider })
    if(second.status!=='IDEMPOTENT_READY')console.error('CLEAN_HOST_SECOND',JSON.stringify(second))
    expect(second.status).toBe('IDEMPOTENT_READY')
    expect(queueReceiveCount).toBe(1)
    expect(stateDaemonRestoreCalls).toHaveLength(1)
    expect(stateDaemonReadinessCalls.length).toBeGreaterThanOrEqual(2)
    expect(stateDaemonReadinessCalls.every((args) => args.includes(DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID))).toBe(true)
    expect(stateDaemonReadinessCalls.flat()).not.toContain('clean-default')
    let activeOwnedQueueId: string | null = null
    let invalidPayloadQueueId: string | null = null
    const invalidPayload = 'step one legacy queue payload'
    if (databaseUrl) {
      const ownedDb = new PgAdapter(databaseUrl)
      const activeOwned = await ownedDb.query<{ id: string | number }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at)
         VALUES ($1, $2, $3, 'pending', 0, now()) RETURNING id`,
        ['clean-default', randomUUID(), JSON.stringify({
          author_id: 'aun-bootstrap', message_type: 'instruction', content: 'run-owned rollback fixture',
          bootstrap_run_id: first.run_id, protected_effect_allowed: false, no_reply_required: true,
        })],
      )
      activeOwnedQueueId = String(activeOwned[0]!.id)
      const invalidShared = await ownedDb.query<{ id: string | number }>(
        `INSERT INTO message_queue (agent_id, message_id, payload, status, priority, created_at, done_at)
         VALUES ($1, $2, $3, 'done', 0, now(), now()) RETURNING id`,
        ['clean-default', randomUUID(), invalidPayload],
      )
      invalidPayloadQueueId = String(invalidShared[0]!.id)
      await ownedDb.close()
    }
    const rolledBack = await bootstrap({ ...input, rollbackRunId: first.run_id }, { run, observeProvider:native.observeProvider })
    if(rolledBack.status!=='ROLLED_BACK')console.error('CLEAN_HOST_ROLLBACK',JSON.stringify(rolledBack))
    expect(rolledBack.status).toBe('ROLLED_BACK')
    expect(rolledBack.reason_codes).toEqual([])
    if (fixture === 'sqlite-new') {
      expect([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    } else if (fixture === 'sqlite-existing') {
      expect(readFileSync(dbPath).equals(sqlitePrestate!)).toBe(true)
      expect([`${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)
    } else if (databaseUrl) {
      const rollbackReadback = new PgAdapter(databaseUrl)
      const queueRows = await rollbackReadback.query<any>(
        'SELECT id, status, payload FROM message_queue ORDER BY id',
      )
      const activeOwnedQueueRows = queueRows.filter((row) => {
        let payload: any = null
        try { payload = JSON.parse(String(row.payload)) } catch { return false }
        return payload?.bootstrap_run_id === first.run_id
          && ['pending', 'read', 'received', 'in_progress'].includes(String(row.status))
      })
      const activeOwned = [
        await rollbackReadback.query<any>(`SELECT runtime_instance_id FROM agent_runtime_instances
          WHERE metadata->>'bootstrap_run_id' = $1 AND status IN ('running', 'active')`, [first.run_id]),
        await rollbackReadback.query<any>(`SELECT id FROM runtime_memory_ready_evidence
          WHERE metadata->>'bootstrap_run_id' = $1 AND result_status = 'ready'`, [first.run_id]),
        activeOwnedQueueRows,
      ]
      expect(activeOwned.map((rows) => rows.length)).toEqual([0, 0, 0])
      const expiredOwned = await rollbackReadback.queryOne<any>(
        'SELECT status, failed_reason, done_at, payload FROM message_queue WHERE id = $1',
        [activeOwnedQueueId],
      )
      expect(expiredOwned?.status).toBe('skipped')
      expect(expiredOwned?.failed_reason).toBe('BOOTSTRAP_ROLLBACK')
      expect(expiredOwned?.done_at).toBeTruthy()
      expect(JSON.parse(String(expiredOwned?.payload)).bootstrap_rollback_expired).toBe(true)
      const sharedContention = await rollbackReadback.queryOne<any>('SELECT status, payload FROM message_queue WHERE id = $1', [contentionQueueId])
      expect(sharedContention?.status).toBe('done')
      expect(JSON.parse(String(sharedContention?.payload)).bootstrap_run_id).toBeUndefined()
      const invalidShared = await rollbackReadback.queryOne<any>(
        'SELECT status, payload FROM message_queue WHERE id = $1', [invalidPayloadQueueId],
      )
      expect(invalidShared).toEqual({ status: 'done', payload: invalidPayload })
      await rollbackReadback.close()
    }
  }, 60_000)

  test('daemon native pre-state fences loaded-without-plist and restores unloaded/run-created states exactly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-daemon-prestate-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    const plan: StateDaemonRestorePlan = {
      commit: 'a'.repeat(40), restoreRoot: join(home, '.agent-comms', 'state-daemon', 'checkouts'),
      checkoutPath: repoRoot, entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'),
      logsDir: join(home, 'logs'), buildOutfile: join(home, 'state-daemon'), plistPath,
      tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
      databaseUrl: 'postgresql:///disposable?host=/tmp', extraEnv: {},
    }
    const original = renderStateDaemonLaunchAgentPlist(plan, {
      SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    })
    let loaded = false
    let pid = 9001
    let restoreCalls = 0
    let bootoutCalls = 0
    const stateDaemonReadinessCalls: string[][] = []
    const run = async (command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') return loaded
        ? { exitCode: 0, stdout: launchctlSafePrint(pid), stderr: '' }
        : { exitCode: 3, stdout: '', stderr: 'not loaded' }
      if (command === 'launchctl' && args[0] === 'bootout') {
        bootoutCalls++
        loaded = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === 'launchctl' && args[0] === 'bootstrap') {
        loaded = true
        pid = 9001
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        restoreCalls++
        writeFileSync(plistPath, original, { mode: 0o644 })
        loaded = true
        pid = 9002
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
      }
      if (command === process.execPath && args.join(' ').includes('state-daemon readiness')) {
        stateDaemonReadinessCalls.push([...args])
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const env = {
      HOME: home, AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: join(home, 'disposable.db'),
      AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex',
    }
    const context = {
      runId: 'daemon-run', agentId: 'daemon-agent', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
    } satisfies BootstrapStageContext
    const ports = bootstrapInternal.createDefaultPorts({ run, env, home, repoRoot })

    loaded = true
    rmSync(plistPath, { force: true })
    const orphanLoaded = await ports.installAndStartDaemon(context)
    expect(orphanLoaded.reasonCodes).toEqual(['NO_GO_PRESTATE_UNREADABLE'])
    expect(restoreCalls).toBe(0)

    loaded = false
    writeFileSync(plistPath, original, { mode: 0o640 })
    const preExistingUnloaded = await ports.installAndStartDaemon(context)
    expect(preExistingUnloaded.ok).toBe(true)
    expect(preExistingUnloaded.mutation?.rollback_payload?.created_by_run).toBe(false)
    const restored = await ports.rollbackMutation(context, {
      mutation_id: 'daemon-m1', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...preExistingUnloaded.mutation!,
    })
    expect(restored.ok).toBe(true)
    expect(loaded).toBe(false)
    expect(readFileSync(plistPath, 'utf8')).toBe(original)
    expect(statSync(plistPath).mode & 0o777).toBe(0o640)

    loaded = false
    rmSync(plistPath, { force: true })
    const runCreated = await ports.installAndStartDaemon({ ...context, runId: 'daemon-created' })
    expect(runCreated.ok).toBe(true)
    expect(runCreated.mutation?.rollback_payload?.created_by_run).toBe(true)

    const rollbackWithoutMutation = async (mutation: typeof runCreated.mutation, candidateContext = { ...context, runId: 'daemon-created' }) => {
      const callsBefore = bootoutCalls
      const outcome = await ports.rollbackMutation(candidateContext, {
        mutation_id: 'daemon-fence', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...mutation!,
      })
      expect(outcome.ok).toBe(false)
      expect(bootoutCalls).toBe(callsBefore)
      expect(loaded).toBe(true)
      expect(existsSync(plistPath)).toBe(true)
    }
    await rollbackWithoutMutation({
      ...runCreated.mutation!,
      rollback_payload: { ...runCreated.mutation!.rollback_payload, launch_label: 'wrong.label' },
    })
    await rollbackWithoutMutation(runCreated.mutation, { ...context, runId: 'daemon-created', agentId: 'wrong-agent' })
    await rollbackWithoutMutation({
      ...runCreated.mutation!,
      rollback_payload: { ...runCreated.mutation!.rollback_payload, bootstrap_run_id: 'wrong-owner-token' },
    })
    writeFileSync(plistPath, `${original}\n<!-- drift -->\n`, { mode: 0o644 })
    await rollbackWithoutMutation(runCreated.mutation)
    writeFileSync(plistPath, original, { mode: 0o644 })
    pid = 9999
    await rollbackWithoutMutation(runCreated.mutation)
    pid = 9002
    const removed = await ports.rollbackMutation({ ...context, runId: 'daemon-created' }, {
      mutation_id: 'daemon-m2', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...runCreated.mutation!,
    })
    expect(removed.ok).toBe(true)
    expect(existsSync(plistPath)).toBe(false)
    expect(loaded).toBe(false)

    writeFileSync(plistPath, original, { mode: 0o644 })
    loaded = true
    pid = 9003
    const exactLoadedBytes = readFileSync(plistPath)
    const exactLoadedMode = statSync(plistPath).mode & 0o777
    const restoreCallsBeforeLoaded = restoreCalls
    const existingLoaded = await ports.installAndStartDaemon({ ...context, runId: 'daemon-existing' })
    expect(existingLoaded.ok).toBe(true)
    expect(existingLoaded.mutation).toBeUndefined()
    expect(restoreCalls).toBe(restoreCallsBeforeLoaded)
    expect(readFileSync(plistPath).equals(exactLoadedBytes)).toBe(true)
    expect(statSync(plistPath).mode & 0o777).toBe(exactLoadedMode)
    const resumeReadback = await ports.revalidateStage?.(context, 'B6_ORDINARY_DAEMON_INSTALL_START')
    expect(resumeReadback?.ok).toBe(true)
    expect(stateDaemonReadinessCalls).toHaveLength(2)
    expect(stateDaemonReadinessCalls.every((args) => args.includes(DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID))).toBe(true)
    expect(stateDaemonReadinessCalls.flat()).not.toContain(context.agentId)
  })

  test('profile, SQLite DB, and daemon mutations returned after nonzero are read back and exactly recoverable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-post-timeout-targets-'))
    roots.push(home)
    const repoRoot = realpathSync(join(import.meta.dir, '..', '..'))
    const dbPath = join(home, 'target.db')
    expect(Bun.spawnSync(['sqlite3', dbPath, 'CREATE TABLE before_marker(value TEXT); INSERT INTO before_marker VALUES (\'exact\');']).exitCode).toBe(0)
    const dbBefore = readFileSync(dbPath)
    const env = { HOME: home, AUN_HOME: join(home, '.aun'), AGENT_COM_DB: 'sqlite', AGENT_COM_SQLITE_PATH: dbPath }
    let profile: any = null
    let profileCreateCalls = 0
    const profileRun = async (command: string, args: string[]) => {
      const joined = args.join(' ')
      if (command === 'tmux') return { exitCode: 0, stdout: 'timeout-session\n', stderr: '' }
      if (command === 'lsof') return { exitCode: 1, stdout: '', stderr: '' }
      if (command === process.execPath && joined.includes('agent profile get')) {
        return { exitCode: 0, stdout: JSON.stringify({ profile }), stderr: '' }
      }
      if (command === process.execPath && joined.includes('agent profile set')) {
        if (args.includes('false')) {
          profile = { ...profile, profile_enabled: false }
          return { exitCode: 0, stdout: '{}', stderr: '' }
        }
        profileCreateCalls++
        profile = {
          runtime: 'TUI', runtime_engine_preference: 'codex', home_directory: repoRoot,
          channel_port: 8801, tmux_session: 'timeout-session', profile_enabled: true, profile_revision: 1,
        }
        return { exitCode: 124, stdout: '', stderr: 'timed out after profile write' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const profileContext = {
      runId: 'profile-timeout', agentId: 'timeout-agent', requestedRuntime: 'codex', resolvedRuntime: 'codex',
      repoRoot, workspaceRoot: repoRoot, repoHead: 'a'.repeat(40), dryRun: false, env,
      priorState: { mutations: [] } as any,
    } satisfies BootstrapStageContext
    const profilePorts = bootstrapInternal.createDefaultPorts({ run: profileRun, env, home, repoRoot })
    const profileFailed = await profilePorts.ensureAgentProfile(profileContext)
    expect(profileCreateCalls).toBe(1)
    expect(profileFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    expect(profileFailed.mutation?.actual_after_digest).toBeString()
    const profileRollback = await profilePorts.rollbackMutation(profileContext, {
      mutation_id: 'profile-m1', stage: 'B3_AGENT_PROFILE', rollback_status: 'not_run', ...profileFailed.mutation!,
    })
    expect(profileRollback.ok).toBe(true)
    expect(profile.profile_enabled).toBe(false)

    let migrationCalls = 0
    const databaseRun = async (command: string, args: string[]) => {
      if (command === process.execPath && args[0] === 'db/migrate.ts') {
        migrationCalls++
        expect(Bun.spawnSync(['sqlite3', dbPath, 'CREATE TABLE timeout_mutation(value TEXT);']).exitCode).toBe(0)
        return { exitCode: 124, stdout: '', stderr: 'timed out after database write' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    }
    const dbPorts = bootstrapInternal.createDefaultPorts({ run: databaseRun, env, home, repoRoot })
    const dbFailed = await dbPorts.migrateDatabase({ ...profileContext, runId: 'db-timeout' })
    expect(migrationCalls).toBe(1)
    expect(dbFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    const dbRollback = await dbPorts.rollbackMutation({ ...profileContext, runId: 'db-timeout' }, {
      mutation_id: 'db-m1', stage: 'B2_DB_MIGRATION', rollback_status: 'not_run', ...dbFailed.mutation!,
    })
    expect(dbRollback.ok).toBe(true)
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true)
    expect([`${dbPath}-wal`, `${dbPath}-shm`].every((path) => !existsSync(path))).toBe(true)

    const plistPath = join(home, 'Library', 'LaunchAgents', STATE_DAEMON_PLIST_NAME)
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
    let loaded = false
    const daemonPlan: StateDaemonRestorePlan = {
      commit: 'a'.repeat(40), restoreRoot: join(home, 'restore'), checkoutPath: repoRoot,
      entryPath: join(repoRoot, 'core', 'state-daemon', 'index.ts'), logsDir: join(home, 'logs'),
      buildOutfile: join(home, 'daemon'), plistPath, tempPlistPath: `${plistPath}.tmp`, bunPath: process.execPath,
      databaseUrl: 'postgresql:///disposable?host=/tmp', extraEnv: {},
    }
    const daemonPlist = renderStateDaemonLaunchAgentPlist(daemonPlan, {
      AGENT_ID: 'state_daemon', SHIRUBE_D1_ENABLED: '0', SHIRUBE_D1_KILL_SWITCH: '1',
      SHIRUBE_D1_TARGET_ALLOWLIST: '[]', STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED: '0',
    })
    const daemonRun = async (command: string, args: string[]) => {
      if (command === 'launchctl' && args[0] === 'print') return loaded
        ? { exitCode: 0, stdout: launchctlSafePrint(7123), stderr: '' }
        : { exitCode: 3, stdout: '', stderr: 'not loaded' }
      if (command === 'launchctl' && args[0] === 'bootout') {
        loaded = false
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      if (command === process.execPath && args[0] === 'scripts/state-daemon-launchagent.ts') {
        writeFileSync(plistPath, daemonPlist, { mode: 0o644 })
        loaded = true
        return { exitCode: 124, stdout: '', stderr: 'timed out after launchd mutation' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const daemonEnv = { ...env, AUN_BOOTSTRAP_PROCESS_RUNTIME: 'codex' }
    const daemonPorts = bootstrapInternal.createDefaultPorts({ run: daemonRun, env: daemonEnv, home, repoRoot })
    const daemonFailed = await daemonPorts.installAndStartDaemon({ ...profileContext, runId: 'daemon-timeout', env: daemonEnv })
    expect(daemonFailed.reasonCodes).toEqual(['NO_GO_POST_MUTATION_READBACK'])
    const daemonRollback = await daemonPorts.rollbackMutation({ ...profileContext, runId: 'daemon-timeout', env: daemonEnv }, {
      mutation_id: 'daemon-timeout-m1', stage: 'B6_ORDINARY_DAEMON_INSTALL_START', rollback_status: 'not_run', ...daemonFailed.mutation!,
    })
    expect(daemonRollback.ok).toBe(true)
    expect(loaded).toBe(false)
    expect(existsSync(plistPath)).toBe(false)
  })

  test('real CLI dry-run reaches PLANNED on a clean host and leaves no files', () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-plan-host-'))
    roots.push(home)
    const stubDir = join(home, 'bin')
    mkdirSync(stubDir)
    const stub = (name: string, body: string) => {
      const path = join(stubDir, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o755)
    }
    stub('git', 'case "$*" in "rev-parse HEAD") echo c8eb30805a587a65a794499fa597935f2460c703;; "--version") echo "git version 2.50.0";; esac')
    stub('node', 'echo v20.20.0')
    stub('tmux', 'echo clean-host-session')
    stub('launchctl', 'exit 0')
    stub('codex', 'case "$*" in "mcp get wasurezu --json") exit 1;; *) echo codex-cli 1.0.0;; esac')
    stub('ps', 'exit 1')
    stub('lsof', 'exit 1')
    const dbPath = join(home, 'agent-com.db')
    const result = Bun.spawnSync([
      process.execPath, 'bin/aun.ts', 'bootstrap', '--agent-id', 'clean-plan', '--runtime', 'codex', '--dry-run', '--json',
    ], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        AUN_HOME: join(home, '.aun'),
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        CODEX_SANDBOX: 'workspace-write',
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: 'PLANNED', resolved_runtime: 'codex' })
    expect(existsSync(dbPath)).toBe(false)
    expect(existsSync(join(home, '.aun')) ? readdirSync(join(home, '.aun')) : []).toEqual([])
  })

  test('writes only a mode-0600 redacted run record beneath AUN_HOME/bootstrap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aun-bootstrap-clean-'))
    roots.push(home)
    const pass = async () => ({ ok: true })
    const ports: BootstrapExecutionPorts = {
      lockAndSnapshot: pass,
      dependencyPreflight: async () => ({ ok: true, resolvedRuntime: 'codex', evidenceRefs: ['token=must-not-leak'] }),
      migrateDatabase: pass, ensureAgentProfile: pass, ensureMcpRegistration: pass,
      ensureMemoryReadiness: pass, installAndStartDaemon: pass, runQueueSmoke: pass,
      readbackReady: pass, rollbackMutation: pass,
    }
    const result = await bootstrap({
      agentId: 'clean-host', runtime: 'codex', home, repoRoot: process.cwd(),
      env: { HOME: home, AUN_HOME: join(home, '.aun'), DISCORD_BOT_TOKEN: 'super-secret-value' },
    }, { ports, run: async (command, args) => command === 'codex' && args.join(' ') === 'mcp get wasurezu --json'
      ? { exitCode: 1, stdout: '', stderr: 'not configured' }
      : { exitCode: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' } })
    expect(result.status).toBe('READY')
    const path = join(home, '.aun', 'bootstrap', 'clean-host', `${result.run_id}.json`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const body = readFileSync(path, 'utf8')
    expect(body).not.toContain('super-secret-value')
    expect(body).not.toContain('must-not-leak')
  })
})
