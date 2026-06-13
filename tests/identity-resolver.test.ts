/**
 * ADR-029R §5 Phase 1 identity resolver — the five fail-closed negative
 * cases (binding for the spike chain per ARC review condition 3) plus the
 * positive paths. Runs against real Postgres with sd-test- isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client as PgClient } from 'pg'
import { resolveAgentIdentity, type IdentityDb } from '../core/identity-resolver'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const PREFIX = `sd-test-idres-${process.pid}`
const AGENT = `${PREFIX}-bot`
const WORKSPACE_ID = `${PREFIX}-ws`

let pg: PgClient
let db: IdentityDb
let workspaceDir: string

function declareIdentity(dir: string, agentId: string): void {
  mkdirSync(join(dir, '.agent'), { recursive: true })
  writeFileSync(join(dir, '.agent', 'identity.json'), JSON.stringify({ agent_id: agentId, project: 'idres-test' }))
}

beforeAll(async () => {
  pg = new PgClient({ connectionString: DATABASE_URL })
  await pg.connect()
  db = {
    query: async (sql, params) => {
      const r = await pg.query(sql, params as any[])
      return { rows: r.rows }
    },
  }

  workspaceDir = realpathSync(mkdtempSync(join(tmpdir(), 'idres-ws-')))

  await pg.query(
    `INSERT INTO agents (agent_id, org_id, display_name, agent_type, runtime, status)
     VALUES ($1, 'default', $1, 'dev', 'TUI', 'idle') ON CONFLICT (agent_id) DO NOTHING`,
    [AGENT],
  )
  await pg.query(
    `INSERT INTO agent_workspaces (workspace_id, org_id, name, workspace_type, local_path)
     VALUES ($1, 'default', $1, 'local_path', $2)
     ON CONFLICT (workspace_id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [WORKSPACE_ID, workspaceDir],
  )
  await pg.query(
    `INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
     VALUES ($1, $2, 'primary', true)
     ON CONFLICT (agent_id, workspace_id, binding_role) DO UPDATE SET active = true`,
    [AGENT, WORKSPACE_ID],
  )
})

afterAll(async () => {
  await pg.query(`DELETE FROM agent_workspace_bindings WHERE workspace_id = $1`, [WORKSPACE_ID])
  await pg.query(`DELETE FROM agent_workspaces WHERE workspace_id = $1`, [WORKSPACE_ID])
  await pg.query(`DELETE FROM agents WHERE agent_id LIKE $1`, [`${PREFIX}%`])
  await pg.end()
  rmSync(workspaceDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await pg.query(
    `UPDATE agent_workspace_bindings SET active = true WHERE agent_id = $1 AND workspace_id = $2`,
    [AGENT, WORKSPACE_ID],
  )
})

describe('positive paths', () => {
  test('workspace declaration resolves and passes the binding cross-check', async () => {
    declareIdentity(workspaceDir, AGENT)
    const result = await resolveAgentIdentity(db, { cwd: workspaceDir, env: {}, mode: 'fleet' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.agent_id).toBe(AGENT)
      expect(result.source).toBe('workspace_declaration')
      expect(result.workspace_id).toBe(WORKSPACE_ID)
      expect(result.project).toBe('idres-test')
    }
  })

  test('operator override with BOTH markers is accepted and audit-callback fires', async () => {
    let audited: any = null
    const result = await resolveAgentIdentity(db, {
      cwd: workspaceDir,
      env: {
        AGENT_ID: AGENT,
        AGENT_ID_OVERRIDE_REASON: 'incident recovery test',
        AGENT_ID_OVERRIDE_ACTOR: 'yuji',
      },
      mode: 'fleet',
      onOverrideAccepted: (info) => {
        audited = info
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source).toBe('operator_override')
      expect(result.override_reason).toBe('incident recovery test')
      expect(result.override_actor).toBe('yuji')
    }
    expect(audited).toMatchObject({ agent_id: AGENT, reason: 'incident recovery test', actor: 'yuji' })
  })
})

describe('ADR-029R §5 — the five fail-closed negative cases', () => {
  test('1. missing identity.json and no valid override → FAIL no_identity', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'idres-bare-')))
    try {
      const result = await resolveAgentIdentity(db, { cwd: bare, env: {}, mode: 'fleet' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('no_identity')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  test('2. declared agent_id not present in agents → FAIL agent_not_registered', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'idres-ghost-')))
    try {
      declareIdentity(dir, `${PREFIX}-ghost`)
      const result = await resolveAgentIdentity(db, { cwd: dir, env: {}, mode: 'fleet' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('agent_not_registered')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('3. no active binding for (agent_id, workspace_id) → FAIL no_active_binding', async () => {
    declareIdentity(workspaceDir, AGENT)
    await pg.query(
      `UPDATE agent_workspace_bindings SET active = false WHERE agent_id = $1 AND workspace_id = $2`,
      [AGENT, WORKSPACE_ID],
    )
    const result = await resolveAgentIdentity(db, { cwd: workspaceDir, env: {}, mode: 'fleet' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('no_active_binding')
  })

  test('4. copied workspace: identity.json present but realpath not registered → FAIL workspace_not_registered', async () => {
    const copy = realpathSync(mkdtempSync(join(tmpdir(), 'idres-copy-')))
    try {
      // Same declaration as the bound workspace, different physical path.
      declareIdentity(copy, AGENT)
      const result = await resolveAgentIdentity(db, { cwd: copy, env: {}, mode: 'fleet' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('workspace_not_registered')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  test('5. env AGENT_ID without override markers (global-config inheritance class) → FAIL env_override_without_marker', async () => {
    declareIdentity(workspaceDir, AGENT)
    const result = await resolveAgentIdentity(db, {
      cwd: workspaceDir,
      // The 2026-06-12 incident shape: inherited AGENT_ID, no markers — even
      // though the value itself would verify, fleet mode must fail closed.
      env: { AGENT_ID: AGENT },
      mode: 'fleet',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('env_override_without_marker')
  })
})

describe('dev mode relaxation (explicitly not fleet behavior)', () => {
  test('plain AGENT_ID is accepted in dev mode but still DB-verified', async () => {
    const result = await resolveAgentIdentity(db, {
      cwd: workspaceDir,
      env: { AGENT_ID: AGENT },
      mode: 'dev',
    })
    expect(result.ok).toBe(true)

    const ghost = await resolveAgentIdentity(db, {
      cwd: workspaceDir,
      env: { AGENT_ID: `${PREFIX}-ghost` },
      mode: 'dev',
    })
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.reason).toBe('agent_not_registered')
  })
})
