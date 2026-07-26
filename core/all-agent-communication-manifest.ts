import { canonicalJson, sha256Utf8 } from './eventlog/transport-contract'

export const ALL_AGENT_COMMUNICATION_MANIFEST_SCHEMA_VERSION = 'all-agent-communication-manifest/v1' as const

export const ALL_AGENT_COMMUNICATION_ACTIVE_FUNCTIONS = [
  'control_source_author',
  'control_artifact_author',
  'coordination_recorder',
  'implementation_executor',
  'evidence_audit_gate',
  'scenario_verification_gate',
  'operator_acceptance_gate',
  'protected_surface_gate',
  'orchestration_controller',
  'runtime_recovery_executor',
  'revenue_demand_owner',
  'revenue_sales_owner',
] as const

export type AllAgentCommunicationActiveFunction = (typeof ALL_AGENT_COMMUNICATION_ACTIVE_FUNCTIONS)[number]
export type AllAgentCommunicationDiscordMode = 'native_verified' | 'aun_gateway_projection'

export interface AllAgentCommunicationManifestTargetV1 {
  agent_id: string
  target_repository: string
  control_source: string
  active_function: AllAgentCommunicationActiveFunction
  workspace_id: string
  workspace_path: string
  runtime_engine: 'codex-exec' | 'claude-exec'
  runtime_profile_ref: string
  provider_identity_ref: string
  communication_auto_receive: boolean
  protected_d1: boolean
  discord_mode: AllAgentCommunicationDiscordMode
}

export interface AllAgentCommunicationManifestV1 {
  schema_version: typeof ALL_AGENT_COMMUNICATION_MANIFEST_SCHEMA_VERSION
  manifest_id: string
  revision: number
  issued_at: string
  not_before: string
  expires_at: string
  owner_decision_ref: string
  owner_pinned_digest: string
  sorted_exact_target_tuples: AllAgentCommunicationManifestTargetV1[]
  target_count: number
  target_sha256: string
  release_commit: string
  release_tree: string
  artifact_digest: string
  policy_digest: string
  revoked_or_superseded_refs: string[]
}

export type AllAgentCommunicationManifestCode =
  | 'ADMITTED'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_UNTRUSTED'
  | 'MANIFEST_NOT_YET_VALID'
  | 'MANIFEST_EXPIRED'
  | 'MANIFEST_REVOKED'
  | 'MANIFEST_ROLLBACK_REJECTED'
  | 'MANIFEST_EQUIVOCATION'
  | 'MANIFEST_OWNER_DECISION_REQUIRED'
  | 'PROJECTION_TRUST_MISMATCH'
  | 'TARGET_DRIFT'
  | 'ORDINARY_AUTO_RECEIVE_DISABLED'

export class AllAgentCommunicationManifestError extends Error {
  constructor(readonly code: AllAgentCommunicationManifestCode, message: string) {
    super(`${code}: ${message}`)
  }
}

export interface AllAgentCommunicationManifestProjection {
  manifest_id: string
  revision: number
  artifact_digest: string
  target_sha256: string
  owner_decision_ref: string
}

export interface AllAgentCommunicationManifestEvaluationContext {
  now: string | Date
  trusted_owner_decision_ref: string
  trusted_owner_pinned_digest: string
  current_projection?: AllAgentCommunicationManifestProjection | null
  observed_targets?: AllAgentCommunicationManifestTargetV1[] | null
  revoked_refs?: string[]
}

export interface AllAgentCommunicationManifestEvaluation {
  ok: boolean
  code: AllAgentCommunicationManifestCode
  manifest: AllAgentCommunicationManifestV1 | null
  canonical_bytes: string | null
  canonical_bytes_sha256: string | null
  target_sha256: string | null
  target_count: number
  drift: string[]
}

const TARGET_KEYS = [
  'agent_id',
  'target_repository',
  'control_source',
  'active_function',
  'workspace_id',
  'workspace_path',
  'runtime_engine',
  'runtime_profile_ref',
  'provider_identity_ref',
  'communication_auto_receive',
  'protected_d1',
  'discord_mode',
] as const

const MANIFEST_KEYS = [
  'schema_version',
  'manifest_id',
  'revision',
  'issued_at',
  'not_before',
  'expires_at',
  'owner_decision_ref',
  'owner_pinned_digest',
  'sorted_exact_target_tuples',
  'target_count',
  'target_sha256',
  'release_commit',
  'release_tree',
  'artifact_digest',
  'policy_digest',
  'revoked_or_superseded_refs',
] as const

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    const missing = expected.filter(key => !actual.includes(key))
    const extra = actual.filter(key => !expected.includes(key))
    throw new AllAgentCommunicationManifestError(
      'MANIFEST_INVALID',
      `${field} is not closed-world missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    )
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be a non-empty string`)
  }
  return value
}

function sha256(value: unknown, field: string): string {
  const text = nonEmptyString(value, field)
  if (!/^[0-9a-f]{64}$/.test(text)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be lowercase sha256`)
  }
  return text
}

function gitSha(value: unknown, field: string): string {
  const text = nonEmptyString(value, field)
  if (!/^[0-9a-f]{40}$/.test(text)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be a full lowercase git sha`)
  }
  return text
}

function rfc3339(value: unknown, field: string): string {
  const text = nonEmptyString(value, field)
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be RFC3339`)
  }
  return text
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be an explicit boolean`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `${field} must be a positive safe integer`)
  }
  return Number(value)
}

function parseTarget(value: unknown, index: number): AllAgentCommunicationManifestTargetV1 {
  const raw = record(value, `sorted_exact_target_tuples[${index}]`)
  exactKeys(raw, TARGET_KEYS, `sorted_exact_target_tuples[${index}]`)
  const agentId = nonEmptyString(raw.agent_id, `target[${index}].agent_id`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].agent_id is not canonical`)
  }
  const repository = nonEmptyString(raw.target_repository, `target[${index}].target_repository`)
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].target_repository must be owner/repo`)
  }
  const activeFunction = nonEmptyString(raw.active_function, `target[${index}].active_function`)
  if (!(ALL_AGENT_COMMUNICATION_ACTIVE_FUNCTIONS as readonly string[]).includes(activeFunction)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].active_function is unknown`)
  }
  const runtimeEngine = nonEmptyString(raw.runtime_engine, `target[${index}].runtime_engine`)
  if (runtimeEngine !== 'codex-exec' && runtimeEngine !== 'claude-exec') {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].runtime_engine is unsupported`)
  }
  const discordMode = nonEmptyString(raw.discord_mode, `target[${index}].discord_mode`)
  if (discordMode !== 'native_verified' && discordMode !== 'aun_gateway_projection') {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].discord_mode is unsupported`)
  }
  const workspacePath = nonEmptyString(raw.workspace_path, `target[${index}].workspace_path`)
  if (!workspacePath.startsWith('/')) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', `target[${index}].workspace_path must be absolute`)
  }
  return {
    agent_id: agentId,
    target_repository: repository,
    control_source: nonEmptyString(raw.control_source, `target[${index}].control_source`),
    active_function: activeFunction as AllAgentCommunicationActiveFunction,
    workspace_id: nonEmptyString(raw.workspace_id, `target[${index}].workspace_id`),
    workspace_path: workspacePath,
    runtime_engine: runtimeEngine,
    runtime_profile_ref: nonEmptyString(raw.runtime_profile_ref, `target[${index}].runtime_profile_ref`),
    provider_identity_ref: nonEmptyString(raw.provider_identity_ref, `target[${index}].provider_identity_ref`),
    communication_auto_receive: boolean(raw.communication_auto_receive, `target[${index}].communication_auto_receive`),
    protected_d1: boolean(raw.protected_d1, `target[${index}].protected_d1`),
    discord_mode: discordMode,
  }
}

export function canonicalAllAgentCommunicationTargets(
  targets: readonly AllAgentCommunicationManifestTargetV1[],
): AllAgentCommunicationManifestTargetV1[] {
  return [...targets].sort((left, right) => {
    const leftCanonical = canonicalJson(left)
    const rightCanonical = canonicalJson(right)
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0
  })
}

export function allAgentCommunicationTargetSha256(
  targets: readonly AllAgentCommunicationManifestTargetV1[],
): string {
  return sha256Utf8(canonicalJson(targets))
}

export function allAgentCommunicationManifestDigestMaterial(
  manifest: Omit<AllAgentCommunicationManifestV1, 'artifact_digest' | 'owner_pinned_digest'>,
): Record<string, unknown> {
  return { ...manifest }
}

export function allAgentCommunicationManifestCanonicalBytes(
  manifest: AllAgentCommunicationManifestV1,
): string {
  const { artifact_digest: _artifact, owner_pinned_digest: _pin, ...material } = manifest
  return canonicalJson(allAgentCommunicationManifestDigestMaterial(material))
}

export function buildAllAgentCommunicationManifest(
  input: Omit<AllAgentCommunicationManifestV1,
    'schema_version' | 'owner_pinned_digest' | 'sorted_exact_target_tuples' | 'target_count' | 'target_sha256' | 'artifact_digest'> & {
      targets: AllAgentCommunicationManifestTargetV1[]
    },
): AllAgentCommunicationManifestV1 {
  const targets = canonicalAllAgentCommunicationTargets(input.targets)
  const partial = {
    schema_version: ALL_AGENT_COMMUNICATION_MANIFEST_SCHEMA_VERSION,
    manifest_id: input.manifest_id,
    revision: input.revision,
    issued_at: input.issued_at,
    not_before: input.not_before,
    expires_at: input.expires_at,
    owner_decision_ref: input.owner_decision_ref,
    sorted_exact_target_tuples: targets,
    target_count: targets.length,
    target_sha256: allAgentCommunicationTargetSha256(targets),
    release_commit: input.release_commit,
    release_tree: input.release_tree,
    policy_digest: input.policy_digest,
    revoked_or_superseded_refs: [...input.revoked_or_superseded_refs].sort(),
  }
  const artifactDigest = sha256Utf8(canonicalJson(partial))
  return parseAllAgentCommunicationManifest({
    ...partial,
    owner_pinned_digest: artifactDigest,
    artifact_digest: artifactDigest,
  })
}

export function parseAllAgentCommunicationManifest(value: unknown): AllAgentCommunicationManifestV1 {
  const raw = record(value, 'manifest')
  exactKeys(raw, MANIFEST_KEYS, 'manifest')
  if (raw.schema_version !== ALL_AGENT_COMMUNICATION_MANIFEST_SCHEMA_VERSION) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'schema_version is unsupported')
  }
  if (!Array.isArray(raw.sorted_exact_target_tuples) || raw.sorted_exact_target_tuples.length === 0) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'sorted_exact_target_tuples must be non-empty')
  }
  const targets = raw.sorted_exact_target_tuples.map(parseTarget)
  const canonicalTargets = canonicalAllAgentCommunicationTargets(targets)
  if (canonicalJson(targets) !== canonicalJson(canonicalTargets)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'target tuples are not in canonical order')
  }
  const agentIds = targets.map(target => target.agent_id)
  if (new Set(agentIds).size !== agentIds.length) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'target agent_id is duplicate or ambiguous')
  }
  const revoked = raw.revoked_or_superseded_refs
  if (!Array.isArray(revoked) || revoked.some(item => typeof item !== 'string' || !item.trim())) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'revoked_or_superseded_refs must be a string array')
  }
  const sortedRevoked = [...revoked].sort()
  if (new Set(revoked).size !== revoked.length || canonicalJson(revoked) !== canonicalJson(sortedRevoked)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'revoked_or_superseded_refs must be unique and sorted')
  }
  const manifest: AllAgentCommunicationManifestV1 = {
    schema_version: ALL_AGENT_COMMUNICATION_MANIFEST_SCHEMA_VERSION,
    manifest_id: nonEmptyString(raw.manifest_id, 'manifest_id'),
    revision: positiveInteger(raw.revision, 'revision'),
    issued_at: rfc3339(raw.issued_at, 'issued_at'),
    not_before: rfc3339(raw.not_before, 'not_before'),
    expires_at: rfc3339(raw.expires_at, 'expires_at'),
    owner_decision_ref: nonEmptyString(raw.owner_decision_ref, 'owner_decision_ref'),
    owner_pinned_digest: sha256(raw.owner_pinned_digest, 'owner_pinned_digest'),
    sorted_exact_target_tuples: targets,
    target_count: positiveInteger(raw.target_count, 'target_count'),
    target_sha256: sha256(raw.target_sha256, 'target_sha256'),
    release_commit: gitSha(raw.release_commit, 'release_commit'),
    release_tree: gitSha(raw.release_tree, 'release_tree'),
    artifact_digest: sha256(raw.artifact_digest, 'artifact_digest'),
    policy_digest: sha256(raw.policy_digest, 'policy_digest'),
    revoked_or_superseded_refs: revoked as string[],
  }
  if (Date.parse(manifest.issued_at) > Date.parse(manifest.not_before)
    || Date.parse(manifest.not_before) >= Date.parse(manifest.expires_at)) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'manifest lifecycle timestamps are not monotonic')
  }
  if (manifest.target_count !== targets.length) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'target_count differs from exact target tuples')
  }
  const targetDigest = allAgentCommunicationTargetSha256(targets)
  if (manifest.target_sha256 !== targetDigest) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'target_sha256 differs from exact target tuples')
  }
  const artifactDigest = sha256Utf8(allAgentCommunicationManifestCanonicalBytes(manifest))
  if (manifest.artifact_digest !== artifactDigest || manifest.owner_pinned_digest !== artifactDigest) {
    throw new AllAgentCommunicationManifestError('MANIFEST_INVALID', 'artifact/owner pin differs from canonical manifest bytes')
  }
  return manifest
}

export function evaluateAllAgentCommunicationTargetDrift(
  expected: readonly AllAgentCommunicationManifestTargetV1[],
  observed: readonly AllAgentCommunicationManifestTargetV1[],
): string[] {
  const expectedByAgent = new Map(expected.map(target => [target.agent_id, canonicalJson(target)]))
  const observedByAgent = new Map<string, string>()
  const drift: string[] = []
  for (const target of observed) {
    if (observedByAgent.has(target.agent_id)) drift.push(`${target.agent_id}:duplicate_observed_target`)
    observedByAgent.set(target.agent_id, canonicalJson(target))
  }
  for (const [agentId, expectedBytes] of expectedByAgent) {
    const observedBytes = observedByAgent.get(agentId)
    if (!observedBytes) drift.push(`${agentId}:missing_target`)
    else if (observedBytes !== expectedBytes) drift.push(`${agentId}:target_projection_mismatch`)
  }
  for (const agentId of observedByAgent.keys()) {
    if (!expectedByAgent.has(agentId)) drift.push(`${agentId}:unexpected_target`)
  }
  return [...new Set(drift)].sort()
}

export function evaluateAllAgentCommunicationManifest(
  value: unknown,
  context: AllAgentCommunicationManifestEvaluationContext,
): AllAgentCommunicationManifestEvaluation {
  let manifest: AllAgentCommunicationManifestV1
  try {
    manifest = parseAllAgentCommunicationManifest(value)
  } catch (error) {
    return {
      ok: false,
      code: error instanceof AllAgentCommunicationManifestError ? error.code : 'MANIFEST_INVALID',
      manifest: null,
      canonical_bytes: null,
      canonical_bytes_sha256: null,
      target_sha256: null,
      target_count: 0,
      drift: [],
    }
  }
  const canonicalBytes = allAgentCommunicationManifestCanonicalBytes(manifest)
  const base = {
    manifest,
    canonical_bytes: canonicalBytes,
    canonical_bytes_sha256: sha256Utf8(canonicalBytes),
    target_sha256: manifest.target_sha256,
    target_count: manifest.target_count,
    drift: [] as string[],
  }
  const fail = (code: AllAgentCommunicationManifestCode, drift: string[] = []): AllAgentCommunicationManifestEvaluation => ({
    ...base,
    ok: false,
    code,
    drift,
  })
  if (manifest.owner_decision_ref !== context.trusted_owner_decision_ref
    || manifest.owner_pinned_digest !== context.trusted_owner_pinned_digest) {
    return fail('MANIFEST_UNTRUSTED')
  }
  const now = context.now instanceof Date ? context.now.getTime() : Date.parse(context.now)
  if (!Number.isFinite(now)) return fail('MANIFEST_INVALID')
  if (now < Date.parse(manifest.not_before)) return fail('MANIFEST_NOT_YET_VALID')
  if (now >= Date.parse(manifest.expires_at)) return fail('MANIFEST_EXPIRED')
  const revoked = new Set(context.revoked_refs ?? [])
  if ([manifest.manifest_id, manifest.owner_decision_ref, manifest.artifact_digest].some(ref => revoked.has(ref))) {
    return fail('MANIFEST_REVOKED')
  }
  const current = context.current_projection
  if (current) {
    if (manifest.revision < current.revision) return fail('MANIFEST_ROLLBACK_REJECTED')
    if (manifest.revision === current.revision && manifest.artifact_digest !== current.artifact_digest) {
      return fail('MANIFEST_EQUIVOCATION')
    }
    if (manifest.revision > current.revision && manifest.owner_decision_ref === current.owner_decision_ref) {
      return fail('MANIFEST_OWNER_DECISION_REQUIRED')
    }
    if (manifest.revision === current.revision && (
      manifest.manifest_id !== current.manifest_id
      || manifest.target_sha256 !== current.target_sha256
      || manifest.owner_decision_ref !== current.owner_decision_ref
    )) return fail('PROJECTION_TRUST_MISMATCH')
  }
  if (context.observed_targets) {
    const drift = evaluateAllAgentCommunicationTargetDrift(
      manifest.sorted_exact_target_tuples,
      context.observed_targets,
    )
    if (drift.length > 0) return fail('TARGET_DRIFT', drift)
  }
  return { ...base, ok: true, code: 'ADMITTED' }
}

export type AllAgentCommunicationAdmissionPhase = 'preclaim' | 'preinvocation' | 'preeffect'

export interface AllAgentCommunicationAdmissionInput {
  phase: AllAgentCommunicationAdmissionPhase
  queue_id: number
  message_id: string | null
  created_at: string
  agent_id: string
  payload: unknown
}

export type AllAgentCommunicationAdmissionDecision =
  | { outcome: 'admit'; manifest_id: string; revision: number; artifact_digest: string; target_sha256: string }
  | { outcome: 'deny'; code: AllAgentCommunicationManifestCode | 'MANIFEST_GATE_UNAVAILABLE'; detail?: string }

export interface AllAgentCommunicationAdmissionGate {
  decide(input: AllAgentCommunicationAdmissionInput): AllAgentCommunicationAdmissionDecision | Promise<AllAgentCommunicationAdmissionDecision>
}

export type AllAgentCommunicationAdmissionContext = AllAgentCommunicationManifestEvaluationContext & {
  observed_targets: AllAgentCommunicationManifestTargetV1[]
}

/**
 * Deterministic ordinary-lane decision shared by the preclaim hook and the
 * future pre-invocation/pre-effect rechecks. The explicit protected_d1 field
 * is validated and read back by the manifest parser, but never grants or
 * changes admission here.
 */
export function decideAllAgentCommunicationAdmission(
  value: unknown,
  context: AllAgentCommunicationAdmissionContext,
  input: AllAgentCommunicationAdmissionInput,
): AllAgentCommunicationAdmissionDecision {
  const evaluation = evaluateAllAgentCommunicationManifest(value, context)
  if (!evaluation.ok || !evaluation.manifest) {
    return { outcome: 'deny', code: evaluation.code }
  }
  const target = evaluation.manifest.sorted_exact_target_tuples.find(
    candidate => candidate.agent_id === input.agent_id,
  )
  if (!target) return { outcome: 'deny', code: 'TARGET_DRIFT', detail: `${input.agent_id}:missing_target` }
  if (!target.communication_auto_receive) {
    return { outcome: 'deny', code: 'ORDINARY_AUTO_RECEIVE_DISABLED' }
  }
  return {
    outcome: 'admit',
    manifest_id: evaluation.manifest.manifest_id,
    revision: evaluation.manifest.revision,
    artifact_digest: evaluation.manifest.artifact_digest,
    target_sha256: evaluation.manifest.target_sha256,
  }
}
