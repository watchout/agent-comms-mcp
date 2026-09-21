import { inspectHostRuntime, type HostRuntimeInspector } from './host-runtime-observer'
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseProcessList, type ProcessSnapshot } from './tmux-runtime-inspector'

/** Physical observations are request-local and must never be persisted. */
export type SeatProvider = 'codex' | 'claude'
export interface SeatProviderObservation {
  schema_version: 'seat-provider-observation/v1'
  agent_id: string
  runtime_instance_id: string
  host_id: string
  process_id: number
  provider_pid: number
  provider_started_at: string
  host_session_id?: string | null
  provider: SeatProvider
  session_name: string
  workspace: string
  observed_at: string
  source: 'process_ancestry'
  verified: true
}
export type SeatProviderSelection = {
  ok: boolean
  provider: SeatProvider | null
  code: 'SELECTED_LIVE' | 'SELECTED_INTENT' | 'SELECTED_HISTORY' | 'PROVIDER_MISSING' | 'PROVIDER_AMBIGUOUS' | 'PROVIDER_UNSUPPORTED'
  observation: SeatProviderObservation | null
}
export function normalizeSeatProvider(value: unknown): SeatProvider | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'codex' || raw === 'codex-runner' || raw === 'codex-exec') return 'codex'
  if (raw === 'claude' || raw === 'claude-code') return 'claude'
  return null
}
/** Shared precedence after each caller has verified its exact identity evidence. */
export function selectObservedProvider(providers: SeatProvider[], intent?: string | null): SeatProviderSelection {
  const requested = normalizeSeatProvider(intent)
  const fail = (code: SeatProviderSelection['code']): SeatProviderSelection => ({ok:false,provider:null,code,observation:null})
  if (intent && !requested) return fail('PROVIDER_UNSUPPORTED')
  if (providers.length > 1 || (providers.length && requested && providers[0] !== requested)) return fail('PROVIDER_AMBIGUOUS')
  if (providers.length) return {ok:true,provider:providers[0],code:'SELECTED_LIVE',observation:null}
  if (requested) return {ok:true,provider:requested,code:'SELECTED_INTENT',observation:null}
  return fail('PROVIDER_MISSING')
}
export function providerExecutable(command: string): SeatProvider | null {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const name = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').replaceAll('\\', '/').split('/').pop()
  return name === 'codex' || name === 'codex.exe' ? 'codex' : name === 'claude' || name === 'claude.exe' ? 'claude' : null
}
// ps lstart has no zone. Read and parse it in the same explicit UTC zone;
// the JS host/test timezone may differ from the operating-system default.
function processStartIso(value: string): string {
  const text = value.trim()
  return new Date(/^\d{4}-\d\d-\d\dT/.test(text) ? text : `${text} UTC`).toISOString()
}
export function observeSeatProvider(input: {
  agentId: string; runtimeInstanceId: string; processId: number; sessionName: string; workspace: string
  hostId?: string; now?: Date; processes?: ProcessSnapshot[]; providerStartedAt?: string
}): SeatProviderObservation | null {
  if (!input.agentId || !input.runtimeInstanceId || !input.sessionName || !input.workspace) return null
  let processes = input.processes
  if (!processes) {
    try { processes = parseProcessList(execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000 })) }
    catch { return null }
  }
  const byPid = new Map(processes.map(p => [p.pid, p]))
  let current = byPid.get(input.processId)
  if (!current) return null
  let identityCommand = current.command
  if (!input.processes) {
    try { identityCommand = execFileSync('ps', ['eww','-p',String(input.processId),'-o','command='], {encoding:'utf8',timeout:3000}) }
    catch { return null }
  }
  if (!input.processes) {
    try {
      const cwd=execFileSync('lsof',['-a','-p',String(input.processId),'-d','cwd','-Fn'],{encoding:'utf8',timeout:3000})
        .split('\n').find(line=>line.startsWith('n'))?.slice(1)
      if(!cwd || realpathSync(cwd)!==realpathSync(input.workspace)) return null
    } catch {return null}
  }
  const actual = identityCommand.match(/(?:^|\s)AGENT_ID=(\S+)/)?.[1]
  const expected = identityCommand.match(/(?:^|\s)AGENT_COM_EXPECTED_AGENT_ID=(\S+)/)?.[1]
  if (actual !== input.agentId || (expected && expected !== input.agentId)) return null
  const seen = new Set<number>()
  for (let depth = 0; current && depth < 32 && !seen.has(current.pid); depth++) {
    seen.add(current.pid)
    const provider = providerExecutable(current.command)
    if (provider) {
      let startedAt = input.providerStartedAt ?? ''
      let providerEnvironment = identityCommand
      if (!input.processes) {
        try {
          startedAt = processStartIso(execFileSync('ps',['-p',String(current.pid),'-o','lstart='],{encoding:'utf8',timeout:3000,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}))
          providerEnvironment = execFileSync('ps',['eww','-p',String(current.pid),'-o','command='],{encoding:'utf8',timeout:3000})
        } catch { return null }
      }
      if (!startedAt) return null
      const sessionKey = provider === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_SESSION_ID'
      const hostSessionId = providerEnvironment.match(new RegExp(`(?:^|\\s)${sessionKey}=(\\S+)`))?.[1] ?? null
      return {
      schema_version: 'seat-provider-observation/v1', agent_id: input.agentId,
      runtime_instance_id: input.runtimeInstanceId, host_id: input.hostId ?? hostname(),
      process_id: input.processId, provider_pid: current.pid, provider_started_at:startedAt, host_session_id:hostSessionId, provider,
      session_name: input.sessionName, workspace: input.workspace,
      observed_at: (input.now ?? new Date()).toISOString(), source: 'process_ancestry', verified: true,
      }
    }
    current = byPid.get(current.ppid)
  }
  return null
}
export async function readObservedProviderRoot(run: (command:string,args:string[],options:any)=>Promise<{exitCode:number;stdout:string}>,
  input:{pid:number;startedAt:string;cwd:string;env:Record<string,string>;provider?:SeatProvider}) {
  const options={cwd:input.cwd,env:{...input.env,TZ:'UTC',LC_ALL:'C'},timeoutMs:3000}
  const start = async () => {
    const r=await run('ps',['-p',String(input.pid),'-o','lstart='],options)
    return r.exitCode === 0 ? processStartIso(r.stdout) : null
  }
  try {
    if (await start() !== input.startedAt) return null
    const result=await run('ps',['eww','-p',String(input.pid),'-o','command='],options)
    if (result.exitCode !== 0 || providerExecutable(result.stdout) !== (input.provider ?? 'codex')) return null
    const values=(key:string)=>[...result.stdout.matchAll(new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`,'g'))].map(m=>m[1].trim())
    const homes=values(input.provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME'), nativeHomes=values('HOME')
    if (new Set(homes).size>1 || new Set(nativeHomes).size>1) return null
    const requested=homes[0] || (nativeHomes[0] ? join(nativeHomes[0],input.provider==='claude'?'.claude':'.codex') : '')
    if (!requested || !isAbsolute(requested)) return null
    const root=realpathSync(requested), stat=statSync(root)
    if (!stat.isDirectory() || await start() !== input.startedAt) return null
    const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const directoryDigest=hash({root,dev:stat.dev,ino:stat.ino})
    return {root,home:nativeHomes[0]?realpathSync(nativeHomes[0]):null,directoryDigest,digest:hash({pid:input.pid,startedAt:input.startedAt,directoryDigest})}
  } catch {return null}
}
function qualified(value: unknown, agentId: string, now: number, maxAge: number): value is SeatProviderObservation {
  if (!value || typeof value !== 'object') return false
  const o = value as SeatProviderObservation
  const time = Date.parse(o.observed_at)
  return o.schema_version === 'seat-provider-observation/v1' && o.source === 'process_ancestry' && o.verified === true
    && o.agent_id === agentId && !!o.runtime_instance_id && !!o.host_id && !!o.session_name && !!o.workspace
    && Number.isSafeInteger(o.process_id) && o.process_id > 1 && Number.isSafeInteger(o.provider_pid) && o.provider_pid > 1
    && typeof o.provider_started_at === 'string' && o.provider_started_at.length > 0
    && normalizeSeatProvider(o.provider) === o.provider && Number.isFinite(time) && time <= now && now - time <= maxAge
}
export function selectSeatProvider(input: {
  agentId: string; live?: unknown[]; history?: unknown[]; intent?: string | null; allowHistory?: boolean
  now?: Date; maxLiveAgeMs?: number; maxHistoryAgeMs?: number
}): SeatProviderSelection {
  const now = (input.now ?? new Date()).getTime()
  const result = (code: SeatProviderSelection['code'], provider: SeatProvider | null = null, observation: SeatProviderObservation | null = null): SeatProviderSelection => ({ ok: provider !== null, code, provider, observation })
  const live = (input.live ?? []).filter(o => qualified(o, input.agentId, now, input.maxLiveAgeMs ?? 1_800_000)) as SeatProviderObservation[]
  const owners = new Set(live.map(o => `${o.host_id}:${o.provider_pid}:${o.runtime_instance_id}`))
  if (owners.size > 1 || new Set(live.map(o => o.provider)).size > 1) return result('PROVIDER_AMBIGUOUS')
  const current = selectObservedProvider(live.length ? [live[0].provider] : [], input.intent)
  if (current.ok) return {...current,observation:live[0] ?? null}
  if (current.code !== 'PROVIDER_MISSING') return current
  // D3: historical DB observations never choose the current provider.
  return result('PROVIDER_MISSING')
}
type SelectionDb = { query: (sql: string, params?: any[]) => Promise<any> }
export async function resolveSeatProvider(db: SelectionDb, input: {
  agentId: string; intent?: string | null; allowHistory?: boolean; now?: Date; hostId?: string
  observe?: typeof observeSeatProvider; inspect?: HostRuntimeInspector
}): Promise<SeatProviderSelection> {
  const unavailable = (): SeatProviderSelection => ({ok:false,provider:null,observation:null,code:'PROVIDER_MISSING'})
  // DB contributes logical identity/authority only. A DB failure never becomes a cold launch.
  let anchors: any[]
  try {
    const read=await db.query(`SELECT r.runtime_instance_id, r.agent_id, r.runtime_kind,
      l.holder_agent_id, l.holder_runtime_instance_id, l.fencing_token,
      CASE WHEN l.status = 'active' AND l.expires_at > CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS authority_live
      FROM agent_runtime_instances r LEFT JOIN control_plane_leases l
      ON l.lease_scope_type = 'runtime_instance' AND l.lease_scope_id = CAST(r.runtime_instance_id AS TEXT)
        AND l.lease_purpose = 'worker' AND l.status = 'active'
      WHERE r.agent_id = $1 AND r.runtime_kind = 'local_process'`, [input.agentId])
    anchors=Array.isArray(read)?read:read.rows
  } catch {return unavailable()}
  const observed=(input.inspect ?? inspectHostRuntime)({agentId:input.agentId,expectedHost:input.hostId})
  if(!['OBSERVED','NO_LIVE_RUNTIME'].includes(observed.reasonCode)) return unavailable()
  const live:SeatProviderObservation[]=[]
  for(const observation of observed.observations) {
    const matches=anchors.filter(row=>String(row.runtime_instance_id)===observation.runtime_instance_id
      && row.agent_id===input.agentId && row.holder_agent_id===input.agentId
      && String(row.holder_runtime_instance_id)===observation.runtime_instance_id
      && Number(row.authority_live)===1 && Number(row.fencing_token)>0)
    if(matches.length!==1) return unavailable()
    live.push(observation)
  }
  return selectSeatProvider({...input,live,history:[],allowHistory:false,now:input.now ?? new Date()})
}

/** Verify the target host's connected memory child, not a repaired private lookup child. */
export function observeSeatMemoryBinding(input:{agentId:string;project:string;providerPid:number;providerStartedAt:string;
  transportArgs:string[];processes?:ProcessSnapshot[];readEnvironment?:(pid:number)=>string}): boolean {
  try {
    const snapshots=input.processes ?? parseProcessList(execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:3000}))
    const byPid=new Map(snapshots.map(row=>[row.pid,row]))
    if(!input.processes) {
      const start=processStartIso(execFileSync('ps',['-p',String(input.providerPid),'-o','lstart='],{encoding:'utf8',timeout:3000,env:{...process.env,TZ:'UTC',LC_ALL:'C'}}))
      if(start!==input.providerStartedAt) return false
    }
    const script=input.transportArgs.find(arg=>arg.includes('/') && /\.[cm]?[jt]s$/.test(arg))
    if(!script) return false
    let found=0
    for(const row of snapshots) {
      if(!row.command.includes(script)) continue
      let parent=row.ppid, owned=false
      const seen=new Set<number>()
      for(let depth=0;parent>1&&depth<32&&!seen.has(parent);depth++) {
        if(parent===input.providerPid) {owned=true;break}
        seen.add(parent);parent=byPid.get(parent)?.ppid ?? 0
      }
      if(!owned) continue
      const env=input.readEnvironment?.(row.pid) ?? execFileSync('ps',['eww','-p',String(row.pid),'-o','command='],{encoding:'utf8',timeout:3000})
      if(env.match(/(?:^|\s)AGENT_MEMORY_AGENT_ID=(\S+)/)?.[1]!==input.agentId
        || env.match(/(?:^|\s)AGENT_MEMORY_PROJECT=(\S+)/)?.[1]!==input.project) return false
      found++
    }
    return found>0
  } catch {return false}
}
