import { copyFileSync, mkdtempSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
/** Synthetic Bun executable named codex. Never launches a provider or reads an account. */
export async function nonpersistHostFixture(runtimeId = randomUUID(), agentId = `np-${randomUUID()}`) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-host-')))
  copyFileSync(process.execPath,join(dir,'codex'))
  writeFileSync(join(dir,'server.ts'),"const s=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('synthetic')});console.log(JSON.stringify({pid:process.pid,port:s.port}));")
  writeFileSync(join(dir,'provider.ts'),`const child=Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(join(dir,'server.ts'))}],{cwd:process.cwd(),env:process.env,stdout:'inherit',stderr:'inherit'});process.on('SIGTERM',()=>{child.kill();process.exit(0)});await child.exited;`)
  mkdirSync(join(dir,'.codex'))
  const env={HOME:dir,CODEX_HOME:join(dir,'.codex'),PATH:process.env.PATH!,LANG:'C',TMPDIR:dir,AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,
    AGENT_COM_RUNTIME_INSTANCE_ID:runtimeId,AGENT_COM_WORKSPACE:dir,AGENT_COM_RUNTIME_SESSION:`session-${agentId}`}
  const child=Bun.spawn([join(dir,'codex'),join(dir,'provider.ts')],{cwd:dir,env,stdout:'pipe',stderr:'pipe'})
  const reader=child.stdout.getReader()
  const first=await Promise.race([reader.read(),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('FIXTURE_START_TIMEOUT')),5000))])
  if(!first.value) throw new Error('FIXTURE_START_FAILED')
  const endpoint=JSON.parse(new TextDecoder().decode(first.value)); reader.releaseLock()
  return {dir,env,child,agentId,runtimeId,endpoint,async close(){child.kill();await child.exited;rmSync(dir,{recursive:true,force:true})}}
}
