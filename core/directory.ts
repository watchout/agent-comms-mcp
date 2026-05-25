import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getChannelPolicy, refreshChannelPolicyDbSnapshot } from './channel-policy'

type Queryable = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

export type DirectorySendability = 'ready' | 'queueable' | 'blocked' | 'human'

export type DirectoryAgent = {
  agent_id: string
  display_name: string
  agent_type: string
  runtime: string
  status: string
  sendability: DirectorySendability
  channel_count: number
  channels: string[]
  has_discord_identity: boolean
  tmux_session: string | null
  warnings: string[]
}

export type DirectoryChannel = {
  channel_id: string
  name: string | null
  type: string
  member_count: number
  active_member_count: number
  members: string[]
  discord_external_id: string | null
  primary: string | null
  adapter_owner: string | null
  outbound_allowlist: string[] | null
  native_projection_count: number
  warnings: string[]
}

export type DirectoryRole = {
  role: string
  agent_id: string
  description: string | null
  warnings: string[]
}

export type MentionDirectoryCandidate = {
  agent_id: string
  display_name: string
  agent_type: string
  status: string
  sendability: DirectorySendability
  queue_target: boolean
  recommended: boolean
  has_discord_identity: boolean
  has_active_connector: boolean
  hard_block_reasons: string[]
  warnings: string[]
}

export type MentionDirectoryPolicyEntry = {
  agent_id: string
  reason: string
}

export type MentionDirectoryChannel = {
  channel_id: string
  name: string | null
  adapter_owner: string | null
  primary: string | null
  recommended: MentionDirectoryCandidate[]
  candidates: MentionDirectoryCandidate[]
  excluded_policy_entries: MentionDirectoryPolicyEntry[]
}

export type MentionDirectory = {
  policy: {
    db_ssot: boolean
    final_send_must_revalidate_db: boolean
    hard_blocks: string[]
    runtime_offline_enforcement: string
  }
  channels: MentionDirectoryChannel[]
}

export type DirectoryReport = {
  ok: true
  generated_at: string
  summary: {
    agent_count: number
    ready_agents: number
    queueable_agents: number
    blocked_agents: number
    human_agents: number
    channel_count: number
    channel_external_id_count: number
    role_count: number
  }
  id_policy: {
    agent_id: string
    channel_id: string
    json_role: string
    db_ssot: boolean
    json_role_policy: string
  }
  agents: DirectoryAgent[]
  channels: DirectoryChannel[]
  mention_directory: MentionDirectory
  roles: DirectoryRole[]
  warnings: string[]
}

type RoleRoutingConfig = {
  roles?: Record<string, {
    agentId?: string
    description?: string
    legacyAgentIds?: string[]
    newWorkAllowedViaLegacyIds?: boolean
  }>
  legacyAgentIds?: Record<string, {
    canonicalAgentId?: string
    newWorkAllowed?: boolean
  }>
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

function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string')
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string')
  } catch {}
  return []
}

function roleConfigPath(): string {
  if (process.env.AGENT_COM_ROLE_ROUTING_PATH) return process.env.AGENT_COM_ROLE_ROUTING_PATH
  const repoRoot = new URL('..', import.meta.url).pathname
  return join(repoRoot, 'config', 'agent-role-routing.json')
}

function loadRoleRoutingConfig(): RoleRoutingConfig {
  const path = roleConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RoleRoutingConfig
  } catch {
    return {}
  }
}

function isSnowflakeLike(value: string): boolean {
  return /^\d{16,22}$/.test(value)
}

function sendabilityFor(agentType: string, status: string, channelCount: number): DirectorySendability {
  if (agentType === 'human') return 'human'
  if (status === 'disabled' || status === 'offline' || status === 'disconnected') return 'blocked'
  if (channelCount === 0) return 'blocked'
  if (status === 'busy') return 'queueable'
  return 'ready'
}

function isMissingRuntimeColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /runtime/i.test(message) && /(no such column|column .* does not exist|does not exist)/i.test(message)
}

async function queryAgentRows(db: Queryable): Promise<any[]> {
  try {
    const result = await db.query(
      `SELECT agent_id, display_name, agent_type, runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
    return result.rows
  } catch (err) {
    if (!isMissingRuntimeColumnError(err)) throw err
    const result = await db.query(
      `SELECT agent_id, display_name, agent_type, cli_type AS runtime, status, metadata
         FROM agents
        ORDER BY agent_id`,
    )
    return result.rows
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function agentWarnings(row: any, channelCount: number, duplicateDisplayName: boolean): string[] {
  const warnings: string[] = []
  const status = String(row.status ?? '')
  if (status === 'disabled') warnings.push('disabled')
  if (status === 'offline' || status === 'disconnected') warnings.push('offline')
  if (channelCount === 0 && row.agent_type !== 'human') warnings.push('no_channel_membership')
  if (duplicateDisplayName) warnings.push('display_name_not_unique')
  if (row.__duplicate_discord_identity === true) warnings.push('discord_identity_not_unique')
  const metadata = parseMetadata(row.metadata)
  if (metadata.project_dir || metadata.projectDir) warnings.push('project_dir_is_metadata_not_identity')
  return warnings
}

function channelWarnings(row: any, activeMemberCount: number): string[] {
  const warnings: string[] = []
  if (isSnowflakeLike(String(row.id))) warnings.push('channel_id_looks_like_platform_external_id')
  if (!row.name) warnings.push('missing_human_name')
  if (activeMemberCount === 0) warnings.push('no_active_members')
  if (!row.discord_external_id) warnings.push('missing_discord_adapter')
  return warnings
}

function mentionHardBlocks(agent: DirectoryAgent | null): string[] {
  if (!agent) return ['agent_missing']
  if (agent.status === 'disabled') return ['disabled']
  if (agent.status === 'failed' || agent.status === 'disconnected') return [agent.status]
  return []
}

function mentionWarnings(agent: DirectoryAgent, hasActiveConnector: boolean): string[] {
  const warnings: string[] = []
  if (agent.status === 'offline') warnings.push('offline_runtime_not_enforced_until_runtime_instances')
  if (agent.agent_type === 'human') warnings.push('human_recipient_not_a_bot_queue_worker')
  if (!agent.has_discord_identity) warnings.push('missing_discord_identity_for_native_mention')
  if (agent.warnings.includes('discord_identity_not_unique')) warnings.push('discord_identity_not_unique')
  if (!hasActiveConnector && agent.agent_type !== 'human') warnings.push('no_active_connector')
  return warnings
}

function policyEntryReason(agentId: string, members: string[], agent: DirectoryAgent | null): string | null {
  if (!agent) return 'agent_missing'
  if (!members.includes(agentId)) return 'not_channel_member'
  const hardBlocks = mentionHardBlocks(agent)
  return hardBlocks[0] ?? null
}

export async function buildDirectoryReport(db: Queryable): Promise<DirectoryReport> {
  const policySnapshot = await refreshChannelPolicyDbSnapshot(db)
  const agentRows = await queryAgentRows(db)
  const channelRows = await db.query(
    `SELECT c.id, c.name, c.type, c.members,
            ca.external_id AS discord_external_id,
            ca.metadata AS adapter_metadata
       FROM channels c
       LEFT JOIN channel_adapters ca
         ON ca.channel_id = c.id
        AND ca.platform = 'discord'
      ORDER BY c.name, c.id`,
  )
  const connectorRows = await db.query(
    `SELECT agent_id, provider, status
       FROM connector_instances
      WHERE status = 'active'`,
  ).catch(() => ({ rows: [] as any[] }))
  const providerIdentityRows = await db.query(
    `SELECT agent_id, provider_subject_id, status, trust_status, identity_kind
       FROM agent_provider_identities
      WHERE provider = 'discord'
      ORDER BY agent_id, identity_kind`,
  ).catch(() => ({ rows: [] as any[] }))

  const providerIdentityKnownAgents = new Set<string>()
  const activeDiscordIdentityByAgent = new Map<string, string>()
  for (const row of providerIdentityRows.rows) {
    const agentId = String(row.agent_id ?? '')
    const subjectId = String(row.provider_subject_id ?? '')
    if (!agentId || !subjectId) continue
    providerIdentityKnownAgents.add(agentId)
    if (String(row.status ?? '') !== 'active') continue
    if (String(row.trust_status ?? '') === 'disabled' || String(row.trust_status ?? '') === 'revoked') continue
    if (!activeDiscordIdentityByAgent.has(agentId)) {
      activeDiscordIdentityByAgent.set(agentId, subjectId)
    }
  }

  const discordIdentityFor = (row: any): string | null => {
    const agentId = String(row.agent_id ?? '')
    const providerSubjectId = activeDiscordIdentityByAgent.get(agentId)
    if (providerSubjectId) return providerSubjectId
    if (providerIdentityKnownAgents.has(agentId)) return null
    return metadataString(parseMetadata(row.metadata), 'discord_id')
  }

  const displayNameCounts = new Map<string, number>()
  const discordIdentityCounts = new Map<string, number>()
  for (const row of agentRows) {
    const name = String(row.display_name ?? '')
    displayNameCounts.set(name, (displayNameCounts.get(name) ?? 0) + 1)
    const discordId = discordIdentityFor(row)
    if (discordId) discordIdentityCounts.set(discordId, (discordIdentityCounts.get(discordId) ?? 0) + 1)
  }

  const agentStatus = new Map<string, string>()
  for (const row of agentRows) {
    agentStatus.set(String(row.agent_id), String(row.status ?? ''))
  }
  const activeConnectorAgents = new Set(
    connectorRows.rows
      .filter((row) => String(row.status ?? '') === 'active')
      .map((row) => String(row.agent_id)),
  )

  const channelsByAgent = new Map<string, string[]>()
  for (const row of channelRows.rows) {
    const label = row.name ? String(row.name) : String(row.id)
    for (const member of parseMembers(row.members)) {
      const channels = channelsByAgent.get(member) ?? []
      channels.push(label)
      channelsByAgent.set(member, channels)
    }
  }

  const agents: DirectoryAgent[] = agentRows.map((row) => {
    const agentId = String(row.agent_id)
    const metadata = parseMetadata(row.metadata)
    const channels = channelsByAgent.get(agentId) ?? []
    const channelCount = channels.length
    const discordId = discordIdentityFor(row)
    row.__duplicate_discord_identity = discordId !== null && (discordIdentityCounts.get(discordId) ?? 0) > 1
    return {
      agent_id: agentId,
      display_name: String(row.display_name ?? agentId),
      agent_type: String(row.agent_type ?? ''),
      runtime: String(row.runtime ?? ''),
      status: String(row.status ?? ''),
      sendability: sendabilityFor(String(row.agent_type ?? ''), String(row.status ?? ''), channelCount),
      channel_count: channelCount,
      channels,
      has_discord_identity: discordId !== null,
      tmux_session: typeof metadata.tmux_session === 'string' ? metadata.tmux_session : null,
      warnings: agentWarnings(row, channelCount, (displayNameCounts.get(String(row.display_name ?? '')) ?? 0) > 1),
    }
  })
  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]))

  const channels: DirectoryChannel[] = channelRows.rows.map((row) => {
    const members = parseMembers(row.members)
    const activeMemberCount = members.filter((member) => {
      const status = agentStatus.get(member)
      return status === 'idle' || status === 'online' || status === 'busy'
    }).length
    const policy = getChannelPolicy(String(row.id))
    return {
      channel_id: String(row.id),
      name: row.name ? String(row.name) : null,
      type: String(row.type ?? ''),
      member_count: members.length,
      active_member_count: activeMemberCount,
      members,
      discord_external_id: row.discord_external_id ? String(row.discord_external_id) : null,
      primary: policy.primary,
      adapter_owner: policy.adapterOwner,
      outbound_allowlist: policy.outboundAllowlist,
      native_projection_count: Object.keys(policy.nativeProjectionIdentities).length + Object.keys(policy.nativeRoleOutboundOwners).length,
      warnings: channelWarnings(row, activeMemberCount),
    }
  })

  const mentionChannels: MentionDirectoryChannel[] = channelRows.rows.map((row) => {
    const channelId = String(row.id)
    const members = parseMembers(row.members)
    const policy = getChannelPolicy(channelId)
    const candidates = members
      .map((agentId): MentionDirectoryCandidate | null => {
        const agent = agentsById.get(agentId) ?? null
        if (!agent) {
          return {
            agent_id: agentId,
            display_name: agentId,
            agent_type: 'unknown',
            status: 'missing',
            sendability: 'blocked',
            queue_target: false,
            recommended: false,
            has_discord_identity: false,
            has_active_connector: false,
            hard_block_reasons: ['agent_missing'],
            warnings: [],
          }
        }
        const hasActiveConnector = activeConnectorAgents.has(agent.agent_id)
        const hardBlocks = mentionHardBlocks(agent)
        const queueTarget = agent.agent_type !== 'human' && hardBlocks.length === 0
        const recommended =
          queueTarget &&
          (agent.sendability === 'ready' || agent.sendability === 'queueable') &&
          agent.status !== 'offline'
        return {
          agent_id: agent.agent_id,
          display_name: agent.display_name,
          agent_type: agent.agent_type,
          status: agent.status,
          sendability: agent.sendability,
          queue_target: queueTarget,
          recommended,
          has_discord_identity: agent.has_discord_identity,
          has_active_connector: hasActiveConnector,
          hard_block_reasons: hardBlocks,
          warnings: mentionWarnings(agent, hasActiveConnector),
        }
      })
      .filter((candidate): candidate is MentionDirectoryCandidate => candidate !== null)
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id))

    const excludedPolicyEntries = (policy.outboundAllowlist ?? [])
      .map((agentId): MentionDirectoryPolicyEntry | null => {
        const reason = policyEntryReason(agentId, members, agentsById.get(agentId) ?? null)
        return reason ? { agent_id: agentId, reason } : null
      })
      .filter((entry): entry is MentionDirectoryPolicyEntry => entry !== null)

    return {
      channel_id: channelId,
      name: row.name ? String(row.name) : null,
      adapter_owner: policy.adapterOwner,
      primary: policy.primary,
      recommended: candidates.filter((candidate) => candidate.recommended),
      candidates,
      excluded_policy_entries: excludedPolicyEntries,
    }
  })

  const roleConfig = loadRoleRoutingConfig()
  const roles: DirectoryRole[] = Object.entries(roleConfig.roles ?? {}).map(([role, entry]) => {
    const agentId = typeof entry.agentId === 'string' ? entry.agentId : ''
    const warnings: string[] = []
    const target = agents.find((agent) => agent.agent_id === agentId)
    if (!target) warnings.push('target_agent_missing')
    if (target?.sendability === 'blocked') warnings.push('target_agent_blocked')
    if (entry.legacyAgentIds?.some((legacy) => roleConfig.legacyAgentIds?.[legacy]?.newWorkAllowed === false)) {
      warnings.push('legacy_alias_for_history_only')
    }
    return {
      role,
      agent_id: agentId,
      description: entry.description ?? null,
      warnings,
    }
  })

  const warnings: string[] = []
  if (channels.some((channel) => channel.warnings.includes('channel_id_looks_like_platform_external_id'))) {
    warnings.push('some_channel_ids_are_platform_external_ids')
  }
  if (agents.some((agent) => agent.warnings.includes('display_name_not_unique'))) {
    warnings.push('some_display_names_are_not_unique')
  }
  if (agents.some((agent) => agent.warnings.includes('discord_identity_not_unique'))) {
    warnings.push('some_discord_identities_are_not_unique')
  }
  if (roles.some((role) => role.warnings.includes('target_agent_missing') || role.warnings.includes('target_agent_blocked'))) {
    warnings.push('role_routing_has_unusable_targets')
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    summary: {
      agent_count: agents.length,
      ready_agents: agents.filter((agent) => agent.sendability === 'ready').length,
      queueable_agents: agents.filter((agent) => agent.sendability === 'queueable').length,
      blocked_agents: agents.filter((agent) => agent.sendability === 'blocked').length,
      human_agents: agents.filter((agent) => agent.sendability === 'human').length,
      channel_count: channels.length,
      channel_external_id_count: channels.filter((channel) => channel.discord_external_id).length,
      role_count: roles.length,
    },
    id_policy: {
      agent_id: 'stable logical slug; do not derive from display_name, project_dir, or platform id',
      channel_id: 'stable internal slug is preferred; current rows may still use platform external ids',
      json_role: 'JSON is bootstrap/policy compatibility, not the future UI SSOT',
      db_ssot: true,
      json_role_policy: 'seed/export/import only after DB-backed policy tables exist',
    },
    agents,
    channels,
    mention_directory: {
      policy: {
        db_ssot: true,
        final_send_must_revalidate_db: true,
        hard_blocks: ['agent_missing', 'not_channel_member', 'disabled', 'failed', 'disconnected'],
        runtime_offline_enforcement: 'offline is warning-only until agent_runtime_instances heartbeat evidence is populated',
      },
      channels: mentionChannels,
    },
    roles,
    warnings: policySnapshot.loaded ? warnings : [...warnings, 'channel_policy_db_table_missing_json_fallback_active'],
  }
}

export function formatDirectoryText(report: DirectoryReport): string {
  const lines = [
    'Bot / Channel Directory',
    `Agents: ${report.summary.agent_count} total, ${report.summary.ready_agents} ready, ${report.summary.queueable_agents} queueable, ${report.summary.blocked_agents} blocked, ${report.summary.human_agents} human`,
    `Channels: ${report.summary.channel_count} total, ${report.summary.channel_external_id_count} with external adapter`,
    '',
    'Ready Recipients:',
  ]
  for (const agent of report.agents.filter((item) => item.sendability === 'ready')) {
    lines.push(`  ${agent.agent_id} (${agent.runtime}/${agent.status}) channels=${agent.channel_count}${agent.warnings.length ? ` warnings=${agent.warnings.join(',')}` : ''}`)
  }
  lines.push('', 'Blocked / Do Not Use:')
  for (const agent of report.agents.filter((item) => item.sendability === 'blocked')) {
    lines.push(`  ${agent.agent_id} (${agent.status}) warnings=${agent.warnings.join(',') || 'blocked'}`)
  }
  lines.push('', 'Governance Roles:')
  for (const role of report.roles) {
    lines.push(`  ${role.role} -> ${role.agent_id}${role.warnings.length ? ` warnings=${role.warnings.join(',')}` : ''}`)
  }
  lines.push('', 'Channels:')
  for (const channel of report.channels) {
    const label = channel.name ?? channel.channel_id
    lines.push(`  ${label}: id=${channel.channel_id} members=${channel.member_count} active=${channel.active_member_count} primary=${channel.primary ?? '-'} adapter=${channel.adapter_owner ?? '-'}${channel.warnings.length ? ` warnings=${channel.warnings.join(',')}` : ''}`)
  }
  if (report.warnings.length > 0) {
    lines.push('', `Directory warnings: ${report.warnings.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}
