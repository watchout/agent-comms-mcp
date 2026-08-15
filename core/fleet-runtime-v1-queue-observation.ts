import { createHash } from 'node:crypto'
import { isAbsolute, normalize, resolve } from 'node:path'
import type { DbAdapter } from './db'

export const FLEET_RUNTIME_QUEUE_OBSERVATION_V2 = Object.freeze({
  schema_version: 'fleet-runtime-v1/observation/v2',
  contract_revision: 2,
  profile_binding_schema: 'fleet-runtime-v1/profile-binding/v1',
  environment_ref_name: 'DATABASE_URL',
  target_agent_id: 'kodama',
  executor_agent_id: 'aun-runtime-executor',
  freshness_max_ms: 300_000,
  future_skew_max_ms: 30_000,
  runtime_freshness_max_ms: 30_000,
})

export type FleetRuntimeQueueActiveStatus = 'pending' | 'received' | 'in_progress'

export interface FleetRuntimeQueueActiveRowV2 {
  id: string
  status: FleetRuntimeQueueActiveStatus
}

export interface FleetRuntimeObservationSourceV2 {
  dialect: 'postgres'
  database_name: string
  database_oid: string
  database_user: string
  system_identifier: string
  profile_binding_digest: string
  migration_epoch: string
}

export interface FleetRuntimeQueueStateV2 {
  agent_id: 'kodama'
  revision: string
  active_rows: FleetRuntimeQueueActiveRowV2[]
  active_rows_sha256: string
  pending_count: number
  received_count: number
  in_progress_count: number
  queue_observation_id: string
}

export interface FleetRuntimeExecutorProfileV2 {
  agent_id: 'aun-runtime-executor'
  agent_type: 'system'
  runtime: 'local_process'
  status: string
  profile_enabled: true
  profile_revision: number
  profile_source: string
}

export interface FleetRuntimeKodamaRegistryV2 {
  agent_id: 'kodama'
  agent_type: 'dev'
  runtime: 'TUI'
  status: string
  profile_enabled: true
  profile_revision: number
  home_directory: string
}

export interface FleetRuntimeLatestInstanceV2 {
  runtime_instance_id: string
  status: 'running' | 'stopped'
  session_name: string | null
  port: number | null
  checkout_path: string | null
  commit_sha: string | null
  started_at: string
  stopped_at: string | null
  last_seen_at: string
  git_dirty: boolean | null
}

export interface FleetRuntimeQueueObservationV2 {
  schema_version: 'fleet-runtime-v1/observation/v2'
  contract_revision: 2
  observed_at: string
  source: FleetRuntimeObservationSourceV2
  queue: FleetRuntimeQueueStateV2
  executor_profile: FleetRuntimeExecutorProfileV2
  kodama_registry: FleetRuntimeKodamaRegistryV2
  runtime_inventory: { latest_instance: FleetRuntimeLatestInstanceV2 | null }
}

export type FleetRuntimeObservationErrorCode =
  | 'QUEUE_OBSERVATION_DIALECT_MISMATCH'
  | 'QUEUE_OBSERVATION_SCHEMA_INACTIVE'
  | 'QUEUE_OBSERVATION_IDENTITY_MISMATCH'
  | 'QUEUE_OBSERVATION_INVALID'
  | 'QUEUE_OBSERVATION_STALE'
  | 'QUEUE_OBSERVATION_DRIFT'
  | 'QUEUE_OBSERVATION_POSTIMAGE_MISMATCH'

export class FleetRuntimeObservationError extends Error {
  constructor(readonly code: FleetRuntimeObservationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'FleetRuntimeObservationError'
  }
}

function fail(code: FleetRuntimeObservationErrorCode, message: string): never {
  throw new FleetRuntimeObservationError(code, message)
}

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('QUEUE_OBSERVATION_INVALID', `${label} must be an object`)
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (canonicalFleetRuntimeObservationJson(actual) !== canonicalFleetRuntimeObservationJson(expected)) {
    fail('QUEUE_OBSERVATION_INVALID', `${label} keys differ`)
  }
}

export function canonicalFleetRuntimeObservationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('QUEUE_OBSERVATION_INVALID', 'non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFleetRuntimeObservationJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalFleetRuntimeObservationJson(object[key])}`).join(',')}}`
}

export function digestFleetRuntimeObservationMaterial(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalFleetRuntimeObservationJson(value), 'utf8').digest('hex')}`
}

function decimal(value: unknown, label: string, positive = false): string {
  if (typeof value !== 'string') return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a decimal string`)
  const text = value
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || (positive && text === '0')) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a ${positive ? 'positive ' : ''}decimal string`)
  }
  return text
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a positive safe integer`)
  }
  return Number(value)
}

function counter(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a nonnegative safe integer`)
  }
  return Number(value)
}

function timestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null
  const text = value instanceof Date ? value.toISOString() : String(value ?? '')
  if (!text || !Number.isFinite(Date.parse(text))) return fail('QUEUE_OBSERVATION_INVALID', `${label} must be RFC3339`)
  return new Date(text).toISOString()
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a nonempty trimmed string`)
  }
  return value
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be sha256`)
  }
  return value
}

function absolutePath(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null
  const path = nonempty(value, label)
  if (!isAbsolute(path) || normalize(path) !== path || resolve(path) !== path) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be an absolute normalized path`)
  }
  return path
}

function booleanOrNull(value: unknown, label: string): boolean | null {
  if (value === null) return null
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fail('QUEUE_OBSERVATION_INVALID', `${label} must be boolean or null`)
}

function uuid(value: unknown, label: string): string {
  const text = nonempty(value, label)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(text)) {
    return fail('QUEUE_OBSERVATION_INVALID', `${label} must be a UUID`)
  }
  return text.toLowerCase()
}

export function fleetRuntimeProfileBindingMaterial(source: Omit<FleetRuntimeObservationSourceV2, 'profile_binding_digest' | 'migration_epoch'>) {
  return {
    schema_version: FLEET_RUNTIME_QUEUE_OBSERVATION_V2.profile_binding_schema,
    environment_ref_name: FLEET_RUNTIME_QUEUE_OBSERVATION_V2.environment_ref_name,
    dialect: 'postgres' as const,
    database_name: source.database_name,
    database_oid: source.database_oid,
    database_user: source.database_user,
    system_identifier: source.system_identifier,
  }
}

export function fleetRuntimeQueueObservationIdMaterial(
  source: FleetRuntimeObservationSourceV2,
  queue: Omit<FleetRuntimeQueueStateV2, 'queue_observation_id'>,
) {
  return {
    database_name: source.database_name,
    database_oid: source.database_oid,
    database_user: source.database_user,
    system_identifier: source.system_identifier,
    profile_binding_digest: source.profile_binding_digest,
    migration_epoch: source.migration_epoch,
    agent_id: queue.agent_id,
    revision: queue.revision,
    active_rows_sha256: queue.active_rows_sha256,
    pending_count: queue.pending_count,
    received_count: queue.received_count,
    in_progress_count: queue.in_progress_count,
  }
}

export interface ReadFleetRuntimeQueueObservationOptions {
  expectedDatabaseName?: string
}

export async function readFleetRuntimeQueueObservationV2(
  db: DbAdapter,
  options: ReadFleetRuntimeQueueObservationOptions = {},
): Promise<FleetRuntimeQueueObservationV2> {
  if (db.dialect !== 'postgres') return fail('QUEUE_OBSERVATION_DIALECT_MISMATCH', 'PostgreSQL is required')
  const expectedDatabaseName = options.expectedDatabaseName ?? 'agent_comms'
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await db.query("SET LOCAL statement_timeout = '5000ms'")
    const identity = await db.queryOne<any>(`
      SELECT current_database() AS database_name,
             (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS database_oid,
             current_user AS database_user,
             (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
             transaction_timestamp() AS observed_at,
             current_setting('transaction_isolation') AS transaction_isolation,
             current_setting('transaction_read_only')::boolean AS transaction_read_only,
             (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::integer AS statement_timeout_ms
    `)
    if (!identity || identity.database_name !== expectedDatabaseName) {
      return fail('QUEUE_OBSERVATION_IDENTITY_MISMATCH', 'database name differs from the exact binding')
    }
    if (identity.transaction_isolation !== 'repeatable read' || identity.transaction_read_only !== true
      || !Number.isSafeInteger(identity.statement_timeout_ms) || identity.statement_timeout_ms <= 0
      || identity.statement_timeout_ms > 5_000) {
      return fail('QUEUE_OBSERVATION_INVALID', 'transaction isolation, read-only mode, or observation timeout differs')
    }
    const marker = await db.queryOne<any>(`
      SELECT schema_version, contract_revision, migration_epoch::text AS migration_epoch
        FROM fleet_runtime_queue_observation_active
       WHERE singleton = true
    `)
    if (!marker || marker.schema_version !== FLEET_RUNTIME_QUEUE_OBSERVATION_V2.schema_version
      || Number(marker.contract_revision) !== FLEET_RUNTIME_QUEUE_OBSERVATION_V2.contract_revision) {
      return fail('QUEUE_OBSERVATION_SCHEMA_INACTIVE', 'exact v2 active marker is absent')
    }
    const revision = await db.queryOne<any>(`
      SELECT revision::text AS revision
        FROM fleet_runtime_queue_agent_revisions
       WHERE migration_epoch = $1::bigint AND agent_id = $2
    `, [marker.migration_epoch, FLEET_RUNTIME_QUEUE_OBSERVATION_V2.target_agent_id])
    if (!revision) return fail('QUEUE_OBSERVATION_SCHEMA_INACTIVE', 'Kodama revision row is absent')
    const activeRowsRaw = await db.query<any>(`
      SELECT id::text AS id, status
        FROM message_queue
       WHERE agent_id = $1 AND status IN ('pending', 'received', 'in_progress')
       ORDER BY id ASC
    `, [FLEET_RUNTIME_QUEUE_OBSERVATION_V2.target_agent_id])
    const profiles = await db.query<any>(`
      SELECT agent_id, agent_type, runtime, status, profile_enabled, profile_revision, profile_source, home_directory
        FROM agents
       WHERE agent_id IN ($1, $2)
       ORDER BY agent_id ASC
    `, [FLEET_RUNTIME_QUEUE_OBSERVATION_V2.executor_agent_id, FLEET_RUNTIME_QUEUE_OBSERVATION_V2.target_agent_id])
    const runtime = await db.queryOne<any>(`
      SELECT runtime_instance_id::text AS runtime_instance_id, status, session_name, port,
             checkout_path, commit_sha, started_at, stopped_at, last_seen_at,
             metadata->>'git_dirty' AS git_dirty
        FROM agent_runtime_instances
       WHERE agent_id = $1
       ORDER BY started_at DESC, runtime_instance_id DESC
       LIMIT 1
    `, [FLEET_RUNTIME_QUEUE_OBSERVATION_V2.target_agent_id])

    const databaseOid = decimal(identity.database_oid, 'source.database_oid', true)
    const systemIdentifier = decimal(identity.system_identifier, 'source.system_identifier', true)
    const databaseUser = nonempty(identity.database_user, 'source.database_user')
    const migrationEpoch = decimal(marker.migration_epoch, 'source.migration_epoch', true)
    const bindingBase = {
      dialect: 'postgres' as const,
      database_name: expectedDatabaseName,
      database_oid: databaseOid,
      database_user: databaseUser,
      system_identifier: systemIdentifier,
    }
    const source: FleetRuntimeObservationSourceV2 = {
      ...bindingBase,
      profile_binding_digest: digestFleetRuntimeObservationMaterial(fleetRuntimeProfileBindingMaterial(bindingBase)),
      migration_epoch: migrationEpoch,
    }
    const activeRows: FleetRuntimeQueueActiveRowV2[] = activeRowsRaw.map((row, index) => {
      const id = decimal(row.id, `queue.active_rows[${index}].id`, true)
      if (!['pending', 'received', 'in_progress'].includes(row.status)) {
        return fail('QUEUE_OBSERVATION_INVALID', `queue.active_rows[${index}].status is invalid`)
      }
      return { id, status: row.status }
    })
    for (let index = 1; index < activeRows.length; index += 1) {
      if (BigInt(activeRows[index - 1].id) >= BigInt(activeRows[index].id)) {
        return fail('QUEUE_OBSERVATION_INVALID', 'active queue rows are not strictly sorted')
      }
    }
    const counts = {
      pending_count: activeRows.filter(row => row.status === 'pending').length,
      received_count: activeRows.filter(row => row.status === 'received').length,
      in_progress_count: activeRows.filter(row => row.status === 'in_progress').length,
    }
    const queueWithoutId = {
      agent_id: 'kodama' as const,
      revision: decimal(revision.revision, 'queue.revision'),
      active_rows: activeRows,
      active_rows_sha256: digestFleetRuntimeObservationMaterial(activeRows),
      ...counts,
    }
    const queue: FleetRuntimeQueueStateV2 = {
      ...queueWithoutId,
      queue_observation_id: digestFleetRuntimeObservationMaterial(fleetRuntimeQueueObservationIdMaterial(source, queueWithoutId)),
    }
    const executor = profiles.find(row => row.agent_id === FLEET_RUNTIME_QUEUE_OBSERVATION_V2.executor_agent_id)
    const kodama = profiles.find(row => row.agent_id === FLEET_RUNTIME_QUEUE_OBSERVATION_V2.target_agent_id)
    if (!executor || !kodama) return fail('QUEUE_OBSERVATION_IDENTITY_MISMATCH', 'required profiles are absent')
    const executorProfile: FleetRuntimeExecutorProfileV2 = {
      agent_id: 'aun-runtime-executor',
      agent_type: executor.agent_type,
      runtime: executor.runtime,
      status: nonempty(executor.status, 'executor_profile.status'),
      profile_enabled: executor.profile_enabled,
      profile_revision: positiveInteger(executor.profile_revision, 'executor_profile.profile_revision'),
      profile_source: nonempty(executor.profile_source, 'executor_profile.profile_source'),
    }
    const kodamaRegistry: FleetRuntimeKodamaRegistryV2 = {
      agent_id: 'kodama',
      agent_type: kodama.agent_type,
      runtime: kodama.runtime,
      status: nonempty(kodama.status, 'kodama_registry.status'),
      profile_enabled: kodama.profile_enabled,
      profile_revision: positiveInteger(kodama.profile_revision, 'kodama_registry.profile_revision'),
      home_directory: absolutePath(kodama.home_directory, 'kodama_registry.home_directory')!,
    }
    if (executorProfile.agent_type !== 'system' || executorProfile.runtime !== 'local_process'
      || executorProfile.status === 'disabled' || executorProfile.profile_enabled !== true
      || kodamaRegistry.agent_type !== 'dev' || kodamaRegistry.runtime !== 'TUI'
      || kodamaRegistry.status === 'disabled' || kodamaRegistry.profile_enabled !== true) {
      return fail('QUEUE_OBSERVATION_IDENTITY_MISMATCH', 'required profile identity differs')
    }
    const latestInstance: FleetRuntimeLatestInstanceV2 | null = runtime ? {
      runtime_instance_id: uuid(runtime.runtime_instance_id, 'runtime_inventory.latest_instance.runtime_instance_id'),
      status: runtime.status,
      session_name: runtime.session_name === null ? null : nonempty(runtime.session_name, 'runtime_inventory.latest_instance.session_name'),
      port: runtime.port === null ? null : positiveInteger(runtime.port, 'runtime_inventory.latest_instance.port'),
      checkout_path: absolutePath(runtime.checkout_path, 'runtime_inventory.latest_instance.checkout_path', true),
      commit_sha: runtime.commit_sha === null ? null : String(runtime.commit_sha),
      started_at: timestamp(runtime.started_at, 'runtime_inventory.latest_instance.started_at')!,
      stopped_at: timestamp(runtime.stopped_at, 'runtime_inventory.latest_instance.stopped_at', true),
      last_seen_at: timestamp(runtime.last_seen_at, 'runtime_inventory.latest_instance.last_seen_at')!,
      git_dirty: booleanOrNull(runtime.git_dirty, 'runtime_inventory.latest_instance.git_dirty'),
    } : null
    if (latestInstance && (!['running', 'stopped'].includes(latestInstance.status)
      || (latestInstance.port !== null && latestInstance.port > 65535)
      || (latestInstance.commit_sha !== null && !/^[a-f0-9]{40}$/.test(latestInstance.commit_sha)))) {
      return fail('QUEUE_OBSERVATION_INVALID', 'latest runtime instance has an invalid status, port, or commit')
    }
    const observation: FleetRuntimeQueueObservationV2 = {
      schema_version: 'fleet-runtime-v1/observation/v2',
      contract_revision: 2,
      observed_at: timestamp(identity.observed_at, 'observed_at')!,
      source,
      queue,
      executor_profile: executorProfile,
      kodama_registry: kodamaRegistry,
      runtime_inventory: { latest_instance: latestInstance },
    }
    assertFleetRuntimeQueueObservationV2(observation, { expectedDatabaseName })
    await db.query('COMMIT')
    return observation
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

export function assertFleetRuntimeQueueObservationV2(
  value: unknown,
  options: ReadFleetRuntimeQueueObservationOptions = {},
): asserts value is FleetRuntimeQueueObservationV2 {
  record(value, 'observation')
  exactKeys(value, ['schema_version', 'contract_revision', 'observed_at', 'source', 'queue', 'executor_profile', 'kodama_registry', 'runtime_inventory'], 'observation')
  if (value.schema_version !== FLEET_RUNTIME_QUEUE_OBSERVATION_V2.schema_version
    || value.contract_revision !== FLEET_RUNTIME_QUEUE_OBSERVATION_V2.contract_revision) {
    return fail('QUEUE_OBSERVATION_INVALID', 'observation revision is not exact v2')
  }
  timestamp(value.observed_at, 'observed_at')
  record(value.source, 'source')
  exactKeys(value.source, ['dialect', 'database_name', 'database_oid', 'database_user', 'system_identifier', 'profile_binding_digest', 'migration_epoch'], 'source')
  if (value.source.dialect !== 'postgres') return fail('QUEUE_OBSERVATION_INVALID', 'source dialect must be postgres')
  const databaseName = nonempty(value.source.database_name, 'source.database_name')
  if (databaseName !== (options.expectedDatabaseName ?? 'agent_comms')) {
    return fail('QUEUE_OBSERVATION_IDENTITY_MISMATCH', 'source database name differs from the exact binding')
  }
  decimal(value.source.database_oid, 'source.database_oid', true)
  nonempty(value.source.database_user, 'source.database_user')
  decimal(value.source.system_identifier, 'source.system_identifier', true)
  sha(value.source.profile_binding_digest, 'source.profile_binding_digest')
  decimal(value.source.migration_epoch, 'source.migration_epoch', true)
  const bindingMaterial = fleetRuntimeProfileBindingMaterial({
    dialect: 'postgres', database_name: value.source.database_name as string,
    database_oid: value.source.database_oid as string, database_user: value.source.database_user as string,
    system_identifier: value.source.system_identifier as string,
  })
  if (value.source.profile_binding_digest !== digestFleetRuntimeObservationMaterial(bindingMaterial)) {
    return fail('QUEUE_OBSERVATION_INVALID', 'profile binding digest differs')
  }
  record(value.queue, 'queue')
  exactKeys(value.queue, ['agent_id', 'revision', 'active_rows', 'active_rows_sha256', 'pending_count', 'received_count', 'in_progress_count', 'queue_observation_id'], 'queue')
  if (value.queue.agent_id !== 'kodama' || !Array.isArray(value.queue.active_rows)) return fail('QUEUE_OBSERVATION_INVALID', 'queue identity differs')
  decimal(value.queue.revision, 'queue.revision')
  const rows = value.queue.active_rows as unknown[]
  rows.forEach((row, index) => {
    record(row, `queue.active_rows[${index}]`)
    exactKeys(row, ['id', 'status'], `queue.active_rows[${index}]`)
    decimal(row.id, `queue.active_rows[${index}].id`, true)
    if (!['pending', 'received', 'in_progress'].includes(String(row.status))) fail('QUEUE_OBSERVATION_INVALID', `queue.active_rows[${index}].status differs`)
    if (index > 0 && BigInt(String((rows[index - 1] as Record<string, unknown>).id)) >= BigInt(String(row.id))) {
      fail('QUEUE_OBSERVATION_INVALID', 'active rows are not strictly sorted')
    }
  })
  const pending = counter(value.queue.pending_count, 'queue.pending_count')
  const received = counter(value.queue.received_count, 'queue.received_count')
  const inProgress = counter(value.queue.in_progress_count, 'queue.in_progress_count')
  if (pending !== rows.filter(row => (row as Record<string, unknown>).status === 'pending').length
    || received !== rows.filter(row => (row as Record<string, unknown>).status === 'received').length
    || inProgress !== rows.filter(row => (row as Record<string, unknown>).status === 'in_progress').length
    || value.queue.active_rows_sha256 !== digestFleetRuntimeObservationMaterial(rows)) {
    return fail('QUEUE_OBSERVATION_INVALID', 'active row digest or counts differ')
  }
  const queueMaterial = { ...value.queue } as Record<string, unknown>
  delete queueMaterial.queue_observation_id
  if (value.queue.queue_observation_id !== digestFleetRuntimeObservationMaterial(
    fleetRuntimeQueueObservationIdMaterial(value.source as unknown as FleetRuntimeObservationSourceV2, queueMaterial as unknown as Omit<FleetRuntimeQueueStateV2, 'queue_observation_id'>),
  )) return fail('QUEUE_OBSERVATION_INVALID', 'queue observation id differs')
  record(value.executor_profile, 'executor_profile')
  exactKeys(value.executor_profile, ['agent_id', 'agent_type', 'runtime', 'status', 'profile_enabled', 'profile_revision', 'profile_source'], 'executor_profile')
  if (value.executor_profile.agent_id !== 'aun-runtime-executor' || value.executor_profile.agent_type !== 'system'
    || value.executor_profile.runtime !== 'local_process' || value.executor_profile.status === 'disabled'
    || value.executor_profile.profile_enabled !== true) return fail('QUEUE_OBSERVATION_INVALID', 'executor profile differs')
  nonempty(value.executor_profile.status, 'executor_profile.status')
  positiveInteger(value.executor_profile.profile_revision, 'executor_profile.profile_revision')
  nonempty(value.executor_profile.profile_source, 'executor_profile.profile_source')
  record(value.kodama_registry, 'kodama_registry')
  exactKeys(value.kodama_registry, ['agent_id', 'agent_type', 'runtime', 'status', 'profile_enabled', 'profile_revision', 'home_directory'], 'kodama_registry')
  if (value.kodama_registry.agent_id !== 'kodama' || value.kodama_registry.agent_type !== 'dev'
    || value.kodama_registry.runtime !== 'TUI' || value.kodama_registry.status === 'disabled'
    || value.kodama_registry.profile_enabled !== true) return fail('QUEUE_OBSERVATION_INVALID', 'Kodama registry differs')
  nonempty(value.kodama_registry.status, 'kodama_registry.status')
  positiveInteger(value.kodama_registry.profile_revision, 'kodama_registry.profile_revision')
  absolutePath(value.kodama_registry.home_directory, 'kodama_registry.home_directory')
  record(value.runtime_inventory, 'runtime_inventory')
  exactKeys(value.runtime_inventory, ['latest_instance'], 'runtime_inventory')
  if (value.runtime_inventory.latest_instance !== null) {
    const latest = value.runtime_inventory.latest_instance
    record(latest, 'runtime_inventory.latest_instance')
    exactKeys(latest, ['runtime_instance_id', 'status', 'session_name', 'port', 'checkout_path', 'commit_sha', 'started_at', 'stopped_at', 'last_seen_at', 'git_dirty'], 'runtime_inventory.latest_instance')
    uuid(latest.runtime_instance_id, 'runtime_inventory.latest_instance.runtime_instance_id')
    if (!['running', 'stopped'].includes(String(latest.status))) fail('QUEUE_OBSERVATION_INVALID', 'runtime_inventory.latest_instance.status differs')
    if (latest.session_name !== null) nonempty(latest.session_name, 'runtime_inventory.latest_instance.session_name')
    if (latest.port !== null && positiveInteger(latest.port, 'runtime_inventory.latest_instance.port') > 65535) {
      fail('QUEUE_OBSERVATION_INVALID', 'runtime_inventory.latest_instance.port exceeds 65535')
    }
    absolutePath(latest.checkout_path, 'runtime_inventory.latest_instance.checkout_path', true)
    if (latest.commit_sha !== null && (typeof latest.commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(latest.commit_sha))) {
      fail('QUEUE_OBSERVATION_INVALID', 'runtime_inventory.latest_instance.commit_sha differs')
    }
    timestamp(latest.started_at, 'runtime_inventory.latest_instance.started_at')
    timestamp(latest.stopped_at, 'runtime_inventory.latest_instance.stopped_at', true)
    timestamp(latest.last_seen_at, 'runtime_inventory.latest_instance.last_seen_at')
    if (latest.git_dirty !== null && typeof latest.git_dirty !== 'boolean') {
      fail('QUEUE_OBSERVATION_INVALID', 'runtime_inventory.latest_instance.git_dirty differs')
    }
  }
}

function freshness(observation: FleetRuntimeQueueObservationV2, nowMs: number): void {
  const observedMs = Date.parse(observation.observed_at)
  if (observedMs > nowMs + FLEET_RUNTIME_QUEUE_OBSERVATION_V2.future_skew_max_ms
    || nowMs - observedMs > FLEET_RUNTIME_QUEUE_OBSERVATION_V2.freshness_max_ms) {
    return fail('QUEUE_OBSERVATION_STALE', 'observation database timestamp is outside the freshness budget')
  }
}

function withoutObservedAt(observation: FleetRuntimeQueueObservationV2): unknown {
  const copy = structuredClone(observation) as Record<string, unknown>
  delete copy.observed_at
  return copy
}

export function assertFleetRuntimeSealToPreObservation(
  sealed: FleetRuntimeQueueObservationV2,
  pre: FleetRuntimeQueueObservationV2,
  nowMs = Date.now(),
): void {
  assertFleetRuntimeQueueObservationV2(sealed)
  assertFleetRuntimeQueueObservationV2(pre)
  freshness(sealed, nowMs)
  freshness(pre, nowMs)
  if (canonicalFleetRuntimeObservationJson(withoutObservedAt(sealed)) !== canonicalFleetRuntimeObservationJson(withoutObservedAt(pre))) {
    return fail('QUEUE_OBSERVATION_DRIFT', 'seal and pre-effect observation differ beyond observed_at')
  }
  if (pre.queue.pending_count !== 0 || pre.queue.received_count !== 0 || pre.queue.in_progress_count !== 0) {
    return fail('QUEUE_OBSERVATION_DRIFT', 'pre-effect queue is not zero')
  }
}

export function assertFleetRuntimePreToPostObservation(
  pre: FleetRuntimeQueueObservationV2,
  post: FleetRuntimeQueueObservationV2,
  input: { approvedStateRoot: string; canonicalCheckout: string; nowMs?: number },
): void {
  assertFleetRuntimeQueueObservationV2(pre)
  assertFleetRuntimeQueueObservationV2(post)
  const nowMs = input.nowMs ?? Date.now()
  freshness(pre, nowMs)
  freshness(post, nowMs)
  for (const key of ['source', 'queue', 'executor_profile', 'kodama_registry'] as const) {
    if (canonicalFleetRuntimeObservationJson(pre[key]) !== canonicalFleetRuntimeObservationJson(post[key])) {
      return fail('QUEUE_OBSERVATION_DRIFT', `${key} changed across the protected effect`)
    }
  }
  if (post.queue.pending_count !== 0 || post.queue.received_count !== 0 || post.queue.in_progress_count !== 0) {
    return fail('QUEUE_OBSERVATION_DRIFT', 'post-effect queue is not zero')
  }
  const latest = post.runtime_inventory.latest_instance
  if (!latest) return fail('QUEUE_OBSERVATION_POSTIMAGE_MISMATCH', 'post-effect runtime instance is absent')
  const priorId = pre.runtime_inventory.latest_instance?.runtime_instance_id ?? null
  const checkout = latest.checkout_path
  const approvedRoot = resolve(input.approvedStateRoot)
  if (latest.runtime_instance_id === priorId || latest.status !== 'running'
    || latest.session_name !== 'discord-kodama' || latest.port !== 8803
    || checkout === null || resolve(checkout) === resolve(input.canonicalCheckout)
    || !resolve(checkout).startsWith(`${approvedRoot}/`)
    || latest.stopped_at !== null || latest.git_dirty !== false
    || nowMs - Date.parse(latest.last_seen_at) > FLEET_RUNTIME_QUEUE_OBSERVATION_V2.runtime_freshness_max_ms
    || Date.parse(latest.last_seen_at) > nowMs + FLEET_RUNTIME_QUEUE_OBSERVATION_V2.future_skew_max_ms) {
    return fail('QUEUE_OBSERVATION_POSTIMAGE_MISMATCH', 'post-effect runtime identity differs')
  }
}
