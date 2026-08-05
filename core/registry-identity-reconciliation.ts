import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'
import { parseJsonObject, profileEnabled, type AuthoritativeProfileClass } from './profile-classification'

export const REGISTRY_RECONCILIATION_CELL_ID = 'CELL-AUN-REGISTRY-IDENTITY-RECONCILIATION-001'
export const REGISTRY_RECONCILIATION_PROFILE_SOURCE = REGISTRY_RECONCILIATION_CELL_ID

export type RegistryClassificationInput = {
  schema_version: 'aun-registry-classification-input/v1'
  target_repository: string
  base_commit: string
  base_tree: string
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  classifications: Array<{
    agent_id: string
    profile_class: AuthoritativeProfileClass
    source_ref: string
    source_sha256: string
  }>
}

export type RegistryEvidenceBundle = Record<
  string,
  string | { encoding: 'utf8' | 'base64'; data: string }
>

type AgentPreimage = {
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
}

type AgentSemanticPostimage = {
  agent_id: string
  metadata: Record<string, unknown>
  profile_revision: number
  profile_source: typeof REGISTRY_RECONCILIATION_PROFILE_SOURCE
}

export type RegistryReconciliationPlanEntry = {
  agent_id: string
  profile_class: AuthoritativeProfileClass
  source_ref: string
  source_sha256: string
  preimage: AgentPreimage
  postimage: AgentSemanticPostimage
}

export type RegistryReconciliationPlan = {
  schema_version: 'aun-registry-identity-reconciliation-plan/v1'
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  target_repository: string
  base_commit: string
  base_tree: string
  input_sha256: string
  denominator_sha256: string
  related_rows_sha256: string
  entries: RegistryReconciliationPlanEntry[]
  exclusions: Array<{ agent_id: string; reason: 'disabled_profile' | 'human' }>
  effects: {
    agents_metadata_profile_fields: number
    audit_log_rows: 1
    cells_30_70_effects: 0
  }
  plan_sha256: string
}

export type RegistryOwnerDecisionEvidence = {
  ref: string
  body: string | Uint8Array
  body_sha256: string
}

export type RegistryApplyReceipt = {
  schema_version: 'aun-registry-identity-reconciliation-apply-receipt/v1'
  cell_id: typeof REGISTRY_RECONCILIATION_CELL_ID
  plan_sha256: string
  input_sha256: string
  related_rows_sha256: string
  owner_decision_ref: string
  owner_decision_body_sha256: string
  applied_at: string
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
  if (value.cell_id !== REGISTRY_RECONCILIATION_CELL_ID) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: cell_id')
  }
  if (typeof value.target_repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.target_repository)) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: target_repository')
  }
  if (typeof value.base_commit !== 'string' || !GIT_SHA_RE.test(value.base_commit)) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: base_commit')
  }
  if (typeof value.base_tree !== 'string' || !GIT_SHA_RE.test(value.base_tree)) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: base_tree')
  }
  if (!Array.isArray(value.classifications) || value.classifications.length === 0) {
    throw new Error('REGISTRY_RECONCILIATION_INPUT_INVALID: classifications')
  }
  const seen = new Set<string>()
  const classifications = value.classifications.map((rawEntry, index) => {
    assertPlainObject(rawEntry, `classifications[${index}]`)
    const agentId = typeof rawEntry.agent_id === 'string' ? rawEntry.agent_id.trim() : ''
    const profileClass = rawEntry.profile_class
    const sourceRef = typeof rawEntry.source_ref === 'string' ? rawEntry.source_ref.trim() : ''
    const sourceSha = typeof rawEntry.source_sha256 === 'string' ? rawEntry.source_sha256.toLowerCase() : ''
    if (!agentId || seen.has(agentId)) throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: duplicate_or_empty_agent_id:${agentId}`)
    if (profileClass !== 'production' && profileClass !== 'test') throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: ${agentId}:profile_class`)
    assertImmutableEvidenceRef(sourceRef)
    if (!SHA256_RE.test(sourceSha)) throw new Error(`REGISTRY_RECONCILIATION_INPUT_INVALID: ${agentId}:source_sha256`)
    seen.add(agentId)
    return { agent_id: agentId, profile_class: profileClass, source_ref: sourceRef, source_sha256: sourceSha }
  }).sort((left, right) => left.agent_id.localeCompare(right.agent_id))
  const input: RegistryClassificationInput = {
    schema_version: 'aun-registry-classification-input/v1',
    target_repository: value.target_repository,
    base_commit: value.base_commit,
    base_tree: value.base_tree,
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    classifications,
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
  for (const entry of input.classifications) {
    if (!Object.prototype.hasOwnProperty.call(bundle, entry.source_ref)) {
      throw new Error(`REGISTRY_RECONCILIATION_EVIDENCE_MISSING: ${entry.agent_id}:${entry.source_ref}`)
    }
    const actual = sha256(evidenceBytes(bundle[entry.source_ref]))
    if (actual !== entry.source_sha256) {
      throw new Error(`REGISTRY_RECONCILIATION_EVIDENCE_DIGEST_MISMATCH: ${entry.agent_id}:${entry.source_ref}`)
    }
  }
}

async function readAgentRows(db: DbAdapter, lock = false): Promise<AgentPreimage[]> {
  const rows = await db.query<any>(
    `SELECT agent_id, org_id, agent_type, status, profile_enabled, disabled_at,
            metadata, profile_revision, profile_source, profile_updated_at
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
  const rows: unknown[] = []
  for (const agentId of [...agentIds].sort()) {
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
  const idSet = new Set(agentIds)
  const channelRows = await db.query<any>(
    `SELECT c.id AS channel_id, c.members, p.primary_agent_id, p.adapter_owner_agent_id,
            p.outbound_allowlist, p.native_role_outbound_owners,
            p.native_projection_identities, p.policy_source
       FROM channels c
       LEFT JOIN channel_routing_policy p ON p.channel_id = c.id
      ORDER BY c.id`,
  )
  const relevantChannels = channelRows.filter((row) => {
    const candidates = [
      ...arrayText(row.members),
      ...arrayText(row.outbound_allowlist),
      String(row.primary_agent_id ?? ''),
      String(row.adapter_owner_agent_id ?? ''),
    ]
    const nativeOwners = parseJsonObject(row.native_role_outbound_owners)
    const nativeIdentities = parseJsonObject(row.native_projection_identities)
    return candidates.some(candidate => idSet.has(candidate))
      || Object.keys(nativeOwners).some(key => idSet.has(key))
      || Object.values(nativeOwners).some(value => idSet.has(String(value)))
      || Object.keys(nativeIdentities).some(key => idSet.has(key))
      || Object.values(nativeIdentities).some(value => idSet.has(String(value)))
  })
  rows.push({ channels: relevantChannels })
  return normalizeDbValue(rows) as unknown[]
}

function planHashMaterial(plan: Omit<RegistryReconciliationPlan, 'plan_sha256'> | RegistryReconciliationPlan): unknown {
  const material = structuredClone(plan) as RegistryReconciliationPlan
  delete (material as Partial<RegistryReconciliationPlan>).plan_sha256
  for (const entry of material.entries) {
    entry.postimage.metadata.profile_class_plan_sha256 = 'SELF'
  }
  return material
}

export function registryPlanSha256(plan: Omit<RegistryReconciliationPlan, 'plan_sha256'> | RegistryReconciliationPlan): string {
  return canonicalSha256(planHashMaterial(plan))
}

function postimageFor(
  preimage: AgentPreimage,
  classification: RegistryClassificationInput['classifications'][number],
  planSha256: string,
): AgentSemanticPostimage {
  const metadata = { ...preimage.metadata }
  metadata.profile_class = classification.profile_class
  metadata.profile_class_source_ref = classification.source_ref
  metadata.profile_class_source_sha256 = classification.source_sha256
  metadata.profile_class_plan_sha256 = planSha256
  return {
    agent_id: preimage.agent_id,
    metadata,
    profile_revision: preimage.profile_revision + 1,
    profile_source: REGISTRY_RECONCILIATION_PROFILE_SOURCE,
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
  const classificationMap = new Map(input.classifications.map(entry => [entry.agent_id, entry]))
  const selectedIds = new Set(selected.map(agent => agent.agent_id))
  const missing = selected.filter(agent => !classificationMap.has(agent.agent_id)).map(agent => agent.agent_id)
  const unknown = input.classifications.filter(entry => !selectedIds.has(entry.agent_id)).map(entry => entry.agent_id)
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`REGISTRY_RECONCILIATION_DENOMINATOR_MISMATCH: missing=${missing.sort().join(',')} unknown=${unknown.sort().join(',')}`)
  }
  const relatedRows = await readRelatedRows(db, [...selectedIds])
  const basePlan: Omit<RegistryReconciliationPlan, 'plan_sha256'> = {
    schema_version: 'aun-registry-identity-reconciliation-plan/v1',
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    target_repository: input.target_repository,
    base_commit: input.base_commit,
    base_tree: input.base_tree,
    input_sha256,
    denominator_sha256: denominatorSha256(allAgents),
    related_rows_sha256: canonicalSha256(relatedRows),
    entries: selected.map((preimage) => {
      const classification = classificationMap.get(preimage.agent_id)!
      return {
        agent_id: preimage.agent_id,
        profile_class: classification.profile_class,
        source_ref: classification.source_ref,
        source_sha256: classification.source_sha256,
        preimage,
        postimage: postimageFor(preimage, classification, 'SELF'),
      }
    }).sort((left, right) => left.agent_id.localeCompare(right.agent_id)),
    exclusions,
    effects: {
      agents_metadata_profile_fields: selected.length,
      audit_log_rows: 1,
      cells_30_70_effects: 0,
    },
  }
  const planSha256 = registryPlanSha256(basePlan)
  for (const entry of basePlan.entries) {
    entry.postimage.metadata.profile_class_plan_sha256 = planSha256
  }
  return { ...basePlan, plan_sha256: planSha256 }
}

export function verifyRegistryReconciliationPlan(plan: RegistryReconciliationPlan): void {
  if (plan.schema_version !== 'aun-registry-identity-reconciliation-plan/v1'
    || plan.cell_id !== REGISTRY_RECONCILIATION_CELL_ID
    || !SHA256_RE.test(plan.plan_sha256)
    || registryPlanSha256(plan) !== plan.plan_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_PLAN_INVALID')
  }
  for (const entry of plan.entries) {
    if (entry.postimage.metadata.profile_class_plan_sha256 !== plan.plan_sha256) {
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

function verifyOwnerDecision(evidence: RegistryOwnerDecisionEvidence, planSha256: string, action: 'apply' | 'rollback'): void {
  const body = ownerDecisionBodyText(evidence)
  if (!/^https:\/\/github\.com\/watchout\/agent-comms-mcp\/issues\/602#issuecomment-\d+$/.test(evidence.ref)) {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')
  }
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exactLine = (key: string, value: string) => new RegExp(`^${key}:\\s*["']?${escaped(value)}["']?\\s*$`, 'm')
  const required = [
    exactLine('decision_id', 'OD-AUN-001'),
    exactLine('cell_id', REGISTRY_RECONCILIATION_CELL_ID),
    exactLine('plan_sha256', planSha256),
    exactLine('action', action),
    exactLine('verdict', 'APPROVED_EXACT_PLAN'),
    exactLine('actor', 'watchout'),
    exactLine('decision_ref', evidence.ref),
  ]
  if (required.some(pattern => !pattern.test(body))) {
    throw new Error('REGISTRY_RECONCILIATION_OWNER_DECISION_INVALID')
  }
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

function receiptFor(
  plan: RegistryReconciliationPlan,
  ownerDecision: RegistryOwnerDecisionEvidence,
  appliedAt: string,
): RegistryApplyReceipt {
  return {
    schema_version: 'aun-registry-identity-reconciliation-apply-receipt/v1',
    cell_id: REGISTRY_RECONCILIATION_CELL_ID,
    plan_sha256: plan.plan_sha256,
    input_sha256: plan.input_sha256,
    related_rows_sha256: plan.related_rows_sha256,
    owner_decision_ref: ownerDecision.ref,
    owner_decision_body_sha256: ownerDecision.body_sha256,
    applied_at: appliedAt,
    entries: plan.entries.map(entry => ({
      agent_id: entry.agent_id,
      preimage: entry.preimage,
      postimage: entry.postimage,
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
    exact_subject: {
      target_repository: string
      base_commit: string
      base_tree: string
    }
    now?: () => Date
  },
): Promise<RegistryApplyResult> {
  verifyRegistryReconciliationPlan(plan)
  if (options.confirm_plan_sha256 !== plan.plan_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_CONFIRM_PLAN_SHA256_MISMATCH')
  }
  verifyOwnerDecision(options.owner_decision, plan.plan_sha256, 'apply')
  const currentInput = parseRegistryClassificationInput(options.raw_input)
  verifyEvidence(currentInput.input, options.evidence_bundle)
  if (currentInput.input_sha256 !== plan.input_sha256
    || currentInput.input.target_repository !== plan.target_repository
    || currentInput.input.base_commit !== plan.base_commit
    || currentInput.input.base_tree !== plan.base_tree
    || options.exact_subject.target_repository !== plan.target_repository
    || options.exact_subject.base_commit !== plan.base_commit
    || options.exact_subject.base_tree !== plan.base_tree) {
    throw new Error('REGISTRY_RECONCILIATION_EXACT_SUBJECT_OR_INPUT_DRIFT')
  }
  const planClassifications = plan.entries.map(entry => ({
    agent_id: entry.agent_id,
    profile_class: entry.profile_class,
    source_ref: entry.source_ref,
    source_sha256: entry.source_sha256,
  }))
  if (!sameCanonical(currentInput.input.classifications, planClassifications)) {
    throw new Error('REGISTRY_RECONCILIATION_CLASSIFICATION_DRIFT')
  }
  const appliedAt = (options.now?.() ?? new Date()).toISOString()
  return db.transaction(async (tx) => {
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
    const states = plan.entries.map((entry) => {
      const current = currentMap.get(entry.agent_id)
      if (!current) return 'drift' as const
      if (sameCanonical(current, entry.preimage)) return 'preimage' as const
      if (sameCanonical(semanticPostimageFromAgent(current), entry.postimage)) return 'postimage' as const
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
      const receipt = receiptFor(plan, options.owner_decision, existingAppliedAt)
      const receiptSha256 = canonicalSha256(receipt)
      const audits = await tx.query<any>(
        `SELECT detail FROM audit_log
          WHERE event_type = $1 AND target = $2
          ORDER BY created_at DESC`,
        ['registry_identity_reconciliation.apply', REGISTRY_RECONCILIATION_CELL_ID],
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
    const receipt = receiptFor(plan, options.owner_decision, appliedAt)
    const receiptSha256 = canonicalSha256(receipt)
    for (const entry of plan.entries) {
      const result = await tx.execute(
        `UPDATE agents
            SET metadata = $1, profile_revision = $2, profile_source = $3, profile_updated_at = $4
          WHERE agent_id = $5 AND profile_revision = $6`,
        [
          JSON.stringify(entry.postimage.metadata),
          entry.postimage.profile_revision,
          entry.postimage.profile_source,
          appliedAt,
          entry.agent_id,
          entry.preimage.profile_revision,
        ],
      )
      if (result.rowCount !== 1) throw new Error(`REGISTRY_RECONCILIATION_AFFECTED_ROW_MISMATCH: ${entry.agent_id}`)
    }
    const audit = await tx.execute(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'registry_identity_reconciliation.apply',
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
      : sameCanonical(row, entry.preimage)
        ? 'preimage' as const
        : sameCanonical(semanticPostimageFromAgent(row), entry.postimage)
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
    now?: () => Date
  },
): Promise<RegistryRollbackResult> {
  if (receipt.schema_version !== 'aun-registry-identity-reconciliation-apply-receipt/v1'
    || receipt.cell_id !== REGISTRY_RECONCILIATION_CELL_ID
    || canonicalSha256(receipt) !== options.confirm_receipt_sha256) {
    throw new Error('REGISTRY_RECONCILIATION_RECEIPT_INVALID')
  }
  verifyOwnerDecision(options.owner_decision, receipt.plan_sha256, 'rollback')
  const rolledBackAt = (options.now?.() ?? new Date()).toISOString()
  return db.transaction(async (tx) => {
    const current = new Map((await readAgentRows(tx, true)).map(agent => [agent.agent_id, agent]))
    const audits = await tx.query<any>(
      `SELECT detail FROM audit_log
        WHERE event_type = $1 AND target = $2
        ORDER BY created_at DESC`,
      ['registry_identity_reconciliation.apply', REGISTRY_RECONCILIATION_CELL_ID],
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
        'registry_identity_reconciliation.rollback',
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
