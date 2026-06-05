export interface AgentStatusDb {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export const DEFAULT_LIVE_RUNTIME_GRACE_SECONDS = 600

export async function heartbeatAgentStatus(
  db: AgentStatusDb,
  agentId: string,
): Promise<void> {
  await db.query(
    `UPDATE agents
        SET last_seen_at = now(),
            status = CASE
              WHEN status IN ('offline', 'disconnected', 'restarting') THEN 'online'
              ELSE status
            END
      WHERE agent_id = $1`,
    [agentId],
  )
}

export async function markAgentRuntimeStopped(
  db: AgentStatusDb,
  runtimeInstanceId: string,
): Promise<void> {
  await db.query(
    `UPDATE agent_runtime_instances
        SET status = 'stopped',
            stopped_at = now(),
            last_seen_at = now()
      WHERE runtime_instance_id = $1`,
    [runtimeInstanceId],
  )
}

export async function markAgentOfflineIfNoOtherLiveRuntime(
  db: AgentStatusDb,
  input: {
    agentId: string
    runtimeInstanceId: string
    liveRuntimeGraceSeconds?: number
  },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE agents
        SET status = 'offline'
      WHERE agent_id = $1
        AND NOT EXISTS (
          SELECT 1
            FROM agent_runtime_instances
           WHERE agent_id = $1
             AND runtime_instance_id <> $2
             AND status = 'running'
             AND last_seen_at > now() - make_interval(secs => $3)
        )`,
    [
      input.agentId,
      input.runtimeInstanceId,
      input.liveRuntimeGraceSeconds ?? DEFAULT_LIVE_RUNTIME_GRACE_SECONDS,
    ],
  )
  return (result.rowCount ?? 0) > 0
}
