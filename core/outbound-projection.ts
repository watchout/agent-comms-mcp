import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'
import {
  DISCORD_DELIVERY_CREDENTIAL_STATUSES,
  discordCredentialStatusSqlList,
  isDiscordDeliveryCredentialStatus,
} from './discord-token-resolution'
import { getAgentDiscordUiId } from './ui-bindings'
import {
  ContractValidationError,
  bindingSnapshotDigest,
  decodeBindingSnapshot,
  decodeResolvedDeliveryDecision,
  digestCanonical,
  resolvedDeliveryDecisionDigest,
  sortedUnique,
  type ResolvedDeliveryBindingSnapshotV1,
  type ResolvedDeliveryDecisionV1,
  type Sha256,
} from './eventlog/transport-contract'

const CANONICAL_ROUTE_DOMAINS = {
  resolutionInput: 'aun-route-resolution-input/v1\n',
  candidate: 'aun-effective-route-candidate/v1\n',
  eligibleCandidateSet: 'aun-eligible-route-candidate-set/v1\n',
  evaluatedCandidateSet: 'aun-evaluated-route-candidate-set/v1\n',
  selectedRoute: 'aun-selected-route/v1\n',
  policy: 'aun-route-policy/v1\n',
} as const

export interface RouteResolutionInputV1 {
  sender_seat_id: string
  recipient_seat_id: string
  conversation_id: string
  turn_id: string
  required_semantic_capabilities: string[]
  required_receipt_mode: 'provider_ack' | 'durable_handoff' | 'none'
  required_guarantee: 'effectively_once' | 'at_least_once'
  authority_snapshot_digest: Sha256
}

export type EffectiveRouteExclusionReasonV1 =
  | 'binding_inactive'
  | 'connector_inactive'
  | 'credential_inactive'
  | 'provider_access_inactive'
  | 'provider_access_expired'
  | 'provider_identity_untrusted'
  | 'projection_identity_untrusted'
  | 'capability_unproven'
  | 'policy_excluded'
  | null

export interface EffectiveRouteCandidateV1 {
  binding_id: string
  binding_role: 'outbound' | 'bidirectional' | 'projection'
  binding_status: 'active' | 'inactive'
  binding_priority: number
  connector_instance_id: string
  connector_status: 'active' | 'inactive'
  adapter_build_digest: Sha256
  capability_digest: Sha256
  credential_id: string
  credential_status: 'active' | 'revoked' | 'expired' | 'disabled'
  credential_generation_digest: Sha256
  provider_channel_access_id: string
  provider_channel_access_status: 'active' | 'inactive' | 'revoked'
  provider_channel_access_expires_at: string | null
  provider_channel_access_generation_digest: Sha256
  provider_identity_id: string
  provider_identity_trust: 'trusted' | 'untrusted' | 'revoked'
  provider_identity_fingerprint: Sha256
  projection_identity_id: string | null
  projection_identity_trust: 'trusted' | 'untrusted' | 'revoked' | 'not_applicable'
  opaque_address_fingerprint: Sha256
  eligible: boolean
  exclusion_reason: EffectiveRouteExclusionReasonV1
}

export interface SelectedRouteV1 {
  binding_id: string
  connector_instance_id: string
  credential_generation_digest: Sha256
  provider_channel_access_generation_digest: Sha256
  provider_identity_fingerprint: Sha256
  projection_identity_id: string | null
  opaque_address_fingerprint: Sha256
  capability_digest: Sha256
}

export interface RoutePolicyMaterialV1 {
  policy_source_digest: Sha256
  fallback_allowed: false
  candidate_serialization_order: 'binding_priority_desc_then_binding_id_connector_id_access_id_asc'
  tie_behavior: 'reject_ambiguous'
}

export interface CanonicalRouteResolutionMaterialV1 {
  resolution_input: RouteResolutionInputV1
  evaluated_candidates: EffectiveRouteCandidateV1[]
  policy: RoutePolicyMaterialV1
  resolver_version: string
  selected_binding_snapshot: ResolvedDeliveryBindingSnapshotV1
}

function routeAssertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', `${field} must be a non-empty string`)
  }
}

function routeAssertSha(value: unknown, field: string): asserts value is Sha256 {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', `${field} must be lowercase sha256`)
  }
}

function routeAssertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', `${field} must be a lowercase UUID`)
  }
}

function routeAssertEnum(value: unknown, values: readonly string[], field: string): asserts value is string {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', `${field} is outside the closed enum`)
  }
}

function routeAssertRfc3339(value: unknown, field: string): asserts value is string {
  routeAssertString(value, field)
  if (!Number.isFinite(Date.parse(value)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', `${field} must be RFC3339`)
  }
}

function canonicalRouteResolutionInput(value: RouteResolutionInputV1): RouteResolutionInputV1 {
  for (const field of ['sender_seat_id', 'recipient_seat_id', 'conversation_id', 'turn_id'] as const) {
    routeAssertString(value[field], field)
  }
  routeAssertSha(value.authority_snapshot_digest, 'authority_snapshot_digest')
  routeAssertEnum(value.required_receipt_mode, ['provider_ack', 'durable_handoff', 'none'], 'required_receipt_mode')
  routeAssertEnum(value.required_guarantee, ['effectively_once', 'at_least_once'], 'required_guarantee')
  const requiredSemanticCapabilities = sortedUnique(value.required_semantic_capabilities, 'required_semantic_capabilities')
  if (requiredSemanticCapabilities.some((item, index) => item !== value.required_semantic_capabilities[index])) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'required_semantic_capabilities must already be sorted')
  }
  return {
    sender_seat_id: value.sender_seat_id,
    recipient_seat_id: value.recipient_seat_id,
    conversation_id: value.conversation_id,
    turn_id: value.turn_id,
    required_semantic_capabilities: requiredSemanticCapabilities,
    required_receipt_mode: value.required_receipt_mode,
    required_guarantee: value.required_guarantee,
    authority_snapshot_digest: value.authority_snapshot_digest,
  }
}

function canonicalEffectiveRouteCandidate(value: EffectiveRouteCandidateV1): EffectiveRouteCandidateV1 {
  routeAssertUuid(value.binding_id, 'binding_id')
  routeAssertUuid(value.connector_instance_id, 'connector_instance_id')
  routeAssertEnum(value.binding_role, ['outbound', 'bidirectional', 'projection'], 'binding_role')
  routeAssertEnum(value.binding_status, ['active', 'inactive'], 'binding_status')
  routeAssertEnum(value.connector_status, ['active', 'inactive'], 'connector_status')
  routeAssertEnum(value.credential_status, ['active', 'revoked', 'expired', 'disabled'], 'credential_status')
  routeAssertEnum(value.provider_channel_access_status, ['active', 'inactive', 'revoked'], 'provider_channel_access_status')
  routeAssertEnum(value.provider_identity_trust, ['trusted', 'untrusted', 'revoked'], 'provider_identity_trust')
  routeAssertEnum(value.projection_identity_trust, ['trusted', 'untrusted', 'revoked', 'not_applicable'], 'projection_identity_trust')
  if (!Number.isSafeInteger(value.binding_priority)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'binding_priority must be an integer')
  }
  for (const field of ['adapter_build_digest', 'capability_digest', 'credential_generation_digest', 'provider_channel_access_generation_digest', 'provider_identity_fingerprint', 'opaque_address_fingerprint'] as const) {
    routeAssertSha(value[field], field)
  }
  for (const field of ['credential_id', 'provider_channel_access_id', 'provider_identity_id'] as const) {
    routeAssertString(value[field], field)
  }
  if (value.provider_channel_access_expires_at !== null) routeAssertRfc3339(value.provider_channel_access_expires_at, 'provider_channel_access_expires_at')
  if (value.projection_identity_id !== null) routeAssertString(value.projection_identity_id, 'projection_identity_id')
  if (value.projection_identity_id === null && value.projection_identity_trust !== 'not_applicable') {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'null projection identity must be not_applicable')
  }
  if (value.projection_identity_id !== null && value.projection_identity_trust === 'not_applicable') {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'present projection identity needs an explicit trust result')
  }
  const exclusions = [
    'binding_inactive', 'connector_inactive', 'credential_inactive', 'provider_access_inactive',
    'provider_access_expired', 'provider_identity_untrusted', 'projection_identity_untrusted',
    'capability_unproven', 'policy_excluded',
  ] as const
  if (value.exclusion_reason !== null) routeAssertEnum(value.exclusion_reason, exclusions, 'exclusion_reason')
  if (typeof value.eligible !== 'boolean' || value.eligible !== (value.exclusion_reason === null)) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'eligible and exclusion_reason disagree')
  }
  if (value.eligible && (
    value.binding_status !== 'active' ||
    value.connector_status !== 'active' ||
    value.credential_status !== 'active' ||
    value.provider_channel_access_status !== 'active' ||
    value.provider_identity_trust !== 'trusted' ||
    !['trusted', 'not_applicable'].includes(value.projection_identity_trust)
  )) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'an eligible candidate contains inactive or untrusted authority')
  }
  return {
    binding_id: value.binding_id,
    binding_role: value.binding_role,
    binding_status: value.binding_status,
    binding_priority: value.binding_priority,
    connector_instance_id: value.connector_instance_id,
    connector_status: value.connector_status,
    adapter_build_digest: value.adapter_build_digest,
    capability_digest: value.capability_digest,
    credential_id: value.credential_id,
    credential_status: value.credential_status,
    credential_generation_digest: value.credential_generation_digest,
    provider_channel_access_id: value.provider_channel_access_id,
    provider_channel_access_status: value.provider_channel_access_status,
    provider_channel_access_expires_at: value.provider_channel_access_expires_at,
    provider_channel_access_generation_digest: value.provider_channel_access_generation_digest,
    provider_identity_id: value.provider_identity_id,
    provider_identity_trust: value.provider_identity_trust,
    provider_identity_fingerprint: value.provider_identity_fingerprint,
    projection_identity_id: value.projection_identity_id,
    projection_identity_trust: value.projection_identity_trust,
    opaque_address_fingerprint: value.opaque_address_fingerprint,
    eligible: value.eligible,
    exclusion_reason: value.exclusion_reason,
  }
}

function canonicalRoutePolicy(value: RoutePolicyMaterialV1): RoutePolicyMaterialV1 {
  routeAssertSha(value.policy_source_digest, 'policy_source_digest')
  if (
    value.fallback_allowed !== false ||
    value.candidate_serialization_order !== 'binding_priority_desc_then_binding_id_connector_id_access_id_asc' ||
    value.tie_behavior !== 'reject_ambiguous'
  ) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'route policy is outside the fail-closed contract')
  }
  return {
    policy_source_digest: value.policy_source_digest,
    fallback_allowed: false,
    candidate_serialization_order: 'binding_priority_desc_then_binding_id_connector_id_access_id_asc',
    tie_behavior: 'reject_ambiguous',
  }
}

function compareLowercaseUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left.toLowerCase(), 'utf8'), Buffer.from(right.toLowerCase(), 'utf8'))
}

function compareCanonicalRouteCandidates(left: EffectiveRouteCandidateV1, right: EffectiveRouteCandidateV1): number {
  if (left.binding_priority !== right.binding_priority) return right.binding_priority - left.binding_priority
  return compareLowercaseUtf8(left.binding_id, right.binding_id)
    || compareLowercaseUtf8(left.connector_instance_id, right.connector_instance_id)
    || compareLowercaseUtf8(left.provider_channel_access_id, right.provider_channel_access_id)
}

export function effectiveRouteCandidateDigest(candidate: EffectiveRouteCandidateV1): Sha256 {
  return digestCanonical(CANONICAL_ROUTE_DOMAINS.candidate, canonicalEffectiveRouteCandidate(candidate))
}

export function routeResolutionInputDigest(input: RouteResolutionInputV1): Sha256 {
  return digestCanonical(CANONICAL_ROUTE_DOMAINS.resolutionInput, canonicalRouteResolutionInput(input))
}

export function selectedRouteDigest(route: SelectedRouteV1): Sha256 {
  return digestCanonical(CANONICAL_ROUTE_DOMAINS.selectedRoute, route)
}

export function routePolicyDigest(policy: RoutePolicyMaterialV1): Sha256 {
  return digestCanonical(CANONICAL_ROUTE_DOMAINS.policy, canonicalRoutePolicy(policy))
}

/** Re-run the same canonical resolver against one pinned authority snapshot. */
export function resolveCanonicalDeliveryDecision(material: CanonicalRouteResolutionMaterialV1): ResolvedDeliveryDecisionV1 {
  routeAssertString(material.resolver_version, 'resolver_version')
  const resolutionInput = canonicalRouteResolutionInput(material.resolution_input)
  const policy = canonicalRoutePolicy(material.policy)
  const candidates = material.evaluated_candidates.map(canonicalEffectiveRouteCandidate).sort(compareCanonicalRouteCandidates)
  if (candidates.length === 0) throw new ContractValidationError('NO_ELIGIBLE_ROUTE', 'the evaluated candidate set is empty')

  const evaluatedDigests = sortedUnique(candidates.map(effectiveRouteCandidateDigest), 'evaluated candidate digest set')
  const eligible = candidates.filter(candidate => candidate.eligible)
  if (eligible.length === 0) throw new ContractValidationError('NO_ELIGIBLE_ROUTE', 'no evaluated candidate is eligible')
  const topPriority = eligible[0]!.binding_priority
  const top = eligible.filter(candidate => candidate.binding_priority === topPriority)
  if (top.length !== 1) throw new ContractValidationError('AMBIGUOUS_ROUTE', 'more than one eligible route has the highest priority')
  const selectedCandidate = top[0]!
  const eligibleDigests = sortedUnique(eligible.map(effectiveRouteCandidateDigest), 'eligible candidate digest set')
  const snapshot = decodeBindingSnapshot(material.selected_binding_snapshot)
  if (
    snapshot.status !== 'active' ||
    snapshot.resolver_version !== material.resolver_version ||
    snapshot.channel_binding_id !== selectedCandidate.binding_id ||
    snapshot.binding_role !== selectedCandidate.binding_role ||
    snapshot.priority !== selectedCandidate.binding_priority ||
    snapshot.connector_instance_id !== selectedCandidate.connector_instance_id ||
    snapshot.provider_channel_access_id !== selectedCandidate.provider_channel_access_id ||
    snapshot.provider_identity_fingerprint !== selectedCandidate.provider_identity_fingerprint ||
    snapshot.projection_identity_id !== selectedCandidate.projection_identity_id ||
    snapshot.opaque_address_fingerprint !== selectedCandidate.opaque_address_fingerprint ||
    snapshot.capability_digest !== selectedCandidate.capability_digest
  ) {
    throw new ContractValidationError('ROUTE_AUTHORITY_INVALID', 'selected binding snapshot differs from the selected candidate')
  }
  const selectedRoute: SelectedRouteV1 = {
    binding_id: selectedCandidate.binding_id,
    connector_instance_id: selectedCandidate.connector_instance_id,
    credential_generation_digest: selectedCandidate.credential_generation_digest,
    provider_channel_access_generation_digest: selectedCandidate.provider_channel_access_generation_digest,
    provider_identity_fingerprint: selectedCandidate.provider_identity_fingerprint,
    projection_identity_id: selectedCandidate.projection_identity_id,
    opaque_address_fingerprint: selectedCandidate.opaque_address_fingerprint,
    capability_digest: selectedCandidate.capability_digest,
  }
  const decisionWithoutDigest: Omit<ResolvedDeliveryDecisionV1, 'resolved_delivery_decision_digest'> = {
    schema_version: 'aun-resolved-delivery-decision/v1',
    resolution_input_digest: digestCanonical(CANONICAL_ROUTE_DOMAINS.resolutionInput, resolutionInput),
    evaluated_candidate_set_digest: digestCanonical(CANONICAL_ROUTE_DOMAINS.evaluatedCandidateSet, evaluatedDigests),
    eligible_candidate_set_digest: digestCanonical(CANONICAL_ROUTE_DOMAINS.eligibleCandidateSet, eligibleDigests),
    selected_route_digest: digestCanonical(CANONICAL_ROUTE_DOMAINS.selectedRoute, selectedRoute),
    policy_digest: digestCanonical(CANONICAL_ROUTE_DOMAINS.policy, policy),
    resolver_version: material.resolver_version,
    selected_binding_snapshot_digest: bindingSnapshotDigest(snapshot),
  }
  return {
    ...decisionWithoutDigest,
    resolved_delivery_decision_digest: resolvedDeliveryDecisionDigest(decisionWithoutDigest),
  }
}

/** Fail closed before provider invocation if any effective resolver authority drifted. */
export function assertCanonicalDeliveryDecisionCurrent(
  pinned: ResolvedDeliveryDecisionV1,
  current: CanonicalRouteResolutionMaterialV1,
): ResolvedDeliveryDecisionV1 {
  const validatedPinned = decodeResolvedDeliveryDecision(pinned)
  const recomputed = resolveCanonicalDeliveryDecision(current)
  if (recomputed.resolved_delivery_decision_digest !== validatedPinned.resolved_delivery_decision_digest) {
    throw new ContractValidationError('RESOLVER_DECISION_DRIFT', 'canonical resolver decision changed before provider invocation')
  }
  return recomputed
}

export type Queryable = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}

export interface OutboundProjectionRoute {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  source: 'thread_adapter_metadata' | 'channel_adapter_metadata' | 'recipient_token_evidence' | 'sender_token_evidence' | 'derived_single_connector' | 'recipient_default_projection' | 'channel_policy_native_role_owner' | 'channel_policy_adapter_owner' | 'channel_policy_primary' | 'none'
  consumerEvidence: DeliveryConsumerEvidence | null
}

export type ProjectionConsumerSource =
  | 'thread_adapter_metadata'
  | 'channel_adapter_metadata'
  | 'recipient_token_evidence'
  | 'sender_token_evidence'
  | 'derived_single_connector'
  | 'channel_policy_adapter_owner'
  | 'channel_policy_primary'
  | 'none'

export type ProjectionIdentitySource =
  | 'recipient_default_projection'
  | 'sender_native_projection'
  | 'fallback_adapter_owner'
  | 'none'

export type ProjectionFallbackReason =
  | 'recipient_projection_unregistered'
  | 'recipient_projection_unhealthy'
  | 'recipient_projection_human'
  | 'native_projection_unregistered'
  | 'native_projection_unhealthy'
  | null

export type DeliveryConsumerDiagnosticCode =
  | 'eligible'
  | 'agent_id_missing'
  | 'connector_missing'
  | 'connector_not_active'
  | 'credential_missing'
  | 'credential_not_delivery_eligible'
  | 'write_binding_missing'
  | 'provider_write_access_missing'
  | 'provider_write_access_read_only'
  | 'ambiguous_delivery_connectors'
  | 'fallback_policy_denied'

export type DeliveryFallbackReason =
  | 'recipient_direct_unavailable'
  | 'sender_direct_unavailable'
  | 'channel_policy_adapter_owner'
  | 'channel_policy_primary'
  | null

export interface DeliveryConsumerDiagnostic {
  agent_id: string | null
  connector_instance_id: string | null
  source: ProjectionConsumerSource
  code: DeliveryConsumerDiagnosticCode
  detail?: Record<string, unknown>
}

export interface OutboundProjectionDecision {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  consumerSource: ProjectionConsumerSource
  consumerEvidence: DeliveryConsumerEvidence | null
  projectionIdentityId: string | null
  intendedProjectionIdentityId: string | null
  projectionSource: ProjectionIdentitySource
  projectionFallbackReason: ProjectionFallbackReason
  deliveryFallbackReason: DeliveryFallbackReason
  deliveryDiagnostics: DeliveryConsumerDiagnostic[]
}

export type EffectiveDeliveryOwnerSource =
  | 'explicit_binding'
  | 'sender_direct'
  | 'recipient_direct'
  | 'derived_single_connector'
  | 'legacy_adapter_owner'
  | 'legacy_primary'

export type EffectiveDeliveryOwnerFailureCode =
  | 'NO_ELIGIBLE_CONNECTOR'
  | 'AMBIGUOUS_CONNECTOR'
  | 'PROVIDER_WRITE_ACCESS_MISSING'
  | 'BINDING_MISSING'
  | 'CREDENTIAL_NOT_DELIVERY_ELIGIBLE'
  | 'FALLBACK_POLICY_DENIED'

export type EffectiveDeliveryOwnerResult =
  | {
      ok: true
      source: EffectiveDeliveryOwnerSource
      consumerAgentId: string
      connectorInstanceId: string | null
      credentialId: string | null
      credentialStatus: string | null
      channelBindingId: string | null
      providerChannelAccessId: string | null
      evidence: DeliveryConsumerEvidence | null
      fallbackReason: DeliveryFallbackReason
      diagnostics: DeliveryConsumerDiagnostic[]
    }
  | {
      ok: false
      code: EffectiveDeliveryOwnerFailureCode
      evidence: {
        consumerAgentId: string | null
        consumerSource: ProjectionConsumerSource
        fallbackReason: DeliveryFallbackReason
        diagnostics: DeliveryConsumerDiagnostic[]
      }
    }

export interface DeliveryConsumerEvidence {
  source_table: 'channel_connector_bindings' | 'provider_channel_access'
  provider: 'discord'
  channel_id: string
  provider_channel_id: string
  agent_id: string
  connector_instance_id: string
  credential_id: string
  credential_status: string
  channel_binding_id: string | null
  channel_binding_priority?: number | null
  provider_channel_access_id: string | null
}

export interface OutboundProjectionInput {
  channelId: string
  threadId?: string | null
  platform?: 'discord'
  senderAgentId?: string | null
  recipientAgentIds?: string[] | null
  fallbackAllowed?: boolean
}

export type OutboundProjectionSkipReason =
  | 'no discord adapter mapping for this channel'
  | 'no eligible discord delivery consumer for this channel'

export const OUTBOUND_SKIP_NO_DISCORD_ADAPTER: OutboundProjectionSkipReason = 'no discord adapter mapping for this channel'
export const OUTBOUND_SKIP_NO_DELIVERY_CONSUMER: OutboundProjectionSkipReason = 'no eligible discord delivery consumer for this channel'

export function outboundProjectionSkipReason(
  projection: Pick<OutboundProjectionDecision, 'channelExternalId' | 'consumerAgentId'>,
): OutboundProjectionSkipReason | null {
  if (!projection.channelExternalId) return OUTBOUND_SKIP_NO_DISCORD_ADAPTER
  if (!projection.consumerAgentId) return OUTBOUND_SKIP_NO_DELIVERY_CONSUMER
  return null
}

export function outboundProjectionSkipCode(reason: OutboundProjectionSkipReason): 'NO_DISCORD_ADAPTER_MAPPING' | 'NO_ELIGIBLE_DELIVERY_CONSUMER' {
  return reason === OUTBOUND_SKIP_NO_DELIVERY_CONSUMER
    ? 'NO_ELIGIBLE_DELIVERY_CONSUMER'
    : 'NO_DISCORD_ADAPTER_MAPPING'
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function ownerFromMetadata(raw: unknown): string | null {
  const metadata = parseMetadata(raw)
  const value = metadata.consumer_agent_id
    ?? metadata.adapter_owner
    ?? metadata.adapterOwner
    ?? metadata.owner_agent_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function queryRows(db: Queryable, sql: string, params?: any[]): Promise<any[]> {
  try {
    const result = await db.query(sql, params)
    return Array.isArray(result.rows) ? result.rows : []
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/(does not exist|no such table|no such column|column .* does not exist)/i.test(message)) return []
    throw err
  }
}

function connectorUri(provider: 'discord', agentId: string): string {
  return `${provider}://agents/${agentId}`
}

function hasWriteCapability(raw: unknown): boolean {
  const capabilities = parseMetadata(raw)
  return ['message_create', 'can_write', 'write', 'send_messages', 'outbound'].some((key) => {
    const value = capabilities[key]
    return value === true || value === 1 || value === 'true' || value === '1'
  })
}

const DELIVERY_CREDENTIAL_STATUS_SQL = discordCredentialStatusSqlList(DISCORD_DELIVERY_CREDENTIAL_STATUSES)

async function deliveryCredentialForConnector(
  db: Queryable,
  platform: 'discord',
  agentId: string,
  connectorInstanceId: string,
): Promise<{ credential_id: string; credential_status: string; delivery_eligible: boolean } | null> {
  const rows = await queryRows(
    db,
    `SELECT credential_id, COALESCE(status, 'registered') AS credential_status
       FROM connector_credentials
      WHERE provider = $1
        AND agent_id = $2
        AND connector_instance_id = $3
        AND COALESCE(trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND COALESCE(secret_ref, '') <> ''
        AND revoked_at IS NULL
        AND disabled_at IS NULL
      ORDER BY
        CASE
          WHEN COALESCE(status, 'registered') IN (${DELIVERY_CREDENTIAL_STATUS_SQL}) THEN 0
          ELSE 1
        END,
        CASE COALESCE(status, 'registered') WHEN 'active' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END,
        credential_id
      LIMIT 1`,
    [platform, agentId, connectorInstanceId],
  )
  const credentialId = firstString(rows[0]?.credential_id)
  if (!credentialId) return null
  const credentialStatus = firstString(rows[0]?.credential_status) ?? 'registered'
  return {
    credential_id: credentialId,
    credential_status: credentialStatus,
    delivery_eligible: isDiscordDeliveryCredentialStatus(credentialStatus),
  }
}

async function writeBindingForConnector(
  db: Queryable,
  platform: 'discord',
  channelId: string,
  connectorInstanceId: string,
): Promise<{ bindingId: string; priority: number | null } | null> {
  const rows = await queryRows(
    db,
    `SELECT channel_binding_id, priority
       FROM channel_connector_bindings
      WHERE provider = $1
        AND channel_id = $2
        AND connector_instance_id = $3
        AND COALESCE(status, 'active') = 'active'
        AND binding_role IN ('outbound', 'bidirectional', 'projection')
      ORDER BY
        CASE binding_role WHEN 'outbound' THEN 0 WHEN 'bidirectional' THEN 1 WHEN 'projection' THEN 2 ELSE 3 END,
        priority,
        channel_binding_id
      LIMIT 1`,
    [platform, channelId, connectorInstanceId],
  )
  const bindingId = firstString(rows[0]?.channel_binding_id)
  if (!bindingId) return null
  const rawPriority = Number(rows[0]?.priority)
  return {
    bindingId,
    priority: Number.isFinite(rawPriority) ? rawPriority : null,
  }
}

async function providerWriteAccessForConnector(
  db: Queryable,
  platform: 'discord',
  providerChannelId: string,
  agentId: string,
  connectorInstanceId: string,
): Promise<{ accessId: string | null; readOnlyAccessIds: string[] }> {
  const rows = await queryRows(
    db,
    `SELECT provider_channel_access_id, capabilities
       FROM provider_channel_access
      WHERE provider = $1
        AND provider_channel_id = $2
        AND connector_instance_id = $3
        AND (agent_id IS NULL OR agent_id = $4)
        AND COALESCE(status, 'active') = 'active'
        AND COALESCE(trust_status, 'local') NOT IN ('revoked', 'disabled')
      ORDER BY provider_channel_access_id
      LIMIT 5`,
    [platform, providerChannelId, connectorInstanceId, agentId],
  )
  const row = rows.find((item) => hasWriteCapability(item.capabilities))
  return {
    accessId: firstString(row?.provider_channel_access_id),
    readOnlyAccessIds: rows
      .filter((item) => !hasWriteCapability(item.capabilities))
      .map((item) => firstString(item.provider_channel_access_id))
      .filter((id): id is string => id !== null),
  }
}

async function eligibleDeliveryConnectorEvidence(
  db: Queryable,
  input: {
    platform: 'discord'
    channelId: string
    providerChannelId: string
    agentId: string
    source: ProjectionConsumerSource
  },
): Promise<{ eligible: DeliveryConsumerEvidence[]; diagnostics: DeliveryConsumerDiagnostic[] }> {
  const agentId = input.agentId.trim()
  const channelId = input.channelId.trim()
  const providerChannelId = input.providerChannelId.trim() || channelId
  const diagnostics: DeliveryConsumerDiagnostic[] = []
  const diagnostic = (
    code: DeliveryConsumerDiagnosticCode,
    connectorInstanceId: string | null = null,
    detail?: Record<string, unknown>,
  ) => {
    diagnostics.push({
      agent_id: agentId || null,
      connector_instance_id: connectorInstanceId,
      source: input.source,
      code,
      ...(detail ? { detail } : {}),
    })
  }
  if (!agentId || !channelId) {
    diagnostic('agent_id_missing')
    return { eligible: [], diagnostics }
  }

  const connectors = await queryRows(
    db,
    `SELECT connector_instance_id, COALESCE(status, 'registered') AS status
       FROM connector_instances
      WHERE provider = $1
        AND agent_id = $2
        AND COALESCE(trust_status, 'local') NOT IN ('revoked', 'disabled')
      ORDER BY
        CASE WHEN connector_uri = $3 THEN 0 ELSE 1 END,
        connector_instance_id`,
    [input.platform, agentId, connectorUri(input.platform, agentId)],
  )
  if (connectors.length === 0) {
    diagnostic('connector_missing')
    return { eligible: [], diagnostics }
  }

  const eligible: DeliveryConsumerEvidence[] = []
  for (const connector of connectors) {
    const connectorInstanceId = firstString(connector.connector_instance_id)
    if (!connectorInstanceId) continue
    const connectorStatus = firstString(connector.status) ?? 'registered'
    if (connectorStatus !== 'active') {
      diagnostic('connector_not_active', connectorInstanceId, { status: connectorStatus })
      continue
    }
    const credential = await deliveryCredentialForConnector(db, input.platform, agentId, connectorInstanceId)
    if (!credential) {
      diagnostic('credential_missing', connectorInstanceId, {
        delivery_eligible_statuses: DISCORD_DELIVERY_CREDENTIAL_STATUSES,
      })
      continue
    }
    if (!credential.delivery_eligible) {
      diagnostic('credential_not_delivery_eligible', connectorInstanceId, {
        credential_id: credential.credential_id,
        credential_status: credential.credential_status,
        delivery_eligible_statuses: DISCORD_DELIVERY_CREDENTIAL_STATUSES,
      })
      continue
    }
    const binding = await writeBindingForConnector(db, input.platform, channelId, connectorInstanceId)
    if (!binding) {
      diagnostic('write_binding_missing', connectorInstanceId)
      continue
    }
    const { accessId, readOnlyAccessIds } = await providerWriteAccessForConnector(db, input.platform, providerChannelId, agentId, connectorInstanceId)
    if (accessId) {
      eligible.push({
        source_table: 'channel_connector_bindings',
        provider: input.platform,
        channel_id: channelId,
        provider_channel_id: providerChannelId,
        agent_id: agentId,
        connector_instance_id: connectorInstanceId,
        credential_id: credential.credential_id,
        credential_status: credential.credential_status,
        channel_binding_id: binding.bindingId,
        channel_binding_priority: binding.priority,
        provider_channel_access_id: accessId,
      })
      diagnostic('eligible', connectorInstanceId, {
        credential_id: credential.credential_id,
        credential_status: credential.credential_status,
        channel_binding_id: binding.bindingId,
        channel_binding_priority: binding.priority,
        provider_channel_access_id: accessId,
        evidence_source: 'channel_connector_bindings+provider_channel_access',
      })
    } else if (readOnlyAccessIds.length > 0) {
      diagnostic('provider_write_access_read_only', connectorInstanceId, {
        provider_channel_access_ids: readOnlyAccessIds,
        channel_binding_id: binding.bindingId,
      })
    } else {
      diagnostic('provider_write_access_missing', connectorInstanceId, {
        provider_channel_id: providerChannelId,
        channel_binding_id: binding.bindingId,
      })
    }
  }
  return { eligible, diagnostics }
}

function selectDeliveryEvidence(eligible: DeliveryConsumerEvidence[]): DeliveryConsumerEvidence | null {
  if (eligible.length === 0) return null
  if (eligible.length === 1) return eligible[0]

  const rankedBindings = eligible
    .filter((item) => item.source_table === 'channel_connector_bindings' && typeof item.channel_binding_priority === 'number')
    .sort((a, b) => (a.channel_binding_priority ?? Number.MAX_SAFE_INTEGER) - (b.channel_binding_priority ?? Number.MAX_SAFE_INTEGER))
  if (rankedBindings.length === 0) return null

  const winningPriority = rankedBindings[0]!.channel_binding_priority
  const winners = rankedBindings.filter((item) => item.channel_binding_priority === winningPriority)
  return winners.length === 1 ? winners[0] : null
}

async function deliveryConsumerEvidence(
  db: Queryable,
  input: {
    platform: 'discord'
    channelId: string
    providerChannelId?: string | null
    agentId: string | null
    source: ProjectionConsumerSource
  },
): Promise<{ evidence: DeliveryConsumerEvidence | null; diagnostics: DeliveryConsumerDiagnostic[] }> {
  if (!input.agentId) {
    return {
      evidence: null,
      diagnostics: [{
        agent_id: null,
        connector_instance_id: null,
        source: input.source,
        code: 'agent_id_missing',
      }],
    }
  }
  const providerChannelId = input.providerChannelId ?? input.channelId
  const { eligible, diagnostics } = await eligibleDeliveryConnectorEvidence(db, {
    platform: input.platform,
    channelId: input.channelId,
    providerChannelId,
    agentId: input.agentId,
    source: input.source,
  })
  const evidence = selectDeliveryEvidence(eligible)
  if (!evidence && eligible.length > 1) {
    diagnostics.push({
      agent_id: input.agentId,
      connector_instance_id: null,
      source: input.source,
      code: 'ambiguous_delivery_connectors',
      detail: {
        connector_instance_ids: eligible.map((item) => item.connector_instance_id),
        channel_binding_priorities: eligible.map((item) => ({
          connector_instance_id: item.connector_instance_id,
          channel_binding_id: item.channel_binding_id,
          channel_binding_priority: item.channel_binding_priority ?? null,
        })),
      },
    })
  }
  return { evidence, diagnostics }
}

async function derivedSingleConnectorEvidence(
  db: Queryable,
  input: {
    platform: 'discord'
    channelId: string
    providerChannelId: string
  },
): Promise<{ evidence: DeliveryConsumerEvidence | null; diagnostics: DeliveryConsumerDiagnostic[] }> {
  const rows = await queryRows(
    db,
    `SELECT DISTINCT ci.agent_id
       FROM channel_connector_bindings b
       JOIN connector_instances ci
         ON ci.connector_instance_id = b.connector_instance_id
      WHERE b.provider = $1
        AND b.channel_id = $2
        AND COALESCE(b.status, 'active') = 'active'
        AND b.binding_role IN ('outbound', 'bidirectional', 'projection')
        AND ci.provider = b.provider
        AND COALESCE(ci.status, 'registered') = 'active'
        AND COALESCE(ci.trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND ci.agent_id IS NOT NULL
      ORDER BY ci.agent_id`,
    [input.platform, input.channelId],
  )
  const agentIds = Array.from(new Set(rows
    .map((row) => firstString(row.agent_id))
    .filter((agentId): agentId is string => agentId !== null)))
  const eligible: DeliveryConsumerEvidence[] = []
  const diagnostics: DeliveryConsumerDiagnostic[] = []

  for (const agentId of agentIds) {
    const result = await deliveryConsumerEvidence(db, {
      platform: input.platform,
      channelId: input.channelId,
      providerChannelId: input.providerChannelId,
      agentId,
      source: 'derived_single_connector',
    })
    diagnostics.push(...result.diagnostics)
    if (result.evidence) eligible.push(result.evidence)
  }

  const evidence = selectDeliveryEvidence(eligible)
  if (!evidence && eligible.length > 1) {
    diagnostics.push({
      agent_id: null,
      connector_instance_id: null,
      source: 'derived_single_connector',
      code: 'ambiguous_delivery_connectors',
      detail: {
        connector_instance_ids: eligible.map((item) => item.connector_instance_id),
        channel_binding_priorities: eligible.map((item) => ({
          agent_id: item.agent_id,
          connector_instance_id: item.connector_instance_id,
          channel_binding_id: item.channel_binding_id,
          channel_binding_priority: item.channel_binding_priority ?? null,
        })),
      },
    })
  }

  return { evidence, diagnostics }
}

async function ownerFromMetadataIfEligible(
  db: Queryable,
  platform: 'discord',
  channelId: string,
  providerChannelId: string,
  raw: unknown,
  source: ProjectionConsumerSource,
): Promise<{ owner: string; evidence: DeliveryConsumerEvidence; diagnostics: DeliveryConsumerDiagnostic[] } | null> {
  const owner = ownerFromMetadata(raw)
  if (!owner) return null
  const { evidence, diagnostics } = await deliveryConsumerEvidence(db, { platform, channelId, providerChannelId, agentId: owner, source })
  return evidence ? { owner, evidence, diagnostics } : null
}

function singleRecipientFrom(input?: string[] | null): string | null {
  const recipients = (input ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0)
  return recipients.length === 1 ? recipients[0].trim() : null
}

async function projectionHealth(
  db: Queryable,
  agentId: string,
): Promise<{ registered: boolean; healthy: boolean; agentType: string | null; projectable: boolean }> {
  const rr = await db.query(
    `SELECT agent_id, agent_type, status, metadata FROM agents WHERE agent_id = $1`,
    [agentId],
  ).catch(() => ({ rows: [] as any[] }))
  if (rr.rows.length === 0) return { registered: false, healthy: false, agentType: null, projectable: false }
  const registered = (await getAgentDiscordUiId(db, agentId)) !== null
  const status = typeof rr.rows[0].status === 'string' ? rr.rows[0].status : null
  const agentType = typeof rr.rows[0].agent_type === 'string' ? rr.rows[0].agent_type : null
  const unhealthyStatus = status === 'offline' || status === 'disconnected' || status === 'failed'
  const projectable = agentType !== 'human'
  return { registered, healthy: registered && !unhealthyStatus && projectable, agentType, projectable }
}

async function resolveSurfaceAndConsumer(
  db: Queryable,
  input: OutboundProjectionInput,
): Promise<{
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  consumerSource: ProjectionConsumerSource
  consumerEvidence: DeliveryConsumerEvidence | null
  deliveryFallbackReason: DeliveryFallbackReason
  deliveryDiagnostics: DeliveryConsumerDiagnostic[]
}> {
  const platform = input.platform ?? 'discord'
  let channelExternalId: string | null = null
  let providerChannelId = input.channelId
  const deliveryDiagnostics: DeliveryConsumerDiagnostic[] = []
  let deliveryFallbackReason: DeliveryFallbackReason = null

  if (input.threadId) {
    const tr = await db.query(
      `SELECT external_id, metadata FROM thread_adapters WHERE thread_id = $1 AND platform = $2`,
      [input.threadId, platform],
    ).catch(() => ({ rows: [] as any[] }))
    if (tr.rows.length > 0) {
      channelExternalId = tr.rows[0].external_id ?? null
      providerChannelId = tr.rows[0].external_id ?? providerChannelId
      const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, tr.rows[0].metadata, 'thread_adapter_metadata')
      if (owner) deliveryDiagnostics.push(...owner.diagnostics)
      if (owner) {
        return { platform, channelExternalId, consumerAgentId: owner.owner, consumerSource: 'thread_adapter_metadata', consumerEvidence: owner.evidence, deliveryFallbackReason, deliveryDiagnostics }
      }
    }
  }

  const cr = await db.query(
    `SELECT external_id, metadata FROM channel_adapters WHERE channel_id = $1 AND platform = $2`,
    [input.channelId, platform],
  ).catch(() => ({ rows: [] as any[] }))
  if (cr.rows.length > 0) {
    const channelAdapterExternalId = cr.rows[0].external_id ?? null
    const targetAlreadyResolved = channelExternalId !== null
    channelExternalId = channelExternalId ?? channelAdapterExternalId
    if (!targetAlreadyResolved) {
      providerChannelId = channelAdapterExternalId ?? providerChannelId
    }
    const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, cr.rows[0].metadata, 'channel_adapter_metadata')
    if (owner) deliveryDiagnostics.push(...owner.diagnostics)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner.owner, consumerSource: 'channel_adapter_metadata', consumerEvidence: owner.evidence, deliveryFallbackReason, deliveryDiagnostics }
    }
  }

  const singleRecipient = singleRecipientFrom(input.recipientAgentIds)
  if (singleRecipient) {
    const recipientResult = await deliveryConsumerEvidence(db, {
      platform,
      channelId: input.channelId,
      providerChannelId,
      agentId: singleRecipient,
      source: 'recipient_token_evidence',
    })
    deliveryDiagnostics.push(...recipientResult.diagnostics)
    if (recipientResult.evidence) {
      return { platform, channelExternalId, consumerAgentId: singleRecipient, consumerSource: 'recipient_token_evidence', consumerEvidence: recipientResult.evidence, deliveryFallbackReason, deliveryDiagnostics }
    }
    deliveryFallbackReason = 'recipient_direct_unavailable'
  }

  const senderAgentId = typeof input.senderAgentId === 'string' && input.senderAgentId.trim() ? input.senderAgentId.trim() : null
  if (senderAgentId) {
    const senderResult = await deliveryConsumerEvidence(db, {
      platform,
      channelId: input.channelId,
      providerChannelId,
      agentId: senderAgentId,
      source: 'sender_token_evidence',
    })
    deliveryDiagnostics.push(...senderResult.diagnostics)
    if (senderResult.evidence) {
      return { platform, channelExternalId, consumerAgentId: senderAgentId, consumerSource: 'sender_token_evidence', consumerEvidence: senderResult.evidence, deliveryFallbackReason, deliveryDiagnostics }
    }
    deliveryFallbackReason = 'sender_direct_unavailable'
  }

  const derivedResult = await derivedSingleConnectorEvidence(db, {
    platform,
    channelId: input.channelId,
    providerChannelId,
  })
  deliveryDiagnostics.push(...derivedResult.diagnostics)
  if (derivedResult.evidence) {
    return {
      platform,
      channelExternalId,
      consumerAgentId: derivedResult.evidence.agent_id,
      consumerSource: 'derived_single_connector',
      consumerEvidence: derivedResult.evidence,
      deliveryFallbackReason,
      deliveryDiagnostics,
    }
  }

  const policy = getChannelPolicy(input.channelId)
  if (policy.adapterOwner) {
    const adapterOwnerResult = await deliveryConsumerEvidence(db, {
      platform,
      channelId: input.channelId,
      providerChannelId,
      agentId: policy.adapterOwner,
      source: 'channel_policy_adapter_owner',
    })
    deliveryDiagnostics.push(...adapterOwnerResult.diagnostics)
    if (adapterOwnerResult.evidence) {
      const fallbackPermitted = input.fallbackAllowed === true || policy.adapterOwnerFallbackAllowed
      if (!fallbackPermitted) {
        deliveryDiagnostics.push({
          agent_id: policy.adapterOwner,
          connector_instance_id: adapterOwnerResult.evidence.connector_instance_id,
          source: 'channel_policy_adapter_owner',
          code: 'fallback_policy_denied',
          detail: {
            fallback_policy: 'adapter_owner',
            explicit_permit_required: true,
            connector_instance_id: adapterOwnerResult.evidence.connector_instance_id,
            channel_binding_id: adapterOwnerResult.evidence.channel_binding_id,
            provider_channel_access_id: adapterOwnerResult.evidence.provider_channel_access_id,
          },
        })
        return {
          platform,
          channelExternalId,
          consumerAgentId: null,
          consumerSource: 'channel_policy_adapter_owner',
          consumerEvidence: null,
          deliveryFallbackReason: deliveryFallbackReason ?? 'channel_policy_adapter_owner',
          deliveryDiagnostics,
        }
      }
      return {
        platform,
        channelExternalId,
        consumerAgentId: policy.adapterOwner,
        consumerSource: 'channel_policy_adapter_owner',
        consumerEvidence: adapterOwnerResult.evidence,
        deliveryFallbackReason: deliveryFallbackReason ?? 'channel_policy_adapter_owner',
        deliveryDiagnostics,
      }
    }
  }
  if (policy.primary) {
    const primaryResult = await deliveryConsumerEvidence(db, {
      platform,
      channelId: input.channelId,
      providerChannelId,
      agentId: policy.primary,
      source: 'channel_policy_primary',
    })
    deliveryDiagnostics.push(...primaryResult.diagnostics)
    if (primaryResult.evidence) {
      const fallbackPermitted = input.fallbackAllowed === true || policy.primaryFallbackAllowed
      if (!fallbackPermitted) {
        deliveryDiagnostics.push({
          agent_id: policy.primary,
          connector_instance_id: primaryResult.evidence.connector_instance_id,
          source: 'channel_policy_primary',
          code: 'fallback_policy_denied',
          detail: {
            fallback_policy: 'primary',
            explicit_permit_required: true,
            connector_instance_id: primaryResult.evidence.connector_instance_id,
            channel_binding_id: primaryResult.evidence.channel_binding_id,
            provider_channel_access_id: primaryResult.evidence.provider_channel_access_id,
          },
        })
        return {
          platform,
          channelExternalId,
          consumerAgentId: null,
          consumerSource: 'channel_policy_primary',
          consumerEvidence: null,
          deliveryFallbackReason: deliveryFallbackReason ?? 'channel_policy_primary',
          deliveryDiagnostics,
        }
      }
      return {
        platform,
        channelExternalId,
        consumerAgentId: policy.primary,
        consumerSource: 'channel_policy_primary',
        consumerEvidence: primaryResult.evidence,
        deliveryFallbackReason: deliveryFallbackReason ?? 'channel_policy_primary',
        deliveryDiagnostics,
      }
    }
  }
  return { platform, channelExternalId, consumerAgentId: null, consumerSource: 'none', consumerEvidence: null, deliveryFallbackReason, deliveryDiagnostics }
}

function fallbackProjection(
  base: Awaited<ReturnType<typeof resolveSurfaceAndConsumer>>,
  fallbackReason: ProjectionFallbackReason = null,
  intendedProjectionIdentityId: string | null = null,
): OutboundProjectionDecision {
  return {
    ...base,
    projectionIdentityId: base.consumerAgentId,
    intendedProjectionIdentityId,
    projectionSource: base.consumerAgentId ? 'fallback_adapter_owner' : 'none',
    projectionFallbackReason: fallbackReason,
    deliveryFallbackReason: base.deliveryFallbackReason,
    deliveryDiagnostics: base.deliveryDiagnostics,
  }
}

export async function resolveOutboundProjectionRoute(
  db: Queryable,
  input: OutboundProjectionInput,
): Promise<OutboundProjectionRoute> {
  await refreshChannelPolicyDbSnapshot(db)
  const base = await resolveSurfaceAndConsumer(db, input)
  return {
    platform: base.platform,
    channelExternalId: base.channelExternalId,
    consumerAgentId: base.consumerAgentId,
    source: base.consumerSource,
    consumerEvidence: base.consumerEvidence,
  }
}

export async function resolveOutboundProjectionDecision(
  db: Queryable,
  input: OutboundProjectionInput,
): Promise<OutboundProjectionDecision> {
  await refreshChannelPolicyDbSnapshot(db)
  const base = await resolveSurfaceAndConsumer(db, input)
  const singleRecipient = singleRecipientFrom(input.recipientAgentIds)
  let recipientFallbackReason: ProjectionFallbackReason = null

  if (singleRecipient) {
    const health = await projectionHealth(db, singleRecipient)
    if (health.healthy) {
      return {
        ...base,
        projectionIdentityId: singleRecipient,
        intendedProjectionIdentityId: singleRecipient,
        projectionSource: 'recipient_default_projection',
        projectionFallbackReason: null,
      }
    }
    recipientFallbackReason = !health.projectable
      ? 'recipient_projection_human'
      : health.registered
        ? 'recipient_projection_unhealthy'
        : 'recipient_projection_unregistered'
  }

  const policy = getChannelPolicy(input.channelId)
  const nativeProjectionIdentity = input.senderAgentId
    ? policy.nativeProjectionIdentities[input.senderAgentId] ?? policy.nativeRoleOutboundOwners[input.senderAgentId] ?? null
    : null
  if (nativeProjectionIdentity) {
    const health = await projectionHealth(db, nativeProjectionIdentity)
    if (health.healthy) {
      return {
        ...base,
        projectionIdentityId: nativeProjectionIdentity,
        intendedProjectionIdentityId: nativeProjectionIdentity,
        projectionSource: 'sender_native_projection',
        projectionFallbackReason: null,
      }
    }
    return fallbackProjection(
      base,
      health.registered ? 'native_projection_unhealthy' : 'native_projection_unregistered',
      nativeProjectionIdentity,
    )
  }

  if (singleRecipient) {
    return fallbackProjection(base, recipientFallbackReason, singleRecipient)
  }
  return fallbackProjection(base)
}

export function toEffectiveDeliveryOwnerResult(
  decision: OutboundProjectionDecision,
  options: { fallbackAllowed?: boolean } = {},
): EffectiveDeliveryOwnerResult {
  const legacyFallback = decision.consumerSource === 'channel_policy_adapter_owner'
    || decision.consumerSource === 'channel_policy_primary'
  if (legacyFallback && options.fallbackAllowed !== true) {
    return {
      ok: false,
      code: 'FALLBACK_POLICY_DENIED',
      evidence: {
        consumerAgentId: decision.consumerAgentId,
        consumerSource: decision.consumerSource,
        fallbackReason: decision.deliveryFallbackReason,
        diagnostics: decision.deliveryDiagnostics,
      },
    }
  }

  if (decision.consumerAgentId) {
    return {
      ok: true,
      source: effectiveDeliveryOwnerSource(decision),
      consumerAgentId: decision.consumerAgentId,
      connectorInstanceId: decision.consumerEvidence?.connector_instance_id ?? null,
      credentialId: decision.consumerEvidence?.credential_id ?? null,
      credentialStatus: decision.consumerEvidence?.credential_status ?? null,
      channelBindingId: decision.consumerEvidence?.channel_binding_id ?? null,
      providerChannelAccessId: decision.consumerEvidence?.provider_channel_access_id ?? null,
      evidence: decision.consumerEvidence,
      fallbackReason: decision.deliveryFallbackReason,
      diagnostics: decision.deliveryDiagnostics,
    }
  }

  return {
    ok: false,
    code: effectiveDeliveryOwnerFailureCode(decision.deliveryDiagnostics),
    evidence: {
      consumerAgentId: null,
      consumerSource: decision.consumerSource,
      fallbackReason: decision.deliveryFallbackReason,
      diagnostics: decision.deliveryDiagnostics,
    },
  }
}

export async function resolveEffectiveDeliveryOwner(
  db: Queryable,
  input: {
    channelId: string
    threadId?: string | null
    platform?: 'discord'
    senderAgentId?: string | null
    recipientAgentIds?: string[] | null
    fallbackAllowed?: boolean
  },
): Promise<EffectiveDeliveryOwnerResult> {
  const decision = await resolveOutboundProjectionDecision(db, input)
  const policy = getChannelPolicy(input.channelId)
  const policyFallbackAllowed =
    (decision.consumerSource === 'channel_policy_adapter_owner' && policy.adapterOwnerFallbackAllowed)
    || (decision.consumerSource === 'channel_policy_primary' && policy.primaryFallbackAllowed)
  return toEffectiveDeliveryOwnerResult(decision, {
    fallbackAllowed: input.fallbackAllowed === true || policyFallbackAllowed,
  })
}

function effectiveDeliveryOwnerSource(decision: OutboundProjectionDecision): EffectiveDeliveryOwnerSource {
  switch (decision.consumerSource) {
    case 'sender_token_evidence':
      return 'sender_direct'
    case 'recipient_token_evidence':
      return 'recipient_direct'
    case 'thread_adapter_metadata':
    case 'channel_adapter_metadata':
      return 'explicit_binding'
    case 'derived_single_connector':
      return 'derived_single_connector'
    case 'channel_policy_adapter_owner':
      return 'legacy_adapter_owner'
    case 'channel_policy_primary':
      return 'legacy_primary'
    default:
      return decision.consumerEvidence?.source_table === 'provider_channel_access'
        ? 'derived_single_connector'
        : 'explicit_binding'
  }
}

function effectiveDeliveryOwnerFailureCode(diagnostics: DeliveryConsumerDiagnostic[]): EffectiveDeliveryOwnerFailureCode {
  const codes = new Set(diagnostics.map((diagnostic) => diagnostic.code))
  if (codes.has('fallback_policy_denied')) return 'FALLBACK_POLICY_DENIED'
  if (codes.has('ambiguous_delivery_connectors')) return 'AMBIGUOUS_CONNECTOR'
  if (codes.has('credential_not_delivery_eligible') || codes.has('credential_missing')) return 'CREDENTIAL_NOT_DELIVERY_ELIGIBLE'
  if (codes.has('provider_write_access_missing') || codes.has('provider_write_access_read_only')) return 'PROVIDER_WRITE_ACCESS_MISSING'
  if (codes.has('write_binding_missing')) return 'BINDING_MISSING'
  return 'NO_ELIGIBLE_CONNECTOR'
}
