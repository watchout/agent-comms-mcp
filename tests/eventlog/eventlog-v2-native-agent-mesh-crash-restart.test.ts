import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  completeTurn,
  dispatchV2NativeInternalHandoffs,
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  openTurnCount,
  pendingV2NativeInternalHandoffs,
  recordV2NativeInternalHandoffPredecessorDeath,
  recoverV2NativeInternalHandoffClaims,
  routeV2NativeMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import {
  recoverSeat,
  runSeatWorkerOnce,
  runV2NativeMeshTick,
  type TurnRuntime,
  type V2NativeMeshSeatBinding,
} from '../../core/eventlog/worker'

const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'deterministic-s0',
  runtime_instance_id: `fixture-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 7).repeat(40),
}))

function scope(): V2NativeMeshScopeV1 {
  return {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: 's0-crash-run',
    stage_id: 'S0_IMPLEMENTATION',
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: 'e325d1e6607360a67d337a9b2a77d5df8dd11477',
    database_identity: 'sqlite:isolated:s0-crash',
    frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
    runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    deadline_ms: Date.now() + 30_000,
  }
}

function fence(s: V2NativeMeshScopeV1): V2NativeMeshExecutionFence {
  return {
    stage_id: 'S0_IMPLEMENTATION',
    exact_implementation_head: s.exact_implementation_head,
    database_identity: s.database_identity,
    runtime_snapshot_sha256: s.runtime_snapshot_sha256,
  }
}

function boundSeat(seatId: string, seatRuntime: TurnRuntime = runtime): V2NativeMeshSeatBinding {
  const agent = agents.find(candidate => candidate.agent_id === seatId)
  if (!agent) throw new Error(`fixture agent ${seatId} not found`)
  return {
    seatId,
    runtime: seatRuntime,
    runtimeInstanceId: agent.runtime_instance_id,
    runtimeCheckoutRoot: agent.runtime_checkout_root,
    runtimeCheckoutSha: agent.runtime_checkout_sha,
  }
}

const runtime = deterministicV2NativeMeshRuntime(({ seatId, content }) =>
  seatId === 'beta' && content === 'request' ? 'reply:beta' : null,
)

let dir: string
let db: SqliteAdapter
let dbPath: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'v2-native-crash-'))
  dbPath = join(dir, 'crash.db')
  db = new SqliteAdapter(dbPath)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

async function ingress() {
  const s = scope()
  await routeV2NativeMessage(db, s, fence(s), {
    route_id: 'alpha-to-beta',
    route_kind: 'direct',
    source_agent_id: 'alpha',
    recipient_agent_ids: ['beta'],
    content: 'request',
  })
  return s
}

async function drain(s: V2NativeMeshScopeV1) {
  let guard = 0
  while ((await openTurnCount(db)) > 0 || (await pendingV2NativeInternalHandoffs(db, s, fence(s))).length > 0) {
    await runV2NativeMeshTick(db, {
      scope: s,
      fence: fence(s),
      seats: [boundSeat('alpha'), boundSeat('beta')],
      instanceId: `restart-${guard}`,
    })
    if (++guard > 6) throw new Error('restart fixture did not converge')
  }
}

async function assertTerminalSet() {
  const completions = Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.completed'"))?.n ?? 0)
  const handoffs = Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.handoff_accepted'"))?.n ?? 0)
  const provider = Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.provider_invocation_started'"))?.n ?? 0)
  expect(completions).toBe(2)
  expect(handoffs).toBe(1)
  expect(provider).toBe(0)
  expect(await openTurnCount(db)).toBe(0)
}

describe('V2-native four-boundary crash/restart', () => {
  test('after message.received before turn.claimed', async () => {
    const s = await ingress()
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.claimed'"))?.n ?? 0)).toBe(0)
    await drain(s)
    await assertTerminalSet()
  })

  test('after turn.claimed before turn.presented rejects stale predecessor', async () => {
    const s = await ingress()
    const proc = Bun.spawn({
      cmd: [process.execPath, 'tests/eventlog/fixtures/v2-native-agent-mesh-worker.ts',
        '--db', dbPath, '--seat-id', 'beta', '--instance-id', 'dead-beta'],
      cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect(exitCode).toBe(17)
    expect(stderr).toBe('')
    const old = JSON.parse(stdout) as { turn_id: string; claim_event_id: string }
    await recoverSeat(db, { seatId: 'beta', seatInstanceId: 'new-beta' })
    await expect(completeTurn(db, {
      turnId: old.turn_id,
      seatId: 'beta',
      seatInstanceId: 'dead-beta',
      claimEventId: old.claim_event_id,
      outcome: 'no_reply',
    })).rejects.toThrow('released')
    await drain(s)
    await assertTerminalSet()
  })

  test('after turn.completed plus reply.enqueued atomic commit', async () => {
    const s = await ingress()
    const recipient = await runSeatWorkerOnce(db, {
      seatId: 'beta', seatInstanceId: 'before-restart', runtime,
    })
    expect(recipient.completed).toBe(1)
    expect((await pendingV2NativeInternalHandoffs(db, s, fence(s))).length).toBe(1)
    await drain(s)
    await assertTerminalSet()
  })

  test('live predecessor cannot be recovered without durable death proof', async () => {
    const s = await ingress()
    await runSeatWorkerOnce(db, { seatId: 'beta', seatInstanceId: 'worker', runtime })
    let releasePredecessor!: () => void
    let claimed!: () => void
    const predecessorPaused = new Promise<void>(resolve => { claimed = resolve })
    const resumePredecessor = new Promise<void>(resolve => { releasePredecessor = resolve })
    const predecessor = dispatchV2NativeInternalHandoffs(db, s, fence(s), {
      dispatcherInstanceId: 'live-dispatcher',
      async onCommitPoint(point) {
        if (point === 'after_delivery_claimed') {
          claimed()
          await resumePredecessor
        }
      },
    })
    await predecessorPaused
    await expect(recoverV2NativeInternalHandoffClaims(db, s, fence(s), {
      activeInstanceId: 'new-dispatcher',
      predecessorDeathEvidenceEventIds: {},
    })).rejects.toThrow('missing durable predecessor-death evidence for live-dispatcher')
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.failed'"))?.n ?? 0)).toBe(0)
    releasePredecessor()
    expect((await predecessor).accepted).toHaveLength(1)
    await drain(s)
    await assertTerminalSet()
  })

  test('proven-dead recovery fences a live stale continuation before placement', async () => {
    const s = await ingress()
    await runSeatWorkerOnce(db, { seatId: 'beta', seatInstanceId: 'worker', runtime })
    let releasePredecessor!: () => void
    let claimed!: () => void
    const predecessorPaused = new Promise<void>(resolve => { claimed = resolve })
    const resumePredecessor = new Promise<void>(resolve => { releasePredecessor = resolve })
    const predecessor = dispatchV2NativeInternalHandoffs(db, s, fence(s), {
      dispatcherInstanceId: 'dead-dispatcher',
      async onCommitPoint(point) {
        if (point === 'after_delivery_claimed') {
          claimed()
          await resumePredecessor
        }
      },
    })
    await predecessorPaused
    const evidence = await recordV2NativeInternalHandoffPredecessorDeath(db, s, fence(s), {
      predecessorDispatcherInstanceId: 'dead-dispatcher',
      observerInstanceId: 'fixture-supervisor',
      supervisorEvidenceRef: 'fixture://supervisor/dead-dispatcher/not-live',
    })
    expect(await recoverV2NativeInternalHandoffClaims(db, s, fence(s), {
      activeInstanceId: 'new-dispatcher',
      predecessorDeathEvidenceEventIds: { 'dead-dispatcher': evidence.event_id },
    })).toEqual(['reply:turn:beta:mesh-message:s0-crash-run:alpha-to-beta:beta:0'])
    releasePredecessor()
    await expect(predecessor).rejects.toThrow('is no longer active')
    const staleTerminals = Number((await db.queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.handoff_accepted'",
    ))?.n ?? 0)
    const stalePlacements = Number((await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log
        WHERE event_type='message.received'
          AND CAST(payload AS TEXT) LIKE '%"route_kind":"reply"%'`,
    ))?.n ?? 0)
    expect(staleTerminals).toBe(0)
    expect(stalePlacements).toBe(0)
    const resumed = await dispatchV2NativeInternalHandoffs(db, s, fence(s), {
      dispatcherInstanceId: 'new-dispatcher',
    })
    expect(resumed.accepted).toHaveLength(1)
    await drain(s)
    await assertTerminalSet()
  })
})
