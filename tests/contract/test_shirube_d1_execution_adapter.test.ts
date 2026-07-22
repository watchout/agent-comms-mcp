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

type D1Effect = NonNullable<D1ExecutionState['effect']>
type D1EffectResult = Awaited<
  ReturnType<D1ExecutionPorts['internal_reply']['perform_once']>
>

interface Counters {
  claim_mutations: number
  invocation_reservations: number
  invocation_completions: number
  internal_reply_effects: number
  github_writeback_effects: number
  external_send_effects: number
}

interface PersistedState {
  claims: Map<string, D1ExecutionState>
  invocations: Map<string, D1ExecutionState>
  // Crash-safe downstream idempotency ledger, separate from invocation persistence.
  effect_results: Map<string, D1EffectResult>
  fail_next_invocation_completion: boolean
}

function emptyCounters(): Counters {
  return {
    claim_mutations: 0,
    invocation_reservations: 0,
    invocation_completions: 0,
    internal_reply_effects: 0,
    github_writeback_effects: 0,
    external_send_effects: 0,
  }
}

function emptyPersistedState(): PersistedState {
  return {
    claims: new Map(),
    invocations: new Map(),
    effect_results: new Map(),
    fail_next_invocation_completion: false,
  }
}

function copyState(state: D1ExecutionState): D1ExecutionState {
  return { ...state }
}

function copyEffectResult(result: D1EffectResult): D1EffectResult {
  return { ...result }
}

function adapterPorts(persisted: PersistedState, counters: Counters): D1ExecutionPorts {
  function effectPort(effect: D1Effect): D1ExecutionPorts['internal_reply'] {
    return {
      async perform_once(state) {
        const invocationKey = state.invocation_key!
        const existing = persisted.effect_results.get(invocationKey)
        if (existing) {
          if (existing.effect !== effect) {
            throw new Error('TEST_EFFECT_KEY_REUSED_ACROSS_CHANNELS')
          }
          return copyEffectResult(existing)
        }

        const nextEffectNumber = effect === 'internal_reply'
          ? ++counters.internal_reply_effects
          : effect === 'github_writeback'
            ? ++counters.github_writeback_effects
            : ++counters.external_send_effects
        const result: D1EffectResult = {
          invocation_key: invocationKey,
          effect,
          receipt: `${effect === 'internal_reply' ? 'internal' : effect === 'github_writeback' ? 'github' : 'external'}:${invocationKey}:${nextEffectNumber}`,
        }
        persisted.effect_results.set(invocationKey, copyEffectResult(result))
        return copyEffectResult(result)
      },
    }
  }

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
      async reserve_once(state) {
        const key = state.invocation_key!
        const existing = persisted.invocations.get(key)
        if (existing) {
          return { acquired: false, state: copyState(existing) }
        }
        counters.invocation_reservations += 1
        persisted.invocations.set(key, copyState(state))
        return { acquired: true, state: copyState(state) }
      },
      async complete_once(state) {
        const key = state.invocation_key!
        const existing = persisted.invocations.get(key)
        if (!existing) throw new Error('TEST_COMPLETION_WITHOUT_RESERVATION')
        if (existing.status === 'completed') return copyState(existing)
        if (persisted.fail_next_invocation_completion) {
          persisted.fail_next_invocation_completion = false
          throw new Error('SIMULATED_ACK_LOSS_AFTER_EXTERNAL_EFFECT')
        }
        counters.invocation_completions += 1
        persisted.invocations.set(key, copyState(state))
        return copyState(state)
      },
    },
    internal_reply: effectPort('internal_reply'),
    github_writeback: effectPort('github_writeback'),
    external_send: effectPort('external_send'),
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
      invocation_reservations: 0,
      invocation_completions: 0,
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
      invocation_reservations: 1,
      invocation_completions: 1,
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
      invocation_reservations: 1,
      invocation_completions: 1,
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
      invocation_reservations: 1,
      invocation_completions: 1,
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
      invocation_reservations: 0,
      invocation_completions: 0,
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
      invocation_reservations: 1,
      invocation_completions: 1,
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

  test('CONCURRENT-SAME-INVOCATION-KEY performs one actual effect and returns one receipt', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const envelope = authorizedEnvelope()
    const ports = adapterPorts(persisted, counters)
    const claimed = await claimD1Execution(envelope, 'claim-concurrent', ports)

    const [first, second] = await Promise.all([
      invokeD1Execution(
        envelope,
        claimed,
        'invoke-concurrent',
        'github_writeback',
        ports,
      ),
      invokeD1Execution(
        envelope,
        claimed,
        'invoke-concurrent',
        'github_writeback',
        ports,
      ),
    ])

    expect(first).toEqual(second)
    expect(first.github_writeback_receipt).toBe('github:invoke-concurrent:1')
    expect(persisted.invocations.size).toBe(1)
    expect(persisted.effect_results.size).toBe(1)
    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_reservations: 1,
      invocation_completions: 1,
      internal_reply_effects: 0,
      github_writeback_effects: 1,
      external_send_effects: 0,
    })
    emitEvidence('CONCURRENT-SAME-INVOCATION-KEY', counters, {
      actual_effects: counters.github_writeback_effects,
      invocation_records: persisted.invocations.size,
      returned_receipts: [
        first.github_writeback_receipt,
        second.github_writeback_receipt,
      ],
      receipt_identity: first.github_writeback_receipt === second.github_writeback_receipt,
      duplicate_effects: 0,
    })
  })

  test('RESTART-ACK-LOSS reuses the downstream idempotent receipt after completion loss', async () => {
    const counters = emptyCounters()
    const persisted = emptyPersistedState()
    const envelope = authorizedEnvelope()
    const firstAdapter = adapterPorts(persisted, counters)
    const claimed = await claimD1Execution(envelope, 'claim-ack-loss', firstAdapter)
    persisted.fail_next_invocation_completion = true

    await expect(invokeD1Execution(
      envelope,
      claimed,
      'invoke-ack-loss',
      'external_send',
      firstAdapter,
    )).rejects.toThrow('SIMULATED_ACK_LOSS_AFTER_EXTERNAL_EFFECT')

    const reserved = persisted.invocations.get('invoke-ack-loss')!
    const downstreamResult = persisted.effect_results.get('invoke-ack-loss')!
    expect(reserved.status).toBe('reserved')
    expect(downstreamResult.receipt).toBe('external:invoke-ack-loss:1')
    expect(counters.external_send_effects).toBe(1)

    const rebuiltAdapter = adapterPorts(persisted, counters)
    const replay = await invokeD1Execution(
      envelope,
      claimed,
      'invoke-ack-loss',
      'external_send',
      rebuiltAdapter,
    )

    expect(replay.status).toBe('completed')
    expect(replay.external_send_receipt).toBe(downstreamResult.receipt)
    expect(persisted.invocations.size).toBe(1)
    expect(persisted.effect_results.size).toBe(1)
    expect(counters).toEqual({
      claim_mutations: 1,
      invocation_reservations: 1,
      invocation_completions: 1,
      internal_reply_effects: 0,
      github_writeback_effects: 0,
      external_send_effects: 1,
    })
    emitEvidence('RESTART-ACK-LOSS', counters, {
      first_error: 'SIMULATED_ACK_LOSS_AFTER_EXTERNAL_EFFECT',
      actual_effects_after_retry: counters.external_send_effects,
      invocation_records: persisted.invocations.size,
      persisted_receipt: replay.external_send_receipt,
      receipt_identity: replay.external_send_receipt === downstreamResult.receipt,
      duplicate_effects: 0,
    })
  })
})
