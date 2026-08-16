import { basename, isAbsolute } from 'node:path'
import {
  PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV,
  providerEffectsConsumerAttestationPath,
  readProviderEffectsConsumerAttestation,
  type ProviderEffectsConsumerAttestation,
  type ProviderEffectsConsumerAttestationReadResult,
} from './provider-effects-consumer-attestation'
import {
  readProviderEffectsControl,
  type ProviderEffectsControlDecision,
} from './provider-effects-control'

export const PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV = 'STATE_DAEMON_PROVIDER_EFFECTS_ZERO_PREFLIGHT'
export const PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV = 'STATE_DAEMON_PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_CONSUMERS'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ProviderEffectsActivationPreflightIssue = {
  code: string
  message: string
  pid?: number
  path?: string
}

export type ProviderEffectsActivationStaticResult = {
  requested: boolean
  ok: boolean
  issues: ProviderEffectsActivationPreflightIssue[]
  decision: ProviderEffectsControlDecision | null
  rootMessageId: string | null
  createdAfter: string | null
}

type StaticOptions = {
  nowMs?: number
  readControl?: (env: NodeJS.ProcessEnv, nowMs: number) => ProviderEffectsControlDecision
}

function csv(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim()).filter(Boolean)
}

function timezoneTimestamp(value: string | undefined): value is string {
  return typeof value === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function parseOutboundV2Fence(
  raw: string | undefined,
  nowMs: number,
): { ok: true; rootMessageId: string; createdAfter: string; expiresAt: string } | { ok: false; reason: string } {
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'missing' }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ok: false, reason: 'invalid_json' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' }
  }
  const value = parsed as Record<string, unknown>
  const expectedKeys = ['created_after', 'expires_at', 'root_message_ids', 'schema_version']
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, reason: 'invalid_shape' }
  }
  if (value.schema_version !== 'agent-comms/outbound-exact-correlation-fence/v2') {
    return { ok: false, reason: 'invalid_schema' }
  }
  if (!Array.isArray(value.root_message_ids)
      || value.root_message_ids.length !== 1
      || typeof value.root_message_ids[0] !== 'string'
      || !UUID_PATTERN.test(value.root_message_ids[0])) {
    return { ok: false, reason: 'invalid_root_message_id' }
  }
  if (!timezoneTimestamp(value.created_after as string | undefined)) {
    return { ok: false, reason: 'invalid_created_after' }
  }
  if (!timezoneTimestamp(value.expires_at as string | undefined)) {
    return { ok: false, reason: 'invalid_expires_at' }
  }
  const createdAfter = value.created_after as string
  const expiresAt = value.expires_at as string
  if (Date.parse(createdAfter) >= Date.parse(expiresAt) || Date.parse(expiresAt) <= nowMs) {
    return { ok: false, reason: 'invalid_interval' }
  }
  return {
    ok: true,
    rootMessageId: (value.root_message_ids[0] as string).toLowerCase(),
    createdAfter,
    expiresAt,
  }
}

export function providerEffectsZeroPreflightRequested(env: NodeJS.ProcessEnv): boolean {
  return env[PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV] === '1'
}

export function validateProviderEffectsZeroActivationConfig(
  env: NodeJS.ProcessEnv,
  options: StaticOptions = {},
): ProviderEffectsActivationStaticResult {
  const issues: ProviderEffectsActivationPreflightIssue[] = []
  const enabled = env[PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV]
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') {
    issues.push({ code: 'provider_effects_zero_preflight_flag_invalid', message: `${PROVIDER_EFFECTS_ZERO_PREFLIGHT_ENV} must be 0 or 1.` })
  }
  const allowEmpty = env[PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV]
  if (allowEmpty !== undefined && allowEmpty !== '0' && allowEmpty !== '1') {
    issues.push({ code: 'provider_effects_zero_allow_empty_flag_invalid', message: `${PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV} must be 0 or 1.` })
  }
  if (enabled !== '1') {
    return { requested: false, ok: issues.length === 0, issues, decision: null, rootMessageId: null, createdAfter: null }
  }

  const nowMs = options.nowMs ?? Date.now()
  const readControl = options.readControl ?? readProviderEffectsControl
  const decision = readControl(env, nowMs)
  if (!decision.configured || decision.reason !== 'control_forbidden' || decision.mode !== 'forbidden') {
    issues.push({
      code: 'provider_effects_zero_requires_valid_forbidden_control',
      message: 'Provider-zero activation requires one readable, unexpired, strict forbidden provider-effects control.',
      ...(decision.sourcePath ? { path: decision.sourcePath } : {}),
    })
  }

  const attestationDirectory = env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]
  if (!attestationDirectory || !isAbsolute(attestationDirectory)) {
    issues.push({
      code: 'provider_effects_zero_attestation_dir_invalid',
      message: `${PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV} must be an absolute path.`,
      ...(attestationDirectory ? { path: attestationDirectory } : {}),
    })
  }
  if (env.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED !== '1') {
    issues.push({ code: 'provider_effects_zero_requires_scheduler', message: 'Provider-zero activation requires the queue-work scheduler.' })
  }
  const fleetMode = env.STATE_DAEMON_QUEUE_WORK_FLEET_MODE
  if (fleetMode !== undefined && fleetMode !== '0') {
    issues.push({ code: 'provider_effects_zero_requires_fleet_off', message: 'Provider-zero activation must not use fleet mode.' })
  }
  if (csv(env.STATE_DAEMON_AGENT_ALLOWLIST).join(',') !== 'aun') {
    issues.push({ code: 'provider_effects_zero_requires_aun_only', message: 'Provider-zero activation requires the exact allowlist aun.' })
  }

  const queueIds = csv(env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS)
  if (queueIds.length !== 1 || !/^[1-9]\d*$/.test(queueIds[0] ?? '')) {
    issues.push({ code: 'provider_effects_zero_requires_single_queue', message: 'Provider-zero activation requires exactly one positive queue id.' })
  }
  const messageIds = csv(env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  if (messageIds.length !== 1 || !UUID_PATTERN.test(messageIds[0] ?? '')) {
    issues.push({ code: 'provider_effects_zero_requires_single_message', message: 'Provider-zero activation requires exactly one UUID message id.' })
  }
  const createdAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER
  if (!timezoneTimestamp(createdAfter)) {
    issues.push({ code: 'provider_effects_zero_created_after_invalid', message: 'Provider-zero activation requires one timezone-qualified created-after timestamp.' })
  }

  const outboundFence = parseOutboundV2Fence(env.OUTBOUND_QUEUE_EXACT_FENCE, nowMs)
  if (!outboundFence.ok) {
    issues.push({ code: 'provider_effects_zero_outbound_fence_invalid', message: `Provider-zero activation requires a strict outbound v2 fence (${outboundFence.reason}).` })
  } else {
    if ((messageIds[0] ?? '').toLowerCase() !== outboundFence.rootMessageId) {
      issues.push({ code: 'provider_effects_zero_outbound_root_mismatch', message: 'Queue message fence and outbound root must match exactly.' })
    }
    if (createdAfter !== outboundFence.createdAfter) {
      issues.push({ code: 'provider_effects_zero_created_after_mismatch', message: 'Queue and outbound created-after timestamps must match exactly.' })
    }
    if (decision.expiresAt && Date.parse(decision.expiresAt) < Date.parse(outboundFence.expiresAt)) {
      issues.push({ code: 'provider_effects_zero_control_expires_too_soon', message: 'Provider deny epoch must cover the complete outbound fence interval.' })
    }
  }

  return {
    requested: true,
    ok: issues.length === 0,
    issues,
    decision,
    rootMessageId: outboundFence.ok ? outboundFence.rootMessageId : null,
    createdAfter: outboundFence.ok ? outboundFence.createdAfter : null,
  }
}

export type ProviderConsumerProcess = { pid: number; command: string }

const BUN_OPTIONS_WITH_VALUE = new Set([
  '--config',
  '--conditions',
  '--console-depth',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--cron-period',
  '--cron-title',
  '--cwd',
  '--define',
  '--dns-result-order',
  '--drop',
  '--elide-lines',
  '--env-file',
  '--extension-order',
  '--feature',
  '--fetch-preconnect',
  '--filter',
  '--heap-prof-dir',
  '--heap-prof-name',
  '--import',
  '--inspect',
  '--inspect-brk',
  '--inspect-wait',
  '--install',
  '--jsx-factory',
  '--jsx-fragment',
  '--jsx-import-source',
  '--jsx-runtime',
  '--loader',
  '--main-fields',
  '--max-http-header-size',
  '--port',
  '--preload',
  '--require',
  '--shell',
  '--title',
  '--tsconfig-override',
  '--unhandled-rejections',
  '--user-agent',
  '-F',
  '-c',
  '-d',
  '-l',
  '-r',
])

function bunEntrypoint(tokens: string[], startIndex: number): string | null {
  let index = startIndex
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print'
        || token.startsWith('-e=') || token.startsWith('--eval=')
        || token.startsWith('-p=') || token.startsWith('--print=')) {
      return null
    }
    if (token === '--') return tokens[index + 1] ?? null
    if (!token.startsWith('-')) return token
    if (token.includes('=')) {
      index++
      continue
    }
    index += BUN_OPTIONS_WITH_VALUE.has(token) ? 2 : 1
  }
  return null
}

/** Parse `ps -axo pid=,comm=,command=` without matching prompts that merely mention server.ts. */
export function parseBunServerProcessInventory(raw: string): ProviderConsumerProcess[] {
  const byPid = new Map<number, ProviderConsumerProcess>()
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/)
    if (!match) continue
    const pid = Number.parseInt(match[1], 10)
    const command = match[3].trim()
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const tokens = command.split(/\s+/)
    // macOS truncates the `comm` column (for example to
    // `/Users/yuji/.bun`), so executable identity must come from the first
    // untruncated command token. Exact Bun/server.ts token positions still
    // exclude Codex prompts and shell arguments that merely mention the file.
    if (tokens.length < 2 || basename(tokens[0]) !== 'bun') continue
    let index = 1
    let entrypoint = bunEntrypoint(tokens, index)
    if (entrypoint === 'run') {
      index = tokens.indexOf(entrypoint, index) + 1
      entrypoint = bunEntrypoint(tokens, index)
    }
    if (basename(entrypoint ?? '') !== 'server.ts') continue
    byPid.set(pid, { pid, command })
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid)
}

export type ProviderEffectsActivationPreflightResult = ProviderEffectsActivationStaticResult & {
  consumerPids: number[]
  attestations: ProviderEffectsConsumerAttestation[]
}

type RuntimeOptions = StaticOptions & {
  sampleProcesses: () => string | Promise<string>
  waitBetweenSamples?: () => void | Promise<void>
  readAttestation?: typeof readProviderEffectsConsumerAttestation
  now?: () => number
}

export async function runProviderEffectsZeroActivationPreflight(
  env: NodeJS.ProcessEnv,
  options: RuntimeOptions,
): Promise<ProviderEffectsActivationPreflightResult> {
  const now = options.now ?? (() => Date.now())
  const firstNow = now()
  const staticResult = validateProviderEffectsZeroActivationConfig(env, { ...options, nowMs: firstNow })
  const issues = [...staticResult.issues]
  if (!staticResult.requested || !staticResult.ok || !staticResult.decision) {
    return { ...staticResult, issues, consumerPids: [], attestations: [] }
  }

  const first = parseBunServerProcessInventory(await options.sampleProcesses())
  await options.waitBetweenSamples?.()
  const second = parseBunServerProcessInventory(await options.sampleProcesses())
  const firstPids = first.map(item => item.pid)
  const secondPids = second.map(item => item.pid)
  if (firstPids.join(',') !== secondPids.join(',')) {
    issues.push({
      code: 'provider_effects_consumer_inventory_unstable',
      message: `Provider consumer PID inventory changed during preflight (${firstPids.join(',')} -> ${secondPids.join(',')}).`,
    })
  }
  if (secondPids.length === 0 && env[PROVIDER_EFFECTS_ZERO_ALLOW_EMPTY_ENV] !== '1') {
    issues.push({ code: 'provider_effects_consumer_inventory_empty', message: 'An empty consumer inventory requires an explicit zero-consumer assertion.' })
  }

  const attestations: ProviderEffectsConsumerAttestation[] = []
  const directory = env[PROVIDER_EFFECTS_CONSUMER_ATTESTATION_DIR_ENV]!
  const readAttestation = options.readAttestation ?? readProviderEffectsConsumerAttestation
  const attestationNow = now()
  for (const process of second) {
    const path = providerEffectsConsumerAttestationPath(directory, process.pid)
    const result: ProviderEffectsConsumerAttestationReadResult = readAttestation(path, {
      nowMs: attestationNow,
      expectedPid: process.pid,
      expectedControlAttestation: staticResult.decision.attestation,
    })
    if (!result.ok) {
      issues.push({
        code: 'provider_effects_consumer_attestation_invalid',
        message: `Provider consumer ${process.pid} has no fresh matching attestation (${result.reason}).`,
        pid: process.pid,
        path,
      })
      continue
    }
    const record = result.record
    if (record.provider_effects_mode !== 'forbidden'
        || record.provider_control_reason !== 'control_forbidden'
        || record.provider_control_source_path !== staticResult.decision.sourcePath
        || record.provider_control_content_sha256 !== staticResult.decision.contentSha256
        || record.provider_control_epoch !== staticResult.decision.epoch
        || record.provider_control_expires_at !== staticResult.decision.expiresAt) {
      issues.push({
        code: 'provider_effects_consumer_attestation_identity_mismatch',
        message: `Provider consumer ${process.pid} attests a different provider-control identity.`,
        pid: process.pid,
        path,
      })
      continue
    }
    attestations.push(record)
  }

  const finalNow = now()
  const readControl = options.readControl ?? readProviderEffectsControl
  const finalDecision = readControl(env, finalNow)
  if (finalDecision.reason !== 'control_forbidden'
      || finalDecision.attestation !== staticResult.decision.attestation
      || finalDecision.sourcePath !== staticResult.decision.sourcePath) {
    issues.push({ code: 'provider_effects_control_changed_during_preflight', message: 'Provider-effects control changed during activation preflight.' })
  }

  return {
    ...staticResult,
    ok: issues.length === 0,
    issues,
    consumerPids: secondPids,
    attestations,
  }
}
