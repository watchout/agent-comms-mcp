import { resolveSeatProvider, readObservedProviderRoot, normalizeSeatProvider, type SeatProvider } from '../../core/seat-runtime-selection'
import { SqliteAdapter, PgAdapter } from '../../core/db'
/**
 * `aun start` — spawn claude with the aun launch flags (spec v6 v1.2 §1.4.2).
 *
 * Cycle 3 redesign: claude CLI flags live HERE, not in settings.json
 * mcpServers.args. The wrapper:
 *
 *   1. Resolves the claude binary (override via AUN_CLAUDE_BIN).
 *   2. Spawns it with stdio inherited from this process.
 *   3. Forwards SIGINT / SIGTERM to the child.
 *   4. Exits with the child's exit code so script-level launchers
 *      (`scripts/run-bot.sh`) can rely on conventional shell semantics.
 *
 * Flag set (frozen, §1.4.2 verbatim — order matters because the
 * `server:aun` value must follow `--dangerously-load-development-channels`):
 *
 *   --mcp-config "${AUN_MCP_CONFIG:-$HOME/.claude.json}"
 *   --dangerously-skip-permissions
 *   --dangerously-load-development-channels server:aun
 *   ...userArgs (verbatim pass-through)
 *
 * Pre-flight CLI signature drift check (cycle 1 carry-over) runs
 * unless `checkSignatures: false`. Drift is informational; we never
 * block the launch.
 */
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { captureSignatures, loadBaseline, compareToBaseline } from './lib/cli-signature-verify'

export class StartSpawnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StartSpawnError'
  }
}

export interface StartOptions {
  agentId?: string
  runtime?: string
  db?: {query:(sql:string,params?:any[])=>Promise<any>;close?:()=>Promise<void>}
  home?: string
  cwd?: string
  mcpConfig?: Record<string, any>
  env?: NodeJS.ProcessEnv
  /** Pass-through args appended verbatim to the claude invocation. */
  extraArgs?: string[]
  /** Run the pre-flight signature check (default true). */
  checkSignatures?: boolean
  /** Actually spawn claude (default true; tests set false to inspect
   *  the constructed argv without launching anything). */
  spawn?: boolean
}

export interface StartResult {
  ok: boolean
  /** The full argv that was (or would be) passed to spawn. argv[0] is
   *  the claude binary; argv[1..] are the flags + user pass-through.
   */
  argv: string[]
  driftWarnings: string[]
  spawned: boolean
  errors: string[]
  /** PID of the spawned child, when applicable. */
  childPid?: number
}

function homeFor(opts: StartOptions): string {
  return opts.home ?? opts.env?.HOME ?? homedir()
}

function resolveMcpConfig(opts: StartOptions): string {
  const env = opts.env ?? process.env
  const explicit = env.AUN_MCP_CONFIG
  if (explicit && explicit.trim() !== '') return explicit
  return join(homeFor(opts), '.claude.json')
}

function resolveClaudeBin(opts: StartOptions): string {
  const env = opts.env ?? process.env
  return env.AUN_CLAUDE_BIN || 'claude'
}

/**
 * Build the argv we would hand to `spawn`. Exported so the contract
 * test (`test_aun_start_spawn_argv`) can verify the flag set without
 * actually launching claude.
 */
export function buildStartArgv(opts: StartOptions = {}): string[] {
  const provider = normalizeSeatProvider(opts.runtime)
  if (!provider) throw new StartSpawnError('PROVIDER_MISSING')
  if (provider === 'codex') {
    const overrides:string[]=[]
    for(const [name,config] of Object.entries(opts.mcpConfig?.mcpServers ?? {})) {
      // Native invocation overrides isolate seat identity from shared account settings.
      overrides.push('-c',`mcp_servers.${name}.enabled=true`)
      if(config.command) overrides.push('-c',`mcp_servers.${name}.command=${JSON.stringify(config.command)}`)
      if(config.args) overrides.push('-c',`mcp_servers.${name}.args=${JSON.stringify(config.args)}`)
      for(const [key,value] of Object.entries(config.env ?? {})) overrides.push('-c',`mcp_servers.${name}.env.${key}=${JSON.stringify(String(value))}`)
    }
    return [(opts.env ?? process.env).AUN_CODEX_BIN || 'codex','--dangerously-bypass-approvals-and-sandbox',...overrides,...(opts.extraArgs ?? [])]
  }
  const claudeBin = resolveClaudeBin(opts)
  const mcpConfig = opts.mcpConfig ? JSON.stringify(opts.mcpConfig) : resolveMcpConfig(opts)
  return [
    claudeBin,
    '--mcp-config', mcpConfig,
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels', opts.mcpConfig?.mcpServers?.['agent-comms'] ? 'server:agent-comms' : 'server:aun',
    ...(opts.extraArgs ?? []),
  ]
}

export async function start(opts: StartOptions = {}): Promise<StartResult> {
  const errors: string[] = []
  const driftWarnings: string[] = []
  const env = {...(opts.env ?? process.env)}
  const agentId = opts.agentId ?? env.AGENT_ID
  if (!agentId) return {ok:false,argv:[],driftWarnings,spawned:false,errors:['SEAT_ID_REQUIRED']}
  const db = opts.db ?? (env.AGENT_COM_DB === 'sqlite'
    ? new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
    : new PgAdapter(env.AGENT_COMMS_DATABASE_URL ?? env.DATABASE_URL ?? 'postgresql:///agent_comms?host=/tmp'))
  let provider: SeatProvider | null = null
  let workspace=resolve(opts.cwd ?? process.cwd())
  try {
    const profileRead = await db.query('SELECT agent_id, profile_enabled, disabled_at FROM agents WHERE agent_id = $1',[agentId])
    const profiles = Array.isArray(profileRead) ? profileRead : profileRead.rows
    if (profiles.length !== 1 || ![true,1].includes(profiles[0].profile_enabled) || profiles[0].disabled_at) throw new Error('SEAT_DISABLED_OR_MISSING')
    const selected = await resolveSeatProvider(db,{agentId,intent:opts.runtime === 'auto' ? null : opts.runtime,allowHistory:true})
    if (!selected.ok) throw new Error(selected.code)
    provider = selected.provider
    if (!opts.cwd && selected.observation) workspace=selected.observation.workspace
    if(selected.code==='SELECTED_LIVE' && selected.provider==='codex' && selected.observation) {
      const root=await readObservedProviderRoot(async(command,args)=>{
        try {return {exitCode:0,stdout:execFileSync(command,args,{encoding:'utf8',timeout:3000})}}
        catch {return {exitCode:1,stdout:''}}
      },{pid:selected.observation.provider_pid,startedAt:selected.observation.provider_started_at,cwd:workspace,env:env as Record<string,string>})
      if(!root) throw new Error('PROVIDER_ACCOUNT_ROOT_UNAVAILABLE')
      env.CODEX_HOME=root.root
    }
  } catch (error) {
    return {ok:false,argv:[],driftWarnings,spawned:false,errors:[(error as Error).message]}
  } finally {if (!opts.db) await db.close?.()}
  const aunHome = join(homeFor(opts), '.aun')
  const baselinePath = join(aunHome, 'cli-baselines.json')

  if (opts.checkSignatures !== false) {
    try {
      const baseline = loadBaseline(baselinePath)
      if (baseline) {
        const current = captureSignatures()
        const report = compareToBaseline(current, baseline)
        for (const d of report.drifted) {
          driftWarnings.push(`[cli-drift ${d.reason}] ${d.name}: ${d.diffSummary}`)
        }
      }
    } catch {
      // Best-effort; never blocks launch.
    }
  }

  let config:Record<string,any>={mcpServers:{}}
  const configPath=env.AUN_MCP_CONFIG || join(workspace,'.mcp.json')
  try {
    if(existsSync(configPath)) config=JSON.parse(readFileSync(configPath,'utf8'))
    config.mcpServers ??={}
    if(config.mcpServers.aun && config.mcpServers['agent-comms']) throw new Error('ambiguous bridge aliases')
    const bridgeName=config.mcpServers['agent-comms'] ? 'agent-comms' : 'aun'
    const previous=config.mcpServers[bridgeName] ?? {}
    const memory=config.mcpServers.wasurezu ?? config.mcpServers['agent-memory']
    // Read the existing account's memory transport, then bind only this invocation.
    // Native account files remain byte-identical.
    const nativePath=provider==='codex' ? join(env.CODEX_HOME || join(homeFor(opts),'.codex'),'config.toml') : join(homeFor(opts),'.claude.json')
    if(existsSync(nativePath)) {
      const native=provider==='codex' ? Bun.TOML.parse(readFileSync(nativePath,'utf8')) : JSON.parse(readFileSync(nativePath,'utf8'))
      const servers=provider==='codex' ? native.mcp_servers : native.mcpServers
      const otherBridge=servers?.[bridgeName==='aun'?'agent-comms':'aun']
      if(otherBridge && otherBridge.enabled!==false) throw new Error('ambiguous native bridge alias')
      for(const alias of ['wasurezu','agent-memory']) if(servers?.[alias] && !config.mcpServers[alias]) {
        const entry=servers[alias]
        if(typeof entry.command!=='string'||!Array.isArray(entry.args)) throw new Error('unsupported native memory transport')
        config.mcpServers[alias]={command:entry.command,args:entry.args,env:entry.env ?? {}}
      }
    }
    const project=env.AGENT_MEMORY_PROJECT || memory?.env?.AGENT_MEMORY_PROJECT || previous.env?.AGENT_MEMORY_PROJECT || basename(workspace)
    config.mcpServers[bridgeName]={...previous,command:env.AGENT_COMMS_BUN_COMMAND || process.execPath,
      args:['run',resolve(import.meta.dir,'../../server.ts')],env:{...previous.env,
        AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,AGENT_COM_WORKSPACE:workspace,
        AGENT_MEMORY_PROJECT:project,WEBHOOK_PORT:'0',AUN_WEBHOOK_PORT:'0',
        AGENT_COM_RUNTIME_HEARTBEAT_DISABLED:'0',AGENT_COMMS_TTL_SWEEP_DISABLED:'1',
        ...(env.AGENT_COM_RUNTIME_SESSION ? {AGENT_COM_RUNTIME_SESSION:env.AGENT_COM_RUNTIME_SESSION}: {})}}
    for(const [name,value] of Object.entries(config.mcpServers) as Array<[string,any]>) {
      if(name==='wasurezu'||name==='agent-memory') value.env={...value.env,AGENT_MEMORY_AGENT_ID:agentId,AGENT_MEMORY_PROJECT:project}
    }
  } catch {return {ok:false,argv:[],driftWarnings,spawned:false,errors:['SEAT_MCP_CONFIG_INVALID']}}
  const argv = buildStartArgv({...opts,env,runtime:provider!,mcpConfig:config})

  if (opts.spawn === false) {
    return { ok: true, argv, driftWarnings, spawned: false, errors }
  }

  let child
  try {
    child = spawn(argv[0], argv.slice(1), {
      stdio: 'inherit',
      cwd:workspace,
      env: {...env,AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,AGENT_MEMORY_AGENT_ID:agentId,AGENT_MEMORY_PROJECT:config.mcpServers.aun?.env.AGENT_MEMORY_PROJECT ?? config.mcpServers['agent-comms']?.env.AGENT_MEMORY_PROJECT,WEBHOOK_PORT:'0',AUN_WEBHOOK_PORT:'0'},
    })
  } catch (err) {
    const e = new StartSpawnError(`failed to spawn ${argv[0]}: ${(err as Error).message}`)
    errors.push(e.message)
    return { ok: false, argv, driftWarnings, spawned: false, errors }
  }

  // Forward common termination signals so Ctrl-C in the parent shell
  // reaches the claude session. Ignore send failures — the child may
  // already have exited.
  const forward = (sig: NodeJS.Signals) => {
    try { child.kill(sig) } catch { /* child gone */ }
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))

  // Inherit the child's exit code so shell-level callers can branch on
  // a successful claude session vs an aborted one.
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal) } catch { process.exit(1) }
      return
    }
    process.exit(code ?? 0)
  })

  return { ok: true, argv, driftWarnings, spawned: true, errors, childPid: child.pid }
}
