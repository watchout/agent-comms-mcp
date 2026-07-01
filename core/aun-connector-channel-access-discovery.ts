import type { DbAdapter } from './db'
import { safeSecretRef, type SafeSecretRef } from './aun-connector-credential-diagnostic'

export const AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION = 'aun-connector-channel-access-discovery/v1'

export interface AunConnectorChannelAccessDiscoveryOptions {
  agentId: string
  provider?: string
  dryRun: true
  now?: () => Date
}

export type AunConnectorChannelAccessDiscoveryFindingSeverity = 'blocker' | 'warning'

export interface AunConnectorChannelAccessDiscoveryFinding {
  severity: AunConnectorChannelAccessDiscoveryFindingSeverity
  code: string
  agent_id: string
  provider: 'discord'
  channel_id?: string | null
  connector_instance_id?: string | null
  details?: Record<string, unknown>
}

export interface AunConnectorChannelAccessDiscovery {
  schema_version: typeof AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION
  generated_at: string
  dry_run: true
  provider: 'discord'
  agent_id: string
  discovery_plan: {
    mode: 'dry_run_plan_only'
    live_provider_call: false
    intended_live_operation: 'discord_channel_access_discovery'
    expected_provider_subject_id: string | null
    expected_provider_subject_source: 'agents.expected_provider_identity' | null
    evidence_sources: string[]
    checks: string[]
  }
  agent_profile: {
    agent_id: string
    profile_enabled: boolean
    expected_provider_subject_id: string | null
    token_source_ref: SafeSecretRef
  } | null
  connector_evidence: Array<{
    connector_instance_id: string
    connector_uri: string | null
    status: string
    trust_status: string
    runtime_instance_id: string | null
  }>
  credential_evidence: Array<{
    credential_id: string
    connector_instance_id: string | null
    status: string
    trust_status: string
    secret_ref: SafeSecretRef
    token_fingerprint_present: boolean
    last_verified_at: string | null
  }>
  provider_identity_evidence: Array<{
    provider_identity_id: string
    provider_subject_id: string
    provider_handle: string | null
    status: string
    trust_status: string
    source: string | null
    last_verified_at: string | null
    matches_expected_subject: boolean | null
  }>
  channel_binding_evidence: Array<{
    channel_binding_id: string
    channel_id: string
    channel_name: string | null
    provider_channel_id: string
    connector_instance_id: string | null
    binding_role: string
    priority: number
    ordering_scope: string
    status: string
    policy_source: string
  }>
  provider_channel_access_evidence: Array<{
    provider_channel_access_id: string
    provider_channel_id: string
    connector_instance_id: string | null
    agent_id: string | null
    capabilities: Record<string, unknown>
    status: string
    trust_status: string
    source: string | null
    discovered_at: string | null
    expires_at: string | null
  }>
  channel_access_plan: Array<{
    channel_id: string
    channel_name: string | null
    provider_channel_id: string
    connector_instance_id: string | null
    binding_role: string
    binding_status: string
    provider_channel_access_id: string | null
    provider_access_status: string | null
    provider_access_trust_status: string | null
    message_create_capability: boolean
    live_provider_call: false
    planned_live_checks: string[]
  }>
  summary: {
    blockers: number
    warnings: number
    connectors_scanned: number
    credentials_scanned: number
    identities_scanned: number
    channel_bindings_scanned: number
    provider_channel_access_scanned: number
    live_provider_calls: 0
  }
  findings: AunConnectorChannelAccessDiscoveryFinding[]
  applied_mutations: []
}

interface AgentProfileRow {
  agent_id: string
  provider_token_source_ref?: string | null
  expected_provider_identity?: unknown
  profile_enabled?: boolean | number | string | null
  disabled_at?: string | null
}

interface ConnectorEvidenceRow {
  connector_instance_id: string
  connector_uri?: string | null
  status?: string | null
  trust_status?: string | null
  runtime_instance_id?: string | null
  disabled_at?: string | null
}

interface CredentialEvidenceRow {
  credential_id: string
  connector_instance_id?: string | null
  secret_ref?: string | null
  token_fingerprint?: string | null
  status?: string | null
  trust_status?: string | null
  last_verified_at?: string | null
}

interface ProviderIdentityRow {
  provider_identity_id: string
  provider_subject_id: string
  provider_handle?: string | null
  status?: string | null
  trust_status?: string | null
  source?: string | null
  last_verified_at?: string | null
}

interface ChannelBindingRow {
  channel_binding_id: string
  channel_id: string
  channel_name?: string | null
  provider_channel_id?: string | null
  connector_instance_id?: string | null
  binding_role?: string | null
  priority?: number | string | null
  ordering_scope?: string | null
  status?: string | null
  policy_source?: string | null
}

interface ProviderChannelAccessRow {
  provider_channel_access_id: string
  provider_channel_id: string
  connector_instance_id?: string | null
  agent_id?: string | null
  capabilities?: unknown
  status?: string | null
  trust_status?: string | null
  source?: string | null
  discovered_at?: string | null
  expires_at?: string | null
}

const ACTIVE_CONNECTOR_STATUSES = new Set(['registered', 'active', 'standby'])
const ACTIVE_CREDENTIAL_STATUSES = new Set(['registered', 'active'])
const ACTIVE_IDENTITY_STATUSES = new Set(['expected', 'verified'])
const ACTIVE_BINDING_STATUSES = new Set(['active', 'standby'])
const ACTIVE_ACCESS_STATUSES = new Set(['active'])
const BLOCKED_TRUST_STATUSES = new Set(['disabled', 'revoked'])
const MESSAGE_CREATE_CAPABILITIES = [
  'message_create',
  'send_messages',
  'channel_message_create',
  'messages.write',
]

function firstText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function boolValue(value: unknown, fallback = true): boolean {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return !['false', '0', 'no'].includes(value.trim().toLowerCase())
  return fallback
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function expectedProvider(row: AgentProfileRow | null): string | null {
  if (!row) return null
  return firstText(parseJsonObject(row.expected_provider_identity).provider)
}

function expectedSubjectId(row: AgentProfileRow | null): string | null {
  if (!row) return null
  const expected = parseJsonObject(row.expected_provider_identity)
  return firstText(expected.subject_id) ?? firstText(expected.provider_subject_id)
}

function normalizedPriority(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 100
}

function hasMessageCreateCapability(capabilities: Record<string, unknown>): boolean {
  return MESSAGE_CREATE_CAPABILITIES.some((key) => capabilities[key] === true)
}

function finding(
  severity: AunConnectorChannelAccessDiscoveryFindingSeverity,
  code: string,
  agentId: string,
  fields: Omit<AunConnectorChannelAccessDiscoveryFinding, 'severity' | 'code' | 'agent_id' | 'provider'> = {},
): AunConnectorChannelAccessDiscoveryFinding {
  return {
    severity,
    code,
    agent_id: agentId,
    provider: 'discord',
    ...fields,
  }
}

async function readAgentProfile(db: DbAdapter, agentId: string): Promise<AgentProfileRow | null> {
  return db.queryOne<AgentProfileRow>(
    `SELECT agent_id,
            provider_token_source_ref,
            expected_provider_identity,
            profile_enabled,
            disabled_at
       FROM agents
      WHERE agent_id = $1
        AND COALESCE(agent_type, '') <> 'human'
      LIMIT 1`,
    [agentId],
  )
}

async function readConnectors(db: DbAdapter, agentId: string): Promise<ConnectorEvidenceRow[]> {
  return db.query<ConnectorEvidenceRow>(
    `SELECT connector_instance_id,
            connector_uri,
            COALESCE(status, 'registered') AS status,
            COALESCE(trust_status, 'local') AS trust_status,
            runtime_instance_id,
            disabled_at
       FROM connector_instances
      WHERE agent_id = $1
        AND provider = 'discord'
      ORDER BY
        CASE COALESCE(status, 'registered')
          WHEN 'active' THEN 0
          WHEN 'registered' THEN 1
          WHEN 'standby' THEN 2
          ELSE 3
        END,
        connector_instance_id`,
    [agentId],
  )
}

async function readCredentialEvidence(db: DbAdapter, agentId: string): Promise<CredentialEvidenceRow[]> {
  return db.query<CredentialEvidenceRow>(
    `SELECT credential_id,
            connector_instance_id,
            secret_ref,
            token_fingerprint,
            COALESCE(status, 'registered') AS status,
            COALESCE(trust_status, 'local') AS trust_status,
            last_verified_at
       FROM connector_credentials
      WHERE agent_id = $1
        AND provider = 'discord'
        AND credential_kind = 'bot_token'
      ORDER BY
        CASE COALESCE(status, 'registered')
          WHEN 'active' THEN 0
          WHEN 'registered' THEN 1
          ELSE 2
        END,
        credential_id`,
    [agentId],
  )
}

async function readProviderIdentityEvidence(db: DbAdapter, agentId: string): Promise<ProviderIdentityRow[]> {
  return db.query<ProviderIdentityRow>(
    `SELECT provider_identity_id,
            provider_subject_id,
            provider_handle,
            COALESCE(status, 'expected') AS status,
            COALESCE(trust_status, 'local') AS trust_status,
            source,
            last_verified_at
       FROM agent_provider_identities
      WHERE agent_id = $1
        AND provider = 'discord'
      ORDER BY
        CASE COALESCE(status, 'expected')
          WHEN 'verified' THEN 0
          WHEN 'expected' THEN 1
          ELSE 2
        END,
        provider_identity_id`,
    [agentId],
  )
}

async function readChannelBindings(db: DbAdapter, agentId: string): Promise<ChannelBindingRow[]> {
  return db.query<ChannelBindingRow>(
    `SELECT b.channel_binding_id,
            b.channel_id,
            c.name AS channel_name,
            COALESCE(ca.external_id, b.channel_id) AS provider_channel_id,
            b.connector_instance_id,
            COALESCE(b.binding_role, 'outbound') AS binding_role,
            COALESCE(b.priority, 100) AS priority,
            COALESCE(b.ordering_scope, 'thread') AS ordering_scope,
            COALESCE(b.status, 'active') AS status,
            COALESCE(b.policy_source, 'db') AS policy_source
       FROM channel_connector_bindings b
       JOIN connector_instances ci
         ON ci.connector_instance_id = b.connector_instance_id
       LEFT JOIN channels c
         ON c.id = b.channel_id
       LEFT JOIN channel_adapters ca
         ON ca.channel_id = b.channel_id
        AND ca.platform = b.provider
      WHERE ci.agent_id = $1
        AND b.provider = 'discord'
      ORDER BY b.channel_id,
               b.priority,
               b.channel_binding_id`,
    [agentId],
  )
}

async function readProviderChannelAccess(db: DbAdapter, agentId: string): Promise<ProviderChannelAccessRow[]> {
  return db.query<ProviderChannelAccessRow>(
    `SELECT pca.provider_channel_access_id,
            pca.provider_channel_id,
            pca.connector_instance_id,
            pca.agent_id,
            pca.capabilities,
            COALESCE(pca.status, 'active') AS status,
            COALESCE(pca.trust_status, 'local') AS trust_status,
            pca.source,
            pca.discovered_at,
            pca.expires_at
       FROM provider_channel_access pca
       JOIN connector_instances ci
         ON ci.connector_instance_id = pca.connector_instance_id
      WHERE ci.agent_id = $1
        AND pca.provider = 'discord'
      ORDER BY pca.provider_channel_id,
               pca.provider_channel_access_id`,
    [agentId],
  )
}

export async function buildAunConnectorChannelAccessDiscovery(
  db: DbAdapter,
  opts: AunConnectorChannelAccessDiscoveryOptions,
): Promise<AunConnectorChannelAccessDiscovery> {
  const now = opts.now ?? (() => new Date())
  const agentId = opts.agentId.trim()
  const [agent, connectors, credentials, identities, bindings, accessRows] = await Promise.all([
    readAgentProfile(db, agentId),
    readConnectors(db, agentId),
    readCredentialEvidence(db, agentId),
    readProviderIdentityEvidence(db, agentId),
    readChannelBindings(db, agentId),
    readProviderChannelAccess(db, agentId),
  ])
  const expected = expectedSubjectId(agent)
  const findings: AunConnectorChannelAccessDiscoveryFinding[] = []

  if (!agent) {
    findings.push(finding('blocker', 'agent_not_found', agentId))
  } else if (!boolValue(agent.profile_enabled) || agent.disabled_at != null) {
    findings.push(finding('blocker', 'agent_profile_disabled', agentId))
  }

  if (agent && expectedProvider(agent) !== 'discord') {
    findings.push(finding('blocker', 'expected_discord_provider_missing', agentId, {
      details: { expected_provider: expectedProvider(agent) },
    }))
  }

  const usableConnectors = connectors.filter((connector) => {
    const status = firstText(connector.status) ?? 'registered'
    const trustStatus = firstText(connector.trust_status) ?? 'local'
    return ACTIVE_CONNECTOR_STATUSES.has(status)
      && !BLOCKED_TRUST_STATUSES.has(trustStatus)
      && connector.disabled_at == null
  })
  if (agent && usableConnectors.length === 0) {
    findings.push(finding('blocker', 'usable_discord_connector_evidence_missing', agentId))
  }

  const usableCredentials = credentials.filter((credential) => {
    const status = firstText(credential.status) ?? 'registered'
    const trustStatus = firstText(credential.trust_status) ?? 'local'
    return ACTIVE_CREDENTIAL_STATUSES.has(status)
      && !BLOCKED_TRUST_STATUSES.has(trustStatus)
      && firstText(credential.secret_ref) !== null
  })
  if (agent && usableCredentials.length === 0) {
    findings.push(finding('blocker', 'usable_discord_bot_token_evidence_missing', agentId))
  }

  const activeIdentities = identities.filter((identity) => {
    const status = firstText(identity.status) ?? 'expected'
    const trustStatus = firstText(identity.trust_status) ?? 'local'
    return ACTIVE_IDENTITY_STATUSES.has(status) && !BLOCKED_TRUST_STATUSES.has(trustStatus)
  })
  if (agent && activeIdentities.length === 0) {
    findings.push(finding('warning', 'provider_identity_evidence_missing', agentId))
  }
  if (expected && activeIdentities.length > 0 && !activeIdentities.some((identity) => identity.provider_subject_id === expected)) {
    findings.push(finding('blocker', 'expected_discord_subject_mismatch', agentId, {
      details: {
        expected_provider_subject_id: expected,
        observed_provider_subject_ids: activeIdentities.map((identity) => identity.provider_subject_id).sort(),
      },
    }))
  }

  const activeBindings = bindings.filter((binding) => {
    const status = firstText(binding.status) ?? 'active'
    return ACTIVE_BINDING_STATUSES.has(status)
  })
  if (agent && activeBindings.length === 0) {
    findings.push(finding('blocker', 'channel_binding_evidence_missing', agentId))
  }

  const accessByConnectorAndChannel = new Map<string, ProviderChannelAccessRow[]>()
  for (const row of accessRows) {
    const connectorId = firstText(row.connector_instance_id)
    const channelId = firstText(row.provider_channel_id)
    if (!connectorId || !channelId) continue
    const key = `${connectorId}\0${channelId}`
    const current = accessByConnectorAndChannel.get(key) ?? []
    current.push(row)
    accessByConnectorAndChannel.set(key, current)
  }

  const channelAccessPlan = bindings.map((binding) => {
    const connectorId = firstText(binding.connector_instance_id)
    const providerChannelId = firstText(binding.provider_channel_id) ?? binding.channel_id
    const accessCandidates = connectorId
      ? accessByConnectorAndChannel.get(`${connectorId}\0${providerChannelId}`) ?? []
      : []
    const selectedAccess = accessCandidates.find((access) => {
      const status = firstText(access.status) ?? 'active'
      const trustStatus = firstText(access.trust_status) ?? 'local'
      return ACTIVE_ACCESS_STATUSES.has(status) && !BLOCKED_TRUST_STATUSES.has(trustStatus)
    }) ?? null
    const capabilities = parseJsonObject(selectedAccess?.capabilities)
    const messageCreateCapability = selectedAccess ? hasMessageCreateCapability(capabilities) : false
    const bindingStatus = firstText(binding.status) ?? 'active'

    if (ACTIVE_BINDING_STATUSES.has(bindingStatus) && !selectedAccess) {
      findings.push(finding('warning', 'provider_channel_access_evidence_missing', agentId, {
        channel_id: binding.channel_id,
        connector_instance_id: connectorId,
        details: { provider_channel_id: providerChannelId },
      }))
    } else if (selectedAccess && !messageCreateCapability) {
      findings.push(finding('warning', 'provider_channel_message_create_capability_missing', agentId, {
        channel_id: binding.channel_id,
        connector_instance_id: connectorId,
        details: {
          provider_channel_access_id: selectedAccess.provider_channel_access_id,
          provider_channel_id: providerChannelId,
          capabilities,
        },
      }))
    }

    return {
      channel_id: binding.channel_id,
      channel_name: firstText(binding.channel_name),
      provider_channel_id: providerChannelId,
      connector_instance_id: connectorId,
      binding_role: firstText(binding.binding_role) ?? 'outbound',
      binding_status: bindingStatus,
      provider_channel_access_id: firstText(selectedAccess?.provider_channel_access_id),
      provider_access_status: firstText(selectedAccess?.status),
      provider_access_trust_status: firstText(selectedAccess?.trust_status),
      message_create_capability: messageCreateCapability,
      live_provider_call: false as const,
      planned_live_checks: [
        'fetch Discord channel permissions for the selected connector identity',
        'compare observed channel visibility and message create permission with provider_channel_access evidence',
        'record provider channel access evidence only in a separately authorized mutation cell',
      ],
    }
  })

  const blockers = findings.filter((item) => item.severity === 'blocker').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    schema_version: AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION,
    generated_at: now().toISOString(),
    dry_run: true,
    provider: 'discord',
    agent_id: agentId,
    discovery_plan: {
      mode: 'dry_run_plan_only',
      live_provider_call: false,
      intended_live_operation: 'discord_channel_access_discovery',
      expected_provider_subject_id: expected,
      expected_provider_subject_source: expected ? 'agents.expected_provider_identity' : null,
      evidence_sources: [
        'agents.expected_provider_identity',
        'connector_instances.connector_instance_id',
        'connector_credentials.secret_ref',
        'connector_credentials.token_fingerprint',
        'agent_provider_identities.provider_subject_id',
        'channel_connector_bindings.channel_id',
        'provider_channel_access.provider_channel_id',
      ],
      checks: [
        'resolve selected Discord bot-token secret ref without printing the secret',
        'call Discord channel permission endpoints only in a separately authorized live operation',
        'compare observed provider channel access with existing channel_connector_bindings and provider_channel_access evidence',
        'record discovered channel access evidence only in a separately authorized mutation cell',
      ],
    },
    agent_profile: agent ? {
      agent_id: agent.agent_id,
      profile_enabled: boolValue(agent.profile_enabled) && agent.disabled_at == null,
      expected_provider_subject_id: expected,
      token_source_ref: safeSecretRef(firstText(agent.provider_token_source_ref)),
    } : null,
    connector_evidence: connectors.map((row) => ({
      connector_instance_id: row.connector_instance_id,
      connector_uri: firstText(row.connector_uri),
      status: firstText(row.status) ?? 'registered',
      trust_status: firstText(row.trust_status) ?? 'local',
      runtime_instance_id: firstText(row.runtime_instance_id),
    })),
    credential_evidence: credentials.map((row) => ({
      credential_id: row.credential_id,
      connector_instance_id: firstText(row.connector_instance_id),
      status: firstText(row.status) ?? 'registered',
      trust_status: firstText(row.trust_status) ?? 'local',
      secret_ref: safeSecretRef(firstText(row.secret_ref)),
      token_fingerprint_present: Boolean(firstText(row.token_fingerprint)),
      last_verified_at: firstText(row.last_verified_at),
    })),
    provider_identity_evidence: identities.map((row) => ({
      provider_identity_id: row.provider_identity_id,
      provider_subject_id: row.provider_subject_id,
      provider_handle: firstText(row.provider_handle),
      status: firstText(row.status) ?? 'expected',
      trust_status: firstText(row.trust_status) ?? 'local',
      source: firstText(row.source),
      last_verified_at: firstText(row.last_verified_at),
      matches_expected_subject: expected ? row.provider_subject_id === expected : null,
    })),
    channel_binding_evidence: bindings.map((row) => ({
      channel_binding_id: row.channel_binding_id,
      channel_id: row.channel_id,
      channel_name: firstText(row.channel_name),
      provider_channel_id: firstText(row.provider_channel_id) ?? row.channel_id,
      connector_instance_id: firstText(row.connector_instance_id),
      binding_role: firstText(row.binding_role) ?? 'outbound',
      priority: normalizedPriority(row.priority),
      ordering_scope: firstText(row.ordering_scope) ?? 'thread',
      status: firstText(row.status) ?? 'active',
      policy_source: firstText(row.policy_source) ?? 'db',
    })),
    provider_channel_access_evidence: accessRows.map((row) => ({
      provider_channel_access_id: row.provider_channel_access_id,
      provider_channel_id: row.provider_channel_id,
      connector_instance_id: firstText(row.connector_instance_id),
      agent_id: firstText(row.agent_id),
      capabilities: parseJsonObject(row.capabilities),
      status: firstText(row.status) ?? 'active',
      trust_status: firstText(row.trust_status) ?? 'local',
      source: firstText(row.source),
      discovered_at: firstText(row.discovered_at),
      expires_at: firstText(row.expires_at),
    })),
    channel_access_plan: channelAccessPlan,
    summary: {
      blockers,
      warnings,
      connectors_scanned: connectors.length,
      credentials_scanned: credentials.length,
      identities_scanned: identities.length,
      channel_bindings_scanned: bindings.length,
      provider_channel_access_scanned: accessRows.length,
      live_provider_calls: 0,
    },
    findings,
    applied_mutations: [],
  }
}
