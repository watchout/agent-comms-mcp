import {
  ACTIVE_EXECUTION_SEAT_QUERY_VERSION,
  listActiveExecutionSeats,
  type ActiveExecutionSeatDb,
} from './active-execution-seats'
import {
  evaluateRuntimeMemoryReadyGate,
  resolveRuntimeMemoryReadyProject,
  type RuntimeMemoryReadyGateResult,
  type RuntimeMemoryReadyProjectResolution,
} from './runtime-memory-ready'

export type RuntimeMemoryReadyCoverageReport = {
  schema_version: 'runtime-memory-ready-coverage/v1'
  query_version: typeof ACTIVE_EXECUTION_SEAT_QUERY_VERSION
  measured_at: string
  active: number
  ready: number
  missing: number
  complete: boolean
  seats: Array<{
    agent_id: string
    ready: boolean
    reason: string
    project: string | null
  }>
}

export async function measureRuntimeMemoryReadyCoverage(
  db: ActiveExecutionSeatDb,
  options: {
    now?: Date
    resolveProject?: (
      db: ActiveExecutionSeatDb,
      agentId: string,
    ) => Promise<RuntimeMemoryReadyProjectResolution>
    evaluateGate?: (
      db: ActiveExecutionSeatDb,
      input: { agent_id: string; expected_agent_id: string; project: string; now: Date },
    ) => Promise<RuntimeMemoryReadyGateResult>
  } = {},
): Promise<RuntimeMemoryReadyCoverageReport> {
  const now = options.now ?? new Date()
  const resolveProject = options.resolveProject ?? resolveRuntimeMemoryReadyProject
  const evaluateGate = options.evaluateGate ?? evaluateRuntimeMemoryReadyGate
  const inventory = await listActiveExecutionSeats(db)
  const seats: RuntimeMemoryReadyCoverageReport['seats'] = []

  for (const seat of inventory) {
    try {
      const project = await resolveProject(db, seat.agent_id)
      const gate = await evaluateGate(db, {
        agent_id: seat.agent_id,
        expected_agent_id: seat.agent_id,
        project: project.project,
        now,
      })
      seats.push({
        agent_id: seat.agent_id,
        ready: gate.ok,
        reason: gate.reason,
        project: project.project,
      })
    } catch (error) {
      seats.push({
        agent_id: seat.agent_id,
        ready: false,
        reason: (error as Error).message ?? String(error),
        project: null,
      })
    }
  }

  const ready = seats.filter(seat => seat.ready).length
  return {
    schema_version: 'runtime-memory-ready-coverage/v1',
    query_version: ACTIVE_EXECUTION_SEAT_QUERY_VERSION,
    measured_at: now.toISOString(),
    active: seats.length,
    ready,
    missing: seats.length - ready,
    complete: seats.length > 0 && ready === seats.length,
    seats,
  }
}
