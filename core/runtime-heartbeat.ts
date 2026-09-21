import { durableRuntimeMetadata } from './runtime-durable-data'
import { inspectHostRuntime, type HostRuntimeInspector } from './host-runtime-observer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import {
  reconcileRuntimeMemoryReadyIdentity,
  type RuntimeMemoryReadyIdentityReconcileResult,
} from './runtime-memory-ready-identity'

export type RuntimeHeartbeatDb = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>
}

export type RuntimeHeartbeatInput = {
  runtimeInstanceId: string
  agentId: string
  orgId?: string | null
  workspaceId?: string | null
  workspaceName?: string | null
  workspaceBindingRole?: string | null
  runtimeEngine?: string | null
  runtimeKind?: string | null
  hostId?: string | null
  sessionName?: string | null
  processId?: number | null
  port?: number | null
  checkoutPath?: string | null
  commitSha?: string | null
  endpointUri?: string | null
  connectorProvider?: string | null
  connectorUri?: string | null
  connectorKind?: string | null
  connectorTransport?: string | null
  metadata?: Record<string, unknown>
  connectorMetadata?: Record<string, unknown>
}

export const RUNTIME_REGISTRATION_METADATA_PROVENANCE_SCHEMA = 'runtime-registration-metadata-provenance/v1' as const

export type RuntimeRegistrationValueSource = 'registered' | 'ambient' | 'missing'

export type RuntimeRegistrationFieldProvenance = {
  source: RuntimeRegistrationValueSource
  effective_value: string | null
  registered_value: string | null
  ambient_value: string | null
  mismatch: boolean
}

export type RuntimeRegistrationMetadataProvenance = {
  schema_version: typeof RUNTIME_REGISTRATION_METADATA_PROVENANCE_SCHEMA
  agent_id: string
  profile_found: boolean
  session_name: RuntimeRegistrationFieldProvenance
  checkout_path: RuntimeRegistrationFieldProvenance
}

export type RuntimeHeartbeatResult = {
  ok: true
  runtime_instance_id: string
  agent_id: string
  workspace_id: string | null
  status: string
  last_seen_at: string | Date | null
  connector_rows_updated: number
  connector_rows_upserted: number
  endpoint_lease_id: string | null
  endpoint_lease_expires_at: string | Date | null
  endpoint_lease_heartbeat_at: string | Date | null
  memory_ready_identity: RuntimeMemoryReadyIdentityReconcileResult | null
  registration_metadata_provenance: RuntimeRegistrationMetadataProvenance
}

export type RuntimeHeartbeatOptions = {
  inspect?: HostRuntimeInspector
  reconcileMemoryReadyIdentity?: typeof reconcileRuntimeMemoryReadyIdentity
}

type AgentWorkspaceProfile = {
  org_id: string | null
  home_directory: string | null
  profile_revision: number | null
  profile_source: string | null
  metadata: Record<string, unknown>
}

type RuntimeConnectorHeartbeatResult = {
  rowCount: number
  connectorInstanceId: string | null
}

type EndpointLeaseHeartbeatResult = {
  leaseId: string
  expiresAt: string | Date | null
  heartbeatAt: string | Date | null
}

const RUNTIME_ENDPOINT_LEASE_PURPOSE = 'worker'
const DEFAULT_RUNTIME_ENDPOINT_LEASE_TTL_MS = 10 * 60 * 1000

function sha256Prefix(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function dbTimestamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, -1)}+00:00`
}

function parseDateMs(value: string | Date | null | undefined): number | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  const ms = parsed.getTime()
  return Number.isNaN(ms) ? null : ms
}

function endpointKind(endpointUri: string | null | undefined): string | null {
  if (!endpointUri) return null
  if (endpointUri.startsWith('http://') || endpointUri.startsWith('https://')) return 'tcp'
  if (endpointUri.startsWith('unix:')) return 'unix'
  return 'unknown'
}

function runtimeEndpointLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_COM_RUNTIME_ENDPOINT_LEASE_TTL_SEC ?? env.AGENT_COM_ENDPOINT_LEASE_TTL_SEC
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed * 1000
    : DEFAULT_RUNTIME_ENDPOINT_LEASE_TTL_MS
}

export function normalizeCheckoutPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim()
  if (!trimmed) return null
  return resolve(trimmed)
}

export function inferWorkspaceName(checkoutPath: string | null, fallback: string): string {
  if (!checkoutPath) return fallback
  return basename(checkoutPath) || fallback
}

export function deterministicWorkspaceId(orgId: string, checkoutPath: string): string {
  return `local:${sha256Prefix(`${orgId}:${checkoutPath}`)}`
}

async function selectAgentWorkspaceProfile(
  db: RuntimeHeartbeatDb,
  agentId: string,
): Promise<AgentWorkspaceProfile | null> {
  const result = await db.query(
    `SELECT org_id, home_directory, profile_revision, profile_source, metadata
       FROM agents
      WHERE agent_id = $1
        AND COALESCE(profile_enabled, true) = true
      LIMIT 1`,
    [agentId],
  )
  const row = result.rows[0]
  if (!row) return null
  let metadata: Record<string, unknown> = {}
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    metadata = row.metadata as Record<string, unknown>
  } else if (typeof row.metadata === 'string' && row.metadata.trim()) {
    try {
      const parsed = JSON.parse(row.metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
    } catch {
      metadata = {}
    }
  }
  return {
    org_id: typeof row.org_id === 'string' ? row.org_id : null,
    home_directory: typeof row.home_directory === 'string' ? row.home_directory : null,
    profile_revision: row.profile_revision === null || row.profile_revision === undefined
      ? null
      : Number(row.profile_revision),
    profile_source: typeof row.profile_source === 'string' ? row.profile_source : null,
    metadata,
  }
}

function normalizedText(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function registrationField(
  registeredValue: string | null,
  ambientValue: string | null,
  preferRegistered: boolean,
): RuntimeRegistrationFieldProvenance {
  const source: RuntimeRegistrationValueSource = preferRegistered && registeredValue
    ? 'registered'
    : ambientValue
      ? 'ambient'
      : 'missing'
  return {
    source,
    effective_value: preferRegistered ? registeredValue ?? ambientValue : ambientValue,
    registered_value: registeredValue,
    ambient_value: ambientValue,
    mismatch: registeredValue !== ambientValue,
  }
}

function resolveRuntimeRegistrationMetadata(
  input: RuntimeHeartbeatInput,
  profile: AgentWorkspaceProfile | null,
): {
  sessionName: string | null
  checkoutPath: string | null
  provenance: RuntimeRegistrationMetadataProvenance
} {
  const ambientSession = normalizedText(input.sessionName)
  const ambientCheckout = normalizeCheckoutPath(input.checkoutPath)
  const registeredSession = normalizedText(
    typeof profile?.metadata.tmux_session === 'string' ? profile.metadata.tmux_session : null,
  )
  const registeredCheckout = normalizeCheckoutPath(profile?.home_directory)
  const observed = input.metadata?.provider_observation as Record<string, unknown> | undefined
  const verifiedLocation = observed?.verified === true && observed.agent_id === input.agentId
    && observed.runtime_instance_id === input.runtimeInstanceId && observed.workspace === ambientCheckout
    && observed.session_name === ambientSession
  const preferRegistered = (normalizedText(input.runtimeKind) ?? 'local_process') === 'local_process' && !verifiedLocation
  const sessionName = registrationField(registeredSession, ambientSession, preferRegistered)
  const checkoutPath = registrationField(registeredCheckout, ambientCheckout, preferRegistered)
  return {
    sessionName: sessionName.effective_value,
    checkoutPath: checkoutPath.effective_value,
    provenance: {
      schema_version: RUNTIME_REGISTRATION_METADATA_PROVENANCE_SCHEMA,
      agent_id: input.agentId,
      profile_found: profile !== null,
      session_name: sessionName,
      checkout_path: checkoutPath,
    },
  }
}

async function heartbeatRuntimeEndpointLease(
  db: RuntimeHeartbeatDb,
  input: RuntimeHeartbeatInput,
  holderConnectorInstanceId: string | null,
): Promise<EndpointLeaseHeartbeatResult | null> {
  const ttlMs = runtimeEndpointLeaseTtlMs()
  const now = new Date()
  const heartbeatAt = dbTimestamp(now)
  const expiresAt = dbTimestamp(new Date(now.getTime() + ttlMs))
  const metadata = JSON.stringify(durableRuntimeMetadata())

  const current = await db.query(
    `SELECT lease_id, fencing_token, expires_at, holder_agent_id, holder_runtime_instance_id, metadata
       FROM control_plane_leases
      WHERE lease_scope_type = 'runtime_instance'
        AND lease_scope_id = $1
        AND lease_purpose = $2
        AND status = 'active'
      ORDER BY fencing_token DESC
      LIMIT 1`,
    [input.runtimeInstanceId, RUNTIME_ENDPOINT_LEASE_PURPOSE],
  )
  const active = current.rows[0]

  if (active && ((active.holder_agent_id && active.holder_agent_id !== input.agentId)
    || (active.holder_runtime_instance_id && String(active.holder_runtime_instance_id) !== input.runtimeInstanceId))) {
    throw new Error('RUNTIME_ENDPOINT_HOLDER_MISMATCH')
  }


  if (active && (parseDateMs(active.expires_at) ?? 0) > now.getTime()) {
    const updated = await db.query(
      `UPDATE control_plane_leases
          SET holder_agent_id = $3,
              holder_runtime_instance_id = $4,
              holder_connector_instance_id = $5,
              heartbeat_at = $6,
              expires_at = $7,
              metadata = COALESCE($8::jsonb, '{}'::jsonb)
        WHERE lease_id = $1
          AND fencing_token = $2
          AND holder_agent_id = $3
          AND holder_runtime_instance_id = $4
          AND status = 'active'
          AND expires_at > $6
        RETURNING lease_id, heartbeat_at, expires_at`,
      [
        active.lease_id,
        Number(active.fencing_token),
        input.agentId,
        input.runtimeInstanceId,
        holderConnectorInstanceId,
        heartbeatAt,
        expiresAt,
        metadata,
      ],
    )
    const row = updated.rows[0]
    return row
      ? { leaseId: String(row.lease_id), expiresAt: row.expires_at ?? null, heartbeatAt: row.heartbeat_at ?? null }
      : null
  }

  if (active) {
    await db.query(
      `UPDATE control_plane_leases
          SET status = 'expired',
              released_at = $3
        WHERE lease_scope_type = 'runtime_instance'
          AND lease_scope_id = $1
          AND lease_purpose = $2
          AND status = 'active'
          AND expires_at <= $3`,
      [input.runtimeInstanceId, RUNTIME_ENDPOINT_LEASE_PURPOSE, heartbeatAt],
    )
    throw new Error('RUNTIME_ENDPOINT_LEASE_EXPIRED')
  }

  const token = await db.query(
    `SELECT COALESCE(MAX(fencing_token), 0) AS max_token
       FROM control_plane_leases
      WHERE lease_scope_type = 'runtime_instance'
        AND lease_scope_id = $1
        AND lease_purpose = $2`,
    [input.runtimeInstanceId, RUNTIME_ENDPOINT_LEASE_PURPOSE],
  )
  const fencingToken = Number(token.rows[0]?.max_token ?? 0) + 1
  if (fencingToken > 1) throw new Error('RUNTIME_ENDPOINT_LEASE_REVOKED')
  const inserted = await db.query(
    `INSERT INTO control_plane_leases (
       lease_scope_type, lease_scope_id, lease_purpose,
       holder_agent_id, holder_runtime_instance_id, holder_connector_instance_id,
       fencing_token, status, acquired_at, heartbeat_at, expires_at, metadata
     ) VALUES (
       'runtime_instance', $1, $2,
       $3, $4, $5,
       $6, 'active', $7, $7, $8, COALESCE($9::jsonb, '{}'::jsonb)
     )
     RETURNING lease_id, heartbeat_at, expires_at`,
    [
      input.runtimeInstanceId,
      RUNTIME_ENDPOINT_LEASE_PURPOSE,
      input.agentId,
      input.runtimeInstanceId,
      holderConnectorInstanceId,
      fencingToken,
      heartbeatAt,
      expiresAt,
      metadata,
    ],
  )
  const row = inserted.rows[0]
  return row
    ? { leaseId: String(row.lease_id), expiresAt: row.expires_at ?? null, heartbeatAt: row.heartbeat_at ?? null }
    : null
}

export function inferRuntimeSessionName(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveRuntimeSessionName(env, resolveTmuxSessionName)
}

/**
 * Resolve a tmux pane identifier to the session that contains it. Separated so the
 * inference above can be exercised without tmux, and so a machine without tmux degrades
 * instead of throwing.
 */
export function resolveTmuxSessionName(paneId: string): string | null {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    const name = out.trim()
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

/**
 * TMUX_PANE holds a pane identifier such as `%1008`, not a session name. Recording it as
 * the session name made `agent_runtime_instances.session_name` disagree with the seat's
 * registered `metadata.tmux_session`, and the memory_ready gate compares exactly those
 * two — so every affected seat failed with `session_mismatch` and its queue rows were
 * never delivered. 26 agents were in that state when this was found.
 *
 * The pane identifier is still used, but as a lookup key rather than as the answer. If
 * tmux cannot be queried the pane id is returned as a last resort, which is no worse
 * than the previous behaviour and keeps a machine without tmux working.
 *
 * The resolver is injected here rather than added as an optional parameter above, so
 * that the exported inference keeps its signature.
 */
export function resolveRuntimeSessionName(
  env: NodeJS.ProcessEnv,
  resolvePane: (paneId: string) => string | null,
): string | null {
  if (env.AGENT_COM_RUNTIME_SESSION?.trim()) return env.AGENT_COM_RUNTIME_SESSION.trim()
  const pane = env.TMUX_PANE?.trim()
  if (pane) return resolvePane(pane) ?? pane
  const stateDir = env.DISCORD_STATE_DIR?.trim()
  if (!stateDir) return null
  return stateDir.split('/').filter(Boolean).pop() ?? null
}

export function parseRuntimePort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.WEBHOOK_PORT ?? env.AUN_WEBHOOK_PORT ?? env.PORT
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export function hasRuntimeConnectorIdentityEvidence(env: NodeJS.ProcessEnv = process.env): boolean {
  const hasExplicitSession = Boolean(env.AGENT_COM_RUNTIME_SESSION?.trim() || env.DISCORD_STATE_DIR?.trim())
  const hasExplicitPort = Boolean(env.WEBHOOK_PORT?.trim() || env.AUN_WEBHOOK_PORT?.trim() || env.PORT?.trim())
  return hasExplicitSession && hasExplicitPort
}

export async function heartbeatRuntimeInstance(
  db: RuntimeHeartbeatDb,
  input: RuntimeHeartbeatInput,
  options: RuntimeHeartbeatOptions = {},
): Promise<RuntimeHeartbeatResult> {
  const inspected=(options.inspect ?? inspectHostRuntime)({agentId:input.agentId,runtimeInstanceId:input.runtimeInstanceId,
    logicalWorkspace:input.checkoutPath ?? undefined,expectedHost:input.hostId ?? undefined})
  const held=inspected.observations
  if(inspected.reasonCode!=='OBSERVED' || held.length!==1 || held[0].process_id!==input.processId
    || held[0].port!==input.port || held[0].endpoint_uri!==input.endpointUri) throw new Error('RUNTIME_CURRENT_HOLDER_UNVERIFIED')
  const profile = await selectAgentWorkspaceProfile(db,input.agentId)
  if(!profile) throw new Error('RUNTIME_SEAT_IDENTITY_MISSING')
  const registration=resolveRuntimeRegistrationMetadata({...input,metadata:{provider_observation:held[0]}},profile)
  const effectiveInput=input
  // Existing logical workspace membership is read, never created from this host's path.
  const binding=await db.query(`SELECT workspace_id FROM agent_workspace_bindings
    WHERE agent_id = $1 AND active = true AND binding_role = 'primary'`,[input.agentId])
  if(binding.rows.length>1) throw new Error('RUNTIME_WORKSPACE_BINDING_AMBIGUOUS')
  const workspaceId=binding.rows[0]?.workspace_id ?? input.workspaceId ?? null
  const runtime=await db.query(`INSERT INTO agent_runtime_instances
    (runtime_instance_id,agent_id,workspace_id,runtime_kind,runtime_engine,status,started_at,metadata)
    VALUES ($1,$2,$3,$4,NULL,NULL,NULL,$5::jsonb)
    ON CONFLICT (runtime_instance_id) DO UPDATE SET runtime_instance_id = EXCLUDED.runtime_instance_id
    WHERE agent_runtime_instances.agent_id = EXCLUDED.agent_id
      AND agent_runtime_instances.runtime_kind = EXCLUDED.runtime_kind
    RETURNING runtime_instance_id,agent_id`,
    [input.runtimeInstanceId,input.agentId,workspaceId,input.runtimeKind ?? 'local_process',JSON.stringify(durableRuntimeMetadata(input.metadata))])
  if(!runtime.rows[0]) throw new Error('RUNTIME_INSTANCE_HOLDER_MISMATCH')

  const memoryReadyIdentity = null
  const connectorRowsUpserted = {rowCount:0,connectorInstanceId:null}
  const endpointLease = await heartbeatRuntimeEndpointLease(db,effectiveInput,null)
  if(!endpointLease) throw new Error('RUNTIME_ENDPOINT_LEASE_UNCONFIRMED')

  const row = runtime.rows[0]
  return {
    ok: true,
    runtime_instance_id: String(row?.runtime_instance_id ?? effectiveInput.runtimeInstanceId),
    agent_id: String(row?.agent_id ?? effectiveInput.agentId),
    workspace_id: workspaceId,
    status: 'observed',
    last_seen_at: held[0].observed_at,
    connector_rows_updated: 0,
    connector_rows_upserted: connectorRowsUpserted.rowCount,
    endpoint_lease_id: endpointLease?.leaseId ?? null,
    endpoint_lease_expires_at: endpointLease?.expiresAt ?? null,
    endpoint_lease_heartbeat_at: endpointLease?.heartbeatAt ?? null,
    memory_ready_identity: memoryReadyIdentity,
    registration_metadata_provenance: registration.provenance,
  }
}
