import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'

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

async function projectionHealth(
  db: Queryable,
  agentId: string,
): Promise<{ registered: boolean; healthy: boolean }> {
  const rr = await db.query(
    `SELECT agent_id, status, metadata FROM agents WHERE agent_id = $1`,
    [agentId],
  ).catch(() => ({ rows: [] as any[] }))
  if (rr.rows.length === 0) return { registered: false, healthy: false }
  const metadata = parseMetadata(rr.rows[0].metadata)
  const discordId = metadata.discord_id
  const registered = typeof discordId === 'string' && discordId.trim().length > 0
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
      const owner = ownerFromMetadata(tr.rows[0].metadata)
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
    const owner = ownerFromMetadata(cr.rows[0].metadata)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner, consumerSource: 'channel_adapter_metadata' }
    }
  }

  const policy = getChannelPolicy(input.channelId)
  if (policy.adapterOwner) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, consumerSource: 'channel_policy_adapter_owner' }
  }
  if (policy.primary) {
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
      const owner = ownerFromMetadata(tr.rows[0].metadata)
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
    const owner = ownerFromMetadata(cr.rows[0].metadata)
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
      const metadata = parseMetadata(rr.rows[0].metadata)
      const discordId = metadata.discord_id
      if (typeof discordId === 'string' && discordId.trim().length > 0) {
        return { platform, channelExternalId, consumerAgentId: singleRecipient, source: 'recipient_default_projection' }
      }
    }
  }

  const policy = getChannelPolicy(input.channelId)
  const nativeRoleOwner = input.senderAgentId ? policy.nativeRoleOutboundOwners[input.senderAgentId] : null
  if (nativeRoleOwner) {
    return { platform, channelExternalId, consumerAgentId: nativeRoleOwner, source: 'channel_policy_native_role_owner' }
  }
  if (policy.adapterOwner) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, source: 'channel_policy_adapter_owner' }
  }
  if (policy.primary) {
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
