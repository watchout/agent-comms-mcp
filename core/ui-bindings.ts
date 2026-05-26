export interface UiBindingDb {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

export interface DiscordUiBindingRow {
  agent_id: string
  ui_id: string
  ui_handle?: string | null
  ui_token_ref?: string | null
  binding_id?: string | null
  status?: string | null
  surface_role?: string | null
}

function missingBindingSurface(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /(does not exist|no such table|no such column|column .* does not exist)/i.test(message)
}

async function queryRows<T = any>(db: UiBindingDb | null, sql: string, params?: any[]): Promise<T[]> {
  if (!db) return []
  try {
    const result = await db.query<T>(sql, params)
    return Array.isArray(result.rows) ? result.rows : []
  } catch (err) {
    if (missingBindingSurface(err)) return []
    throw err
  }
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
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

export async function getDiscordUiBindingForAgent(
  db: UiBindingDb | null,
  agentId: string,
): Promise<DiscordUiBindingRow | null> {
  const trimmedAgentId = agentId.trim()
  if (!trimmedAgentId) return null
  const rows = await queryRows<DiscordUiBindingRow>(
    db,
    `SELECT agent_id, ui_id, ui_handle, ui_token_ref, binding_id, status, surface_role
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
  const row = rows[0]
  return row && firstString(row.ui_id) ? row : null
}

export async function getAgentDiscordUiId(
  db: UiBindingDb | null,
  agentId: string,
): Promise<string | null> {
  const binding = await getDiscordUiBindingForAgent(db, agentId)
  if (binding?.ui_id) return String(binding.ui_id)
  const rows = await queryRows<{ discord_id?: string | null; metadata?: unknown }>(
    db,
    "SELECT metadata->>'discord_id' AS discord_id, metadata FROM agents WHERE agent_id = $1",
    [agentId],
  )
  return firstString(rows[0]?.discord_id) ?? firstString(parseJsonObject(rows[0]?.metadata).discord_id)
}

async function discordBindingCandidates(
  db: UiBindingDb | null,
  discordId: string,
): Promise<DiscordUiBindingRow[]> {
  const trimmedDiscordId = discordId.trim()
  if (!trimmedDiscordId) return []
  return queryRows<DiscordUiBindingRow>(
    db,
    `SELECT agent_id, ui_id, ui_handle, ui_token_ref, binding_id, status, surface_role
       FROM agent_ui_bindings
      WHERE ui_type = 'discord'
        AND ui_id = $1
        AND COALESCE(status, 'registered') IN ('registered', 'active')
      ORDER BY
        CASE COALESCE(status, 'registered') WHEN 'active' THEN 0 WHEN 'registered' THEN 1 ELSE 2 END,
        CASE COALESCE(surface_role, 'primary') WHEN 'primary' THEN 0 WHEN 'projection' THEN 1 WHEN 'outbound' THEN 2 ELSE 3 END,
        agent_id`,
    [trimmedDiscordId],
  )
}

async function legacyDiscordIdCandidates(
  db: UiBindingDb | null,
  discordId: string,
): Promise<string[]> {
  const rows = await queryRows<{ agent_id: string }>(
    db,
    "SELECT agent_id FROM agents WHERE metadata->>'discord_id' = $1 ORDER BY agent_id",
    [discordId],
  )
  return rows.map((row) => row.agent_id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export async function resolveAgentFromDiscordUiId(
  db: UiBindingDb | null,
  discordId: string,
): Promise<string | null> {
  const bindingCandidates = await discordBindingCandidates(db, discordId)
  const bindingAgentIds = [...new Set(bindingCandidates.map((row) => row.agent_id).filter(Boolean))]
  if (bindingAgentIds.length === 1) return bindingAgentIds[0]
  if (bindingAgentIds.length > 1) return null

  const legacyAgentIds = await legacyDiscordIdCandidates(db, discordId)
  return legacyAgentIds.length === 1 ? legacyAgentIds[0] : null
}

export async function resolveAgentFromDiscordUiIdInMembers(
  db: UiBindingDb | null,
  discordId: string,
  members: readonly string[],
): Promise<{ agentId: string } | { error: 'not_found' | 'ambiguous'; candidates: string[] }> {
  if (!db || members.length === 0) return { error: 'not_found', candidates: [] }
  const memberSet = new Set(members)

  const bindingCandidates = await discordBindingCandidates(db, discordId)
  const bindingAgentIds = [
    ...new Set(
      bindingCandidates
        .map((row) => row.agent_id)
        .filter((agentId): agentId is string => typeof agentId === 'string' && memberSet.has(agentId)),
    ),
  ]
  if (bindingAgentIds.length === 1) return { agentId: bindingAgentIds[0] }
  if (bindingAgentIds.length > 1) return { error: 'ambiguous', candidates: bindingAgentIds }

  const legacyAgentIds = (await legacyDiscordIdCandidates(db, discordId)).filter((agentId) => memberSet.has(agentId))
  if (legacyAgentIds.length === 1) return { agentId: legacyAgentIds[0] }
  if (legacyAgentIds.length > 1) return { error: 'ambiguous', candidates: legacyAgentIds }
  return { error: 'not_found', candidates: [] }
}
