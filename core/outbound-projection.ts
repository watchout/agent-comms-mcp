import { getChannelPolicy } from './channel-policy'

export type Queryable = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}

export interface OutboundProjectionRoute {
  platform: 'discord'
  channelExternalId: string | null
  consumerAgentId: string | null
  source: 'thread_adapter_metadata' | 'channel_adapter_metadata' | 'channel_policy_native_role_owner' | 'channel_policy_adapter_owner' | 'channel_policy_primary' | 'none'
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

export async function resolveOutboundProjectionRoute(
  db: Queryable,
  input: { channelId: string; threadId?: string | null; platform?: 'discord'; senderAgentId?: string | null },
): Promise<OutboundProjectionRoute> {
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
