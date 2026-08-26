import {
  buildWasurezuBootstrapEvidence,
  evaluateRuntimeMemoryReadyGate,
  recordRuntimeMemoryReadyEvidence,
  resolveRuntimeMemoryReadyProject,
  type RuntimeMemoryReadyDb,
  type RuntimeMemoryReadyProjectResolution,
} from './runtime-memory-ready'
import {
  loadRuntimeMemoryReadyPolicy,
  reapRuntimeMemoryReadyStaleRows,
  resolveRuntimeMemoryReadyCurrent,
  type RuntimeCurrentResolution,
  type RuntimeMemoryReadyPolicy,
} from './runtime-current-resolver'

type FleetSeatRow = {
  agent_id: string
}

export type RuntimeMemoryReadySeatResult = {
  agent_id: string
  status: 'ready' | 'failed' | 'skipped' | 'dry_run_ready'
  reason: string
  runtime_instance_id: string | null
  project: string | null
  evidence_id: string | number | null
  evidence_log_id: string | null
  reaped_runtime_instances: Array<{ runtime_instance_id: string; reason: string; reaped: boolean }>
  details: Record<string, unknown>
}

export type RuntimeMemoryReadyFleetRefreshReport = {
  ok: boolean
  schema_version: 'runtime-memory-ready-refresh-report/v1'
  generated_at: string
  dry_run: boolean
  provider_effects: 0
  discord_visible_sends: 0
  policy: RuntimeMemoryReadyPolicy['readback'] & { schema_version: string }
  summary: {
    inventory: number
    eligible: number
    ready: number
    failed: number
    skipped: number
    terminal_results: number
  }
  seats: RuntimeMemoryReadySeatResult[]
}

export type RuntimeMemoryReadyFleetRefreshOptions = {
  now?: Date
  dryRun?: boolean
  validForSeconds?: number
  policy?: RuntimeMemoryReadyPolicy
  resolveProject?: (
    db: RuntimeMemoryReadyDb,
    agentId: string,
  ) => Promise<RuntimeMemoryReadyProjectResolution>
  resolveCurrent?: typeof resolveRuntimeMemoryReadyCurrent
  refreshSeat?: (input: {
    db: RuntimeMemoryReadyDb
    resolution: RuntimeCurrentResolution
    project: RuntimeMemoryReadyProjectResolution
    now: Date
    validForSeconds: number
    policy: RuntimeMemoryReadyPolicy
  }) => Promise<{ evidence_id: string | number | null; evidence_log_id: string | null }>
}

async function queryRows<T>(db: RuntimeMemoryReadyDb, sql: string, params?: any[]): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  return Array.isArray(result) ? result : result.rows
}

async function defaultRefreshSeat(input: {
  db: RuntimeMemoryReadyDb
  resolution: RuntimeCurrentResolution
  project: RuntimeMemoryReadyProjectResolution
  now: Date
  validForSeconds: number
  policy: RuntimeMemoryReadyPolicy
}): Promise<{ evidence_id: string | number | null; evidence_log_id: string | null }> {
  const runtime = input.resolution.current_runtime
  const profile = input.resolution.profile
  if (!runtime || !profile || !runtime.session_name || runtime.port === null) {
    throw new Error('CURRENT_RUNTIME_IDENTITY_INCOMPLETE')
  }
  const evidence = buildWasurezuBootstrapEvidence({
    agent_id: input.resolution.agent_id,
    project: input.project.project,
    runtime_instance_id: runtime.runtime_instance_id,
    profile_revision: profile.profile_revision,
    profile_source: profile.profile_source,
    session_name: runtime.session_name,
    port: runtime.port,
    checkout_path: runtime.checkout_path,
    checkout_commit_sha: runtime.commit_sha,
    completed_at: input.now,
    valid_for_seconds: input.validForSeconds,
    recovery_command: 'mcp__wasurezu__recover_context',
  })
  const recorded = await recordRuntimeMemoryReadyEvidence(input.db, evidence)
  const gate = await evaluateRuntimeMemoryReadyGate(input.db, {
    agent_id: input.resolution.agent_id,
    expected_agent_id: input.resolution.agent_id,
    project: input.project.project,
    now: input.now,
    policy: input.policy,
  })
  if (!gate.ok) {
    throw new Error(`MEMORY_READY_READBACK_FAILED:${gate.reason}`)
  }
  return recorded
}

export { defaultRefreshSeat as refreshRuntimeMemoryReadySeat }

export async function runRuntimeMemoryReadyFleetRefresh(
  db: RuntimeMemoryReadyDb,
  options: RuntimeMemoryReadyFleetRefreshOptions,
): Promise<RuntimeMemoryReadyFleetRefreshReport> {
  const now = options.now ?? new Date()
  const dryRun = options.dryRun ?? false
  const validForSeconds = options.validForSeconds ?? 86_400
  const policy = options.policy ?? loadRuntimeMemoryReadyPolicy()
  const resolveProject = options.resolveProject ?? resolveRuntimeMemoryReadyProject
  const resolveCurrent = options.resolveCurrent ?? resolveRuntimeMemoryReadyCurrent
  const refreshSeat = options.refreshSeat ?? defaultRefreshSeat
  const inventory = await queryRows<FleetSeatRow>(
    db,
    `SELECT agent_id
       FROM agents
      WHERE status IN ('idle', 'busy')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
        AND COALESCE(agent_type, 'dev') <> 'human'
      ORDER BY agent_id`,
  )
  const seats: RuntimeMemoryReadySeatResult[] = []

  for (const seat of inventory) {
    const agentId = String(seat.agent_id)

    let resolution: RuntimeCurrentResolution | null = null
    let reaped: RuntimeMemoryReadySeatResult['reaped_runtime_instances'] = []
    let reapDetails: Record<string, unknown> = {}
    try {
      resolution = await resolveCurrent(db, {
        agentId,
        requestedRuntimeKind: 'local_process',
        now,
        policy,
      })
      let allReapResults: RuntimeMemoryReadySeatResult['reaped_runtime_instances']
      if (!dryRun && resolution.reap_candidates.length > 0) {
        allReapResults = (await reapRuntimeMemoryReadyStaleRows(db, resolution.reap_candidates, now)).map(row => ({
          runtime_instance_id: row.runtime_instance_id,
          reason: row.reason,
          reaped: row.reaped,
        }))
      } else {
        allReapResults = resolution.reap_candidates.map(row => ({
          runtime_instance_id: row.runtime_instance_id,
          reason: row.reason,
          reaped: false,
        }))
      }
      reaped = allReapResults.slice(0, 5)
      reapDetails = {
        reap_candidates_total: allReapResults.length,
        reap_success_total: allReapResults.filter(row => row.reaped).length,
        reap_result_sample_limit: 5,
        reap_result_truncated: allReapResults.length > 5,
      }
      if (!resolution.ok || !resolution.current_runtime) {
        seats.push({
          agent_id: agentId,
          status: 'failed',
          reason: resolution.code,
          runtime_instance_id: null,
          project: null,
          evidence_id: null,
          evidence_log_id: null,
          reaped_runtime_instances: reaped,
          details: {
            repair_signal: resolution.code === 'NO_CURRENT_RUNTIME_FOR_PROFILE'
              ? 'RUNTIME_REREGISTRATION_REQUIRED'
              : 'PROFILE_REPAIR_REQUIRED',
            ...reapDetails,
            ...resolution.details,
          },
        })
        continue
      }
      const currentRegistrationMismatch = resolution.profile_mismatch_observations.find(row => row.current) ?? null
      if (currentRegistrationMismatch) {
        seats.push({
          agent_id: agentId,
          status: 'failed',
          reason: currentRegistrationMismatch.code,
          runtime_instance_id: resolution.current_runtime.runtime_instance_id,
          project: null,
          evidence_id: null,
          evidence_log_id: null,
          reaped_runtime_instances: reaped,
          details: {
            repair_signal: 'RUNTIME_REGISTRATION_PROFILE_CORRECTION_REQUIRED',
            registration_profile_mismatch: currentRegistrationMismatch,
            ...reapDetails,
          },
        })
        continue
      }
      const project = await resolveProject(db, agentId)
      if (dryRun) {
        seats.push({
          agent_id: agentId,
          status: 'dry_run_ready',
          reason: 'DRY_RUN_READY',
          runtime_instance_id: resolution.current_runtime.runtime_instance_id,
          project: project.project,
          evidence_id: null,
          evidence_log_id: null,
          reaped_runtime_instances: reaped,
          details: { project_resolution_source: project.source, ...reapDetails },
        })
        continue
      }
      const recorded = await refreshSeat({ db, resolution, project, now, validForSeconds, policy })
      seats.push({
        agent_id: agentId,
        status: 'ready',
        reason: 'READY',
        runtime_instance_id: resolution.current_runtime.runtime_instance_id,
        project: project.project,
        evidence_id: recorded.evidence_id,
        evidence_log_id: recorded.evidence_log_id,
        reaped_runtime_instances: reaped,
        details: { project_resolution_source: project.source, ...reapDetails },
      })
    } catch (error) {
      seats.push({
        agent_id: agentId,
        status: 'failed',
        reason: 'SEAT_REFRESH_ERROR',
        runtime_instance_id: resolution?.current_runtime?.runtime_instance_id ?? null,
        project: null,
        evidence_id: null,
        evidence_log_id: null,
        reaped_runtime_instances: reaped,
        details: { error: (error as Error).message ?? String(error), ...reapDetails },
      })
    }
  }

  const skipped = seats.filter(row => row.status === 'skipped').length
  const failed = seats.filter(row => row.status === 'failed').length
  const ready = seats.filter(row => row.status === 'ready' || row.status === 'dry_run_ready').length
  return {
    ok: failed === 0 && seats.length === inventory.length,
    schema_version: 'runtime-memory-ready-refresh-report/v1',
    generated_at: now.toISOString(),
    dry_run: dryRun,
    provider_effects: 0,
    discord_visible_sends: 0,
    policy: { schema_version: policy.schema_version, ...policy.readback },
    summary: {
      inventory: inventory.length,
      eligible: inventory.length - skipped,
      ready,
      failed,
      skipped,
      terminal_results: seats.length,
    },
    seats,
  }
}
