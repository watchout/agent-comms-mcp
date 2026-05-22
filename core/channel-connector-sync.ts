import type { DbAdapter } from './db'

export type BindingRole = 'inbound' | 'outbound' | 'bidirectional' | 'projection' | 'presence' | 'worker'
export type OrderingScope = 'none' | 'channel' | 'thread' | 'custom'

export interface SyncChannelPolicyConnectorsOptions {
  dryRun?: boolean
  channel?: string | null
  provider?: string
  bindingRole?: BindingRole
  orderingScope?: OrderingScope
  maxConcurrency?: number
}

export interface ChannelConnectorSyncItem {
  channel_id: string
  channel_name: string | null
  adapter_owner_agent_id: string
  provider: string
  connector_uri: string
  connector_instance_id: string | null
  channel_binding_id: string | null
  connector_action: 'create' | 'reuse'
  binding_action: 'create' | 'reuse'
}

export interface ChannelConnectorSyncSkipped {
  channel_id: string
  channel_name: string | null
  adapter_owner_agent_id: string | null
  reason: 'no_adapter_owner' | 'unknown_adapter_owner' | 'connector_disabled' | 'active_binding_conflict'
  details?: Record<string, unknown>
}

export interface ChannelConnectorSyncReport {
  ok: true
  dry_run: boolean
  provider: string
  binding_role: BindingRole
  ordering_scope: OrderingScope
  max_concurrency: number
  planned: ChannelConnectorSyncItem[]
  skipped: ChannelConnectorSyncSkipped[]
  created_connectors: number
  created_bindings: number
}

const BINDING_ROLES = new Set(['inbound', 'outbound', 'bidirectional', 'projection', 'presence', 'worker'])
const ORDERING_SCOPES = new Set(['none', 'channel', 'thread', 'custom'])

interface PolicyRow {
  channel_id: string
  channel_name: string | null
  adapter_owner_agent_id: string | null
}

interface ConnectorRow {
  connector_instance_id: string
  agent_id: string
  status: string
}

interface BindingRow {
  channel_binding_id: string
  connector_instance_id: string | null
}

function connectorUri(provider: string, agentId: string): string {
  return `${provider}://agents/${agentId}`
}

async function resolveChannelId(db: DbAdapter, channel: string | null | undefined): Promise<string | null> {
  const ref = channel?.trim()
  if (!ref) return null
  const rows = await db.query<{ id: string; name: string | null }>(
    `SELECT id, name
       FROM channels
      WHERE id = $1::text OR name = $1::text
      ORDER BY CASE WHEN id = $1::text THEN 0 ELSE 1 END, id`,
    [ref],
  )
  if (rows.length === 0) throw new Error(`CHANNEL_NOT_FOUND: ${ref}`)
  const exactId = rows.find((row) => row.id === ref)
  if (exactId) return exactId.id
  if (rows.length > 1) throw new Error(`CHANNEL_NAME_AMBIGUOUS: ${ref}`)
  return rows[0].id
}

async function loadPolicyRows(db: DbAdapter, channelId: string | null): Promise<PolicyRow[]> {
  return db.query<PolicyRow>(
      `SELECT p.channel_id,
              c.name AS channel_name,
              p.adapter_owner_agent_id
         FROM channel_routing_policy p
         JOIN channels c ON c.id = p.channel_id
      WHERE ($1::text IS NULL OR p.channel_id = $1::text)
      ORDER BY c.name, p.channel_id`,
    [channelId],
  )
}

async function buildSyncPlan(
  db: DbAdapter,
  rows: PolicyRow[],
  provider: string,
  bindingRole: BindingRole,
  orderingScope: OrderingScope,
  maxConcurrency: number,
): Promise<{ planned: ChannelConnectorSyncItem[]; skipped: ChannelConnectorSyncSkipped[] }> {
  const planned: ChannelConnectorSyncItem[] = []
  const skipped: ChannelConnectorSyncSkipped[] = []

  for (const row of rows) {
    const channelId = String(row.channel_id)
    const channelName = row.channel_name ? String(row.channel_name) : null
    const adapterOwner = typeof row.adapter_owner_agent_id === 'string' ? row.adapter_owner_agent_id.trim() : ''
    if (!adapterOwner) {
      skipped.push({
        channel_id: channelId,
        channel_name: channelName,
        adapter_owner_agent_id: null,
        reason: 'no_adapter_owner',
      })
      continue
    }

    const agent = await db.queryOne<{ agent_id: string }>(
      `SELECT agent_id FROM agents WHERE agent_id = $1`,
      [adapterOwner],
    )
    if (!agent) {
      skipped.push({
        channel_id: channelId,
        channel_name: channelName,
        adapter_owner_agent_id: adapterOwner,
        reason: 'unknown_adapter_owner',
      })
      continue
    }

    const uri = connectorUri(provider, adapterOwner)
    const connector = await db.queryOne<ConnectorRow>(
      `SELECT connector_instance_id, agent_id, status
         FROM connector_instances
        WHERE provider = $1
          AND connector_uri = $2`,
      [provider, uri],
    )
    if (connector?.status === 'disabled') {
      skipped.push({
        channel_id: channelId,
        channel_name: channelName,
        adapter_owner_agent_id: adapterOwner,
        reason: 'connector_disabled',
        details: { connector_instance_id: connector.connector_instance_id },
      })
      continue
    }

    const activeBindings = await db.query<BindingRow>(
      `SELECT channel_binding_id, connector_instance_id
         FROM channel_connector_bindings
        WHERE channel_id = $1
          AND provider = $2
          AND binding_role = $3
          AND status = 'active'
        ORDER BY priority, channel_binding_id`,
      [channelId, provider, bindingRole],
    )
    const matchingBinding = connector
      ? activeBindings.find((binding) => binding.connector_instance_id === connector.connector_instance_id)
      : null
    if (!matchingBinding && activeBindings.length > 0) {
      skipped.push({
        channel_id: channelId,
        channel_name: channelName,
        adapter_owner_agent_id: adapterOwner,
        reason: 'active_binding_conflict',
        details: { active_bindings: activeBindings.map((binding) => binding.channel_binding_id) },
      })
      continue
    }

    planned.push({
      channel_id: channelId,
      channel_name: channelName,
      adapter_owner_agent_id: adapterOwner,
      provider,
      connector_uri: uri,
      connector_instance_id: connector?.connector_instance_id ?? null,
      channel_binding_id: matchingBinding?.channel_binding_id ?? null,
      connector_action: connector ? 'reuse' : 'create',
      binding_action: matchingBinding ? 'reuse' : 'create',
    })
  }

  return { planned, skipped }
}

async function ensureConnector(db: DbAdapter, item: ChannelConnectorSyncItem, bindingRole: BindingRole): Promise<string> {
  if (item.connector_instance_id) return item.connector_instance_id
  await db.execute(
    `INSERT INTO connector_instances (
       agent_id, provider, connector_kind, transport, connector_uri,
       status, trust_status, capabilities, metadata, last_seen_at
     ) VALUES (
       $1, $2, 'chat_adapter', 'discord_gateway', $3,
       'active', 'local', $4, $5, NOW()
     )`,
    [
      item.adapter_owner_agent_id,
      item.provider,
      item.connector_uri,
      JSON.stringify({ roles: [bindingRole], source: 'channel_policy_sync' }),
      JSON.stringify({ source: 'channel_policy_sync' }),
    ],
  )
  const connector = await db.queryOne<ConnectorRow>(
    `SELECT connector_instance_id, agent_id, status
       FROM connector_instances
      WHERE provider = $1
        AND connector_uri = $2`,
    [item.provider, item.connector_uri],
  )
  if (!connector) throw new Error(`CONNECTOR_SYNC_INSERT_NOT_FOUND: ${item.connector_uri}`)
  return connector.connector_instance_id
}

async function ensureBinding(
  db: DbAdapter,
  item: ChannelConnectorSyncItem,
  connectorInstanceId: string,
  bindingRole: BindingRole,
  orderingScope: OrderingScope,
  maxConcurrency: number,
): Promise<void> {
  if (item.channel_binding_id) return
  await db.execute(
    `INSERT INTO channel_connector_bindings (
       channel_id, provider, connector_instance_id, binding_role,
       priority, max_concurrency, ordering_scope, status, policy_source, metadata
     ) VALUES (
       $1, $2, $3, $4,
       100, $5, $6, 'active', 'channel_policy_sync', $7
     )`,
    [
      item.channel_id,
      item.provider,
      connectorInstanceId,
      bindingRole,
      maxConcurrency,
      orderingScope,
      JSON.stringify({ source: 'channel_policy_sync' }),
    ],
  )
}

export async function syncChannelPolicyConnectors(
  db: DbAdapter,
  options: SyncChannelPolicyConnectorsOptions = {},
): Promise<ChannelConnectorSyncReport> {
  const provider = options.provider ?? 'discord'
  const bindingRole = options.bindingRole ?? 'outbound'
  const orderingScope = options.orderingScope ?? 'thread'
  const maxConcurrency = options.maxConcurrency ?? 1
  if (!BINDING_ROLES.has(bindingRole)) throw new Error(`BINDING_ROLE_INVALID: ${bindingRole}`)
  if (!ORDERING_SCOPES.has(orderingScope)) throw new Error(`ORDERING_SCOPE_INVALID: ${orderingScope}`)
  if (maxConcurrency <= 0 || !Number.isFinite(maxConcurrency)) throw new Error('MAX_CONCURRENCY_INVALID')

  const channelId = await resolveChannelId(db, options.channel)
  const rows = await loadPolicyRows(db, channelId)
  const { planned, skipped } = await buildSyncPlan(db, rows, provider, bindingRole, orderingScope, maxConcurrency)

  if (!options.dryRun) {
    await db.transaction(async (tx) => {
      for (const item of planned) {
        const connectorInstanceId = await ensureConnector(tx, item, bindingRole)
        await ensureBinding(tx, item, connectorInstanceId, bindingRole, orderingScope, maxConcurrency)
      }
    })
  }

  return {
    ok: true,
    dry_run: options.dryRun !== false,
    provider,
    binding_role: bindingRole,
    ordering_scope: orderingScope,
    max_concurrency: maxConcurrency,
    planned,
    skipped,
    created_connectors: options.dryRun === false ? planned.filter((item) => item.connector_action === 'create').length : 0,
    created_bindings: options.dryRun === false ? planned.filter((item) => item.binding_action === 'create').length : 0,
  }
}
