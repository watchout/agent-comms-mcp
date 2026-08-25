export const ACTIVE_EXECUTION_SEAT_QUERY_VERSION = 'registry-active-execution-seats/v1' as const
export const ACTIVE_EXECUTION_SEAT_STATUSES = ['idle', 'busy'] as const

export type ActiveExecutionSeatRow = {
  agent_id: string
  agent_type: string | null
  status: string | null
  profile_enabled: unknown
  disabled_at: unknown
  metadata: unknown
}

export type ActiveExecutionSeatDb = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null } | T[]>
}

function rowsOf<T>(result: { rows: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.rows
}

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function isActiveExecutionSeat(row: ActiveExecutionSeatRow): boolean {
  const status = row.status?.trim().toLowerCase() ?? ''
  const agentType = row.agent_type?.trim().toLowerCase() ?? ''
  const retired = metadataObject(row.metadata).retired
  return ACTIVE_EXECUTION_SEAT_STATUSES.includes(status as typeof ACTIVE_EXECUTION_SEAT_STATUSES[number])
    && enabled(row.profile_enabled)
    && row.disabled_at == null
    && agentType.length > 0
    && agentType !== 'human'
    && retired !== true
    && retired !== 'true'
}

export async function listActiveExecutionSeats(
  db: ActiveExecutionSeatDb,
): Promise<ActiveExecutionSeatRow[]> {
  const result = await db.query<ActiveExecutionSeatRow>(
    `SELECT agent_id, agent_type, status, profile_enabled, disabled_at, metadata
       FROM agents
      WHERE status IN ('idle', 'busy')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND COALESCE(agent_type, '') <> 'human'
      ORDER BY agent_id`,
  )
  return rowsOf(result).filter(isActiveExecutionSeat)
}
