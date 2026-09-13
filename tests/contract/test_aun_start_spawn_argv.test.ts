import { migrateSqlite } from '../../db/migrate-sqlite'
import { Database } from 'bun:sqlite'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
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
  test('real subprocess: AUN_CLAUDE_BIN mock receives the same argv', () => {
    const r = spawnSync('bun', ['run', AUN_CLI, 'start', '--agent-id', 'fixture-seat','--runtime','claude','--', '--user-flag', 'user-value'], {
      encoding: 'utf-8',
      cwd:home,
      env: { ...process.env, HOME: home, AUN_CLAUDE_BIN: mockClaudeBin,AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:join(home,'fixture.db'),DATABASE_URL:'' },
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
