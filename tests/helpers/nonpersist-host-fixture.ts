import { copyFileSync, mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectHostRuntime, sameHostRuntime } from '../../core/host-runtime-observer'
import { processStartUpperBoundMs } from '../../core/process-start-time'

/** Manual logical leases must be granted after the observed holder's interval.
 * This is deliberately separate from spawning: replacement/replay negatives
 * must exercise the immediate new process, without an artificial delay.
 */
export async function awaitFixtureAuthorityWindow(host:{agentId:string;runtimeId:string;endpoint:{pid:number}},readDatabaseClock:()=>Promise<unknown>) {
  const inspect=()=>inspectHostRuntime({agentId:host.agentId,runtimeInstanceId:host.runtimeId})
  const before=inspect()
  if(before.reasonCode!=='OBSERVED'||before.observations.length!==1||before.observations[0].process_id!==host.endpoint.pid)throw Error('FIXTURE_HOLDER_UNVERIFIED')
  const holder=before.observations[0],upper=processStartUpperBoundMs(holder.process_started_at)
  const clock=async()=>{const value=await readDatabaseClock();return value instanceof Date?value.getTime():Date.parse(String(value))}
  const first=await clock(),waitMs=Math.max(0,upper-first)
  if(!Number.isFinite(waitMs)||waitMs>1000)throw Error('FIXTURE_CLOCK_UNPROVEN')
  if(waitMs)await Bun.sleep(waitMs)
  const final=await clock(),after=inspect()
  if(final<upper||!Number.isFinite(final)||after.observations.length!==1||!sameHostRuntime(holder,after.observations[0]))throw Error('FIXTURE_AUTHORITY_WINDOW_UNPROVEN')
  console.log(JSON.stringify({case:'manual-fixture-authority-window',agent:host.agentId,pid:host.endpoint.pid,started_at:holder.process_started_at,upper_ms:upper,first_db_ms:first,final_db_ms:final,wait_ms:waitMs}))
}
/** Synthetic Bun executable named codex. Never launches a provider or reads an account. */
export async function nonpersistHostFixture(runtimeId = randomUUID(), agentId = `np-${randomUUID()}`, session = `session-${agentId}`) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-host-')))
  copyFileSync(process.execPath,join(dir,'codex'))
  writeFileSync(join(dir,'server.ts'),"const s=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('synthetic')});console.log(JSON.stringify({pid:process.pid,port:s.port}));")
  writeFileSync(join(dir,'provider.ts'),`const child=Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(join(dir,'server.ts'))}],{cwd:process.cwd(),env:process.env,stdout:'inherit',stderr:'inherit'});process.on('SIGTERM',()=>{child.kill();process.exit(0)});await child.exited;`)
  mkdirSync(join(dir,'.codex'))
  const env={HOME:dir,CODEX_HOME:join(dir,'.codex'),PATH:process.env.PATH!,LANG:'C',TMPDIR:dir,AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,
    AGENT_COM_RUNTIME_INSTANCE_ID:runtimeId,AGENT_COM_WORKSPACE:dir,AGENT_COM_RUNTIME_SESSION:session}
  const child=Bun.spawn([join(dir,'codex'),join(dir,'provider.ts')],{cwd:dir,env,stdout:'pipe',stderr:'pipe'})
  const reader=child.stdout.getReader()
  const first=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('FIXTURE_START_TIMEOUT')),5000))])
  if(!first.value) throw new Error('FIXTURE_START_FAILED')
  const endpoint=JSON.parse(new TextDecoder().decode(first.value)); reader.releaseLock()
  return {dir,env,child,agentId,runtimeId,endpoint,async close(){child.kill();await child.exited;rmSync(dir,{recursive:true,force:true})}}
}

/** Real OS holder and logical authority for isolated SQLite CLI contract tests. */
export async function observedSqliteRuntimeFixture(dbPath:string,agentId:string,session?:string) {
  const {SqliteAdapter}=await import('../../core/db/sqlite-adapter')
  const {heartbeatRuntimeInstance}=await import('../../core/runtime-heartbeat')
  const host=await nonpersistHostFixture(randomUUID(),agentId,session), adapter=new SqliteAdapter(dbPath)
  try {
    const db={dialect:'sqlite' as const,async query(sql:string,params?:unknown[]){const rows=await adapter.query(sql,params);return {rows,rowCount:rows.length}}}
    await heartbeatRuntimeInstance(db,{agentId,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
      port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir})
    return host
  }catch(error){await host.close();throw error}
  finally{await adapter.close()}
}
