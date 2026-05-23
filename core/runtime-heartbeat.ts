import { hostname } from 'node:os'

export type RuntimeHeartbeatDb = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>
}

export type RuntimeHeartbeatInput = {
  runtimeInstanceId: string
  agentId: string
  workspaceId?: string | null
  runtimeEngine?: string | null
  runtimeKind?: string | null
  hostId?: string | null
  sessionName?: string | null
  processId?: number | null
  port?: number | null
  checkoutPath?: string | null
  commitSha?: string | null
  endpointUri?: string | null
  metadata?: Record<string, unknown>
}

export type RuntimeHeartbeatResult = {
  ok: true
  runtime_instance_id: string
  agent_id: string
  status: string
  last_seen_at: string | Date | null
  connector_rows_updated: number
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
      input.workspaceId ?? null,
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
    status: String(row?.status ?? 'running'),
    last_seen_at: row?.last_seen_at ?? null,
    connector_rows_updated: connectorUpdate.rowCount ?? connectorUpdate.rows.length,
  }
}
