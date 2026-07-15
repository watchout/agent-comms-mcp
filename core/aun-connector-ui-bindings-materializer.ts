import type { DbAdapter } from './db'
import {
  buildAunConnectorChannelAccessDiscovery,
  type AunConnectorChannelAccessDiscovery,
} from './aun-connector-channel-access-discovery'
import { safeSecretRef, type SafeSecretRef } from './aun-connector-credential-diagnostic'

export const AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION = 'aun-connector-ui-bindings-materializer/v1'

export interface AunConnectorUiBindingsMaterializerOptions {
  agentId: string
  provider?: string
  dryRun: true
  now?: () => Date
}

export type AunConnectorUiBindingsMaterializerFindingSeverity = 'blocker' | 'warning'

export interface AunConnectorUiBindingsMaterializerFinding {
  severity: AunConnectorUiBindingsMaterializerFindingSeverity
  code: string
  agent_id: string
  provider: 'discord'
  ui_id?: string | null
  connector_instance_id?: string | null
  details?: Record<string, unknown>
}

export interface AunConnectorUiBindingsMaterializer {
  schema_version: typeof AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION
  generated_at: string
  dry_run: true
  provider: 'discord'
  agent_id: string
  materialization_plan: {
    mode: 'dry_run_plan_only'
    live_provider_call: false
    target_table: 'agent_ui_bindings'
    target_table_available: boolean
    intended_live_operation: 'agent_ui_binding_materialization'
    evidence_sources: string[]
    checks: string[]
  }
  agent_profile: AunConnectorChannelAccessDiscovery['agent_profile']
  connector_evidence: AunConnectorChannelAccessDiscovery['connector_evidence']
  credential_evidence: AunConnectorChannelAccessDiscovery['credential_evidence']
  provider_identity_evidence: AunConnectorChannelAccessDiscovery['provider_identity_evidence']
  channel_access_plan: AunConnectorChannelAccessDiscovery['channel_access_plan']
  existing_ui_bindings: Array<{
    agent_ui_binding_id: string
    agent_id: string
    ui_type: 'discord'
    ui_id: string
    ui_handle: string | null
    ui_token_ref: SafeSecretRef
    connector_instance_id: string | null
    credential_id: string | null
    provider_identity_id: string | null
    surface_role: string
    status: string
    trust_status: string
    metadata_keys: string[]
    created_at: string | null
    updated_at: string | null
  }>
  ui_bindings: Array<{
    operation: 'upsert_agent_ui_binding' | 'noop_existing_binding_matches'
    target_table: 'agent_ui_bindings'
    would_mutate: false
    mutation_authorized: false
    agent_id: string
    ui_type: 'discord'
    ui_id: string
    ui_handle: string | null
    ui_token_ref: SafeSecretRef
    connector_instance_id: string | null
    credential_id: string | null
    provider_identity_id: string | null
    surface_role: 'primary'
    status: 'registered'
    trust_status: 'local'
    source_evidence: {
      provider_identity_id: string
      credential_id: string
      connector_instance_id: string | null
      write_capable_channel_count: number
    }
    metadata: {
      planned_by: typeof AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION
      channel_access_plan_count: number
      provider_identity_status: string
      credential_status: string
    }
  }>
  summary: {
    blockers: number
    warnings: number
    connectors_scanned: number
    credentials_scanned: number
    identities_scanned: number
    channel_access_plan_scanned: number
    existing_ui_bindings_scanned: number
    planned_ui_bindings: number
    live_provider_calls: 0
  }
  findings: AunConnectorUiBindingsMaterializerFinding[]
  applied_mutations: []
}

interface UiBindingRow {
  agent_ui_binding_id: string
  agent_id: string
  ui_type: string
  ui_id: string
  ui_handle?: string | null
  ui_token_ref?: string | null
  connector_instance_id?: string | null
  credential_id?: string | null
  provider_identity_id?: string | null
  surface_role?: string | null
  status?: string | null
  trust_status?: string | null
  metadata?: unknown
  created_at?: string | null
  updated_at?: string | null
}

const ACTIVE_CONNECTOR_STATUSES = new Set(['registered', 'active', 'standby'])
const ACTIVE_CREDENTIAL_STATUSES = new Set(['registered', 'active'])
const ACTIVE_IDENTITY_STATUSES = new Set(['expected', 'verified'])
const ACTIVE_UI_BINDING_STATUSES = new Set(['registered', 'active'])
const BLOCKED_TRUST_STATUSES = new Set(['disabled', 'revoked'])

function firstText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
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

function schemaUnavailable(err: unknown): boolean {
  const message = String((err as Error).message ?? err)
  return /no such table|no such column|does not exist|undefined_table|undefined_column/i.test(message)
}

function finding(
  severity: AunConnectorUiBindingsMaterializerFindingSeverity,
  code: string,
  agentId: string,
  fields: Omit<AunConnectorUiBindingsMaterializerFinding, 'severity' | 'code' | 'agent_id' | 'provider'> = {},
): AunConnectorUiBindingsMaterializerFinding {
  return {
    severity,
    code,
    agent_id: agentId,
    provider: 'discord',
    ...fields,
  }
}

async function readExistingUiBindings(db: DbAdapter, agentId: string): Promise<{ available: boolean; rows: UiBindingRow[] }> {
  try {
    const rows = await db.query<UiBindingRow>(
      `SELECT agent_ui_binding_id,
              agent_id,
              ui_type,
              ui_id,
              ui_handle,
              ui_token_ref,
              connector_instance_id,
              credential_id,
              provider_identity_id,
              COALESCE(surface_role, 'primary') AS surface_role,
              COALESCE(status, 'registered') AS status,
              COALESCE(trust_status, 'local') AS trust_status,
              metadata,
              created_at,
              updated_at
         FROM agent_ui_bindings
        WHERE agent_id = $1
          AND ui_type = 'discord'
        ORDER BY
          CASE COALESCE(surface_role, 'primary')
            WHEN 'primary' THEN 0
            WHEN 'projection' THEN 1
            WHEN 'outbound' THEN 2
            ELSE 3
          END,
          agent_ui_binding_id`,
      [agentId],
    )
    return { available: true, rows }
  } catch (err) {
    if (schemaUnavailable(err)) return { available: false, rows: [] }
    throw err
  }
}

function normalizeExisting(row: UiBindingRow): AunConnectorUiBindingsMaterializer['existing_ui_bindings'][number] {
  return {
    agent_ui_binding_id: row.agent_ui_binding_id,
    agent_id: row.agent_id,
    ui_type: 'discord',
    ui_id: row.ui_id,
    ui_handle: firstText(row.ui_handle),
    ui_token_ref: safeSecretRef(firstText(row.ui_token_ref)),
    connector_instance_id: firstText(row.connector_instance_id),
    credential_id: firstText(row.credential_id),
    provider_identity_id: firstText(row.provider_identity_id),
    surface_role: firstText(row.surface_role) ?? 'primary',
    status: firstText(row.status) ?? 'registered',
    trust_status: firstText(row.trust_status) ?? 'local',
    metadata_keys: Object.keys(parseJsonObject(row.metadata)).sort(),
    created_at: firstText(row.created_at),
    updated_at: firstText(row.updated_at),
  }
}

function activeTrust(status: string, trustStatus: string, activeStatuses: Set<string>): boolean {
  return activeStatuses.has(status) && !BLOCKED_TRUST_STATUSES.has(trustStatus)
}

export async function buildAunConnectorUiBindingsMaterializer(
  db: DbAdapter,
  opts: AunConnectorUiBindingsMaterializerOptions,
): Promise<AunConnectorUiBindingsMaterializer> {
  const now = opts.now ?? (() => new Date())
  const agentId = opts.agentId.trim()
  const [discovery, existingResult] = await Promise.all([
    buildAunConnectorChannelAccessDiscovery(db, {
      agentId,
      provider: 'discord',
      dryRun: true,
      now,
    }),
    readExistingUiBindings(db, agentId),
  ])
  const findings: AunConnectorUiBindingsMaterializerFinding[] = discovery.findings.map((item) => ({
    severity: item.severity,
    code: `channel_access_${item.code}`,
    agent_id: item.agent_id,
    provider: 'discord',
    connector_instance_id: item.connector_instance_id,
    details: item.details,
  }))

  if (!existingResult.available) {
    findings.push(finding('warning', 'agent_ui_bindings_table_unavailable', agentId, {
      details: {
        target_table: 'agent_ui_bindings',
        reason: 'table_or_column_not_available_in_current_database',
      },
    }))
  }

  const connectors = discovery.connector_evidence.filter((connector) => {
    return activeTrust(connector.status, connector.trust_status, ACTIVE_CONNECTOR_STATUSES)
  })
  const credentials = discovery.credential_evidence.filter((credential) => {
    return activeTrust(credential.status, credential.trust_status, ACTIVE_CREDENTIAL_STATUSES)
      && credential.secret_ref.present
  })
  const identities = discovery.provider_identity_evidence.filter((identity) => {
    return activeTrust(identity.status, identity.trust_status, ACTIVE_IDENTITY_STATUSES)
      && identity.matches_expected_subject !== false
  })
  const writeCapablePlans = discovery.channel_access_plan.filter((plan) => plan.message_create_capability)

  const selectedIdentity = identities.find((identity) => identity.status === 'verified') ?? identities[0] ?? null
  const selectedCredential = credentials.find((credential) => {
    return credential.connector_instance_id !== null
      && connectors.some((connector) => connector.connector_instance_id === credential.connector_instance_id)
  }) ?? credentials[0] ?? null
  const selectedConnector = selectedCredential?.connector_instance_id
    ? connectors.find((connector) => connector.connector_instance_id === selectedCredential.connector_instance_id) ?? null
    : connectors[0] ?? null

  if (discovery.summary.blockers > 0) {
    findings.push(finding('blocker', 'channel_access_discovery_has_blockers', agentId, {
      details: { blocker_count: discovery.summary.blockers },
    }))
  }
  if (!selectedIdentity) {
    findings.push(finding('blocker', 'provider_identity_evidence_missing', agentId))
  }
  if (!selectedCredential) {
    findings.push(finding('blocker', 'usable_discord_bot_token_evidence_missing', agentId))
  }
  if (!selectedConnector) {
    findings.push(finding('blocker', 'usable_discord_connector_evidence_missing', agentId))
  }
  if (writeCapablePlans.length === 0) {
    findings.push(finding('blocker', 'write_capable_channel_access_evidence_missing', agentId))
  }

  const existingUiBindings = existingResult.rows.map(normalizeExisting)
  const matchingExisting = selectedIdentity
    ? existingUiBindings.find((binding) => {
      return binding.surface_role === 'primary'
        && binding.ui_id === selectedIdentity.provider_subject_id
        && activeTrust(binding.status, binding.trust_status, ACTIVE_UI_BINDING_STATUSES)
    }) ?? null
    : null

  if (selectedIdentity) {
    const conflictingExisting = existingUiBindings.find((binding) => {
      return binding.surface_role === 'primary'
        && binding.status !== 'disabled'
        && binding.ui_id !== selectedIdentity.provider_subject_id
    }) ?? null
    if (conflictingExisting) {
      findings.push(finding('blocker', 'primary_ui_binding_conflict', agentId, {
        ui_id: conflictingExisting.ui_id,
        connector_instance_id: conflictingExisting.connector_instance_id,
        details: {
          existing_agent_ui_binding_id: conflictingExisting.agent_ui_binding_id,
          expected_ui_id: selectedIdentity.provider_subject_id,
        },
      }))
    }
  }

  const blockers = findings.filter((item) => item.severity === 'blocker').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const canPlanBinding = blockers === 0 && selectedIdentity && selectedCredential && selectedConnector && writeCapablePlans.length > 0
  const uiBindings: AunConnectorUiBindingsMaterializer['ui_bindings'] = canPlanBinding
    ? [{
      operation: matchingExisting ? 'noop_existing_binding_matches' : 'upsert_agent_ui_binding',
      target_table: 'agent_ui_bindings',
      would_mutate: false,
      mutation_authorized: false,
      agent_id: agentId,
      ui_type: 'discord',
      ui_id: selectedIdentity.provider_subject_id,
      ui_handle: selectedIdentity.provider_handle,
      ui_token_ref: selectedCredential.secret_ref,
      connector_instance_id: selectedConnector.connector_instance_id,
      credential_id: selectedCredential.credential_id,
      provider_identity_id: selectedIdentity.provider_identity_id,
      surface_role: 'primary',
      status: 'registered',
      trust_status: 'local',
      source_evidence: {
        provider_identity_id: selectedIdentity.provider_identity_id,
        credential_id: selectedCredential.credential_id,
        connector_instance_id: selectedConnector.connector_instance_id,
        write_capable_channel_count: writeCapablePlans.length,
      },
      metadata: {
        planned_by: AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION,
        channel_access_plan_count: discovery.channel_access_plan.length,
        provider_identity_status: selectedIdentity.status,
        credential_status: selectedCredential.status,
      },
    }]
    : []

  return {
    schema_version: AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION,
    generated_at: now().toISOString(),
    dry_run: true,
    provider: 'discord',
    agent_id: agentId,
    materialization_plan: {
      mode: 'dry_run_plan_only',
      live_provider_call: false,
      target_table: 'agent_ui_bindings',
      target_table_available: existingResult.available,
      intended_live_operation: 'agent_ui_binding_materialization',
      evidence_sources: [
        'agents.expected_provider_identity',
        'connector_instances.connector_instance_id',
        'connector_credentials.secret_ref',
        'connector_credentials.token_fingerprint',
        'agent_provider_identities.provider_subject_id',
        'channel_connector_bindings.channel_id',
        'provider_channel_access.provider_channel_id',
        'agent_ui_bindings.agent_ui_binding_id',
      ],
      checks: [
        'derive intended Discord UI binding from existing provider identity evidence',
        'reuse existing credential evidence without printing raw token material',
        'require write-capable channel access evidence before planning a primary binding',
        'report intended agent_ui_bindings changes without executing DB mutations',
      ],
    },
    agent_profile: discovery.agent_profile,
    connector_evidence: discovery.connector_evidence,
    credential_evidence: discovery.credential_evidence,
    provider_identity_evidence: discovery.provider_identity_evidence,
    channel_access_plan: discovery.channel_access_plan,
    existing_ui_bindings: existingUiBindings,
    ui_bindings: uiBindings,
    summary: {
      blockers,
      warnings,
      connectors_scanned: discovery.summary.connectors_scanned,
      credentials_scanned: discovery.summary.credentials_scanned,
      identities_scanned: discovery.summary.identities_scanned,
      channel_access_plan_scanned: discovery.channel_access_plan.length,
      existing_ui_bindings_scanned: existingUiBindings.length,
      planned_ui_bindings: uiBindings.length,
      live_provider_calls: 0,
    },
    findings,
    applied_mutations: [],
  }
}
