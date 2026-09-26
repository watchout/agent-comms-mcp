import { mkdtempSync,realpathSync,writeFileSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Plain Bun host: no provider executable, account, memory service or credentials. */
export async function nativeProcessFixture(agentId=`s0-${randomUUID()}`,runtimeId=randomUUID()) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-s0-')))
  const script=join(dir,'server.ts')
  writeFileSync(script,"const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('native-fixture')});console.log(JSON.stringify({pid:process.pid,port:s.port}));")
  const child=Bun.spawn([process.execPath,'--no-env-file',script],{cwd:dir,
    env:{PATH:process.env.PATH!,LANG:'C',HOME:dir,TMPDIR:dir,AGENT_ID:agentId,AGENT_COM_EXPECTED_AGENT_ID:agentId,
      AGENT_COM_RUNTIME_INSTANCE_ID:runtimeId,AGENT_COM_WORKSPACE:dir,AGENT_COM_RUNTIME_SESSION:'native-fixture'},stdout:'pipe',stderr:'pipe'})
  const reader=child.stdout.getReader()
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const chunk=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('NATIVE_FIXTURE_START_TIMEOUT')),5000)})])
    if(!chunk.value)throw new Error('NATIVE_FIXTURE_START_FAILED')
    const endpoint=JSON.parse(new TextDecoder().decode(chunk.value))
    return {dir,agentId,runtimeId,endpoint,child,async close(){if(child.exitCode===null)child.kill();await child.exited;rmSync(dir,{recursive:true,force:true})}}
  }catch(error){if(child.exitCode===null)child.kill();await child.exited;rmSync(dir,{recursive:true,force:true});throw error}
  finally {clearTimeout(timer);reader.releaseLock()}
}
