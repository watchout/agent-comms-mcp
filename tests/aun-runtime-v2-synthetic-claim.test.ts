import { describe, expect, test } from 'bun:test'
import {
  createAunRuntimeV2SyntheticClaimStore,
  type AunRuntimeV2SyntheticBaton,
} from '../core/aun-runtime-v2-synthetic-claim'

const NOW = new Date('2026-06-26T00:00:00.000Z')
const LATER = '2026-06-26T00:05:00.000Z'
const EXPIRED = '2026-06-25T23:55:00.000Z'

function now() {
  return NOW
}

function baton(overrides: Partial<AunRuntimeV2SyntheticBaton> = {}): AunRuntimeV2SyntheticBaton {
  return {
    baton_id: 'baton-1',
    owner_agent_id: 'kodama',
    observer_agent_ids: ['codex-audit'],
    state: 'open',
    active_claim: null,
    ...overrides,
  }
}

function claimDefaults(overrides: Record<string, unknown> = {}) {
  return {
    baton_id: 'baton-1',
    owner_agent_id: 'kodama',
    runtime_instance_id: 'runtime-kodama-1',
    lease_expires_at: LATER,
    fencing_token: 'fence-1',
    now,
    ...overrides,
  }
}

function claim(store = createAunRuntimeV2SyntheticClaimStore([baton()]), overrides: Record<string, unknown> = {}) {
  return store.claim(claimDefaults(overrides))
}

describe('AUN runtime-v2 synthetic claim', () => {
  test('claims a baton with owner, runtime, lease, and fencing token using only synthetic memory', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    const before = store.snapshot()
    const result = claim(store)
    const after = store.snapshot()

    expect(result).toMatchObject({
      schema_version: 'aun-runtime-v2-synthetic-claim/v1',
      generated_at: NOW.toISOString(),
      target: {
        baton_id: 'baton-1',
        owner_agent_id: 'kodama',
        runtime_instance_id: 'runtime-kodama-1',
      },
      evaluation: {
        baton_found: true,
        owner_matches: true,
        observer_is_requester: false,
        active_claim_present: false,
        lease_expires_at_valid: true,
        fencing_token_present: true,
      },
      claim: {
        claimed: true,
        reason_code: 'claimed',
        active_claim: {
          baton_id: 'baton-1',
          owner_agent_id: 'kodama',
          runtime_instance_id: 'runtime-kodama-1',
          claimed_at: NOW.toISOString(),
          lease_expires_at: LATER,
          fencing_token: 'fence-1',
        },
        synthetic_mutations: [{
          op: 'claim_baton',
          scope: 'synthetic_in_memory',
          baton_id: 'baton-1',
        }],
        production_mutations: [],
      },
    })
    expect(before[0].active_claim).toBeNull()
    expect(after[0].active_claim).toMatchObject({
      owner_agent_id: 'kodama',
      runtime_instance_id: 'runtime-kodama-1',
      fencing_token: 'fence-1',
    })
  })

  test('requires baton id, owner agent, runtime instance, future lease, and fencing token', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    const before = store.snapshot()
    const result = store.claim({
      baton_id: 'baton-1',
      owner_agent_id: 'kodama',
      runtime_instance_id: '',
      lease_expires_at: LATER,
      fencing_token: 'fence-1',
      now,
    })

    expect(result.claim).toMatchObject({
      claimed: false,
      reason_code: 'invalid_claim_request',
      synthetic_mutations: [],
      production_mutations: [],
    })
    expect(store.snapshot()).toEqual(before)
  })

  test('blocks duplicate active claims for the same baton', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    expect(claim(store).claim.reason_code).toBe('claimed')

    const duplicate = claim(store, {
      runtime_instance_id: 'runtime-kodama-2',
      fencing_token: 'fence-2',
    })

    expect(duplicate.claim).toMatchObject({
      claimed: false,
      reason_code: 'active_claim_exists',
      synthetic_mutations: [],
      production_mutations: [],
    })
    expect(store.getBaton('baton-1')?.active_claim).toMatchObject({
      runtime_instance_id: 'runtime-kodama-1',
      fencing_token: 'fence-1',
    })
  })

  test('replaces an expired claim only when replacement policy is explicit', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([
      baton({
        state: 'claimed',
        active_claim: {
          claim_id: 'old-claim',
          baton_id: 'baton-1',
          owner_agent_id: 'kodama',
          runtime_instance_id: 'runtime-old',
          claimed_at: '2026-06-25T23:50:00.000Z',
          lease_expires_at: EXPIRED,
          fencing_token: 'old-fence',
        },
      }),
    ])

    const blocked = claim(store, {
      runtime_instance_id: 'runtime-new',
      fencing_token: 'new-fence',
    })
    expect(blocked.claim).toMatchObject({
      claimed: false,
      reason_code: 'expired_claim_requires_policy',
      production_mutations: [],
    })
    expect(store.getBaton('baton-1')?.active_claim?.fencing_token).toBe('old-fence')

    const replaced = claim(store, {
      runtime_instance_id: 'runtime-new',
      fencing_token: 'new-fence',
      allow_expired_lease_replacement: true,
    })
    expect(replaced.claim).toMatchObject({
      claimed: true,
      reason_code: 'claimed',
      active_claim: {
        runtime_instance_id: 'runtime-new',
        fencing_token: 'new-fence',
      },
      synthetic_mutations: [{
        op: 'replace_expired_claim',
        scope: 'synthetic_in_memory',
        baton_id: 'baton-1',
      }],
      production_mutations: [],
    })
  })

  test('does not let an observer claim as the owner', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    const result = claim(store, {
      owner_agent_id: 'codex-audit',
      runtime_instance_id: 'runtime-audit-1',
      fencing_token: 'audit-fence',
    })

    expect(result.evaluation).toMatchObject({
      baton_found: true,
      owner_matches: false,
      observer_is_requester: true,
    })
    expect(result.claim).toMatchObject({
      claimed: false,
      reason_code: 'observer_cannot_claim_as_owner',
      synthetic_mutations: [],
      production_mutations: [],
    })
    expect(store.getBaton('baton-1')?.active_claim).toBeNull()
  })

  test('blocks finalization by stale holder or wrong fencing token', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    expect(claim(store).claim.reason_code).toBe('claimed')

    const wrongFence = store.finalize({
      baton_id: 'baton-1',
      owner_agent_id: 'kodama',
      runtime_instance_id: 'runtime-kodama-1',
      fencing_token: 'wrong-fence',
      now,
    })
    expect(wrongFence.finalization).toMatchObject({
      finalized: false,
      reason_code: 'fencing_token_mismatch',
      synthetic_mutations: [],
      production_mutations: [],
    })

    const stale = store.finalize({
      baton_id: 'baton-1',
      owner_agent_id: 'kodama',
      runtime_instance_id: 'runtime-kodama-1',
      fencing_token: 'fence-1',
      now: () => new Date('2026-06-26T00:06:00.000Z'),
    })
    expect(stale.finalization).toMatchObject({
      finalized: false,
      reason_code: 'lease_expired',
      synthetic_mutations: [],
      production_mutations: [],
    })
    expect(store.getBaton('baton-1')?.active_claim).toMatchObject({
      fencing_token: 'fence-1',
    })
  })

  test('finalizes only with matching active lease and fencing token', () => {
    const store = createAunRuntimeV2SyntheticClaimStore([baton()])
    expect(claim(store).claim.reason_code).toBe('claimed')

    const finalized = store.finalize({
      baton_id: 'baton-1',
      owner_agent_id: 'kodama',
      runtime_instance_id: 'runtime-kodama-1',
      fencing_token: 'fence-1',
      now,
    })

    expect(finalized).toMatchObject({
      schema_version: 'aun-runtime-v2-synthetic-finalize/v1',
      finalization: {
        finalized: true,
        reason_code: 'finalized',
        synthetic_mutations: [{
          op: 'finalize_claim',
          scope: 'synthetic_in_memory',
          baton_id: 'baton-1',
        }],
        production_mutations: [],
      },
    })
    expect(store.getBaton('baton-1')).toMatchObject({
      state: 'finalized',
      active_claim: null,
    })
  })
})
