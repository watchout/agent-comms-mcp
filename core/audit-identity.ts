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

export type CanonicalAuditRoute = {
  active_function: string
  canonical_seat: string
  agent_id: string
  route_kind: 'evidence_audit_gate' | 'scenario_verification_gate'
  legacy_input: {
    role?: string | null
    label?: string | null
    agent_id?: string | null
  }
  historical_input: boolean
}

export type CanonicalAuditRouteInput = {
  role?: string | null
  label?: string | null
  agentId?: string | null
  activeFunction?: string | null
  canonicalSeat?: string | null
}

export type AuditRouteBlockCode = Extract<AuditSeatRouteResult, { ok: false }>['code']

export type CanonicalAuditRouteResolveResult =
  | { ok: true; route: CanonicalAuditRoute }
  | {
      ok: false
      code: AuditRouteBlockCode
      detail: string
      active_function: string | null
      canonical_seat: string | null
      requested_agent_id: string | null
    }

export type AgentRetirementReadPhase =
  | 'agent_exists'
  | 'connector_instances'
  | 'channel_connector_bindings'
  | 'connector_credentials'
  | 'agent_provider_identities'
  | 'provider_channel_access'
  | 'agent_ui_bindings'
  | 'agent_workspace_bindings'
  | 'agent_runtime_instances'
  | 'channel_memberships'
  | 'role_routing'
  | 'channel_routing_policies'

export type AgentRetirementAffected = {
  connector_instances: string[]
  channel_connector_bindings: string[]
  connector_credentials: string[]
  agent_provider_identities: string[]
  provider_channel_access: string[]
  agent_ui_bindings: string[]
  agent_workspace_bindings: Array<{ agent_id: string; workspace_id: string; binding_role: string }>
  agent_runtime_instances: string[]
  channel_memberships: Array<{ channel_id: string; before_members: string[]; after_members: string[] }>
  role_routing: Array<{
    role_key: string
    before_agent_id: string
    after_agent_id: string
    before_historical_only: boolean
    before_new_work_allowed: boolean
    after_historical_only: true
    after_new_work_allowed: false
    active_function: string | null
    canonical_seat: string | null
  }>
  channel_routing_policies: Array<{
    channel_id: string
    before_primary_agent_id: string | null
    after_primary_agent_id: string | null
    before_adapter_owner_agent_id: string | null
    after_adapter_owner_agent_id: string | null
    before_outbound_allowlist: string[]
    after_outbound_allowlist: string[]
    before_native_role_outbound_owners: Record<string, unknown>
    after_native_role_outbound_owners: Record<string, unknown>
    before_native_projection_identities: Record<string, unknown>
    after_native_projection_identities: Record<string, unknown>
  }>
}

export type AgentRetirementTombstone = {
  status: 'disabled'
  historical_only: true
  new_work_allowed: false
  profile_enabled: false
  non_routable: true
}

export type AgentRetirementPlan =
  | {
      ok: true
      dry_run: boolean
      agent_id: string
      reason: string
      agent_exists: boolean
      final_tombstone: AgentRetirementTombstone
      affected: AgentRetirementAffected
    }
  | {
      ok: false
      dry_run: boolean
      agent_id: string
      reason: string
      blocker: {
        code: 'RETIREMENT_PREFLIGHT_READ_FAILED'
        phase: AgentRetirementReadPhase
        surface: string
        detail: string
      }
      affected: AgentRetirementAffected
    }

export type AuditRouteReconciliationPlan =
  | {
      ok: true
      dry_run: boolean
      reason: string
      canonical_routes: Array<{
        role_key: 'evidence_audit_gate' | 'scenario_verification_gate'
        before: RoleRouteSnapshot | null
        after: RoleRouteSnapshot
        action: 'create' | 'activate' | 'noop'
      }>
      legacy_routes: Array<{
        role_key: string
        before: RoleRouteSnapshot
        after: RoleRouteSnapshot
        reason: 'ambiguous_legacy_audit_key'
      }>
    }
  | {
      ok: false
      dry_run: boolean
      reason: string
      blocker: {
        code: 'ROLE_ROUTING_READ_FAILED'
        phase: 'canonical_routes' | 'legacy_routes'
        detail: string
      }
      canonical_routes: []
      legacy_routes: []
    }

export type RoleRouteSnapshot = {
  role_key: string
  agent_id: string | null
  active_function: string | null
  canonical_seat: string | null
  historical_only: boolean
  new_work_allowed: boolean
  description: string | null
}

type Queryable = Pick<DbAdapter, 'query' | 'execute' | 'transaction' | 'dialect'>

const CANONICAL_AUDIT_ROLE_ROUTES: Array<{
  role_key: 'evidence_audit_gate' | 'scenario_verification_gate'
  agent_id: string
  active_function: string
  canonical_seat: string
  description: string
}> = [
  {
    role_key: 'evidence_audit_gate',
    agent_id: 'codex-audit',
    active_function: 'evidence_audit_gate',
    canonical_seat: 'codex-audit',
    description: 'Canonical Shirube V3 evidence audit gate; no l2auditor or devauditor fallback.',
  },
  {
    role_key: 'scenario_verification_gate',
    agent_id: 'devauditor',
    active_function: 'scenario_verification_gate',
    canonical_seat: 'devauditor',
    description: 'Scenario verification gate for failure/recovery reproduction only.',
  },
]

const AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS = [
  'audit',
  'contract_audit_viewpoint',
  'pr_audit_l1',
  'pr_audit_l2',
  'primary_audit',
  'secondary_audit',
]

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

function normalizeRouteToken(raw: unknown): string | null {
  const value = normalize(raw)?.toLowerCase().replace(/_/g, '-')
  if (!value) return null
  if (value.startsWith('needs:')) return value.slice('needs:'.length)
  if (value.startsWith('role:')) return value.slice('role:'.length)
  if (value.startsWith('owner:')) return value.slice('owner:'.length)
  return value
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

function configuredEvidenceRoute(config: AgentRoleRoutingConfig): {
  activeFunction: string
  canonicalSeat: string
  agentId: string
} {
  const evidence = config.auditRouting?.evidenceAuditGate ?? {}
  return {
    activeFunction: evidence.activeFunction ?? 'evidence_audit_gate',
    canonicalSeat: evidence.canonicalSeat ?? 'codex-audit',
    agentId: evidence.agentId ?? evidence.canonicalSeat ?? 'codex-audit',
  }
}

function configuredScenarioRoute(config: AgentRoleRoutingConfig): {
  activeFunction: string
  canonicalSeat: string
  agentId: string
} {
  const scenario = config.auditRouting?.scenarioVerificationGate ?? {}
  return {
    activeFunction: scenario.activeFunction ?? 'scenario_verification_gate',
    canonicalSeat: scenario.canonicalSeat ?? 'devauditor',
    agentId: scenario.agentId ?? scenario.canonicalSeat ?? 'devauditor',
  }
}

function canonicalRouteFromSeatResult(
  input: CanonicalAuditRouteInput,
  agentId: string | null,
  result: Extract<AuditSeatRouteResult, { ok: true }>,
  routeKind: CanonicalAuditRoute['route_kind'],
  historicalInput = false,
): CanonicalAuditRoute {
  return {
    active_function: result.active_function,
    canonical_seat: result.canonical_seat,
    agent_id: result.agent_id,
    route_kind: routeKind,
    legacy_input: {
      role: input.role ?? null,
      label: input.label ?? null,
      agent_id: agentId,
    },
    historical_input: historicalInput,
  }
}

function canonicalRouteError(result: Extract<AuditSeatRouteResult, { ok: false }>): CanonicalAuditRouteResolveResult {
  return {
    ok: false,
    code: result.code,
    detail: result.detail,
    active_function: result.active_function,
    canonical_seat: result.canonical_seat,
    requested_agent_id: result.requested_agent_id,
  }
}

export function resolveCanonicalAuditRouteForInputStrict(
  input: CanonicalAuditRouteInput,
  config = loadAgentRoleRoutingConfig(),
): CanonicalAuditRouteResolveResult | null {
  const role = normalizeRouteToken(input.role)
  const label = normalizeRouteToken(input.label)
  const agentId = normalize(input.agentId)
  const agentToken = normalizeRouteToken(agentId)
  const activeFunction = normalize(input.activeFunction)
  const canonicalSeat = normalize(input.canonicalSeat)

  const evidence = configuredEvidenceRoute(config)
  const scenario = configuredScenarioRoute(config)
  if (activeFunction === evidence.activeFunction) {
    const resolved = resolveAuditSeatRoute({
      active_function: activeFunction,
      canonical_seat: canonicalSeat,
      requested_agent_id: agentId,
    }, config)
    return resolved.ok
      ? {
          ok: true,
          route: canonicalRouteFromSeatResult(input, agentId, resolved, 'evidence_audit_gate', Boolean(
            role === 'l1-audit' ||
            role === 'l2-audit' ||
            agentToken === 'l1auditor' ||
            agentToken === 'l2auditor' ||
            agentToken === 'auditor',
          )),
        }
      : canonicalRouteError(resolved)
  }
  if (activeFunction === scenario.activeFunction) {
    const resolved = resolveAuditSeatRoute({
      active_function: activeFunction,
      canonical_seat: canonicalSeat,
      requested_agent_id: agentId,
    }, config)
    return resolved.ok
      ? {
          ok: true,
          route: canonicalRouteFromSeatResult(input, agentId, resolved, 'scenario_verification_gate'),
        }
      : canonicalRouteError(resolved)
  }
  if (activeFunction) {
    return canonicalRouteError(resolveAuditSeatRoute({
      active_function: activeFunction,
      canonical_seat: canonicalSeat,
      requested_agent_id: agentId,
    }, config) as Extract<AuditSeatRouteResult, { ok: false }>)
  }

  const evidenceTokens = new Set([
    'audit',
    'l1-audit',
    'l2-audit',
    'pr-audit-l1',
    'pr-audit-l2',
    'evidence-audit',
    'evidence-audit-gate',
    evidence.activeFunction.replace(/_/g, '-'),
    evidence.canonicalSeat.toLowerCase(),
    evidence.agentId.toLowerCase(),
    'auditor',
    'l1auditor',
    'l2auditor',
  ])
  const scenarioTokens = new Set([
    'scenario-verification',
    'scenario-verification-gate',
    scenario.activeFunction.replace(/_/g, '-'),
    scenario.canonicalSeat.toLowerCase(),
    scenario.agentId.toLowerCase(),
    'devauditor',
  ])
  const tokens = [role, label, normalizeRouteToken(activeFunction), normalizeRouteToken(canonicalSeat), agentToken]
    .filter((token): token is string => Boolean(token))

  const wantsEvidence = tokens.some((token) => evidenceTokens.has(token))
  const wantsScenario = tokens.some((token) => scenarioTokens.has(token)) && !wantsEvidence
  if (!wantsEvidence && !wantsScenario) return null

  const target = wantsScenario ? scenario : evidence
  const resolved = resolveAuditSeatRoute({
    active_function: target.activeFunction,
    canonical_seat: target.canonicalSeat,
  }, config)
  if (!resolved.ok) return canonicalRouteError(resolved)

  return {
    ok: true,
    route: canonicalRouteFromSeatResult(input, agentId, resolved, wantsScenario ? 'scenario_verification_gate' : 'evidence_audit_gate', Boolean(
      role === 'l1-audit' ||
      role === 'l2-audit' ||
      role === 'pr-audit-l1' ||
      role === 'pr-audit-l2' ||
      agentToken === 'l1auditor' ||
      agentToken === 'l2auditor' ||
      agentToken === 'auditor',
    )),
  }
}

export function resolveCanonicalAuditRouteForInput(
  input: CanonicalAuditRouteInput,
  config = loadAgentRoleRoutingConfig(),
): CanonicalAuditRoute | null {
  const result = resolveCanonicalAuditRouteForInputStrict(input, config)
  return result?.ok ? result.route : null
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

function removeObjectAgentReferences(input: Record<string, unknown>, agentId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === agentId) continue
    if (typeof value === 'string' && value === agentId) continue
    if (Array.isArray(value)) {
      const filtered = value.filter((item) => item !== agentId)
      out[key] = filtered
      continue
    }
    out[key] = value
  }
  return out
}

function roleRouteSnapshot(row: any): RoleRouteSnapshot {
  return {
    role_key: String(row.role_key),
    agent_id: normalize(row.agent_id),
    active_function: normalize(row.active_function),
    canonical_seat: normalize(row.canonical_seat),
    historical_only: normalizeBool(row.historical_only),
    new_work_allowed: normalizeBool(row.new_work_allowed, true),
    description: normalize(row.description),
  }
}

function sameRoleRouteSnapshot(a: RoleRouteSnapshot | null, b: RoleRouteSnapshot): boolean {
  return Boolean(a) &&
    a?.agent_id === b.agent_id &&
    a.active_function === b.active_function &&
    a.canonical_seat === b.canonical_seat &&
    a.historical_only === b.historical_only &&
    a.new_work_allowed === b.new_work_allowed
}

async function queryRoleRouteRows(db: Queryable, whereSql: string, params: unknown[]): Promise<RoleRouteSnapshot[]> {
  const rows = await db.query<any>(
    `SELECT role_key, agent_id, active_function, canonical_seat, historical_only, new_work_allowed, description
       FROM role_routing
      ${whereSql}
      ORDER BY role_key`,
    params,
  )
  return rows.map(roleRouteSnapshot)
}

function auditRouteReconciliationReadBlocker(
  input: { reason?: string; dryRun?: boolean },
  phase: 'canonical_routes' | 'legacy_routes',
  err: unknown,
): AuditRouteReconciliationPlan {
  return {
    ok: false,
    dry_run: input.dryRun !== false,
    reason: input.reason?.trim() || 'audit route canonicalization',
    blocker: {
      code: 'ROLE_ROUTING_READ_FAILED',
      phase,
      detail: err instanceof Error ? err.message : String(err),
    },
    canonical_routes: [],
    legacy_routes: [],
  }
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function finalRetirementTombstone(): AgentRetirementTombstone {
  return {
    status: 'disabled',
    historical_only: true,
    new_work_allowed: false,
    profile_enabled: false,
    non_routable: true,
  }
}

function emptyRetirementAffected(): AgentRetirementAffected {
  return {
    connector_instances: [],
    channel_connector_bindings: [],
    connector_credentials: [],
    agent_provider_identities: [],
    provider_channel_access: [],
    agent_ui_bindings: [],
    agent_workspace_bindings: [],
    agent_runtime_instances: [],
    channel_memberships: [],
    role_routing: [],
    channel_routing_policies: [],
  }
}

class AgentRetirementPreflightReadError extends Error {
  readonly phase: AgentRetirementReadPhase
  readonly surface: string
  readonly detail: string

  constructor(phase: AgentRetirementReadPhase, surface: string, err: unknown) {
    const detail = errorDetail(err)
    super(`RETIREMENT_PREFLIGHT_READ_FAILED:${phase}:${surface}:${detail}`)
    this.name = 'AgentRetirementPreflightReadError'
    this.phase = phase
    this.surface = surface
    this.detail = detail
  }
}

async function requiredRetirementRead<T>(
  phase: AgentRetirementReadPhase,
  surface: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read()
  } catch (err) {
    throw new AgentRetirementPreflightReadError(phase, surface, err)
  }
}

function agentRetirementReadBlocker(
  input: { agentId: string; reason?: string; dryRun?: boolean },
  err: AgentRetirementPreflightReadError,
): AgentRetirementPlan {
  return {
    ok: false,
    dry_run: input.dryRun !== false,
    agent_id: input.agentId.trim(),
    reason: input.reason?.trim() || 'historical-only identity canonicalization',
    blocker: {
      code: 'RETIREMENT_PREFLIGHT_READ_FAILED',
      phase: err.phase,
      surface: err.surface,
      detail: err.detail,
    },
    affected: emptyRetirementAffected(),
  }
}

export async function buildAuditRouteReconciliationPlan(
  db: Queryable,
  input: { reason?: string; dryRun?: boolean } = {},
): Promise<AuditRouteReconciliationPlan> {
  const reason = input.reason?.trim() || 'audit route canonicalization'
  let canonicalRows: RoleRouteSnapshot[]
  try {
    canonicalRows = await queryRoleRouteRows(
      db,
      `WHERE role_key IN ($1, $2)`,
      ['evidence_audit_gate', 'scenario_verification_gate'],
    )
  } catch (err) {
    return auditRouteReconciliationReadBlocker({ ...input, reason }, 'canonical_routes', err)
  }
  const canonicalByKey = new Map(canonicalRows.map((row) => [row.role_key, row]))
  const canonicalRoutes: AuditRouteReconciliationPlan['canonical_routes'] = CANONICAL_AUDIT_ROLE_ROUTES.map((route) => {
    const before = canonicalByKey.get(route.role_key) ?? null
    const after: RoleRouteSnapshot = {
      role_key: route.role_key,
      agent_id: route.agent_id,
      active_function: route.active_function,
      canonical_seat: route.canonical_seat,
      historical_only: false,
      new_work_allowed: true,
      description: route.description,
    }
    return {
      role_key: route.role_key,
      before,
      after,
      action: before === null ? 'create' : sameRoleRouteSnapshot(before, after) ? 'noop' : 'activate',
    }
  })

  let legacyRows: RoleRouteSnapshot[]
  try {
    legacyRows = await queryRoleRouteRows(
      db,
      `WHERE role_key NOT IN ($1, $2)
         AND (
           lower(role_key) IN (${AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS.map((_, idx) => `$${idx + 3}`).join(', ')})
           OR (agent_id = $${AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS.length + 3} AND lower(role_key) LIKE '%audit%')
           OR (active_function = $${AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS.length + 4} AND agent_id <> $${AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS.length + 5})
         )`,
      [
        'evidence_audit_gate',
        'scenario_verification_gate',
        ...AMBIGUOUS_LEGACY_AUDIT_ROLE_KEYS,
        'devauditor',
        'evidence_audit_gate',
        'codex-audit',
      ],
    )
  } catch (err) {
    return auditRouteReconciliationReadBlocker({ ...input, reason }, 'legacy_routes', err)
  }
  const legacyRoutes = legacyRows
    .filter((row) => row.historical_only !== true || row.new_work_allowed !== false)
    .map((before) => ({
      role_key: before.role_key,
      before,
      after: {
        ...before,
        historical_only: true,
        new_work_allowed: false,
      },
      reason: 'ambiguous_legacy_audit_key' as const,
    }))

  return {
    ok: true,
    dry_run: input.dryRun !== false,
    reason,
    canonical_routes: canonicalRoutes,
    legacy_routes: legacyRoutes,
  }
}

async function queryIds(db: Queryable, sql: string, params: unknown[], idColumn: string): Promise<string[]> {
  const rows = await db.query<Record<string, unknown>>(sql, params)
  return rows.map((row) => String(row[idColumn])).filter(Boolean)
}

async function queryWorkspaceBindings(db: Queryable, agentId: string): Promise<AgentRetirementAffected['agent_workspace_bindings']> {
  const rows = await db.query<any>(
    `SELECT agent_id, workspace_id, binding_role
       FROM agent_workspace_bindings
      WHERE agent_id = $1
        AND active = true
      ORDER BY workspace_id, binding_role`,
    [agentId],
  )
  return rows.map((row) => ({
    agent_id: String(row.agent_id),
    workspace_id: String(row.workspace_id),
    binding_role: String(row.binding_role),
  }))
}

async function queryChannelMemberships(db: Queryable, agentId: string): Promise<AgentRetirementAffected['channel_memberships']> {
  const rows = await db.query<any>(
    `SELECT id, members
       FROM channels
      ORDER BY id`,
  )
  const memberships: AgentRetirementAffected['channel_memberships'] = []
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

async function queryRoleRouting(
  db: Queryable,
  agentId: string,
  config: AgentRoleRoutingConfig,
): Promise<AgentRetirementAffected['role_routing']> {
  const canonicalAgentId = config.legacyAgentIds?.[agentId]?.canonicalAgentId ?? agentId
  const rows = await db.query<any>(
    `SELECT role_key, agent_id, active_function, canonical_seat, historical_only, new_work_allowed
       FROM role_routing
      WHERE agent_id = $1
         OR (COALESCE(historical_only, false) = false AND role_key IN (
              SELECT role_key
                FROM role_routing
               WHERE agent_id = $1
            ))
      ORDER BY role_key`,
    [agentId],
  )
  return rows
    .filter((row) => String(row.agent_id) === agentId)
    .map((row) => ({
      role_key: String(row.role_key),
      before_agent_id: String(row.agent_id),
      after_agent_id: canonicalAgentId,
      before_historical_only: normalizeBool(row.historical_only),
      before_new_work_allowed: normalizeBool(row.new_work_allowed, true),
      after_historical_only: true as const,
      after_new_work_allowed: false as const,
      active_function: normalize(row.active_function),
      canonical_seat: normalize(row.canonical_seat),
    }))
}

async function queryChannelRoutingPolicies(
  db: Queryable,
  agentId: string,
): Promise<AgentRetirementAffected['channel_routing_policies']> {
  const rows = await db.query<any>(
    `SELECT channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist,
            native_role_outbound_owners, native_projection_identities
       FROM channel_routing_policy
      ORDER BY channel_id`,
  )
  const affected: AgentRetirementAffected['channel_routing_policies'] = []
  for (const row of rows) {
    const beforeOutbound = parseMembers(row.outbound_allowlist)
    const beforeOwners = parseJsonObject(row.native_role_outbound_owners)
    const beforeIdentities = parseJsonObject(row.native_projection_identities)
    const beforePrimary = normalize(row.primary_agent_id)
    const beforeAdapter = normalize(row.adapter_owner_agent_id)
    const mentioned = beforePrimary === agentId ||
      beforeAdapter === agentId ||
      beforeOutbound.includes(agentId) ||
      Object.keys(beforeOwners).includes(agentId) ||
      Object.values(beforeOwners).includes(agentId) ||
      Object.keys(beforeIdentities).includes(agentId) ||
      Object.values(beforeIdentities).includes(agentId)
    if (!mentioned) continue
    affected.push({
      channel_id: String(row.channel_id),
      before_primary_agent_id: beforePrimary,
      after_primary_agent_id: beforePrimary === agentId ? null : beforePrimary,
      before_adapter_owner_agent_id: beforeAdapter,
      after_adapter_owner_agent_id: beforeAdapter === agentId ? null : beforeAdapter,
      before_outbound_allowlist: beforeOutbound,
      after_outbound_allowlist: beforeOutbound.filter((member) => member !== agentId),
      before_native_role_outbound_owners: beforeOwners,
      after_native_role_outbound_owners: removeObjectAgentReferences(beforeOwners, agentId),
      before_native_projection_identities: beforeIdentities,
      after_native_projection_identities: removeObjectAgentReferences(beforeIdentities, agentId),
    })
  }
  return affected
}

export async function buildAgentRetirementPlan(
  db: Queryable,
  input: { agentId: string; reason?: string; dryRun?: boolean },
): Promise<AgentRetirementPlan> {
  const agentId = input.agentId.trim()
  const config = loadAgentRoleRoutingConfig()
  const reason = input.reason?.trim() || 'historical-only identity canonicalization'
  let rows: any[]
  let affected: AgentRetirementAffected
  try {
    rows = await requiredRetirementRead('agent_exists', 'agents', () => db.query<any>(
      `SELECT agent_id
         FROM agents
        WHERE agent_id = $1
        LIMIT 1`,
      [agentId],
    ))
    affected = {
      connector_instances: await requiredRetirementRead('connector_instances', 'connector_instances', () => queryIds(
        db,
        `SELECT connector_instance_id
           FROM connector_instances
          WHERE agent_id = $1
            AND status IN ('registered', 'active', 'standby', 'draining')
          ORDER BY connector_instance_id`,
        [agentId],
        'connector_instance_id',
      )),
      channel_connector_bindings: await requiredRetirementRead('channel_connector_bindings', 'channel_connector_bindings', () => queryIds(
        db,
        `SELECT b.channel_binding_id
           FROM channel_connector_bindings b
           JOIN connector_instances ci ON ci.connector_instance_id = b.connector_instance_id
          WHERE ci.agent_id = $1
            AND b.status IN ('active', 'standby')
          ORDER BY b.channel_binding_id`,
        [agentId],
        'channel_binding_id',
      )),
      connector_credentials: await requiredRetirementRead('connector_credentials', 'connector_credentials', () => queryIds(
        db,
        `SELECT credential_id
           FROM connector_credentials
          WHERE agent_id = $1
            AND status IN ('registered', 'active')
          ORDER BY credential_id`,
        [agentId],
        'credential_id',
      )),
      agent_provider_identities: await requiredRetirementRead('agent_provider_identities', 'agent_provider_identities', () => queryIds(
        db,
        `SELECT provider_identity_id
           FROM agent_provider_identities
          WHERE agent_id = $1
            AND status IN ('expected', 'verified')
          ORDER BY provider_identity_id`,
        [agentId],
        'provider_identity_id',
      )),
      provider_channel_access: await requiredRetirementRead('provider_channel_access', 'provider_channel_access', () => queryIds(
        db,
        `SELECT pca.provider_channel_access_id
           FROM provider_channel_access pca
          LEFT JOIN connector_instances ci
            ON ci.connector_instance_id = pca.connector_instance_id
          WHERE (pca.agent_id = $1 OR (pca.agent_id IS NULL AND ci.agent_id = $1))
            AND pca.status = 'active'
          ORDER BY pca.provider_channel_access_id`,
        [agentId],
        'provider_channel_access_id',
      )),
      agent_ui_bindings: await requiredRetirementRead('agent_ui_bindings', 'agent_ui_bindings', () => queryIds(
        db,
        `SELECT binding_id
           FROM agent_ui_bindings
          WHERE agent_id = $1
            AND status IN ('registered', 'active')
          ORDER BY binding_id`,
        [agentId],
        'binding_id',
      )),
      agent_workspace_bindings: await requiredRetirementRead('agent_workspace_bindings', 'agent_workspace_bindings', () => queryWorkspaceBindings(db, agentId)),
      agent_runtime_instances: await requiredRetirementRead('agent_runtime_instances', 'agent_runtime_instances', () => queryIds(
        db,
        `SELECT runtime_instance_id
           FROM agent_runtime_instances
          WHERE agent_id = $1
            AND status IN ('running', 'active', 'unknown')
          ORDER BY started_at DESC`,
        [agentId],
        'runtime_instance_id',
      )),
      channel_memberships: await requiredRetirementRead('channel_memberships', 'channels', () => queryChannelMemberships(db, agentId)),
      role_routing: await requiredRetirementRead('role_routing', 'role_routing', () => queryRoleRouting(db, agentId, config)),
      channel_routing_policies: await requiredRetirementRead('channel_routing_policies', 'channel_routing_policy', () => queryChannelRoutingPolicies(db, agentId)),
    }
  } catch (err) {
    if (err instanceof AgentRetirementPreflightReadError) {
      return agentRetirementReadBlocker(input, err)
    }
    throw err
  }
  return {
    ok: true,
    dry_run: input.dryRun !== false,
    agent_id: agentId,
    reason,
    agent_exists: rows.length > 0,
    final_tombstone: finalRetirementTombstone(),
    affected,
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

async function upsertRoleRoute(db: Queryable, route: RoleRouteSnapshot): Promise<void> {
  const existing = await db.query<{ role_key: string }>(
    `SELECT role_key FROM role_routing WHERE role_key = $1 LIMIT 1`,
    [route.role_key],
  )
  if (existing.length === 0) {
    await db.execute(
      `INSERT INTO role_routing (
         role_key, agent_id, description, new_work_allowed,
         active_function, canonical_seat, historical_only, policy_source
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'audit_route_reconciliation')`,
      [
        route.role_key,
        route.agent_id,
        route.description,
        route.new_work_allowed,
        route.active_function,
        route.canonical_seat,
        route.historical_only,
      ],
    )
    return
  }
  await db.execute(
    `UPDATE role_routing
        SET agent_id = $2,
            description = COALESCE($3, description),
            new_work_allowed = $4,
            active_function = $5,
            canonical_seat = $6,
            historical_only = $7,
            policy_source = 'audit_route_reconciliation',
            updated_at = now()
      WHERE role_key = $1`,
    [
      route.role_key,
      route.agent_id,
      route.description,
      route.new_work_allowed,
      route.active_function,
      route.canonical_seat,
      route.historical_only,
    ],
  )
}

async function writeAuditRouteReconciliationAudit(db: Queryable, plan: AuditRouteReconciliationPlan): Promise<void> {
  await db.execute(
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ($1, $2, $3, $4, 'default')`,
    ['audit_route.reconcile', 'cli', 'role_routing', JSON.stringify(plan)],
  ).catch(() => ({ rowCount: 0 }))
}

export async function executeAuditRouteReconciliation(
  db: Queryable,
  input: { reason?: string } = {},
): Promise<AuditRouteReconciliationPlan> {
  let executedPlan: AuditRouteReconciliationPlan | null = null
  await db.transaction(async (tx) => {
    const plan = await buildAuditRouteReconciliationPlan(tx, {
      reason: input.reason,
      dryRun: false,
    })
    if (!plan.ok) {
      throw new Error(`${plan.blocker.code}:${plan.blocker.phase}:${plan.blocker.detail}`)
    }
    for (const route of plan.canonical_routes) {
      if (route.action === 'noop') continue
      await upsertRoleRoute(tx, route.after)
    }
    for (const route of plan.legacy_routes) {
      await tx.execute(
        `UPDATE role_routing
            SET historical_only = true,
                new_work_allowed = false,
                policy_source = 'audit_route_reconciliation',
                updated_at = now()
          WHERE role_key = $1`,
        [route.role_key],
      )
    }
    await writeAuditRouteReconciliationAudit(tx, plan)
    executedPlan = plan
  })
  return executedPlan ?? await buildAuditRouteReconciliationPlan(db, {
    reason: input.reason,
    dryRun: false,
  })
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
    if (!plan.ok) {
      throw new Error(`${plan.blocker.code}:${plan.blocker.phase}:${plan.blocker.surface}:${plan.blocker.detail}`)
    }
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
    for (const role of plan.affected.role_routing) {
      await tx.execute(
        `UPDATE role_routing
            SET agent_id = $2,
                active_function = COALESCE(active_function, $3),
                canonical_seat = COALESCE(canonical_seat, $4),
                historical_only = true,
                new_work_allowed = false,
                updated_at = now()
          WHERE role_key = $1`,
        [
          role.role_key,
          role.after_agent_id,
          role.active_function ?? (role.after_agent_id === 'codex-audit' ? 'evidence_audit_gate' : null),
          role.canonical_seat ?? role.after_agent_id,
        ],
      )
    }
    for (const policy of plan.affected.channel_routing_policies) {
      if (tx.dialect === 'sqlite') {
        await tx.execute(
          `UPDATE channel_routing_policy
              SET primary_agent_id = $2,
                  adapter_owner_agent_id = $3,
                  outbound_allowlist = $4,
                  native_role_outbound_owners = $5,
                  native_projection_identities = $6,
                  updated_at = now()
            WHERE channel_id = $1`,
          [
            policy.channel_id,
            policy.after_primary_agent_id,
            policy.after_adapter_owner_agent_id,
            JSON.stringify(policy.after_outbound_allowlist),
            JSON.stringify(policy.after_native_role_outbound_owners),
            JSON.stringify(policy.after_native_projection_identities),
          ],
        )
      } else {
        await tx.execute(
          `UPDATE channel_routing_policy
              SET primary_agent_id = $2,
                  adapter_owner_agent_id = $3,
                  outbound_allowlist = $4,
                  native_role_outbound_owners = $5::jsonb,
                  native_projection_identities = $6::jsonb,
                  updated_at = now()
            WHERE channel_id = $1`,
          [
            policy.channel_id,
            policy.after_primary_agent_id,
            policy.after_adapter_owner_agent_id,
            policy.after_outbound_allowlist,
            JSON.stringify(policy.after_native_role_outbound_owners),
            JSON.stringify(policy.after_native_projection_identities),
          ],
        )
      }
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
