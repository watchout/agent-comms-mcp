import {spawn,type ChildProcess,execFileSync} from 'node:child_process'
import {mkdtempSync,realpathSync,symlinkSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'

const servers:Array<{child:ChildProcess;home:string}>=[]
/** Actual server under a harmless provider-shaped process; never calls an LLM. */
export function spawnObservedServer(repo:string,env:NodeJS.ProcessEnv):ChildProcess {
  const home=realpathSync(mkdtempSync(join(tmpdir(),'http-mcp-host-')))
  const node=realpathSync(execFileSync('which',['node'],{encoding:'utf8'}).trim()),provider=join(home,'codex')
  symlinkSync(node,provider)
  const script=join(home,'host.mjs')
  writeFileSync(script,`import {spawn} from 'node:child_process';
    const server=spawn(${JSON.stringify(process.execPath)},['--no-env-file',${JSON.stringify(join(repo,'server.ts'))}],{cwd:${JSON.stringify(repo)},env:process.env,stdio:['pipe','inherit','inherit']});
    process.on('SIGTERM',()=>server.kill('SIGTERM'));process.on('SIGINT',()=>server.kill('SIGTERM'));
    server.on('exit',code=>process.exit(code??0));process.on('exit',()=>server.kill('SIGTERM'));
  `)
  const child=spawn(provider,[script],{cwd:repo,env:{...env,HOME:home,CODEX_HOME:home,
    AGENT_COM_RUNTIME_INSTANCE_ID:randomUUID(),AGENT_COM_WORKSPACE:repo,AGENT_COM_RUNTIME_SESSION:'http-fixture',CODEX_THREAD_ID:'http-fixture'},
    stdio:['ignore','ignore','pipe']})
  let diagnostic='';child.stderr?.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-2000)})
  child.on('exit',code=>{if(code && code!==0)process.stderr.write(`HTTP fixture startup exit=${code}\n${diagnostic}\n`)})
  servers.push({child,home});return child
}
export async function closeObservedServers(){
  while(servers.length){const {child,home}=servers.pop()!;if(child.exitCode===null){child.kill('SIGTERM');await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},5000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}rmSync(home,{recursive:true,force:true})}
}
