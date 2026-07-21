#!/usr/bin/env bun
import { describe, expect, test } from 'bun:test'
import {
  D1AuthorizationError,
  claimD1Execution,
  computeD1AuthorizationDigest,
  invokeD1Execution,
  type D1AuthorizationEnvelope,
  type D1ExecutionPorts,
  type D1ExecutionState,
} from '../../core/shirube-d1-execution-adapter'

interface Counters {
  claim_mutations: number
  invocation_mutations: number
  internal_reply_effects: number
  github_writeback_effects: number
  external_send_effects: number
}

interface PersistedState {
  claims: Map<string, D1ExecutionState>
  invocations: Map<string, D1ExecutionState>
}

function emptyCounters(): Counters {
  return {
    claim_mutations: 0,
    invocation_mutations: 0,
    internal_reply_effects: 0,
    github_writeback_effects: 0,
    external_send_effects: 0,
  }
}

function emptyPersistedState(): PersistedState {
  return { claims: new Map(), invocations: new Map() }
}

function copyState(state: D1ExecutionState): D1ExecutionState {
  return { ...state }
}

function adapterPorts(persisted: PersistedState, counters: Counters): D1ExecutionPorts {
  return {
    claim_persistence: {
      async load(key) {
        const state = persisted.claims.get(key)
        return state ? copyState(state) : null
      },
      async persist_once(state) {
        const existing = persisted.claims.get(state.claim_key)
        if (existing) return copyState(existing)
        counters.claim_mutations += 1
        persisted.claims.set(state.claim_key, copyState(state))
        return copyState(state)
      },
    },
    invocation_persistence: {
      async load(key) {
        const state = persisted.invocations.get(key)
        return state ? copyState(state) : null
      },
      async persist_once(state) {
        const key = state.invocation_key!
        const existing = persisted.invocations.get(key)
        if (existing) return copyState(existing)
        counters.invocation_mutations += 1
        persisted.invocations.set(key, copyState(state))
        return copyState(state)
      },
    },
    internal_reply: {
      async perform(state) {
        counters.internal_reply_effects += 1
        return `internal:${state.invocation_key}:${counters.internal_reply_effects}`
      },
    },
    github_writeback: {
      async perform(state) {
        counters.github_writeback_effects += 1
        return `github:${state.invocation_key}:${counters.github_writeback_effects}`
      },
    },
    external_send: {
      async perform(state) {
        counters.external_send_effects += 1
        return `external:${state.invocation_key}:${counters.external_send_effects}`
      },
    },
  }
}

function authorizedEnvelope(overrides: Partial<D1AuthorizationEnvelope> = {}): D1AuthorizationEnvelope {
  const unsigned = {
    control_source: overrides.control_source ?? 'watchout/ai-dev-framework#556',
    handoff_id: overrides.handoff_id ?? 'CH-D1-CROSS-REPO-ADAPTER-FAST-TRACK-20260721-001',
    exact_base_sha: overrides.exact_base_sha ?? '91252e4b854fe7e67a9d995689a70f93abca4184',
    allowed_paths: overrides.allowed_paths ?? [
      'core/shirube-d1-execution-adapter.ts',
      'tests/contract/test_shirube_d1_execution_adapter.test.ts',
    ],
  }
  return {
    ...unsigned,
    authorization_digest: overrides.authorization_digest
      ?? computeD1AuthorizationDigest(unsigned),
  }
}

function allMutationAndEffectCounts(counters: Counters): number {
  return Object.values(counters).reduce((sum, count) => sum + count, 0)
}

function emitEvidence(
  fixture: string,
  counters: Counters,
  extra: Record<string, unknown> = {},
): void {
  process.stdout.write(`${JSON.stringify({ fixture, counters, ...extra })}\n`)
}

async function expectAuthorizationError(
  run: () => Promise<unknown>,
  code: D1AuthorizationError['code'],
): Promise<void> {
  try {
    await run()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(D1AuthorizationError)
    expect((error as D1AuthorizationError).code).toBe(code)
  }
}

describe('Shirube D1 nonactivated execution adapter contract', () => {
  test('AUTH-008-MISSING rejects before persistence and every effect port', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)

    await expectAuthorizationError(
      () => claimD1Execution(undefined, 'claim-auth-008-missing', ports),
      'MISSING_AUTHORIZATION',
    )

    expect(allMutationAndEffectCounts(counters)).toBe(0)
    expect(persisted.claims.size).toBe(0)
    expect(persisted.invocations.size).toBe(0)
    emitEvidence('AUTH-008-MISSING', counters)
  })

  test('AUTH-008-MISMATCH rejects before persistence and every effect port', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)
    const envelope = authorizedEnvelope({ authorization_digest: '0'.repeat(64) })

    await expectAuthorizationError(
      () => claimD1Execution(envelope, 'claim-auth-008-mismatch', ports),
      'AUTHORIZATION_DIGEST_MISMATCH',
    )

    expect(allMutationAndEffectCounts(counters)).toBe(0)
    expect(persisted.claims.size).toBe(0)
    expect(persisted.invocations.size).toBe(0)
    emitEvidence('AUTH-008-MISMATCH', counters)
  })

  test('AUTH-009-DIGEST-DRIFT rejects invocation before mutation/effect and preserves claim', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)
    const envelope = authorizedEnvelope()
    const claimed = await claimD1Execution(envelope, 'claim-auth-009', ports)
    const drifted = {
      ...envelope,
      exact_base_sha: 'f'.repeat(40),
    }

    await expectAuthorizationError(
      () => invokeD1Execution(drifted, claimed, 'invoke-auth-009', 'internal_reply', ports),
      'AUTHORIZATION_DIGEST_MISMATCH',
    )

    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 0,
      internal_reply_effects: 0,
      github_writeback_effects: 0,
      external_send_effects: 0,
    })
    expect(persisted.claims.get('claim-auth-009')).toEqual(claimed)
    expect(persisted.invocations.size).toBe(0)
    emitEvidence('AUTH-009-DIGEST-DRIFT', counters, { claim_preserved: true })
  })

  test('AUTH-010-INTERNAL-ONLY selects only the internal reply port and receipt', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)
    const envelope = authorizedEnvelope()
    const claimed = await claimD1Execution(envelope, 'claim-auth-010-internal', ports)

    const invoked = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-auth-010-internal',
      'internal_reply',
      ports,
    )

    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 1,
      internal_reply_effects: 1,
      github_writeback_effects: 0,
      external_send_effects: 0,
    })
    expect(invoked.internal_reply_receipt).toBe('internal:invoke-auth-010-internal:1')
    expect(invoked.github_writeback_receipt).toBeNull()
    expect(invoked.external_send_receipt).toBeNull()
    await expect(invokeD1Execution(
      envelope,
      claimed,
      'invoke-auth-010-internal',
      'github_writeback',
      ports,
    )).rejects.toThrow(/INVOCATION_EFFECT_MISMATCH/)
    expect(counters.github_writeback_effects).toBe(0)
    emitEvidence('AUTH-010-INTERNAL-ONLY', counters, {
      internal_reply_receipt: invoked.internal_reply_receipt,
      cross_channel_receipt_rejected: true,
    })
  })

  test('AUTH-010-GITHUB-ONLY selects only the GitHub writeback port and receipt', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)
    const envelope = authorizedEnvelope()
    const claimed = await claimD1Execution(envelope, 'claim-auth-010-github', ports)

    const invoked = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-auth-010-github',
      'github_writeback',
      ports,
    )

    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 1,
      internal_reply_effects: 0,
      github_writeback_effects: 1,
      external_send_effects: 0,
    })
    expect(invoked.internal_reply_receipt).toBeNull()
    expect(invoked.github_writeback_receipt).toBe('github:invoke-auth-010-github:1')
    expect(invoked.external_send_receipt).toBeNull()
    emitEvidence('AUTH-010-GITHUB-ONLY', counters, {
      github_writeback_receipt: invoked.github_writeback_receipt,
    })
  })

  test('AUTH-010-EXTERNAL-ONLY selects only the external send port and receipt', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const ports = adapterPorts(persisted, counters)
    const envelope = authorizedEnvelope()
    const claimed = await claimD1Execution(envelope, 'claim-auth-010-external', ports)

    const invoked = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-auth-010-external',
      'external_send',
      ports,
    )

    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 1,
      internal_reply_effects: 0,
      github_writeback_effects: 0,
      external_send_effects: 1,
    })
    expect(invoked.internal_reply_receipt).toBeNull()
    expect(invoked.github_writeback_receipt).toBeNull()
    expect(invoked.external_send_receipt).toBe('external:invoke-auth-010-external:1')
    emitEvidence('AUTH-010-EXTERNAL-ONLY', counters, {
      external_send_receipt: invoked.external_send_receipt,
    })
  })

  test('RESTART-001-CLAIM-REPLAY returns the persisted claim without duplicate mutation', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const envelope = authorizedEnvelope()
    const firstAdapter = adapterPorts(persisted, counters)
    const first = await claimD1Execution(envelope, 'claim-restart-001', firstAdapter)

    const rebuiltAdapter = adapterPorts(persisted, counters)
    const replay = await claimD1Execution(envelope, 'claim-restart-001', rebuiltAdapter)

    expect(replay).toEqual(first)
    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 0,
      internal_reply_effects: 0,
      github_writeback_effects: 0,
      external_send_effects: 0,
    })
    emitEvidence('RESTART-001-CLAIM-REPLAY', counters, {
      record_identity: replay,
      duplicate_mutations: 0,
    })
  })

  test('RESTART-002-INVOKE-REPLAY returns the persisted receipt without duplicate effect', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const envelope = authorizedEnvelope()
    const firstAdapter = adapterPorts(persisted, counters)
    const claimed = await claimD1Execution(envelope, 'claim-restart-002', firstAdapter)
    const first = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-restart-002',
      'github_writeback',
      firstAdapter,
    )

    const rebuiltAdapter = adapterPorts(persisted, counters)
    const replay = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-restart-002',
      'github_writeback',
      rebuiltAdapter,
    )

    expect(replay).toEqual(first)
    expect(replay.github_writeback_receipt).toBe(first.github_writeback_receipt)
    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_mutations: 1,
      internal_reply_effects: 0,
      github_writeback_effects: 1,
      external_send_effects: 0,
    })
    emitEvidence('RESTART-002-INVOKE-REPLAY', counters, {
      first_receipt: first.github_writeback_receipt,
      replay_receipt: replay.github_writeback_receipt,
      receipt_identity: first.github_writeback_receipt === replay.github_writeback_receipt,
      duplicate_mutations: 0,
      duplicate_effects: 0,
    })
  })
})
