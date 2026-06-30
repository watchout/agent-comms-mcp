import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'

export const AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION = 'aun-connector-credential-diagnostic/v1'

export interface AunConnectorCredentialDiagnosticOptions {
  agentId?: string
  provider?: string
  now?: () => Date
}

export type AunConnectorCredentialFindingSeverity = 'blocker' | 'warning'

export interface SafeSecretRef {
  present: boolean
  display: string | null
  scheme: string | null
  redacted: boolean
  raw_secret_like: boolean
  digest: string | null
}

export interface AunConnectorCredentialFinding {
  severity: AunConnectorCredentialFindingSeverity
  code: string
  agent_id?: string | null
  provider?: string | null
  credential_id?: string | null
  connector_instance_id?: string | null
  secret_ref?: SafeSecretRef
  details?: Record<string, unknown>
}

export interface AunConnectorCredentialDiagnostic {
  schema_version: typeof AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION
  generated_at: string
  filters: {
    agent_id: string | null
    provider: string | null
  }
  summary: {
    agents_scanned: number
    connectors_scanned: number
    credentials_scanned: number
    active_credentials: number
    blockers: number
    warnings: number
  }
  agents: Array<{
    agent_id: string
    profile_enabled: boolean
    expected_provider: string | null
    expected_provider_subject_set: boolean
    token_source_ref: SafeSecretRef
  }>
  connectors: Array<{
    connector_instance_id: string
    agent_id: string
    provider: string
    connector_uri: string | null
    status: string
    trust_status: string
    runtime_instance_id: string | null
    credential_count: number
  }>
  credentials: Array<{
    credential_id: string
    agent_id: string
    provider: string
    connector_instance_id: string | null
    connector_agent_id: string | null
    connector_status: string | null
    credential_kind: string
    status: string
    trust_status: string
    secret_ref: SafeSecretRef
    token_fingerprint_present: boolean
    last_verified_at: string | null
    owner_matches_connector: boolean | null
  }>
  findings: AunConnectorCredentialFinding[]
  applied_mutations: []
}

interface AgentRow {
  agent_id: string
  provider_token_source_ref?: string | null
  expected_provider_identity?: unknown
  profile_enabled?: boolean | number | null
  disabled_at?: string | null
}

interface ConnectorRow {
  connector_instance_id: string
  agent_id: string
  provider: string
  connector_uri?: string | null
  status?: string | null
  trust_status?: string | null
  runtime_instance_id?: string | null
}

interface CredentialRow {
  credential_id: string
  agent_id: string
  provider: string
  connector_instance_id?: string | null
  credential_kind?: string | null
  secret_ref?: string | null
  token_fingerprint?: string | null
  status?: string | null
  trust_status?: string | null
  last_verified_at?: string | null
  connector_agent_id?: string | null
  connector_status?: string | null
}

const ACTIVE_CREDENTIAL_STATUSES = new Set(['registered', 'active'])
const BLOCKED_STATUSES = new Set(['disabled', 'revoked'])
const BLOCKED_TRUST_STATUSES = new Set(['disabled', 'revoked'])
const SAFE_SECRET_REF_SCHEMES = new Set([
  'env',
  'local-env',
  'mcp-json',
  'keychain',
  'vault',
  'secret',
  'file',
])

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

function expectedProvider(row: AgentRow): string | null {
  const expected = parseJsonObject(row.expected_provider_identity)
  return firstText(expected.provider)
}

function expectedProviderSubjectSet(row: AgentRow): boolean {
  const expected = parseJsonObject(row.expected_provider_identity)
  return Boolean(firstText(expected.subject_id) ?? firstText(expected.provider_subject_id))
}

function schemeFor(ref: string | null): string | null {
  if (!ref) return null
  const match = ref.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)
  return match?.[1]?.toLowerCase() ?? null
}

export function looksLikeRawSecret(value: string | null | undefined): boolean {
  const text = value?.trim() ?? ''
  if (!text) return false
  const scheme = schemeFor(text)
  if (scheme && SAFE_SECRET_REF_SCHEMES.has(scheme)) return false
  if (/^(ghp|github_pat|xox[baprs]|sk|rk)_[A-Za-z0-9_-]{20,}$/u.test(text)) return true
  if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/u.test(text)) return true
  return !scheme && text.length >= 48 && /^[A-Za-z0-9._~+/=-]+$/u.test(text)
}

export function safeSecretRef(value: string | null | undefined): SafeSecretRef {
  const text = value?.trim() ?? ''
  if (!text) {
    return {
      present: false,
      display: null,
      scheme: null,
      redacted: false,
      raw_secret_like: false,
      digest: null,
    }
  }
  const scheme = schemeFor(text)
  const rawSecretLike = looksLikeRawSecret(text)
  const safeScheme = scheme !== null && SAFE_SECRET_REF_SCHEMES.has(scheme)
  const digest = rawSecretLike
    ? null
    : createHash('sha256').update(text).digest('hex').slice(0, 16)
  return {
    present: true,
    display: rawSecretLike ? '[redacted:raw-secret-like]' : safeScheme ? text : '[redacted:unknown-secret-ref]',
    scheme,
    redacted: rawSecretLike || !safeScheme,
    raw_secret_like: rawSecretLike,
    digest,
  }
}

function finding(
  severity: AunConnectorCredentialFindingSeverity,
  code: string,
  fields: Omit<AunConnectorCredentialFinding, 'severity' | 'code'> = {},
): AunConnectorCredentialFinding {
  return { severity, code, ...fields }
}

function filtersWhere(opts: AunConnectorCredentialDiagnosticOptions, alias: string): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.agentId) {
    params.push(opts.agentId)
    clauses.push(`${alias}.agent_id = $${params.length}`)
  }
  if (opts.provider) {
    params.push(opts.provider)
    clauses.push(`${alias}.provider = $${params.length}`)
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}

async function readAgents(db: DbAdapter, opts: AunConnectorCredentialDiagnosticOptions): Promise<AgentRow[]> {
  const params: unknown[] = []
  const clauses = ["COALESCE(agent_type, '') <> 'human'"]
  if (opts.agentId) {
    params.push(opts.agentId)
    clauses.push(`agent_id = $${params.length}`)
  }
  const rows = await db.query<AgentRow>(
    `SELECT agent_id,
            provider_token_source_ref,
            expected_provider_identity,
            profile_enabled,
            disabled_at
       FROM agents
      WHERE ${clauses.join(' AND ')}
      ORDER BY agent_id`,
    params,
  )
  return opts.provider ? rows.filter((row) => expectedProvider(row) === opts.provider) : rows
}

async function readConnectors(db: DbAdapter, opts: AunConnectorCredentialDiagnosticOptions): Promise<ConnectorRow[]> {
  const where = filtersWhere(opts, 'ci')
  return db.query<ConnectorRow>(
    `SELECT ci.connector_instance_id,
            ci.agent_id,
            ci.provider,
            ci.connector_uri,
            ci.status,
            ci.trust_status,
            ci.runtime_instance_id
       FROM connector_instances ci
       ${where.sql}
      ORDER BY ci.agent_id, ci.provider, ci.connector_uri, ci.connector_instance_id`,
    where.params,
  )
}

async function readCredentials(db: DbAdapter, opts: AunConnectorCredentialDiagnosticOptions): Promise<CredentialRow[]> {
  const where = filtersWhere(opts, 'cc')
  return db.query<CredentialRow>(
    `SELECT cc.credential_id,
            cc.agent_id,
            cc.provider,
            cc.connector_instance_id,
            cc.credential_kind,
            cc.secret_ref,
            cc.token_fingerprint,
            cc.status,
            cc.trust_status,
            cc.last_verified_at,
            ci.agent_id AS connector_agent_id,
            ci.status AS connector_status
       FROM connector_credentials cc
       LEFT JOIN connector_instances ci
         ON ci.connector_instance_id = cc.connector_instance_id
       ${where.sql}
      ORDER BY cc.agent_id, cc.provider, cc.credential_id`,
    where.params,
  )
}

export async function buildAunConnectorCredentialDiagnostic(
  db: DbAdapter,
  opts: AunConnectorCredentialDiagnosticOptions = {},
): Promise<AunConnectorCredentialDiagnostic> {
  const now = opts.now ?? (() => new Date())
  const provider = firstText(opts.provider)
  const agentId = firstText(opts.agentId)
  const normalized = { ...opts, provider: provider ?? undefined, agentId: agentId ?? undefined }
  const [agents, connectors, credentials] = await Promise.all([
    readAgents(db, normalized),
    readConnectors(db, normalized),
    readCredentials(db, normalized),
  ])

  const findings: AunConnectorCredentialFinding[] = []
  const credentialsByConnector = new Map<string, CredentialRow[]>()
  for (const credential of credentials) {
    const connectorId = firstText(credential.connector_instance_id)
    if (!connectorId) continue
    const current = credentialsByConnector.get(connectorId) ?? []
    current.push(credential)
    credentialsByConnector.set(connectorId, current)
  }

  for (const agent of agents) {
    const expected = expectedProvider(agent)
    const tokenSourceRef = firstText(agent.provider_token_source_ref)
    const safeRef = safeSecretRef(tokenSourceRef)
    if (tokenSourceRef && safeRef.raw_secret_like) {
      findings.push(finding('blocker', 'raw_secret_like_agent_token_source_ref', {
        agent_id: agent.agent_id,
        provider: expected,
        secret_ref: safeRef,
      }))
    }
    if (tokenSourceRef && !expected) {
      findings.push(finding('blocker', 'agent_token_source_without_expected_provider', {
        agent_id: agent.agent_id,
        secret_ref: safeRef,
      }))
    }
    if (expected && !tokenSourceRef) {
      findings.push(finding('blocker', 'agent_expected_provider_without_token_source_ref', {
        agent_id: agent.agent_id,
        provider: expected,
      }))
    }
    if (expected && tokenSourceRef) {
      const matchingCredential = credentials.find((credential) => {
        return credential.agent_id === agent.agent_id
          && credential.provider === expected
          && firstText(credential.secret_ref) === tokenSourceRef
          && ACTIVE_CREDENTIAL_STATUSES.has(firstText(credential.status) ?? 'registered')
      })
      if (!matchingCredential) {
        findings.push(finding('warning', 'agent_profile_missing_matching_credential_evidence', {
          agent_id: agent.agent_id,
          provider: expected,
          secret_ref: safeRef,
        }))
      }
    }
  }

  const activeSecretRefs = new Map<string, CredentialRow[]>()
  for (const credential of credentials) {
    const secretRef = firstText(credential.secret_ref)
    const safeRef = safeSecretRef(secretRef)
    const status = firstText(credential.status) ?? 'registered'
    const trustStatus = firstText(credential.trust_status) ?? 'local'
    if (safeRef.raw_secret_like) {
      findings.push(finding('blocker', 'raw_secret_like_credential_secret_ref', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
        connector_instance_id: firstText(credential.connector_instance_id),
        secret_ref: safeRef,
      }))
    }
    if (BLOCKED_STATUSES.has(status) || BLOCKED_TRUST_STATUSES.has(trustStatus)) {
      findings.push(finding('blocker', 'credential_disabled_or_revoked', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
        connector_instance_id: firstText(credential.connector_instance_id),
        details: { status, trust_status: trustStatus },
      }))
    }
    if (!firstText(credential.connector_instance_id)) {
      findings.push(finding('blocker', 'credential_missing_connector_instance', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
      }))
    }
    if (firstText(credential.connector_instance_id) && !firstText(credential.connector_agent_id)) {
      findings.push(finding('blocker', 'credential_connector_not_found', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
        connector_instance_id: firstText(credential.connector_instance_id),
      }))
    }
    if (firstText(credential.connector_agent_id) && credential.connector_agent_id !== credential.agent_id) {
      findings.push(finding('blocker', 'credential_connector_owner_mismatch', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
        connector_instance_id: firstText(credential.connector_instance_id),
        details: { connector_agent_id: credential.connector_agent_id },
      }))
    }
    if (status === 'active' && !firstText(credential.token_fingerprint)) {
      findings.push(finding('blocker', 'active_credential_missing_token_fingerprint', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
      }))
    } else if (status === 'registered' && !firstText(credential.token_fingerprint)) {
      findings.push(finding('warning', 'registered_credential_missing_token_fingerprint', {
        agent_id: credential.agent_id,
        provider: credential.provider,
        credential_id: credential.credential_id,
      }))
    }
    if (ACTIVE_CREDENTIAL_STATUSES.has(status) && secretRef) {
      const key = `${credential.provider}\0${secretRef}`
      const current = activeSecretRefs.get(key) ?? []
      current.push(credential)
      activeSecretRefs.set(key, current)
    }
  }

  for (const duplicateRows of activeSecretRefs.values()) {
    const agents = new Set(duplicateRows.map((row) => row.agent_id))
    if (duplicateRows.length > 1 && agents.size > 1) {
      findings.push(finding('blocker', 'duplicate_active_secret_ref', {
        provider: duplicateRows[0].provider,
        secret_ref: safeSecretRef(firstText(duplicateRows[0].secret_ref)),
        details: {
          agents: [...agents].sort(),
          credential_ids: duplicateRows.map((row) => row.credential_id).sort(),
        },
      }))
    }
  }

  for (const connector of connectors) {
    const status = firstText(connector.status) ?? 'registered'
    const connectorCredentials = credentialsByConnector.get(connector.connector_instance_id) ?? []
    const usableCredentials = connectorCredentials.filter((credential) => {
      const credentialStatus = firstText(credential.status) ?? 'registered'
      const trustStatus = firstText(credential.trust_status) ?? 'local'
      return ACTIVE_CREDENTIAL_STATUSES.has(credentialStatus) && !BLOCKED_TRUST_STATUSES.has(trustStatus)
    })
    if (['registered', 'active'].includes(status) && usableCredentials.length === 0) {
      findings.push(finding(status === 'active' ? 'blocker' : 'warning', 'connector_missing_usable_credential', {
        agent_id: connector.agent_id,
        provider: connector.provider,
        connector_instance_id: connector.connector_instance_id,
        details: { connector_status: status },
      }))
    }
  }

  const blockers = findings.filter((item) => item.severity === 'blocker').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    schema_version: AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION,
    generated_at: now().toISOString(),
    filters: {
      agent_id: agentId,
      provider,
    },
    summary: {
      agents_scanned: agents.length,
      connectors_scanned: connectors.length,
      credentials_scanned: credentials.length,
      active_credentials: credentials.filter((row) => ACTIVE_CREDENTIAL_STATUSES.has(firstText(row.status) ?? 'registered')).length,
      blockers,
      warnings,
    },
    agents: agents.map((row) => ({
      agent_id: row.agent_id,
      profile_enabled: boolValue(row.profile_enabled) && row.disabled_at == null,
      expected_provider: expectedProvider(row),
      expected_provider_subject_set: expectedProviderSubjectSet(row),
      token_source_ref: safeSecretRef(firstText(row.provider_token_source_ref)),
    })),
    connectors: connectors.map((row) => ({
      connector_instance_id: row.connector_instance_id,
      agent_id: row.agent_id,
      provider: row.provider,
      connector_uri: firstText(row.connector_uri),
      status: firstText(row.status) ?? 'registered',
      trust_status: firstText(row.trust_status) ?? 'local',
      runtime_instance_id: firstText(row.runtime_instance_id),
      credential_count: (credentialsByConnector.get(row.connector_instance_id) ?? []).length,
    })),
    credentials: credentials.map((row) => ({
      credential_id: row.credential_id,
      agent_id: row.agent_id,
      provider: row.provider,
      connector_instance_id: firstText(row.connector_instance_id),
      connector_agent_id: firstText(row.connector_agent_id),
      connector_status: firstText(row.connector_status),
      credential_kind: firstText(row.credential_kind) ?? 'bot_token',
      status: firstText(row.status) ?? 'registered',
      trust_status: firstText(row.trust_status) ?? 'local',
      secret_ref: safeSecretRef(firstText(row.secret_ref)),
      token_fingerprint_present: Boolean(firstText(row.token_fingerprint)),
      last_verified_at: firstText(row.last_verified_at),
      owner_matches_connector: firstText(row.connector_agent_id)
        ? row.connector_agent_id === row.agent_id
        : null,
    })),
    findings,
    applied_mutations: [],
  }
}
