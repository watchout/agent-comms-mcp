import type { DbAdapter } from './db'
import { safeSecretRef, type SafeSecretRef } from './aun-connector-credential-diagnostic'

export const AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION = 'aun-connector-provider-identity-verify/v1'

export interface AunConnectorProviderIdentityVerifyOptions {
  agentId: string
  provider?: string
  dryRun: true
  now?: () => Date
}

export type AunConnectorProviderIdentityVerifyFindingSeverity = 'blocker' | 'warning'

export interface AunConnectorProviderIdentityVerifyFinding {
  severity: AunConnectorProviderIdentityVerifyFindingSeverity
  code: string
  agent_id: string
  provider: 'discord'
  details?: Record<string, unknown>
}

export interface AunConnectorProviderIdentityVerify {
  schema_version: typeof AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION
  generated_at: string
  dry_run: true
  provider: 'discord'
  agent_id: string
  verification_plan: {
    mode: 'dry_run_plan_only'
    live_provider_call: false
    intended_live_operation: 'discord_current_user_identity_check'
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
  summary: {
    blockers: number
    warnings: number
    credentials_scanned: number
    identities_scanned: number
    live_provider_calls: 0
  }
  findings: AunConnectorProviderIdentityVerifyFinding[]
  applied_mutations: []
}

interface AgentProfileRow {
  agent_id: string
  provider_token_source_ref?: string | null
  expected_provider_identity?: unknown
  profile_enabled?: boolean | number | string | null
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

const ACTIVE_CREDENTIAL_STATUSES = new Set(['registered', 'active'])
const ACTIVE_IDENTITY_STATUSES = new Set(['expected', 'verified'])
const BLOCKED_TRUST_STATUSES = new Set(['disabled', 'revoked'])

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

function expectedSubjectId(row: AgentProfileRow | null): string | null {
  if (!row) return null
  const expected = parseJsonObject(row.expected_provider_identity)
  return firstText(expected.subject_id) ?? firstText(expected.provider_subject_id)
}

function finding(
  severity: AunConnectorProviderIdentityVerifyFindingSeverity,
  code: string,
  agentId: string,
  details?: Record<string, unknown>,
): AunConnectorProviderIdentityVerifyFinding {
  return {
    severity,
    code,
    agent_id: agentId,
    provider: 'discord',
    ...(details ? { details } : {}),
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

export async function buildAunConnectorProviderIdentityVerify(
  db: DbAdapter,
  opts: AunConnectorProviderIdentityVerifyOptions,
): Promise<AunConnectorProviderIdentityVerify> {
  const now = opts.now ?? (() => new Date())
  const agentId = opts.agentId.trim()
  const [agent, credentials, identities] = await Promise.all([
    readAgentProfile(db, agentId),
    readCredentialEvidence(db, agentId),
    readProviderIdentityEvidence(db, agentId),
  ])
  const expected = expectedSubjectId(agent)
  const findings: AunConnectorProviderIdentityVerifyFinding[] = []

  if (!agent) {
    findings.push(finding('blocker', 'agent_not_found', agentId))
  } else if (!boolValue(agent.profile_enabled) || agent.disabled_at != null) {
    findings.push(finding('blocker', 'agent_profile_disabled', agentId))
  }

  if (agent && !expected) {
    findings.push(finding('blocker', 'expected_discord_subject_missing', agentId))
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
      expected_provider_subject_id: expected,
      observed_provider_subject_ids: activeIdentities.map((identity) => identity.provider_subject_id).sort(),
    }))
  }

  for (const credential of credentials) {
    const status = firstText(credential.status) ?? 'registered'
    const trustStatus = firstText(credential.trust_status) ?? 'local'
    if (BLOCKED_TRUST_STATUSES.has(trustStatus) || ['disabled', 'revoked'].includes(status)) {
      findings.push(finding('warning', 'ignored_disabled_or_revoked_credential', agentId, {
        credential_id: credential.credential_id,
        status,
        trust_status: trustStatus,
      }))
    }
    if (ACTIVE_CREDENTIAL_STATUSES.has(status) && !firstText(credential.token_fingerprint)) {
      findings.push(finding(status === 'active' ? 'blocker' : 'warning', 'credential_token_fingerprint_missing', agentId, {
        credential_id: credential.credential_id,
        status,
      }))
    }
  }

  const blockers = findings.filter((item) => item.severity === 'blocker').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    schema_version: AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION,
    generated_at: now().toISOString(),
    dry_run: true,
    provider: 'discord',
    agent_id: agentId,
    verification_plan: {
      mode: 'dry_run_plan_only',
      live_provider_call: false,
      intended_live_operation: 'discord_current_user_identity_check',
      expected_provider_subject_id: expected,
      expected_provider_subject_source: expected ? 'agents.expected_provider_identity' : null,
      evidence_sources: [
        'agents.expected_provider_identity',
        'connector_credentials.secret_ref',
        'connector_credentials.token_fingerprint',
        'agent_provider_identities.provider_subject_id',
      ],
      checks: [
        'resolve selected Discord bot-token secret ref without printing the secret',
        'call Discord current-user identity endpoint in a separately authorized live operation',
        'compare observed provider subject id with expected provider subject id',
        'record verification evidence only in a separately authorized mutation cell',
      ],
    },
    agent_profile: agent ? {
      agent_id: agent.agent_id,
      profile_enabled: boolValue(agent.profile_enabled) && agent.disabled_at == null,
      expected_provider_subject_id: expected,
      token_source_ref: safeSecretRef(firstText(agent.provider_token_source_ref)),
    } : null,
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
    summary: {
      blockers,
      warnings,
      credentials_scanned: credentials.length,
      identities_scanned: identities.length,
      live_provider_calls: 0,
    },
    findings,
    applied_mutations: [],
  }
}
