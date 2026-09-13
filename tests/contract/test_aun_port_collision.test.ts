import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindRuntimeEndpoint, requestedRuntimePort, resolveRuntimeEndpoint } from '../../core/runtime-endpoint'

// Issue #248's noninterference regression, updated for seat continuity SC2:
// keep the OS bind(0) socket open, then publish its actual endpoint. These tests
// own only ephemeral loopback listeners; no server.ts startup, DB, or orphan kill.
const held: ReturnType<typeof bindRuntimeEndpoint>[] = []
const bind = (port?: number) => {
  const endpoint = bindRuntimeEndpoint({ port, fetch: () => new Response('owned fixture') })
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
    lease_id: 'lease-current', fencing_token: 2, holder_agent_id: 'fixture-seat',
    holder_runtime_instance_id: 'current-runtime', lease_status: 'active', expires_at: '2026-09-13T01:05:00Z',
    lease_metadata: { port: endpoint.port, endpoint_uri: endpoint.endpointUri, process_id: 4201 },
  }
}
const resolveRows = (rows: any[]) => resolveRuntimeEndpoint({ query: async () => rows }, {
  agentId: 'fixture-seat', runtimeInstanceId: 'current-runtime', hostId: 'fixture-host', now: NOW,
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
      expect(await (await fetch(seat.endpointUri)).text()).toBe('owned fixture')
    }
  })

  test('publication uses the actual still-held port and URI', async () => {
    const endpoint = bind()
    const result = await endpoint.publish(async (port, uri) => {
      expect(port).toBe(endpoint.server.port)
      expect(uri).toBe(`http://127.0.0.1:${port}`)
      expect(await (await fetch(uri)).text()).toBe('owned fixture')
      expect(() => bind(port)).toThrow()
      return { port, uri }
    })
    expect(result).toEqual({ port: endpoint.port, uri: endpoint.endpointUri })
    expect(await (await fetch(result.uri)).text()).toBe('owned fixture')
  })

  test('explicit collision leaves the existing owner alive', async () => {
    const owner = bind()
    expect(() => bind(requestedRuntimePort({ AUN_STATIC_WEBHOOK_PORT: String(owner.port) }))).toThrow()
    expect(await (await fetch(owner.endpointUri)).text()).toBe('owned fixture')
  })

  test('registration failure releases only its own socket', async () => {
    const failed = bind()
    const survivor = bind()
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
      { holder_agent_id: 'foreign-seat' }, { holder_runtime_instance_id: 'previous-runtime' },
      { host_id: 'other-host' }, { lease_status: 'released' },
      { expires_at: '2026-09-13T00:59:59Z' }, { runtime_status: 'stopped' },
      { last_seen_at: '2026-09-12T00:00:00Z' }, { fencing_token: 0 },
      { lease_metadata: { ...row.lease_metadata, process_id: 4202 } },
      { lease_metadata: { ...row.lease_metadata, endpoint_uri: 'http://127.0.0.1:1' } },
    ]) {
      expect((await resolveRows([{ ...row, ...mismatch }])).code).toBe('RUNTIME_ENDPOINT_UNAVAILABLE')
    }
    expect((await resolveRows([])).endpoint).toBeNull()
    expect((await resolveRows([row, { ...row, lease_id: 'ambiguous-lease' }])).code).toBe('RUNTIME_ENDPOINT_AMBIGUOUS')
  })

  test('a rebound seat cannot use the previous runtime lease', async () => {
    const old = bind()
    const oldRow = leaseRow(old)
    old.server.stop(true)
    const current = bind()
    const currentRow = { ...leaseRow(current), runtime_instance_id: 'replacement-runtime', holder_runtime_instance_id: 'replacement-runtime' }
    const result = await resolveRuntimeEndpoint({ query: async () => [
      { ...oldRow, lease_status: 'released', runtime_status: 'stopped' }, currentRow,
    ] }, { agentId: 'fixture-seat', hostId: 'fixture-host', now: NOW })
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
