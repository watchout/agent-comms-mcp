import { test, expect } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

test('NP04 managed pre-exec entry supplies a new UUID and exact identity on every actual child launch',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'aun-np-entry-'))),entry=join(dir,'entrypoints/runtime.ts')
 try {
  mkdirSync(join(dir,'entrypoints'))
  const source=join(import.meta.dir,'../../entrypoints/runtime.ts')
  copyFileSync(source,entry);expect(readFileSync(entry)).toEqual(readFileSync(source))
  writeFileSync(join(dir,'server.ts'),"console.log(JSON.stringify({uuid:process.env.AGENT_COM_RUNTIME_INSTANCE_ID,agent:process.env.AGENT_ID,expected:process.env.AGENT_COM_EXPECTED_AGENT_ID,workspace:process.env.AGENT_COM_WORKSPACE,session:process.env.AGENT_COM_RUNTIME_SESSION,pid:process.pid}));")
  const previous=randomUUID(),agent='np-entry-fixture'
  const run=async(extra:Record<string,string>={})=>{
    const child=Bun.spawn([process.execPath,'--no-env-file',entry],{cwd:dir,env:{PATH:process.env.PATH!,LANG:'C',AGENT_ID:agent,AGENT_COM_RUNTIME_INSTANCE_ID:previous,...extra},stdout:'pipe',stderr:'pipe'})
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
    return {stdout,stderr,code}
  }
  const one=await run(),two=await run()
  expect(one.code).toBe(0);expect(two.code).toBe(0)
  const a=JSON.parse(one.stdout),b=JSON.parse(two.stdout)
  expect(a.uuid).not.toBe(previous);expect(b.uuid).not.toBe(previous);expect(a.uuid).not.toBe(b.uuid)
  expect(a.pid).not.toBe(b.pid)
  for(const observed of [a,b]) {
    expect(observed.expected).toBe(agent);expect(observed.agent).toBe(agent);expect(observed.workspace).toBe(dir)
    expect(observed.session).toBe('runtime:'+observed.uuid)
  }
  const denied=await run({AGENT_COM_EXPECTED_AGENT_ID:'foreign-seat'})
  expect(denied.code).not.toBe(0);expect(denied.stdout).toBe('');expect(denied.stderr).toContain('RUNTIME_PRE_EXEC_SEAT_IDENTITY_REQUIRED')
 }finally{rmSync(dir,{recursive:true,force:true})}
},15000)
