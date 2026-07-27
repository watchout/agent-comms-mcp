import { randomUUID } from 'node:crypto'
import type { DbAdapter } from './db'

export type LeaseScopeType = 'connector_instance' | 'channel_binding' | 'queue_partition' | 'runtime_instance'
export type LeasePurpose = 'inbound' | 'outbound' | 'worker' | 'leader' | 'presence' | 'maintenance'
export type LeaseStatus = 'active' | 'released' | 'expired' | 'revoked'

export interface ControlPlaneLease {
  lease_id: string
  lease_scope_type: LeaseScopeType
  lease_scope_id: string
  lease_purpose: LeasePurpose
  holder_agent_id: string | null
  holder_runtime_instance_id: string | null
  holder_connector_instance_id: string | null
  fencing_token: number
  status: LeaseStatus
  acquired_at: string | Date | null
  heartbeat_at: string | Date | null
  expires_at: string | Date
  released_at: string | Date | null
  metadata: Record<string, unknown>
}

export interface LeaseHolderInput {
  holderAgentId?: string | null
  holderRuntimeInstanceId?: string | null
  holderConnectorInstanceId?: string | null
}

export interface AcquireControlPlaneLeaseInput extends LeaseHolderInput {
  scopeType: LeaseScopeType
  scopeId: string
  purpose?: LeasePurpose
  ttlMs: number
  now?: Date
  metadata?: Record<string, unknown>
}

export interface LeaseTokenInput extends LeaseHolderInput {
  leaseId: string
  fencingToken: number
  ttlMs?: number
  now?: Date
}

export type AcquireControlPlaneLeaseResult =
  | { ok: true; lease: ControlPlaneLease; expiredLeaseIds: string[] }
  | { ok: false; reason: 'active_lease_exists'; activeLease: ControlPlaneLease }

export type LeaseCheckResult =
  | { ok: true; lease: ControlPlaneLease }
  | { ok: false; reason: 'not_found' | 'not_active' | 'expired' | 'fencing_token_mismatch' | 'holder_mismatch'; lease: ControlPlaneLease | null }

function dbTimestamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, -1)}+00:00`
}

function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms)
}

function parseDbDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeLease(row: any): ControlPlaneLease {
  return {
    lease_id: String(row.lease_id),
    lease_scope_type: row.lease_scope_type,
    lease_scope_id: String(row.lease_scope_id),
    lease_purpose: row.lease_purpose,
    holder_agent_id: row.holder_agent_id ?? null,
    holder_runtime_instance_id: row.holder_runtime_instance_id ?? null,
    holder_connector_instance_id: row.holder_connector_instance_id ?? null,
    fencing_token: Number(row.fencing_token),
    status: row.status,
    acquired_at: row.acquired_at ?? null,
    heartbeat_at: row.heartbeat_at ?? null,
    expires_at: row.expires_at,
    released_at: row.released_at ?? null,
    metadata: normalizeMetadata(row.metadata),
  }
}

function assertLeaseRequest(scopeType: LeaseScopeType, scopeId: string, purpose: LeasePurpose, ttlMs?: number): void {
  if (!scopeType) throw new Error('CONTROL_PLANE_LEASE_SCOPE_TYPE_REQUIRED')
  if (!scopeId) throw new Error('CONTROL_PLANE_LEASE_SCOPE_ID_REQUIRED')
  if (!purpose) throw new Error('CONTROL_PLANE_LEASE_PURPOSE_REQUIRED')
  assertLeaseTtl(ttlMs)
}

function assertLeaseTtl(ttlMs?: number): void {
  if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error('CONTROL_PLANE_LEASE_TTL_INVALID')
  }
}

function holderMatches(lease: ControlPlaneLease, input: LeaseHolderInput): boolean {
  if (input.holderAgentId !== undefined && lease.holder_agent_id !== (input.holderAgentId ?? null)) return false
  if (input.holderRuntimeInstanceId !== undefined && lease.holder_runtime_instance_id !== (input.holderRuntimeInstanceId ?? null)) return false
  if (input.holderConnectorInstanceId !== undefined && lease.holder_connector_instance_id !== (input.holderConnectorInstanceId ?? null)) return false
  return true
}

function isExpired(lease: ControlPlaneLease, now: Date): boolean {
  const expiresAt = parseDbDate(lease.expires_at)
  return !expiresAt || expiresAt.getTime() <= now.getTime()
}

async function getLease(db: DbAdapter, leaseId: string): Promise<ControlPlaneLease | null> {
  const row = await db.queryOne<any>(
    `SELECT * FROM control_plane_leases WHERE lease_id = $1`,
    [leaseId],
  )
  return row ? normalizeLease(row) : null
}

async function classifyLeaseFailure(
  db: DbAdapter,
  input: LeaseTokenInput,
  now: Date,
): Promise<LeaseCheckResult> {
  const lease = await getLease(db, input.leaseId)
  if (!lease) return { ok: false, reason: 'not_found', lease: null }
  if (lease.fencing_token !== Number(input.fencingToken)) {
    return { ok: false, reason: 'fencing_token_mismatch', lease }
  }
  if (!holderMatches(lease, input)) {
    return { ok: false, reason: 'holder_mismatch', lease }
  }
  if (lease.status !== 'active') {
    return { ok: false, reason: 'not_active', lease }
  }
  if (isExpired(lease, now)) {
    return { ok: false, reason: 'expired', lease }
  }
  return { ok: true, lease }
}

export async function acquireControlPlaneLease(
  db: DbAdapter,
  input: AcquireControlPlaneLeaseInput,
): Promise<AcquireControlPlaneLeaseResult> {
  const purpose = input.purpose ?? 'worker'
  assertLeaseRequest(input.scopeType, input.scopeId, purpose, input.ttlMs)
  const now = input.now ?? new Date()
  const expiresAt = addMs(now, input.ttlMs)

  return db.transaction(async (tx) => {
    const activeRows = await tx.query<any>(
      `SELECT * FROM control_plane_leases
        WHERE lease_scope_type = $1
          AND lease_scope_id = $2
          AND lease_purpose = $3
          AND status = 'active'
        ORDER BY fencing_token DESC
        FOR UPDATE`,
      [input.scopeType, input.scopeId, purpose],
    )
    const activeLeases = activeRows.map(normalizeLease)
    const liveLease = activeLeases.find((lease) => !isExpired(lease, now))
    if (liveLease) {
      return { ok: false, reason: 'active_lease_exists', activeLease: liveLease }
    }

    const expiredLeaseIds = activeLeases.map((lease) => lease.lease_id)
    for (const leaseId of expiredLeaseIds) {
      await tx.execute(
        `UPDATE control_plane_leases
            SET status = 'expired',
                released_at = $2
          WHERE lease_id = $1
            AND status = 'active'`,
        [leaseId, dbTimestamp(now)],
      )
    }

    const tokenRow = await tx.queryOne<any>(
      `SELECT COALESCE(MAX(fencing_token), 0) AS max_token
         FROM control_plane_leases
        WHERE lease_scope_type = $1
          AND lease_scope_id = $2
          AND lease_purpose = $3`,
      [input.scopeType, input.scopeId, purpose],
    )
    const fencingToken = Number(tokenRow?.max_token ?? 0) + 1
    const leaseId = randomUUID()
    await tx.execute(
      `INSERT INTO control_plane_leases (
         lease_id, lease_scope_type, lease_scope_id, lease_purpose,
         holder_agent_id, holder_runtime_instance_id, holder_connector_instance_id,
         fencing_token, status, acquired_at, heartbeat_at, expires_at, metadata
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, 'active', $9, $9, $10, $11
       )`,
      [
        leaseId,
        input.scopeType,
        input.scopeId,
        purpose,
        input.holderAgentId ?? null,
        input.holderRuntimeInstanceId ?? null,
        input.holderConnectorInstanceId ?? null,
        fencingToken,
        dbTimestamp(now),
        dbTimestamp(expiresAt),
        JSON.stringify(input.metadata ?? {}),
      ],
    )
    const lease = await getLease(tx, leaseId)
    if (!lease) throw new Error('CONTROL_PLANE_LEASE_INSERT_NOT_FOUND')
    return { ok: true, lease, expiredLeaseIds }
  })
}

export async function verifyControlPlaneFence(
  db: DbAdapter,
  input: LeaseTokenInput,
): Promise<LeaseCheckResult> {
  const now = input.now ?? new Date()
  return classifyLeaseFailure(db, input, now)
}

export async function heartbeatControlPlaneLease(
  db: DbAdapter,
  input: LeaseTokenInput & { ttlMs: number },
): Promise<LeaseCheckResult> {
  if (!input.leaseId) throw new Error('CONTROL_PLANE_LEASE_ID_REQUIRED')
  assertLeaseTtl(input.ttlMs)
  const now = input.now ?? new Date()
  const expiresAt = addMs(now, input.ttlMs)

  const update = await db.execute(
    `UPDATE control_plane_leases
        SET heartbeat_at = $3,
            expires_at = $4
      WHERE lease_id = $1
        AND fencing_token = $2
        AND status = 'active'
        AND expires_at > $3
        AND ($5::text IS NULL OR holder_agent_id = $5::text)
        AND ($6::uuid IS NULL OR holder_runtime_instance_id = $6::uuid)
        AND ($7::uuid IS NULL OR holder_connector_instance_id = $7::uuid)`,
    [
      input.leaseId,
      Number(input.fencingToken),
      dbTimestamp(now),
      dbTimestamp(expiresAt),
      input.holderAgentId ?? null,
      input.holderRuntimeInstanceId ?? null,
      input.holderConnectorInstanceId ?? null,
    ],
  )
  if (update.rowCount !== 1) {
    return classifyLeaseFailure(db, input, now)
  }
  const lease = await getLease(db, input.leaseId)
  if (!lease) return { ok: false, reason: 'not_found', lease: null }
  return { ok: true, lease }
}

export async function releaseControlPlaneLease(
  db: DbAdapter,
  input: LeaseTokenInput,
): Promise<LeaseCheckResult> {
  const now = input.now ?? new Date()
  const update = await db.execute(
    `UPDATE control_plane_leases
        SET status = 'released',
            released_at = $3
      WHERE lease_id = $1
        AND fencing_token = $2
        AND status = 'active'
        AND expires_at > $3
        AND ($4::text IS NULL OR holder_agent_id = $4::text)
        AND ($5::uuid IS NULL OR holder_runtime_instance_id = $5::uuid)
        AND ($6::uuid IS NULL OR holder_connector_instance_id = $6::uuid)`,
    [
      input.leaseId,
      Number(input.fencingToken),
      dbTimestamp(now),
      input.holderAgentId ?? null,
      input.holderRuntimeInstanceId ?? null,
      input.holderConnectorInstanceId ?? null,
    ],
  )
  if (update.rowCount !== 1) {
    return classifyLeaseFailure(db, input, now)
  }
  const lease = await getLease(db, input.leaseId)
  if (!lease) return { ok: false, reason: 'not_found', lease: null }
  return { ok: true, lease }
}
