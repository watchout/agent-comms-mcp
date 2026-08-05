import { afterEach, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'
import { SqliteAdapter } from '../core/db/sqlite-adapter'
import { PgAdapter } from '../core/db/pg-adapter'
import { Client } from 'pg'
import {
  applyRegistryIdentityReconciliation,
  buildRegistryIdentityReconciliationPlan,
  canonicalJson,
  canonicalSha256,
  readRegistryIdentityReconciliationState,
  REGISTRY_RECONCILIATION_CELL_ID,
  REGISTRY_RECONCILIATION_IMPLEMENTATION_PR_REF,
  rollbackRegistryIdentityReconciliation,
  type RegistryApplyReceipt,
  type RegistryExactSubject,
  type RegistryOwnerDecisionEvidence,
  type RegistryReconciliationPlan,
} from '../core/registry-identity-reconciliation'

const BASE_COMMIT = '05045be81165d0e151baf02f9fc1b93cb46c997e'
const BASE_TREE = '7d4e0109825fb63c7c343ae272bc8cc3b97ba89e'
const SOURCE_REF = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5186249673'
const SOURCE_BODY = 'owner-frozen Cell 20 production denominator and test-fixture classification\n'
const SOURCE_SHA = createHash('sha256').update(SOURCE_BODY).digest('hex')
const EXACT_SUBJECT = {
  repo: 'watchout/agent-comms-mcp',
  base_commit: BASE_COMMIT,
  base_tree: BASE_TREE,
  implementation_pr_ref: REGISTRY_RECONCILIATION_IMPLEMENTATION_PR_REF,
  head_commit: '1'.repeat(40),
  head_tree: '2'.repeat(40),
} satisfies RegistryExactSubject
const cleanup: string[] = []
const POSSIBLE_PG_TEST_URL = process.env.AGENT_COM_TEST_DATABASE_URL
  ?? (/(?:^|[/_])[^/?]*_test(?:\?|$)/.test(process.env.DATABASE_URL ?? '') ? process.env.DATABASE_URL : undefined)
const pgTest = POSSIBLE_PG_TEST_URL ? test : test.skip

function inputFor(entries: Array<{ agent_id: string; target_profile_class: 'production' | 'test' }> = [
  { agent_id: 'dev-001', target_profile_class: 'production' },
  { agent_id: 'billing-production', target_profile_class: 'test' },
]): string {
  const input = {
    schema_version: 'aun-registry-classification-input/v1',
    control_source_ref: SOURCE_REF,
    source_commit: BASE_COMMIT,
    source_tree: BASE_TREE,
    entries: entries.map(entry => ({
      ...entry,
      evidence_ref: SOURCE_REF,
      evidence_sha256: SOURCE_SHA,
    })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
  }
  return `${canonicalJson(input)}\n`
}

function ownerDecision(
  plan: RegistryReconciliationPlan,
  action: 'apply' | 'rollback' = 'apply',
  exactSubject: RegistryExactSubject = EXACT_SUBJECT,
): RegistryOwnerDecisionEvidence {
  const ref = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5187000000'
  const body = canonicalJson({
    schema_version: 'shirube-v3/owner_decision/v1',
    decision_id: 'OD-AUN-001',
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    scope: 'CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001_registry_apply_only',
    action,
    verdict: 'APPROVED_EXACT_PLAN',
    actor: 'watchout',
    decision_ref: ref,
    repo: exactSubject.repo,
    base_commit: exactSubject.base_commit,
    base_tree: exactSubject.base_tree,
    head_commit: exactSubject.head_commit,
    head_tree: exactSubject.head_tree,
    handoff_ref: SOURCE_REF,
    handoff_sha256: '82c3f997ecaed6a3e852a32118714169d078fcc24a2b05d8e4be725135524779',
    implementation_pr_ref: exactSubject.implementation_pr_ref,
    independent_audit_ref: 'https://github.com/watchout/agent-comms-mcp/pull/914#issuecomment-5188000000',
    independent_audit_sha256: '3'.repeat(64),
    input_manifest_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5188000001',
    input_manifest_sha256: plan.input_manifest_sha256,
    plan_ref: 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5188000002',
    plan_sha256: plan.plan_sha256,
    ordered_agent_ids: plan.entries.map(entry => entry.agent_id),
    ordered_agent_count: plan.entry_count,
    ordered_exclusions: plan.exclusions,
    ordered_exclusion_count: plan.exclusions.length,
    per_row_digests: plan.entries.map(entry => ({
      agent_id: entry.agent_id,
      agents_preimage_sha256: entry.agents_preimage_sha256,
      proposed_postimage_sha256: entry.proposed_postimage_sha256,
    })),
    permitted_effect: plan.permitted_effect,
    apply_window_start: '2026-08-05T00:00:00.000Z',
    apply_window_end: '2026-08-05T02:00:00.000Z',
    readback_acceptance: [
      'all_plan_entries_match_postimage',
      'one_apply_audit_row_matches_receipt',
      'second_apply_is_verified_noop',
    ],
    rollback_trigger: ['any_postimage_drift', 'readback_mismatch', 'operator_requested_rollback'],
    rollback_receipt_contract: [
      'confirm_receipt_sha256',
      'audited_apply_receipt_required',
      'exact_postimage_match_required',
      'restore_exact_preimages',
    ],
    forbidden_effects: { activation: false, endpoint: false, mcp: false, queue: false, restart: false, schema: false },
  })
  return {
    ref,
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
    owner_decision: ownerDecision(plan),
    raw_input: rawInput,
    evidence_bundle: { [SOURCE_REF]: SOURCE_BODY },
    exact_subject: EXACT_SUBJECT,
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
      expect(plan).toMatchObject({
        control_source_ref: SOURCE_REF,
        repo: 'watchout/agent-comms-mcp',
        input_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        entry_count: 2,
        permitted_effect: { cells_30_70_effect_count: 0 },
      })
      const devEntry = plan.entries.find(entry => entry.agent_id === 'dev-001')!
      expect(devEntry.proposed_metadata).toMatchObject({
        custom: 'preserved',
        profile_class: 'production',
        profile_class_source_ref: SOURCE_REF,
        profile_class_source_sha256: SOURCE_SHA,
        profile_class_plan_sha256: plan.plan_sha256,
      })
      expect(devEntry.agents_preimage_sha256).toBe(canonicalSha256(devEntry.agents_preimage))
      expect(devEntry.related_read_set_sha256).toBe(canonicalSha256(devEntry.related_read_set))
      expect(devEntry.proposed_postimage_sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.entries.find(entry => entry.agent_id === 'billing-production')?.target_profile_class).toBe('test')
      expect(plan.exclusions).toEqual([
        { agent_id: 'disabled-dev', reason: 'disabled_profile', source_ref: SOURCE_REF },
        { agent_id: 'human-owner', reason: 'human', source_ref: SOURCE_REF },
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

      const malformedAunRef = 'aun-message:------------------------------------'
      const malformed = JSON.parse(rawInput)
      malformed.entries = malformed.entries.map((entry: any) => ({ ...entry, evidence_ref: malformedAunRef }))
      await expect(buildRegistryIdentityReconciliationPlan(
        db,
        `${canonicalJson(malformed)}\n`,
        { [malformedAunRef]: SOURCE_BODY },
      )).rejects.toThrow('mutable source_ref')

      const uppercaseDigest = JSON.parse(rawInput)
      uppercaseDigest.entries = uppercaseDigest.entries.map((entry: any) => ({
        ...entry,
        evidence_sha256: String(entry.evidence_sha256).toUpperCase(),
      }))
      await expect(buildRegistryIdentityReconciliationPlan(
        db,
        `${canonicalJson(uppercaseDigest)}\n`,
        { [SOURCE_REF]: SOURCE_BODY },
      )).rejects.toThrow('input must be RFC 8785 canonical JSON plus LF')
    } finally {
      await db.close()
    }
  })

  test('name is never classification authority and denominator mismatch fails closed', async () => {
    const { db } = await fixture()
    try {
      const raw = inputFor([{ agent_id: 'dev-001', target_profile_class: 'production' }])
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

      const validOwner = ownerDecision(plan)
      const duplicateBody = String(validOwner.body).replace('"actor":"watchout"', '"actor":"watchout","actor":"watchout"')
      const duplicateOwner = {
        ...validOwner,
        body: duplicateBody,
        body_sha256: createHash('sha256').update(duplicateBody).digest('hex'),
      }
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        owner_decision: duplicateOwner,
      })).rejects.toThrow('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')

      const contradictoryBody = String(validOwner.body).replace(
        '"verdict":"APPROVED_EXACT_PLAN"',
        '"verdict":"APPROVED_EXACT_PLAN","verdict":"REJECTED"',
      )
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        owner_decision: {
          ...validOwner,
          body: contradictoryBody,
          body_sha256: createHash('sha256').update(contradictoryBody).digest('hex'),
        },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')

      const incomplete = JSON.parse(String(validOwner.body))
      delete incomplete.independent_audit_ref
      const incompleteBody = canonicalJson(incomplete)
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        owner_decision: {
          ...validOwner,
          body: incompleteBody,
          body_sha256: createHash('sha256').update(incompleteBody).digest('hex'),
        },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')

      for (const [field, wrongValue] of [
        ['base_commit', 'e'.repeat(40)],
        ['base_tree', 'f'.repeat(40)],
        ['head_commit', 'e'.repeat(40)],
        ['head_tree', 'f'.repeat(40)],
        ['implementation_pr_ref', 'https://github.com/watchout/agent-comms-mcp/pull/999'],
      ] as const) {
        const wrongSubject = JSON.parse(String(validOwner.body))
        wrongSubject[field] = wrongValue
        const wrongSubjectBody = canonicalJson(wrongSubject)
        await expect(applyRegistryIdentityReconciliation(db, plan, {
          ...applyOptions(plan, rawInput),
          owner_decision: {
            ...validOwner,
            body: wrongSubjectBody,
            body_sha256: createHash('sha256').update(wrongSubjectBody).digest('hex'),
          },
        })).rejects.toThrow('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')
      }
      expect((await db.queryOne<any>(`SELECT profile_revision FROM agents WHERE agent_id = 'dev-001'`))?.profile_revision).toBe(4)
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry.identity_reconciliation.%'`)).toHaveLength(0)
    } finally {
      await db.close()
    }
  })

  test('input, exact subject, and related-row drift abort with zero writes', async () => {
    const { db, rawInput, plan } = await fixture()
    try {
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        exact_subject: { ...EXACT_SUBJECT, base_commit: 'f'.repeat(40) },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        exact_subject: { ...EXACT_SUBJECT, base_tree: 'f'.repeat(40) },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, rawInput),
        exact_subject: { ...EXACT_SUBJECT, implementation_pr_ref: 'https://github.com/watchout/agent-comms-mcp/pull/999' as any },
      })).rejects.toThrow('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')

      const changedInput = JSON.parse(rawInput)
      changedInput.source_commit = 'e'.repeat(40)
      await expect(applyRegistryIdentityReconciliation(db, plan, {
        ...applyOptions(plan, `${canonicalJson(changedInput)}\n`),
      })).rejects.toThrow('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')

      await db.execute(
        `INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id, runtime_engine, status)
         VALUES ('runtime-drift', 'dev-001', 'codex', 'active')`,
      )
      await expect(applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput)))
        .rejects.toThrow('REGISTRY_RECONCILIATION_RELATED_ROW_DRIFT')
      expect((await db.queryOne<any>(`SELECT profile_revision FROM agents WHERE agent_id = 'dev-001'`))?.profile_revision).toBe(4)
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry.identity_reconciliation.%'`)).toHaveLength(0)
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
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type LIKE 'registry.identity_reconciliation.%'`)).toHaveLength(0)
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
      expect(await db.query<any>(`SELECT * FROM audit_log WHERE event_type = 'registry.identity_reconciliation.apply'`)).toHaveLength(1)
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
      const rollbackOwner = ownerDecision(first.plan, 'rollback')
      const rolledBack = await rollbackRegistryIdentityReconciliation(first.db, applied.receipt, {
        confirm_receipt_sha256: applied.receipt_sha256,
        owner_decision: rollbackOwner,
        exact_subject: EXACT_SUBJECT,
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
        owner_decision: ownerDecision(drift.plan, 'rollback'),
        exact_subject: EXACT_SUBJECT,
        now: () => new Date('2026-08-05T01:05:00.000Z'),
      })).rejects.toThrow('REGISTRY_RECONCILIATION_ROLLBACK_POSTIMAGE_DRIFT')
      expect(await drift.db.query<any>(`SELECT * FROM audit_log WHERE event_type = 'registry.identity_reconciliation.rollback'`)).toHaveLength(0)
    } finally {
      await drift.db.close()
    }
  })

  pgTest('PostgreSQL concurrent related-row writer fails before agents or audit writes', async () => {
    const schema = `cell20_${randomUUID().replaceAll('-', '')}`
    const admin = new Client({ connectionString: POSSIBLE_PG_TEST_URL })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}`)
    const config = { connectionString: POSSIBLE_PG_TEST_URL, options: `-c search_path=${schema}` }
    const db = new PgAdapter(config)
    const writer = new Client(config)
    await writer.connect()
    try {
      await admin.query(`SET search_path TO ${schema}`)
      await admin.query(`
        CREATE TABLE agents (
          agent_id text PRIMARY KEY, org_id text, agent_type text, status text,
          profile_enabled boolean, disabled_at timestamptz, metadata jsonb,
          profile_revision integer, profile_source text, profile_updated_at timestamptz,
          runtime_engine_preference text, expected_provider_identity jsonb
        );
        CREATE TABLE agent_workspaces (
          workspace_id text PRIMARY KEY, org_id text, name text, workspace_type text,
          local_path text, repo_url text, default_branch text, metadata jsonb
        );
        CREATE TABLE agent_workspace_bindings (
          agent_id text, workspace_id text, binding_role text, active boolean,
          created_at timestamptz, updated_at timestamptz
        );
        CREATE TABLE agent_runtime_instances (
          runtime_instance_id text PRIMARY KEY, agent_id text, workspace_id text,
          runtime_engine text, runtime_kind text, host_id text, session_name text,
          process_id integer, port integer, checkout_path text, commit_sha text,
          endpoint_uri text, status text, started_at timestamptz, stopped_at timestamptz,
          last_seen_at timestamptz, metadata jsonb
        );
        CREATE TABLE agent_provider_identities (
          provider_identity_id text PRIMARY KEY, agent_id text, provider text,
          provider_subject_id text, provider_handle text, identity_kind text, status text,
          trust_status text, source text, evidence_revision integer, last_verified_at timestamptz,
          metadata jsonb, disabled_at timestamptz, revoked_at timestamptz
        );
        CREATE TABLE agent_ui_bindings (
          binding_id text PRIMARY KEY, agent_id text, ui_type text, ui_id text, ui_handle text,
          connector_instance_id text, credential_id text, provider_identity_id text,
          surface_role text, status text, trust_status text, last_verified_at timestamptz,
          evidence_revision integer, metadata jsonb, disabled_at timestamptz
        );
        CREATE TABLE channels (id text PRIMARY KEY, members text[]);
        CREATE TABLE channel_routing_policy (
          channel_id text PRIMARY KEY, primary_agent_id text, adapter_owner_agent_id text,
          outbound_allowlist text[], native_role_outbound_owners jsonb,
          native_projection_identities jsonb, policy_source text
        );
        CREATE TABLE audit_log (
          event_type text, agent_id text, target text, detail jsonb, org_id text,
          created_at timestamptz DEFAULT now()
        );
        INSERT INTO agents VALUES (
          'dev-001', 'default', 'dev', 'idle', true, NULL, '{"custom":"preserved"}',
          4, 'legacy', '2026-08-01T00:00:00Z', 'codex', '{}'
        );
      `)
      const rawInput = inputFor([{ agent_id: 'dev-001', target_profile_class: 'production' }])
      const plan = await buildRegistryIdentityReconciliationPlan(db, rawInput, { [SOURCE_REF]: SOURCE_BODY })

      await writer.query('BEGIN')
      await writer.query(`
        INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id, runtime_engine, status)
        VALUES ('concurrent-runtime', 'dev-001', 'codex', 'active')
      `)
      await expect(applyRegistryIdentityReconciliation(db, plan, applyOptions(plan, rawInput)))
        .rejects.toThrow(/could not obtain lock|lock not available/i)

      const agent = await admin.query(`SELECT profile_revision, metadata FROM agents WHERE agent_id='dev-001'`)
      const audits = await admin.query(`SELECT * FROM audit_log`)
      expect(agent.rows[0].profile_revision).toBe(4)
      expect(agent.rows[0].metadata).toEqual({ custom: 'preserved' })
      expect(audits.rowCount).toBe(0)
      await writer.query('ROLLBACK')
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      await writer.end().catch(() => {})
      await db.close().catch(() => {})
      await admin.query('SET search_path TO public').catch(() => {})
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
      await admin.end().catch(() => {})
    }
  })
})
