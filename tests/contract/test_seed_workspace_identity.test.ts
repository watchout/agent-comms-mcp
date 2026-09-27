import * as hostObserver from '../../core/host-runtime-observer'
import {unitRuntimeObservation,unitRuntimeId} from '../helpers/logical-runtime-unit-fixture'
/**
 * ADR-029R PR 5 — seed-workspace-identity tool contract.
 *
 * The seeded state must satisfy the Phase 1 resolver end-to-end: after
 * --execute, resolveAgentIdentity() on the seeded workspace succeeds; the
 * tool is dry-run by default, idempotent, and never creates agents.
 */
import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as PgClient } from 'pg'
import { resolveAgentIdentity } from '../../core/identity-resolver'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const PREFIX = `sd-test-seedws-${process.pid}`
const AGENT = `${PREFIX}-bot`

let pg: PgClient
let workspaceDir: string
function declaredId(dir:string){try{return JSON.parse(readFileSync(join(dir,'.agent','identity.json'),'utf8')).workspace_id}catch{return 'absent'}}

function runSeed(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('bun', ['scripts/seed-workspace-identity.ts', ...args], {
    cwd: `${import.meta.dir}/../..`,
    encoding: 'utf-8',
    env: { ...process.env, DATABASE_URL },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

let observationSpy:ReturnType<typeof spyOn>
afterAll(()=>observationSpy?.mockRestore())
beforeAll(async () => {
  pg = new PgClient({ connectionString: DATABASE_URL })
  await pg.connect()
  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'seedws-')))
  observationSpy=spyOn(hostObserver,'inspectHostRuntime').mockImplementation(input=>({reasonCode:'OBSERVED',
    observations:[unitRuntimeObservation(input.agentId,{workspace:workspaceDir})]}))
  await pg.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type)
     VALUES ($1, 'default', $1, 'dev') ON CONFLICT (agent_id) DO NOTHING`,
    [AGENT],
  )
  await pg.query(`INSERT INTO agent_runtime_instances(runtime_instance_id,agent_id,runtime_kind) VALUES($1,$2,'local_process')`,[unitRuntimeId(AGENT),AGENT])
  await pg.query(`INSERT INTO control_plane_leases(lease_id,lease_scope_type,lease_scope_id,lease_purpose,holder_agent_id,holder_runtime_instance_id,fencing_token,status,acquired_at,expires_at)
    VALUES($1::uuid,'runtime_instance',$1::text,'worker',$2,$1::uuid,1,'active',clock_timestamp(),clock_timestamp()+interval '1 hour')`,[unitRuntimeId(AGENT),AGENT])

})

afterAll(async () => {
  const ownWorkspaces=await pg.query('SELECT workspace_id FROM agent_workspace_bindings WHERE agent_id LIKE $1',[`${PREFIX}%`])
  await pg.query(`DELETE FROM agent_workspace_bindings WHERE agent_id LIKE $1`, [`${PREFIX}%`])
  await pg.query('DELETE FROM agent_workspaces WHERE workspace_id=ANY($1::text[])',[ownWorkspaces.rows.map(r=>r.workspace_id)])
  await pg.query('DELETE FROM control_plane_leases WHERE holder_agent_id=$1',[AGENT])
  await pg.query('DELETE FROM agent_runtime_instances WHERE agent_id=$1',[AGENT])
  await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
  await pg.end()
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('seed-workspace-identity', () => {
  test('dry-run by default: reports the plan, writes nothing', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--project', 'seed-test'])
    expect(r.status).toBe(0)
    const plan = JSON.parse(r.stdout)
    expect(plan.dry_run).toBe(true)

    expect(existsSync(join(workspaceDir, '.agent', 'identity.json'))).toBe(false)
    const ws = await pg.query(`SELECT 1 FROM agent_workspaces WHERE workspace_id = $1`, [declaredId(workspaceDir)])
    expect(ws.rows.length).toBe(0)
  })

  test('refuses unknown agents (never creates them)', () => {
    const r = runSeed(['--agent-id', `${PREFIX}-ghost`, '--workspace', workspaceDir, '--execute'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not present in agents')
  })

  test('--execute seeds rows + declaration, and the Phase 1 resolver then succeeds end-to-end', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--project', 'seed-test', '--execute'])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result.seeded).toBe(true)

    expect(existsSync(join(workspaceDir, '.agent', 'identity.json'))).toBe(true)

    const db = {
      query: async (sql: string, params?: unknown[]) => {
        const res = await pg.query(sql, params as any[])
        return { rows: res.rows }
      },
    }
    const resolved = await resolveAgentIdentity(db, { cwd: workspaceDir, env: {}, mode: 'fleet' })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.agent_id).toBe(AGENT)
      expect(resolved.project).toBe('seed-test')
      expect(resolved.source).toBe('workspace_declaration')
    }
  })

  test('idempotent: re-running --execute succeeds and keeps the binding active', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--execute'])
    expect(r.status).toBe(0)
    const binding = await pg.query(
      `SELECT active FROM agent_workspace_bindings b
        JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
       WHERE b.agent_id = $1 AND w.workspace_id = $2`,
      [AGENT, declaredId(workspaceDir)],
    )
    expect(binding.rows.length).toBe(1)
    expect(binding.rows[0].active).toBe(true)
  })
})

describe('ARC preflight conditions (PR #738 review)', () => {
  test('1. existing agent_workspaces(org_id, workspace_id) row is REUSED, never duplicated', async () => {
    // The workspace was already seeded above with a generated workspace_id.
    const before = await pg.query(`SELECT workspace_id FROM agent_workspaces WHERE workspace_id = $1`, [declaredId(workspaceDir)])
    expect(before.rows.length).toBe(1)
    const existingId = before.rows[0].workspace_id

    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--execute'])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result.workspace_id).toBe(existingId)
    expect(result.workspace_reused).toBe(true)

    const after = await pg.query(`SELECT workspace_id FROM agent_workspaces WHERE workspace_id = $1`, [declaredId(workspaceDir)])
    expect(after.rows.length).toBe(1)
  })

  test('2. ACTIVE binding held by another agent → fail closed (BINDING_CONFLICT)', async () => {
    // A fresh workspace with no identity.json, bound ACTIVE to AGENT in DB,
    // then seeded as another agent — must fail on the binding, not the file.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seedws-bind-')))
    const otherAgent = `${PREFIX}-other`
    try {
      await pg.query(
        `INSERT INTO agents (agent_id, org_id, display_name, agent_type)
         VALUES ($1, 'default', $1, 'dev') ON CONFLICT (agent_id) DO NOTHING`,
        [otherAgent],
      )
      const seedFirst = runSeed(['--agent-id', AGENT, '--workspace', dir, '--execute'])
      expect(seedFirst.status).toBe(0)
      // Remove the declaration so only the DB binding can conflict.
      const workspaceId=declaredId(dir)
      rmSync(join(dir, '.agent'), { recursive: true, force: true })

      const r = runSeed(['--agent-id', otherAgent, '--workspace', dir, '--workspace-id',workspaceId, '--execute'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('BINDING_CONFLICT')
    } finally {
      await pg.query(
        `DELETE FROM agent_workspace_bindings WHERE workspace_id IN (SELECT workspace_id FROM agent_workspaces WHERE workspace_id = $1)`,
        [declaredId(dir)],
      )
      await pg.query(`DELETE FROM agent_workspaces WHERE workspace_id = $1`, [declaredId(dir)])
      await pg.query(`DELETE FROM agents WHERE agent_id = $1`, [otherAgent])
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('3. identity.json declaring a different agent_id → fail closed, no DB writes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'seedws-conflict-')))
    try {
      await Bun.write(join(dir, '.agent', 'identity.json'), JSON.stringify({ agent_id: `${PREFIX}-previous-owner` }))

      const r = runSeed(['--agent-id', AGENT, '--workspace', dir, '--execute'])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('IDENTITY_DECLARATION_CONFLICT')

      const ws = await pg.query(`SELECT 1 FROM agent_workspaces WHERE workspace_id = $1`, [declaredId(dir)])
      expect(ws.rows.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('4. existing MATCHING identity.json is idempotent (re-seed succeeds, declaration intact)', async () => {
    const r = runSeed(['--agent-id', AGENT, '--workspace', workspaceDir, '--project', 'seed-test', '--execute'])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout)
    expect(result.seeded).toBe(true)
    const declared = JSON.parse(await Bun.file(join(workspaceDir, '.agent', 'identity.json')).text())
    expect(declared.agent_id).toBe(AGENT)
  })
})


test('explicit workspace ID in another org is rejected before binding or declaration', async () => {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'seedws-org-'))),id=`${PREFIX}-foreign`
  try {
    await pg.query("INSERT INTO agent_workspaces(workspace_id,org_id,name,workspace_type) VALUES($1,'foreign-fixture','Foreign','project')",[id])
    const result=runSeed(['--agent-id',AGENT,'--workspace',dir,'--workspace-id',id,'--execute'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WORKSPACE_ORG_CONFLICT')
    expect((await pg.query('SELECT 1 FROM agent_workspace_bindings WHERE workspace_id=$1',[id])).rows).toEqual([])
    expect(existsSync(join(dir,'.agent/identity.json'))).toBe(false)
  } finally {await pg.query('DELETE FROM agent_workspaces WHERE workspace_id=$1',[id]);rmSync(dir,{recursive:true,force:true})}
})
