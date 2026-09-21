export interface AgentStatusDb {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export const DEFAULT_LIVE_RUNTIME_GRACE_SECONDS = 600

/** Liveness is an OS observation, never a durable agent status. */
export async function heartbeatAgentStatus(_db: AgentStatusDb, _agentId: string): Promise<void> {}
export async function markAgentRuntimeStopped(_db: AgentStatusDb, _runtimeInstanceId: string): Promise<void> {}
export async function markAgentOfflineIfNoOtherLiveRuntime(_db: AgentStatusDb,
  _input: {agentId:string;runtimeInstanceId:string;liveRuntimeGraceSeconds?:number}): Promise<boolean> { return false }
