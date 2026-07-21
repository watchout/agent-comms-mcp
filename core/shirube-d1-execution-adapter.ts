import { createHash } from 'node:crypto'

export interface D1AuthorizationEnvelope {
  control_source: string
  handoff_id: string
  exact_base_sha: string
  allowed_paths: readonly string[]
  authorization_digest: string
}

export interface D1ExecutionState {
  handoff_id: string
  authorization_digest: string
  claim_key: string
  invocation_key: string | null
  internal_reply_receipt: string | null
  github_writeback_receipt: string | null
  external_send_receipt: string | null
}

type D1Effect = 'internal_reply' | 'github_writeback' | 'external_send'

interface D1PersistencePort {
  load(key: string): Promise<D1ExecutionState | null>
  persist_once(state: D1ExecutionState): Promise<D1ExecutionState>
}

interface D1EffectPort {
  perform(state: Readonly<D1ExecutionState>): Promise<string>
}

export interface D1ExecutionPorts {
  claim_persistence: D1PersistencePort
  invocation_persistence: D1PersistencePort
  internal_reply: D1EffectPort
  github_writeback: D1EffectPort
  external_send: D1EffectPort
}

export class D1AuthorizationError extends Error {
  constructor(
    readonly code: 'MISSING_AUTHORIZATION' | 'AUTHORIZATION_DIGEST_MISMATCH',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'D1AuthorizationError'
  }
}

type D1AuthorizationFields = Pick<
  D1AuthorizationEnvelope,
  'control_source' | 'handoff_id' | 'exact_base_sha' | 'allowed_paths'
>

function canonicalAuthorizationFields(envelope: D1AuthorizationFields): {
  allowed_paths: string[]
  control_source: string
  exact_base_sha: string
  handoff_id: string
} {
  return {
    allowed_paths: [...new Set(envelope.allowed_paths)].sort(),
    control_source: envelope.control_source,
    exact_base_sha: envelope.exact_base_sha,
    handoff_id: envelope.handoff_id,
  }
}

export function computeD1AuthorizationDigest(
  envelope: D1AuthorizationFields,
): string {
  const canonical = canonicalAuthorizationFields(envelope)
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

function missingAuthorization(message: string): never {
  throw new D1AuthorizationError('MISSING_AUTHORIZATION', message)
}

function digestMismatch(message: string): never {
  throw new D1AuthorizationError('AUTHORIZATION_DIGEST_MISMATCH', message)
}

function exactNonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return missingAuthorization(`${field} must be a trimmed nonempty string`)
  }
  return value
}

function assertAuthorization(
  envelope: D1AuthorizationEnvelope | null | undefined,
): asserts envelope is D1AuthorizationEnvelope {
  if (!envelope || typeof envelope !== 'object') {
    return missingAuthorization('authorization envelope is required')
  }
  exactNonemptyString(envelope.control_source, 'control_source')
  exactNonemptyString(envelope.handoff_id, 'handoff_id')
  const base = exactNonemptyString(envelope.exact_base_sha, 'exact_base_sha')
  if (!/^[0-9a-f]{40}$/.test(base)) {
    return missingAuthorization('exact_base_sha must be a lowercase 40-hex commit SHA')
  }
  if (!Array.isArray(envelope.allowed_paths) || envelope.allowed_paths.length === 0) {
    return missingAuthorization('allowed_paths must be a nonempty array')
  }
  envelope.allowed_paths.forEach((path, index) => {
    exactNonemptyString(path, `allowed_paths[${index}]`)
  })
  const suppliedDigest = exactNonemptyString(envelope.authorization_digest, 'authorization_digest')
  if (!/^[0-9a-f]{64}$/.test(suppliedDigest)) {
    return missingAuthorization('authorization_digest must be a lowercase SHA-256 digest')
  }
  const recomputedDigest = computeD1AuthorizationDigest(envelope)
  if (suppliedDigest !== recomputedDigest) {
    return digestMismatch('authorization_digest does not match the canonical authorization fields')
  }
}

function exactKey(value: string, field: 'claim_key' | 'invocation_key'): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a trimmed nonempty string`)
  }
  return value
}

function assertStateAuthorization(
  state: D1ExecutionState,
  envelope: D1AuthorizationEnvelope,
  claimKey: string,
): void {
  if (
    state.handoff_id !== envelope.handoff_id
    || state.authorization_digest !== envelope.authorization_digest
    || state.claim_key !== claimKey
  ) {
    return digestMismatch('persisted execution state does not match the authorization envelope and claim key')
  }
}

function receiptFor(state: D1ExecutionState, effect: D1Effect): string | null {
  if (effect === 'internal_reply') return state.internal_reply_receipt
  if (effect === 'github_writeback') return state.github_writeback_receipt
  return state.external_send_receipt
}

function receiptCount(state: D1ExecutionState): number {
  return [
    state.internal_reply_receipt,
    state.github_writeback_receipt,
    state.external_send_receipt,
  ].filter(receipt => receipt !== null).length
}

function assertInvocationReplay(
  state: D1ExecutionState,
  envelope: D1AuthorizationEnvelope,
  claimedState: D1ExecutionState,
  invocationKey: string,
  effect: D1Effect,
): void {
  assertStateAuthorization(state, envelope, claimedState.claim_key)
  if (state.invocation_key !== invocationKey) {
    throw new Error('INVOCATION_KEY_MISMATCH: persisted invocation uses another key')
  }
  if (receiptCount(state) !== 1 || receiptFor(state, effect) === null) {
    throw new Error('INVOCATION_EFFECT_MISMATCH: an invocation receipt cannot satisfy another effect channel')
  }
}

export async function claimD1Execution(
  envelope: D1AuthorizationEnvelope | null | undefined,
  claimKey: string,
  ports: D1ExecutionPorts,
): Promise<D1ExecutionState> {
  assertAuthorization(envelope)
  const exactClaimKey = exactKey(claimKey, 'claim_key')

  const existing = await ports.claim_persistence.load(exactClaimKey)
  if (existing) {
    assertStateAuthorization(existing, envelope, exactClaimKey)
    return existing
  }

  const claimed: D1ExecutionState = {
    handoff_id: envelope.handoff_id,
    authorization_digest: envelope.authorization_digest,
    claim_key: exactClaimKey,
    invocation_key: null,
    internal_reply_receipt: null,
    github_writeback_receipt: null,
    external_send_receipt: null,
  }
  const persisted = await ports.claim_persistence.persist_once(claimed)
  assertStateAuthorization(persisted, envelope, exactClaimKey)
  return persisted
}

export async function invokeD1Execution(
  envelope: D1AuthorizationEnvelope | null | undefined,
  claimedState: D1ExecutionState,
  invocationKey: string,
  effect: D1Effect,
  ports: D1ExecutionPorts,
): Promise<D1ExecutionState> {
  assertAuthorization(envelope)
  const exactInvocationKey = exactKey(invocationKey, 'invocation_key')
  assertStateAuthorization(claimedState, envelope, claimedState.claim_key)

  const existing = await ports.invocation_persistence.load(exactInvocationKey)
  if (existing) {
    assertInvocationReplay(existing, envelope, claimedState, exactInvocationKey, effect)
    return existing
  }

  const invocation: D1ExecutionState = {
    ...claimedState,
    invocation_key: exactInvocationKey,
    internal_reply_receipt: null,
    github_writeback_receipt: null,
    external_send_receipt: null,
  }
  const receipt = effect === 'internal_reply'
    ? await ports.internal_reply.perform(invocation)
    : effect === 'github_writeback'
      ? await ports.github_writeback.perform(invocation)
      : effect === 'external_send'
        ? await ports.external_send.perform(invocation)
        : (() => { throw new Error(`UNKNOWN_D1_EFFECT: ${String(effect)}`) })()

  const completed: D1ExecutionState = {
    ...invocation,
    internal_reply_receipt: effect === 'internal_reply' ? receipt : null,
    github_writeback_receipt: effect === 'github_writeback' ? receipt : null,
    external_send_receipt: effect === 'external_send' ? receipt : null,
  }
  const persisted = await ports.invocation_persistence.persist_once(completed)
  assertInvocationReplay(persisted, envelope, claimedState, exactInvocationKey, effect)
  return persisted
}
