import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DbAdapter } from './db'

export type AgentRoleRoutingConfig = {
  roles?: Record<string, {
    agentId?: string
    activeFunction?: string
    canonicalSeat?: string
    historicalOnly?: boolean
    newWorkAllowed?: boolean
    legacyAgentIds?: string[]
    newWorkAllowedViaLegacyIds?: boolean
    description?: string
  }>
  legacyAgentIds?: Record<string, {
    canonicalAgentId?: string
    status?: string
    historicalOnly?: boolean
    newWorkAllowed?: boolean
    reason?: string
  }>
  auditRouting?: {
    evidenceAuditGate?: {
      activeFunction?: string
      canonicalSeat?: string
      agentId?: string
      forbiddenFallbackAgentIds?: string[]
    }
    scenarioVerificationGate?: {
      activeFunction?: string
      canonicalSeat?: string
      agentId?: string
    }
  }
}

export type AuditSeatRouteInput = {
  active_function?: string | null
  canonical_seat?: string | null
  requested_agent_id?: string | null
}

export type AuditSeatRouteResult =
  | {
      ok: true
      active_function: string
      canonical_seat: string
      agent_id: string
      reason: 'evidence_audit_gate_canonical_seat' | 'scenario_verification_gate'
    }
  | {
      ok: false
      active_function: string | null
      canonical_seat: string | null
      requested_agent_id: string | null
      code:
        | 'ACTIVE_FUNCTION_REQUIRED'
        | 'CANONICAL_SEAT_REQUIRED'
        | 'CANONICAL_SEAT_MISMATCH'
        | 'HISTORICAL_AGENT_NOT_ROUTABLE'
        | 'AGENT_FUNCTION_MISMATCH'
        | 'AUDIT_ROUTE_UNSUPPORTED'
      detail: string
    }

export type AgentRetirementPlan = {
  ok: true
  dry_run: boolean
  agent_id: string
  reason: string
  agent_exists: boolean
  final_tombstone: {
    status: 'disabled'
    historical_only: true
    new_work_allowed: false
    profile_enabled: false
    non_routable: true
  }
  affected: {
    connector_instances: string[]
    channel_connector_bindings: string[]
    connector_credentials: string[]
    agent_provider_identities: string[]
    provider_channel_access: string[]
    agent_ui_bindings: string[]
    agent_workspace_bindings: Array<{ agent_id: string; workspace_id: string; binding_role: string }>
    agent_runtime_instances: string[]
    channel_memberships: Array<{ channel_id: string; before_members: string[]; after_members: string[] }>
  }
}

type Queryable = Pick<DbAdapter, 'query' | 'execute' | 'transaction' | 'dialect'>

function roleConfigPath(): string {
  if (process.env.AGENT_COM_ROLE_ROUTING_PATH) return process.env.AGENT_COM_ROLE_ROUTING_PATH
  const repoRoot = new URL('..', import.meta.url).pathname
  return join(repoRoot, 'config', 'agent-role-routing.json')
}

export function loadAgentRoleRoutingConfig(): AgentRoleRoutingConfig {
  const path = roleConfigPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AgentRoleRoutingConfig
  } catch {
    return {}
  }
}

function normalize(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value.length > 0 ? value : null
}

function normalizeBool(raw: unknown, fallback = false): boolean {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  const value = String(raw).trim().toLowerCase()
  if (!value) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value)
}

export function isHistoricalOnlyAgentId(agentId: string, config = loadAgentRoleRoutingConfig()): boolean {
  const legacy = config.legacyAgentIds?.[agentId]
  if (legacy?.historicalOnly === true || legacy?.newWorkAllowed === false) return true
  for (const role of Object.values(config.roles ?? {})) {
    if (role.legacyAgentIds?.includes(agentId) && role.newWorkAllowedViaLegacyIds === false) return true
  }
  return false
}

export function isHistoricalRoleKey(roleKey: string, config = loadAgentRoleRoutingConfig()): boolean {
  const role = config.roles?.[roleKey]
  return role?.historicalOnly === true || role?.newWorkAllowed === false
}

export function resolveAuditSeatRoute(
  input: AuditSeatRouteInput,
  config = loadAgentRoleRoutingConfig(),
): AuditSeatRouteResult {
  const activeFunction = normalize(input.active_function)
  const canonicalSeat = normalize(input.canonical_seat)
  const requestedAgentId = normalize(input.requested_agent_id)
  const evidence = config.auditRouting?.evidenceAuditGate ?? {}
  const scenario = config.auditRouting?.scenarioVerificationGate ?? {}
  const evidenceFunction = evidence.activeFunction ?? 'evidence_audit_gate'
  const evidenceSeat = evidence.canonicalSeat ?? 'codex-audit'
  const evidenceAgent = evidence.agentId ?? evidenceSeat
  const forbiddenEvidenceFallbacks = new Set([
    ...(evidence.forbiddenFallbackAgentIds ?? []),
    'l2auditor',
    'devauditor',
  ])
  const scenarioFunction = scenario.activeFunction ?? 'scenario_verification_gate'
  const scenarioSeat = scenario.canonicalSeat ?? 'devauditor'
  const scenarioAgent = scenario.agentId ?? scenarioSeat

  if (!activeFunction) {
    return {
      ok: false,
      active_function: null,
      canonical_seat: canonicalSeat,
      requested_agent_id: requestedAgentId,
      code: 'ACTIVE_FUNCTION_REQUIRED',
      detail: 'active_function is required for audit routing',
    }
  }

  if (requestedAgentId && isHistoricalOnlyAgentId(requestedAgentId, config)) {
    return {
      ok: false,
      active_function: activeFunction,
      canonical_seat: canonicalSeat,
      requested_agent_id: requestedAgentId,
      code: 'HISTORICAL_AGENT_NOT_ROUTABLE',
      detail: `${requestedAgentId} is historical_only and cannot receive new work`,
    }
  }

  if (activeFunction === evidenceFunction) {
    if (!canonicalSeat) {
      return {
        ok: false,
        active_function: activeFunction,
        canonical_seat: null,
        requested_agent_id: requestedAgentId,
        code: 'CANONICAL_SEAT_REQUIRED',
        detail: `canonical_seat=${evidenceSeat} is required for ${evidenceFunction}`,
      }
    }
    if (canonicalSeat !== evidenceSeat) {
      return {
        ok: false,
        active_function: activeFunction,
        canonical_seat: canonicalSeat,
        requested_agent_id: requestedAgentId,
        code: 'CANONICAL_SEAT_MISMATCH',
        detail: `${evidenceFunction} must use canonical_seat=${evidenceSeat}`,
      }
    }
    if (requestedAgentId && requestedAgentId !== evidenceAgent) {
      const code = forbiddenEvidenceFallbacks.has(requestedAgentId)
        ? 'AGENT_FUNCTION_MISMATCH'
        : 'CANONICAL_SEAT_MISMATCH'
      return {
        ok: false,
        active_function: activeFunction,
        canonical_seat: canonicalSeat,
        requested_agent_id: requestedAgentId,
        code,
        detail: `${evidenceFunction} routes only to ${evidenceAgent}`,
      }
    }
    return {
      ok: true,
      active_function: activeFunction,
      canonical_seat: canonicalSeat,
      agent_id: evidenceAgent,
      reason: 'evidence_audit_gate_canonical_seat',
    }
  }

  if (activeFunction === scenarioFunction) {
    if (canonicalSeat && canonicalSeat !== scenarioSeat) {
      return {
        ok: false,
        active_function: activeFunction,
        canonical_seat: canonicalSeat,
        requested_agent_id: requestedAgentId,
        code: 'CANONICAL_SEAT_MISMATCH',
        detail: `${scenarioFunction} uses canonical_seat=${scenarioSeat}`,
      }
    }
    if (requestedAgentId && requestedAgentId !== scenarioAgent) {
      return {
        ok: false,
        active_function: activeFunction,
        canonical_seat: canonicalSeat,
        requested_agent_id: requestedAgentId,
        code: 'AGENT_FUNCTION_MISMATCH',
        detail: `${scenarioFunction} routes only to ${scenarioAgent}`,
      }
    }
    return {
      ok: true,
      active_function: activeFunction,
      canonical_seat: canonicalSeat ?? scenarioSeat,
      agent_id: scenarioAgent,
      reason: 'scenario_verification_gate',
    }
  }

  return {
    ok: false,
    active_function: activeFunction,
    canonical_seat: canonicalSeat,
    requested_agent_id: requestedAgentId,
    code: 'AUDIT_ROUTE_UNSUPPORTED',
    detail: `unsupported active_function for audit routing: ${activeFunction}`,
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string')
  if (typeof raw !== 'string') return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string')
  } catch {}
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
  }
  return []
}

async function queryIds(db: Queryable, sql: string, params: unknown[], idColumn: string): Promise<string[]> {
  const rows = await db.query<Record<string, unknown>>(sql, params).catch(() => [])
  return rows.map((row) => String(row[idColumn])).filter(Boolean)
}

async function queryWorkspaceBindings(db: Queryable, agentId: string): Promise<AgentRetirementPlan['affected']['agent_workspace_bindings']> {
  const rows = await db.query<any>(
    `SELECT agent_id, workspace_id, binding_role
       FROM agent_workspace_bindings
      WHERE agent_id = $1
        AND active = true
      ORDER BY workspace_id, binding_role`,
    [agentId],
  ).catch(() => [])
  return rows.map((row) => ({
    agent_id: String(row.agent_id),
    workspace_id: String(row.workspace_id),
    binding_role: String(row.binding_role),
  }))
}

async function queryChannelMemberships(db: Queryable, agentId: string): Promise<AgentRetirementPlan['affected']['channel_memberships']> {
  const rows = await db.query<any>(
    `SELECT id, members
       FROM channels
      ORDER BY id`,
  ).catch(() => [])
  const memberships: AgentRetirementPlan['affected']['channel_memberships'] = []
  for (const row of rows) {
    const beforeMembers = parseMembers(row.members)
    if (!beforeMembers.includes(agentId)) continue
    memberships.push({
      channel_id: String(row.id),
      before_members: beforeMembers,
      after_members: beforeMembers.filter((member) => member !== agentId),
    })
  }
  return memberships
}

export async function buildAgentRetirementPlan(
  db: Queryable,
  input: { agentId: string; reason?: string; dryRun?: boolean },
): Promise<AgentRetirementPlan> {
  const agentId = input.agentId.trim()
  const reason = input.reason?.trim() || 'historical-only identity canonicalization'
  const rows = await db.query<any>(
    `SELECT agent_id
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  ).catch(() => [])
  return {
    ok: true,
    dry_run: input.dryRun !== false,
    agent_id: agentId,
    reason,
    agent_exists: rows.length > 0,
    final_tombstone: {
      status: 'disabled',
      historical_only: true,
      new_work_allowed: false,
      profile_enabled: false,
      non_routable: true,
    },
    affected: {
      connector_instances: await queryIds(
        db,
        `SELECT connector_instance_id
           FROM connector_instances
          WHERE agent_id = $1
            AND status IN ('registered', 'active', 'standby', 'draining')
          ORDER BY connector_instance_id`,
        [agentId],
        'connector_instance_id',
      ),
      channel_connector_bindings: await queryIds(
        db,
        `SELECT b.channel_binding_id
           FROM channel_connector_bindings b
           JOIN connector_instances ci ON ci.connector_instance_id = b.connector_instance_id
          WHERE ci.agent_id = $1
            AND b.status IN ('active', 'standby')
          ORDER BY b.channel_binding_id`,
        [agentId],
        'channel_binding_id',
      ),
      connector_credentials: await queryIds(
        db,
        `SELECT credential_id
           FROM connector_credentials
          WHERE agent_id = $1
            AND status IN ('registered', 'active')
          ORDER BY credential_id`,
        [agentId],
        'credential_id',
      ),
      agent_provider_identities: await queryIds(
        db,
        `SELECT provider_identity_id
           FROM agent_provider_identities
          WHERE agent_id = $1
            AND status IN ('expected', 'verified')
          ORDER BY provider_identity_id`,
        [agentId],
        'provider_identity_id',
      ),
      provider_channel_access: await queryIds(
        db,
        `SELECT pca.provider_channel_access_id
           FROM provider_channel_access pca
           LEFT JOIN connector_instances ci
             ON ci.connector_instance_id = pca.connector_instance_id
          WHERE (pca.agent_id = $1 OR ci.agent_id = $1)
            AND pca.status = 'active'
          ORDER BY pca.provider_channel_access_id`,
        [agentId],
        'provider_channel_access_id',
      ),
      agent_ui_bindings: await queryIds(
        db,
        `SELECT binding_id
           FROM agent_ui_bindings
          WHERE agent_id = $1
            AND status IN ('registered', 'active')
          ORDER BY binding_id`,
        [agentId],
        'binding_id',
      ),
      agent_workspace_bindings: await queryWorkspaceBindings(db, agentId),
      agent_runtime_instances: await queryIds(
        db,
        `SELECT runtime_instance_id
           FROM agent_runtime_instances
          WHERE agent_id = $1
            AND status IN ('running', 'active', 'unknown')
          ORDER BY started_at DESC`,
        [agentId],
        'runtime_instance_id',
      ),
      channel_memberships: await queryChannelMemberships(db, agentId),
    },
  }
}

async function updateByIds(db: Queryable, table: string, idColumn: string, ids: string[], sqlSet: string): Promise<void> {
  for (const id of ids) {
    await db.execute(`UPDATE ${table} SET ${sqlSet} WHERE ${idColumn} = $1`, [id])
  }
}

async function upsertTombstone(db: Queryable, agentId: string, reason: string): Promise<void> {
  const rows = await db.query<any>(
    `SELECT agent_id, metadata
       FROM agents
      WHERE agent_id = $1
      LIMIT 1`,
    [agentId],
  )
  const now = new Date().toISOString()
  const metadata = {
    ...parseJsonObject(rows[0]?.metadata),
    historical_only: true,
    lifecycle: 'historical_only',
    non_routable: true,
    new_work_allowed: false,
    tombstone_reason: reason,
    tombstoned_at: now,
  }
  if (rows.length === 0) {
    await db.execute(
      `INSERT INTO agents (
         agent_id, display_name, agent_type, runtime, status, metadata,
         disabled_at, historical_only, new_work_allowed, profile_enabled
       )
       VALUES ($1, $1, 'historical', 'none', 'disabled', $2, now(), true, false, false)`,
      [agentId, JSON.stringify(metadata)],
    )
    return
  }
  await db.execute(
    `UPDATE agents
        SET display_name = COALESCE(NULLIF(display_name, ''), $1),
            agent_type = COALESCE(NULLIF(agent_type, ''), 'historical'),
            runtime = COALESCE(NULLIF(runtime, ''), 'none'),
            status = 'disabled',
            metadata = $2,
            disabled_at = COALESCE(disabled_at, now()),
            historical_only = true,
            new_work_allowed = false,
            profile_enabled = false,
            profile_updated_at = now()
      WHERE agent_id = $1`,
    [agentId, JSON.stringify(metadata)],
  )
}

async function writeRetirementAudit(db: Queryable, plan: AgentRetirementPlan): Promise<void> {
  await db.execute(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, 'default')`,
    ['agent.retire_historical_only', 'cli', plan.agent_id, JSON.stringify(plan)],
  ).catch(() => ({ rowCount: 0 }))
}

export async function executeAgentRetirement(
  db: Queryable,
  input: { agentId: string; reason?: string },
): Promise<AgentRetirementPlan> {
  let executedPlan: AgentRetirementPlan | null = null
  await db.transaction(async (tx) => {
    const plan = await buildAgentRetirementPlan(tx, {
      agentId: input.agentId,
      reason: input.reason,
      dryRun: false,
    })
    await updateByIds(tx, 'channel_connector_bindings', 'channel_binding_id', plan.affected.channel_connector_bindings, "status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    await updateByIds(tx, 'provider_channel_access', 'provider_channel_access_id', plan.affected.provider_channel_access, "status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    await updateByIds(tx, 'agent_ui_bindings', 'binding_id', plan.affected.agent_ui_bindings, "status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    await updateByIds(tx, 'agent_provider_identities', 'provider_identity_id', plan.affected.agent_provider_identities, "status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    await updateByIds(tx, 'connector_credentials', 'credential_id', plan.affected.connector_credentials, "status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    await updateByIds(tx, 'connector_instances', 'connector_instance_id', plan.affected.connector_instances, "status = 'disabled', trust_status = 'disabled', disabled_at = COALESCE(disabled_at, now()), updated_at = now()")
    for (const binding of plan.affected.agent_workspace_bindings) {
      await tx.execute(
        `UPDATE agent_workspace_bindings
            SET active = false,
                updated_at = now()
          WHERE agent_id = $1
            AND workspace_id = $2
            AND binding_role = $3`,
        [binding.agent_id, binding.workspace_id, binding.binding_role],
      )
    }
    await updateByIds(tx, 'agent_runtime_instances', 'runtime_instance_id', plan.affected.agent_runtime_instances, "status = 'stopped', stopped_at = COALESCE(stopped_at, now()), last_seen_at = COALESCE(last_seen_at, now())")
    for (const membership of plan.affected.channel_memberships) {
      await tx.execute(
        tx.dialect === 'sqlite'
          ? `UPDATE channels
                SET members = $1
              WHERE id = $2`
          : `UPDATE channels
                SET members = $1,
                    updated_at = now()
              WHERE id = $2`,
        [
          tx.dialect === 'sqlite' ? JSON.stringify(membership.after_members) : membership.after_members,
          membership.channel_id,
        ],
      )
    }
    await upsertTombstone(tx, plan.agent_id, plan.reason)
    await writeRetirementAudit(tx, plan)
    executedPlan = plan
  })
  return executedPlan ?? await buildAgentRetirementPlan(db, {
    agentId: input.agentId,
    reason: input.reason,
    dryRun: false,
  })
}
