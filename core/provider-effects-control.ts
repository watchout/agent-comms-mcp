import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const PROVIDER_EFFECTS_CONTROL_FILE_ENV = 'AGENT_COM_PROVIDER_EFFECTS_CONTROL_FILE'
export const PROVIDER_EFFECTS_CONTROL_SCHEMA = 'agent-comms/provider-effects-control/v1'
export const PROVIDER_EFFECTS_FORBIDDEN_CODE = 'PROVIDER_EFFECTS_FORBIDDEN'
export const PROVIDER_EFFECTS_FORBIDDEN_REASON = 'provider effects forbidden by host control'

const MAX_CONTROL_BYTES = 16 * 1024
const EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type ProviderEffectsControlMode = 'allowed' | 'forbidden'

export interface ProviderEffectsControlDecision {
  configured: boolean
  allowsProviderEffects: boolean
  mode: ProviderEffectsControlMode
  reason:
    | 'legacy_unconfigured'
    | 'control_allowed'
    | 'control_forbidden'
    | 'control_path_not_absolute'
    | 'control_unreadable'
    | 'control_too_large'
    | 'control_invalid_json'
    | 'control_invalid_shape'
    | 'control_invalid_schema'
    | 'control_invalid_epoch'
    | 'control_invalid_mode'
    | 'control_invalid_expiry'
    | 'control_expired'
  epoch: string | null
  expiresAt: string | null
  sourcePath: string | null
  contentSha256: string | null
  attestation: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function denied(
  reason: ProviderEffectsControlDecision['reason'],
  sourcePath: string | null,
  raw: string | null = null,
  epoch: string | null = null,
  expiresAt: string | null = null,
): ProviderEffectsControlDecision {
  const contentSha256 = raw === null ? null : sha256(raw)
  return {
    configured: true,
    allowsProviderEffects: false,
    mode: 'forbidden',
    reason,
    epoch,
    expiresAt,
    sourcePath,
    contentSha256,
    attestation: `deny:${reason}:${epoch ?? 'none'}:${contentSha256 ?? 'none'}`,
  }
}

export function parseProviderEffectsControl(
  raw: string,
  sourcePath: string,
  nowMs = Date.now(),
): ProviderEffectsControlDecision {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CONTROL_BYTES) {
    return denied('control_too_large', sourcePath)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return denied('control_invalid_json', sourcePath, raw)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return denied('control_invalid_shape', sourcePath, raw)
  }

  const value = parsed as Record<string, unknown>
  const expectedKeys = ['epoch', 'expires_at', 'provider_effects', 'schema_version']
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return denied('control_invalid_shape', sourcePath, raw)
  }
  if (value.schema_version !== PROVIDER_EFFECTS_CONTROL_SCHEMA) {
    return denied('control_invalid_schema', sourcePath, raw)
  }
  if (typeof value.epoch !== 'string' || !EPOCH_PATTERN.test(value.epoch)) {
    return denied('control_invalid_epoch', sourcePath, raw)
  }
  if (value.provider_effects !== 'allowed' && value.provider_effects !== 'forbidden') {
    return denied('control_invalid_mode', sourcePath, raw, value.epoch)
  }
  if (typeof value.expires_at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.expires_at)) {
    return denied('control_invalid_expiry', sourcePath, raw, value.epoch)
  }
  const expiresAtMs = Date.parse(value.expires_at)
  if (!Number.isFinite(expiresAtMs)) {
    return denied('control_invalid_expiry', sourcePath, raw, value.epoch)
  }
  if (expiresAtMs <= nowMs) {
    return denied('control_expired', sourcePath, raw, value.epoch, value.expires_at)
  }

  const contentSha256 = sha256(raw)
  const mode = value.provider_effects
  return {
    configured: true,
    allowsProviderEffects: mode === 'allowed',
    mode,
    reason: mode === 'allowed' ? 'control_allowed' : 'control_forbidden',
    epoch: value.epoch,
    expiresAt: value.expires_at,
    sourcePath,
    contentSha256,
    attestation: `${mode}:${value.epoch}:${contentSha256}`,
  }
}

/**
 * Read the host-shared provider-effects epoch at the exact effect boundary.
 * Unconfigured processes retain legacy behavior. Once configured, every
 * malformed, unreadable, or expired control fails closed.
 */
export function readProviderEffectsControl(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): ProviderEffectsControlDecision {
  const sourcePath = env[PROVIDER_EFFECTS_CONTROL_FILE_ENV]
  if (sourcePath === undefined) {
    return {
      configured: false,
      allowsProviderEffects: true,
      mode: 'allowed',
      reason: 'legacy_unconfigured',
      epoch: null,
      expiresAt: null,
      sourcePath: null,
      contentSha256: null,
      attestation: 'legacy-unconfigured',
    }
  }
  if (!isAbsolute(sourcePath)) return denied('control_path_not_absolute', sourcePath)

  let raw: string
  try {
    raw = readFileSync(sourcePath, 'utf8')
  } catch {
    return denied('control_unreadable', sourcePath)
  }
  return parseProviderEffectsControl(raw, sourcePath, nowMs)
}

export function providerEffectsControlAuditEvidence(
  decision: ProviderEffectsControlDecision,
): Record<string, unknown> {
  return {
    configured: decision.configured,
    mode: decision.mode,
    reason: decision.reason,
    epoch: decision.epoch,
    expires_at: decision.expiresAt,
    source_path: decision.sourcePath,
    content_sha256: decision.contentSha256,
    attestation: decision.attestation,
  }
}
