import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createHostRuntimeObserver, createNativeHostRuntimeObserver, inspectHostRuntime, type HostRuntimeObservation } from '../../core/host-runtime-observer'
import { durableMemoryMetadata, durableRuntimeMetadata } from '../../core/runtime-durable-data'
import { heartbeatRuntimeInstance } from '../../core/runtime-heartbeat'
import { bindRuntimeEndpoint, resolveRuntimeEndpoint } from '../../core/runtime-endpoint'
import { selectSeatProvider, resolveSeatProvider } from '../../core/seat-runtime-selection'
import { nonpersistHostFixture } from '../helpers/nonpersist-host-fixture'
const id='10000000-0000-4000-8000-000000000001'
function observation(overrides:Partial<HostRuntimeObservation>={}):HostRuntimeObservation {return {
  schema_version:'seat-provider-observation/v1',agent_id:'seat',runtime_instance_id:id,host_id:'fixture-host',
  process_id:200,process_started_at:'2026-09-21T00:00:00Z',provider_pid:100,provider_started_at:'2026-09-21T00:00:00Z',
  provider:'codex',session_name:'session',workspace:'/fixture',port:32100,endpoint_uri:'http://127.0.0.1:32100',
  observed_at:new Date().toISOString(),source:'process_ancestry',verified:true,...overrides}}
const inspect=()=>({reasonCode:'OBSERVED',observations:[observation()]})
function authority(overrides:Record<string,unknown>={}) {return {runtime_instance_id:id,agent_id:'seat',runtime_kind:'local_process',
  holder_agent_id:'seat',holder_runtime_instance_id:id,authority_live:1,lease_id:'lease',fencing_token:1,acquired_at:new Date().toISOString(),...overrides}}
describe('NP implementation: observation and durable boundaries',()=>{
  test('NP05: a tempting same-seat history never supplies cold intent',()=>{
    const history=[observation()]
    expect(selectSeatProvider({agentId:'seat',history,allowHistory:true}).code).toBe('PROVIDER_MISSING')
    expect(selectSeatProvider({agentId:'seat',history,allowHistory:true,intent:'claude'}).code).toBe('SELECTED_INTENT')
    expect(selectSeatProvider({agentId:'seat',live:history,intent:'claude'}).code).toBe('PROVIDER_AMBIGUOUS')
  })
  test('NP01/07: copied native/physical fields are excluded by positive serializers',()=>{
    const input={provider_observation:observation(),native_delivery:observation(),source_commit:'a'.repeat(40),port:32100,
      seat_context_receipt:{agent_id:'seat',project:'project',runtime_instance_id:id,pack_id:'restart_pack:seat:project:1',
        work_digest:'b'.repeat(64),invocation_digest:'c'.repeat(64),completed_at:'2026-09-21T00:00:00Z',native_delivery:observation(),
        target_runtime:'codex',response_digest:'d'.repeat(64),transport_binding_digest:'e'.repeat(64)}}
    const runtime=durableRuntimeMetadata(input), memory=durableMemoryMetadata(input)
    expect(runtime).toEqual({schema_version:'aun-runtime-nonpersistence/v1',source_commit:'a'.repeat(40)})
    expect(memory).toEqual({schema_version:'aun-runtime-nonpersistence/v1',seat_context_proof:{agent_id:'seat',project:'project',runtime_instance_id:id,
      pack_id:'restart_pack:seat:project:1',work_digest:'b'.repeat(64),invocation_digest:'c'.repeat(64),completed_at:'2026-09-21T00:00:00Z'}})
    expect(input.seat_context_receipt.native_delivery.port).toBe(32100)
  })
  test('NP01/07 permitted metadata keys reject paths, malformed digests and incomplete logical proof',()=>{
    const good={agent_id:'seat',project:'project',runtime_instance_id:id,pack_id:'restart_pack:seat:project:1',work_digest:'a'.repeat(64),invocation_digest:'b'.repeat(64),completed_at:'2026-09-21T00:00:00Z'}
    for(const key of ['work_digest','invocation_digest','runtime_instance_id','pack_id','completed_at']) {
      expect(()=>durableMemoryMetadata({seat_context_receipt:{...good,[key]:'/observed/process/path'}})).toThrow('MEMORY_LOGICAL_PROOF_INVALID')
    }
    expect(()=>durableRuntimeMetadata({source_commit:'/observed/process/path'})).toThrow('RUNTIME_LOGICAL_METADATA_INVALID')
    expect(()=>durableRuntimeMetadata({mcp_runtime_instance_id:'-'.repeat(36)})).toThrow('RUNTIME_LOGICAL_METADATA_INVALID')
  })
  test('NP04/08: endpoint requires current exact authority, ignores tempting DB physical fields',async()=>{
    const calls:string[]=[]
    const db={async query(sql:string){calls.push(sql);return [authority({port:9,endpoint_uri:'http://foreign',process_id:999})]}}
    const resolved=await resolveRuntimeEndpoint(db,{agentId:'seat',inspect})
    expect(resolved.endpoint?.port).toBe(32100)
    expect(calls.join(' ')).not.toContain('r.port')
    for(const changed of [{authority_live:0},{holder_agent_id:'other'},{holder_runtime_instance_id:'forged'},{fencing_token:0}]) {
      expect((await resolveRuntimeEndpoint({async query(){return [authority(changed)]}},{agentId:'seat',inspect})).ok).toBe(false)
    }
    expect((await resolveRuntimeEndpoint({async query(){throw new Error('DB down')}},{agentId:'seat',inspect})).code).toBe('RUNTIME_ENDPOINT_AUTHORITY_UNAVAILABLE')
    expect((await resolveRuntimeEndpoint(db,{agentId:'seat',inspect:()=>({observations:[],reasonCode:'HOST_OBSERVATION_UNAVAILABLE'})})).ok).toBe(false)
  })
  test('NP05/08: DB-down cannot become a cold launch; authoritative empty set plus no live process can use explicit intent',async()=>{
    const empty=()=>({observations:[],reasonCode:'NO_LIVE_RUNTIME'})
    expect((await resolveSeatProvider({async query(){throw new Error('down')}},{agentId:'seat',intent:'codex',inspect:empty})).ok).toBe(false)
    expect((await resolveSeatProvider({async query(){return []}},{agentId:'seat',intent:'codex',inspect:empty})).code).toBe('SELECTED_INTENT')
    expect((await resolveSeatProvider({async query(){return []}},{agentId:'seat',inspect})).ok).toBe(false)
  })
  test('NP01: actual heartbeat SQL and parameters contain only anchor and authority data',async()=>{
    const calls:Array<{sql:string;params:unknown[]}>=[]
    const db={async query(sql:string,params:unknown[]=[]){calls.push({sql,params})
      if(sql.includes('clock_timestamp() AS database_now')) return {rows:[{database_now:new Date().toISOString()}]}
      if(sql.includes('FROM agents'))return {rows:[{org_id:'default',metadata:{}}]}
      if(sql.includes('INSERT INTO agent_runtime_instances'))return {rows:[{runtime_instance_id:id,agent_id:'seat'}]}
      if(sql.includes('MAX(fencing_token)'))return {rows:[{max_token:0}]}
      if(sql.includes('INSERT INTO control_plane_leases'))return {rows:[{lease_id:'lease',expires_at:new Date(Date.now()+60000).toISOString()}]}
      return {rows:[]}}}
    const result=await heartbeatRuntimeInstance(db,{agentId:'seat',runtimeInstanceId:id,processId:200,port:32100,
      endpointUri:'http://127.0.0.1:32100',checkoutPath:'/fixture',metadata:{provider_observation:observation(),nested:{port:32100}}},{inspect})
    expect(result.endpoint_lease_id).toBe('lease')
    const writes=calls.filter(c=>/INSERT|UPDATE/.test(c.sql))
    expect(writes).toHaveLength(2)
    expect(JSON.stringify(writes.map(c=>c.params))).not.toContain('32100')
    expect(JSON.stringify(writes.map(c=>c.params))).not.toContain('/fixture')
    expect(JSON.stringify(writes.map(c=>c.params))).not.toContain('codex')
    expect(writes[0].sql).toContain('NULL,NULL,NULL')
  })
  test('NP04/06: genuine OS listener and a fresh independent reader use no DB snapshot',async()=>{
    const f=await nonpersistHostFixture()
    try {
      const first=inspectHostRuntime({agentId:f.agentId,runtimeInstanceId:f.runtimeId,logicalWorkspace:f.dir})
      expect(first.reasonCode).toBe('OBSERVED')
      expect(first.observations).toHaveLength(1)
      expect(first.observations[0].process_id).toBe(f.endpoint.pid)
      expect(first.observations[0].port).toBe(f.endpoint.port)
      const module=join(import.meta.dir,'../../core/host-runtime-observer.ts')
      const child=Bun.spawn([process.execPath,'-e',`import {inspectHostRuntime} from ${JSON.stringify(module)}; console.log(JSON.stringify(inspectHostRuntime({agentId:${JSON.stringify(f.agentId)}})))`],
        {env:{PATH:process.env.PATH!,LANG:'C',TMPDIR:f.dir},stdout:'pipe',stderr:'pipe'})
      const second=JSON.parse(await new Response(child.stdout).text())
      expect(await child.exited).toBe(0)
      expect(second.observations[0].process_id).toBe(f.endpoint.pid)
      expect(second.observations[0].runtime_instance_id).toBe(f.runtimeId)
      expect(inspectHostRuntime({agentId:f.agentId,logicalWorkspace:'/wrong'}).observations).toEqual([])
      expect(inspectHostRuntime({agentId:f.agentId,expectedHost:'wrong-host'}).observations).toEqual([])
    } finally {await f.close()}
  },15000)
  test('NP04: OS-visible unbound UUID cannot be discovered',async()=>{
    const f=await nonpersistHostFixture('forged')
    try {expect(inspectHostRuntime({agentId:f.agentId}).reasonCode).toBe('RUNTIME_UUID_UNBOUND')}
    finally {await f.close()}
  },10000)
  test('NP08: one deadline covers all candidates; no fresh per-candidate budget',()=>{
    let monotonic=0,calls=0
    const observer=createHostRuntimeObserver({host:()=> 'host',canonical:v=>v,wall:()=>1000,monotonic:()=>monotonic,
      run(_command,args,timeout){calls++;expect(timeout).toBeLessThanOrEqual(3);monotonic+=4;return '200 100 bun /fixture/server.ts'}})
    expect(observer({agentId:'seat',deadline:3}).observations).toEqual([])
    expect(calls).toBe(1)
  })
})

describe('NP changed-input effect and authority regressions',()=>{
 test('NP03: held port is inaccessible before commit and after authority loss',async()=>{
   let calls=0,allowed=false
   const held=bindRuntimeEndpoint({fetch:()=>{calls++;return new Response('effect')},authorize:async()=>allowed})
   try {
     expect((await fetch(held.endpointUri)).status).toBe(503);expect(calls).toBe(0)
     let commit!:()=>void
     const publishing=held.publish(()=>new Promise<void>(resolve=>{commit=resolve}))
     expect((await fetch(held.endpointUri)).status).toBe(503);expect(calls).toBe(0)
     allowed=true;commit();await publishing
     expect((await fetch(held.endpointUri)).status).toBe(200);expect(calls).toBe(1)
     allowed=false;expect((await fetch(held.endpointUri)).status).toBe(503);expect(calls).toBe(1)
   }finally{held.server.stop(true)}
 })
 test('NP03: unknown commit closes only this held socket',async()=>{
   const other=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('other')})
   const failed=bindRuntimeEndpoint({fetch:()=>new Response('never'),authorize:async()=>true})
   try{await expect(failed.publish(async()=>{throw new Error('unknown commit')})).rejects.toThrow('RUNTIME_ENDPOINT_REGISTRATION_FAILED')
     expect((await fetch(`http://127.0.0.1:${other.port}`)).status).toBe(200)
   }finally{other.stop(true);failed.server.stop(true)}
 })
 test('NP02: bypass authority constraints survive projection exactly',()=>{
   const raw={actor:'owner',reason:'one scoped repair',timestamp:'2026-09-21T00:00:00Z',expires_at:'2026-09-21T01:00:00Z',
     target:{agent_id:'seat'},queue_scope:{agent_id:'seat',queue_ids:[1,3],statuses:['pending'],action_kinds:['invoke']}}
   const saved=durableMemoryMetadata(raw)
   expect(saved.target).toEqual(raw.target);expect(saved.queue_scope).toEqual(raw.queue_scope)
   expect((saved.queue_scope as any).queue_ids.includes(2)).toBe(false)
   expect(()=>durableMemoryMetadata({...raw,queue_scope:{...raw.queue_scope,unknown_restriction:'only one'}})).toThrow('BYPASS_SCOPE_UNSUPPORTED_CONSTRAINT')
 })
})


describe('NP host enumeration churn',()=>{
  for(const factory of [createHostRuntimeObserver,createNativeHostRuntimeObserver]) {
    for(const scenario of ['unrelated_exited','unrelated_unreadable','target_exited','target_changed','invalid_pid_readback'] as const) {
      test(`${factory.name}: ${scenario} distinguishes disappearance from missing authority`,()=>{
        let targetReads=0,confirmations=0
        const observer=factory({host:()=> 'host',canonical:p=>p,wall:()=>Date.parse('2026-09-21T00:00:10Z'),monotonic:()=>0,
          processStart:()=> '2026-09-21T00:00:00Z',
          run(command,args){
            expect(command==='ps'||command==='lsof').toBe(true)
            if(args.join(' ')==='-axo pid=,ppid=,command=')return '300 1 bun /other/server.ts\n200 100 bun /fixture/server.ts\n100 1 /fixture/codex'
            if(args.join(' ')==='-axo pid=') {
              confirmations++
              if(scenario==='invalid_pid_readback')return 'invalid'
              return scenario==='unrelated_unreadable'?'100 200 300':scenario==='target_exited'?'100':'100 200'
            }
            const pid=args[args.indexOf('-p')+1]
            if(args[0]==='eww') {
              if(pid==='300')throw Object.assign(new Error('candidate exited'),{status:1})
              if(pid==='200') {
                targetReads++
                if(scenario==='target_exited'||(scenario==='target_changed'&&targetReads===2))throw Object.assign(new Error('holder exited'),{status:1})
                return `bun /fixture/server.ts AGENT_ID=seat AGENT_COM_RUNTIME_INSTANCE_ID=${id} AGENT_COM_EXPECTED_AGENT_ID=seat AGENT_COM_WORKSPACE=/fixture AGENT_COM_RUNTIME_SESSION=session`
              }
              return '/fixture/codex CODEX_THREAD_ID=session'
            }
            if(args.includes('lstart='))return '2026-09-21T00:00:00Z'
            if(args.includes('cwd'))return 'p200\nn/fixture'
            if(command==='lsof')return 'p200\nn127.0.0.1:32100'
            throw new Error('unexpected fixture operation')
          },
        })
        const result=observer({agentId:'seat'})
        expect(confirmations).toBeGreaterThan(0)
        if(scenario==='unrelated_exited') {
          expect(result.reasonCode).toBe('OBSERVED')
          expect(result.observations).toHaveLength(1)
          expect(result.observations[0].runtime_instance_id).toBe(id)
          expect(result.observations[0].process_id).toBe(200)
        } else {
          expect(result.observations).toEqual([])
          expect(result.reasonCode).toBe(scenario==='target_exited'?'NO_LIVE_RUNTIME':'HOST_OBSERVATION_UNAVAILABLE')
        }
      })
    }
  }
})


describe('NP HTTP transport socket roles', () => {
  for (const factory of [createHostRuntimeObserver, createNativeHostRuntimeObserver]) {
    for (const [label, config, sockets, expected] of [
      ['explicit MCP', 'AGENT_COMMS_PORT=8801', 'n*:8801\nn127.0.0.1:32100', 'OBSERVED'],
      ['default MCP', 'EXPECTED_BOTS=seat', 'n*:8800\nn127.0.0.1:32100', 'OBSERVED'],
      ['undeclared listener', '', 'n*:8801\nn127.0.0.1:32100', 'SOCKET_OWNER_AMBIGUOUS'],
      ['extra runtime', 'AGENT_COMMS_PORT=8801', 'n*:8801\nn127.0.0.1:32100\nn127.0.0.1:32101', 'SOCKET_OWNER_AMBIGUOUS'],
      ['MCP alone', 'AGENT_COMMS_PORT=8801', 'n*:8801', 'SOCKET_OWNER_AMBIGUOUS'],
      ['invalid port', 'AGENT_COMMS_PORT=8801oops', 'n*:8801\nn127.0.0.1:32100', 'SOCKET_OWNER_AMBIGUOUS'],
      ['configuration alone', 'AGENT_COMMS_PORT=8801', 'n127.0.0.1:32100', 'OBSERVED'],
    ]) {
      test(`${factory.name}: ${label}`, () => {
        const inspector = factory({host: () => 'host', canonical: value => value,
          wall: () => Date.parse('2026-09-21T00:00:10Z'), monotonic: () => 0,
          processStart: () => '2026-09-21T00:00:00Z',
          run(command, args) {
            if (args.join(' ') === '-axo pid=,ppid=,command=') return '200 100 bun /fixture/server.ts\n100 1 /fixture/codex'
            if (args[0] === 'eww') return args.includes('200')
              ? `bun /fixture/server.ts AGENT_ID=seat AGENT_COM_RUNTIME_INSTANCE_ID=${id} AGENT_COM_EXPECTED_AGENT_ID=seat AGENT_COM_WORKSPACE=/fixture AGENT_COM_RUNTIME_SESSION=session ${config}`
              : '/fixture/codex CODEX_THREAD_ID=session'
            if (args.includes('lstart=')) return '2026-09-21T00:00:00Z'
            if (args.includes('cwd')) return 'p200\nn/fixture'
            if (command === 'lsof') return `p200\n${sockets}`
            throw new Error('unexpected operation')
          },
        })
        const result = inspector({agentId: 'seat'})
        expect(result.reasonCode).toBe(expected)
        if (expected === 'OBSERVED') {
          expect(result.observations).toHaveLength(1)
          expect(result.observations[0].port).toBe(32100)
        } else expect(result.observations).toEqual([])
      })
    }
  }
})
