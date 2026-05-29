import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'
import { getAgentDiscordUiId } from './ui-bindings'

export type Queryable = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}

export interface OutboundProjectionRoute {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  source: 'thread_adapter_metadata' | 'channel_adapter_metadata' | 'recipient_token_evidence' | 'recipient_default_projection' | 'channel_policy_native_role_owner' | 'channel_policy_adapter_owner' | 'channel_policy_primary' | 'none'
}

export type ProjectionConsumerSource =
  | 'thread_adapter_metadata'
  | 'channel_adapter_metadata'
  | 'recipient_token_evidence'
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

async function hasActiveCredentialForConnector(
  db: Queryable,
  platform: 'discord',
  agentId: string,
  connectorInstanceId: string,
): Promise<boolean> {
  const rows = await queryRows(
    db,
    `SELECT credential_id
       FROM connector_credentials
      WHERE provider = $1
        AND agent_id = $2
        AND connector_instance_id = $3
        AND COALESCE(status, 'registered') = 'active'
        AND COALESCE(trust_status, 'local') NOT IN ('revoked', 'disabled')
        AND COALESCE(secret_ref, '') <> ''
        AND revoked_at IS NULL
        AND disabled_at IS NULL
      ORDER BY credential_id
      LIMIT 1`,
    [platform, agentId, connectorInstanceId],
  )
  return rows.length > 0
}

async function hasWriteBindingForConnector(
  db: Queryable,
  platform: 'discord',
  channelId: string,
  connectorInstanceId: string,
): Promise<boolean> {
  const rows = await queryRows(
    db,
    `SELECT channel_binding_id
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
  return rows.length > 0
}

async function hasProviderWriteAccessForConnector(
  db: Queryable,
  platform: 'discord',
  providerChannelId: string,
  agentId: string,
  connectorInstanceId: string,
): Promise<boolean> {
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
  return rows.some((row) => hasWriteCapability(row.capabilities))
}

async function eligibleDeliveryConnectorIds(
  db: Queryable,
  input: {
    platform: 'discord'
    channelId: string
    providerChannelId: string
    agentId: string
  },
): Promise<string[]> {
  const agentId = input.agentId.trim()
  const channelId = input.channelId.trim()
  const providerChannelId = input.providerChannelId.trim() || channelId
  if (!agentId || !channelId) return []

  const connectors = await queryRows(
    db,
    `SELECT connector_instance_id
       FROM connector_instances
      WHERE provider = $1
        AND agent_id = $2
        AND COALESCE(status, 'registered') = 'active'
        AND COALESCE(trust_status, 'local') NOT IN ('revoked', 'disabled')
      ORDER BY
        CASE WHEN connector_uri = $3 THEN 0 ELSE 1 END,
        connector_instance_id`,
    [input.platform, agentId, connectorUri(input.platform, agentId)],
  )

  const eligible: string[] = []
  for (const connector of connectors) {
    const connectorInstanceId = firstString(connector.connector_instance_id)
    if (!connectorInstanceId) continue
    if (!await hasActiveCredentialForConnector(db, input.platform, agentId, connectorInstanceId)) continue
    if (await hasWriteBindingForConnector(db, input.platform, channelId, connectorInstanceId)) {
      eligible.push(connectorInstanceId)
      continue
    }
    if (await hasProviderWriteAccessForConnector(db, input.platform, providerChannelId, agentId, connectorInstanceId)) {
      eligible.push(connectorInstanceId)
    }
  }
  return eligible
}

async function deliveryConsumerEligible(
  db: Queryable,
  input: {
    platform: 'discord'
    channelId: string
    providerChannelId?: string | null
    agentId: string | null
  },
): Promise<boolean> {
  if (!input.agentId) return false
  if (input.platform !== 'discord') return true
  const providerChannelId = input.providerChannelId ?? input.channelId
  const eligible = await eligibleDeliveryConnectorIds(db, {
    platform: input.platform,
    channelId: input.channelId,
    providerChannelId,
    agentId: input.agentId,
  })
  return eligible.length === 1
}

async function ownerFromMetadataIfEligible(
  db: Queryable,
  platform: 'discord',
  channelId: string,
  providerChannelId: string,
  raw: unknown,
): Promise<string | null> {
  const owner = ownerFromMetadata(raw)
  if (!owner) return null
  return (await deliveryConsumerEligible(db, { platform, channelId, providerChannelId, agentId: owner })) ? owner : null
}

function singleRecipientFrom(input?: string[] | null): string | null {
  const recipients = (input ?? []).filter((id) => typeof id === 'string' && id.trim().length > 0)
  return recipients.length === 1 ? recipients[0].trim() : null
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
  input: { channelId: string; threadId?: string | null; platform?: 'discord'; recipientAgentIds?: string[] | null },
): Promise<{
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  consumerSource: ProjectionConsumerSource
}> {
  const platform = input.platform ?? 'discord'
  let channelExternalId: string | null = null
  let providerChannelId = input.channelId

  if (input.threadId) {
    const tr = await db.query(
      `SELECT external_id, metadata FROM thread_adapters WHERE thread_id = $1 AND platform = $2`,
      [input.threadId, platform],
    ).catch(() => ({ rows: [] as any[] }))
    if (tr.rows.length > 0) {
      channelExternalId = tr.rows[0].external_id ?? null
      providerChannelId = tr.rows[0].external_id ?? providerChannelId
      const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, tr.rows[0].metadata)
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
    const channelAdapterExternalId = cr.rows[0].external_id ?? null
    const targetAlreadyResolved = channelExternalId !== null
    channelExternalId = channelExternalId ?? channelAdapterExternalId
    if (!targetAlreadyResolved) {
      providerChannelId = channelAdapterExternalId ?? providerChannelId
    }
    const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, cr.rows[0].metadata)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner, consumerSource: 'channel_adapter_metadata' }
    }
  }

  const singleRecipient = singleRecipientFrom(input.recipientAgentIds)
  if (singleRecipient && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: singleRecipient })) {
    return { platform, channelExternalId, consumerAgentId: singleRecipient, consumerSource: 'recipient_token_evidence' }
  }

  const policy = getChannelPolicy(input.channelId)
  if (policy.adapterOwner && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: policy.adapterOwner })) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, consumerSource: 'channel_policy_adapter_owner' }
  }
  if (policy.primary && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: policy.primary })) {
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
  let providerChannelId = input.channelId

  if (input.threadId) {
    const tr = await db.query(
      `SELECT external_id, metadata FROM thread_adapters WHERE thread_id = $1 AND platform = $2`,
      [input.threadId, platform],
    ).catch(() => ({ rows: [] as any[] }))
    if (tr.rows.length > 0) {
      channelExternalId = tr.rows[0].external_id ?? null
      providerChannelId = tr.rows[0].external_id ?? providerChannelId
      const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, tr.rows[0].metadata)
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
    const channelAdapterExternalId = cr.rows[0].external_id ?? null
    const targetAlreadyResolved = channelExternalId !== null
    channelExternalId = channelExternalId ?? channelAdapterExternalId
    if (!targetAlreadyResolved) {
      providerChannelId = channelAdapterExternalId ?? providerChannelId
    }
    const owner = await ownerFromMetadataIfEligible(db, platform, input.channelId, providerChannelId, cr.rows[0].metadata)
    if (owner) {
      return { platform, channelExternalId, consumerAgentId: owner, source: 'channel_adapter_metadata' }
    }
  }

  const singleRecipient = singleRecipientFrom(input.recipientAgentIds)
  if (singleRecipient && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: singleRecipient })) {
    return { platform, channelExternalId, consumerAgentId: singleRecipient, source: 'recipient_token_evidence' }
  }

  const policy = getChannelPolicy(input.channelId)
  const nativeRoleOwner = input.senderAgentId ? policy.nativeRoleOutboundOwners[input.senderAgentId] : null
  if (nativeRoleOwner && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: nativeRoleOwner })) {
    return { platform, channelExternalId, consumerAgentId: nativeRoleOwner, source: 'channel_policy_native_role_owner' }
  }
  if (policy.adapterOwner && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: policy.adapterOwner })) {
    return { platform, channelExternalId, consumerAgentId: policy.adapterOwner, source: 'channel_policy_adapter_owner' }
  }
  if (policy.primary && await deliveryConsumerEligible(db, { platform, channelId: input.channelId, providerChannelId, agentId: policy.primary })) {
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
