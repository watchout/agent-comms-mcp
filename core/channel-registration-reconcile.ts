import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'

type SqlDialect = 'postgres' | 'sqlite'

export interface ChannelRegistrationReconcileOptions {
  provider?: string
  windowHours?: number
  externalChannelId?: string | null
  adapterOwnerAgentId?: string | null
  primaryAgentId?: string | null
  members?: string[]
  dryRun?: boolean
  confirmPlanHash?: string | null
  sqlDialect?: SqlDialect
}

export interface ChannelRegistrationObservation {
  message_count: number
  latest_message_id: string | null
  latest_created_at: string | null
  raw_mention_ids: string[]
  resolved_mentions: string[]
  unresolved_mentions: string[]
  ambiguous_mentions: Array<{ external_user_id: string; candidates: string[] }>
}

export interface ChannelRegistrationPlanItem {
  external_channel_id: string
  proposed_channel_id: string
  proposed_channel_name: string
  provider: string
  adapter_owner_agent_id: string
  primary_agent_id: string
  proposed_members: string[]
  channel_adapter: {
    channel_id: string
    platform: string
    external_id: string
    metadata: Record<string, unknown>
  }
  routing_policy: {
    channel_id: string
    primary_agent_id: string
    adapter_owner_agent_id: string
    outbound_allowlist: string[]
    policy_source: 'channel_registration_reconcile'
  }
  observations: ChannelRegistrationObservation
  actions: Array<{
    table: 'channels' | 'channel_adapters' | 'channel_routing_policy' | 'audit_log'
    action: 'upsert' | 'insert'
    key: Record<string, string>
  }>
  reversibility: string[]
  warnings: string[]
}

export interface ChannelRegistrationSkippedItem {
  external_channel_id: string
  reason:
    | 'already_registered'
    | 'adapter_owner_required'
    | 'unknown_adapter_owner'
    | 'unknown_primary_agent'
    | 'unknown_member'
    | 'no_proposed_members'
  details?: Record<string, unknown>
}

export interface ChannelRegistrationReconcileReport {
  ok: boolean
  dry_run: boolean
  generated_at: string
  plan_hash: string
  error?: 'OPERATOR_APPROVAL_REQUIRED'
  policy: {
    read_only_inventory: boolean
    dry_run_default: boolean
    execute_requires_confirm_plan_hash: boolean
    no_raw_tokens_in_output: boolean
    reversible_where_possible: boolean
  }
  options: {
    provider: string
    window_hours: number
    external_channel_id: string | null
    adapter_owner_agent_id: string | null
    primary_agent_id: string | null
  }
  summary: {
    observed_missing_channels: number
    planned: number
    skipped: number
    executed: number
  }
  planned: ChannelRegistrationPlanItem[]
  skipped: ChannelRegistrationSkippedItem[]
  executed: Array<{ external_channel_id: string; channel_id: string }>
  mutations: {
    channels_upserted: number
    channel_adapters_upserted: number
    channel_routing_policies_upserted: number
    audit_rows_inserted: number
  }
}

export interface UnregisteredInboundDiagnosticInput {
  provider: string
  externalChannelId: string
  externalMessageId: string
  receiverAgentId: string
  authorExternalId: string
  authorName: string
  authorIsBot: boolean
  content: string
  messageId?: string
  mentions: string[]
  timestamp: Date
}

type QueryDb = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[] }>
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > 0 ? text : null
}

function asCount(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).map((item) => item.trim()).filter(Boolean)
  }
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean)
  }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed.map(String).map((item) => item.trim()).filter(Boolean) : []
  } catch {
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean)
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort()
}

function extractDiscordMentionIds(content: string): string[] {
  const ids: string[] = []
  for (const match of content.matchAll(/<@!?(\d+)>/g)) {
    if (match[1]) ids.push(match[1])
  }
  return uniqueSorted(ids)
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new Error(`PROVIDER_INVALID: ${provider}`)
  }
  return normalized
}

function missingOptionalSurface(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /(does not exist|no such table|no such column|column .* does not exist)/i.test(message)
}

async function queryOptional<T = any>(db: DbAdapter, sql: string, params?: any[]): Promise<T[]> {
  try {
    return await db.query<T>(sql, params)
  } catch (err) {
    if (missingOptionalSurface(err)) return []
    throw err
  }
}

async function queryOneOptional<T = any>(db: DbAdapter, sql: string, params?: any[]): Promise<T | null> {
  const rows = await queryOptional<T>(db, sql, params)
  return rows[0] ?? null
}

async function agentExists(db: DbAdapter, agentId: string | null | undefined): Promise<boolean> {
  const id = agentId?.trim()
  if (!id) return false
  const row = await db.queryOne<{ agent_id: string }>(
    `SELECT agent_id FROM agents WHERE agent_id = $1 LIMIT 1`,
    [id],
  )
  return row !== null
}

async function resolveDiscordUserId(db: DbAdapter, provider: string, externalUserId: string): Promise<{ agentId: string } | { error: 'not_found' | 'ambiguous'; candidates: string[] }> {
  const bindingRows = await queryOptional<{ agent_id: string }>(
    db,
    `SELECT agent_id
       FROM agent_ui_bindings
      WHERE ui_type = $1
        AND ui_id = $2
        AND COALESCE(status, 'registered') IN ('registered', 'active')
      ORDER BY agent_id`,
    [provider, externalUserId],
  )
  const legacyRows = await queryOptional<{ agent_id: string }>(
    db,
    "SELECT agent_id FROM agents WHERE metadata->>'discord_id' = $1 ORDER BY agent_id",
    [externalUserId],
  )
  const candidates = uniqueSorted([
    ...bindingRows.map((row) => row.agent_id),
    ...legacyRows.map((row) => row.agent_id),
  ])
  if (candidates.length === 1) return { agentId: candidates[0] }
  if (candidates.length > 1) return { error: 'ambiguous', candidates }
  return { error: 'not_found', candidates: [] }
}

async function inferSingleAdapterOwner(db: DbAdapter, provider: string): Promise<{ owner: string | null; candidates: string[] }> {
  const connectorRows = await queryOptional<{ agent_id: string }>(
    db,
    `SELECT DISTINCT agent_id
       FROM connector_instances
      WHERE provider = $1
        AND COALESCE(status, 'registered') IN ('registered', 'active')
      ORDER BY agent_id`,
    [provider],
  )
  const uiRows = await queryOptional<{ agent_id: string }>(
    db,
    `SELECT DISTINCT agent_id
       FROM agent_ui_bindings
      WHERE ui_type = $1
        AND COALESCE(status, 'registered') IN ('registered', 'active')
        AND NULLIF(COALESCE(ui_token_ref, ''), '') IS NOT NULL
      ORDER BY agent_id`,
    [provider],
  )
  const agentRows = await queryOptional<{ agent_id: string }>(
    db,
    `SELECT agent_id
       FROM agents
      WHERE NULLIF(COALESCE(provider_token_source_ref, ''), '') IS NOT NULL
      ORDER BY agent_id`,
  )
  const candidates = uniqueSorted([
    ...connectorRows.map((row) => row.agent_id),
    ...uiRows.map((row) => row.agent_id),
    ...agentRows.map((row) => row.agent_id),
  ])
  return { owner: candidates.length === 1 ? candidates[0] : null, candidates }
}

async function registrationState(db: DbAdapter, provider: string, externalChannelId: string): Promise<{ registered: boolean; details: Record<string, unknown> }> {
  const channel = await db.queryOne<{ id: string }>(
    `SELECT id FROM channels WHERE id = $1 LIMIT 1`,
    [externalChannelId],
  )
  if (channel) return { registered: true, details: { channels_id: channel.id } }

  const adapter = await queryOneOptional<{ channel_id: string }>(
    db,
    `SELECT channel_id FROM channel_adapters WHERE platform = $1 AND external_id = $2 LIMIT 1`,
    [provider, externalChannelId],
  )
  if (adapter) return { registered: true, details: { channel_adapters_channel_id: adapter.channel_id } }

  const threadAdapter = await queryOneOptional<{ thread_id: string }>(
    db,
    `SELECT thread_id FROM thread_adapters WHERE platform = $1 AND external_id = $2 LIMIT 1`,
    [provider, externalChannelId],
  )
  if (threadAdapter) return { registered: true, details: { thread_adapters_thread_id: threadAdapter.thread_id } }

  return { registered: false, details: {} }
}

async function observedMissingExternalChannels(
  db: DbAdapter,
  provider: string,
  windowHours: number,
  externalChannelId: string | null,
): Promise<Array<{ external_channel_id: string; message_count: number; latest_created_at: string | null }>> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const rows = await db.query<{ external_channel_id: string | null; message_count: unknown; latest_created_at: unknown }>(
    `SELECT COALESCE(metadata->>'${provider}_channel_id', channel_id) AS external_channel_id,
            COUNT(*) AS message_count,
            MAX(created_at) AS latest_created_at
       FROM agent_messages
      WHERE source = $1
        AND direction = 'inbound'
        AND created_at >= $2
        AND COALESCE(metadata->>'${provider}_channel_id', channel_id) IS NOT NULL
        AND ($3::text IS NULL OR COALESCE(metadata->>'${provider}_channel_id', channel_id) = $3::text)
      GROUP BY COALESCE(metadata->>'${provider}_channel_id', channel_id)
      ORDER BY MAX(created_at) DESC, COALESCE(metadata->>'${provider}_channel_id', channel_id)`,
    [provider, cutoff, externalChannelId],
  )
  return rows
    .map((row) => ({
      external_channel_id: asString(row.external_channel_id) ?? '',
      message_count: asCount(row.message_count),
      latest_created_at: asString(row.latest_created_at),
    }))
    .filter((row) => row.external_channel_id.length > 0)
}

async function buildObservation(
  db: DbAdapter,
  provider: string,
  externalChannelId: string,
  windowHours: number,
  messageCount: number,
): Promise<ChannelRegistrationObservation> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  const rows = await db.query<any>(
    `SELECT id, content, metadata, input_mentions, created_at
       FROM agent_messages
      WHERE source = $1
        AND direction = 'inbound'
        AND created_at >= $2
        AND COALESCE(metadata->>'${provider}_channel_id', channel_id) = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 25`,
    [provider, cutoff, externalChannelId],
  )

  const rawMentionIds = uniqueSorted(rows.flatMap((row) => extractDiscordMentionIds(String(row.content ?? ''))))
  const metadataMentions = rows.flatMap((row) => parseStringArray(parseJsonObject(row.metadata).mentions))
  const inputMentions = rows.flatMap((row) => parseStringArray(row.input_mentions))
  const resolvedFromRows = new Set<string>([
    ...metadataMentions.filter((mention) => !/^\d+$/.test(mention)),
    ...inputMentions.filter((mention) => !/^\d+$/.test(mention)),
  ])
  const unresolved: string[] = []
  const ambiguous: Array<{ external_user_id: string; candidates: string[] }> = []
  for (const rawId of uniqueSorted([...rawMentionIds, ...metadataMentions.filter((mention) => /^\d+$/.test(mention))])) {
    const resolved = await resolveDiscordUserId(db, provider, rawId)
    if ('agentId' in resolved) resolvedFromRows.add(resolved.agentId)
    else if (resolved.error === 'ambiguous') ambiguous.push({ external_user_id: rawId, candidates: resolved.candidates })
    else unresolved.push(rawId)
  }

  const latest = rows[0]
  return {
    message_count: messageCount,
    latest_message_id: latest?.id ? String(latest.id) : null,
    latest_created_at: asString(latest?.created_at),
    raw_mention_ids: rawMentionIds,
    resolved_mentions: uniqueSorted(resolvedFromRows),
    unresolved_mentions: uniqueSorted(unresolved),
    ambiguous_mentions: ambiguous.sort((a, b) => a.external_user_id.localeCompare(b.external_user_id)),
  }
}

function channelNameFor(externalChannelId: string): string {
  return `discord-${externalChannelId}`
}

function membersParam(members: string[], dialect: SqlDialect): unknown {
  return dialect === 'sqlite' ? JSON.stringify(members) : members
}

function stablePlanHash(report: {
  provider: string
  window_hours: number
  external_channel_id: string | null
  planned: ChannelRegistrationPlanItem[]
  skipped: ChannelRegistrationSkippedItem[]
}): string {
  const stable = {
    provider: report.provider,
    window_hours: report.window_hours,
    external_channel_id: report.external_channel_id,
    planned: report.planned.map((item) => ({
      external_channel_id: item.external_channel_id,
      proposed_channel_id: item.proposed_channel_id,
      proposed_members: item.proposed_members,
      adapter_owner_agent_id: item.adapter_owner_agent_id,
      primary_agent_id: item.primary_agent_id,
      channel_adapter: item.channel_adapter,
      routing_policy: item.routing_policy,
    })),
    skipped: report.skipped,
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

async function executePlan(
  db: DbAdapter,
  planned: ChannelRegistrationPlanItem[],
  provider: string,
  planHash: string,
  dialect: SqlDialect,
): Promise<ChannelRegistrationReconcileReport['mutations']> {
  const mutations = {
    channels_upserted: 0,
    channel_adapters_upserted: 0,
    channel_routing_policies_upserted: 0,
    audit_rows_inserted: 0,
  }
  await db.transaction(async (tx) => {
    for (const item of planned) {
      await tx.execute(
        `INSERT INTO channels (id, name, type, members)
         VALUES ($1, $2, 'channel', $3)
         ON CONFLICT (id) DO UPDATE SET name = $2, type = 'channel', members = $3`,
        [item.proposed_channel_id, item.proposed_channel_name, membersParam(item.proposed_members, dialect)],
      )
      mutations.channels_upserted++

      await tx.execute(
        `INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, platform) DO UPDATE SET external_id = $3, metadata = $4`,
        [
          item.channel_adapter.channel_id,
          item.channel_adapter.platform,
          item.channel_adapter.external_id,
          JSON.stringify(item.channel_adapter.metadata),
        ],
      )
      mutations.channel_adapters_upserted++

      await tx.execute(
        `INSERT INTO channel_routing_policy (
           channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
           native_role_outbound_owners, native_projection_identities, policy_source
         ) VALUES ($1, $2, $3, $4, $5, $6, 'channel_registration_reconcile')
         ON CONFLICT (channel_id) DO UPDATE SET
           primary_agent_id = $2,
           adapter_owner_agent_id = $3,
           outbound_allowlist = $4,
           native_role_outbound_owners = $5,
           native_projection_identities = $6,
           policy_source = 'channel_registration_reconcile',
           updated_at = NOW()`,
        [
          item.routing_policy.channel_id,
          item.routing_policy.primary_agent_id,
          item.routing_policy.adapter_owner_agent_id,
          JSON.stringify(item.routing_policy.outbound_allowlist),
          JSON.stringify({}),
          JSON.stringify({}),
        ],
      )
      mutations.channel_routing_policies_upserted++

      await tx.execute(
        `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
         VALUES ($1, $2, $3, $4, 'default')`,
        [
          'channel.registration_reconcile_execute',
          item.adapter_owner_agent_id,
          item.proposed_channel_id,
          JSON.stringify({
            provider,
            plan_hash: planHash,
            external_channel_id: item.external_channel_id,
            proposed_members: item.proposed_members,
            reversible_where_possible: item.reversibility,
          }),
        ],
      )
      mutations.audit_rows_inserted++
    }
  })
  return mutations
}

export async function buildChannelRegistrationReconcileReport(
  db: DbAdapter,
  options: ChannelRegistrationReconcileOptions = {},
): Promise<ChannelRegistrationReconcileReport> {
  const provider = normalizeProvider(options.provider ?? 'discord')
  const windowHours = options.windowHours ?? 168
  const dryRun = options.dryRun !== false
  const externalChannelId = options.externalChannelId?.trim() || null
  const dialect = options.sqlDialect ?? (process.env.AGENT_COM_DB === 'sqlite' ? 'sqlite' : 'postgres')
  const observed = await observedMissingExternalChannels(db, provider, windowHours, externalChannelId)
  const explicitMembers = uniqueSorted(options.members ?? [])
  const inferredOwner = options.adapterOwnerAgentId?.trim()
    ? { owner: options.adapterOwnerAgentId.trim(), candidates: [options.adapterOwnerAgentId.trim()] }
    : await inferSingleAdapterOwner(db, provider)

  const planned: ChannelRegistrationPlanItem[] = []
  const skipped: ChannelRegistrationSkippedItem[] = []

  for (const row of observed) {
    const state = await registrationState(db, provider, row.external_channel_id)
    if (state.registered) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'already_registered',
        details: state.details,
      })
      continue
    }

    const observation = await buildObservation(db, provider, row.external_channel_id, windowHours, row.message_count)
    const warnings: string[] = []
    if (observation.unresolved_mentions.length > 0) warnings.push(`unresolved_mentions:${observation.unresolved_mentions.join(',')}`)
    if (observation.ambiguous_mentions.length > 0) warnings.push(`ambiguous_mentions:${observation.ambiguous_mentions.map((m) => m.external_user_id).join(',')}`)
    if (!inferredOwner.owner && inferredOwner.candidates.length > 1) warnings.push(`adapter_owner_ambiguous:${inferredOwner.candidates.join(',')}`)

    const adapterOwner = inferredOwner.owner
    if (!adapterOwner) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'adapter_owner_required',
        details: {
          candidates: inferredOwner.candidates,
          observations: observation,
        },
      })
      continue
    }
    if (!(await agentExists(db, adapterOwner))) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'unknown_adapter_owner',
        details: { adapter_owner_agent_id: adapterOwner },
      })
      continue
    }

    const primary = options.primaryAgentId === null
      ? adapterOwner
      : (options.primaryAgentId?.trim() || adapterOwner)
    if (!(await agentExists(db, primary))) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'unknown_primary_agent',
        details: { primary_agent_id: primary },
      })
      continue
    }

    const proposedMembers = uniqueSorted([
      ...explicitMembers,
      ...observation.resolved_mentions,
      adapterOwner,
      primary,
    ])
    const unknownMembers: string[] = []
    for (const member of proposedMembers) {
      if (!(await agentExists(db, member))) unknownMembers.push(member)
    }
    if (unknownMembers.length > 0) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'unknown_member',
        details: { unknown_members: unknownMembers, observations: observation },
      })
      continue
    }
    if (proposedMembers.length === 0) {
      skipped.push({
        external_channel_id: row.external_channel_id,
        reason: 'no_proposed_members',
        details: { observations: observation },
      })
      continue
    }

    const proposedChannelId = row.external_channel_id
    const proposedChannelName = channelNameFor(row.external_channel_id)
    planned.push({
      external_channel_id: row.external_channel_id,
      proposed_channel_id: proposedChannelId,
      proposed_channel_name: proposedChannelName,
      provider,
      adapter_owner_agent_id: adapterOwner,
      primary_agent_id: primary,
      proposed_members: proposedMembers,
      channel_adapter: {
        channel_id: proposedChannelId,
        platform: provider,
        external_id: row.external_channel_id,
        metadata: {
          source: 'channel_registration_reconcile',
          observed_message_count: row.message_count,
          latest_created_at: row.latest_created_at,
        },
      },
      routing_policy: {
        channel_id: proposedChannelId,
        primary_agent_id: primary,
        adapter_owner_agent_id: adapterOwner,
        outbound_allowlist: proposedMembers,
        policy_source: 'channel_registration_reconcile',
      },
      observations: observation,
      actions: [
        { table: 'channels', action: 'upsert', key: { id: proposedChannelId } },
        { table: 'channel_adapters', action: 'upsert', key: { channel_id: proposedChannelId, platform: provider } },
        { table: 'channel_routing_policy', action: 'upsert', key: { channel_id: proposedChannelId } },
        { table: 'audit_log', action: 'insert', key: { event_type: 'channel.registration_reconcile_execute', target: proposedChannelId } },
      ],
      reversibility: [
        `DELETE FROM channel_routing_policy WHERE channel_id = '${proposedChannelId}' AND policy_source = 'channel_registration_reconcile'`,
        `DELETE FROM channel_adapters WHERE channel_id = '${proposedChannelId}' AND platform = '${provider}'`,
        `DELETE FROM channels WHERE id = '${proposedChannelId}'`,
      ],
      warnings,
    })
  }

  const planHash = stablePlanHash({
    provider,
    window_hours: windowHours,
    external_channel_id: externalChannelId,
    planned,
    skipped,
  })
  const executed: Array<{ external_channel_id: string; channel_id: string }> = []
  let mutations = {
    channels_upserted: 0,
    channel_adapters_upserted: 0,
    channel_routing_policies_upserted: 0,
    audit_rows_inserted: 0,
  }
  let ok = true
  let error: ChannelRegistrationReconcileReport['error']

  if (!dryRun) {
    if (options.confirmPlanHash !== planHash) {
      ok = false
      error = 'OPERATOR_APPROVAL_REQUIRED'
    } else {
      mutations = await executePlan(db, planned, provider, planHash, dialect)
      executed.push(...planned.map((item) => ({
        external_channel_id: item.external_channel_id,
        channel_id: item.proposed_channel_id,
      })))
    }
  }

  return {
    ok,
    dry_run: dryRun,
    generated_at: new Date().toISOString(),
    plan_hash: planHash,
    ...(error ? { error } : {}),
    policy: {
      read_only_inventory: dryRun,
      dry_run_default: true,
      execute_requires_confirm_plan_hash: true,
      no_raw_tokens_in_output: true,
      reversible_where_possible: true,
    },
    options: {
      provider,
      window_hours: windowHours,
      external_channel_id: externalChannelId,
      adapter_owner_agent_id: inferredOwner.owner,
      primary_agent_id: options.primaryAgentId?.trim() || inferredOwner.owner,
    },
    summary: {
      observed_missing_channels: observed.length,
      planned: planned.length,
      skipped: skipped.length,
      executed: executed.length,
    },
    planned,
    skipped,
    executed,
    mutations,
  }
}

export function formatChannelRegistrationReconcileText(report: ChannelRegistrationReconcileReport): string {
  const lines = [
    'Channel Registration Reconcile',
    `Generated: ${report.generated_at}`,
    `Provider: ${report.options.provider} window=${report.options.window_hours}h dry_run=${report.dry_run}`,
    `Plan hash: ${report.plan_hash}`,
    `Observed missing=${report.summary.observed_missing_channels} planned=${report.summary.planned} skipped=${report.summary.skipped} executed=${report.summary.executed}`,
    '',
  ]
  if (report.error === 'OPERATOR_APPROVAL_REQUIRED') {
    lines.push(`Error: ${report.error}; rerun with --execute --confirm ${report.plan_hash}`, '')
  }
  for (const item of report.planned) {
    lines.push(
      `- ${item.external_channel_id}: channel=${item.proposed_channel_id} owner=${item.adapter_owner_agent_id} primary=${item.primary_agent_id} members=${item.proposed_members.join(',') || 'none'}`,
    )
    lines.push(`  policy=${item.routing_policy.policy_source} adapter=${item.channel_adapter.platform}:${item.channel_adapter.external_id}`)
    if (item.warnings.length > 0) lines.push(`  warnings=${item.warnings.join(',')}`)
  }
  if (report.skipped.length > 0) {
    lines.push('', 'Skipped:')
    for (const item of report.skipped) {
      lines.push(`- ${item.external_channel_id}: ${item.reason}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function recordUnregisteredInboundDiagnostic(
  db: QueryDb | null,
  input: UnregisteredInboundDiagnosticInput,
): Promise<boolean> {
  if (!db) return false
  const detail = {
    source: 'inbound_receiver',
    reason: 'CHANNEL_UNKNOWN',
    provider: input.provider,
    external_channel_id: input.externalChannelId,
    external_message_id: input.externalMessageId,
    receiver_agent_id: input.receiverAgentId,
    author_external_id: input.authorExternalId,
    author_name: input.authorName,
    author_is_bot: input.authorIsBot,
    message_id: input.messageId ?? null,
    input_mentions: input.mentions,
    raw_mention_ids: extractDiscordMentionIds(input.content),
    queue_rows_created: 0,
    occurred_at: input.timestamp.toISOString(),
    recommended_action: 'agent-com channel reconcile --provider discord --dry-run',
  }
  try {
    await db.query(
      `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
       VALUES ($1, $2, $3, $4, 'default')`,
      [
        'inbound.channel_unregistered',
        input.receiverAgentId,
        input.externalChannelId,
        JSON.stringify(detail),
      ],
    )
    return true
  } catch (err) {
    if (missingOptionalSurface(err)) return false
    throw err
  }
}
