import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'
import { parseJsonObject, profileEnabled, type AuthoritativeProfileClass } from './profile-classification'

export const REGISTRY_RECONCILIATION_CELL_ID = 'CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001'
export const REGISTRY_RECONCILIATION_PROFILE_SOURCE = REGISTRY_RECONCILIATION_CELL_ID
export const REGISTRY_RECONCILIATION_REPOSITORY = 'watchout/agent-comms-mcp'
export const REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5186249673'
export const REGISTRY_RECONCILIATION_HANDOFF_SHA256 = '82c3f997ecaed6a3e852a32118714169d078fcc24a2b05d8e4be725135524779'

export type RegistryClassificationInput = {
  schema_version: 'aun-registry-classification-input/v1'
  control_source_ref: typeof REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF
  source_commit: string
  source_tree: string
  entries: Array<{
    agent_id: string
    target_profile_class: AuthoritativeProfileClass
    evidence_ref: string
    evidence_sha256: string
  }>
}

export type RegistryEvidenceBundle = Record<
  string,
  string | { encoding: 'utf8' | 'base64'; data: string }
>

export type AgentPreimage = {
  agent_id: string
  org_id: string
  agent_type: string
  status: string
  profile_enabled: boolean
  disabled_at: string | null
  metadata: Record<string, unknown>
  profile_revision: number
  profile_source: string
  profile_updated_at: string | null
  runtime_engine_preference: string | null
  expected_provider_identity: Record<string, unknown>
}

type AgentSemanticPostimage = {
  agent_id: string
  metadata: Record<string, unknown>
  profile_revision: number
  profile_source: typeof REGISTRY_RECONCILIATION_PROFILE_SOURCE
}

export type RegistryReconciliationPlanEntry = {
  agent_id: string
  target_profile_class: AuthoritativeProfileClass
  evidence_ref: string
  evidence_sha256: string
  agents_preimage: AgentPreimage
  agents_preimage_sha256: string
  related_read_set: unknown
  related_read_set_sha256: string
  proposed_metadata: Record<string, unknown>
  proposed_profile_revision: number
  proposed_profile_source: typeof REGISTRY_RECONCILIATION_PROFILE_SOURCE
  proposed_postimage_sha256: string
}

export type RegistryPermittedEffect = {
  update: {
    table: 'agents'
    agent_ids: string[]
    columns: ['metadata', 'profile_revision', 'profile_source', 'profile_updated_at']
    metadata_keys: typeof OWNED_METADATA_KEYS
  }
  insert: {
    table: 'audit_log'
    event_types: ['registry.identity_reconciliation.apply', 'registry.identity_reconciliation.rollback']
    rows_per_transaction: 1
  }
  forbidden_tables: string[]
  cells_30_70_effect_count: 0
}

export type RegistryReconciliationPlan = {
  schema_version: 'aun-registry-identity-reconciliation-plan/v1'
  control_source_ref: typeof REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  repo: typeof REGISTRY_RECONCILIATION_REPOSITORY
  base_commit: string
  base_tree: string
  input_manifest_sha256: string
  entry_count: number
  denominator_sha256: string
  related_rows_sha256: string
  entries: RegistryReconciliationPlanEntry[]
  exclusions: Array<{ agent_id: string; reason: 'disabled_profile' | 'human'; source_ref: string }>
  permitted_effect: RegistryPermittedEffect
  plan_sha256: string
}

export type RegistryOwnerDecisionEvidence = {
  ref: string
  body: string | Uint8Array
  body_sha256: string
}

export const REGISTRY_RECONCILIATION_IMPLEMENTATION_PR_REF = 'https://github.com/watchout/agent-comms-mcp/pull/914' as const

export type RegistryExactSubject = {
  repo: typeof REGISTRY_RECONCILIATION_REPOSITORY
  base_commit: string
  base_tree: string
  implementation_pr_ref: typeof REGISTRY_RECONCILIATION_IMPLEMENTATION_PR_REF
  head_commit: string
  head_tree: string
}

export type RegistryApplyReceipt = {
  schema_version: 'aun-registry-identity-reconciliation-apply-receipt/v1'
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  plan_sha256: string
  input_manifest_sha256: string
  related_rows_sha256: string
  owner_decision_ref: string
  owner_decision_body_sha256: string
  exact_subject: RegistryExactSubject
  applied_at: string
  plan: RegistryReconciliationPlan
  entries: Array<{
    agent_id: string
    preimage: AgentPreimage
    postimage: AgentSemanticPostimage
  }>
}

export type RegistryApplyResult = {
  ok: true
  status: 'applied' | 'already_applied'
  plan_sha256: string
  affected_agents: number
  audit_rows: 0 | 1
  receipt: RegistryApplyReceipt
  receipt_sha256: string
}

export type RegistryRollbackResult = {
  ok: true
  status: 'rolled_back'
  plan_sha256: string
  affected_agents: number
  audit_rows: 1
  rolled_back_at: string
}

const SHA256_RE = /^[a-f0-9]{64}$/
const GIT_SHA_RE = /^[a-f0-9]{40}$/
const OWNED_METADATA_KEYS = [
  'profile_class',
  'profile_class_source_ref',
  'profile_class_source_sha256',
  'profile_class_plan_sha256',
] as const

function sha256(raw: string | Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex')
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: ${label} must be an object`)
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('JCS_INVALID_UNICODE')
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('JCS_INVALID_UNICODE')
    }
  }
}

/** RFC 8785-compatible canonical JSON for the JSON value subset used here. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') {
    assertUnicodeScalarString(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS_INVALID_NUMBER')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object).sort()
    return `{${keys.map((key) => `${canonicalJson(key)}:${canonicalJson(object[key])}`).join(',')}}`
  }
  throw new Error(`JCS_UNSUPPORTED_TYPE: ${typeof value}`)
}

export function canonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value))
}

function normalizeDbValue(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(normalizeDbValue)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeDbValue(nested)]),
    )
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function normalizeAgent(row: any): AgentPreimage {
  const revision = Number(row.profile_revision)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`REGISTRY_RECONCILIATION_PREIMAGE_INVALID: ${row.agent_id}:profile_revision`)
  }
  return {
    agent_id: String(row.agent_id),
    org_id: String(row.org_id ?? 'default'),
    agent_type: String(row.agent_type ?? ''),
    status: String(row.status ?? ''),
    profile_enabled: profileEnabled(row.profile_enabled),
    disabled_at: normalizeTimestamp(row.disabled_at),
    metadata: parseJsonObject(row.metadata),
    profile_revision: revision,
    profile_source: String(row.profile_source ?? ''),
    profile_updated_at: normalizeTimestamp(row.profile_updated_at),
    runtime_engine_preference: row.runtime_engine_preference == null ? null : String(row.runtime_engine_preference),
    expected_provider_identity: parseJsonObject(row.expected_provider_identity),
  }
}

function evidenceBytes(value: RegistryEvidenceBundle[string]): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (value.encoding === 'base64') return Buffer.from(value.data, 'base64')
  if (value.encoding === 'utf8') return Buffer.from(value.data, 'utf8')
  throw new Error('REGISTRY_RECONCILIATION_EVIDENCE_INVALID: unsupported encoding')
}

function assertImmutableEvidenceRef(ref: string): void {
  const immutable = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(ref)
    || /^git:[a-f0-9]{40}:.+/.test(ref)
    || /^aun-message:[0-9a-f-]{36}$/.test(ref)
  if (!immutable) throw new Error(`REGISTRY_RECONCILIATION_EVIDENCE_INVALID: mutable source_ref ${ref}`)
}

export function parseRegistryClassificationInput(raw: string | Uint8Array): {
  input: RegistryClassificationInput
  input_sha256: string
} {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: input must be UTF-8')
  }
  if (!text.endsWith('\n') || text.includes('\r')) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: input must use one LF terminator and no CR')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: invalid JSON')
  }
  assertPlainObject(value, 'root')
  if (value.schema_version !== 'aun-registry-classification-input/v1') {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: schema_version')
  }
  if (value.control_source_ref !== REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: control_source_ref')
  }
  if (typeof value.source_commit !== 'string' || !GIT_SHA_RE.test(value.source_commit)) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: source_commit')
  }
  if (typeof value.source_tree !== 'string' || !GIT_SHA_RE.test(value.source_tree)) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: source_tree')
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: entries')
  }
  const seen = new Set<string>()
  const entries = value.entries.map((rawEntry, index) => {
    assertPlainObject(rawEntry, `entries[${index}]`)
    const agentId = typeof rawEntry.agent_id === 'string' ? rawEntry.agent_id.trim() : ''
    const profileClass = rawEntry.target_profile_class
    const sourceRef = typeof rawEntry.evidence_ref === 'string' ? rawEntry.evidence_ref.trim() : ''
    const sourceSha = typeof rawEntry.evidence_sha256 === 'string' ? rawEntry.evidence_sha256.toLowerCase() : ''
    if (!agentId || seen.has(agentId)) throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: duplicate_or_empty_agent_id:${agentId}`)
    if (profileClass !== 'production' && profileClass !== 'test') throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: ${agentId}:target_profile_class`)
    assertImmutableEvidenceRef(sourceRef)
    if (!SHA256_RE.test(sourceSha)) throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: ${agentId}:evidence_sha256`)
    seen.add(agentId)
    return { agent_id: agentId, target_profile_class: profileClass, evidence_ref: sourceRef, evidence_sha256: sourceSha }
  }).sort((left, right) => left.agent_id.localeCompare(right.agent_id))
  const input: RegistryClassificationInput = {
    schema_version: 'aun-registry-classification-input/v1',
    control_source_ref: REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF,
    source_commit: value.source_commit,
    source_tree: value.source_tree,
    entries,
  }
  if (text !== `${canonicalJson(input)}\n`) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: input must be RFC 8785 canonical JSON plus LF')
  }
  return {
    input,
    input_sha256: sha256(bytes),
  }
}

function verifyEvidence(input: RegistryClassificationInput, bundle: RegistryEvidenceBundle): void {
  for (const entry of input.entries) {
    if (!Object.prototype.hasOwnProperty.call(bundle, entry.evidence_ref)) {
      throw new Error(`REGISTRY_RECONCILIATION_EVIDENCE_MISSING: ${entry.agent_id}:${entry.evidence_ref}`)
    }
    const actual = sha256(evidenceBytes(bundle[entry.evidence_ref]))
    if (actual !== entry.evidence_sha256) {
      throw new Error(`REGISTRY_RECONCILIATION_EVIDENCE_DIGEST_MISMATCH: ${entry.agent_id}:${entry.evidence_ref}`)
    }
  }
}

async function readAgentRows(db: DbAdapter, lock = false): Promise<AgentPreimage[]> {
  const rows = await db.query<any>(
    `SELECT agent_id, org_id, agent_type, status, profile_enabled, disabled_at,
            metadata, profile_revision, profile_source, profile_updated_at,
            runtime_engine_preference, expected_provider_identity
       FROM agents
      ORDER BY agent_id${lock && db.dialect === 'postgres' ? ' FOR UPDATE' : ''}`,
  )
  return rows.map(normalizeAgent)
}

function arrayText(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

async function readRelatedRows(db: DbAdapter, agentIds: string[]): Promise<unknown[]> {
  const rows: Array<Record<string, unknown>> = []
  const orderedIds = [...agentIds].sort()
  for (const agentId of orderedIds) {
    rows.push({
      agent_id: agentId,
      workspaces: await db.query(
        `SELECT b.agent_id, b.workspace_id, b.binding_role, b.active, b.created_at, b.updated_at,
                w.org_id, w.name, w.workspace_type, w.local_path, w.repo_url, w.default_branch, w.metadata
           FROM agent_workspace_bindings b
           JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
          WHERE b.agent_id = $1
          ORDER BY b.workspace_id, b.binding_role`,
        [agentId],
      ),
      runtimes: await db.query(
        `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind, host_id,
                session_name, process_id, port, checkout_path, commit_sha, endpoint_uri, status,
                started_at, stopped_at, last_seen_at, metadata
           FROM agent_runtime_instances
          WHERE agent_id = $1
          ORDER BY runtime_instance_id`,
        [agentId],
      ),
      provider_identities: await db.query(
        `SELECT provider_identity_id, agent_id, provider, provider_subject_id, provider_handle,
                identity_kind, status, trust_status, source, evidence_revision, last_verified_at,
                metadata, disabled_at, revoked_at
           FROM agent_provider_identities
          WHERE agent_id = $1
          ORDER BY provider_identity_id`,
        [agentId],
      ),
      ui_bindings: await db.query(
        `SELECT binding_id, agent_id, ui_type, ui_id, ui_handle, connector_instance_id,
                credential_id, provider_identity_id, surface_role, status, trust_status,
                last_verified_at, evidence_revision, metadata, disabled_at
           FROM agent_ui_bindings
          WHERE agent_id = $1
          ORDER BY binding_id`,
        [agentId],
      ),
    })
  }
  const channelRows = await db.query<any>(
    `SELECT c.id AS channel_id, c.members, p.primary_agent_id, p.adapter_owner_agent_id,
            p.outbound_allowlist, p.native_role_outbound_owners,
            p.native_projection_identities, p.policy_source
       FROM channels c
       LEFT JOIN channel_routing_policy p ON p.channel_id = c.id
      ORDER BY c.id`,
  )
  const channelAppliesTo = (row: any, agentId: string) => {
    const candidates = [
      ...arrayText(row.members),
      ...arrayText(row.outbound_allowlist),
      String(row.primary_agent_id ?? ''),
      String(row.adapter_owner_agent_id ?? ''),
    ]
    const nativeOwners = parseJsonObject(row.native_role_outbound_owners)
    const nativeIdentities = parseJsonObject(row.native_projection_identities)
    return candidates.includes(agentId)
      || Object.keys(nativeOwners).includes(agentId)
      || Object.values(nativeOwners).some(value => String(value) === agentId)
      || Object.keys(nativeIdentities).includes(agentId)
      || Object.values(nativeIdentities).some(value => String(value) === agentId)
  }
  for (const row of rows) {
    row.channels = channelRows.filter(channel => channelAppliesTo(channel, String(row.agent_id)))
  }
  return normalizeDbValue(rows) as unknown[]
}

async function lockRegistryReconciliationReadSet(db: DbAdapter): Promise<void> {
  if (db.dialect !== 'postgres') return
  // A PostgreSQL READ COMMITTED snapshot alone leaves a check-to-write race:
  // a related row could commit after its SELECT and before the first agents
  // UPDATE. These transaction-scoped locks either fail immediately behind an
  // existing writer or hold every denominator/provenance table stable through
  // commit. Plan-listed agents are additionally locked in agent_id order below.
  await db.query(`LOCK TABLE
    agents,
    agent_workspace_bindings,
    agent_workspaces,
    agent_runtime_instances,
    agent_provider_identities,
    agent_ui_bindings,
    channels,
    channel_routing_policy
    IN SHARE ROW EXCLUSIVE MODE NOWAIT`)
}

function relatedReadSetByAgent(rows: unknown[]): Map<string, unknown> {
  return new Map(rows.map((row: any) => [String(row.agent_id), row]))
}

function planHashMaterial(plan: Omit<RegistryReconciliationPlan, 'plan_sha256'> | RegistryReconciliationPlan): unknown {
  const material = structuredClone(plan) as RegistryReconciliationPlan
  delete (material as Partial<RegistryReconciliationPlan>).plan_sha256
  for (const entry of material.entries) {
    entry.proposed_metadata.profile_class_plan_sha256 = 'SELF'
    entry.proposed_postimage_sha256 = 'SELF'
  }
  return material
}

export function registryPlanSha256(plan: Omit<RegistryReconciliationPlan, 'plan_sha256'> | RegistryReconciliationPlan): string {
  return canonicalSha256(planHashMaterial(plan))
}

function postimageFor(
  preimage: AgentPreimage,
  classification: RegistryClassificationInput['entries'][number],
  planSha256: string,
): AgentSemanticPostimage {
  const metadata = { ...preimage.metadata }
  metadata.profile_class = classification.target_profile_class
  metadata.profile_class_source_ref = classification.evidence_ref
  metadata.profile_class_source_sha256 = classification.evidence_sha256
  metadata.profile_class_plan_sha256 = planSha256
  return {
    agent_id: preimage.agent_id,
    metadata,
    profile_revision: preimage.profile_revision + 1,
    profile_source: REGISTRY_RECONCILIATION_PROFILE_SOURCE,
  }
}

function postimageFromPlanEntry(entry: RegistryReconciliationPlanEntry): AgentSemanticPostimage {
  return {
    agent_id: entry.agent_id,
    metadata: entry.proposed_metadata,
    profile_revision: entry.proposed_profile_revision,
    profile_source: entry.proposed_profile_source,
  }
}

function permittedEffect(agentIds: string[]): RegistryPermittedEffect {
  return {
    update: {
      table: 'agents',
      agent_ids: [...agentIds].sort(),
      columns: ['metadata', 'profile_revision', 'profile_source', 'profile_updated_at'],
      metadata_keys: OWNED_METADATA_KEYS,
    },
    insert: {
      table: 'audit_log',
      event_types: ['registry.identity_reconciliation.apply', 'registry.identity_reconciliation.rollback'],
      rows_per_transaction: 1,
    },
    forbidden_tables: [
      'message_queue',
      'channels',
      'channel_routing_policy',
      'agent_workspace_bindings',
      'agent_workspaces',
      'agent_runtime_instances',
      'agent_provider_identities',
      'agent_ui_bindings',
      'schema_migrations',
    ],
    cells_30_70_effect_count: 0,
  }
}

function denominatorSha256(agents: AgentPreimage[]): string {
  return canonicalSha256(agents.map(agent => ({
    agent_id: agent.agent_id,
    agent_type: agent.agent_type,
    profile_enabled: agent.profile_enabled,
    disabled_at: agent.disabled_at,
  })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)))
}

export async function buildRegistryIdentityReconciliationPlan(
  db: DbAdapter,
  rawInput: string | Uint8Array,
  evidenceBundle: RegistryEvidenceBundle,
): Promise<RegistryReconciliationPlan> {
  const { input, input_sha256 } = parseRegistryClassificationInput(rawInput)
  verifyEvidence(input, evidenceBundle)
  const allAgents = await readAgentRows(db)
  const selected = allAgents.filter(agent => agent.agent_type !== 'human' && agent.profile_enabled && agent.disabled_at === null)
  const exclusions = allAgents
    .filter(agent => !selected.includes(agent))
    .map(agent => ({
      agent_id: agent.agent_id,
      reason: agent.agent_type === 'human' ? 'human' as const : 'disabled_profile' as const,
    }))
    .sort((left, right) => left.agent_id.localeCompare(right.agent_id))
  const classificationMap = new Map(input.entries.map(entry => [entry.agent_id, entry]))
  const selectedIds = new Set(selected.map(agent => agent.agent_id))
  const missing = selected.filter(agent => !classificationMap.has(agent.agent_id)).map(agent => agent.agent_id)
  const unknown = input.entries.filter(entry => !selectedIds.has(entry.agent_id)).map(entry => entry.agent_id)
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`REGISTRY_RECONCILIATION_DENOMINATOR_MISMATCH: missing=${missing.sort().join(',')} unknown=${unknown.sort().join(',')}`)
  }
  const relatedRows = await readRelatedRows(db, [...selectedIds])
  const relatedByAgent = relatedReadSetByAgent(relatedRows)
  const basePlan: Omit<RegistryReconciliationPlan, 'plan_sha256'> = {
    schema_version: 'aun-registry-identity-reconciliation-plan/v1',
    control_source_ref: input.control_source_ref,
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    repo: REGISTRY_RECONCILIATION_REPOSITORY,
    base_commit: input.source_commit,
    base_tree: input.source_tree,
    input_manifest_sha256: input_sha256,
    entry_count: selected.length,
    denominator_sha256: denominatorSha256(allAgents),
    related_rows_sha256: canonicalSha256(relatedRows),
    entries: selected.map((preimage) => {
      const classification = classificationMap.get(preimage.agent_id)!
      const relatedReadSet = relatedByAgent.get(preimage.agent_id)
      if (!relatedReadSet) throw new Error(`REGISTRY_RECONCILIATION_RELATED_ROW_MISSING: ${preimage.agent_id}`)
      const postimage = postimageFor(preimage, classification, 'SELF')
      return {
        agent_id: preimage.agent_id,
        target_profile_class: classification.target_profile_class,
        evidence_ref: classification.evidence_ref,
        evidence_sha256: classification.evidence_sha256,
        agents_preimage: preimage,
        agents_preimage_sha256: canonicalSha256(preimage),
        related_read_set: relatedReadSet,
        related_read_set_sha256: canonicalSha256(relatedReadSet),
        proposed_metadata: postimage.metadata,
        proposed_profile_revision: postimage.profile_revision,
        proposed_profile_source: postimage.profile_source,
        proposed_postimage_sha256: 'SELF',
      }
    }).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
    exclusions: exclusions.map(exclusion => ({ ...exclusion, source_ref: input.control_source_ref })),
    permitted_effect: permittedEffect([...selectedIds]),
  }
  const planSha256 = registryPlanSha256(basePlan)
  for (const entry of basePlan.entries) {
    entry.proposed_metadata.profile_class_plan_sha256 = planSha256
    entry.proposed_postimage_sha256 = canonicalSha256(postimageFromPlanEntry(entry))
  }
  return { ...basePlan, plan_sha256: planSha256 }
}

export function verifyRegistryReconciliationPlan(plan: RegistryReconciliationPlan): void {
  if (plan.schema_version !== 'aun-registry-identity-reconciliation-plan/v1'
    || plan.control_source_ref !== REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF
    || plan.cell_id !== REGISTRY_RECONCILIATION_CELL_ID
    || plan.repo !== REGISTRY_RECONCILIATION_REPOSITORY
    || plan.entry_count !== plan.entries.length
    || !SHA256_RE.test(plan.plan_sha256)
    || registryPlanSha256(plan) !== plan.plan_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_PLAN_INVALID')
  }
  const orderedIds = plan.entries.map(entry => entry.agent_id)
  if (!sameCanonical(orderedIds, [...orderedIds].sort())
    || !sameCanonical(plan.permitted_effect, permittedEffect(orderedIds))) {
    throw new Error('REGISTRY_RECONCILIATION_PLAN_INVALID: ordering_or_permitted_effect')
  }
  for (const entry of plan.entries) {
    if (entry.proposed_metadata.profile_class_plan_sha256 !== plan.plan_sha256
      || entry.agents_preimage_sha256 !== canonicalSha256(entry.agents_preimage)
      || entry.related_read_set_sha256 !== canonicalSha256(entry.related_read_set)
      || entry.proposed_profile_revision !== entry.agents_preimage.profile_revision + 1
      || entry.proposed_profile_source !== REGISTRY_RECONCILIATION_PROFILE_SOURCE
      || entry.proposed_postimage_sha256 !== canonicalSha256(postimageFromPlanEntry(entry))) {
      throw new Error(`REGISTRY_RECONCILIATION_PLAN_INVALID: ${entry.agent_id}:plan_binding`)
    }
  }
}

function ownerDecisionBodyText(evidence: RegistryOwnerDecisionEvidence): string {
  const body = typeof evidence.body === 'string' ? evidence.body : Buffer.from(evidence.body).toString('utf8')
  const digest = sha256(typeof evidence.body === 'string' ? Buffer.from(evidence.body, 'utf8') : evidence.body)
  if (!SHA256_RE.test(evidence.body_sha256) || digest !== evidence.body_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_DIGEST_MISMATCH')
  }
  assertImmutableEvidenceRef(evidence.ref)
  return body
}

type RegistryOwnerDecisionPayload = {
  schema_version: 'shirube-v3/owner_decision/v1'
  decision_id: 'OD-AUN-001'
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  scope: 'CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001_registry_apply_only'
  action: 'apply' | 'rollback'
  verdict: 'APPROVED_EXACT_PLAN'
  actor: 'watchout'
  decision_ref: string
  repo: typeof REGISTRY_RECONCILIATION_REPOSITORY
  base_commit: string
  base_tree: string
  head_commit: string
  head_tree: string
  handoff_ref: typeof REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF
  handoff_sha256: typeof REGISTRY_RECONCILIATION_HANDOFF_SHA256
  implementation_pr_ref: string
  independent_audit_ref: string
  independent_audit_sha256: string
  input_manifest_ref: string
  input_manifest_sha256: string
  plan_ref: string
  plan_sha256: string
  ordered_agent_ids: string[]
  ordered_agent_count: number
  ordered_exclusions: RegistryReconciliationPlan['exclusions']
  ordered_exclusion_count: number
  per_row_digests: Array<{
    agent_id: string
    agents_preimage_sha256: string
    proposed_postimage_sha256: string
  }>
  permitted_effect: RegistryPermittedEffect
  apply_window_start: string
  apply_window_end: string
  readback_acceptance: string[]
  rollback_trigger: string[]
  rollback_receipt_contract: string[]
  forbidden_effects: {
    mcp: false
    queue: false
    schema: false
    endpoint: false
    activation: false
    restart: false
  }
}

const OWNER_DECISION_KEYS = [
  'schema_version', 'decision_id', 'cell_id', 'scope', 'action', 'verdict', 'actor', 'decision_ref',
  'repo', 'base_commit', 'base_tree', 'head_commit', 'head_tree', 'handoff_ref', 'handoff_sha256',
  'implementation_pr_ref', 'independent_audit_ref', 'independent_audit_sha256', 'input_manifest_ref',
  'input_manifest_sha256', 'plan_ref', 'plan_sha256', 'ordered_agent_ids', 'ordered_agent_count',
  'ordered_exclusions', 'ordered_exclusion_count', 'per_row_digests', 'permitted_effect',
  'apply_window_start', 'apply_window_end', 'readback_acceptance', 'rollback_trigger',
  'rollback_receipt_contract', 'forbidden_effects',
].sort()

function parseOwnerDecisionPayload(body: string): RegistryOwnerDecisionPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID: canonical_json_required')
  }
  assertPlainObject(parsed, 'owner_decision')
  if (body !== canonicalJson(parsed)
    || !sameCanonical(Object.keys(parsed).sort(), OWNER_DECISION_KEYS)) {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID: duplicate_extra_or_noncanonical_fields')
  }
  return parsed as RegistryOwnerDecisionPayload
}

function verifyOwnerDecision(
  evidence: RegistryOwnerDecisionEvidence,
  plan: RegistryReconciliationPlan,
  exactSubject: RegistryExactSubject,
  action: 'apply' | 'rollback',
  effectiveAt: string,
): RegistryOwnerDecisionPayload {
  const body = ownerDecisionBodyText(evidence)
  if (!/^https:\/\/github\.com\/watchout\/agent-comms-mcp\/issues\/602#issuecomment-\d+$/.test(evidence.ref)) {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')
  }
  const decision = parseOwnerDecisionPayload(body)
  const expectedPerRow = plan.entries.map(entry => ({
    agent_id: entry.agent_id,
    agents_preimage_sha256: entry.agents_preimage_sha256,
    proposed_postimage_sha256: entry.proposed_postimage_sha256,
  }))
  const windowStart = Date.parse(decision.apply_window_start)
  const windowEnd = Date.parse(decision.apply_window_end)
  const effective = Date.parse(effectiveAt)
  const refsValid = [decision.independent_audit_ref, decision.input_manifest_ref, decision.plan_ref]
    .every((ref) => {
      try { assertImmutableEvidenceRef(ref); return true } catch { return false }
    })
  const valid = decision.schema_version === 'shirube-v3/owner_decision/v1'
    && decision.decision_id === 'OD-AUN-001'
    && decision.cell_id === REGISTRY_RECONCILIATION_CELL_ID
    && decision.scope === 'CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001_registry_apply_only'
    && decision.action === action
    && decision.verdict === 'APPROVED_EXACT_PLAN'
    && decision.actor === 'watchout'
    && decision.decision_ref === evidence.ref
    && decision.repo === exactSubject.repo
    && decision.base_commit === exactSubject.base_commit
    && decision.base_tree === exactSubject.base_tree
    && decision.head_commit === exactSubject.head_commit
    && decision.head_tree === exactSubject.head_tree
    && decision.handoff_ref === REGISTRY_RECONCILIATION_CONTROL_SOURCE_REF
    && decision.handoff_sha256 === REGISTRY_RECONCILIATION_HANDOFF_SHA256
    && decision.implementation_pr_ref === exactSubject.implementation_pr_ref
    && SHA256_RE.test(decision.independent_audit_sha256)
    && decision.input_manifest_sha256 === plan.input_manifest_sha256
    && decision.plan_sha256 === plan.plan_sha256
    && refsValid
    && sameCanonical(decision.ordered_agent_ids, plan.entries.map(entry => entry.agent_id))
    && decision.ordered_agent_count === plan.entry_count
    && sameCanonical(decision.ordered_exclusions, plan.exclusions)
    && decision.ordered_exclusion_count === plan.exclusions.length
    && sameCanonical(decision.per_row_digests, expectedPerRow)
    && sameCanonical(decision.permitted_effect, plan.permitted_effect)
    && Number.isFinite(windowStart) && Number.isFinite(windowEnd) && Number.isFinite(effective)
    && windowStart <= effective && effective <= windowEnd && windowStart < windowEnd
    && sameCanonical(decision.readback_acceptance, [
      'all_plan_entries_match_postimage',
      'one_apply_audit_row_matches_receipt',
      'second_apply_is_verified_noop',
    ])
    && sameCanonical(decision.rollback_trigger, [
      'any_postimage_drift',
      'readback_mismatch',
      'operator_requested_rollback',
    ])
    && sameCanonical(decision.rollback_receipt_contract, [
      'confirm_receipt_sha256',
      'audited_apply_receipt_required',
      'exact_postimage_match_required',
      'restore_exact_preimages',
    ])
    && sameCanonical(decision.forbidden_effects, {
      activation: false,
      endpoint: false,
      mcp: false,
      queue: false,
      restart: false,
      schema: false,
    })
  if (!valid) throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID: exact_payload_mismatch')
  return decision
}

function semanticPostimageFromAgent(agent: AgentPreimage): AgentSemanticPostimage {
  return {
    agent_id: agent.agent_id,
    metadata: agent.metadata,
    profile_revision: agent.profile_revision,
    profile_source: agent.profile_source as typeof REGISTRY_RECONCILIATION_PROFILE_SOURCE,
  }
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function verifyExactSubject(plan: RegistryReconciliationPlan, subject: RegistryExactSubject): void {
  if (subject.repo !== plan.repo
    || subject.base_commit !== plan.base_commit
    || subject.base_tree !== plan.base_tree
    || subject.implementation_pr_ref !== REGISTRY_RECONCILIATION_IMPLEMENTATION_PR_REF
    || !GIT_SHA_RE.test(subject.head_commit)
    || !GIT_SHA_RE.test(subject.head_tree)) {
    throw new Error('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')
  }
}

function receiptFor(
  plan: RegistryReconciliationPlan,
  ownerDecision: RegistryOwnerDecisionEvidence,
  exactSubject: RegistryExactSubject,
  appliedAt: string,
): RegistryApplyReceipt {
  return {
    schema_version: 'aun-registry-identity-reconciliation-apply-receipt/v1',
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    plan_sha256: plan.plan_sha256,
    input_manifest_sha256: plan.input_manifest_sha256,
    related_rows_sha256: plan.related_rows_sha256,
    owner_decision_ref: ownerDecision.ref,
    owner_decision_body_sha256: ownerDecision.body_sha256,
    exact_subject: exactSubject,
    applied_at: appliedAt,
    plan,
    entries: plan.entries.map(entry => ({
      agent_id: entry.agent_id,
      preimage: entry.agents_preimage,
      postimage: postimageFromPlanEntry(entry),
    })),
  }
}

export async function applyRegistryIdentityReconciliation(
  db: DbAdapter,
  plan: RegistryReconciliationPlan,
  options: {
    confirm_plan_sha256: string
    owner_decision: RegistryOwnerDecisionEvidence
    raw_input: string | Uint8Array
    evidence_bundle: RegistryEvidenceBundle
    exact_subject: RegistryExactSubject
    now?: () => Date
  },
): Promise<RegistryApplyResult> {
  verifyRegistryReconciliationPlan(plan)
  if (options.confirm_plan_sha256 !== plan.plan_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_CONFIRM_PLAN_SHA256_MISMATCH')
  }
  verifyExactSubject(plan, options.exact_subject)
  const appliedAt = (options.now?.() ?? new Date()).toISOString()
  verifyOwnerDecision(options.owner_decision, plan, options.exact_subject, 'apply', appliedAt)
  const currentInput = parseRegistryClassificationInput(options.raw_input)
  verifyEvidence(currentInput.input, options.evidence_bundle)
  if (currentInput.input_sha256 !== plan.input_manifest_sha256
    || currentInput.input.control_source_ref !== plan.control_source_ref
    || currentInput.input.source_commit !== plan.base_commit
    || currentInput.input.source_tree !== plan.base_tree
    || options.exact_subject.repo !== plan.repo
    || options.exact_subject.base_commit !== plan.base_commit
    || options.exact_subject.base_tree !== plan.base_tree) {
    throw new Error('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')
  }
  const planClassifications = plan.entries.map(entry => ({
    agent_id: entry.agent_id,
    target_profile_class: entry.target_profile_class,
    evidence_ref: entry.evidence_ref,
    evidence_sha256: entry.evidence_sha256,
  }))
  if (!sameCanonical(currentInput.input.entries, planClassifications)) {
    throw new Error('REGISTRY_RECONCILIATION_CLASSIFICATION_DRIFT')
  }
  return db.transaction(async (tx) => {
    await lockRegistryReconciliationReadSet(tx)
    const agents = await readAgentRows(tx, true)
    if (denominatorSha256(agents) !== plan.denominator_sha256) {
      throw new Error('REGISTRY_RECONCILIATION_DENOMINATOR_DRIFT')
    }
    const currentMap = new Map(agents.map(agent => [agent.agent_id, agent]))
    const expectedIds = plan.entries.map(entry => entry.agent_id)
    const relatedRows = await readRelatedRows(tx, expectedIds)
    if (canonicalSha256(relatedRows) !== plan.related_rows_sha256) {
      throw new Error('REGISTRY_RECONCILIATION_RELATED_ROW_DRIFT')
    }
    const relatedByAgent = relatedReadSetByAgent(relatedRows)
    if (plan.entries.some(entry => canonicalSha256(relatedByAgent.get(entry.agent_id)) !== entry.related_read_set_sha256)) {
      throw new Error('REGISTRY_RECONCILIATION_RELATED_ROW_DRIFT')
    }
    const states = plan.entries.map((entry) => {
      const current = currentMap.get(entry.agent_id)
      if (!current) return 'drift' as const
      if (sameCanonical(current, entry.agents_preimage)) return 'preimage' as const
      if (sameCanonical(semanticPostimageFromAgent(current), postimageFromPlanEntry(entry))) return 'postimage' as const
      return 'drift' as const
    })
    if (states.some(state => state === 'drift') || (states.includes('preimage') && states.includes('postimage'))) {
      throw new Error('REGISTRY_RECONCILIATION_AGENT_ROW_DRIFT')
    }
    if (states.every(state => state === 'postimage')) {
      const updatedAtValues = plan.entries.map(entry => currentMap.get(entry.agent_id)?.profile_updated_at ?? null)
      const existingAppliedAt = updatedAtValues[0]
      if (!existingAppliedAt || updatedAtValues.some(value => value !== existingAppliedAt)) {
        throw new Error('REGISTRY_RECONCILIATION_POSTIMAGE_TIMESTAMP_DRIFT')
      }
      const receipt = receiptFor(plan, options.owner_decision, options.exact_subject, existingAppliedAt)
      const receiptSha256 = canonicalSha256(receipt)
      const audits = await tx.query<any>(
        `SELECT detail FROM audit_log
          WHERE event_type = $1 AND target = $2
          ORDER BY created_at DESC`,
        ['registry.identity_reconciliation.apply', REGISTRY_RECONCILIATION_CELL_ID],
      )
      const priorAudit = audits.some((row) => {
        const detail = parseJsonObject(row.detail)
        return detail.plan_sha256 === plan.plan_sha256 && detail.receipt_sha256 === receiptSha256
      })
      if (!priorAudit) throw new Error('REGISTRY_RECONCILIATION_PRIOR_APPLY_EVIDENCE_MISSING')
      return {
        ok: true,
        status: 'already_applied',
        plan_sha256: plan.plan_sha256,
        affected_agents: 0,
        audit_rows: 0,
        receipt,
        receipt_sha256: receiptSha256,
      }
    }
    const receipt = receiptFor(plan, options.owner_decision, options.exact_subject, appliedAt)
    const receiptSha256 = canonicalSha256(receipt)
    for (const entry of plan.entries) {
      const result = await tx.execute(
        `UPDATE agents
            SET metadata = $1, profile_revision = $2, profile_source = $3, profile_updated_at = $4
          WHERE agent_id = $5 AND profile_revision = $6`,
        [
          JSON.stringify(entry.proposed_metadata),
          entry.proposed_profile_revision,
          entry.proposed_profile_source,
          appliedAt,
          entry.agent_id,
          entry.agents_preimage.profile_revision,
        ],
      )
      if (result.rowCount !== 1) throw new Error(`REGISTRY_RECONCILIATION_AFFECTED_ROW_MISMATCH: ${entry.agent_id}`)
    }
    const audit = await tx.execute(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'registry.identity_reconciliation.apply',
        'aun',
        REGISTRY_RECONCILIATION_CELL_ID,
        JSON.stringify({ plan_sha256: plan.plan_sha256, receipt_sha256: receiptSha256, affected_agents: plan.entries.length }),
        'default',
      ],
    )
    if (audit.rowCount !== 1) throw new Error('REGISTRY_RECONCILIATION_AUDIT_ROW_MISMATCH')
    return {
      ok: true,
      status: 'applied',
      plan_sha256: plan.plan_sha256,
      affected_agents: plan.entries.length,
      audit_rows: 1,
      receipt,
      receipt_sha256: receiptSha256,
    }
  })
}

export async function readRegistryIdentityReconciliationState(
  db: DbAdapter,
  plan: RegistryReconciliationPlan,
): Promise<{
  ok: boolean
  plan_sha256: string
  denominator_match: boolean
  related_rows_match: boolean
  agents: Array<{ agent_id: string; state: 'preimage' | 'postimage' | 'drift' | 'missing' }>
}> {
  verifyRegistryReconciliationPlan(plan)
  const currentRows = await readAgentRows(db)
  const current = new Map(currentRows.map(agent => [agent.agent_id, agent]))
  const denominatorMatch = denominatorSha256(currentRows) === plan.denominator_sha256
  const relatedRowsMatch = canonicalSha256(await readRelatedRows(db, plan.entries.map(entry => entry.agent_id))) === plan.related_rows_sha256
  const agents = plan.entries.map((entry) => {
    const row = current.get(entry.agent_id)
    const state = !row
      ? 'missing' as const
      : sameCanonical(row, entry.agents_preimage)
        ? 'preimage' as const
        : sameCanonical(semanticPostimageFromAgent(row), postimageFromPlanEntry(entry))
          ? 'postimage' as const
          : 'drift' as const
    return { agent_id: entry.agent_id, state }
  })
  return {
    ok: denominatorMatch && relatedRowsMatch && agents.every(agent => agent.state === 'postimage'),
    plan_sha256: plan.plan_sha256,
    denominator_match: denominatorMatch,
    related_rows_match: relatedRowsMatch,
    agents,
  }
}

export async function rollbackRegistryIdentityReconciliation(
  db: DbAdapter,
  receipt: RegistryApplyReceipt,
  options: {
    confirm_receipt_sha256: string
    owner_decision: RegistryOwnerDecisionEvidence
    exact_subject: RegistryExactSubject
    now?: () => Date
  },
): Promise<RegistryRollbackResult> {
  if (receipt.schema_version !== 'aun-registry-identity-reconciliation-apply-receipt/v1'
    || receipt.cell_id !== REGISTRY_RECONCILIATION_CELL_ID
    || receipt.plan?.plan_sha256 !== receipt.plan_sha256
    || receipt.input_manifest_sha256 !== receipt.plan?.input_manifest_sha256
    || !sameCanonical(receipt.exact_subject, options.exact_subject)
    || !sameCanonical(receipt.entries, receipt.plan?.entries.map(entry => ({
      agent_id: entry.agent_id,
      preimage: entry.agents_preimage,
      postimage: postimageFromPlanEntry(entry),
    })))
    || canonicalSha256(receipt) !== options.confirm_receipt_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_RECEIPT_INVALID')
  }
  verifyRegistryReconciliationPlan(receipt.plan)
  verifyExactSubject(receipt.plan, options.exact_subject)
  const rolledBackAt = (options.now?.() ?? new Date()).toISOString()
  verifyOwnerDecision(options.owner_decision, receipt.plan, options.exact_subject, 'rollback', rolledBackAt)
  return db.transaction(async (tx) => {
    await lockRegistryReconciliationReadSet(tx)
    const current = new Map((await readAgentRows(tx, true)).map(agent => [agent.agent_id, agent]))
    const audits = await tx.query<any>(
      `SELECT detail FROM audit_log
        WHERE event_type = $1 AND target = $2
        ORDER BY created_at DESC`,
      ['registry.identity_reconciliation.apply', REGISTRY_RECONCILIATION_CELL_ID],
    )
    if (!audits.some((row) => parseJsonObject(row.detail).receipt_sha256 === options.confirm_receipt_sha256)) {
      throw new Error('REGISTRY_RECONCILIATION_APPLY_RECEIPT_NOT_AUDITED')
    }
    for (const entry of receipt.entries) {
      const row = current.get(entry.agent_id)
      if (!row
        || !sameCanonical(semanticPostimageFromAgent(row), entry.postimage)
        || row.profile_updated_at !== receipt.applied_at) {
        throw new Error(`REGISTRY_RECONCILIATION_ROLLBACK_POSTIMAGE_DRIFT: ${entry.agent_id}`)
      }
    }
    for (const entry of receipt.entries) {
      const result = await tx.execute(
        `UPDATE agents
            SET metadata = $1, profile_revision = $2, profile_source = $3, profile_updated_at = $4
          WHERE agent_id = $5 AND profile_revision = $6`,
        [
          JSON.stringify(entry.preimage.metadata),
          entry.preimage.profile_revision,
          entry.preimage.profile_source,
          entry.preimage.profile_updated_at,
          entry.agent_id,
          entry.postimage.profile_revision,
        ],
      )
      if (result.rowCount !== 1) throw new Error(`REGISTRY_RECONCILIATION_ROLLBACK_AFFECTED_ROW_MISMATCH: ${entry.agent_id}`)
    }
    const audit = await tx.execute(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'registry.identity_reconciliation.rollback',
        'aun',
        REGISTRY_RECONCILIATION_CELL_ID,
        JSON.stringify({ plan_sha256: receipt.plan_sha256, apply_receipt_sha256: options.confirm_receipt_sha256, affected_agents: receipt.entries.length }),
        'default',
      ],
    )
    if (audit.rowCount !== 1) throw new Error('REGISTRY_RECONCILIATION_ROLLBACK_AUDIT_ROW_MISMATCH')
    return {
      ok: true,
      status: 'rolled_back',
      plan_sha256: receipt.plan_sha256,
      affected_agents: receipt.entries.length,
      audit_rows: 1,
      rolled_back_at: rolledBackAt,
    }
  })
}

export function ownedRegistryMetadataKeys(): readonly string[] {
  return OWNED_METADATA_KEYS
}
