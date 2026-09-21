import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate as evaluateGate,
  recordRuntimeMemoryReadyEvidence,
  recordVerifiedNativeRuntimeMemoryReady,
  resolveRuntimeMemoryReadyProject as resolveProject,
} from '../core/runtime-memory-ready'
import { seatContextDigest, type SeatContextReceipt } from '../core/seat-context-recovery'
import { unitRuntimeId, unitRuntimeObservation } from './helpers/logical-runtime-unit-fixture'
import type { HostRuntimeObservation } from '../core/host-runtime-observer'
import { nonpersistHostFixture } from './helpers/nonpersist-host-fixture'
import { memoryReadyBootstrap } from '../bin/aun/memory-ready'

let tmp: string
let dbPath: string
let db: SqliteAdapter
let actualHosts: Array<Awaited<ReturnType<typeof nonpersistHostFixture>>> = []
let observations: Map<string, HostRuntimeObservation>
let originals: Map<string, SeatContextReceipt>
const inspect = (input: {agentId:string;runtimeInstanceId?:string}) => ({reasonCode:'OBSERVED' as const,
  observations:[...observations.values()].filter(o=>o.agent_id===input.agentId && (!input.runtimeInstanceId || o.runtime_instance_id===input.runtimeInstanceId))})
const readNativeProof = async (input: {agentId:string;project:string;runtimeInstanceId:string}) => {
  const receipt=originals.get(`${input.runtimeInstanceId}:${input.project}`)
  if(!receipt)throw new Error('NATIVE_ORIGINAL_UNAVAILABLE')
  return receipt
}
const evaluateRuntimeMemoryReadyGate = (db:any,input:any)=>evaluateGate(db,{inspect,readNativeProof,...input})
const resolveRuntimeMemoryReadyProject = (db:any,agent:string,input:any={})=>resolveProject(db,agent,{inspect,readNativeProof,...input})


beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'memory-ready-'))
  dbPath = join(tmp, 'test.db')
  migrateSqlite(dbPath)
  db = new SqliteAdapter(dbPath)
  observations = new Map(); originals = new Map()
})

afterEach(async () => {
  for(const host of actualHosts)await host.close()
  actualHosts=[]
  await db.close()
  rmSync(tmp, { recursive: true, force: true })
})

// Unit native adapter owns the original, independently of the persisted AUN proof.
// Real native MCP/pipe provenance is exercised by test_runtime_nonpersist_native.
function receiptFor(agentId: string, runtimeId: string, project = 'agent-comms-mcp') {
  return { schema_version: 'seat-context-consumption/v1', agent_id: agentId, project,
    runtime_instance_id: runtimeId, target_runtime: 'codex', pack_id: `restart_pack:${agentId}:${project}:1789280000000`,
    response_digest: 'a'.repeat(64), work_digest: 'b'.repeat(64), invocation_digest: 'c'.repeat(64), transport_binding_digest: 'd'.repeat(64),
    completed_at: '2026-06-01T00:00:02.000Z', consumption: { runtime_instance_id: runtimeId, invocation_digest: 'c'.repeat(64), consumer: 'unit-original-input' } } as SeatContextReceipt
}
async function seedAnchor(agentId:string,id:string,kind='local_process') {
  await db.execute(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind,runtime_engine,status,started_at,metadata)
    VALUES($1,$2,$3,NULL,NULL,NULL,$4)`,[id,agentId,kind,JSON.stringify({schema_version:'aun-runtime-nonpersistence/v1',source_commit:'a'.repeat(40)})])
}
async function leaseRuntime(runtimeId: string) {
  const row = await db.queryOne<any>('SELECT * FROM agent_runtime_instances WHERE runtime_instance_id=$1', [runtimeId])
  await db.execute(`INSERT OR REPLACE INTO control_plane_leases (lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at,metadata)
    VALUES ($1,'runtime_instance',$2,'worker',$3,$2,1,'active','2026-06-01T00:00:01Z','2099-01-01T00:00:00Z','{}')`,
    [`lease-${runtimeId}`, runtimeId, row.agent_id])
}
async function seedRuntime(agentId = 'agent-com-dev', port = 39100): Promise<void> {
  await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type) VALUES($1,$1,'dev')`,[agentId])
  const id=unitRuntimeId(`runtime-${agentId}`)
  await seedAnchor(agentId,id)
  observations.set(id,unitRuntimeObservation(agentId,{runtime_instance_id:id,port,endpoint_uri:`http://127.0.0.1:${port}`,
    workspace:`/tmp/${agentId}`,observed_at:'2026-06-01T00:00:03Z',process_started_at:'2026-06-01T00:00:00Z'}))
  await leaseRuntime(id)
}

async function recordReady(agentId = 'agent-com-dev', overrides: Record<string, unknown> = {}): Promise<void> {
  const id = String(overrides.runtime_instance_id ?? unitRuntimeId(`runtime-${agentId}`))
  const project = String(overrides.project ?? 'agent-comms-mcp')
  if(!originals.has(`${id}:${project}`))originals.set(`${id}:${project}`,receiptFor(agentId,id,project))
  await recordRuntimeMemoryReadyEvidence(db as any, {
    agent_id: agentId,
    project: 'agent-comms-mcp',
    runtime_instance_id: unitRuntimeId(`runtime-${agentId}`),
    profile_revision: 1,
    profile_source: 'legacy',
    session_name: `${agentId}-session`,
    port: 39100,
    expected_agent_id: agentId,
    checkout_path: `/tmp/${agentId}`,
    checkout_commit_sha: 'a'.repeat(40),
    recovery_command: 'mcp__wasurezu__recover_context',
    result_status: 'ready',
    completed_at: '2026-06-01T00:00:02.000Z',
    evidence_path: `/tmp/${agentId}-memory-ready.json`,
    evidence_log_id: `${agentId}-memory-ready-log`,
    valid_until: '2099-01-01T00:00:00.000Z',
    source: 'agent_memory_boot_recovery',
    metadata: { seat_context_receipt: receiptFor(agentId, String(overrides.runtime_instance_id ?? unitRuntimeId(`runtime-${agentId}`)), String(overrides.project ?? 'agent-comms-mcp')) },
    ...overrides,
  } as any)
}

async function bindPrimaryWorkspace(agentId: string, workspacePath: string, workspaceId: string): Promise<void> {
  await db.execute(
    `INSERT INTO agent_workspaces (workspace_id, name) VALUES ($1, $2)`,
    [workspaceId, workspaceId],
  )
  await db.execute(
    `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
     VALUES ($1, $2, 'primary', 1)`,
    [agentId, workspaceId],
  )
}

function auditedBypassMetadata(agentId = 'agent-com-dev', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor: 'codex-cto',
    reason: 'operator-approved memory-ready queue resume bypass',
    timestamp: '2026-06-01T00:00:02.000Z',
    target_agent: agentId,
    queue_scope: {
      status: 'pending',
      action_kind: 'invoke_codex_runner',
    },
    expires_at: '2026-06-01T00:10:00.000Z',
    ...overrides,
  }
}

describe('runtime memory-ready evidence gate', () => {
  test('requires consumed context for this runtime and a live endpoint lease', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', { metadata: {} })
    const evaluate = () => evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03Z'),
    })
    expect((await evaluate()).reason).toBe('context_consumption_missing')
    await expect(recordReady('agent-com-dev', { metadata: { seat_context_receipt: receiptFor('agent-com-dev', unitRuntimeId('prior-runtime')) } })).rejects.toThrow('MEMORY_LOGICAL_PROOF_BINDING_MISMATCH')
    expect((await evaluate()).reason).toBe('context_consumption_missing')
    await recordReady()
    expect((await evaluate()).ok).toBe(true)
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_agent_id='agent-com-dev'")
    expect((await evaluate()).reason).toBe('no_current_runtime_for_profile')
    expect((await db.queryOne<any>("SELECT channel_port FROM agents WHERE agent_id='agent-com-dev'"))?.channel_port).toBeNull()
  })
  test('native input evidence remains bound to the observed provider process and start', async () => {
    await seedRuntime()
    const native = { agent_id:'agent-com-dev',project:'agent-comms-mcp',pack_ref:`restart_pack:agent-com-dev:agent-comms-mcp:1789280000000`,input_sha256:'c'.repeat(64),work_sha256:'b'.repeat(64),provider_pid: 5678, provider_started_at: '2026-06-01T00:00:00.000Z', target_runtime: 'codex',
      host_session_id: 'session-one', workspace_sha256: createHash('sha256').update('/tmp/agent-com-dev').digest('hex') }
    const observation = { verified: true, source: 'process_ancestry', agent_id: 'agent-com-dev',
      runtime_instance_id: unitRuntimeId('runtime-agent-com-dev'), provider_pid: 5678, provider_started_at: native.provider_started_at,
      provider: 'codex', host_session_id: 'session-one', workspace: '/tmp/agent-com-dev' }
    observations.set(unitRuntimeId('runtime-agent-com-dev'),{...observations.get(unitRuntimeId('runtime-agent-com-dev'))!,...observation})
    await recordReady('agent-com-dev', { metadata: { seat_context_receipt: { ...receiptFor('agent-com-dev', unitRuntimeId('runtime-agent-com-dev')), native_delivery: native, response_digest:seatContextDigest(native) } } })
    originals.set(`${unitRuntimeId('runtime-agent-com-dev')}:agent-comms-mcp`,{...receiptFor('agent-com-dev',unitRuntimeId('runtime-agent-com-dev')),native_delivery:native,response_digest:seatContextDigest(native)} as any)
    const evaluate = () => evaluateRuntimeMemoryReadyGate(db as any, { agent_id: 'agent-com-dev', project: 'agent-comms-mcp', now: new Date('2026-06-01T00:00:03Z') })
    expect((await evaluate()).ok).toBe(true)
    observations.set(unitRuntimeId('runtime-agent-com-dev'),{...observations.get(unitRuntimeId('runtime-agent-com-dev'))!,provider_started_at:'2026-06-01T00:00:01.000Z'})
    expect((await evaluate()).reason).toBe('context_consumption_missing')
  })
  test('ordinary native readiness independently binds the actual MCP UUID and ignores only known other-kind evidence', async () => {
    await seedRuntime()
    const completed=new Date().toISOString()
    const agentId = 'agent-com-dev', runtimeInstanceId = unitRuntimeId('runtime-agent-com-dev')
    const native = { schema_version: 'native-context-delivery/v1', status: 'accepted', agent_id: agentId, project: 'agent-comms-mcp',
      target_runtime: 'codex', host_session_id: 'native-session', provider_pid: 5678, provider_started_at: '2026-06-01T00:00:00.000Z',
      provider_executable_sha256: 'a'.repeat(64), workspace_sha256: createHash('sha256').update('/tmp/agent-com-dev').digest('hex'),
      pipe_sha256: 'b'.repeat(64), input_sha256: 'c'.repeat(64), work_sha256: 'b'.repeat(64),
      pack_ref: `restart_pack:${agentId}:agent-comms-mcp:1789280000000`, delivered_at: completed,
      attempt_id: 'native-attempt', attempt_started_at: '2026-06-01T00:00:01.000Z' }
    const receipt = { ...receiptFor(agentId, runtimeInstanceId), completed_at:completed, native_delivery: native, response_digest: seatContextDigest(native) } as SeatContextReceipt
    const observation = { schema_version: 'seat-provider-observation/v1', agent_id: agentId, runtime_instance_id: runtimeInstanceId,
      host_id: hostname(), process_id: 1234, provider_pid: 5678, provider_started_at: native.provider_started_at,
      host_session_id: native.host_session_id, provider: 'codex', session_name: `${agentId}-session`, workspace: `/tmp/${agentId}`,
      observed_at: completed, source: 'process_ancestry', verified: true } as const
    observations.set(runtimeInstanceId,{...observations.get(runtimeInstanceId)!,...observation})
    originals.set(`${runtimeInstanceId}:agent-comms-mcp`,receipt)
    const args = {agentId,project:'agent-comms-mcp',runtimeInstanceId,receipt,now:new Date(),observeProvider:()=>observation,inspect,readNativeProof}
    await expect(recordVerifiedNativeRuntimeMemoryReady(db as any, {...args, receipt:{...receipt,runtime_instance_id:unitRuntimeId('sealed-runtime')}})).rejects.toThrow('MEMORY_NATIVE_RUNTIME_RECEIPT_MISMATCH')
    await expect(recordVerifiedNativeRuntimeMemoryReady(db as any, {...args, observeProvider:()=>({...observation,provider_started_at:'2026-06-01T00:00:01.000Z'})})).rejects.toThrow('MEMORY_NATIVE_CURRENT_PROVIDER_MISMATCH')
    expect((await db.queryOne<any>('SELECT COUNT(*) AS total FROM runtime_memory_ready_evidence'))?.total).toBe(0)
    await recordVerifiedNativeRuntimeMemoryReady(db as any,args)
    await seedAnchor(agentId,unitRuntimeId('sealed-runtime'),'bootstrap_bound_provider')
    await recordReady(agentId,{runtime_instance_id:unitRuntimeId('sealed-runtime'),completed_at:'2026-06-01T00:00:02.500Z'})
    const ordinary = await evaluateRuntimeMemoryReadyGate(db as any,{agent_id:agentId,project:args.project,now:args.now})
    expect(ordinary.ok).toBe(true)
    expect(ordinary.current_runtime?.runtime_instance_id).toBe(runtimeInstanceId)
    await expect(resolveRuntimeMemoryReadyProject(db as any,agentId,{now:args.now})).resolves.toMatchObject({project:args.project,source:'verified_current_runtime_receipt'})
    const foreignNative = {...native,agent_id:'foreign-seat'}
    const foreignReceipt = {...receipt,project:'foreign-project',pack_id:`restart_pack:${agentId}:foreign-project:1789280000000`,native_delivery:foreignNative,response_digest:seatContextDigest(foreignNative)} as SeatContextReceipt
    await recordReady(agentId,{project:'foreign-project',completed_at:completed,metadata:{seat_context_receipt:foreignReceipt}})
    originals.set(`${runtimeInstanceId}:foreign-project`,foreignReceipt)
    await expect(resolveRuntimeMemoryReadyProject(db as any,agentId,{now:args.now})).resolves.toMatchObject({project:args.project})
    const secondNative={...native,project:'second-project',pack_ref:`restart_pack:${agentId}:second-project:1789280000000`}
    const secondReceipt={...receipt,project:'second-project',pack_id:`restart_pack:${agentId}:second-project:1789280000000`,native_delivery:secondNative,response_digest:seatContextDigest(secondNative)} as SeatContextReceipt
    await recordReady(agentId,{project:'second-project',completed_at:completed,metadata:{seat_context_receipt:secondReceipt}})
    originals.set(`${runtimeInstanceId}:second-project`,secondReceipt)
    await expect(resolveRuntimeMemoryReadyProject(db as any,agentId,{now:args.now})).rejects.toMatchObject({code:'PROJECT_AMBIGUOUS'})

    observations.set(runtimeInstanceId,{...observations.get(runtimeInstanceId)!,provider_pid:9999})
    expect((await evaluateRuntimeMemoryReadyGate(db as any,{agent_id:agentId,project:args.project,now:args.now})).ok).toBe(false)
  })
  test('explicit logical project resolution admits only current exact-runtime evidence', async () => {
    const workspace = join(tmp, 'codex')
    mkdirSync(workspace)
    await seedRuntime('codex-cto', 39130)
    await bindPrimaryWorkspace('codex-cto', workspace, 'workspace-codex')
    await db.execute('UPDATE agents SET metadata=$1 WHERE agent_id=$2',[JSON.stringify({memory_project:'codex'}),'codex-cto'])
    await recordReady('codex-cto', {
      project: 'agent-comms-mcp',
      port: 39130,
      valid_until: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('codex-cto', {
      project: 'codex',
      port: 39130,
      valid_until: '2099-01-01T00:00:00.000Z',
    })

    const resolution = await resolveRuntimeMemoryReadyProject(db as any, 'codex-cto')
    expect(resolution).toEqual({
      agent_id: 'codex-cto',
      project: 'codex',
      workspace_path: null,
      source: 'agent_metadata_override',
    })
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'codex-cto',
      project: resolution.project,
      now: new Date('2026-06-01T00:00:03.000Z'),
    })
    expect(gate.ok).toBe(true)
    expect(gate.project).toBe('codex')
    expect(gate.reason).toBe('ready')
  })

  test('missing logical project never derives a namespace from relative, absent, canonical or multiple workspace paths', async () => {
    for (const [agentId,path] of [['relative-workspace','relative/project'],['absent-workspace',join(tmp,'absent-project')],['canonical-workspace','/tmp/canonical-project']]) {
      await seedRuntime(agentId)
      await bindPrimaryWorkspace(agentId,path,`binding-${agentId}`)
      await expect(resolveRuntimeMemoryReadyProject(db as any,agentId)).rejects.toMatchObject({code:'PROJECT_MISSING'})
    }
    await seedRuntime('ambiguous-workspace')
    await bindPrimaryWorkspace('ambiguous-workspace','/tmp/one','binding-one')
    await bindPrimaryWorkspace('ambiguous-workspace','/tmp/two','binding-two')
    await expect(resolveRuntimeMemoryReadyProject(db as any,'ambiguous-workspace')).rejects.toMatchObject({code:'PROJECT_MISSING'})
    await db.execute('UPDATE agents SET metadata=$1 WHERE agent_id=$2',[JSON.stringify({memory_project:{foreign:'project'}}),'ambiguous-workspace'])
    await expect(resolveRuntimeMemoryReadyProject(db as any,'ambiguous-workspace')).rejects.toMatchObject({code:'PROJECT_INVALID'})
    await db.execute('UPDATE agents SET profile_enabled=0 WHERE agent_id=$1',['ambiguous-workspace'])
    await expect(resolveRuntimeMemoryReadyProject(db as any,'ambiguous-workspace')).rejects.toMatchObject({code:'AGENT_NOT_ENABLED'})
  })

  test('explicit per-agent memory project override is deterministic without a workspace fallback', async () => {
    await seedRuntime('project-override', 39135)
    await db.execute(
      `UPDATE agents SET home_directory=NULL, metadata=$1 WHERE agent_id='project-override'`,
      [JSON.stringify({ memory_project: 'iyasaka-arc' })],
    )
    await expect(resolveRuntimeMemoryReadyProject(db as any, 'project-override')).resolves.toEqual({
      agent_id: 'project-override',
      project: 'iyasaka-arc',
      workspace_path: null,
      source: 'agent_metadata_override',
    })
  })

  test('logical project remains stable across host-local path replacement without rewriting the project', async () => {
    await seedRuntime('relocated-seat')
    await db.execute('UPDATE agents SET metadata=$1 WHERE agent_id=$2',[JSON.stringify({memory_project:'product-fixture'}),'relocated-seat'])
    for (const path of ['/old-host/original-name','/new-host/different-basename']) {
      observations.set(unitRuntimeId('runtime-relocated-seat'),{...observations.get(unitRuntimeId('runtime-relocated-seat'))!,workspace:path})
      await expect(resolveRuntimeMemoryReadyProject(db as any,'relocated-seat')).resolves.toMatchObject({project:'product-fixture',source:'agent_metadata_override'})
    }
  })

  test('valid current-runtime-bound evidence passes', async () => {
    await seedRuntime()
    await recordReady()

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('ready')
    expect(gate.runtime_instance_id).toBe(unitRuntimeId('runtime-agent-com-dev'))
    expect(gate.evidence_path).toBeNull()
  })

  test('gate follows current logical authority rather than evidence-bound precedence', async () => {
    await seedRuntime('aun',8811)
    const canonical=unitRuntimeId('runtime-aun'), competing=unitRuntimeId('runtime-aun-competing')
    await seedAnchor('aun',competing)
    observations.set(competing,{...observations.get(canonical)!,runtime_instance_id:competing,port:8812,endpoint_uri:'http://127.0.0.1:8812'})
    await leaseRuntime(competing)
    await recordReady('aun',{project:'codex-aun'})
    const evaluate=()=>evaluateRuntimeMemoryReadyGate(db,{agent_id:'aun',project:'codex-aun',now:new Date('2026-06-01T00:00:06Z')})
    expect((await evaluate()).ok).toBe(false)
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id=$1",[canonical])
    const competingCurrent=await evaluate()
    expect(competingCurrent.ok).toBe(false)
    expect(competingCurrent.reason).toBe('runtime_instance_mismatch')
    expect(competingCurrent.runtime_instance_id).toBe(competing)
    expect(competingCurrent.evidence_id).not.toBeNull()
    await db.execute("UPDATE control_plane_leases SET status='released' WHERE holder_runtime_instance_id=$1",[competing])
    await leaseRuntime(canonical)
    const canonicalCurrent=await evaluate()
    expect(canonicalCurrent.ok).toBe(true)
    expect(canonicalCurrent.runtime_instance_id).toBe(canonical)
    expect(canonicalCurrent.evidence_id).toBe(competingCurrent.evidence_id)
  })

  test('latest exact-project evidence never falls back when its runtime is inactive', async () => {
    await seedRuntime('no-fallback', 39140)
    await recordReady('no-fallback', {
      completed_at: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('no-fallback', {
      runtime_instance_id: unitRuntimeId('runtime-no-fallback-stopped'),
      completed_at: '2026-06-01T00:00:04.000Z',
    })
    await seedAnchor('no-fallback',unitRuntimeId('runtime-no-fallback-stopped'))

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'no-fallback',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:05.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('runtime_instance_mismatch')
    expect(gate.evidence_id).not.toBeNull()
    expect(gate.details.evidence_runtime_instance_id).toBe(unitRuntimeId('runtime-no-fallback-stopped'))
  })

  test('equal evidence timestamps select the highest id without runtime fallback', async () => {
    await seedRuntime('evidence-order', 39141)
    await recordReady('evidence-order', {
      completed_at: '2026-06-01T00:00:02.000Z',
    })
    await recordReady('evidence-order', {
      runtime_instance_id: unitRuntimeId('runtime-evidence-order-missing'),
      completed_at: '2026-06-01T00:00:02.000Z',
    })

    const latest = await db.queryOne<{ id: number }>(
      `SELECT id FROM runtime_memory_ready_evidence
        WHERE agent_id='evidence-order' AND project='agent-comms-mcp'
        ORDER BY completed_at DESC, id DESC LIMIT 1`,
    )
    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'evidence-order',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('runtime_instance_mismatch')
    expect(Number(gate.evidence_id)).toBe(Number(latest?.id))
    expect(gate.details.evidence_runtime_instance_id).toBe(unitRuntimeId('runtime-evidence-order-missing'))
  })

  const profileMismatchCases = [
    {
      label: 'session',
      agentId: 'profile-session-mismatch',
      update: `session_name=unitRuntimeId('runtime-only-session')`,
      evidence: { session_name: unitRuntimeId('runtime-only-session') },
      reason: 'session_mismatch',
      details: {
        profile_session_name: 'profile-session-mismatch-session',
        runtime_session_name: unitRuntimeId('runtime-only-session'),
      },
    },
    {
      label: 'port',
      agentId: 'profile-port-mismatch',
      update: 'port=39152',
      evidence: { port: 39152 },
      reason: 'port_mismatch',
      details: {
        profile_port: 39142,
        runtime_port: 39152,
      },
    },
    {
      label: 'checkout',
      agentId: 'profile-checkout-mismatch',
      update: `checkout_path='/tmp/runtime-only-checkout'`,
      evidence: { checkout_path: '/tmp/runtime-only-checkout' },
      reason: 'checkout_path_mismatch',
      details: {
        profile_checkout_path: '/tmp/profile-checkout-mismatch',
        runtime_checkout_path: '/tmp/runtime-only-checkout',
      },
    },
  ] as const

  for (const profileMismatch of profileMismatchCases) {
    test(`current receipt and lease permit observed ${profileMismatch.label} replacement without profile edits`, async () => {
      await seedRuntime(profileMismatch.agentId, 39142)
      const id=unitRuntimeId(`runtime-${profileMismatch.agentId}`)
      const change = profileMismatch.label==='session' ? {session_name:'runtime-only-session'}
        : profileMismatch.label==='port' ? {port:39152,endpoint_uri:'http://127.0.0.1:39152'} : {workspace:'/tmp/runtime-only-checkout'}
      observations.set(id,{...observations.get(id)!,...change})
      await recordReady(profileMismatch.agentId, { port: 39142, ...profileMismatch.evidence })

      const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
        agent_id: profileMismatch.agentId,
        project: 'agent-comms-mcp',
        now: new Date('2026-06-01T00:00:03.000Z'),
      })

      expect(gate.ok).toBe(true)
      const profile = await db.queryOne<any>('SELECT channel_port,home_directory,metadata FROM agents WHERE agent_id=$1', [profileMismatch.agentId])
      expect(profile.channel_port).toBeNull()
      expect(profile.home_directory).toBeNull()
      expect(JSON.parse(profile.metadata).tmux_session).toBeUndefined()

    })
  }

  test('legacy provider preference mismatch does not override current recovery and lease', async () => {
    const agentId = 'profile-runtime-engine-mismatch'
    await seedRuntime(agentId, 39142)
    observations.set(unitRuntimeId(`runtime-${agentId}`),{...observations.get(unitRuntimeId(`runtime-${agentId}`))!,provider:'claude-code'})
    await recordReady(agentId, { port: 39142 })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: agentId,
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('ready')
  })

  test('missing, stale, and mismatched evidence fail closed', async () => {
    await seedRuntime()
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('missing_evidence')

    await recordReady('agent-com-dev', { valid_until: '2026-06-01T00:00:02.000Z' })
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('expired')

    await db.execute(`DELETE FROM runtime_memory_ready_evidence`)
    await recordReady('agent-com-dev', { runtime_instance_id: unitRuntimeId('runtime-other') })
    expect((await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })).reason).toBe('runtime_instance_mismatch')
  })

  test('bypassed evidence without audited metadata fails closed', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: {},
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('bypass_metadata_missing')
    const missing = gate.details.missing as string[]
    expect(missing).toContain('actor')
    expect(missing).toContain('queue_scope')
  })

  test('bypassed evidence passes only with bounded audited metadata', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: auditedBypassMetadata(),
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(true)
    expect(gate.reason).toBe('bypassed')
  })

  test('bypassed evidence with mismatched queue scope fails closed', async () => {
    await seedRuntime()
    await recordReady('agent-com-dev', {
      result_status: 'bypassed',
      source: 'explicit_operator_bypass',
      metadata: auditedBypassMetadata('agent-com-dev', {
        queue_scope: {
          status: 'received',
          action_kind: 'wake_received',
        },
      }),
    })

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'agent-com-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
      queue_scope: {
        status: 'pending',
        action_kind: 'invoke_codex_runner',
      },
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('bypass_scope_mismatch')
  })

  test('wrong identity on occupied expected port fails readiness', async () => {
    await db.execute(`INSERT INTO agents(agent_id,display_name,agent_type) VALUES('target-dev','target','dev')`)
    await seedRuntime('other-dev',39110)

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'target-dev',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:03.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('no_current_runtime_for_profile')
    expect(gate.current_runtime).toBeNull()
  })

  test('newer same-agent B5 runtime cannot shadow an older wrong-agent port occupant', async () => {
    await seedRuntime('port-shadow-target', 39111)
    const b5=unitRuntimeId('runtime-port-shadow-target'), ordinary=unitRuntimeId('runtime-port-shadow-same-agent')
    await db.execute("UPDATE agent_runtime_instances SET runtime_kind='bootstrap_bound_provider' WHERE runtime_instance_id=$1",[b5])
    await seedRuntime('port-shadow-other',39111)
    await seedAnchor('port-shadow-target',ordinary)
    observations.set(ordinary,{...observations.get(b5)!,runtime_instance_id:ordinary,port:39112,endpoint_uri:'http://127.0.0.1:39112'})
    observations.delete(b5)
    await leaseRuntime(ordinary)
    await recordReady('port-shadow-target',{runtime_instance_id:b5,port:39111})

    const gate = await evaluateRuntimeMemoryReadyGate(db as any, {
      agent_id: 'port-shadow-target',
      project: 'agent-comms-mcp',
      now: new Date('2026-06-01T00:00:11.000Z'),
    })

    expect(gate.ok).toBe(false)
    expect(gate.reason).toBe('missing_evidence')
    expect(gate.evidence_id).toBeNull()
  })

  test('Wasurezu bootstrap evidence is queue-independent metadata', () => {
    const evidence = buildWasurezuBootstrapEvidence({
      agent_id: 'wasurezu',
      project: 'agent-comms-mcp',
      runtime_instance_id: unitRuntimeId('runtime-wasurezu'),
      session_name: 'wasurezu-session',
      port: 39120,
      completed_at: '2026-06-01T00:00:00.000Z',
    })

    expect(evidence.source).toBe('wasurezu_boot_recovery')
    expect(evidence.metadata).toMatchObject({
      bootstrap_without_aun_queue: true,
      live_discord_send: false,
      launchagent_mutation: false,
    })
  })

  test('SQLite dry-run never creates a missing database or journal', async () => {
    const path = join(tmp, 'absent.db')
    const before = readdirSync(tmp).sort()
    expect(existsSync(path)).toBe(false)
    const result = await memoryReadyBootstrap({agentId:'wasurezu',dryRun:true,
      env:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:path}})
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ok:false,mutation_performed:false})
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(tmp).sort()).toEqual(before)
  })

  test('SQLite dry-run refuses WAL before touching existing database or shared-memory bytes', async () => {
    await seedRuntime('wasurezu', 39120)
    const snapshot = () => Object.fromEntries(readdirSync(tmp).sort().map(name => {
      const path=join(tmp,name), stat=statSync(path)
      return [name,{size:stat.size,mtime:stat.mtimeMs,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}]
    }))
    const before=snapshot()
    const result=await memoryReadyBootstrap({agentId:'wasurezu',project:'agent-comms-mcp',dryRun:true,
      env:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:dbPath,PATH:'/unavailable-native-tools'}})
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ok:false,mutation_performed:false,reason:'MEMORY_SQLITE_DRY_RUN_WAL_OR_JOURNAL_UNSUPPORTED'})
    expect(snapshot()).toEqual(before)
    expect((await db.queryOne<any>('SELECT COUNT(*) AS n FROM runtime_memory_ready_evidence'))?.n).toBe(0)
    const closedPath=join(tmp,'wal-header-without-sidecars.db')
    copyFileSync(dbPath,closedPath)
    const checkpointed=snapshot()
    expect(readFileSync(closedPath)[18]).toBe(2)
    expect(existsSync(closedPath+'-wal')).toBe(false)
    expect(existsSync(closedPath+'-shm')).toBe(false)
    const closed=await memoryReadyBootstrap({agentId:'wasurezu',dryRun:true,env:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:closedPath}})
    expect(JSON.parse(closed.stdout).reason).toBe('MEMORY_SQLITE_DRY_RUN_WAL_OR_JOURNAL_UNSUPPORTED')
    expect(snapshot()).toEqual(checkpointed)
  })

  test('SQLite dry-run reads a clean rollback-journal database without file or journal changes', async () => {
    await seedRuntime('wasurezu',39120)
    const host=await nonpersistHostFixture(unitRuntimeId('runtime-wasurezu'),'wasurezu');actualHosts.push(host)
    await db.execute("UPDATE control_plane_leases SET acquired_at=clock_timestamp()")
    const cleanPath=join(tmp,'clean.db')
    await db.execute('VACUUM INTO $1',[cleanPath])
    expect(readFileSync(cleanPath)[18]).toBe(1)
    const snapshot=()=>Object.fromEntries(readdirSync(tmp).sort().map(name=>[name,createHash('sha256').update(readFileSync(join(tmp,name))).digest('hex')]))
    const before=snapshot()
    const result=await memoryReadyBootstrap({agentId:'wasurezu',project:'agent-comms-mcp',dryRun:true,
      env:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:cleanPath,PATH:'/unavailable-native-tools'}})
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ok:true,dry_run:true,mutation_performed:false,native_receipt_checked:false,readiness_recorded:false})
    expect(snapshot()).toEqual(before)
    writeFileSync(cleanPath+'-journal','pending-journal')
    const journalBefore=snapshot()
    const journalResult=await memoryReadyBootstrap({agentId:'wasurezu',dryRun:true,env:{AGENT_COM_DB:'sqlite',AGENT_COM_SQLITE_PATH:cleanPath}})
    expect(JSON.parse(journalResult.stdout)).toMatchObject({ok:false,mutation_performed:false,reason:'MEMORY_SQLITE_DRY_RUN_WAL_OR_JOURNAL_UNSUPPORTED'})
    expect(snapshot()).toEqual(journalBefore)
  })

  test('transport-free bootstrap cannot claim context consumption', async () => {
    await seedRuntime('wasurezu', 39120)
    const result = await memoryReadyBootstrap({
      agentId: 'wasurezu',
      project: 'agent-comms-mcp',
      runtimeInstanceId: unitRuntimeId('runtime-wasurezu'),
      sessionName: 'wasurezu-session',
      port: '39120',
      checkoutPath: '/tmp/wasurezu',
      checkoutCommitSha: 'head-sha',
      evidencePath: '/tmp/wasurezu-bootstrap-memory-ready.json',
      evidenceLogId: 'wasurezu-bootstrap-memory-ready-log',
      env: {
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: dbPath,
        AGENT_ID: 'wasurezu',
        AGENT_COM_EXPECTED_AGENT_ID: 'wasurezu',
      },
    })

    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ok:false,mode:'memory-ready-bootstrap',mutation_performed:false})
    expect((await db.queryOne<any>('SELECT COUNT(*) AS n FROM runtime_memory_ready_evidence'))?.n).toBe(0)

  })
})
