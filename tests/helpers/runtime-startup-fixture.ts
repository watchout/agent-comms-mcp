import { copyFileSync,mkdtempSync,realpathSync,mkdirSync,rmSync,writeFileSync,existsSync,readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type StartupReport={status:string;errors:string[];pid:number;port:number;workspace:string;runtimeInstanceId:string;
  publications:number;work:number;acquisitions:number;prepublishStatus:number;events:string[]}
/** Real child MCP + synthetic codex ancestor. Only product bind/acquire/publish runs;
 * no provider account, shared database, full server background worker or live effect. */
export async function runtimeStartupFixture(input:{agentId:string;runtimeId:string;databaseUrl:string}) {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-startup-')))
  copyFileSync(process.execPath,join(dir,'codex'));mkdirSync(join(dir,'.codex'))
  const resultPath=join(dir,'startup.json')
  writeFileSync(join(dir,'server.ts'),`await import(${JSON.stringify(join(import.meta.dir,'runtime-startup-child.ts'))})`)
  writeFileSync(join(dir,'provider.ts'),`const child=Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(join(dir,'server.ts'))}],{cwd:process.cwd(),env:process.env,stdout:'inherit',stderr:'inherit'});
let stopping=false;process.on('SIGTERM',async()=>{stopping=true;child.kill();await child.exited;process.exit(0)});
const code=await child.exited;if(!stopping)process.exit(code);`)
  const env={HOME:dir,CODEX_HOME:join(dir,'.codex'),PATH:process.env.PATH!,LANG:'C',TMPDIR:dir,
    AGENT_ID:input.agentId,AGENT_COM_EXPECTED_AGENT_ID:input.agentId,AGENT_COM_RUNTIME_INSTANCE_ID:input.runtimeId,
    AGENT_COM_WORKSPACE:dir,AGENT_COM_RUNTIME_SESSION:`session-${input.agentId}`,
    AGENT_COM_TEST_DATABASE_URL:input.databaseUrl,AUN_STARTUP_RESULT:resultPath}
  const child=Bun.spawn([join(dir,'codex'),join(dir,'provider.ts')],{cwd:dir,env,stdout:'pipe',stderr:'pipe'})
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text()
  let closed=false
  const close=async()=>{if(closed)return;closed=true;if(child.exitCode===null)child.kill();await child.exited;rmSync(dir,{recursive:true,force:true})}
  try {
    const deadline=Date.now()+15000
    while(!existsSync(resultPath)) {
      if(child.exitCode!==null)throw Error(`STARTUP_FIXTURE_EXIT_${child.exitCode}: ${await stderr}`)
      if(Date.now()>=deadline)throw Error('STARTUP_FIXTURE_TIMEOUT')
      await Bun.sleep(10)
    }
    const report:StartupReport=JSON.parse(readFileSync(resultPath,'utf8'))
    return {dir,child,report,stdout,stderr,close}
  }catch(error){await close();throw error}
}
