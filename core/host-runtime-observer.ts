import { readDarwinProcessStart } from './process-start-time'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { performance } from 'node:perf_hooks'
import { parseProcessList, type ProcessSnapshot } from './tmux-runtime-inspector'
import { providerExecutable, type SeatProviderObservation } from './seat-runtime-selection'

/** Request-local OS observation. No registry, persisted snapshot or cross-call cache. */
export type HostRuntimeObservation = SeatProviderObservation & {
  process_started_at: string
  port: number
  endpoint_uri: string
}
export type HostRuntimeInspection = { observations: HostRuntimeObservation[]; reasonCode: string }
type HostRuntimeInspectionInput = {
  agentId: string; runtimeInstanceId?: string; logicalWorkspace?: string; expectedHost?: string; deadline?: number
}
export type HostRuntimeInspector = (input: HostRuntimeInspectionInput) => HostRuntimeInspection
export type NativeHostRuntimeObservation = Omit<HostRuntimeObservation,
  'schema_version'|'source'|'provider'|'provider_pid'|'provider_started_at'|'host_session_id'> & {
  schema_version:'seat-native-runtime-observation/v1'; source:'process_socket'
}
export type NativeHostRuntimeInspection = {observations:NativeHostRuntimeObservation[];reasonCode:string}
export type NativeHostRuntimeInspector = (input:HostRuntimeInspectionInput)=>NativeHostRuntimeInspection
export type HostRuntimeIo = {
  run(command: string, args: string[], timeoutMs: number): string
  canonical(path: string): string
  monotonic(): number
  wall(): number
  host(): string
  processStart?: (pid:number)=>string
}
const io: HostRuntimeIo = {
  run: (command, args, timeout) => execFileSync(command, args, {encoding:'utf8', timeout, maxBuffer:16*1024*1024,
    stdio:['ignore','pipe','ignore'], env:{PATH:process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',TZ:'UTC',LC_ALL:'C'}}),
  processStart: process.platform==='darwin'?readDarwinProcessStart:undefined,
  canonical: realpathSync, monotonic: () => performance.now(), wall: Date.now, host: hostname,
}
function field(command: string, key: string): string | null {
  const values = [...command.trim().matchAll(new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`, 'g'))].map(m=>m[1].trim())
  return values.length === 1 && values[0] ? values[0] : null
}
function start(value: string): string {
  const text=value.trim(); return new Date(/^\d{4}-\d\d-\d\dT/.test(text)?text:`${text} UTC`).toISOString()
}
/** Distinguish the server's optional MCP transport from its runtime bridge.
 * All listeners come from the same OS-owned process; configuration is read fresh.
 */
function runtimeListenerPorts(listeners: string[], env: string): number[] | null {
  const configured = field(env, 'AGENT_COMMS_PORT')
  const multiBot = configured !== null || field(env, 'EXPECTED_BOTS') !== null
  const auxiliary = multiBot ? Number(configured ?? '8800') : null
  if (multiBot && (!/^\d+$/.test(configured ?? '8800') || !Number.isSafeInteger(auxiliary) || auxiliary! < 1 || auxiliary! > 65535)) return null
  const runtimeListeners = listeners.filter(value => {
    const match = /^(?:127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]):(\d+)$/.exec(value)
    return auxiliary === null || !match || Number(match[1]) !== auxiliary
  })
  if (runtimeListeners.some(value => !/^127\.0\.0\.1:\d+$/.test(value))) return null
  const ports = [...new Set(runtimeListeners.map(value => Number(value.slice(value.lastIndexOf(':') + 1))))]
  return ports.length === 1 && ports[0] > 0 && ports[0] <= 65535 ? ports : null
}
/** A single absolute monotonic deadline covers enumeration and every candidate. */
function hostRuntimeObserver(adapter: HostRuntimeIo, native:boolean) {
  return (input:HostRuntimeInspectionInput) => {
    const began=adapter.monotonic(), wall=adapter.wall(), deadline=Math.min(input.deadline ?? began+3000,began+3000)
    const run=(command:string,args:string[])=>{
      const left=Math.floor(deadline-adapter.monotonic())
      if(left<1 || adapter.wall()<wall) throw new Error('HOST_OBSERVATION_DEADLINE')
      return adapter.run(command,args,left)
    }
    const fail=(reasonCode:string)=>({observations:[],reasonCode})
    if (input.expectedHost && input.expectedHost!==adapter.host()) return fail('HOST_MISMATCH')
    try {
      // Only PID/ancestry/command are enumerated. Environments are read only for
      // candidate MCP processes and never returned, logged or written to a DB.
      const processes=parseProcessList(run('ps',['-axo','pid=,ppid=,command=']))
      const byPid=new Map(processes.map(p=>[p.pid,p]))
      const observations:Array<HostRuntimeObservation|NativeHostRuntimeObservation>=[]
      for(const candidate of processes) {
        if(!/(?:^|\s|\/)server\.[cm]?[jt]s(?:\s|$)/.test(candidate.command)) continue
        let env:string
        try { env=run('ps',['eww','-p',String(candidate.pid),'-o','command=']) }
        catch(error) {
          // Enumeration is not atomic. An unrelated server can exit before we
          // read its seat identity. Confirm absence; an unreadable live process
          // remains fail-closed, and all reads share the original deadline.
          const currentPids=run('ps',['-axo','pid=']).split(/\s+/).filter(Boolean).map(Number)
          if(!currentPids.length || currentPids.some(pid=>!Number.isSafeInteger(pid)||pid<1))throw error
          if(!currentPids.includes(candidate.pid))continue
          throw error
        }
        if(field(env,'AGENT_ID')!==input.agentId) continue
        const uuid=field(env,'AGENT_COM_RUNTIME_INSTANCE_ID')
        if(!uuid || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) return fail('RUNTIME_UUID_UNBOUND')
        if(input.runtimeInstanceId && uuid!==input.runtimeInstanceId) continue
        if(field(env,'AGENT_COM_EXPECTED_AGENT_ID')!==input.agentId) return fail('SEAT_IDENTITY_MISMATCH')
        const declared=field(env,'AGENT_COM_WORKSPACE'), session=field(env,'AGENT_COM_RUNTIME_SESSION')
        if(!declared || !session) return fail('RUNTIME_IDENTITY_INCOMPLETE')
        const processStart=()=>adapter.processStart?.(candidate.pid) ?? start(run('ps',['-p',String(candidate.pid),'-o','lstart=']))
        const before=processStart()
        const cwd=run('lsof',['-a','-p',String(candidate.pid),'-d','cwd','-Fn']).split('\n').find(l=>l.startsWith('n'))?.slice(1)
        if(!cwd || adapter.canonical(cwd)!==adapter.canonical(declared)
          || (input.logicalWorkspace && adapter.canonical(cwd)!==adapter.canonical(input.logicalWorkspace))) return fail('WORKSPACE_MISMATCH')
        if(native) {
          // D-S0-1: logical native-kind authority is checked by the caller. OS
          // inspection proves only this seat's process/start/socket, without
          // deriving a provider or requiring an LLM parent.
          const listeners=run('lsof',['-nP','-a','-p',String(candidate.pid),'-iTCP','-sTCP:LISTEN','-Fn'])
            .split('\n').filter(l=>l.startsWith('n')).map(l=>l.slice(1))
          const ports=runtimeListenerPorts(listeners,env)
          if(!ports) return fail('SOCKET_OWNER_AMBIGUOUS')
          if(processStart()!==before || run('ps',['eww','-p',String(candidate.pid),'-o','command='])!==env) return fail('PROCESS_IDENTITY_CHANGED')
          const observed=adapter.wall()
          if(observed<wall || adapter.monotonic()>=deadline) return fail('HOST_OBSERVATION_DEADLINE')
          observations.push({schema_version:'seat-native-runtime-observation/v1',agent_id:input.agentId,runtime_instance_id:uuid,
            host_id:adapter.host(),process_id:candidate.pid,process_started_at:before,session_name:session,
            workspace:adapter.canonical(cwd),port:ports[0],endpoint_uri:`http://127.0.0.1:${ports[0]}`,
            observed_at:new Date(observed).toISOString(),source:'process_socket',verified:true})
          continue
        }
        let process:ProcessSnapshot|undefined=candidate, provider:null|SeatProviderObservation['provider']=null
        const seen=new Set<number>()
        for(let depth=0;process && depth<32 && !seen.has(process.pid);depth++) {
          seen.add(process.pid); provider=providerExecutable(process.command)
          if(provider) break
          process=byPid.get(process.ppid)
        }
        if(!provider || !process) return fail('PROVIDER_UNVERIFIED')
        const providerStart=start(run('ps',['-p',String(process.pid),'-o','lstart=']))
        const providerEnv=run('ps',['eww','-p',String(process.pid),'-o','command='])
        const listeners=run('lsof',['-nP','-a','-p',String(candidate.pid),'-iTCP','-sTCP:LISTEN','-Fn'])
          .split('\n').filter(l=>l.startsWith('n')).map(l=>l.slice(1))
        const ports=runtimeListenerPorts(listeners,env)
        if(!ports) return fail('SOCKET_OWNER_AMBIGUOUS')
        if(processStart()!==before
          || start(run('ps',['-p',String(process.pid),'-o','lstart=']))!==providerStart
          || run('ps',['eww','-p',String(candidate.pid),'-o','command='])!==env) return fail('PROCESS_IDENTITY_CHANGED')
        const observed=adapter.wall(); if(observed<wall || adapter.monotonic()>=deadline) return fail('HOST_OBSERVATION_DEADLINE')
        observations.push({schema_version:'seat-provider-observation/v1',agent_id:input.agentId,runtime_instance_id:uuid,
          host_id:adapter.host(),process_id:candidate.pid,process_started_at:before,provider_pid:process.pid,
          provider_started_at:providerStart,host_session_id:field(providerEnv,provider==='codex'?'CODEX_THREAD_ID':'CLAUDE_SESSION_ID'),
          provider,session_name:session,workspace:adapter.canonical(cwd),port:ports[0],endpoint_uri:`http://127.0.0.1:${ports[0]}`,
          observed_at:new Date(observed).toISOString(),source:'process_ancestry',verified:true})
      }
      if(adapter.monotonic()>=deadline || adapter.wall()<wall) return fail('HOST_OBSERVATION_DEADLINE')
      if(new Set(observations.map(o=>o.runtime_instance_id)).size!==observations.length) return fail('RUNTIME_UUID_AMBIGUOUS')
      return {observations,reasonCode:observations.length?'OBSERVED':'NO_LIVE_RUNTIME'}
    } catch {return fail('HOST_OBSERVATION_UNAVAILABLE')}
  }
}
export function createHostRuntimeObserver(adapter:HostRuntimeIo=io):HostRuntimeInspector {
  return hostRuntimeObserver(adapter,false) as HostRuntimeInspector
}
export function createNativeHostRuntimeObserver(adapter:HostRuntimeIo=io):NativeHostRuntimeInspector {
  return hostRuntimeObserver(adapter,true) as NativeHostRuntimeInspector
}
export const inspectHostRuntime = createHostRuntimeObserver()
export const inspectNativeHostRuntime = createNativeHostRuntimeObserver()

export function sameNativeHostRuntime(a:NativeHostRuntimeObservation,b:NativeHostRuntimeObservation):boolean {
  return ['agent_id','runtime_instance_id','host_id','process_id','process_started_at',
    'session_name','workspace','port','endpoint_uri'].every(key=>(a as any)[key]===(b as any)[key])
}

/** Identity equality excludes freshness timestamps; every physical field is freshly read. */
export function sameHostRuntime(a:HostRuntimeObservation,b:HostRuntimeObservation):boolean {
  return ['agent_id','runtime_instance_id','host_id','process_id','process_started_at','provider_pid',
    'provider_started_at','host_session_id','provider','session_name','workspace','port','endpoint_uri']
    .every(key=>(a as any)[key]===(b as any)[key])
}
