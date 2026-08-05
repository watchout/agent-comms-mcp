import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import {
  applyRegistryIdentityReconciliation,
  buildRegistryIdentityReconciliationPlan,
  canonicalJson,
  canonicalSha256,
  readRegistryIdentityReconciliationState,
  REGISTRY_RECONCILIATION_CELL_ID,
  rollbackRegistryIdentityReconciliation,
  type RegistryApplyReceipt,
  type RegistryOwnerDecisionEvidence,
  type RegistryReconciliationPlan,
} from '../core/registry-identity-reconciliation'

const BASE_COMMIT = '05045be81165d0e151baf02f9fc1b93cb46c997e'
const BASE_TREE = '7d4e0109825fb63c7c343ae272bc8cc3b97ba89e'
const SOURCE_REF = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5186249673'
const SOURCE_BODY = 'owner-frozen Cell 20 production denominator and test-fixture classification\n'
const SOURCE_SHA = createHash('sha256').update(SOURCE_BODY).digest('hex')
const cleanup: string[] = []

function inputFor(entries: Array<{ agent_id: string; profile_class: 'production' | 'test' }> = [
  { agent_id: 'dev-001', profile_class: 'production' },
  { agent_id: 'billing-production', profile_class: 'test' },
]): string {
  const input = {
    schema_version: 'aun-registry-classification-input/v1',
    target_repository: 'watchout/agent-comms-mcp',
    base_commit: BASE_COMMIT,
    base_tree: BASE_TREE,
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    classifications: entries.map(entry => ({
      ...entry,
      source_ref: SOURCE_REF,
      source_sha256: SOURCE_SHA,
    })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
  }
  return `${canonicalJson(input)}\n`
}

function ownerDecision(planSha256: string, action: 'apply' | 'rollback' = 'apply'): RegistryOwnerDecisionEvidence {
  const body = [
    'schema_version: shirube-v3/owner_decision/v1',
    'decision_id: OD-AUN-001',
    `cell_id: ${REGISTRY_RECONCILIATION_CELL_ID}`,
    `plan_sha256: ${planSha256}`,
    `action: ${action}`,
    'verdict: APPROVED_EXACT_PLAN',
    'actor: watchout',
    'decision_ref: https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5187000000',
  ].join('\n')
  return {
    ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5187000000',
    body,
    body_sha256: createHash('sha256').update(body).digest('hex'),
  }
}

async function fixture(): Promise<{
  db: SqliteAdapter
  rawInput: string
  plan: RegistryReconciliationPlan
}> {
  const dir = mkdtempSync(join(tmpdir(), 'registry-reconcile-'))
  cleanup.push(dir)
  const path = join(dir, 'test.db')
  migrateSqlite(path)
  const seed = new Database(path)
  seed.exec(`
    INSERT INTO agents
      (agent_id, display_name, agent_type, status, metadata, profile_enabled,
       profile_revision, profile_source, profile_updated_at)
    VALUES
      ('dev-001', 'Dev', 'dev', 'idle', '{"custom":"preserved"}', 1, 4, 'legacy', '2026-08-01T00:00:00Z'),
      ('billing-production', 'Fixture', 'dev', 'idle', '{}', 1, 2, 'legacy', NULL),
      ('human-owner', 'Owner', 'human', 'idle', '{}', 1, 1, 'legacy', NULL),
      ('disabled-dev', 'Disabled', 'dev', 'disabled', '{}', 0, 3, 'legacy', NULL);

    INSERT INTO agent_workspaces (workspace_id, name, local_path, repo_url)
    VALUES ('ws-dev', 'Dev workspace', '/work/dev', 'https://github.com/watchout/agent-comms-mcp.git');
    INSERT INTO agent_workspace_bindings (agent_id, workspace_id, binding_role, active)
    VALUES ('dev-001', 'ws-dev', 'primary', 1);
  `)
  seed.close()
  const db = new SqliteAdapter(path)
  const rawInput = inputFor()
  const plan = await buildRegistryIdentityReconciliationPlan(db, rawInput, { [SOURCE_REF]: SOURCE_BODY })
  return { db, rawInput, plan }
}

function applyOptions(plan: RegistryReconciliationPlan, rawInput: string) {
  return {
    confirm_plan_sha256: plan.plan_sha256,
    owner_decision: ownerDecision(plan.plan_sha256),
    raw_input: rawInput,
    evidence_bundle: { [SOURCE_REF]: SOURCE_BODY },
    exact_subject: {
      target_repository: 'watchout/agent-comms-mcp',
      base_commit: BASE_COMMIT,
      base_tree: BASE_TREE,
    },
    now: () => new Date('2026-08-05T01:00:00.000Z'),
  }
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

describe('Cell 20 registry identity reconciliation', () => {
  test('plan is deterministic, source-bound, and preserves non-owned metadata', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      const second = await buildRegistryIdentityReconciliationPlan(db, rawInput, { [SOURCE_REF]: SOURCE_BODY })
      expect(second).toEqual(plan)
      expect(plan.plan_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.effects).toEqual({
        agents_metadata_profile_fields: 2,
        audit_log_rows: 1,
        cells_30_70_effects: 0,
      })
      expect(plan.entries.find(entry => entry.agent_id === 'dev-001')?.postimage.metadata).toMatchObject({
        custom: 'preserved',
        profile_class: 'production',
        profile_class_source_ref: SOURCE_REF,
        profile_class_source_sha256: SOURCE_SHA,
        profile_class_plan_sha256: plan.plan_sha256,
      })
      expect(plan.entries.find(entry => entry.agent_id === 'billing-production')?.profile_class).toBe('test')
      expect(plan.exclusions).toEqual([
        { agent_id: 'disabled-dev', reason: 'disabled_profile' },
        { agent_id: 'human-owner', reason: 'human' },
      ])
    } finally {
      await db.close()
    }
  })

  test('missing or mismatched evidence digest is blocked before a plan exists', async () => {
    const { db, rawInput } = await fixture()
    try {
      await expect(buildRegistryIdentityReconciliationPlan(db, rawInput, {}))
        .rejects.toThrow('REGISTRY_RECONCILIATION_EVIDENCE_MISSING')
      await expect(buildRegistryIdentityReconciliationPlan(db, rawInput, { [SOURCE_REF]: 'changed' }))
        .rejects.toThrow('REGISTRY_RECONCILIATION_EVIDENCE_DIGEST_MISMATCH')
      await expect(buildRegistryIdentityReconciliationPlan(
        db,
        JSON.stringify(JSON.parse(rawInput)),
        { [SOURCE_REF]: SOURCE_BODY },
      )).rejects.toThrow('input must use one LF terminator')
    } finally {
      await db.close()
    }
  })

  test('name is never classification authority and denominator mismatch fails closed', async () => {
    const { db } = await fixture()
    try {
      const raw = inputFor([{ agent_id: 'dev-001', profile_class: 'production' }])
      await expect(buildRegistryIdentityReconciliationPlan(db, raw, { [SOURCE_REF]: SOURCE_BODY }))
        .rejects.toThrow('REGISTRY_RECONCILIATION_DENOMINATOR_MISMATCH')
    } finally {
      await db.close()
    }
  })

  test('wrong plan hash and missing OD authority cause zero writes', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      const wrongHash = { ...applyOptions(plan, rawInput), confirm_plan_sha256: '0'.repeat(64) }
      await expect(applyRegistryIdentityReconciliation(db, plan, wrongHash))
        .rejects.toThrow('REGISTRY_RECONCILIATION_CONFIRM_PLAN_SHA256_MISMATCH')
      const invalidOwner = {
        ...applyOptions(plan, rawInput),
        owner_decision: {
          ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5187000001',
          body: 'not an approval',
          body_sha256: createHash('sha256').update('not an approval').digest('hex'),
        },
      }
      await expect(applyRegistryIdentityReconciliation(db, plan, invalidOwner))
        .rejects.toThrow('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')
      expect((await db.queryOne<any>(`SELECT profile_revision FROM agents WHERE agent_id = 'dev-001'`))?.profile_revision).toBe(4)
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry_identity_reconciliation.%'`)).toHaveLength(0)
    } finally {
      await db.close()
    }
  })

  test('input, exact subject, and related-row drift abort with zero writes', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        exact_subject: { target_repository: 'watchout/agent-comms-mcp', base_commit: 'f'.repeat(40), base_tree: BASE_TREE },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')

      await db.execute(
        `INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id, runtime_engine, status)
         VALUES ('runtime-drift', 'dev-001', 'codex', 'active')`,
      )
      await expect(applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput)))
        .rejects.toThrow('REGISTRY_RECONCILIATION_RELATED_ROW_DRIFT')
      expect((await db.queryOne<any>(`SELECT profile_revision FROM agents WHERE agent_id = 'dev-001'`))?.profile_revision).toBe(4)
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry_identity_reconciliation.%'`)).toHaveLength(0)
    } finally {
      await db.close()
    }
  })

  test('agent denominator drift after planning aborts before any write', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      await db.execute(
        `INSERT INTO agents (agent_id, display_name, agent_type, status, metadata, profile_enabled)
         VALUES ('late-seat', 'Late', 'dev', 'idle', '{}', 1)`,
      )
      await expect(applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput)))
        .rejects.toThrow('REGISTRY_RECONCILIATION_DENOMINATOR_DRIFT')
      expect((await db.queryOne<any>(`SELECT profile_revision FROM agents WHERE agent_id = 'dev-001'`))?.profile_revision).toBe(4)
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry_identity_reconciliation.%'`)).toHaveLength(0)
    } finally {
      await db.close()
    }
  })

  test('one transaction applies exact rows, second apply is a no-op, and readback closes', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      const result = await applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput))
      expect(result).toMatchObject({ status: 'applied', affected_agents: 2, audit_rows: 1 })
      expect(result.receipt_sha256).toBe(canonicalSha256(result.receipt))
      const row = await db.queryOne<any>(`SELECT metadata, profile_revision, profile_source, profile_updated_at FROM agents WHERE agent_id = 'dev-001'`)
      expect(JSON.parse(row.metadata)).toMatchObject({ custom: 'preserved', profile_class: 'production', profile_class_plan_sha256: plan.plan_sha256 })
      expect(row.profile_revision).toBe(5)
      expect(row.profile_source).toBe(REGISTRY_RECONCILIATION_CELL_ID)
      expect(row.profile_updated_at).toBe('2026-08-05T01:00:00.000Z')

      const second = await applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput))
      expect(second).toMatchObject({ status: 'already_applied', affected_agents: 0, audit_rows: 0 })
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type = 'registry_identity_reconciliation.apply'`)).toHaveLength(1)
      expect(await readRegistryIdentityReconciliationState(db, plan)).toMatchObject({
        ok: true,
        related_rows_match: true,
        agents: [
          { agent_id: 'billing-production', state: 'postimage' },
          { agent_id: 'dev-001', state: 'postimage' },
        ],
      })
    } finally {
      await db.close()
    }
  })

  test('rollback restores exact preimages and refuses any postimage drift', async () => {
    const first = await fixture()
    try {
      const applied = await applyRegistryIdentityReconciliation(first.db, first.plan, applyOptions(first.plan, first.rawInput))
      const rollbackOwner = ownerDecision(first.plan.plan_sha256, 'rollback')
      const rolledBack = await rollbackRegistryIdentityReconciliation(first.db, applied.receipt, {
        confirm_receipt_sha256: applied.receipt_sha256,
        owner_decision: rollbackOwner,
        now: () => new Date('2026-08-05T01:05:00.000Z'),
      })
      expect(rolledBack).toMatchObject({ status: 'rolled_back', affected_agents: 2, audit_rows: 1 })
      expect(await first.db.queryOne<any>(`SELECT metadata, profile_revision, profile_source, profile_updated_at FROM agents WHERE agent_id = 'dev-001'`)).toEqual({
        metadata: '{"custom":"preserved"}',
        profile_revision: 4,
        profile_source: 'legacy',
        profile_updated_at: '2026-08-01T00:00:00Z',
      })
    } finally {
      await first.db.close()
    }

    const drift = await fixture()
    try {
      const applied = await applyRegistryIdentityReconciliation(drift.db, drift.plan, applyOptions(drift.plan, drift.rawInput))
      const changed = JSON.stringify({
        ...applied.receipt.entries[0].postimage.metadata,
        unrelated_concurrent_change: true,
      })
      await drift.db.execute(`UPDATE agents SET metadata = $1 WHERE agent_id = $2`, [changed, applied.receipt.entries[0].agent_id])
      await expect(rollbackRegistryIdentityReconciliation(drift.db, applied.receipt as RegistryApplyReceipt, {
        confirm_receipt_sha256: applied.receipt_sha256,
        owner_decision: ownerDecision(drift.plan.plan_sha256, 'rollback'),
      })).rejects.toThrow('REGISTRY_RECONCILIATION_ROLLBACK_POSTIMAGE_DRIFT')
      expect(await drift.db.query<any>(`SELECT * FROM audit_log WHERE event_type = 'registry_identity_reconciliation.rollback'`)).toHaveLength(0)
    } finally {
      await drift.db.close()
    }
  })
})
