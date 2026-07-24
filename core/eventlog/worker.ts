// EventLogCore/v1 — V2 seat worker (cutover M3: pull-claim consumer).
//
// This is the piece that makes "row lands in the queue → seat processes it
// with zero terminal input" true on the V2 design: an idle seat PULLS one
// open turn (claimNextTurn — conditional insert wins), runs the injected
// LLM runtime, and terminal-closes the turn with its replies in ONE
// transaction (completeTurn → reply.enqueued, transactional outbox). The
// outbox dispatcher then delivers through the injected transport.
//
// No push, no wake dependency: a missed signal is caught by the next poll.
// Crash recovery is identity-based (recoverSeatClaims at startup) — the
// fleet-kill and runtime-switch fixtures in tests/eventlog/ are the proof
// this loop leans on.

import type { DbAdapter } from '../db/adapter'
import {
  claimExactTurn,
  claimNextTurn,
  completeTurn,
  failTurnAttempt,
  presentTurn,
  recoverSeatClaims,
  scheduleTurnRetry,
  StaleClaimError,
  type ReplyInput,
  type ClaimExecutionMode,
  type TurnMutationFence,
} from './turns'
import { parseEventPayload, type OutboxTransport, type QueueViewRow } from './types'
import {
  assertV2NativeMeshExecutionFence,
  V2NativeMeshFenceError,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshFrozenAgentV1,
} from './v2-native-ingress'
import {
  assertRuntimeBindingCurrent,
  resolveRuntimeBinding,
  type ResolvedRuntimeBindingV1,
  type RuntimeBindingCurrentSnapshotV1,
} from './runtime-binding'
import {
  runSeatSupervisorCycle,
  type SeatSupervisionConfigV1,
  type SeatSupervisionUnitV1,
  type SupervisionUnitKind,
} from './seat-supervisor'

export interface TurnRuntimeResult {
  outcome: 'replied' | 'no_reply' | 'failed'
  replies?: ReplyInput[]
  summary?: string
}

/**
 * The LLM runtime seam. Production binds this to a codex-exec invocation
 * (bin/aun/v2-worker.ts); fixtures inject fakes. The runtime NEVER touches
 * the log — appending transitions stays with this worker (no LLM in any
 * transition path, per the Option B guardrails).
 */
export interface TurnRuntime {
  runTurn(input: {
    seatId: string
    turn: QueueViewRow
    payload: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<TurnRuntimeResult>
}

export interface SeatWorkerOptions {
  seatId: string
  seatInstanceId: string
  runtime: TurnRuntime
  /** Max turns to process in one pass (bounded work per tick). */
  maxTurns?: number
  /** Native S0 revalidation hook; invoked around every event-log mutation. */
  mutationFence?: TurnMutationFence
  /** PostgreSQL production workers use the guarded multi-worker path. */
  claimExecutionMode?: ClaimExecutionMode
  /** Database-clock lease duration for a production PostgreSQL claim. */
  claimLeaseDurationMs?: number
  /** K2 exact binding fence, re-read before claim, runtime and terminal mutation. */
  runtimeBinding?: ResolvedRuntimeBindingV1
  currentRuntimeBinding?: () => RuntimeBindingCurrentSnapshotV1
  retryBackoffMs?: number
  now?: () => Date
  /** Supervision cancellation fence. Aborted work must append no later mutation. */
  signal?: AbortSignal
}

export interface V2NativeMeshSeatBinding {
  seatId: string
  runtime: TurnRuntime
  runtimeInstanceId: string
  runtimeCheckoutRoot: string
  runtimeCheckoutSha: string
  resolvedRuntimeBinding?: ResolvedRuntimeBindingV1
  currentRuntimeBinding?: () => RuntimeBindingCurrentSnapshotV1
  /** K2 production constructs an adapter only after all bindings pass. */
  runtimeFactory?: (binding: ResolvedRuntimeBindingV1) => TurnRuntime
}

export type V2NativeMeshDbFactory = (unit: {
  unitId: string
  kind: SupervisionUnitKind
  seatId?: string
}) => Promise<DbAdapter>

export interface SeatWorkerPassResult {
  claimed: number
  completed: number
  failed: number
  staleLost: number
}

export class ExactTurnRuntimeViolationError extends Error {
  readonly code = 'EXACT_TURN_RUNTIME_VIOLATION' as const
}

export interface ExactTurnWorkerResult {
  claimed: 1
  completed: 1
  runtimeCalls: 1
  claimEventId: string
  claimEpoch: number
  completionEventId: string
}

/** Startup recovery: release claims of this seat's dead predecessors. */
export async function recoverSeat(db: DbAdapter, opts: { seatId: string; seatInstanceId: string }) {
  return recoverSeatClaims(db, { seatId: opts.seatId, activeInstanceId: opts.seatInstanceId })
}

/**
 * One worker pass: pull-claim and process turns for a seat until the inbox
 * is drained or maxTurns is hit. Safe to call from any number of instances
 * — the claim arbiter serializes them.
 *
 * CONNECTION OWNERSHIP: each worker instance must own its own DbAdapter
 * connection. Transactions are connection-wide (both bun:sqlite and pg),
 * so two instances sharing one adapter would interleave BEGIN/COMMIT —
 * same rule as core/inbound-delivery.ts's transaction-private client.
 */
export async function runSeatWorkerOnce(
  db: DbAdapter,
  opts: SeatWorkerOptions,
): Promise<SeatWorkerPassResult> {
  const result: SeatWorkerPassResult = { claimed: 0, completed: 0, failed: 0, staleLost: 0 }
  const maxTurns = opts.maxTurns ?? 10
  const assertActive = () => {
    if (!opts.signal?.aborted) return
    throw opts.signal.reason instanceof Error
      ? opts.signal.reason
      : new Error('seat worker cancelled by supervision fence')
  }
  const assertBinding = () => {
    assertActive()
    if (opts.runtimeBinding && opts.currentRuntimeBinding) {
      assertRuntimeBindingCurrent(opts.runtimeBinding, opts.currentRuntimeBinding())
    } else if (opts.runtimeBinding || opts.currentRuntimeBinding) {
      throw new Error('runtime binding and current snapshot reader must be supplied together')
    }
  }

  for (let i = 0; i < maxTurns; i++) {
    assertBinding()
    const claimed = await claimNextTurn(db, {
      seatId: opts.seatId,
      seatInstanceId: opts.seatInstanceId,
      mutationFence: opts.mutationFence,
      executionMode: opts.claimExecutionMode,
      leaseDurationMs: opts.claimLeaseDurationMs,
    })
    if (!claimed) break
    assertActive()
    result.claimed++
    await presentTurn(db, claimed, {
      seatId: opts.seatId,
      seatInstanceId: opts.seatInstanceId,
      mutationFence: opts.mutationFence,
    })

    let runtimeResult: TurnRuntimeResult
    try {
      assertBinding()
      runtimeResult = await opts.runtime.runTurn({
        seatId: opts.seatId,
        turn: claimed.turn,
        payload: await turnInboundPayload(db, claimed.turn),
        signal: opts.signal,
      })
    } catch (err) {
      runtimeResult = {
        outcome: 'failed',
        summary: `${typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN_ATTEMPT_FAILURE'}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    try {
      assertActive()
      assertBinding()
      if (runtimeResult.outcome === 'failed' && claimed.fencingToken !== undefined) {
        const summary = runtimeResult.summary ?? 'runtime attempt failed'
        const failureCode = summary.includes('RUNTIME_TIMEOUT')
          ? 'RUNTIME_TIMEOUT'
          : summary.includes('exited')
            ? 'RUNTIME_EXIT_NONZERO'
            : summary.includes('violated')
              ? 'RUNTIME_OUTPUT_INVALID'
              : 'UNKNOWN_ATTEMPT_FAILURE'
        const failure = await failTurnAttempt(db, {
          turnId: claimed.turn.turn_id,
          seatId: opts.seatId,
          seatInstanceId: opts.seatInstanceId,
          claimEventId: claimed.claimEventId,
          claimEpoch: claimed.claimEpoch,
          fencingToken: claimed.fencingToken,
          conversationId: claimed.turn.conversation_id,
          failureCode,
          failureSummary: summary,
          retryable: true,
          mutationFence: opts.mutationFence,
        })
        assertActive()
        assertBinding()
        const backoffMs = opts.retryBackoffMs ?? 1_000
        const availableAt = new Date((opts.now?.() ?? new Date()).getTime() + backoffMs).toISOString()
        await scheduleTurnRetry(db, {
          turnId: claimed.turn.turn_id,
          seatId: opts.seatId,
          seatInstanceId: opts.seatInstanceId,
          claimEventId: claimed.claimEventId,
          claimEpoch: claimed.claimEpoch,
          fencingToken: claimed.fencingToken,
          conversationId: claimed.turn.conversation_id,
          failureEventId: failure.event.event_id,
          availableAt,
          backoffMs,
          mutationFence: opts.mutationFence,
        })
        result.failed++
        continue
      }
      await completeTurn(db, {
        turnId: claimed.turn.turn_id,
        seatId: opts.seatId,
        seatInstanceId: opts.seatInstanceId,
        claimEventId: claimed.claimEventId,
        fencingToken: claimed.fencingToken,
        outcome: runtimeResult.outcome,
        conversationId: claimed.turn.conversation_id,
        payload: runtimeResult.summary ? { summary: runtimeResult.summary } : {},
        replies: runtimeResult.outcome === 'replied' ? runtimeResult.replies ?? [] : [],
        mutationFence: opts.mutationFence,
      })
      if (runtimeResult.outcome === 'failed') result.failed++
      else result.completed++
    } catch (err) {
      // fenced out by a racing recovery — the turn belongs to a newer
      // claim now; count and move on
      if (err instanceof StaleClaimError) {
        result.staleLost++
        continue
      }
      throw err
    }
  }
  return result
}

/**
 * Canary-only one-shot worker seam. It names one turn, claims no fallback,
 * invokes one injected runtime exactly once, accepts only deterministic
 * no_reply, and never loads or dispatches an outbox transport.
 */
export async function runExactTurnWorkerOnce(
  db: DbAdapter,
  opts: {
    seatId: 'aun'
    turnId: string
    queueId: number
    messageId: string
    createdAfter: string
    seatInstanceId: string
    runtime: TurnRuntime
  },
): Promise<ExactTurnWorkerResult> {
  const claimed = await claimExactTurn(db, {
    seatId: opts.seatId,
    turnId: opts.turnId,
    queueId: opts.queueId,
    messageId: opts.messageId,
    createdAfter: opts.createdAfter,
    seatInstanceId: opts.seatInstanceId,
  })
  if (!claimed) throw new StaleClaimError(`exact target ${opts.turnId} is not claimable`)

  await presentTurn(db, claimed, {
    seatId: opts.seatId,
    seatInstanceId: opts.seatInstanceId,
  })
  const runtimeResult = await opts.runtime.runTurn({
    seatId: opts.seatId,
    turn: claimed.turn,
    payload: await turnInboundPayload(db, claimed.turn),
  })
  if (
    runtimeResult.outcome !== 'no_reply' ||
    (runtimeResult.replies !== undefined && runtimeResult.replies.length !== 0)
  ) {
    throw new ExactTurnRuntimeViolationError('exact canary runtime must return no_reply with zero replies')
  }
  const completion = await completeTurn(db, {
    turnId: claimed.turn.turn_id,
    seatId: opts.seatId,
    seatInstanceId: opts.seatInstanceId,
    claimEventId: claimed.claimEventId,
    outcome: 'no_reply',
    conversationId: claimed.turn.conversation_id,
    payload: { runtime: 'deterministic-no-reply', provider_dispatch: 'disabled' },
    replies: [],
  })
  return {
    claimed: 1,
    completed: 1,
    runtimeCalls: 1,
    claimEventId: claimed.claimEventId,
    claimEpoch: claimed.claimEpoch,
    completionEventId: completion.completion.event.event_id,
  }
}

/**
 * Full pass for a set of seats plus one outbox drain: the shape the
 * production daemon tick calls. Returns per-seat results and the dispatch
 * outcome so the caller can emit metrics.
 */
export async function runV2Tick(
  db: DbAdapter,
  opts: {
    seats: Array<{ seatId: string; runtime: TurnRuntime }>
    instanceId: string
    transport: OutboxTransport
    maxTurnsPerSeat?: number
  },
) {
  // Keep provider/outbox code outside the exact-canary module graph. The
  // production tick loads it only when a dispatching tick is actually used.
  const { dispatchOutboxOnce } = await import('./outbox')
  const seatResults: Record<string, SeatWorkerPassResult> = {}
  for (const seat of opts.seats) {
    seatResults[seat.seatId] = await runSeatWorkerOnce(db, {
      seatId: seat.seatId,
      seatInstanceId: opts.instanceId,
      runtime: seat.runtime,
      maxTurns: opts.maxTurnsPerSeat,
    })
  }
  const dispatch = await dispatchOutboxOnce(db, opts.transport, {
    dispatcherId: 'v2-outbox',
    dispatcherInstanceId: opts.instanceId,
  })
  return { seatResults, dispatch }
}

/**
 * Provider-free V2-native tick.  It shares the pull-claim worker but replaces
 * the external transport drain with atomic EventLogCore internal placement.
 * Scope validation is deliberately first so drift causes zero mutation.
 */
export async function runV2NativeMeshTick(
  db: DbAdapter,
  opts: {
    scope: unknown
    fence: V2NativeMeshExecutionFence
    seats: V2NativeMeshSeatBinding[]
    instanceId: string
    maxTurnsPerSeat?: number
    dbFactory?: V2NativeMeshDbFactory
    /** Required for S1/S2/S3: complete durable/offline/DB revalidation. */
    mutationFence?: (boundary: string) => void | Promise<void>
    supervision?: Partial<Omit<SeatSupervisionConfigV1, 'units'>>
    /** K3 provider dispatcher; production-only and independently supervised. */
    v2DeliveryDispatcher?: (db: DbAdapter, signal: AbortSignal) => Promise<unknown>
    reconciler?: (db: DbAdapter, signal: AbortSignal) => Promise<unknown>
  },
) {
  const scope = assertV2NativeMeshExecutionFence(opts.scope, opts.fence)
  if (scope.stage_id !== 'S0_IMPLEMENTATION' && !opts.mutationFence) {
    throw new V2NativeMeshFenceError('native activation stage requires an asynchronous mutation revalidation callback')
  }
  const frozen = new Map(scope.frozen_enabled_set.map(agent => [agent.agent_id, agent]))
  const seatIds = new Set(opts.seats.map(seat => seat.seatId))
  if (opts.seats.length !== frozen.size || seatIds.size !== frozen.size || opts.seats.some(seat => !frozen.has(seat.seatId))) {
    throw new V2NativeMeshFenceError('native mesh tick seats must equal the complete frozen_enabled_set')
  }

  const assertSeatBinding = (seat: V2NativeMeshSeatBinding): V2NativeMeshFrozenAgentV1 => {
    const currentScope = assertV2NativeMeshExecutionFence(opts.scope, opts.fence)
    const agent = currentScope.frozen_enabled_set.find(candidate => candidate.agent_id === seat.seatId)
    if (!agent) throw new V2NativeMeshFenceError(`seat ${seat.seatId} left frozen_enabled_set`)
    if (
      seat.runtimeInstanceId !== agent.runtime_instance_id ||
      seat.runtimeCheckoutRoot !== agent.runtime_checkout_root ||
      seat.runtimeCheckoutSha !== agent.runtime_checkout_sha
    ) {
      throw new V2NativeMeshFenceError(`runtime identity drift for seat ${seat.seatId}`)
    }
    return agent
  }

  // Validate the complete binding set before any seat can append a claim.
  for (const seat of opts.seats) assertSeatBinding(seat)

  if (opts.dbFactory) {
    const resolvedBindings = new Map<string, ResolvedRuntimeBindingV1>()
    for (const seat of opts.seats) {
      if (!seat.resolvedRuntimeBinding || !seat.currentRuntimeBinding || !seat.runtimeFactory) {
        throw new V2NativeMeshFenceError(`K2 production seat ${seat.seatId} has no exact runtime binding and adapter factory`)
      }
      const resolved = resolveRuntimeBinding({
        binding: seat.resolvedRuntimeBinding,
        current: seat.currentRuntimeBinding(),
      })
      if (
        resolved.agent_id !== seat.seatId ||
        resolved.runtime_instance_id !== seat.runtimeInstanceId ||
        resolved.workspace_realpath !== seat.runtimeCheckoutRoot ||
        resolved.build_sha !== seat.runtimeCheckoutSha
      ) {
        throw new V2NativeMeshFenceError(`resolved K2 runtime binding does not match frozen seat ${seat.seatId}`)
      }
      resolvedBindings.set(seat.seatId, resolved)
    }
    // Construction happens only after the complete set passes; partial
    // admission can therefore create neither a DB nor a runtime adapter.
    const runtimes = new Map(opts.seats.map(seat => [
      seat.seatId,
      seat.runtimeFactory!(resolvedBindings.get(seat.seatId)!),
    ]))
    const seatResults: Record<string, SeatWorkerPassResult> = {}
    let handoff: unknown = null
    let deliveryDispatch: unknown = null
    const units: SeatSupervisionUnitV1[] = [...opts.seats]
      .sort((a, b) => a.seatId.localeCompare(b.seatId))
      .map(seat => ({
        unitId: `seat:${seat.seatId}`,
        kind: 'seat' as const,
        seatId: seat.seatId,
        adapterFactory: () => opts.dbFactory!({ unitId: `seat:${seat.seatId}`, kind: 'seat', seatId: seat.seatId }),
        run: async (unitDb, signal) => runSeatWorkerOnce(unitDb, {
          seatId: seat.seatId,
          seatInstanceId: seat.runtimeInstanceId,
          runtime: runtimes.get(seat.seatId)!,
          maxTurns: opts.maxTurnsPerSeat,
          mutationFence: async boundary => {
            await opts.mutationFence?.(`seat:${seat.seatId}:${boundary}`)
            assertSeatBinding(seat)
          },
          runtimeBinding: resolvedBindings.get(seat.seatId),
          currentRuntimeBinding: seat.currentRuntimeBinding,
          claimExecutionMode: unitDb.dialect === 'postgres' ? 'production_multi_worker' : 'unit_conformance',
          signal,
        }),
        retryable: () => true,
      }))
    units.push({
      unitId: 'outbox:v2-native-internal-handoff',
      kind: 'outbox',
      adapterFactory: () => opts.dbFactory!({ unitId: 'outbox:v2-native-internal-handoff', kind: 'outbox' }),
      run: async unitDb => {
        const { dispatchV2NativeInternalHandoffs } = await import('./internal-handoff')
        return dispatchV2NativeInternalHandoffs(unitDb, scope, opts.fence, {
          dispatcherInstanceId: opts.instanceId,
          mutationFence: async boundary => { await opts.mutationFence?.(`internal-handoff:${boundary}`) },
        })
      },
      retryable: () => true,
    })
    if (opts.v2DeliveryDispatcher) {
      units.push({
        unitId: 'outbox:v2-delivery-truth',
        kind: 'outbox',
        adapterFactory: () => opts.dbFactory!({ unitId: 'outbox:v2-delivery-truth', kind: 'outbox' }),
        run: opts.v2DeliveryDispatcher,
        retryable: () => true,
      })
    }
    if (opts.reconciler) {
      units.push({
        unitId: 'reconciler:v2-native',
        kind: 'reconciler',
        adapterFactory: () => opts.dbFactory!({ unitId: 'reconciler:v2-native', kind: 'reconciler' }),
        run: opts.reconciler,
        retryable: () => true,
      })
    }
    const report = await runSeatSupervisorCycle({
      units,
      maxConcurrency: opts.supervision?.maxConcurrency ?? units.length,
      unitTimeoutMs: opts.supervision?.unitTimeoutMs ?? 30_000,
      reconnectMaxAttempts: opts.supervision?.reconnectMaxAttempts ?? 5,
      reconnectBaseDelayMs: opts.supervision?.reconnectBaseDelayMs ?? 50,
      reconnectMaxDelayMs: opts.supervision?.reconnectMaxDelayMs ?? 2_000,
      jitterSeed: opts.supervision?.jitterSeed ?? 20260716,
      sleep: opts.supervision?.sleep,
    })
    for (const unit of report.units) {
      if (unit.kind === 'seat' && unit.seat_id && unit.status === 'completed') {
        seatResults[unit.seat_id] = unit.value as SeatWorkerPassResult
      }
      if (unit.unit_id === 'outbox:v2-native-internal-handoff' && unit.status === 'completed') handoff = unit.value
      if (unit.unit_id === 'outbox:v2-delivery-truth' && unit.status === 'completed') deliveryDispatch = unit.value
    }
    return { seatResults, handoff, deliveryDispatch, supervision: report }
  }

  const seatResults: Record<string, SeatWorkerPassResult> = {}
  for (const seat of [...opts.seats].sort((a, b) => a.seatId.localeCompare(b.seatId))) {
    const mutationFence: TurnMutationFence = async boundary => {
      await opts.mutationFence?.(`seat:${seat.seatId}:${boundary}`)
      assertSeatBinding(seat)
    }
    seatResults[seat.seatId] = await runSeatWorkerOnce(db, {
      seatId: seat.seatId,
      seatInstanceId: seat.runtimeInstanceId,
      runtime: seat.runtime,
      maxTurns: opts.maxTurnsPerSeat,
      mutationFence,
    })
  }
  const { dispatchV2NativeInternalHandoffs } = await import('./internal-handoff')
  const handoff = await dispatchV2NativeInternalHandoffs(db, scope, opts.fence, {
    dispatcherInstanceId: opts.instanceId,
    mutationFence: async boundary => { await opts.mutationFence?.(`internal-handoff:${boundary}`) },
  })
  return { seatResults, handoff }
}

/**
 * Read the full inbound payload for a turn from its receive event (the
 * dual-write stored the whole envelope there). Exposed for runtimes that
 * want channel/thread/author/content when building the prompt.
 */
export async function turnInboundPayload(
  db: DbAdapter,
  turn: QueueViewRow,
): Promise<Record<string, unknown>> {
  const row = await db.queryOne<{ payload: unknown }>(
    'SELECT payload FROM event_log WHERE event_id = $1',
    [turn.received_event_id],
  )
  return row ? parseEventPayload(row.payload) : {}
}
