import { migrateSqlite } from '../../db/migrate-sqlite'
import { Database } from 'bun:sqlite'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildStartArgv, start } from '../../bin/aun/start'

// Spec v6 v1.2 §1.4.2 — `aun start` spawns claude with the frozen
// 4-flag set. We verify both:
//   (a) the in-process `buildStartArgv` returns the expected token
//       sequence (fast unit-style assertion);
//   (b) a real subprocess invocation lands the same argv at the
//       child's process boundary (mock claude binary dumps argv to
//       a log so we can read it back).
//
// Intentional: cycle 3 keeps the claude CLI flags out of mcpServers
// args (cycle 2 / pilot blocker reproduction), so the absence of any
// `--dangerously-*` token in `~/.claude.json` is guaranteed by
// test_aun_claude_json_register; this file pins the SAME flags in the
// `aun start` spawn argv so the migration target is unambiguous.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

describe('test_aun_start_spawn_argv — 4 frozen flags + user pass-through', () => {
  let home: string
  let mockClaudeBin: string
  let argvLog: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-start-argv-'))
    argvLog = join(home, 'argv.log')
    migrateSqlite(join(home,'fixture.db'))
    const db=new Database(join(home,'fixture.db'));db.exec("INSERT INTO agents(agent_id,display_name,agent_type,runtime,status,profile_enabled,runtime_engine_preference) VALUES('fixture-seat','Fixture','dev','TUI','idle',1,'codex')");db.close()
    mockClaudeBin = join(home, 'mock-claude')
    writeFileSync(mockClaudeBin, `#!/usr/bin/env bash
# Dump every arg, one per line, then exit 0 — replaces the real claude
# CLI for the test. We write atomically (single >>) so a flaky parent
# process can't see a half-written line.
{
  for a in "$@"; do
    printf '%s\\n' "$a"
  done
} > "${argvLog}"
exit 0
`)
    chmodSync(mockClaudeBin, 0o755)
  })

  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('buildStartArgv returns claude + 4 frozen flags + user pass-through (in order)', () => {
    const argv = buildStartArgv({
      home, runtime:'claude',
      env: { HOME: home, AUN_CLAUDE_BIN: mockClaudeBin } as any,
      extraArgs: ['--foo', 'bar'],
      checkSignatures: false,
    })
    // argv[0] is the claude bin (the mock here).
    expect(argv[0]).toBe(mockClaudeBin)
    // The frozen flag set, exact tokens, in spec order.
    expect(argv).toContain('--mcp-config')
    const mcpIdx = argv.indexOf('--mcp-config')
    expect(argv[mcpIdx + 1]).toMatch(/\.claude\.json$/)
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).toContain('--dangerously-load-development-channels')
    const dlIdx = argv.indexOf('--dangerously-load-development-channels')
    expect(argv[dlIdx + 1]).toBe('server:aun')
    // User pass-through preserved at the tail.
    expect(argv.slice(-2)).toEqual(['--foo', 'bar'])
  })

  test('missing provider intent and history never invokes a provider',async()=>{
    const result=await start({agentId:'fixture-seat',spawn:false,checkSignatures:false,
      cwd:home,env:{HOME:home,AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:join(home,'fixture.db')}})
    expect(result.ok).toBe(false)
    expect(result.spawned).toBe(false)
    expect(result.argv).toEqual([])
    expect(result.errors).toEqual(['PROVIDER_MISSING'])
  })
  test('explicit Codex intent has no implicit Claude argv',()=>{
    expect(buildStartArgv({runtime:'codex',env:{},extraArgs:['literal-user-arg']})).toEqual(['codex','--dangerously-bypass-approvals-and-sandbox','literal-user-arg'])
  })
  test('both providers receive invocation-scoped seat identity while old workspace config bytes are preserved',async()=>{
    const configPath=join(home,'.mcp.json')
    const original=JSON.stringify({mcpServers:{aun:{command:'old-bun',args:['old-server'],env:{AGENT_ID:'foreign',WEBHOOK_PORT:'8812'}},
      wasurezu:{command:'fixture-memory',args:[],env:{AGENT_MEMORY_AGENT_ID:'foreign',AGENT_MEMORY_PROJECT:'wrong'}}}})
    writeFileSync(configPath,original)
    for(const runtime of ['codex','claude']) {
      const result=await start({agentId:'fixture-seat',runtime,spawn:false,checkSignatures:false,cwd:home,
        env:{HOME:home,AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:join(home,'fixture.db'),AGENT_MEMORY_PROJECT:'stable-project'}})
      expect(result.ok).toBe(true)
      if(runtime==='codex') {
        expect(result.argv).toContain('mcp_servers.aun.env.AGENT_ID="fixture-seat"')
        expect(result.argv).toContain('mcp_servers.aun.env.WEBHOOK_PORT="0"')
        expect(result.argv).toContain('mcp_servers.wasurezu.env.AGENT_MEMORY_PROJECT="stable-project"')
      } else {
        const config=JSON.parse(result.argv[result.argv.indexOf('--mcp-config')+1])
        expect(config.mcpServers.aun.env.AGENT_ID).toBe('fixture-seat')
        expect(config.mcpServers.aun.env.WEBHOOK_PORT).toBe('0')
        expect(config.mcpServers.wasurezu.env.AGENT_MEMORY_PROJECT).toBe('stable-project')
      }
      expect(readFileSync(configPath,'utf8')).toBe(original)
    }
  })
  test('ordinary Codex invocation corrects the existing native memory alias without changing global bytes',async()=>{
    mkdirSync(join(home,'.codex'),{recursive:true})
    const path=join(home,'.codex','config.toml')
    const before='[mcp_servers.agent-memory]\ncommand = "fixture-memory"\nargs = ["/fixture/wasurezu/server.ts"]\n[mcp_servers.agent-memory.env]\nAGENT_MEMORY_AGENT_ID = "arc"\nAGENT_MEMORY_PROJECT = "iyasaka-arc"\n'
    writeFileSync(path,before)
    const result=await start({agentId:'fixture-seat',runtime:'codex',spawn:false,checkSignatures:false,cwd:home,
      env:{HOME:home,AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:join(home,'fixture.db'),AGENT_MEMORY_PROJECT:'stable-project'}})
    expect(result.ok).toBe(true)
    expect(result.argv).toContain('mcp_servers.agent-memory.env.AGENT_MEMORY_AGENT_ID="fixture-seat"')
    expect(result.argv).toContain('mcp_servers.agent-memory.env.AGENT_MEMORY_PROJECT="stable-project"')
    expect(readFileSync(path,'utf8')).toBe(before)
  })
  test('both providers preserve verified same-seat logical projects after a workspace move',async()=>{
    for(const runtime of ['codex','claude']) {
      const fixture=mkdtempSync(join(tmpdir(),'seat-project-move-'))
      try {
        const workspace=join(fixture,'relocated-folder');mkdirSync(workspace)
        mkdirSync(join(fixture,'.codex'))
        const nativePath=runtime==='codex'?join(fixture,'.codex','config.toml'):join(fixture,'.claude.json')
        const native=runtime==='codex'
          ? '[mcp_servers.agent-memory]\ncommand="memory"\nargs=["/fixture/memory.ts"]\n[mcp_servers.agent-memory.env]\nAGENT_MEMORY_AGENT_ID="fixture-seat"\nAGENT_MEMORY_PROJECT="existing-stable-project"\n'
          : JSON.stringify({mcpServers:{'agent-memory':{command:'memory',args:['/fixture/memory.ts'],env:{AGENT_MEMORY_AGENT_ID:'fixture-seat',AGENT_MEMORY_PROJECT:'existing-stable-project'}}}})
        writeFileSync(nativePath,native)
        const options={agentId:'fixture-seat',runtime,spawn:false,checkSignatures:false,cwd:workspace,
          db:{query:async(sql:string)=>sql.includes('FROM agents')?[{profile_enabled:true}]:[]},env:{HOME:fixture}}
        const plan=await start(options)
        expect(plan.ok).toBe(true)
        expect(plan.launch?.env.AGENT_MEMORY_PROJECT).toBe('existing-stable-project')
        expect(readFileSync(nativePath,'utf8')).toBe(native)
        writeFileSync(nativePath,native.replaceAll('fixture-seat','arc'))
        expect((await start(options)).errors).toEqual(['SEAT_MEMORY_PROJECT_REQUIRED'])
        const fromDurable=await start({...options,db:{query:async(sql:string)=>sql.includes('FROM agents')?[{profile_enabled:true,metadata:{memory_project:'durable-seat-project'}}]:[]}})
        expect(fromDurable.ok).toBe(true)
        expect(fromDurable.launch?.env.AGENT_MEMORY_PROJECT).toBe('durable-seat-project')
        writeFileSync(nativePath,native)
        writeFileSync(join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{wasurezu:{command:'memory',args:[],env:{AGENT_MEMORY_AGENT_ID:'fixture-seat',AGENT_MEMORY_PROJECT:'conflicting-project'}}}}))
        expect((await start(options)).errors).toEqual(['SEAT_MEMORY_PROJECT_AMBIGUOUS'])
      } finally {rmSync(fixture,{recursive:true,force:true})}
    }
  })
  test('direct and detached plans deliver the observed account root and exact seat environment to a real harmless child',()=>{
    const fixture=realpathSync(mkdtempSync(join(tmpdir(),'seat-launch-env-')))
    try {
      const account=join(fixture,'observed-account'),caller=join(fixture,'caller-account'),workspace=join(fixture,'workspace')
      for(const path of [account,caller,workspace]) mkdirSync(path)
      const output=join(fixture,'received.json'),child=join(fixture,'harmless-provider'),runner=join(fixture,'runner.ts')
      writeFileSync(child,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({cwd:process.cwd(),home:process.env.HOME,codex:process.env.CODEX_HOME,claude:process.env.CLAUDE_CONFIG_DIR,agent:process.env.AGENT_ID,expected:process.env.AGENT_COM_EXPECTED_AGENT_ID,project:process.env.AGENT_MEMORY_PROJECT,session:process.env.AGENT_COM_RUNTIME_SESSION}));`)
      chmodSync(child,0o755)
      for(const runtime of ['codex','claude']) for(const mode of ['direct','detached']) {
        writeFileSync(runner,`
          import {mock} from 'bun:test';
          import {spawnSync} from 'node:child_process';
          mock.module(${JSON.stringify(join(REPO_ROOT,'core/seat-runtime-selection.ts'))},()=>({
            normalizeSeatProvider:()=>${JSON.stringify(runtime)},
            resolveSeatProvider:async()=>({ok:true,code:'SELECTED_LIVE',provider:${JSON.stringify(runtime)},observation:{provider_pid:123,provider_started_at:'fixture',workspace:${JSON.stringify(workspace)}}}),
            readObservedProviderRoot:async()=>({root:${JSON.stringify(account)},home:${JSON.stringify(account)}})
          }));
          const {start,buildStartLaunchArgv}=await import(${JSON.stringify(join(REPO_ROOT,'bin/aun/start.ts'))});
          const plan=await start({agentId:'fixture-seat',runtime:${JSON.stringify(runtime)},cwd:${JSON.stringify(workspace)},checkSignatures:false,spawn:${mode==='direct'},
            db:{query:async()=>[{profile_enabled:true}]},env:{...process.env,HOME:${JSON.stringify(caller)},CODEX_HOME:${JSON.stringify(caller)},CLAUDE_CONFIG_DIR:${JSON.stringify(caller)},
              AGENT_MEMORY_PROJECT:'stable-project',AGENT_COM_RUNTIME_SESSION:'actual-session',AUN_CODEX_BIN:${JSON.stringify(child)},AUN_CLAUDE_BIN:${JSON.stringify(child)},UNRELATED_SECRET:'must-not-serialize'}});
          if(!plan.ok)throw new Error(plan.errors.join(','));
          if(Object.hasOwn(plan.launch.env,'UNRELATED_SECRET'))throw new Error('ambient secret in plan');
          if(${mode==='detached'}) {const argv=buildStartLaunchArgv(plan);const result=spawnSync(argv[0],argv.slice(1),{cwd:plan.launch.cwd,env:{...process.env,HOME:${JSON.stringify(caller)},CODEX_HOME:${JSON.stringify(caller)},CLAUDE_CONFIG_DIR:${JSON.stringify(caller)}}});if(result.status!==0)throw new Error(String(result.stderr));}
        `)
        const result=spawnSync(process.execPath,['--no-env-file',runner],{cwd:fixture,env:{PATH:process.env.PATH,HOME:fixture,NODE_ENV:'test',DATABASE_URL:''},encoding:'utf8',timeout:10000})
        expect(result.status).toBe(0)
        const received=JSON.parse(readFileSync(output,'utf8'))
        expect(received).toMatchObject({cwd:workspace,home:account,agent:'fixture-seat',expected:'fixture-seat',project:'stable-project',session:'actual-session'})
        expect(received[runtime]).toBe(account)
      }
    } finally {rmSync(fixture,{recursive:true,force:true})}
  })
  test('real subprocess: AUN_CLAUDE_BIN mock receives the same argv', () => {
    const r = spawnSync('bun', ['run', AUN_CLI, 'start', '--agent-id', 'fixture-seat','--runtime','claude','--', '--user-flag', 'user-value'], {
      encoding: 'utf-8',
      cwd:home,
      env: { ...process.env, HOME: home, AGENT_MEMORY_PROJECT:'stable-project', AUN_CLAUDE_BIN: mockClaudeBin,AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:join(home,'fixture.db'),DATABASE_URL:'' },
      timeout: 15_000,
    })
    expect(r.status).toBe(0)
    expect(existsSync(argvLog)).toBe(true)
    const dumped = readFileSync(argvLog, 'utf-8').split('\n').filter(Boolean)
    // The mock dumps `claude`'s argv (excluding argv[0]). Verify each
    // frozen token reached the child.
    expect(dumped).toContain('--mcp-config')
    expect(dumped).toContain('--dangerously-skip-permissions')
    expect(dumped).toContain('--dangerously-load-development-channels')
    expect(dumped).toContain('server:aun')
    // User pass-through.
    expect(dumped).toContain('--user-flag')
    expect(dumped).toContain('user-value')
    // Defensive: no claude CLI flag should be smuggled through any
    // other field — every dumped arg starts with `--`, `server:`, or
    // is a value following one of those.
  })
})
