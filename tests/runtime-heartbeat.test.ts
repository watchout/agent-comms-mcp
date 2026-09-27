import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { nonpersistHostFixture } from './helpers/nonpersist-host-fixture'
import { heartbeatRuntimeInstance, inferRuntimeSessionName, resolveRuntimeSessionName,
  parseRuntimePort, hasRuntimeConnectorIdentityEvidence, normalizeCheckoutPath,
  inferWorkspaceName, deterministicWorkspaceId } from '../core/runtime-heartbeat'

async function withHolder(run: (x: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'heartbeat-logical-'))
  const path = join(dir, 'test.db'); migrateSqlite(path)
  const adapter = new SqliteAdapter(path), host = await nonpersistHostFixture()
  const calls: Array<{sql: string; params: any[]}> = []
  const db = { async query(sql: string, params: any[] = []) {
    calls.push({sql, params}); const rows = await adapter.query(sql, params)
    return {rows, rowCount: rows.length}
  }}
  try {
    await adapter.execute(`INSERT INTO agents(agent_id,display_name,agent_type) VALUES($1,$1,'dev')`, [host.agentId])
    await adapter.execute(`INSERT INTO agent_workspaces(workspace_id,name) VALUES('logical-project','project')`)
    await adapter.execute(`INSERT INTO agent_workspace_bindings(agent_id,workspace_id,binding_role,active) VALUES($1,'logical-project','primary',1)`, [host.agentId])
    const input = {agentId:host.agentId,runtimeInstanceId:host.runtimeId,processId:host.endpoint.pid,
      port:host.endpoint.port,endpointUri:`http://127.0.0.1:${host.endpoint.port}`,checkoutPath:host.dir}
    await run({adapter,db,host,input,calls})
  } finally { await host.close(); await adapter.close(); rmSync(dir,{recursive:true,force:true}) }
}

async function assertNoPhysicalCopies(x: any, expectedConnectors: any[] = []) {
  const row = await x.adapter.queryOne('SELECT * FROM agent_runtime_instances WHERE runtime_instance_id=$1',[x.host.runtimeId])
  for (const key of ['runtime_engine','session_name','process_id','port','endpoint_uri','host_id','checkout_path','status','started_at','last_seen_at']) expect(row[key]).toBeNull()
  expect(await x.adapter.query('SELECT * FROM connector_instances')).toEqual(expectedConnectors)
  const lease = await x.adapter.queryOne('SELECT * FROM control_plane_leases')
  expect(lease.holder_runtime_instance_id).toBe(x.host.runtimeId)
  expect(JSON.stringify(lease.metadata)).not.toContain(x.host.dir)
  expect(JSON.stringify(lease.metadata)).not.toContain(String(x.host.endpoint.port))
}

describe('runtime heartbeat logical authority', () => {
  test('acquires a logical runtime and lease without copying connector observations', async () => {
    await withHolder(async x => {
      let reconciles=0
      const result=await heartbeatRuntimeInstance(x.db,{...x.input,connectorProvider:'discord',connectorUri:'discord://fixture',metadata:{source:'test'}},
        {reconcileMemoryReadyIdentity:async()=>{reconciles++;throw new Error('must use original native proof')}})
      expect(result.ok).toBe(true)
      expect(result.runtime_instance_id).toBe(x.host.runtimeId)
      expect(result.workspace_id).toBe('logical-project')
      expect(result.connector_rows_upserted).toBe(0)
      expect(result.connector_rows_updated).toBe(0)
      expect(result.endpoint_lease_id).toBeTruthy()
      expect(result.memory_ready_identity).toBeNull()
      expect(reconciles).toBe(0)
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO agent_workspaces'))).toBe(false)
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO agent_workspace_bindings'))).toBe(false)
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO agent_runtime_instances'))).toBe(true)
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO connector_instances'))).toBe(false)
      expect(x.calls.some((c:any)=>c.sql.includes('UPDATE connector_instances'))).toBe(false)
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO control_plane_leases'))).toBe(true)
      await assertNoPhysicalCopies(x)
    })
  })
  test('does not attach existing connector rows without connector evidence', async () => {
    await withHolder(async x => {
      await x.adapter.execute(`INSERT INTO connector_instances(connector_instance_id,agent_id,provider,connector_uri,status)
        VALUES($1,$2,'discord','discord://fixture-existing','registered')`,[randomUUID(),x.host.agentId])
      const before=await x.adapter.query('SELECT * FROM connector_instances')
      expect(before).toHaveLength(1)
      const result=await heartbeatRuntimeInstance(x.db,x.input)
      expect(result.connector_rows_upserted).toBe(0)
      expect(result.connector_rows_updated).toBe(0)
      expect(result.endpoint_lease_id).toBeTruthy()
      const lease=await x.adapter.queryOne('SELECT * FROM control_plane_leases')
      expect(lease.holder_connector_instance_id).toBeNull()
      await assertNoPhysicalCopies(x,before)
    })
  })
  test('renews an existing runtime endpoint lease using the process-held receipt', async () => {
    await withHolder(async x => {
      const first=await heartbeatRuntimeInstance(x.db,x.input)
      const lease={leaseId:first.endpoint_lease_id!,fencingToken:first.endpoint_lease_fencing_token}
      x.calls.length=0
      const result=await heartbeatRuntimeInstance(x.db,x.input,{lease})
      expect(result.endpoint_lease_id).toBe(lease.leaseId)
      const update=x.calls.find((c:any)=>c.sql.includes('UPDATE control_plane_leases'))
      expect(update.params.slice(0,5)).toEqual([lease.leaseId,lease.fencingToken,x.host.agentId,x.host.runtimeId,null])
      expect(x.calls.some((c:any)=>c.sql.includes('INSERT INTO control_plane_leases'))).toBe(false)
      await assertNoPhysicalCopies(x)
    })
  })
  test('expired runtime endpoint cannot be resurrected by its delayed heartbeat', async () => {
    await withHolder(async x => {
      const first=await heartbeatRuntimeInstance(x.db,x.input)
      await x.adapter.execute("UPDATE control_plane_leases SET expires_at='2000-01-01T00:00:00Z'")
      const before=await x.adapter.query('SELECT * FROM control_plane_leases')
      const lease={leaseId:first.endpoint_lease_id!,fencingToken:first.endpoint_lease_fencing_token}
      await expect(heartbeatRuntimeInstance(x.db,x.input,{lease})).rejects.toThrow('RUNTIME_ENDPOINT_LEASE_EXPIRED')
      expect(await x.adapter.query('SELECT * FROM control_plane_leases')).toEqual(before)
      expect(x.calls.filter((c:any)=>c.sql.includes('INSERT INTO control_plane_leases'))).toHaveLength(1)
      await assertNoPhysicalCopies(x)
    })
  })
  test('uses logical workspace membership while the current holder supplies its path', async () => {
    await withHolder(async x => {
      const before=await x.adapter.query('SELECT * FROM agents')
      const result=await heartbeatRuntimeInstance(x.db,x.input)
      expect(result.workspace_id).toBe('logical-project')
      expect(result.registration_metadata_provenance.checkout_path.effective_value).toBe(x.host.dir)
      expect(result.registration_metadata_provenance.checkout_path.source).toBe('ambient')
      expect(await x.adapter.query('SELECT * FROM agents')).toEqual(before)
      expect((await x.adapter.queryOne('SELECT local_path FROM agent_workspaces')).local_path).toBeNull()
      await assertNoPhysicalCopies(x)
    })
  })
  test('registers an exact MCP holder without PWD or TMUX metadata and refuses an unrelated path', async () => {
    await withHolder(async x => {
      const result=await heartbeatRuntimeInstance(x.db,x.input)
      expect(result.registration_metadata_provenance.profile_found).toBe(true)
      expect(result.registration_metadata_provenance.checkout_path.effective_value).toBe(x.host.dir)
      expect(result.registration_metadata_provenance.session_name.registered_value).toBeNull()
      expect(result.workspace_id).toBe('logical-project')
      const before=await x.adapter.query('SELECT * FROM control_plane_leases')
      await expect(heartbeatRuntimeInstance(x.db,{...x.input,checkoutPath:'/foreign/project'})).rejects.toThrow('RUNTIME_CURRENT_HOLDER_UNVERIFIED')
      expect(await x.adapter.query('SELECT * FROM control_plane_leases')).toEqual(before)
      await assertNoPhysicalCopies(x)
    })
  })
  test('infers session name and port from runtime environment', () => {
    expect(inferRuntimeSessionName({ DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' })).toBe('discord-hotel')

    // TMUX_PANE is a pane identifier, not a session name. Recording it verbatim made
    // agent_runtime_instances.session_name disagree with the seat's registered
    // metadata.tmux_session, and the memory_ready gate compares exactly those two, so
    // affected seats failed with session_mismatch and never received their queue rows.
    expect(resolveRuntimeSessionName({ TMUX_PANE: '%1008' }, () => 'discord-auditor')).toBe('discord-auditor')

    // An explicit override still wins over the pane lookup.
    expect(
      resolveRuntimeSessionName({ AGENT_COM_RUNTIME_SESSION: 'discord-arc', TMUX_PANE: '%1008' }, () => 'other'),
    ).toBe('discord-arc')

    // Without tmux the pane id is still returned, which is no worse than before and
    // keeps a machine with no tmux working.
    expect(resolveRuntimeSessionName({ TMUX_PANE: '%1008' }, () => null)).toBe('%1008')

    // A pane takes precedence over the state directory fallback.
    expect(
      resolveRuntimeSessionName({ TMUX_PANE: '%42', DISCORD_STATE_DIR: '/tmp/channels/discord-hotel' }, () => 'discord-auditor'),
    ).toBe('discord-auditor')
    expect(parseRuntimePort({ WEBHOOK_PORT: '8811' })).toBe(8811)
    expect(hasRuntimeConnectorIdentityEvidence({
      DISCORD_STATE_DIR: '/tmp/channels/discord-aun',
      WEBHOOK_PORT: '8811',
    })).toBe(true)
    expect(hasRuntimeConnectorIdentityEvidence({
      AGENT_COM_RUNTIME_SESSION: 'discord-aun',
      AUN_WEBHOOK_PORT: '8811',
    })).toBe(true)
    expect(hasRuntimeConnectorIdentityEvidence({
      TMUX_PANE: '%12',
      WEBHOOK_PORT: '8811',
    })).toBe(false)
    expect(hasRuntimeConnectorIdentityEvidence({
      DISCORD_STATE_DIR: '/tmp/channels/discord-aun',
    })).toBe(false)
  })

  test('derives stable local workspace identity from checkout path', () => {
    const normalized = normalizeCheckoutPath('/tmp/../tmp/hotel')
    expect(normalized).toBe('/tmp/hotel')
    expect(inferWorkspaceName(normalized, 'fallback')).toBe('hotel')
    expect(deterministicWorkspaceId('default', normalized!)).toMatch(/^local:[0-9a-f]{16}$/)
    expect(deterministicWorkspaceId('default', normalized!)).toBe(deterministicWorkspaceId('default', normalized!))
  })
})
