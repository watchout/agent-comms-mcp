import { describe, test, expect } from 'bun:test'
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { publishNativeFixtureReport } from './helpers/seat-native-runtime-fixture'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { bindRuntimeEndpoint, requestedRuntimePort, resolveRuntimeEndpoint } from '../core/runtime-endpoint'
import { observeSeatMemoryBinding, readObservedProviderRoot, observeSeatProvider, resolveSeatProvider, selectSeatProvider, type SeatProviderObservation } from '../core/seat-runtime-selection'

const NOW = new Date('2026-09-13T12:00:00Z')
function observation(overrides: Partial<SeatProviderObservation> = {}): SeatProviderObservation {
  return {schema_version:'seat-provider-observation/v1',agent_id:'seat',runtime_instance_id:'runtime',host_id:'test-host',
    process_id:200,provider_pid:100,provider_started_at:'fixture-start',provider:'codex',session_name:'new-session',workspace:'/new-host/repo',
    observed_at:NOW.toISOString(),source:'process_ancestry',verified:true,...overrides}
}
describe('SC1 stable seat provider selection', () => {
  test('P01 actual target ancestry selects either provider despite opposite legacy preference', async () => {
    for (const provider of ['codex','claude'] as const) {
      let writes = 0
      const db = {async query(sql: string) {
        if (!sql.startsWith('SELECT')) writes++
        return [{runtime_instance_id:'runtime',agent_id:'seat',host_id:'test-host',process_id:200,
          session_name:'new-session',checkout_path:'/new-host/repo',status:'running',last_seen_at:NOW.toISOString(),
          runtime_engine_preference:provider === 'codex' ? 'claude-code' : 'codex',metadata:{}}]
      }}
      const result = await resolveSeatProvider(db,{agentId:'seat',hostId:'test-host',now:NOW,
        observe: input => observeSeatProvider({...input,providerStartedAt:'fixture-start',processes:[
          {pid:100,ppid:1,command:`/bin/${provider}`},{pid:200,ppid:100,command:'bun server.ts AGENT_ID=seat'},
          {pid:300,ppid:1,command:`/bin/${provider === 'codex' ? 'claude' : 'codex'}`},
        ]})})
      expect(result.provider).toBe(provider)
      expect(result.code).toBe('SELECTED_LIVE')
      expect(writes).toBe(0)
    }
  })
  test('live provider root ignores caller context and rejects PID reuse, missing or conflicting evidence', async () => {
    const dir=mkdtempSync(join(tmpdir(),'seat-native-root-'))
    const nativeRoot=join(dir,'.codex'); mkdirSync(nativeRoot)
    const started='2026-09-13T00:00:00.000Z'
    const input={pid:123,startedAt:started,cwd:dir,env:{CODEX_HOME:'/wrong-caller'}}
    try {
      for (const nativeEnv of [`HOME=${dir}`,`HOME=${dir} CODEX_HOME=${nativeRoot}`]) {
        const run=async (_c:string,args:string[])=>({exitCode:0,stdout:args.includes('lstart=')?started:`/bin/codex ${nativeEnv}`})
        expect((await readObservedProviderRoot(run,input))?.root).toBe(realpathSync(nativeRoot))
      }
      for (const nativeEnv of ['',`HOME=${dir} CODEX_HOME=${nativeRoot} CODEX_HOME=/foreign`]) {
        const run=async (_c:string,args:string[])=>({exitCode:0,stdout:args.includes('lstart=')?started:`/bin/codex ${nativeEnv}`})
        expect(await readObservedProviderRoot(run,input)).toBeNull()
      }
      // ps returns a zone-less value even when the JavaScript host has a
      // different timezone. Readback binds UTC explicitly and retains PID reuse denial.
      expect((await readObservedProviderRoot(async(_c,args,options)=>{
        expect(options.env.TZ).toBe('UTC')
        expect(options.env.LC_ALL).toBe('C')
        return {exitCode:0,stdout:args.includes('lstart=')?'Sun Sep 13 00:00:00 2026':`/bin/codex HOME=${dir}`}
      },{...input,env:{...input.env,TZ:'Asia/Tokyo'}}))?.root).toBe(realpathSync(nativeRoot))
      let reads=0
      expect(await readObservedProviderRoot(async(_c,args)=>({exitCode:0,stdout:args.includes('lstart=')
        ? (++reads===1?started:'2026-09-13T00:00:01.000Z'):`/bin/codex HOME=${dir}`}),input)).toBeNull()
    } finally {rmSync(dir,{recursive:true,force:true})}
  })
  test('actual connected memory child must match the current provider and seat; private repaired lookup is insufficient',()=>{
    const input={agentId:'seat',project:'project',providerPid:100,providerStartedAt:'2026-09-13T00:00:00Z',transportArgs:['/fixture/wasurezu/server.ts'],
      processes:[{pid:100,ppid:1,command:'codex'},{pid:200,ppid:100,command:'bun /fixture/wasurezu/server.ts'}]}
    expect(observeSeatMemoryBinding({...input,readEnvironment:()=> 'AGENT_MEMORY_AGENT_ID=seat AGENT_MEMORY_PROJECT=project'})).toBe(true)
    expect(observeSeatMemoryBinding({...input,readEnvironment:()=> 'AGENT_MEMORY_AGENT_ID=arc AGENT_MEMORY_PROJECT=iyasaka-arc'})).toBe(false)
    expect(observeSeatMemoryBinding({...input,processes:[{pid:200,ppid:999,command:'bun /fixture/wasurezu/server.ts'}],readEnvironment:()=> 'AGENT_MEMORY_AGENT_ID=seat AGENT_MEMORY_PROJECT=project'})).toBe(false)
  })
  test('P02 unknown, generic MCP, foreign seat, and multiple live owners cannot select', () => {
    expect(observeSeatProvider({agentId:'seat',runtimeInstanceId:'runtime',processId:200,sessionName:'s',workspace:'/repo',
      processes:[{pid:200,ppid:1,command:'bun server.ts'}]})).toBeNull()
    for (const live of [[],[observation({agent_id:'decoy'})],[{...observation(),verified:false}],
      [observation(),observation({provider:'claude',provider_pid:300,runtime_instance_id:'other'})]]) {
      expect(selectSeatProvider({agentId:'seat',live,now:NOW}).ok).toBe(false)
    }
    expect(selectSeatProvider({agentId:'seat',live:[observation()],intent:'claude',now:NOW}).code).toBe('PROVIDER_AMBIGUOUS')
  })
  test('P03 cold intent or qualified history; stale/profile-only/ambiguous history cannot launch', () => {
    expect(selectSeatProvider({agentId:'seat',intent:'claude',now:NOW}).code).toBe('SELECTED_INTENT')
    expect(selectSeatProvider({agentId:'seat',history:[observation()],allowHistory:true,now:NOW}).provider).toBe('codex')
    for (const history of [[{runtime_engine_preference:'codex'}],[observation({observed_at:'2026-08-01T00:00:00Z'})],
      [observation(),observation({provider:'claude',runtime_instance_id:'other'})]]) {
      expect(selectSeatProvider({agentId:'seat',history,allowHistory:true,now:NOW}).ok).toBe(false)
    }
    expect(selectSeatProvider({agentId:'seat',intent:'unsupported',now:NOW}).code).toBe('PROVIDER_UNSUPPORTED')
  })
})

describe('SC2 held OS endpoint and exact lease resolution', () => {
  test('legacy generated port env never requests a fixed listener', () => {
    expect(requestedRuntimePort({WEBHOOK_PORT:'8812',AUN_WEBHOOK_PORT:'8802'})).toBe(0)
    expect(requestedRuntimePort({AUN_STATIC_WEBHOOK_PORT:'19022'})).toBe(19022)
    expect(() => requestedRuntimePort({AUN_STATIC_WEBHOOK_PORT:'80garbage'})).toThrow()
  })
  test('P05-P07 held binds, exact publication, same-seat replacement and foreign/stale denial', async () => {
    const dir=mkdtempSync(join(tmpdir(),'seat-endpoint-')), path=join(dir,'fixture.db')
    migrateSqlite(path)
    const db=new SqliteAdapter(path)
    const listeners = await Promise.all(['one','two'].map(async id => bindRuntimeEndpoint({fetch:()=>Response.json({runtime:id})})))
    async function publish(index:number,id:string,agent:string) {
      return listeners[index].publish(async(port,uri)=>{
        await db.execute(`INSERT OR IGNORE INTO agents(agent_id,display_name,agent_type,runtime,status,channel_port) VALUES($1,$1,'dev','TUI','idle',8812)`,[agent])
        await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_engine,runtime_kind,host_id,process_id,port,endpoint_uri,status,last_seen_at)
          VALUES($1,$2,'TUI','local_process','test-host',$3,$4,$5,'running',$6)`,[id,agent,200+index,port,uri,NOW.toISOString()])
        await db.execute(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,expires_at,metadata)
          VALUES($1,'runtime_instance',$2,'worker',$3,$2,1,'active',$4,$5)`,['lease-'+id,id,agent,new Date(NOW.getTime()+600000).toISOString(),JSON.stringify({port,endpoint_uri:uri,process_id:200+index})])
      })
    }
    try {
      expect(listeners[0].port).toBeGreaterThan(0)
      expect(listeners[0].port).not.toBe(listeners[1].port)
      expect((await resolveRuntimeEndpoint(db,{agentId:'one',hostId:'test-host',now:NOW})).ok).toBe(false)
      await Promise.all([publish(0,'one','one'),publish(1,'two','two')])
      for(let i=0;i<2;i++) {
        const id=i?'two':'one', result=await resolveRuntimeEndpoint(db,{agentId:id,runtimeInstanceId:id,hostId:'test-host',now:NOW})
        expect(result.endpoint?.port).toBe(listeners[i].port)
        expect(await (await fetch(result.endpoint!.endpointUri)).json()).toEqual({runtime:id})
        expect((await resolveRuntimeEndpoint(db,{agentId:id,hostId:'foreign-host',now:NOW})).ok).toBe(false)
      }
      listeners.push(bindRuntimeEndpoint({fetch:()=>Response.json({runtime:'replacement'})}))
      await publish(2,'one-new','one')
      expect((await resolveRuntimeEndpoint(db,{agentId:'one',hostId:'test-host',now:NOW})).code).toBe('RUNTIME_ENDPOINT_AMBIGUOUS')
      await db.execute("UPDATE agent_runtime_instances SET status='stopped' WHERE runtime_instance_id='one'")
      await db.execute("UPDATE control_plane_leases SET status='released' WHERE lease_id='lease-one'")
      const replacement=await resolveRuntimeEndpoint(db,{agentId:'one',hostId:'test-host',now:NOW})
      expect(replacement.endpoint?.runtimeInstanceId).toBe('one-new')
      expect(replacement.endpoint?.port).toBe(listeners[2].port)
      expect(await (await fetch(replacement.endpoint!.endpointUri)).json()).toEqual({runtime:'replacement'})
      expect((await resolveRuntimeEndpoint(db,{agentId:'one',runtimeInstanceId:'one',hostId:'test-host',now:NOW})).ok).toBe(false)
      await db.execute("UPDATE control_plane_leases SET holder_agent_id='two' WHERE lease_id='lease-one-new'")
      expect((await resolveRuntimeEndpoint(db,{agentId:'one',hostId:'test-host',now:NOW})).ok).toBe(false)
      await db.execute("UPDATE control_plane_leases SET expires_at='2020-01-01' WHERE lease_id='lease-two'")
      expect((await resolveRuntimeEndpoint(db,{agentId:'two',hostId:'test-host',now:NOW})).ok).toBe(false)
      expect(await (await fetch(listeners[0].endpointUri)).json()).toEqual({runtime:'one'})
    } finally {listeners.forEach(l=>l.server.stop(true));await db.close();rmSync(dir,{recursive:true,force:true})}
  })
  test('P06 registration failure closes only its own held socket', async () => {
    const good=bindRuntimeEndpoint({fetch:()=>new Response('good')}), bad=bindRuntimeEndpoint({fetch:()=>new Response('bad')})
    try {
      await expect(bad.publish(async()=>{throw new Error('synthetic DB failure')})).rejects.toThrow('RUNTIME_ENDPOINT_REGISTRATION_FAILED')
      await expect(fetch(bad.endpointUri)).rejects.toThrow()
      expect(await (await fetch(good.endpointUri)).text()).toBe('good')
    } finally {good.server.stop(true);bad.server.stop(true)}
  })
})


describe('native fixture report publication', () => {
  test('partial staging bytes are invisible until the actual publisher completes', () => {
    const home = mkdtempSync(join(tmpdir(), 'native-report-publication-'))
    const report = join(home, 'native-host.json')
    const payload = {endpoint: {pid: 123, port: 456}, content: 'complete fixture report'}
    let observations = 0
    try {
      publishNativeFixtureReport(report, payload, {openSync, closeSync, renameSync, rmSync,
        writeFileSync(fd, data) {
          const bytes = String(data)
          expect(existsSync(report)).toBe(false)
          expect(readFileSync(`${report}.pending`, 'utf8')).toBe('')
          writeSync(fd as number, bytes.slice(0, 8))
          expect(existsSync(report)).toBe(false)
          expect(() => JSON.parse(readFileSync(`${report}.pending`, 'utf8'))).toThrow()
          observations++
          writeSync(fd as number, bytes.slice(8))
        },
      })
      expect(observations).toBe(1)
      expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(payload)
      expect(existsSync(`${report}.pending`)).toBe(false)
    } finally {rmSync(home, {recursive: true, force: true})}
  })
  test('failed partial write or publication never exposes a complete report', () => {
    for (const failure of ['write', 'rename'] as const) {
      const home = mkdtempSync(join(tmpdir(), 'native-report-failure-'))
      const report = join(home, 'native-host.json')
      try {
        expect(() => publishNativeFixtureReport(report, {value: 'complete'}, {
          openSync, closeSync, rmSync,
          writeFileSync(fd, data) {
            if (failure === 'write') {writeSync(fd as number, '{'); throw new Error('controlled writer failure')}
            writeFileSync(fd, data)
          },
          renameSync(from, to) {
            expect(existsSync(report)).toBe(false)
            if (failure === 'rename') throw new Error('controlled publish failure')
            renameSync(from, to)
          },
        })).toThrow(failure === 'write' ? 'controlled writer failure' : 'controlled publish failure')
        expect(existsSync(report)).toBe(false)
        expect(existsSync(`${report}.pending`)).toBe(false)
      } finally {rmSync(home, {recursive: true, force: true})}
    }
  })
})
