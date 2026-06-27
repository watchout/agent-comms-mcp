export const AUN_RUNTIME_V2_SYNTHETIC_CLAIM_SCHEMA_VERSION = 'aun-runtime-v2-synthetic-claim/v1' as const
export const AUN_RUNTIME_V2_SYNTHETIC_FINALIZE_SCHEMA_VERSION = 'aun-runtime-v2-synthetic-finalize/v1' as const

const CLAIM_REASON = {
  claimed: 'claimed',
  invalidClaimRequest: 'invalid_claim_request',
  batonNotFound: 'baton_not_found',
  ownerMismatch: 'owner_mismatch',
  observerCannotClaimAsOwner: 'observer_cannot_claim_as_owner',
  activeClaimExists: 'active_claim_exists',
  expiredClaimRequiresPolicy: 'expired_claim_requires_policy',
} as const

const FINALIZE_REASON = {
  finalized: 'finalized',
  invalidFinalizeRequest: 'invalid_finalize_request',
  batonNotFound: 'baton_not_found',
  claimNotActive: 'claim_not_active',
  ownerMismatch: 'owner_mismatch',
  runtimeInstanceMismatch: 'runtime_instance_mismatch',
  fencingTokenMismatch: 'fencing_token_mismatch',
  leaseExpired: 'lease_expired',
} as const

export type AunRuntimeV2SyntheticClaimReasonCode = (typeof CLAIM_REASON)[keyof typeof CLAIM_REASON]

export type AunRuntimeV2SyntheticFinalizeReasonCode = (typeof FINALIZE_REASON)[keyof typeof FINALIZE_REASON]

export interface AunRuntimeV2SyntheticClaim {
  claim_id: string
  baton_id: string
  owner_agent_id: string
  runtime_instance_id: string
  claimed_at: string
  lease_expires_at: string
  fencing_token: string
}

export interface AunRuntimeV2SyntheticBaton {
  baton_id: string
  owner_agent_id: string
  observer_agent_ids?: string[]
  state?: 'open' | 'claimed' | 'finalized'
  active_claim?: AunRuntimeV2SyntheticClaim | null
}

export interface AunRuntimeV2SyntheticClaimRequest {
  baton_id?: string | null
  owner_agent_id?: string | null
  runtime_instance_id?: string | null
  lease_expires_at?: string | null
  fencing_token?: string | null
  now?: () => Date
  allow_expired_lease_replacement?: boolean
}

export interface AunRuntimeV2SyntheticFinalizeRequest {
  baton_id?: string | null
  owner_agent_id?: string | null
  runtime_instance_id?: string | null
  fencing_token?: string | null
  now?: () => Date
}

export interface AunRuntimeV2SyntheticMutation {
  op: 'claim_baton' | 'replace_expired_claim' | 'finalize_claim'
  scope: 'synthetic_in_memory'
  baton_id: string
  claim_id?: string
}

export interface AunRuntimeV2SyntheticTarget {
  baton_id: string | null
  owner_agent_id: string | null
  runtime_instance_id: string | null
}

export interface AunRuntimeV2SyntheticClaimResult {
  schema_version: typeof AUN_RUNTIME_V2_SYNTHETIC_CLAIM_SCHEMA_VERSION
  generated_at: string
  target: AunRuntimeV2SyntheticTarget
  evaluation: {
    baton_found: boolean
    owner_matches: boolean
    observer_is_requester: boolean
    active_claim_present: boolean
    active_claim_expired: boolean
    replacement_policy_authorized: boolean
    lease_expires_at_valid: boolean
    fencing_token_present: boolean
  }
  claim: {
    claimed: boolean
    reason_code: AunRuntimeV2SyntheticClaimReasonCode
    active_claim: AunRuntimeV2SyntheticClaim | null
    synthetic_mutations: AunRuntimeV2SyntheticMutation[]
    production_mutations: []
  }
  evidence_refs: string[]
}

export interface AunRuntimeV2SyntheticFinalizeResult {
  schema_version: typeof AUN_RUNTIME_V2_SYNTHETIC_FINALIZE_SCHEMA_VERSION
  generated_at: string
  target: AunRuntimeV2SyntheticTarget
  evaluation: {
    baton_found: boolean
    active_claim_present: boolean
    owner_matches: boolean
    runtime_instance_matches: boolean
    fencing_token_matches: boolean
    lease_active: boolean
  }
  finalization: {
    finalized: boolean
    reason_code: AunRuntimeV2SyntheticFinalizeReasonCode
    synthetic_mutations: AunRuntimeV2SyntheticMutation[]
    production_mutations: []
  }
  evidence_refs: string[]
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function cloneClaim(value: AunRuntimeV2SyntheticClaim | null | undefined): AunRuntimeV2SyntheticClaim | null {
  return value ? { ...value } : null
}

function cloneBaton(value: AunRuntimeV2SyntheticBaton): AunRuntimeV2SyntheticBaton {
  return {
    ...value,
    observer_agent_ids: [...(value.observer_agent_ids ?? [])],
    active_claim: cloneClaim(value.active_claim),
  }
}

function dateMs(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function generatedAt(requestNow: (() => Date) | undefined): { now: Date; iso: string } {
  const now = requestNow?.() ?? new Date()
  return { now, iso: now.toISOString() }
}

function targetFromIds(input: {
  batonId: string | null
  ownerAgentId: string | null
  runtimeInstanceId: string | null
}): AunRuntimeV2SyntheticTarget {
  return {
    baton_id: input.batonId,
    owner_agent_id: input.ownerAgentId,
    runtime_instance_id: input.runtimeInstanceId,
  }
}

function claimId(input: {
  batonId: string
  ownerAgentId: string
  runtimeInstanceId: string
  fencingToken: string
}): string {
  return [
    'synthetic',
    input.batonId,
    input.ownerAgentId,
    input.runtimeInstanceId,
    input.fencingToken,
  ].join(':')
}

export class AunRuntimeV2SyntheticClaimStore {
  private readonly batons = new Map<string, AunRuntimeV2SyntheticBaton>()

  constructor(batons: AunRuntimeV2SyntheticBaton[]) {
    for (const baton of batons) {
      this.batons.set(baton.baton_id, cloneBaton(baton))
    }
  }

  snapshot(): AunRuntimeV2SyntheticBaton[] {
    return [...this.batons.values()]
      .map(cloneBaton)
      .sort((a, b) => a.baton_id.localeCompare(b.baton_id))
  }

  getBaton(batonId: string): AunRuntimeV2SyntheticBaton | null {
    const baton = this.batons.get(batonId)
    return baton ? cloneBaton(baton) : null
  }

  claim(request: AunRuntimeV2SyntheticClaimRequest): AunRuntimeV2SyntheticClaimResult {
    const { now, iso } = generatedAt(request.now)
    const batonId = cleanString(request.baton_id)
    const ownerAgentId = cleanString(request.owner_agent_id)
    const runtimeInstanceId = cleanString(request.runtime_instance_id)
    const leaseExpiresAt = cleanString(request.lease_expires_at)
    const fencingToken = cleanString(request.fencing_token)
    const baton = batonId ? this.batons.get(batonId) ?? null : null
    const activeClaim = cloneClaim(baton?.active_claim)
    const activeClaimExpired = activeClaim ? (dateMs(activeClaim.lease_expires_at) ?? Number.NEGATIVE_INFINITY) <= now.getTime() : false
    const leaseExpiresMs = dateMs(leaseExpiresAt)
    const leaseValid = leaseExpiresMs !== null && leaseExpiresMs > now.getTime()
    const observerIsRequester = !!ownerAgentId && !!baton?.observer_agent_ids?.includes(ownerAgentId)

    const base = (): Omit<AunRuntimeV2SyntheticClaimResult, 'claim'> => ({
      schema_version: AUN_RUNTIME_V2_SYNTHETIC_CLAIM_SCHEMA_VERSION,
      generated_at: iso,
      target: targetFromIds({ batonId, ownerAgentId, runtimeInstanceId }),
      evaluation: {
        baton_found: !!baton,
        owner_matches: !!baton && ownerAgentId === baton.owner_agent_id,
        observer_is_requester: observerIsRequester,
        active_claim_present: !!activeClaim,
        active_claim_expired: activeClaimExpired,
        replacement_policy_authorized: request.allow_expired_lease_replacement === true,
        lease_expires_at_valid: leaseValid,
        fencing_token_present: !!fencingToken,
      },
      evidence_refs: [],
    })

    const blocked = (
      reasonCode: AunRuntimeV2SyntheticClaimReasonCode,
      claim: AunRuntimeV2SyntheticClaim | null = activeClaim,
    ): AunRuntimeV2SyntheticClaimResult => ({
      ...base(),
      claim: {
        claimed: false,
        reason_code: reasonCode,
        active_claim: cloneClaim(claim),
        synthetic_mutations: [],
        production_mutations: [],
      },
    })

    if (!batonId || !ownerAgentId || !runtimeInstanceId || !leaseExpiresAt || !leaseValid || !fencingToken) {
      return blocked(CLAIM_REASON.invalidClaimRequest, null)
    }
    if (!baton) return blocked(CLAIM_REASON.batonNotFound, null)
    if (observerIsRequester) return blocked(CLAIM_REASON.observerCannotClaimAsOwner)
    if (ownerAgentId !== baton.owner_agent_id) return blocked(CLAIM_REASON.ownerMismatch)
    if (activeClaim && !activeClaimExpired) return blocked(CLAIM_REASON.activeClaimExists)
    if (activeClaimExpired && request.allow_expired_lease_replacement !== true) {
      return blocked(CLAIM_REASON.expiredClaimRequiresPolicy)
    }

    const nextClaim: AunRuntimeV2SyntheticClaim = {
      claim_id: claimId({ batonId, ownerAgentId, runtimeInstanceId, fencingToken }),
      baton_id: batonId,
      owner_agent_id: ownerAgentId,
      runtime_instance_id: runtimeInstanceId,
      claimed_at: iso,
      lease_expires_at: leaseExpiresAt,
      fencing_token: fencingToken,
    }
    this.batons.set(batonId, {
      ...baton,
      state: 'claimed',
      active_claim: nextClaim,
    })

    return {
      ...base(),
      evaluation: {
        ...base().evaluation,
        active_claim_present: !!activeClaim,
        active_claim_expired: activeClaimExpired,
      },
      claim: {
        claimed: true,
        reason_code: CLAIM_REASON.claimed,
        active_claim: cloneClaim(nextClaim),
        synthetic_mutations: [{
          op: activeClaimExpired ? 'replace_expired_claim' : 'claim_baton',
          scope: 'synthetic_in_memory',
          baton_id: batonId,
          claim_id: nextClaim.claim_id,
        }],
        production_mutations: [],
      },
    }
  }

  finalize(request: AunRuntimeV2SyntheticFinalizeRequest): AunRuntimeV2SyntheticFinalizeResult {
    const { now, iso } = generatedAt(request.now)
    const batonId = cleanString(request.baton_id)
    const ownerAgentId = cleanString(request.owner_agent_id)
    const runtimeInstanceId = cleanString(request.runtime_instance_id)
    const fencingToken = cleanString(request.fencing_token)
    const baton = batonId ? this.batons.get(batonId) ?? null : null
    const activeClaim = baton?.active_claim ?? null
    const leaseActive = activeClaim ? (dateMs(activeClaim.lease_expires_at) ?? Number.NEGATIVE_INFINITY) > now.getTime() : false

    const base = (): Omit<AunRuntimeV2SyntheticFinalizeResult, 'finalization'> => ({
      schema_version: AUN_RUNTIME_V2_SYNTHETIC_FINALIZE_SCHEMA_VERSION,
      generated_at: iso,
      target: targetFromIds({ batonId, ownerAgentId, runtimeInstanceId }),
      evaluation: {
        baton_found: !!baton,
        active_claim_present: !!activeClaim,
        owner_matches: !!activeClaim && ownerAgentId === activeClaim.owner_agent_id,
        runtime_instance_matches: !!activeClaim && runtimeInstanceId === activeClaim.runtime_instance_id,
        fencing_token_matches: !!activeClaim && fencingToken === activeClaim.fencing_token,
        lease_active: leaseActive,
      },
      evidence_refs: [],
    })

    const blocked = (reasonCode: AunRuntimeV2SyntheticFinalizeReasonCode): AunRuntimeV2SyntheticFinalizeResult => ({
      ...base(),
      finalization: {
        finalized: false,
        reason_code: reasonCode,
        synthetic_mutations: [],
        production_mutations: [],
      },
    })

    if (!batonId || !ownerAgentId || !runtimeInstanceId || !fencingToken) {
      return blocked(FINALIZE_REASON.invalidFinalizeRequest)
    }
    if (!baton) return blocked(FINALIZE_REASON.batonNotFound)
    if (!activeClaim) return blocked(FINALIZE_REASON.claimNotActive)
    if (ownerAgentId !== activeClaim.owner_agent_id) return blocked(FINALIZE_REASON.ownerMismatch)
    if (runtimeInstanceId !== activeClaim.runtime_instance_id) return blocked(FINALIZE_REASON.runtimeInstanceMismatch)
    if (fencingToken !== activeClaim.fencing_token) return blocked(FINALIZE_REASON.fencingTokenMismatch)
    if (!leaseActive) return blocked(FINALIZE_REASON.leaseExpired)

    this.batons.set(batonId, {
      ...baton,
      state: 'finalized',
      active_claim: null,
    })

    return {
      ...base(),
      finalization: {
        finalized: true,
        reason_code: FINALIZE_REASON.finalized,
        synthetic_mutations: [{
          op: 'finalize_claim',
          scope: 'synthetic_in_memory',
          baton_id: batonId,
          claim_id: activeClaim.claim_id,
        }],
        production_mutations: [],
      },
    }
  }
}

export function createAunRuntimeV2SyntheticClaimStore(
  batons: AunRuntimeV2SyntheticBaton[],
): AunRuntimeV2SyntheticClaimStore {
  return new AunRuntimeV2SyntheticClaimStore(batons)
}
