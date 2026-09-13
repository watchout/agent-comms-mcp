import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  evaluateRuntimeMemoryReadyGate,
  recordVerifiedNativeRuntimeMemoryReady,
} from '../../core/runtime-memory-ready'
import { resolveRuntimeMemoryReadyCurrent } from '../../core/runtime-current-resolver'
import { resolveRuntimeEndpoint } from '../../core/runtime-endpoint'
import { observeSeatProvider, readObservedProviderRoot, observeSeatMemoryBinding } from '../../core/seat-runtime-selection'
import { readNativeSeatContextReceipt } from '../../core/seat-context-recovery'
import { readConfiguredWasurezuTransport } from './bootstrap'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'

export interface MemoryReadyBootstrapOptions {
  agentId?: string
  project?: string
  runtimeInstanceId?: string
  sessionName?: string
  port?: string
  profileRevision?: string
  profileSource?: string
  checkoutPath?: string
  checkoutCommitSha?: string
  evidencePath?: string
  evidenceLogId?: string
  recoveryCommand?: string
  validForSeconds?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
}

export interface MemoryReadyBootstrapResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function resolveAgentId(opts: MemoryReadyBootstrapOptions, env: NodeJS.ProcessEnv): string {
  const agentId = opts.agentId?.trim() || env.AGENT_ID?.trim()
  if (!agentId) throw new Error('agent id required: pass --agent-id <id> or set AGENT_ID')
  const expected = env.AGENT_COM_EXPECTED_AGENT_ID?.trim()
  if (expected && expected !== agentId) {
    throw new Error(`AGENT_ID_MISMATCH: resolved agent_id=${agentId}, expected ${expected}`)
  }
  return agentId
}

function numberFlag(raw: string | undefined, name: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`)
  return n
}


function dbKind(env: Record<string, string>): 'postgres' | 'sqlite' {
  const explicit = env.AGENT_COM_DB?.trim()
  if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres'
  if (explicit === 'sqlite') return 'sqlite'
  return env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite'
}

async function withDb<T>(env: Record<string, string>, fn: (db: DbAdapter) => Promise<T>): Promise<T> {
  if (dbKind(env) === 'sqlite') {
    const db = new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
    try {
      return await fn(db)
    } finally {
      await db.close()
    }
  }

  const { PgAdapter } = await import('../../core/db/pg-adapter')
  const db = new PgAdapter(env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp')
  try {
    return await fn(db)
  } finally {
    await db.close().catch(() => {})
  }
}

function runReadOnly(command: string, args: string[], options: {cwd: string;env: Record<string,string>;timeoutMs?: number}): Promise<{exitCode:number;stdout:string;stderr:string}> {
  return new Promise(resolveResult => execFile(command,args,{cwd:options.cwd,env:options.env,timeout:options.timeoutMs ?? 10_000},
    (error,stdout,stderr)=>resolveResult({exitCode:error?1:0,stdout,stderr})))
}

function projectValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value !== 'string' || !value.trim() || /[:\r\n\0]/.test(value)) throw new Error('MEMORY_PROJECT_INVALID')
  return value.trim()
}

export async function memoryReadyBootstrap(opts: MemoryReadyBootstrapOptions = {}): Promise<MemoryReadyBootstrapResult> {
  const env = cleanEnv(opts.env ?? process.env)
  let recorded = false
  try {
    const agentId = resolveAgentId(opts, env)
    const result = await withDb(env, async db => {
      const now = new Date()
      const current = await resolveRuntimeMemoryReadyCurrent(db,{agentId,requestedRuntimeKind:'local_process',now})
      const runtime = current.current_runtime
      if (!current.ok || !runtime || !runtime.checkout_path || !runtime.session_name) throw new Error('MEMORY_CURRENT_RUNTIME_UNAVAILABLE')
      const endpoint = await resolveRuntimeEndpoint(db,{agentId,runtimeInstanceId:runtime.runtime_instance_id,now})
      if (!endpoint.ok || !endpoint.endpoint) throw new Error('MEMORY_CURRENT_ENDPOINT_UNAVAILABLE')
      const actual = endpoint.endpoint
      for (const [name,expected,value] of [
        ['runtime_instance',opts.runtimeInstanceId,runtime.runtime_instance_id],
        ['session',opts.sessionName,runtime.session_name],
        ['port',opts.port,actual.port],
        ['checkout_commit',opts.checkoutCommitSha,runtime.commit_sha],
        ['profile_revision',opts.profileRevision,current.profile?.profile_revision],
        ['profile_source',opts.profileSource,current.profile?.profile_source],
      ]) if (expected !== undefined && String(expected) !== String(value)) throw new Error(`MEMORY_EXPECTATION_MISMATCH:${name}`)
      if (opts.checkoutPath && resolve(opts.checkoutPath) !== resolve(runtime.checkout_path)) throw new Error('MEMORY_EXPECTATION_MISMATCH:workspace')
      const row = await db.queryOne<any>('SELECT metadata FROM agents WHERE agent_id=$1',[agentId])
      const metadata = typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata
      const stableProject = projectValue(metadata?.memory_project)
      const expectedProject = projectValue(opts.project) || (env.AGENT_MEMORY_AGENT_ID === agentId ? projectValue(env.AGENT_MEMORY_PROJECT) : undefined)
      if (expectedProject && stableProject && expectedProject !== stableProject) throw new Error('MEMORY_EXPECTATION_MISMATCH:project')
      let project = stableProject || expectedProject
      const plan = {agent_id:agentId,project:project ?? null,runtime_instance_id:runtime.runtime_instance_id,
        session_name:runtime.session_name,port:actual.port,workspace:runtime.checkout_path}
      if (opts.dryRun) return {ok:true,dry_run:true,plan,native_receipt_checked:false,readiness_recorded:false}

      const observed = observeSeatProvider({agentId,runtimeInstanceId:runtime.runtime_instance_id,processId:actual.processId,
        hostId:actual.hostId,sessionName:runtime.session_name,workspace:runtime.checkout_path,now})
      if (!observed) throw new Error('MEMORY_CURRENT_PROVIDER_UNAVAILABLE')
      const rootInput={pid:observed.provider_pid,startedAt:observed.provider_started_at,provider:observed.provider,cwd:runtime.checkout_path,env}
      const root = await readObservedProviderRoot(runReadOnly,rootInput)
      if (!root) throw new Error('MEMORY_CURRENT_ACCOUNT_ROOT_UNAVAILABLE')
      if (root.home) env.HOME=root.home
      env[observed.provider==='codex'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']=root.root
      const transport = await readConfiguredWasurezuTransport({resolvedRuntime:observed.provider,workspaceRoot:runtime.checkout_path,env},runReadOnly)
      if (!transport) throw new Error('MEMORY_NATIVE_TRANSPORT_UNAVAILABLE')
      const rootAgain=await readObservedProviderRoot(runReadOnly,rootInput)
      if (!rootAgain || rootAgain.digest!==root.digest) throw new Error('MEMORY_CURRENT_ACCOUNT_ROOT_CHANGED')
      if (!project && transport.env.AGENT_MEMORY_AGENT_ID===agentId) project=projectValue(transport.env.AGENT_MEMORY_PROJECT)
      if (!project) throw new Error('MEMORY_PROJECT_REQUIRED')
      const binding={agentId,project,providerPid:observed.provider_pid,providerStartedAt:observed.provider_started_at,transportArgs:transport.args}
      if (!observeSeatMemoryBinding(binding)) throw new Error('MEMORY_ACTUAL_HOST_BINDING_MISMATCH')
      const receipt=await readNativeSeatContextReceipt({agentId,project,runtimeInstanceId:runtime.runtime_instance_id,
        targetRuntime:observed.provider,providerPid:observed.provider_pid,providerStartedAt:observed.provider_started_at,
        hostSessionId:observed.host_session_id ?? undefined,transport,cwd:runtime.checkout_path,env})
      if (!observeSeatMemoryBinding(binding)) throw new Error('MEMORY_ACTUAL_HOST_BINDING_MISMATCH')
      const validForSeconds=opts.validForSeconds===undefined?1800:numberFlag(opts.validForSeconds,'--valid-for-seconds')
      const evidence=await db.transaction(tx=>recordVerifiedNativeRuntimeMemoryReady(tx,{agentId,project:project!,runtimeInstanceId:runtime.runtime_instance_id,receipt,validForSeconds}))
      recorded=true
      const gate=await evaluateRuntimeMemoryReadyGate(db,{agent_id:agentId,project,requested_runtime_kind:'local_process'})
      return {ok:gate.ok,dry_run:false,plan:{...plan,project},native_receipt_checked:true,readiness_recorded:true,
        evidence_id:evidence.evidence_id,evidence_log_id:evidence.evidence_log_id,memory_ready:gate}
    })
    return {ok:result.ok,code:result.ok?0:1,stdout:`${JSON.stringify({...result,mode:'memory-ready-bootstrap',mutation_performed:recorded,
      live_discord_send:false,launchagent_mutation:false,queue_dependency:false},null,2)}\n`,stderr:''}
  } catch (error) {
    const reason=(error as Error).message
    return {ok:false,code:1,stdout:`${JSON.stringify({ok:false,mode:'memory-ready-bootstrap',mutation_performed:recorded,reason})}\n`,
      stderr:`Error [MEMORY_READY_BOOTSTRAP_FAILED]: ${reason}\n`}
  }
}
