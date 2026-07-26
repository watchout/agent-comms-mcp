import type { DbAdapter } from './db'
import {
  ALL_AGENT_COMMUNICATION_ACTIVE_FUNCTIONS,
  allAgentCommunicationTargetSha256,
  canonicalAllAgentCommunicationTargets,
  type AllAgentCommunicationActiveFunction,
  type AllAgentCommunicationDiscordMode,
  type AllAgentCommunicationManifestTargetV1,
} from './all-agent-communication-manifest'
import {
  evaluateFleetCheckoutDrift,
  fullGitShaEquals,
  normalizeApprovedCheckoutRoots,
  type FleetCheckoutDriftResult,
} from './fleet-checkout-drift'

export type BootstrapRuntimeKind = 'codex' | 'claude'

export type BootstrapRuntimeSignal = {
  source: 'agent_profile' | 'process_identity'
  runtime: BootstrapRuntimeKind
  verified: boolean
  evidence: string
}

export type BootstrapRuntimeSelection = {
  ok: boolean
  runtime: BootstrapRuntimeKind | null
  reason: 'selected' | 'NO_GO_RUNTIME_UNDETECTED' | 'NO_GO_RUNTIME_AMBIGUOUS'
  signals: BootstrapRuntimeSignal[]
}

/**
 * Selects a bootstrap provider from identity evidence, never from a mere
 * `--version` result. An existing profile is accepted only when a matching
 * live process identity is also present. With no profile, one verified live
 * process identity is sufficient. Conflicts are always fail-closed.
 */
export function selectBootstrapRuntime(
  requested: 'auto' | BootstrapRuntimeKind,
  signals: BootstrapRuntimeSignal[],
): BootstrapRuntimeSelection {
  const verified = signals.filter((signal) => signal.verified)
  if (requested !== 'auto') {
    const conflicting = verified.filter((signal) => signal.runtime !== requested)
    if (conflicting.length > 0) {
      return { ok: false, runtime: null, reason: 'NO_GO_RUNTIME_AMBIGUOUS', signals }
    }
    return { ok: true, runtime: requested, reason: 'selected', signals }
  }

  const profiles = verified.filter((signal) => signal.source === 'agent_profile')
  const processes = verified.filter((signal) => signal.source === 'process_identity')
  const runtimes = new Set(verified.map((signal) => signal.runtime))
  if (runtimes.size > 1 || profiles.length > 1 || processes.length > 1) {
    return { ok: false, runtime: null, reason: 'NO_GO_RUNTIME_AMBIGUOUS', signals }
  }
  if (processes.length === 0) {
    return { ok: false, runtime: null, reason: 'NO_GO_RUNTIME_UNDETECTED', signals }
  }
  if (profiles.length === 1 && profiles[0].runtime !== processes[0].runtime) {
    return { ok: false, runtime: null, reason: 'NO_GO_RUNTIME_AMBIGUOUS', signals }
  }
  return { ok: true, runtime: processes[0].runtime, reason: 'selected', signals }
}
import type { V2NativeMeshFrozenAgentV1 } from './eventlog/v2-native-ingress'

type RuntimeFreshness = 'fresh' | 'stale' | 'missing_heartbeat' | 'stopped' | 'unknown'

type RuntimeInventoryOptions = {
  staleMinutes?: number
  expectedCommit?: string | null
  approvedCheckoutRoots?: string[] | null
  provider?: string
  bindingRole?: string
}

export type RuntimeInventoryAgent = {
  agent_id: string
  agent_status: string
  declared_runtime: string
  runtime_instance_count: number
  latest_runtime_instance_id: string | null
  runtime_status: string | null
  runtime_engine: string | null
  runtime_kind: string | null
  session_name: string | null
  process_id: number | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  checkout_drift: FleetCheckoutDriftResult
  last_seen_at: string | null
  freshness: RuntimeFreshness
  warnings: string[]
}

export type RuntimeInventoryConnector = {
  connector_instance_id: string
  agent_id: string
  provider: string
  connector_uri: string | null
  status: string
  trust_status: string
  runtime_instance_id: string | null
  runtime_freshness: RuntimeFreshness
  active_binding_count: number
  last_seen_at: string | null
  warnings: string[]
}

export type RuntimeInventoryBinding = {
  channel_binding_id: string
  channel_id: string
  channel_name: string | null
  provider: string
  binding_role: string
  status: string
  connector_instance_id: string | null
  connector_agent_id: string | null
  adapter_owner_agent_id: string | null
  warnings: string[]
}

export type RuntimeInventoryPolicyGap = {
  channel_id: string
  channel_name: string | null
  adapter_owner_agent_id: string
  provider: string
  binding_role: string
  reason: 'missing_active_binding' | 'active_binding_wrong_owner'
  active_binding_agents: string[]
}

export type RuntimeInventoryReport = {
  ok: true
  generated_at: string
  policy: {
    db_is_source_of_truth: true
    runtime_identity: string
    final_design_guardrail: string
  }
  options: {
    stale_minutes: number
    expected_commit: string | null
    approved_checkout_roots: string[]
    provider: string
    binding_role: string
  }
  summary: {
    agents: number
    runtime_instances: number
    fresh_runtimes: number
    stale_runtimes: number
    connectors: number
    active_connectors: number
    active_bindings: number
    policy_gaps: number
    blockers: number
  }
  agents: RuntimeInventoryAgent[]
  connectors: RuntimeInventoryConnector[]
  bindings: RuntimeInventoryBinding[]
  policy_gaps: RuntimeInventoryPolicyGap[]
  blockers: string[]
  warnings: string[]
}

export interface V2NativeFrozenSetReadOptions {
  nowMs?: number
  maxHeartbeatAgeMs?: number
}

export interface AllAgentCommunicationCandidateOptions {
  nowMs?: number
  maxHeartbeatAgeMs?: number
  controlSourceByAgent: Record<string, string>
  activeFunctionByAgent: Record<string, string>
  communicationAutoReceiveByAgent: Record<string, boolean>
  protectedD1ByAgent: Record<string, boolean>
  discordModeByAgent: Record<string, AllAgentCommunicationDiscordMode>
}

export interface AllAgentCommunicationCandidateReport {
  ok: boolean
  generated_at: string
  expected_agent_ids: string[]
  expected_target_count: number
  resolved_target_count: number
  target_sha256: string | null
  targets: AllAgentCommunicationManifestTargetV1[]
  blockers: string[]
}

function metadataObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Read the canonical production-enabled non-human membership and join each
 * member to exactly one ready runtime. This is read-only and fails the whole
 * freeze on missing, duplicate, stale, or incomplete runtime evidence.
 */
export async function readV2NativeFrozenEnabledSet(
  db: DbAdapter,
  options: V2NativeFrozenSetReadOptions = {},
): Promise<V2NativeMeshFrozenAgentV1[]> {
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxHeartbeatAgeMs ?? 15 * 60_000
  const rows = await db.query<any>(
    `SELECT agent_id, profile_revision, runtime_engine_preference, metadata,
            profile_enabled, disabled_at, agent_type
       FROM agents
      ORDER BY agent_id`,
  )
  const selected = rows.filter(row => {
    const metadata = metadataObject(row.metadata)
    return (row.profile_enabled === true || Number(row.profile_enabled) === 1)
      && row.disabled_at === null
      && String(row.agent_type) !== 'human'
      && String(metadata.profile_class ?? '') !== 'test'
  })
  if (selected.length < 2) throw new Error('V2_NATIVE_FROZEN_SET_BLOCKED: fewer than two production-enabled non-human agents')

  const result: V2NativeMeshFrozenAgentV1[] = []
  for (const agent of selected) {
    const runtimes = await db.query<any>(
      `SELECT runtime_instance_id, runtime_engine, checkout_path, commit_sha,
              status, stopped_at, last_seen_at
         FROM agent_runtime_instances
        WHERE agent_id = $1
        ORDER BY started_at DESC`,
      [agent.agent_id],
    )
    const live = runtimes.filter(runtime => {
      const seen = parseTimestampMs(runtime.last_seen_at)
      return runtime.stopped_at === null
        && ['ready', 'running', 'active', 'online'].includes(String(runtime.status))
        && seen !== null
        && nowMs - seen <= maxAgeMs
    })
    if (live.length !== 1) throw new Error(`V2_NATIVE_FROZEN_SET_BLOCKED: ${agent.agent_id} has ${live.length} selected live runtimes`)
    const runtime = live[0]
    const metadata = metadataObject(agent.metadata)
    const companyDevOs = metadataObject(metadata.companyDevOs)
    const engine = normalizeString(agent.runtime_engine_preference)
      ?? normalizeString(companyDevOs.runtime_engine)
      ?? normalizeString(runtime.runtime_engine)
    const instanceId = normalizeString(runtime.runtime_instance_id)
    const checkoutRoot = normalizeString(runtime.checkout_path)
    const checkoutSha = normalizeString(runtime.commit_sha)
    if (!engine || !instanceId || !checkoutRoot || !checkoutSha || !/^[0-9a-f]{40}$/.test(checkoutSha)) {
      throw new Error(`V2_NATIVE_FROZEN_SET_BLOCKED: ${agent.agent_id} runtime identity is incomplete`)
    }
    result.push({
      agent_id: String(agent.agent_id),
      profile_revision: String(agent.profile_revision),
      runtime_engine: engine,
      runtime_instance_id: instanceId,
      runtime_checkout_root: checkoutRoot,
      runtime_checkout_sha: checkoutSha,
    })
  }
  return result
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function normalizeRepository(raw: unknown): string | null {
  const text = normalizeString(raw)
  if (!text) return null
  const normalized = text
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized : null
}

function manifestRuntimeEngine(raw: unknown): 'codex-exec' | 'claude-exec' | null {
  const value = normalizeString(raw)?.toLowerCase()
  if (!value) return null
  if (value === 'codex' || value === 'codex-exec') return 'codex-exec'
  if (value === 'claude' || value === 'claude-exec' || value === 'claude-code') return 'claude-exec'
  return null
}

function parseMembers(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === 'string')
  if (typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

/**
 * Builds evidence-only candidate rows for the ordinary communication lane.
 * Membership comes from the canonical production registry and every selected
 * agent remains in the denominator even when its evidence is incomplete.
 * `protected_d1` and auto-receive are explicit caller-bound policy inputs;
 * neither is inferred from an agent id or an existing protected allowlist.
 */
export async function generateAllAgentCommunicationManifestCandidates(
  db: DbAdapter,
  options: AllAgentCommunicationCandidateOptions,
): Promise<AllAgentCommunicationCandidateReport> {
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxHeartbeatAgeMs ?? 15 * 60_000
  const agents = (await db.query<any>(
    `SELECT agent_id, agent_type, profile_revision, profile_enabled, disabled_at,
            runtime_engine_preference, metadata
       FROM agents
      ORDER BY agent_id`,
  )).filter(row => {
    const metadata = metadataObject(row.metadata)
    return (row.profile_enabled === true || Number(row.profile_enabled) === 1)
      && row.disabled_at === null
      && String(row.agent_type) === 'dev'
      && String(metadata.profile_class ?? '') !== 'test'
  })
  const expectedAgentIds = agents.map(row => String(row.agent_id)).sort()
  const blockers: string[] = []
  const targets: AllAgentCommunicationManifestTargetV1[] = []

  const gatewayRows = await db.query<any>(
    `SELECT c.members, p.adapter_owner_agent_id
       FROM channels c
       JOIN channel_routing_policy p ON p.channel_id = c.id
      WHERE p.adapter_owner_agent_id = $1`,
    ['aun'],
  )
  const gatewayMembers = new Set(gatewayRows.flatMap(row => parseMembers(row.members)))

  for (const agent of agents) {
    const agentId = String(agent.agent_id)
    const agentBlockers: string[] = []
    const activeFunction = options.activeFunctionByAgent[agentId]
    if (!(ALL_AGENT_COMMUNICATION_ACTIVE_FUNCTIONS as readonly string[]).includes(activeFunction)) {
      agentBlockers.push('active_function_missing_or_unknown')
    }
    const controlSource = normalizeString(options.controlSourceByAgent[agentId])
    if (!controlSource) agentBlockers.push('control_source_missing')
    if (!hasOwn(options.communicationAutoReceiveByAgent, agentId)
      || typeof options.communicationAutoReceiveByAgent[agentId] !== 'boolean') {
      agentBlockers.push('communication_auto_receive_not_explicit')
    }
    if (!hasOwn(options.protectedD1ByAgent, agentId)
      || typeof options.protectedD1ByAgent[agentId] !== 'boolean') {
      agentBlockers.push('protected_d1_not_explicit')
    }
    const discordMode = options.discordModeByAgent[agentId]
    if (discordMode !== 'native_verified' && discordMode !== 'aun_gateway_projection') {
      agentBlockers.push('discord_mode_missing_or_unknown')
    }

    const workspaces = await db.query<any>(
      `SELECT w.workspace_id, w.local_path, w.repo_url
         FROM agent_workspace_bindings b
         JOIN agent_workspaces w ON w.workspace_id = b.workspace_id
        WHERE b.agent_id = $1 AND b.active = true AND b.binding_role = 'primary'
        ORDER BY w.workspace_id`,
      [agentId],
    )
    if (workspaces.length !== 1) agentBlockers.push(`primary_workspace_count_${workspaces.length}`)
    const workspace = workspaces[0]
    const workspacePath = normalizeString(workspace?.local_path)
    const repository = normalizeRepository(workspace?.repo_url)
    if (!workspacePath || !workspacePath.startsWith('/')) agentBlockers.push('workspace_path_missing_or_non_absolute')
    if (!repository) agentBlockers.push('target_repository_missing_or_invalid')

    const runtimes = await db.query<any>(
      `SELECT runtime_instance_id, workspace_id, runtime_engine, status, stopped_at, last_seen_at
         FROM agent_runtime_instances
        WHERE agent_id = $1
        ORDER BY started_at DESC`,
      [agentId],
    )
    const live = runtimes.filter(runtime => {
      const seen = parseTimestampMs(runtime.last_seen_at)
      return runtime.stopped_at === null
        && ['ready', 'running', 'active', 'online'].includes(String(runtime.status))
        && seen !== null
        && nowMs - seen <= maxAgeMs
        && String(runtime.workspace_id ?? '') === String(workspace?.workspace_id ?? '')
    })
    if (live.length !== 1) agentBlockers.push(`selected_runtime_count_${live.length}`)
    if (live.length === 1 && !normalizeString(live[0]?.runtime_instance_id)) {
      agentBlockers.push('runtime_instance_id_missing')
    }
    const profileEngine = manifestRuntimeEngine(agent.runtime_engine_preference)
    const liveEngine = manifestRuntimeEngine(live[0]?.runtime_engine)
    if (!profileEngine) agentBlockers.push('profile_runtime_engine_missing_or_unsupported')
    if (!liveEngine) agentBlockers.push('live_runtime_engine_missing_or_unsupported')
    if (profileEngine && liveEngine && profileEngine !== liveEngine) {
      agentBlockers.push('runtime_engine_profile_mismatch')
    }
    const engine = profileEngine ?? liveEngine
    const profileRevision = Number(agent.profile_revision)
    if (!Number.isSafeInteger(profileRevision) || profileRevision <= 0) agentBlockers.push('profile_revision_missing_or_invalid')

    const identityAgentId = discordMode === 'aun_gateway_projection' ? 'aun' : agentId
    const identities = await db.query<any>(
      `SELECT provider_identity_id
         FROM agent_provider_identities
        WHERE agent_id = $1 AND provider = 'discord'
          AND status = 'verified' AND trust_status = 'verified'
          AND disabled_at IS NULL AND revoked_at IS NULL
        ORDER BY provider_identity_id`,
      [identityAgentId],
    )
    if (identities.length !== 1) agentBlockers.push(`verified_provider_identity_count_${identities.length}`)
    if (discordMode === 'native_verified') {
      const bindings = await db.query<any>(
        `SELECT binding_id
           FROM agent_ui_bindings
          WHERE agent_id = $1 AND ui_type = 'discord'
            AND status = 'active' AND trust_status = 'verified'
            AND disabled_at IS NULL
            AND provider_identity_id = $2
          ORDER BY binding_id`,
        [agentId, identities[0]?.provider_identity_id ?? null],
      )
      if (bindings.length !== 1) agentBlockers.push(`verified_native_ui_binding_count_${bindings.length}`)
    } else if (discordMode === 'aun_gateway_projection' && !gatewayMembers.has(agentId)) {
      agentBlockers.push('aun_gateway_projection_missing')
    }

    if (agentBlockers.length > 0) {
      blockers.push(...agentBlockers.map(blocker => `${agentId}:${blocker}`))
      continue
    }
    targets.push({
      agent_id: agentId,
      target_repository: repository!,
      control_source: controlSource!,
      active_function: activeFunction as AllAgentCommunicationActiveFunction,
      workspace_id: String(workspace.workspace_id),
      workspace_path: workspacePath!,
      runtime_engine: engine!,
      runtime_profile_ref: `agent-profile://${agentId}/revision/${profileRevision}`,
      provider_identity_ref: `discord-identity://${identityAgentId}/${identities[0].provider_identity_id}`,
      communication_auto_receive: options.communicationAutoReceiveByAgent[agentId],
      protected_d1: options.protectedD1ByAgent[agentId],
      discord_mode: discordMode,
    })
  }
  const canonicalTargets = canonicalAllAgentCommunicationTargets(targets)
  const ok = blockers.length === 0 && canonicalTargets.length === expectedAgentIds.length && expectedAgentIds.length > 0
  return {
    ok,
    generated_at: new Date(nowMs).toISOString(),
    expected_agent_ids: expectedAgentIds,
    expected_target_count: expectedAgentIds.length,
    resolved_target_count: canonicalTargets.length,
    target_sha256: ok ? allAgentCommunicationTargetSha256(canonicalTargets) : null,
    targets: canonicalTargets,
    blockers: blockers.sort(),
  }
}

function parseTimestampMs(raw: unknown): number | null {
  if (!raw) return null
  if (raw instanceof Date) {
    const ms = raw.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const text = String(raw)
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? text.replace(' ', 'T')
    : text
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function timestampString(raw: unknown): string | null {
  if (!raw) return null
  if (raw instanceof Date) return raw.toISOString()
  return String(raw)
}

function normalizeString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw)
  return value.length > 0 ? value : null
}

function isStoppedStatus(status: string | null): boolean {
  return ['stopped', 'disabled', 'offline', 'disconnected', 'failed'].includes(status ?? '')
}

function classifyRuntime(row: any | null, nowMs: number, staleMs: number): RuntimeFreshness {
  if (!row) return 'unknown'
  const status = normalizeString(row.status)
  if (isStoppedStatus(status) || row.stopped_at) return 'stopped'
  const lastSeen = parseTimestampMs(row.last_seen_at)
  if (lastSeen === null) return 'missing_heartbeat'
  return nowMs - lastSeen > staleMs ? 'stale' : 'fresh'
}

function runtimeWarnings(row: any | null, freshness: RuntimeFreshness, expectedCommit: string | null): string[] {
  const warnings: string[] = []
  if (!row) {
    warnings.push('no_runtime_instance')
    return warnings
  }
  if (freshness === 'stale') warnings.push('runtime_stale')
  if (freshness === 'missing_heartbeat') warnings.push('runtime_missing_heartbeat')
  if (freshness === 'stopped') warnings.push('runtime_stopped')
  if (expectedCommit) {
    const commit = normalizeString(row.commit_sha)
    if (!commit) warnings.push('runtime_commit_missing')
    else if (!fullGitShaEquals(commit, expectedCommit)) warnings.push('runtime_commit_mismatch')
  }
  if (!normalizeString(row.checkout_path)) warnings.push('runtime_checkout_path_missing')
  return warnings
}

function runtimeWarningsForDrift(
  row: any | null,
  freshness: RuntimeFreshness,
  drift: FleetCheckoutDriftResult,
): string[] {
  const warnings = runtimeWarnings(row, freshness, drift.approved_commit)
  if (!row) return warnings
  for (const reason of drift.reasons) {
    if (!warnings.includes(reason)) warnings.push(reason)
  }
  return warnings
}

function blockerFromWarning(agentId: string, warning: string): string | null {
  if (warning === 'runtime_stale') return `${agentId}:runtime_stale`
  if (warning === 'runtime_commit_missing') return `${agentId}:runtime_commit_missing`
  if (warning === 'runtime_commit_mismatch') return `${agentId}:runtime_commit_mismatch`
  if (warning === 'runtime_checkout_path_missing') return `${agentId}:runtime_checkout_path_missing`
  if (warning === 'runtime_checkout_path_unapproved') return `${agentId}:runtime_checkout_path_unapproved`
  if (warning === 'runtime_dirty_checkout') return `${agentId}:runtime_dirty_checkout`
  return null
}

async function queryAgentRows(db: DbAdapter): Promise<any[]> {
  try {
    return await db.query(
      `SELECT agent_id, agent_type, runtime, status
         FROM agents
        ORDER BY agent_id`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!/runtime/i.test(message)) throw err
    return await db.query(
      `SELECT agent_id, agent_type, cli_type AS runtime, status
         FROM agents
        ORDER BY agent_id`,
    )
  }
}

export async function buildRuntimeInventoryReport(
  db: DbAdapter,
  options: RuntimeInventoryOptions = {},
): Promise<RuntimeInventoryReport> {
  const staleMinutes = options.staleMinutes ?? 15
  const expectedCommit = options.expectedCommit ?? null
  const approvedCheckoutRoots = normalizeApprovedCheckoutRoots(options.approvedCheckoutRoots)
  const provider = options.provider ?? 'discord'
  const bindingRole = options.bindingRole ?? 'outbound'
  const staleMs = staleMinutes * 60_000
  const nowMs = Date.now()

  // The PgAdapter owns a single pg.Client, so keep reads sequential. This is a
  // read-only operator report; deterministic correctness matters more than
  // parallel query speed.
  const agentRows = await queryAgentRows(db)
  const runtimeRows = await db.query(
    `SELECT runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
            host_id, session_name, process_id, port, checkout_path, commit_sha,
            endpoint_uri, status, started_at, stopped_at, last_seen_at, metadata
       FROM agent_runtime_instances
      ORDER BY agent_id, started_at DESC`,
  )
  const connectorRows = await db.query(
    `SELECT connector_instance_id, agent_id, runtime_instance_id, provider, connector_uri,
            status, trust_status, created_at, updated_at, last_seen_at, disabled_at
       FROM connector_instances
      WHERE provider = $1
      ORDER BY agent_id, created_at DESC`,
    [provider],
  )
  const bindingRows = await db.query(
    `SELECT b.channel_binding_id, b.channel_id, c.name AS channel_name, b.provider,
            b.connector_instance_id, b.binding_role, b.status, b.max_concurrency,
            b.ordering_scope, b.policy_source, ci.agent_id AS connector_agent_id,
            ci.status AS connector_status, ci.runtime_instance_id AS connector_runtime_instance_id,
            p.adapter_owner_agent_id
       FROM channel_connector_bindings b
       LEFT JOIN channels c ON c.id = b.channel_id
       LEFT JOIN connector_instances ci ON ci.connector_instance_id = b.connector_instance_id
       LEFT JOIN channel_routing_policy p ON p.channel_id = b.channel_id
      WHERE b.provider = $1
      ORDER BY c.name, b.channel_id, b.binding_role, b.priority`,
    [provider],
  )
  const policyRows = await db.query(
    `SELECT p.channel_id, c.name AS channel_name, p.adapter_owner_agent_id
       FROM channel_routing_policy p
       LEFT JOIN channels c ON c.id = p.channel_id
      WHERE p.adapter_owner_agent_id IS NOT NULL
      ORDER BY c.name, p.channel_id`,
  )

  const runtimesByAgent = new Map<string, any[]>()
  const runtimeById = new Map<string, any>()
  for (const row of runtimeRows) {
    const agentId = String(row.agent_id)
    const runtimeId = String(row.runtime_instance_id)
    const rows = runtimesByAgent.get(agentId) ?? []
    rows.push(row)
    runtimesByAgent.set(agentId, rows)
    runtimeById.set(runtimeId, row)
  }

  const activeBindingCountByConnector = new Map<string, number>()
  const policyBindingAgentsByChannel = new Map<string, string[]>()
  for (const row of bindingRows) {
    if (row.status !== 'active') continue
    const connectorId = normalizeString(row.connector_instance_id)
    if (connectorId) activeBindingCountByConnector.set(connectorId, (activeBindingCountByConnector.get(connectorId) ?? 0) + 1)
    if (String(row.binding_role) !== bindingRole) continue
    const agentId = normalizeString(row.connector_agent_id)
    if (agentId) {
      const agents = policyBindingAgentsByChannel.get(String(row.channel_id)) ?? []
      agents.push(agentId)
      policyBindingAgentsByChannel.set(String(row.channel_id), [...new Set(agents)])
    }
  }

  const agents: RuntimeInventoryAgent[] = agentRows.map((row) => {
    const agentId = String(row.agent_id)
    const runtimes = runtimesByAgent.get(agentId) ?? []
    const latest = runtimes[0] ?? null
    const freshness = classifyRuntime(latest, nowMs, staleMs)
    const checkoutDrift = evaluateFleetCheckoutDrift(latest, {
      approvedCommit: expectedCommit,
      approvedCheckoutRoots,
    })
    const warnings = runtimeWarningsForDrift(latest, freshness, checkoutDrift)
    return {
      agent_id: agentId,
      agent_status: String(row.status ?? ''),
      declared_runtime: String(row.runtime ?? ''),
      runtime_instance_count: runtimes.length,
      latest_runtime_instance_id: latest ? String(latest.runtime_instance_id) : null,
      runtime_status: normalizeString(latest?.status),
      runtime_engine: normalizeString(latest?.runtime_engine),
      runtime_kind: normalizeString(latest?.runtime_kind),
      session_name: normalizeString(latest?.session_name),
      process_id: latest?.process_id === null || latest?.process_id === undefined ? null : Number(latest.process_id),
      port: latest?.port === null || latest?.port === undefined ? null : Number(latest.port),
      checkout_path: normalizeString(latest?.checkout_path),
      commit_sha: normalizeString(latest?.commit_sha),
      checkout_drift: checkoutDrift,
      last_seen_at: timestampString(latest?.last_seen_at),
      freshness,
      warnings,
    }
  })

  const connectors: RuntimeInventoryConnector[] = connectorRows.map((row) => {
    const runtimeId = normalizeString(row.runtime_instance_id)
    const runtime = runtimeId ? runtimeById.get(runtimeId) ?? null : null
    const freshness = runtimeId && runtime ? classifyRuntime(runtime, nowMs, staleMs) : 'unknown'
    const warnings: string[] = []
    if (row.status !== 'active') warnings.push('connector_not_active')
    if (row.disabled_at) warnings.push('connector_disabled')
    if (!runtimeId) warnings.push('connector_without_runtime')
    else if (!runtime) warnings.push('connector_runtime_missing')
    else warnings.push(...runtimeWarnings(runtime, freshness, expectedCommit).map((warning) => `connector_${warning}`))
    if (runtimeId && runtime) {
      const checkoutDrift = evaluateFleetCheckoutDrift(runtime, {
        approvedCommit: expectedCommit,
        approvedCheckoutRoots,
      })
      for (const reason of checkoutDrift.reasons) {
        const warning = `connector_${reason}`
        if (!warnings.includes(warning)) warnings.push(warning)
      }
    }
    return {
      connector_instance_id: String(row.connector_instance_id),
      agent_id: String(row.agent_id),
      provider: String(row.provider),
      connector_uri: normalizeString(row.connector_uri),
      status: String(row.status ?? ''),
      trust_status: String(row.trust_status ?? ''),
      runtime_instance_id: runtimeId,
      runtime_freshness: freshness,
      active_binding_count: activeBindingCountByConnector.get(String(row.connector_instance_id)) ?? 0,
      last_seen_at: timestampString(row.last_seen_at),
      warnings,
    }
  })

  const bindings: RuntimeInventoryBinding[] = bindingRows.map((row) => {
    const warnings: string[] = []
    if (!row.connector_instance_id) warnings.push('binding_without_connector')
    if (!row.connector_agent_id) warnings.push('binding_connector_missing')
    if (row.connector_status && row.connector_status !== 'active') warnings.push('binding_connector_not_active')
    if (row.adapter_owner_agent_id && row.connector_agent_id && row.adapter_owner_agent_id !== row.connector_agent_id) {
      warnings.push('binding_connector_agent_mismatch_policy')
    }
    const runtimeId = normalizeString(row.connector_runtime_instance_id)
    if (!runtimeId) warnings.push('binding_connector_without_runtime')
    else {
      const runtime = runtimeById.get(runtimeId)
      const freshness = runtime ? classifyRuntime(runtime, nowMs, staleMs) : 'unknown'
      if (freshness === 'stale') warnings.push('binding_runtime_stale')
      if (freshness === 'missing_heartbeat') warnings.push('binding_runtime_missing_heartbeat')
    }
    return {
      channel_binding_id: String(row.channel_binding_id),
      channel_id: String(row.channel_id),
      channel_name: normalizeString(row.channel_name),
      provider: String(row.provider),
      binding_role: String(row.binding_role),
      status: String(row.status),
      connector_instance_id: normalizeString(row.connector_instance_id),
      connector_agent_id: normalizeString(row.connector_agent_id),
      adapter_owner_agent_id: normalizeString(row.adapter_owner_agent_id),
      warnings,
    }
  })

  const policyGaps: RuntimeInventoryPolicyGap[] = []
  for (const policy of policyRows) {
    const owner = normalizeString(policy.adapter_owner_agent_id)
    if (!owner) continue
    const activeAgents = policyBindingAgentsByChannel.get(String(policy.channel_id)) ?? []
    if (activeAgents.length === 0) {
      policyGaps.push({
        channel_id: String(policy.channel_id),
        channel_name: normalizeString(policy.channel_name),
        adapter_owner_agent_id: owner,
        provider,
        binding_role: bindingRole,
        reason: 'missing_active_binding',
        active_binding_agents: [],
      })
    } else if (!activeAgents.includes(owner)) {
      policyGaps.push({
        channel_id: String(policy.channel_id),
        channel_name: normalizeString(policy.channel_name),
        adapter_owner_agent_id: owner,
        provider,
        binding_role: bindingRole,
        reason: 'active_binding_wrong_owner',
        active_binding_agents: activeAgents,
      })
    }
  }

  const blockers = [
    ...agents.flatMap((agent) => agent.warnings.map((warning) => blockerFromWarning(agent.agent_id, warning)).filter((item): item is string => item !== null)),
    ...connectors.flatMap((connector) => connector.warnings
      .filter((warning) => [
        'connector_runtime_stale',
        'connector_runtime_commit_missing',
        'connector_runtime_commit_mismatch',
        'connector_runtime_checkout_path_missing',
        'connector_runtime_checkout_path_unapproved',
        'connector_runtime_dirty_checkout',
      ].includes(warning))
      .map((warning) => `${connector.agent_id}:${warning}`)),
    ...policyGaps.map((gap) => `${gap.channel_id}:${gap.reason}`),
  ]
  const warnings = [
    ...agents.flatMap((agent) => agent.warnings.map((warning) => `${agent.agent_id}:${warning}`)),
    ...connectors.flatMap((connector) => connector.warnings.map((warning) => `${connector.connector_instance_id}:${warning}`)),
    ...bindings.flatMap((binding) => binding.warnings.map((warning) => `${binding.channel_id}:${warning}`)),
  ]

  return {
    ok: true,
    generated_at: new Date(nowMs).toISOString(),
    policy: {
      db_is_source_of_truth: true,
      runtime_identity: 'agent_id is logical identity; runtime_instance_id is concrete process/session evidence',
      final_design_guardrail: 'read-only inventory; do not infer trust from local path, tmux name, or Discord identity',
    },
    options: {
      stale_minutes: staleMinutes,
      expected_commit: expectedCommit,
      approved_checkout_roots: approvedCheckoutRoots,
      provider,
      binding_role: bindingRole,
    },
    summary: {
      agents: agents.length,
      runtime_instances: runtimeRows.length,
      fresh_runtimes: agents.filter((agent) => agent.freshness === 'fresh').length,
      stale_runtimes: agents.filter((agent) => agent.freshness === 'stale').length,
      connectors: connectors.length,
      active_connectors: connectors.filter((connector) => connector.status === 'active').length,
      active_bindings: bindings.filter((binding) => binding.status === 'active').length,
      policy_gaps: policyGaps.length,
      blockers: blockers.length,
    },
    agents,
    connectors,
    bindings,
    policy_gaps: policyGaps,
    blockers,
    warnings,
  }
}

export function formatRuntimeInventoryText(report: RuntimeInventoryReport): string {
  const lines = [
    'Runtime Inventory',
    `Agents: ${report.summary.agents}, runtime instances: ${report.summary.runtime_instances}, fresh: ${report.summary.fresh_runtimes}, stale: ${report.summary.stale_runtimes}`,
    `Connectors: ${report.summary.connectors}, active connectors: ${report.summary.active_connectors}, active bindings: ${report.summary.active_bindings}, policy gaps: ${report.summary.policy_gaps}`,
    '',
    'Runtime Evidence:',
  ]
  for (const agent of report.agents) {
    lines.push(`  ${agent.agent_id}: freshness=${agent.freshness} runtime=${agent.latest_runtime_instance_id ?? '-'} commit=${agent.commit_sha ?? '-'} session=${agent.session_name ?? '-'}${agent.warnings.length ? ` warnings=${agent.warnings.join(',')}` : ''}`)
  }
  lines.push('', 'Connectors:')
  for (const connector of report.connectors) {
    lines.push(`  ${connector.agent_id}/${connector.provider}: status=${connector.status} uri=${connector.connector_uri ?? '-'} runtime=${connector.runtime_instance_id ?? '-'} bindings=${connector.active_binding_count}${connector.warnings.length ? ` warnings=${connector.warnings.join(',')}` : ''}`)
  }
  lines.push('', `Policy Gaps (${report.options.binding_role}):`)
  if (report.policy_gaps.length === 0) {
    lines.push('  none')
  } else {
    for (const gap of report.policy_gaps) {
      lines.push(`  ${gap.channel_name ?? gap.channel_id}: adapter_owner=${gap.adapter_owner_agent_id} reason=${gap.reason}`)
    }
  }
  if (report.blockers.length > 0) lines.push('', `Blockers: ${report.blockers.join(', ')}`)
  if (report.warnings.length > 0) lines.push('', `Warnings: ${report.warnings.join(', ')}`)
  return `${lines.join('\n')}\n`
}
