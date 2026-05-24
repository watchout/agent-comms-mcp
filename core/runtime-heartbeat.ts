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
}

function sha256Prefix(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
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

async function ensureWorkspaceBinding(
  db: RuntimeHeartbeatDb,
  input: RuntimeHeartbeatInput,
): Promise<string | null> {
  const checkoutPath = normalizeCheckoutPath(input.checkoutPath)
  const explicitWorkspaceId = input.workspaceId?.trim() || null
  if (!checkoutPath && !explicitWorkspaceId) return null

  const orgId = input.orgId?.trim() || 'default'
  const workspaceId = explicitWorkspaceId ?? deterministicWorkspaceId(orgId, checkoutPath!)
  const workspaceName = input.workspaceName?.trim() || inferWorkspaceName(checkoutPath, input.agentId)
  const bindingRole = input.workspaceBindingRole?.trim() || 'primary'

  if (checkoutPath) {
    const workspaceMetadata = JSON.stringify({
      source: 'runtime_heartbeat',
      agent_id: input.agentId,
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
      [workspaceId, orgId, workspaceName, checkoutPath, workspaceMetadata],
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
): Promise<number> {
  const provider = input.connectorProvider?.trim()
  const connectorUri = input.connectorUri?.trim()
  if (!provider || !connectorUri) return 0

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
  return result.rowCount ?? result.rows.length
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
  const connectorUpdate = await db.query(
    `UPDATE connector_instances
        SET runtime_instance_id = $1,
            last_seen_at = now(),
            updated_at = now()
      WHERE agent_id = $2
        AND status = 'active'
      RETURNING connector_instance_id`,
    [input.runtimeInstanceId, input.agentId],
  ).catch(() => ({ rows: [] as any[], rowCount: 0 }))

  const row = runtime.rows[0]
  return {
    ok: true,
    runtime_instance_id: String(row?.runtime_instance_id ?? input.runtimeInstanceId),
    agent_id: String(row?.agent_id ?? input.agentId),
    workspace_id: workspaceId,
    status: String(row?.status ?? 'running'),
    last_seen_at: row?.last_seen_at ?? null,
    connector_rows_updated: connectorUpdate.rowCount ?? connectorUpdate.rows.length,
    connector_rows_upserted: connectorRowsUpserted,
  }
}
