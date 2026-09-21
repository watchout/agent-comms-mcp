import { execFileSync } from 'node:child_process'
import { readObservedProviderRoot, observeSeatMemoryBinding } from './seat-runtime-selection'
import { readNativeSeatContextReceipt, type SeatContextReceipt } from './seat-context-recovery'
import type { HostRuntimeObservation } from './host-runtime-observer'
/** Read the original native proof through the already configured same-host
 * memory transport. A stored AUN ready row cannot replace this observation. */
export async function readCurrentNativeProof(input:{agentId:string;project:string;runtimeInstanceId:string;
  observation:HostRuntimeObservation}):Promise<SeatContextReceipt> {
  const o=input.observation
  const run=async(command:string,args:string[],options:any)=>{
    try {return {exitCode:0,stderr:'',stdout:execFileSync(command,args,{encoding:'utf8',cwd:options.cwd,
      env:options.env,timeout:Math.min(options.timeoutMs ?? 3000,10000),stdio:['ignore','pipe','ignore']})}}
    catch {return {exitCode:1,stdout:'',stderr:''}}
  }
  const minimal:Record<string,string>={PATH:process.env.PATH ?? '/usr/bin:/bin',LANG:'C'}
  const root=await readObservedProviderRoot(run,{pid:o.provider_pid,startedAt:o.provider_started_at,
    cwd:o.workspace,env:minimal,provider:o.provider})
  if(!root) throw new Error('MEMORY_NATIVE_ROOT_UNVERIFIED')
  const env={...minimal,[o.provider==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']:root.root,
    ...(root.home?{HOME:root.home}:{}),AGENT_MEMORY_AGENT_ID:input.agentId,AGENT_MEMORY_PROJECT:input.project}
  const {readConfiguredWasurezuTransport}=await import('../bin/aun/bootstrap')
  const transport=await readConfiguredWasurezuTransport({resolvedRuntime:o.provider,workspaceRoot:o.workspace,env},run)
  if(!transport || !observeSeatMemoryBinding({agentId:input.agentId,project:input.project,providerPid:o.provider_pid,
    providerStartedAt:o.provider_started_at,transportArgs:transport.args})) throw new Error('MEMORY_ACTUAL_HOST_BINDING_MISMATCH')
  return readNativeSeatContextReceipt({agentId:input.agentId,project:input.project,runtimeInstanceId:input.runtimeInstanceId,
    targetRuntime:o.provider,providerPid:o.provider_pid,providerStartedAt:o.provider_started_at,
    hostSessionId:o.host_session_id ?? undefined,cwd:o.workspace,transport,env,timeoutMs:10000})
}
