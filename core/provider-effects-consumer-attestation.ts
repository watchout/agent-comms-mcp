import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { ProviderEffectsControlDecision } from './provider-effects-control'

export const PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV =
  'AGENT_COM_PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR'
export const PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA =
  'agent-comms/provider-effects-consumer-attestation/v1'
export const PROVIDER_EFFECTS_CONSUMER_ATTESTATION_MAX_AGE_MS = 5_000

const MAX_ATTESTATION_BYTES = 16 * 1024
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const CONFIGURED_REASONS = new Set<ProviderEffectsControlDecision['reason']>([
  'control_allowed',
  'control_forbidden',
  'control_path_not_absolute',
  'control_unreadable',
  'control_too_large',
  'control_invalid_json',
  'control_invalid_shape',
  'control_invalid_schema',
  'control_invalid_epoch',
  'control_invalid_mode',
  'control_invalid_expiry',
  'control_expired',
])

export interface ProviderEffectsConsumerAttestation {
  schema_version: typeof PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA
  agent_id: string
  pid: number
  observed_at: string
  provider_effects_mode: ProviderEffectsControlDecision['mode']
  provider_control_reason: Exclude<ProviderEffectsControlDecision['reason'], 'legacy_unconfigured'>
  provider_control_epoch: string | null
  provider_control_expires_at: string | null
  provider_control_source_path: string
  provider_control_content_sha256: string | null
  provider_control_attestation: string
}

export type ProviderEffectsConsumerAttestationInvalidReason =
  | 'invalid_json'
  | 'invalid_shape'
  | 'invalid_schema'
  | 'invalid_agent_id'
  | 'invalid_pid'
  | 'invalid_observed_at'
  | 'invalid_mode'
  | 'invalid_reason'
  | 'invalid_epoch'
  | 'invalid_expires_at'
  | 'invalid_source_path'
  | 'invalid_content_sha256'
  | 'invalid_control_attestation'
  | 'future_observation'
  | 'stale_observation'
  | 'agent_id_mismatch'
  | 'pid_mismatch'
  | 'control_attestation_mismatch'

export type ProviderEffectsConsumerAttestationParseResult =
  | { ok: true; record: ProviderEffectsConsumerAttestation }
  | { ok: false; reason: ProviderEffectsConsumerAttestationInvalidReason }

export interface ParseProviderEffectsConsumerAttestationOptions {
  nowMs?: number
  maxAgeMs?: number | null
  expectedAgentId?: string
  expectedPid?: number
  expectedControlAttestation?: string
}

function validTimezoneTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function expectedControlAttestation(record: {
  provider_effects_mode: ProviderEffectsControlDecision['mode']
  provider_control_reason: ProviderEffectsControlDecision['reason']
  provider_control_epoch: string | null
  provider_control_content_sha256: string | null
}): string {
  if (record.provider_control_reason === 'control_allowed'
      || record.provider_control_reason === 'control_forbidden') {
    return `${record.provider_effects_mode}:${record.provider_control_epoch ?? 'none'}:${record.provider_control_content_sha256 ?? 'none'}`
  }
  return `deny:${record.provider_control_reason}:${record.provider_control_epoch ?? 'none'}:${record.provider_control_content_sha256 ?? 'none'}`
}

export function parseProviderEffectsConsumerAttestation(
  raw: string,
  options: ParseProviderEffectsConsumerAttestationOptions = {},
): ProviderEffectsConsumerAttestationParseResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) {
    return { ok: false, reason: 'invalid_shape' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' }
  }

  const value = parsed as Record<string, unknown>
  const expectedKeys = [
    'agent_id',
    'observed_at',
    'pid',
    'provider_control_attestation',
    'provider_control_content_sha256',
    'provider_control_epoch',
    'provider_control_expires_at',
    'provider_control_reason',
    'provider_control_source_path',
    'provider_effects_mode',
    'schema_version',
  ]
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, reason: 'invalid_shape' }
  }
  if (value.schema_version !== PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA) {
    return { ok: false, reason: 'invalid_schema' }
  }
  if (typeof value.agent_id !== 'string' || !AGENT_ID_PATTERN.test(value.agent_id)) {
    return { ok: false, reason: 'invalid_agent_id' }
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    return { ok: false, reason: 'invalid_pid' }
  }
  if (!validTimezoneTimestamp(value.observed_at)
      || new Date(Date.parse(value.observed_at)).toISOString() !== value.observed_at) {
    return { ok: false, reason: 'invalid_observed_at' }
  }
  if (value.provider_effects_mode !== 'allowed' && value.provider_effects_mode !== 'forbidden') {
    return { ok: false, reason: 'invalid_mode' }
  }
  if (typeof value.provider_control_reason !== 'string'
      || !CONFIGURED_REASONS.has(value.provider_control_reason as ProviderEffectsControlDecision['reason'])) {
    return { ok: false, reason: 'invalid_reason' }
  }
  if (value.provider_control_epoch !== null
      && (typeof value.provider_control_epoch !== 'string' || !EPOCH_PATTERN.test(value.provider_control_epoch))) {
    return { ok: false, reason: 'invalid_epoch' }
  }
  if (value.provider_control_expires_at !== null
      && !validTimezoneTimestamp(value.provider_control_expires_at)) {
    return { ok: false, reason: 'invalid_expires_at' }
  }
  if (typeof value.provider_control_source_path !== 'string'
      || value.provider_control_source_path.length === 0) {
    return { ok: false, reason: 'invalid_source_path' }
  }
  if (value.provider_control_content_sha256 !== null
      && (typeof value.provider_control_content_sha256 !== 'string'
        || !SHA256_PATTERN.test(value.provider_control_content_sha256))) {
    return { ok: false, reason: 'invalid_content_sha256' }
  }
  if (typeof value.provider_control_attestation !== 'string'
      || value.provider_control_attestation.length === 0
      || value.provider_control_attestation.length > 512) {
    return { ok: false, reason: 'invalid_control_attestation' }
  }

  const record = value as unknown as ProviderEffectsConsumerAttestation
  if (record.provider_control_attestation !== expectedControlAttestation(record)) {
    return { ok: false, reason: 'invalid_control_attestation' }
  }
  if ((record.provider_control_reason === 'control_allowed') !== (record.provider_effects_mode === 'allowed')) {
    return { ok: false, reason: 'invalid_reason' }
  }
  if ((record.provider_control_reason === 'control_allowed'
      || record.provider_control_reason === 'control_forbidden')
      && (record.provider_control_epoch === null
        || record.provider_control_expires_at === null
        || record.provider_control_content_sha256 === null)) {
    return { ok: false, reason: 'invalid_reason' }
  }

  const nowMs = options.nowMs ?? Date.now()
  const observedAtMs = Date.parse(record.observed_at)
  const maxAgeMs = options.maxAgeMs === undefined
    ? PROVIDER_EFFECTS_CONSUMER_ATTESTATION_MAX_AGE_MS
    : options.maxAgeMs
  if (observedAtMs > nowMs) return { ok: false, reason: 'future_observation' }
  if (maxAgeMs !== null && nowMs - observedAtMs > maxAgeMs) {
    return { ok: false, reason: 'stale_observation' }
  }
  if (options.expectedAgentId !== undefined && record.agent_id !== options.expectedAgentId) {
    return { ok: false, reason: 'agent_id_mismatch' }
  }
  if (options.expectedPid !== undefined && record.pid !== options.expectedPid) {
    return { ok: false, reason: 'pid_mismatch' }
  }
  if (options.expectedControlAttestation !== undefined
      && record.provider_control_attestation !== options.expectedControlAttestation) {
    return { ok: false, reason: 'control_attestation_mismatch' }
  }
  return { ok: true, record }
}

export type ProviderEffectsConsumerAttestationReadResult =
  | { ok: true; path: string; record: ProviderEffectsConsumerAttestation }
  | { ok: false; path: string; reason: 'path_not_absolute' | 'unreadable' | 'too_large' | ProviderEffectsConsumerAttestationInvalidReason }

export function readProviderEffectsConsumerAttestation(
  path: string,
  options: ParseProviderEffectsConsumerAttestationOptions = {},
): ProviderEffectsConsumerAttestationReadResult {
  if (!isAbsolute(path)) return { ok: false, path, reason: 'path_not_absolute' }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, path, reason: 'unreadable' }
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_ATTESTATION_BYTES) {
    return { ok: false, path, reason: 'too_large' }
  }
  const parsed = parseProviderEffectsConsumerAttestation(raw, options)
  return parsed.ok
    ? { ok: true, path, record: parsed.record }
    : { ok: false, path, reason: parsed.reason }
}

export interface ProviderEffectsConsumerAttestationContext {
  env?: NodeJS.ProcessEnv
  pid?: number
  nowMs?: number
}

export type ProviderEffectsConsumerAttestationRefreshResult =
  | { ok: true; required: false; path: null; record: null }
  | { ok: true; required: true; path: string; record: ProviderEffectsConsumerAttestation }
  | {
      ok: false
      required: true
      path: string | null
      reason:
        | 'attestation_dir_unconfigured'
        | 'attestation_dir_not_absolute'
        | 'attestation_dir_invalid'
        | 'invalid_agent_id'
        | 'invalid_pid'
        | 'invalid_control_decision'
        | 'attestation_write_failed'
        | 'attestation_readback_failed'
    }

export function providerEffectsConsumerAttestationPath(directory: string, pid: number): string {
  return join(directory, `consumer-${pid}.json`)
}

export function refreshProviderEffectsConsumerAttestation(
  decision: ProviderEffectsControlDecision,
  agentId: string,
  context: ProviderEffectsConsumerAttestationContext = {},
): ProviderEffectsConsumerAttestationRefreshResult {
  if (!decision.configured) return { ok: true, required: false, path: null, record: null }

  const env = context.env ?? process.env
  const pid = context.pid ?? process.pid
  const nowMs = context.nowMs ?? Date.now()
  const directory = env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
  if (directory === undefined || directory.trim() === '') {
    return { ok: false, required: true, path: null, reason: 'attestation_dir_unconfigured' }
  }
  if (!isAbsolute(directory)) {
    return { ok: false, required: true, path: null, reason: 'attestation_dir_not_absolute' }
  }
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return { ok: false, required: true, path: null, reason: 'invalid_agent_id' }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, required: true, path: null, reason: 'invalid_pid' }
  }
  if (decision.sourcePath === null || decision.sourcePath.length === 0) {
    return { ok: false, required: true, path: null, reason: 'invalid_control_decision' }
  }

  const record: ProviderEffectsConsumerAttestation = {
    schema_version: PROVIDER_EFFECTS_CONSUMER_ATTESTATION_SCHEMA,
    agent_id: agentId,
    pid,
    observed_at: new Date(nowMs).toISOString(),
    provider_effects_mode: decision.mode,
    provider_control_reason: decision.reason as Exclude<ProviderEffectsControlDecision['reason'], 'legacy_unconfigured'>,
    provider_control_epoch: decision.epoch,
    provider_control_expires_at: decision.expiresAt,
    provider_control_source_path: decision.sourcePath,
    provider_control_content_sha256: decision.contentSha256,
    provider_control_attestation: decision.attestation,
  }
  const validated = parseProviderEffectsConsumerAttestation(JSON.stringify(record), {
    nowMs,
    expectedAgentId: agentId,
    expectedPid: pid,
    expectedControlAttestation: decision.attestation,
  })
  if (!validated.ok) {
    return { ok: false, required: true, path: null, reason: 'invalid_control_decision' }
  }

  const finalPath = providerEffectsConsumerAttestationPath(directory, pid)
  const temporaryPath = join(directory, `.consumer-${pid}.${nowMs}.tmp`)
  let fileDescriptor: number | null = null
  let directoryDescriptor: number | null = null
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return { ok: false, required: true, path: finalPath, reason: 'attestation_dir_invalid' }
    }
    chmodSync(directory, 0o700)

    fileDescriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    chmodSync(temporaryPath, 0o600)
    writeFileSync(fileDescriptor, `${JSON.stringify(record)}\n`, 'utf8')
    fsyncSync(fileDescriptor)
    closeSync(fileDescriptor)
    fileDescriptor = null
    renameSync(temporaryPath, finalPath)

    directoryDescriptor = openSync(directory, constants.O_RDONLY)
    fsyncSync(directoryDescriptor)
    closeSync(directoryDescriptor)
    directoryDescriptor = null
  } catch {
    if (fileDescriptor !== null) {
      try { closeSync(fileDescriptor) } catch {}
    }
    if (directoryDescriptor !== null) {
      try { closeSync(directoryDescriptor) } catch {}
    }
    try { unlinkSync(temporaryPath) } catch {}
    return { ok: false, required: true, path: finalPath, reason: 'attestation_write_failed' }
  }

  const readback = readProviderEffectsConsumerAttestation(finalPath, {
    nowMs,
    expectedAgentId: agentId,
    expectedPid: pid,
    expectedControlAttestation: decision.attestation,
  })
  if (!readback.ok) {
    return { ok: false, required: true, path: finalPath, reason: 'attestation_readback_failed' }
  }
  return { ok: true, required: true, path: finalPath, record: readback.record }
}

export interface RemoveProviderEffectsConsumerAttestationOptions {
  env?: NodeJS.ProcessEnv
  pid?: number
  agentId?: string
  path?: string
}

/** Best-effort cleanup that only removes a strict record owned by this PID. */
export function removeProviderEffectsConsumerAttestation(
  options: RemoveProviderEffectsConsumerAttestationOptions = {},
): boolean {
  const pid = options.pid ?? process.pid
  const agentId = options.agentId
  const directory = (options.env ?? process.env)[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
  const path = options.path ?? (
    directory && isAbsolute(directory)
      ? providerEffectsConsumerAttestationPath(directory, pid)
      : null
  )
  if (path === null || !isAbsolute(path)) return false

  const readback = readProviderEffectsConsumerAttestation(path, {
    maxAgeMs: null,
    expectedPid: pid,
    ...(agentId === undefined ? {} : { expectedAgentId: agentId }),
  })
  if (!readback.ok) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}
