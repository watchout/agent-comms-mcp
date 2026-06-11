import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'

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
}

type AgentWorkspaceProfile = {
  org_id: string | null
  home_directory: string | null
  profile_revision: number | null
  profile_source: string | null
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
    `SELECT org_id, home_directory, profile_revision, profile_source
       FROM agents
      WHERE agent_id = $1
        AND COALESCE(profile_enabled, true) = true
      LIMIT 1`,
    [agentId],
  ).catch(() => ({ rows: [] as any[], rowCount: 0 }))
  const row = result.rows[0]
  if (!row) return null
  return {
    org_id: typeof row.org_id === 'string' ? row.org_id : null,
    home_directory: typeof row.home_directory === 'string' ? row.home_directory : null,
    profile_revision: row.profile_revision === null || row.profile_revision === undefined
      ? null
      : Number(row.profile_revision),
    profile_source: typeof row.profile_source === 'string' ? row.profile_source : null,
  }
}

async function ensureWorkspaceBinding(
  db: RuntimeHeartbeatDb,
  input: RuntimeHeartbeatInput,
): Promise<string | null> {
  const checkoutPath = normalizeCheckoutPath(input.checkoutPath)
  const explicitWorkspaceId = input.workspaceId?.trim() || null
  const profile = await selectAgentWorkspaceProfile(db, input.agentId)
  const profileHomeDirectory = normalizeCheckoutPath(profile?.home_directory)
  const workspacePath = profileHomeDirectory ?? checkoutPath
  if (!workspacePath && !explicitWorkspaceId) return null

  const orgId = input.orgId?.trim() || 'default'
  const effectiveOrgId = profile?.org_id?.trim() || orgId
  const workspaceId = explicitWorkspaceId ?? deterministicWorkspaceId(effectiveOrgId, workspacePath!)
  const workspaceName = input.workspaceName?.trim() || inferWorkspaceName(workspacePath, input.agentId)
  const bindingRole = input.workspaceBindingRole?.trim() || 'primary'

  if (workspacePath) {
    const workspaceMetadata = JSON.stringify({
      source: 'runtime_heartbeat',
      agent_id: input.agentId,
      workspace_path_source: profileHomeDirectory ? 'agent_profile.home_directory' : 'runtime.checkout_path',
      profile_revision: profile?.profile_revision ?? null,
      profile_source: profile?.profile_source ?? null,
      runtime_checkout_path: checkoutPath,
    })
    const workspace = await db.query<{ workspace_id: string }>(
      `INSERT INTO agent_workspaces
         (workspace_id, org_id, name, workspace_type, local_path, metadata, updated_at)
       VALUES
         ($1, $2, $3, 'local_path', $4, COALESCE($5::jsonb, '{}'::jsonb), now())
       ON CONFLICT (org_id, local_path) WHERE local_path IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         workspace_type = EXCLUDED.workspace_type,
         updated_at = now(),
         metadata = COALESCE(agent_workspaces.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
       RETURNING workspace_id`,
      [workspaceId, effectiveOrgId, workspaceName, workspacePath, workspaceMetadata],
    )
    const resolvedWorkspaceId = String(workspace.rows[0]?.workspace_id ?? workspaceId)
    await db.query(
      `INSERT INTO agent_workspace_bindings
         (agent_id, workspace_id, binding_role, active, updated_at)
       VALUES
         ($1, $2, $3, true, now())
       ON CONFLICT (agent_id, workspace_id, binding_role) DO UPDATE SET
         active = true,
         updated_at = now()`,
      [input.agentId, resolvedWorkspaceId, bindingRole],
    )
    return resolvedWorkspaceId
  }

  return workspaceId
}

async function ensureRuntimeConnector(
  db: RuntimeHeartbeatDb,
  input: RuntimeHeartbeatInput,
): Promise<RuntimeConnectorHeartbeatResult> {
  const provider = input.connectorProvider?.trim()
  const connectorUri = input.connectorUri?.trim()
  if (!provider || !connectorUri) return { rowCount: 0, connectorInstanceId: null }

  const capabilities = JSON.stringify({ roles: ['runtime'], source: 'runtime_heartbeat' })
  const metadata = JSON.stringify({
    source: 'runtime_heartbeat',
    ...(input.connectorMetadata ?? {}),
  })
  const result = await db.query(
    `INSERT INTO connector_instances
       (agent_id, runtime_instance_id, provider, connector_kind, transport, connector_uri,
        status, trust_status, capabilities, metadata, last_seen_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6,
        'active', 'local', COALESCE($7::jsonb, '{}'::jsonb), COALESCE($8::jsonb, '{}'::jsonb), now(), now())
     ON CONFLICT (provider, connector_uri) WHERE connector_uri IS NOT NULL DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       runtime_instance_id = EXCLUDED.runtime_instance_id,
       connector_kind = EXCLUDED.connector_kind,
       transport = EXCLUDED.transport,
       status = CASE
         WHEN connector_instances.status = 'disabled' THEN connector_instances.status
         ELSE 'active'
       END,
       trust_status = CASE
         WHEN connector_instances.trust_status IN ('revoked', 'disabled') THEN connector_instances.trust_status
         ELSE EXCLUDED.trust_status
       END,
       capabilities = COALESCE(connector_instances.capabilities, '{}'::jsonb) || COALESCE(EXCLUDED.capabilities, '{}'::jsonb),
       metadata = COALESCE(connector_instances.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
       last_seen_at = now(),
       updated_at = now()
     RETURNING connector_instance_id`,
    [
      input.agentId,
      input.runtimeInstanceId,
      provider,
      input.connectorKind?.trim() || 'chat_adapter',
      input.connectorTransport?.trim() || `${provider}_gateway`,
      connectorUri,
      capabilities,
      metadata,
    ],
  ).catch(() => ({ rows: [] as any[], rowCount: 0 }))
  return {
    rowCount: result.rowCount ?? result.rows.length,
    connectorInstanceId: result.rows[0]?.connector_instance_id ? String(result.rows[0].connector_instance_id) : null,
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
  const metadata = JSON.stringify({
    source: 'runtime_heartbeat',
    endpoint_uri: input.endpointUri ?? null,
    endpoint_kind: endpointKind(input.endpointUri),
    port: input.port ?? null,
    process_id: input.processId ?? null,
    session_name: input.sessionName ?? null,
    checkout_path: input.checkoutPath ?? null,
    commit_sha: input.commitSha ?? null,
  })

  const current = await db.query(
    `SELECT lease_id, fencing_token, expires_at
       FROM control_plane_leases
      WHERE lease_scope_type = 'runtime_instance'
        AND lease_scope_id = $1
        AND lease_purpose = $2
        AND status = 'active'
      ORDER BY fencing_token DESC
      LIMIT 1`,
    [input.runtimeInstanceId, RUNTIME_ENDPOINT_LEASE_PURPOSE],
  ).catch(() => ({ rows: [] as any[], rowCount: 0 }))
  const active = current.rows[0]

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
  }

  const token = await db.query(
    `SELECT COALESCE(MAX(fencing_token), 0) AS max_token
       FROM control_plane_leases
      WHERE lease_scope_type = 'runtime_instance'
        AND lease_scope_id = $1
        AND lease_purpose = $2`,
    [input.runtimeInstanceId, RUNTIME_ENDPOINT_LEASE_PURPOSE],
  ).catch(() => ({ rows: [] as any[], rowCount: 0 }))
  const fencingToken = Number(token.rows[0]?.max_token ?? 0) + 1
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
  if (env.AGENT_COM_RUNTIME_SESSION?.trim()) return env.AGENT_COM_RUNTIME_SESSION.trim()
  if (env.TMUX_PANE?.trim()) return env.TMUX_PANE.trim()
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
): Promise<RuntimeHeartbeatResult> {
  const workspaceId = await ensureWorkspaceBinding(db, input)
  const metadata = JSON.stringify(input.metadata ?? {})
  const runtime = await db.query(
    `INSERT INTO agent_runtime_instances
       (runtime_instance_id, agent_id, workspace_id, runtime_engine, runtime_kind,
        host_id, session_name, process_id, port, checkout_path, commit_sha,
        endpoint_uri, status, started_at, stopped_at, last_seen_at, metadata)
     VALUES
       ($1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, 'running', now(), NULL, now(), COALESCE($13::jsonb, '{}'::jsonb))
     ON CONFLICT (runtime_instance_id) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       workspace_id = EXCLUDED.workspace_id,
       runtime_engine = EXCLUDED.runtime_engine,
       runtime_kind = EXCLUDED.runtime_kind,
       host_id = EXCLUDED.host_id,
       session_name = EXCLUDED.session_name,
       process_id = EXCLUDED.process_id,
       port = EXCLUDED.port,
       checkout_path = EXCLUDED.checkout_path,
       commit_sha = EXCLUDED.commit_sha,
       endpoint_uri = EXCLUDED.endpoint_uri,
       status = 'running',
       stopped_at = NULL,
       last_seen_at = now(),
       metadata = COALESCE(agent_runtime_instances.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
     RETURNING runtime_instance_id, agent_id, status, last_seen_at`,
    [
      input.runtimeInstanceId,
      input.agentId,
      workspaceId,
      input.runtimeEngine ?? 'unknown',
      input.runtimeKind ?? 'local_process',
      input.hostId ?? hostname(),
      input.sessionName ?? null,
      input.processId ?? null,
      input.port ?? null,
      input.checkoutPath ?? null,
      input.commitSha ?? null,
      input.endpointUri ?? null,
      metadata,
    ],
  )

  const connectorRowsUpserted = await ensureRuntimeConnector(db, input)
  const holderConnectorInstanceId = connectorRowsUpserted.connectorInstanceId
  const endpointLease = await heartbeatRuntimeEndpointLease(db, input, holderConnectorInstanceId)

  const row = runtime.rows[0]
  return {
    ok: true,
    runtime_instance_id: String(row?.runtime_instance_id ?? input.runtimeInstanceId),
    agent_id: String(row?.agent_id ?? input.agentId),
    workspace_id: workspaceId,
    status: String(row?.status ?? 'running'),
    last_seen_at: row?.last_seen_at ?? null,
    connector_rows_updated: 0,
    connector_rows_upserted: connectorRowsUpserted.rowCount,
    endpoint_lease_id: endpointLease?.leaseId ?? null,
    endpoint_lease_expires_at: endpointLease?.expiresAt ?? null,
    endpoint_lease_heartbeat_at: endpointLease?.heartbeatAt ?? null,
  }
}
