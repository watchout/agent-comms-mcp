import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { fixture, seed, insert } from '../helpers/runtime-observation-nonpersistence-db-fixture'

for(const kind of ['postgres','sqlite'] as const)test(`NP03 ${kind} ordinary enrollment and stable updates preserve legacy observations; projection uses logical membership`,async()=>{
  const f=await fixture(kind,false)
  try {
    await seed(f);await f.apply()
    const before=(await f.query("SELECT runtime,status,status_detail,home_directory,channel_port,metadata FROM agents WHERE agent_id='fixture-agent'"))[0]
    const url=new URL(process.env.AGENT_COM_TEST_DATABASE_URL!);url.pathname='/'+f.name
    const run=async(args:string[])=>{
      const child=Bun.spawn([process.execPath,'--no-env-file',join(import.meta.dir,'../../cli/index.ts'),...args],{
        cwd:process.env.AUN_NP_FIXTURE_ROOT!,env:{PATH:process.env.PATH!,LANG:'C',AGENT_ID:'isolated-operator',AGENT_COM_PG_NOTIFY:'false',
          AGENT_COM_DB:kind,DATABASE_URL:kind==='postgres'?url.href:'',
          AGENT_COM_SQLITE_PATH:join(process.env.AUN_NP_FIXTURE_ROOT!,f.name+'.sqlite')},stdout:'pipe',stderr:'pipe'})
      const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()])
      return {code,stdout,stderr}
    }
    const registered=await run(['agent','register','fresh-profile','--display-name','Fresh profile'])
    expect(registered.code,registered.stderr+registered.stdout).toBe(0)
    expect((await f.query("SELECT runtime,status,status_detail,home_directory,channel_port FROM agents WHERE agent_id='fresh-profile'"))[0])
      .toEqual({runtime:null,status:null,status_detail:null,home_directory:null,channel_port:null})
    const changed=await run(['agent','profile','set','fixture-agent','--display-name','Logical change','--enabled','false','--execute'])
    expect(changed.code,changed.stderr+changed.stdout).toBe(0)
    expect((await f.query("SELECT runtime,status,status_detail,home_directory,channel_port,metadata FROM agents WHERE agent_id='fixture-agent'"))[0]).toEqual(before)
    expect((await f.query("SELECT display_name,profile_enabled FROM agents WHERE agent_id='fixture-agent'"))[0].display_name).toBe('Logical change')
    const denied=await run(['agent','profile','set','fresh-profile','--home-directory','/untrusted/runtime','--execute'])
    expect(denied.code).not.toBe(0);expect(denied.stderr+denied.stdout).toContain('PROFILE_PHYSICAL_OBSERVATION_FORBIDDEN')
    const missing=await run(['agent','profile','project','fresh-profile','--execute'])
    expect(JSON.parse(missing.stdout).projections[0].blockers).toContainEqual({code:'logical_workspace_binding_unavailable'})
    await insert(f,'agent_workspaces',{workspace_id:'fresh-logical',org_id:'default',name:'Logical project',workspace_type:'logical'})
    await insert(f,'agent_workspace_bindings',{agent_id:'fresh-profile',workspace_id:'fresh-logical',binding_role:'primary',active:true})
    const projected=await run(['agent','profile','project','fresh-profile','--execute'])
    expect(projected.code,projected.stderr+projected.stdout).toBe(0)
    const result=JSON.parse(projected.stdout)
    expect(result.ok).toBe(true)
    expect(result.projections[0].actions.some((a:any)=>['agent_workspaces','agent_runtime_instances'].includes(a.table))).toBe(false)
    expect((await f.query("SELECT local_path FROM agent_workspaces WHERE workspace_id='fresh-logical'"))[0].local_path).toBeNull()
    const audit=await f.query("SELECT detail FROM audit_log WHERE event_type IN ('agent.register','agent.profile_set')")
    expect(audit.length).toBe(2)
    expect(JSON.stringify(audit)).not.toContain('/historical/workspace')
    expect(JSON.stringify(audit)).not.toContain('provider_observation')
  }finally{await f.close()}
},40000)
