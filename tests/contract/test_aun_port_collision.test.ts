import {unitRuntimeObservation} from '../helpers/logical-runtime-unit-fixture'
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindRuntimeEndpoint, requestedRuntimePort, resolveRuntimeEndpoint } from '../../core/runtime-endpoint'

// Issue #248's noninterference regression, updated for seat continuity SC2:
// keep the OS bind(0) socket open, then publish its actual endpoint. These tests
// own only ephemeral loopback listeners; no server.ts startup, DB, or orphan kill.
const held: ReturnType<typeof bindRuntimeEndpoint>[] = []
const bind = (port?: number) => {
  const endpoint = bindRuntimeEndpoint({ port, authorize:async()=>true, fetch: () => new Response('owned fixture') })
  held.push(endpoint)
  return endpoint
}
afterEach(() => { for (const endpoint of held.splice(0)) endpoint.server.stop(true) })

const NOW = new Date('2026-09-13T01:00:00Z')
function leaseRow(endpoint: ReturnType<typeof bindRuntimeEndpoint>) {
  return {
    runtime_instance_id: 'current-runtime', agent_id: 'fixture-seat', runtime_kind: 'local_process',
    host_id: 'fixture-host', process_id: 4201, session_name: 'fixture-session', checkout_path: '/fixture',
    port: endpoint.port, endpoint_uri: endpoint.endpointUri, runtime_status: 'active', last_seen_at: NOW.toISOString(),
    authority_live:1, acquired_at:'2026-09-13T00:01:00Z', lease_id: 'lease-current', fencing_token: 2, holder_agent_id: 'fixture-seat',
    holder_runtime_instance_id: 'current-runtime', lease_status: 'active', expires_at: '2026-09-13T01:05:00Z',
    lease_metadata: { port: endpoint.port, endpoint_uri: endpoint.endpointUri, process_id: 4201 },
  }
}
const inspectRow=(row:any)=>()=>({reasonCode:'OBSERVED',observations:[unitRuntimeObservation('fixture-seat',{
  runtime_instance_id:row.runtime_instance_id,host_id:'fixture-host',process_id:4201,process_started_at:'2026-09-13T00:00:00Z',
  session_name:'fixture-session',workspace:'/fixture',port:row.port,endpoint_uri:row.endpoint_uri})]})
const resolveRows = (rows: any[], observed:any=rows[0]) => resolveRuntimeEndpoint({ query: async () => rows }, {
  agentId: 'fixture-seat', runtimeInstanceId: 'current-runtime', hostId: 'fixture-host', now: NOW, inspect:observed?inspectRow(observed):()=>({reasonCode:'NO_LIVE_RUNTIME',observations:[]}),
})

describe('test_aun_port_collision — held OS endpoint and owner isolation', () => {
  test('ordinary startup ignores both legacy generated port variables', () => {
    expect(requestedRuntimePort({})).toBe(0)
    expect(requestedRuntimePort({ WEBHOOK_PORT: '8789' })).toBe(0)
    expect(requestedRuntimePort({ AUN_WEBHOOK_PORT: '8810', WEBHOOK_PORT: '8850' })).toBe(0)
  })

  test('only an explicit infrastructure request selects a static port', () => {
    expect(requestedRuntimePort({ AUN_STATIC_WEBHOOK_PORT: '41234', WEBHOOK_PORT: '8789' })).toBe(41234)
    expect(requestedRuntimePort({ AUN_STATIC_WEBHOOK_PORT: '' })).toBe(0)
    for (const invalid of ['0', '-1', '65536', 'port', '1.5', ' 41234']) {
      expect(() => requestedRuntimePort({ AUN_STATIC_WEBHOOK_PORT: invalid })).toThrow('RUNTIME_STATIC_PORT_INVALID')
    }
  })

  test('simultaneous ordinary seats hold distinct reachable ports', async () => {
    const seats = await Promise.all(Array.from({ length: 8 }, async () => bind()))
    expect(new Set(seats.map(seat => seat.port)).size).toBe(8)
    for (const seat of seats) {
      expect(seat.port).toBeGreaterThan(0)
      expect(seat.port).toBeLessThanOrEqual(65535)
      expect((await fetch(seat.endpointUri)).status).toBe(503)
      await seat.publish(async()=>({registered:true}))
      expect(await (await fetch(seat.endpointUri)).text()).toBe('owned fixture')
    }
  })

  test('publication uses the actual still-held port and URI', async () => {
    const endpoint = bind()
    const result = await endpoint.publish(async (port, uri) => {
      expect(port).toBe(endpoint.server.port)
      expect(uri).toBe(`http://127.0.0.1:${port}`)
      expect((await fetch(uri)).status).toBe(503)
      expect(() => bind(port)).toThrow()
      return { port, uri }
    })
    expect(result).toEqual({ port: endpoint.port, uri: endpoint.endpointUri })
    expect(await (await fetch(result.uri)).text()).toBe('owned fixture')
  })

  test('explicit collision leaves the existing owner alive', async () => {
    const owner = bind()
    await owner.publish(async()=>({registered:true}))
    expect(() => bind(requestedRuntimePort({ AUN_STATIC_WEBHOOK_PORT: String(owner.port) }))).toThrow()
    expect(await (await fetch(owner.endpointUri)).text()).toBe('owned fixture')
  })

  test('registration failure releases only its own socket', async () => {
    const failed = bind()
    const survivor = bind()
    await survivor.publish(async()=>({registered:true}))
    await expect(failed.publish(async () => { throw new Error('fixture registration refused') }))
      .rejects.toThrow('RUNTIME_ENDPOINT_REGISTRATION_FAILED')
    await expect(fetch(failed.endpointUri)).rejects.toThrow()
    expect(await (await fetch(survivor.endpointUri)).text()).toBe('owned fixture')
  })

  test('no PATH probe or external lsof command is needed to allocate the socket', () => {
    const helper = join(import.meta.dir, '../../core/runtime-endpoint.ts')
    const script = `import {bindRuntimeEndpoint} from ${JSON.stringify(helper)};
      const e=bindRuntimeEndpoint({fetch:()=>new Response('ok')});
      console.log(JSON.stringify({port:e.port,uri:e.endpointUri}));e.server.stop(true);`
    const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
      env: { PATH: '/nonexistent-fixture-path' }, stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    const value = JSON.parse(result.stdout.toString())
    expect(value.port).toBeGreaterThan(0)
    expect(value.uri).toBe(`http://127.0.0.1:${value.port}`)
  })

  test('consumers resolve only the exact live runtime lease, never a profile port', async () => {
    const row = leaseRow(bind())
    const resolved = await resolveRows([row])
    expect(resolved.ok).toBe(true)
    expect(resolved.endpoint).toMatchObject({ runtimeInstanceId: row.runtime_instance_id, port: row.port, fencingToken: 2 })
    for (const mismatch of [
      { holder_agent_id:'foreign-seat' },{ holder_runtime_instance_id:'previous-runtime' },
      { authority_live:0 },{ fencing_token:0 },
    ])expect((await resolveRows([{...row,...mismatch}],row)).ok).toBe(false)
    // D-OWN-1: historical acquisition time is not ownership evidence.
    expect((await resolveRows([{...row,acquired_at:'2026-09-12T00:00:00Z'}],row)).ok).toBe(true)
    // Legacy physical columns and copied metadata are irrelevant to current authority.
    expect((await resolveRows([{...row,runtime_status:'stopped',host_id:'old-host',lease_metadata:{port:1}}],row)).ok).toBe(true)
    expect((await resolveRows([])).endpoint).toBeNull()
    expect((await resolveRows([row, { ...row, lease_id: 'ambiguous-lease' }])).code).toBe('RUNTIME_ENDPOINT_HOLDER_UNVERIFIED')
  })

  test('a rebound seat cannot use the previous runtime lease', async () => {
    const old = bind()
    const oldRow = leaseRow(old)
    old.server.stop(true)
    const current = bind()
    await current.publish(async()=>({registered:true}))
    const currentRow = { ...leaseRow(current), runtime_instance_id: 'replacement-runtime', holder_runtime_instance_id: 'replacement-runtime' }
    const result = await resolveRuntimeEndpoint({ query: async () => [
      { ...oldRow, authority_live:0, lease_status: 'released', runtime_status: 'stopped' }, currentRow,
    ] }, { agentId: 'fixture-seat', hostId: 'fixture-host', now: NOW,inspect:inspectRow(currentRow) })
    expect(result.endpoint?.runtimeInstanceId).toBe('replacement-runtime')
    expect(result.endpoint?.port).toBe(current.port)
    expect(await (await fetch(current.endpointUri)).text()).toBe('owned fixture')
  })

  test('the ordinary server calls the same held-binder implementation', () => {
    const source = readFileSync(join(import.meta.dir, '../../server.ts'), 'utf8')
    expect(source).toContain('requestedRuntimePort(')
    expect(source).toContain('bindRuntimeEndpoint(')
    expect(source).not.toContain('for (let port = 8801')
  })
})
