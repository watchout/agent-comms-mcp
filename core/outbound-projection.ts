import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'
import { collectTokenEvidence } from './token-evidence'
import { getAgentDiscordUiId } from './ui-bindings'

export type Queryable = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}

export interface OutboundProjectionRoute {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  source: 'thread_adapter_metadata' | 'channel_adapter_metadata' | 'recipient_default_projection' | 'channel_policy_native_role_owner' | 'channel_policy_adapter_owner' | 'channel_policy_primary' | 'none'
}

export type ProjectionConsumerSource =
  | 'thread_adapter_metadata'
  | 'channel_adapter_metadata'
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
  | 'native_projection_unregistered'
  | 'native_projection_unhealthy'
  | null

export interface OutboundProjectionDecision {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  consumerSource: ProjectionConsumerSource
  projectionIdentityId: string | null
  intendedProjectionIdentityId: string | null
  projectionSource: ProjectionIdentitySource
  projectionFallbackReason: ProjectionFallbackReason
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

async function hasTokenBackedDiscordEvidence(db: Queryable, agentId: string): Promise<boolean> {
  const trimmedAgentId = agentId.trim()
  if (!trimmedAgentId) return false
  const agentRows = await queryRows(
    db,
    `SELECT agent_id, provider_token_source_ref, NULL AS discord_token, metadata
       FROM agents
      WHERE agent_id = $1`,
    [trimmedAgentId],
  )
  const connectorRows = await queryRows(
    db,
    `SELECT connector_instance_id, agent_id, status, metadata
       FROM connector_instances
      WHERE provider = $1
        AND connector_uri = $2
        AND COALESCE(status, 'active') <> 'disabled'
      ORDER BY connector_instance_id
      LIMIT 1`,
    ['discord', connectorUri('discord', trimmedAgentId)],
  )
  const credentialRows = await queryRows(
    db,
    `SELECT credential_id, agent_id, secret_ref, status, metadata
       FROM connector_credentials
      WHERE provider = $1
        AND agent_id = $2
        AND COALESCE(status, 'registered') IN ('registered', 'active')
      ORDER BY
        CASE COALESCE(status, 'registered') WHEN 'active' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END,
        credential_id
      LIMIT 1`,
    ['discord', trimmedAgentId],
  )
  const uiBindingRows = await queryRows(
    db,
    `SELECT binding_id, agent_id, ui_token_ref, status, metadata
       FROM agent_ui_bindings
      WHERE agent_id = $1
        AND ui_type = 'discord'
        AND COALESCE(status, 'registered') IN ('registered', 'active')
      ORDER BY
        CASE COALESCE(status, 'registered') WHEN 'active' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END,
        CASE COALESCE(surface_role, 'primary') WHEN 'primary' THEN 0 WHEN 'projection' THEN 1 WHEN 'outbound' THEN 2 ELSE 3 END,
        binding_id
      LIMIT 1`,
    [trimmedAgentId],
  )
  return collectTokenEvidence({
    agent: agentRows[0] ?? null,
    connector: connectorRows[0] ?? null,
    credential: credentialRows[0] ?? null,
    uiBinding: uiBindingRows[0] ?? null,
  }).length > 0
}

async function deliveryConsumerEligible(db: Queryable, platform: 'discord', agentId: string | null): Promise<boolean> {
  if (!agentId) return false
  if (platform !== 'discord') return true
  return hasTokenBackedDiscordEvidence(db, agentId)
}

async function ownerFromMetadataIfEligible(
  db: Queryable,
  platform: 'discord',
  raw: unknown,
): Promise<string | null> {
  const owner = ownerFromMetadata(raw)
  if (!owner) return null
  return (await deliveryConsumerEligible(db, platform, owner)) ? owner : null
}

async function projectionHealth(
  db: Queryable,
  agentId: string,
): Promise<{ registered: boolean; healthy: boolean }> {
  const rr = await db.query(
    `SELECT agent_id, status, metadata FROM agents WHERE agent_id = $1`,
    [agentId],
  ).catch(() => ({ rows: [] as any[] }))
  if (rr.rows.length === 0) return { registered: false, healthy: false }
  const registered = (await getAgentDiscordUiId(db, agentId)) !== null
  const status = typeof rr.rows[0].status === 'string' ? rr.rows[0].status : null
  const unhealthyStatus = status === 'offline' || status === 'disconnected' || status === 'failed'
  return { registered, healthy: registered && !unhealthyStatus }
}

async function resolveSurfaceAndConsumer(
  db: Queryable,
  input: { channelId: string; threadId?: string | null; platform?: 'discord' },
): Promise<{
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  consumerSource: ProjectionConsumerSource
}> {
  const platform = input.platform ?? 'discord'
  let channelExternalId: string | null = null

  if (input.threadId) {
    const tr = await db.query(
      `SELECT external_id, metadata FROM thread_adapters WHERE thread_id = $1 AND platform = $2`,
      [input.threadId, platform],
    ).catch(() => ({ rows: [] as any[] }))
    if (tr.rows.length > 0) {
      channelExternalId = tr.rows[0].external_id ?? null
      const owner = await ownerFromMetadataIfEligible(db, platform, tr.rows[0].metadata)
      if (owner) {
        return { platform, channelExternalId, consumerAgentId: owner, consumerSource: 'thread_adapter_metadata' }
      }
    }
  }

  const cr = await db.query(
    `SELECT external_id, metadata FROM channel_adapters WHERE channel_id = $1 AND platform = $2`,
    [input.channelId, platform],
  ).catch(() => ({ rows: [] as any[] }))
  if (cr.rows.length > 0) {
    channelExternalId = channelExternalId ?? cr.rows[0].external_id ?? null
    const owner = await ownerFromMetadataIfEligible(db, platform, cr.rows[0].metadata)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner, consumerSource: 'channel_adapter_metadata' }
    }
  }

  const policy = getChannelPolicy(input.channelId)
  if (policy.adapterOwner && await deliveryConsumerEligible(db, platform, policy.adapterOwner)) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, consumerSource: 'channel_policy_adapter_owner' }
  }
  if (policy.primary && await deliveryConsumerEligible(db, platform, policy.primary)) {
    return { platform, channelExternalId, consumerAgentId: policy.primary, consumerSource: 'channel_policy_primary' }
  }
  return { platform, channelExternalId, consumerAgentId: null, consumerSource: 'none' }
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
  }
}

export async function resolveOutboundProjectionRoute(
  db: Queryable,
  input: { channelId: string; threadId?: string | null; platform?: 'discord'; senderAgentId?: string | null; recipientAgentIds?: string[] | null },
): Promise<OutboundProjectionRoute> {
  await refreshChannelPolicyDbSnapshot(db)
  const platform = input.platform ?? 'discord'
  let channelExternalId: string | null = null

  if (input.threadId) {
    const tr = await db.query(
      `SELECT external_id, metadata FROM thread_adapters WHERE thread_id = $1 AND platform = $2`,
      [input.threadId, platform],
    ).catch(() => ({ rows: [] as any[] }))
    if (tr.rows.length > 0) {
      channelExternalId = tr.rows[0].external_id ?? null
      const owner = await ownerFromMetadataIfEligible(db, platform, tr.rows[0].metadata)
      if (owner) {
        return { platform, channelExternalId, consumerAgentId: owner, source: 'thread_adapter_metadata' }
      }
    }
  }

  const cr = await db.query(
    `SELECT external_id, metadata FROM channel_adapters WHERE channel_id = $1 AND platform = $2`,
    [input.channelId, platform],
  ).catch(() => ({ rows: [] as any[] }))
  if (cr.rows.length > 0) {
    channelExternalId = channelExternalId ?? cr.rows[0].external_id ?? null
    const owner = await ownerFromMetadataIfEligible(db, platform, cr.rows[0].metadata)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner, source: 'channel_adapter_metadata' }
    }
  }

  const recipients = (input.recipientAgentIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0)
  const singleRecipient = recipients.length === 1 ? recipients[0].trim() : null
  if (singleRecipient) {
    const rr = await db.query(
      `SELECT agent_id, metadata FROM agents WHERE agent_id = $1`,
      [singleRecipient],
    ).catch(() => ({ rows: [] as any[] }))
    if (rr.rows.length > 0) {
      const discordId = await getAgentDiscordUiId(db, singleRecipient)
      if (
        typeof discordId === 'string'
        && discordId.trim().length > 0
        && await deliveryConsumerEligible(db, platform, singleRecipient)
      ) {
        return { platform, channelExternalId, consumerAgentId: singleRecipient, source: 'recipient_default_projection' }
      }
    }
  }

  const policy = getChannelPolicy(input.channelId)
  const nativeRoleOwner = input.senderAgentId ? policy.nativeRoleOutboundOwners[input.senderAgentId] : null
  if (nativeRoleOwner && await deliveryConsumerEligible(db, platform, nativeRoleOwner)) {
    return { platform, channelExternalId, consumerAgentId: nativeRoleOwner, source: 'channel_policy_native_role_owner' }
  }
  if (policy.adapterOwner && await deliveryConsumerEligible(db, platform, policy.adapterOwner)) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, source: 'channel_policy_adapter_owner' }
  }
  if (policy.primary && await deliveryConsumerEligible(db, platform, policy.primary)) {
    return { platform, channelExternalId, consumerAgentId: policy.primary, source: 'channel_policy_primary' }
  }
  return { platform, channelExternalId, consumerAgentId: null, source: 'none' }
}

export async function resolveOutboundProjectionDecision(
  db: Queryable,
  input: { channelId: string; threadId?: string | null; platform?: 'discord'; senderAgentId?: string | null; recipientAgentIds?: string[] | null },
): Promise<OutboundProjectionDecision> {
  await refreshChannelPolicyDbSnapshot(db)
  const base = await resolveSurfaceAndConsumer(db, input)
  const recipients = (input.recipientAgentIds ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0)
  const singleRecipient = recipients.length === 1 ? recipients[0].trim() : null
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
    recipientFallbackReason = health.registered ? 'recipient_projection_unhealthy' : 'recipient_projection_unregistered'
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
