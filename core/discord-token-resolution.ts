import { resolveTokenSourceRef, type TokenSourceEnv } from './token-source-ref'

export const DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES = ['active', 'registered'] as const
export const DISCORD_DELIVERY_CREDENTIAL_STATUSES = ['active'] as const

export type DiscordRuntimeLoginCredentialStatus = typeof DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES[number]
export type DiscordDeliveryCredentialStatus = typeof DISCORD_DELIVERY_CREDENTIAL_STATUSES[number]
export type DiscordRuntimeTokenSource = 'connector_credential' | 'agent_provider_token_source_ref'
export type DiscordRuntimeTokenResolution = {
  token: string
  source: DiscordRuntimeTokenSource
  agentId: string
  credentialId: string | null
  credentialStatus: DiscordRuntimeLoginCredentialStatus | null
  secretRef: string
  tokenSource: string
}

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
}

const runtimeLoginStatuses = new Set<string>(DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES)
const deliveryStatuses = new Set<string>(DISCORD_DELIVERY_CREDENTIAL_STATUSES)

function normalizedStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status.trim() : 'registered'
}

export function isDiscordRuntimeLoginCredentialStatus(status: unknown): status is DiscordRuntimeLoginCredentialStatus {
  return runtimeLoginStatuses.has(normalizedStatus(status))
}

export function isDiscordDeliveryCredentialStatus(status: unknown): status is DiscordDeliveryCredentialStatus {
  return deliveryStatuses.has(normalizedStatus(status))
}

export function discordCredentialStatusSqlList(statuses: readonly string[]): string {
  return statuses.map((status) => `'${status.replace(/'/g, "''")}'`).join(', ')
}

const RUNTIME_LOGIN_CREDENTIAL_STATUS_SQL = discordCredentialStatusSqlList(DISCORD_RUNTIME_LOGIN_CREDENTIAL_STATUSES)
const BLOCKED_TRUST_STATUSES = new Set(['revoked', 'disabled'])

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedTrustStatus(status: unknown): string {
  return typeof status === 'string' && status.trim() ? status.trim() : 'local'
}

function isBlockedTrustStatus(status: unknown): boolean {
  return BLOCKED_TRUST_STATUSES.has(normalizedTrustStatus(status))
}

export async function resolveDbDiscordBotToken(
  db: Queryable,
  agentId: string,
  env: TokenSourceEnv = process.env,
): Promise<DiscordRuntimeTokenResolution | null> {
  const id = agentId.trim()
  if (!id) return null

  const credentialRows = await db.query(
    `SELECT cc.credential_id,
            cc.secret_ref,
            COALESCE(cc.status, 'registered') AS credential_status,
            COALESCE(cc.trust_status, 'local') AS credential_trust_status,
            cc.revoked_at AS credential_revoked_at,
            cc.disabled_at AS credential_disabled_at,
            cc.connector_instance_id,
            ci.connector_instance_id AS linked_connector_instance_id,
            COALESCE(ci.status, 'registered') AS connector_status,
            COALESCE(ci.trust_status, 'local') AS connector_trust_status,
            ci.disabled_at AS connector_disabled_at
       FROM connector_credentials cc
       JOIN agents a
         ON a.agent_id = cc.agent_id
       LEFT JOIN connector_instances ci
         ON ci.connector_instance_id = cc.connector_instance_id
      WHERE cc.provider = 'discord'
        AND cc.agent_id = $1
        AND cc.credential_kind = 'bot_token'
        AND COALESCE(cc.secret_ref, '') <> ''
        AND COALESCE(cc.status, 'registered') IN (${RUNTIME_LOGIN_CREDENTIAL_STATUS_SQL})
        AND COALESCE(cc.trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND cc.revoked_at IS NULL
        AND cc.disabled_at IS NULL
        AND a.agent_type <> 'human'
        AND COALESCE(a.profile_enabled, true) = true
        AND (
          cc.connector_instance_id IS NULL
          OR (
            ci.connector_instance_id IS NOT NULL
            AND COALESCE(ci.status, 'registered') = 'active'
            AND COALESCE(ci.trust_status, 'local') NOT IN ('revoked', 'disabled')
            AND ci.disabled_at IS NULL
          )
        )
      ORDER BY
        CASE COALESCE(cc.status, 'registered')
          WHEN 'active' THEN 0
          WHEN 'registered' THEN 1
          ELSE 2
        END,
        cc.updated_at DESC,
        cc.created_at DESC
      LIMIT 10`,
    [id],
  ).catch(() => ({ rows: [] as any[] }))

  for (const row of credentialRows.rows) {
    const secretRef = firstString(row.secret_ref)
    const credentialStatus = firstString(row.credential_status) ?? 'registered'
    if (!secretRef || !isDiscordRuntimeLoginCredentialStatus(credentialStatus)) continue
    if (isBlockedTrustStatus(row.credential_trust_status)) continue
    if (row.credential_revoked_at != null || row.credential_disabled_at != null) continue
    const credentialConnectorInstanceId = firstString(row.connector_instance_id)
    if (credentialConnectorInstanceId) {
      const linkedConnectorInstanceId = firstString(row.linked_connector_instance_id)
      const connectorStatus = firstString(row.connector_status) ?? 'registered'
      if (!linkedConnectorInstanceId) continue
      if (connectorStatus !== 'active') continue
      if (isBlockedTrustStatus(row.connector_trust_status)) continue
      if (row.connector_disabled_at != null) continue
    }
    const resolved = resolveTokenSourceRef(secretRef, env)
    if (!resolved) continue
    return {
      token: resolved.token,
      source: 'connector_credential',
      agentId: id,
      credentialId: firstString(row.credential_id),
      credentialStatus,
      secretRef,
      tokenSource: resolved.source,
    }
  }

  const agentRows = await db.query(
    `SELECT provider_token_source_ref
       FROM agents
      WHERE agent_id = $1
        AND agent_type <> 'human'
        AND COALESCE(profile_enabled, true) = true
      LIMIT 1`,
    [id],
  ).catch(() => ({ rows: [] as any[] }))
  const legacyRef = firstString(agentRows.rows[0]?.provider_token_source_ref)
  const legacyResolved = resolveTokenSourceRef(legacyRef, env)
  if (legacyRef && legacyResolved) {
    return {
      token: legacyResolved.token,
      source: 'agent_provider_token_source_ref',
      agentId: id,
      credentialId: null,
      credentialStatus: null,
      secretRef: legacyRef,
      tokenSource: legacyResolved.source,
    }
  }

  return null
}
