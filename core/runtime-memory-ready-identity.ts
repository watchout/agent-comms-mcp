import {
  loadRuntimeMemoryReadyPolicy,
  resolveRuntimeMemoryReadyCurrent,
  type RuntimeCandidateExclusion,
  type RuntimeCurrentResolution,
  type RuntimeMemoryReadyPolicy,
  type RuntimeProfileMismatchObservation,
} from './runtime-current-resolver'
import {
  resolveRuntimeMemoryReadyProject,
  type RuntimeMemoryReadyDb,
  type RuntimeMemoryReadyProjectResolution,
} from './runtime-memory-ready'
import { refreshRuntimeMemoryReadySeat } from './runtime-memory-ready-refresher'

type LatestEvidenceRow = {
  id: string | number
  runtime_instance_id: string
  result_status: string
  completed_at: string | Date
  bound_runtime_status: string | null
}

type FleetSeatRow = { agent_id: string }

export type RuntimeMemoryReadyIdentityReconcileResult = {
  agent_id: string
  observed_runtime_instance_id: string | null
  current_runtime_instance_id: string | null
  previous_evidence_runtime_instance_id: string | null
  status:
    | 'UNCHANGED'
    | 'REFRESHED'
    | 'NO_EVIDENCE'
    | 'NO_CURRENT_RUNTIME'
    | 'PROFILE_MISMATCH_EXCLUDED'
    | 'PROFILE_MISMATCH_DEPRIORITIZED'
    | 'HEARTBEAT_NOT_CURRENT'
    | 'REFRESH_FAILED'
  code: string
  evidence_id: string | number | null
  evidence_log_id: string | null
  details: Record<string, unknown>
}

export type RuntimeMemoryReadyIdentityFinding = {
  code:
    | 'PROFILE_MISMATCH_EXCLUDED'
    | 'REGISTRATION_PROFILE_MISMATCH'
    | 'PROFILE_MISMATCH_DEPRIORITIZED'
    | 'SUPERSEDED_EVIDENCE_BINDING'
  agent_id: string
  runtime_instance_id: string
  details: Record<string, unknown>
}

export type RuntimeMemoryReadyIdentityMonitorReport = {
  schema_version: 'runtime-memory-ready-identity-monitor/v1'
  generated_at: string
  read_only: true
  summary: {
    inventory: number
    profile_mismatch_excluded: number
    registration_profile_mismatch: number
    profile_mismatch_deprioritized: number
    superseded_evidence_binding: number
  }
  findings: RuntimeMemoryReadyIdentityFinding[]
}

export type RuntimeMemoryReadyIdentityOptions = {
  now?: Date
  policy?: RuntimeMemoryReadyPolicy
  resolveCurrent?: typeof resolveRuntimeMemoryReadyCurrent
  resolveProject?: (
    db: RuntimeMemoryReadyDb,
    agentId: string,
  ) => Promise<RuntimeMemoryReadyProjectResolution>
  refreshSeat?: typeof refreshRuntimeMemoryReadySeat
}

async function queryRows<T>(db: RuntimeMemoryReadyDb, sql: string, params?: any[]): Promise<T[]> {
  const result = await db.query<T>(sql, params)
  return Array.isArray(result) ? result : result.rows
}

async function selectLatestEvidence(
  db: RuntimeMemoryReadyDb,
  agentId: string,
  project: string,
): Promise<LatestEvidenceRow | null> {
  const rows = await queryRows<LatestEvidenceRow>(
    db,
    `SELECT e.id, e.runtime_instance_id, e.result_status, e.completed_at,
            ari.status AS bound_runtime_status
       FROM runtime_memory_ready_evidence e
       LEFT JOIN agent_runtime_instances ari
         ON CAST(ari.runtime_instance_id AS TEXT) = e.runtime_instance_id
      WHERE e.agent_id = $1
        AND e.project = $2
      ORDER BY e.completed_at DESC, e.id DESC
      LIMIT 1`,
    [agentId, project],
  )
  return rows[0] ?? null
}

async function recordIdentityAudit(
  db: RuntimeMemoryReadyDb,
  input: {
    agentId: string
    target: string
    code: string
    now: Date
    details: Record<string, unknown>
    deduplicateForMs?: number
  },
): Promise<boolean> {
  if (input.deduplicateForMs && input.deduplicateForMs > 0) {
    const since = new Date(input.now.getTime() - input.deduplicateForMs).toISOString()
    const existing = await queryRows<{ id: string }>(
      db,
      `SELECT id
         FROM audit_log
        WHERE event_type = 'runtime.memory_ready_identity'
          AND agent_id = $1
          AND target = $2
          AND detail->>'code' = $3
          AND created_at >= $4
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.agentId, input.target, input.code, since],
    ).catch(() => [])
    if (existing.length > 0) return false
  }
  const inserted = await queryRows<{ id: string }>(
    db,
    `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
     VALUES ('runtime.memory_ready_identity', $1, $2, COALESCE($3::jsonb, '{}'::jsonb), 'default')
     RETURNING id`,
    [input.agentId, input.target, JSON.stringify({ code: input.code, ...input.details })],
  ).catch(() => [])
  return inserted.length === 1
}

function observedExclusion(
  resolution: RuntimeCurrentResolution,
  runtimeInstanceId: string | null,
): RuntimeCandidateExclusion | null {
  if (!runtimeInstanceId) return null
  return resolution.candidate_exclusions.find(row => row.runtime_instance_id === runtimeInstanceId) ?? null
}

function observedRegistrationMismatch(
  resolution: RuntimeCurrentResolution,
  runtimeInstanceId: string | null,
): RuntimeProfileMismatchObservation | null {
  if (!runtimeInstanceId) return null
  return resolution.profile_mismatch_observations.find(row => row.runtime_instance_id === runtimeInstanceId) ?? null
}

export async function reconcileRuntimeMemoryReadyIdentity(
  db: RuntimeMemoryReadyDb,
  input: {
    agentId: string
    observedRuntimeInstanceId?: string | null
    requestedRuntimeKind?: string
  },
  options: RuntimeMemoryReadyIdentityOptions = {},
): Promise<RuntimeMemoryReadyIdentityReconcileResult> {
  const now = options.now ?? new Date()
  const policy = options.policy ?? loadRuntimeMemoryReadyPolicy()
  const resolveCurrent = options.resolveCurrent ?? resolveRuntimeMemoryReadyCurrent
  const resolveProject = options.resolveProject ?? resolveRuntimeMemoryReadyProject
  const refreshSeat = options.refreshSeat ?? refreshRuntimeMemoryReadySeat
  const observedRuntimeInstanceId = input.observedRuntimeInstanceId?.trim() || null
  let resolution: RuntimeCurrentResolution
  try {
    resolution = await resolveCurrent(db, {
      agentId: input.agentId,
      requestedRuntimeKind: input.requestedRuntimeKind?.trim() || 'local_process',
      now,
      policy,
    })
  } catch (error) {
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: null,
      previous_evidence_runtime_instance_id: null,
      status: 'REFRESH_FAILED',
      code: 'CURRENT_RUNTIME_RESOLUTION_ERROR',
      evidence_id: null,
      evidence_log_id: null,
      details: { error: (error as Error).message ?? String(error) },
    }
  }

  const exclusion = observedExclusion(resolution, observedRuntimeInstanceId)
  if (exclusion) {
    const auditRecorded = await recordIdentityAudit(db, {
      agentId: input.agentId,
      target: exclusion.runtime_instance_id,
      code: exclusion.code,
      now,
      deduplicateForMs: 30 * 60 * 1000,
      details: {
        handling: exclusion.handling,
        mismatches: exclusion.mismatches,
        requested_runtime_kind: resolution.requested_runtime_kind,
      },
    })
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: resolution.current_runtime?.runtime_instance_id ?? null,
      previous_evidence_runtime_instance_id: null,
      status: exclusion.code === 'PROFILE_MISMATCH_DEPRIORITIZED'
        ? 'PROFILE_MISMATCH_DEPRIORITIZED'
        : 'PROFILE_MISMATCH_EXCLUDED',
      code: exclusion.code,
      evidence_id: null,
      evidence_log_id: null,
      details: { ...resolution.details, exclusion, audit_recorded: auditRecorded },
    }
  }
  if (!resolution.ok || !resolution.current_runtime) {
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: null,
      previous_evidence_runtime_instance_id: null,
      status: 'NO_CURRENT_RUNTIME',
      code: resolution.code,
      evidence_id: null,
      evidence_log_id: null,
      details: resolution.details,
    }
  }
  if (observedRuntimeInstanceId && resolution.current_runtime.runtime_instance_id !== observedRuntimeInstanceId) {
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
      previous_evidence_runtime_instance_id: null,
      status: 'HEARTBEAT_NOT_CURRENT',
      code: 'HEARTBEAT_NOT_CURRENT',
      evidence_id: null,
      evidence_log_id: null,
      details: {},
    }
  }

  const registrationMismatch = observedRegistrationMismatch(resolution, observedRuntimeInstanceId)
  let registrationMismatchAuditRecorded = false
  if (registrationMismatch) {
    registrationMismatchAuditRecorded = await recordIdentityAudit(db, {
      agentId: input.agentId,
      target: registrationMismatch.runtime_instance_id,
      code: registrationMismatch.code,
      now,
      deduplicateForMs: 30 * 60 * 1000,
      details: {
        handling: registrationMismatch.handling,
        mismatches: registrationMismatch.mismatches,
        registration_metadata_provenance: registrationMismatch.registration_metadata_provenance,
        requested_runtime_kind: resolution.requested_runtime_kind,
      },
    })
  }
  const mismatchDetails = registrationMismatch
    ? {
        registration_profile_mismatch: registrationMismatch,
        registration_profile_mismatch_audit_recorded: registrationMismatchAuditRecorded,
      }
    : {}

  try {
    const project = await resolveProject(db, input.agentId)
    const evidence = await selectLatestEvidence(db, input.agentId, project.project)
    if (!evidence) {
      return {
        agent_id: input.agentId,
        observed_runtime_instance_id: observedRuntimeInstanceId,
        current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
        previous_evidence_runtime_instance_id: null,
        status: 'NO_EVIDENCE',
        code: 'NO_EVIDENCE',
        evidence_id: null,
        evidence_log_id: null,
        details: { project: project.project, project_resolution_source: project.source, ...mismatchDetails },
      }
    }
    if (evidence.runtime_instance_id === resolution.current_runtime.runtime_instance_id) {
      return {
        agent_id: input.agentId,
        observed_runtime_instance_id: observedRuntimeInstanceId,
        current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
        previous_evidence_runtime_instance_id: evidence.runtime_instance_id,
        status: 'UNCHANGED',
        code: 'EVIDENCE_ALREADY_CURRENT',
        evidence_id: evidence.id,
        evidence_log_id: null,
        details: { project: project.project, ...mismatchDetails },
      }
    }

    await recordIdentityAudit(db, {
      agentId: input.agentId,
      target: resolution.current_runtime.runtime_instance_id,
      code: 'SUPERSEDED_EVIDENCE_BINDING',
      now,
      details: {
        project: project.project,
        evidence_id: evidence.id,
        evidence_runtime_instance_id: evidence.runtime_instance_id,
        evidence_runtime_status: evidence.bound_runtime_status,
        current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
      },
    })
    const refreshed = await refreshSeat({ db, resolution, project, now, validForSeconds: 86_400, policy })
    await recordIdentityAudit(db, {
      agentId: input.agentId,
      target: resolution.current_runtime.runtime_instance_id,
      code: 'EVIDENCE_BINDING_REFRESHED',
      now,
      details: {
        project: project.project,
        superseded_runtime_instance_id: evidence.runtime_instance_id,
        current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
        evidence_id: refreshed.evidence_id,
      },
    })
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
      previous_evidence_runtime_instance_id: evidence.runtime_instance_id,
      status: 'REFRESHED',
      code: 'EVIDENCE_BINDING_REFRESHED',
      evidence_id: refreshed.evidence_id,
      evidence_log_id: refreshed.evidence_log_id,
      details: { project: project.project, superseded_evidence_id: evidence.id, ...mismatchDetails },
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    await recordIdentityAudit(db, {
      agentId: input.agentId,
      target: resolution.current_runtime.runtime_instance_id,
      code: 'EVIDENCE_BINDING_REFRESH_FAILED',
      now,
      details: { error: message, ...mismatchDetails },
    })
    return {
      agent_id: input.agentId,
      observed_runtime_instance_id: observedRuntimeInstanceId,
      current_runtime_instance_id: resolution.current_runtime.runtime_instance_id,
      previous_evidence_runtime_instance_id: null,
      status: 'REFRESH_FAILED',
      code: 'EVIDENCE_BINDING_REFRESH_FAILED',
      evidence_id: null,
      evidence_log_id: null,
      details: { error: message },
    }
  }
}

export async function reconcileRuntimeMemoryReadyFleetIdentity(
  db: RuntimeMemoryReadyDb,
  input: { denylist: string[] },
  options: RuntimeMemoryReadyIdentityOptions = {},
): Promise<RuntimeMemoryReadyIdentityReconcileResult[]> {
  const denylist = new Set(input.denylist.map(value => value.trim()).filter(Boolean))
  const seats = await queryRows<FleetSeatRow>(
    db,
    `SELECT agent_id
       FROM agents
      WHERE status IN ('idle', 'busy')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
      ORDER BY agent_id`,
  )
  const results: RuntimeMemoryReadyIdentityReconcileResult[] = []
  for (const seat of seats) {
    const agentId = String(seat.agent_id)
    if (denylist.has(agentId)) continue
    results.push(await reconcileRuntimeMemoryReadyIdentity(db, { agentId }, options))
  }
  return results
}

export async function queryRuntimeMemoryReadyIdentityMonitor(
  db: RuntimeMemoryReadyDb,
  options: Pick<RuntimeMemoryReadyIdentityOptions, 'now' | 'policy' | 'resolveCurrent' | 'resolveProject'> = {},
): Promise<RuntimeMemoryReadyIdentityMonitorReport> {
  const now = options.now ?? new Date()
  const policy = options.policy ?? loadRuntimeMemoryReadyPolicy()
  const resolveCurrent = options.resolveCurrent ?? resolveRuntimeMemoryReadyCurrent
  const resolveProject = options.resolveProject ?? resolveRuntimeMemoryReadyProject
  const seats = await queryRows<FleetSeatRow>(
    db,
    `SELECT agent_id
       FROM agents
      WHERE status IN ('idle', 'busy')
        AND COALESCE(profile_enabled, true) = true
        AND disabled_at IS NULL
      ORDER BY agent_id`,
  )
  const findings: RuntimeMemoryReadyIdentityFinding[] = []
  for (const seat of seats) {
    const agentId = String(seat.agent_id)
    const resolution = await resolveCurrent(db, {
      agentId,
      requestedRuntimeKind: 'local_process',
      now,
      policy,
    })
    for (const mismatch of resolution.profile_mismatch_observations.filter(row => row.live)) {
      findings.push({
        code: 'REGISTRATION_PROFILE_MISMATCH',
        agent_id: agentId,
        runtime_instance_id: mismatch.runtime_instance_id,
        details: {
          current: mismatch.current,
          mismatches: mismatch.mismatches,
          handling: mismatch.handling,
          registration_metadata_provenance: mismatch.registration_metadata_provenance,
        },
      })
    }
    for (const exclusion of resolution.candidate_exclusions.filter(
      row => row.live && row.code === 'PROFILE_MISMATCH_DEPRIORITIZED',
    )) {
      findings.push({
        code: 'PROFILE_MISMATCH_DEPRIORITIZED',
        agent_id: agentId,
        runtime_instance_id: exclusion.runtime_instance_id,
        details: { mismatches: exclusion.mismatches, handling: exclusion.handling },
      })
    }
    if (!resolution.current_runtime) continue
    const project = await resolveProject(db, agentId)
    const evidence = await selectLatestEvidence(db, agentId, project.project)
    if (evidence && evidence.runtime_instance_id !== resolution.current_runtime.runtime_instance_id) {
      findings.push({
        code: 'SUPERSEDED_EVIDENCE_BINDING',
        agent_id: agentId,
        runtime_instance_id: resolution.current_runtime.runtime_instance_id,
        details: {
          project: project.project,
          evidence_id: evidence.id,
          evidence_runtime_instance_id: evidence.runtime_instance_id,
          evidence_runtime_status: evidence.bound_runtime_status,
        },
      })
    }
  }
  return {
    schema_version: 'runtime-memory-ready-identity-monitor/v1',
    generated_at: now.toISOString(),
    read_only: true,
    summary: {
      inventory: seats.length,
      profile_mismatch_excluded: 0,
      registration_profile_mismatch: findings.filter(row => row.code === 'REGISTRATION_PROFILE_MISMATCH').length,
      profile_mismatch_deprioritized: findings.filter(row => row.code === 'PROFILE_MISMATCH_DEPRIORITIZED').length,
      superseded_evidence_binding: findings.filter(row => row.code === 'SUPERSEDED_EVIDENCE_BINDING').length,
    },
    findings,
  }
}
