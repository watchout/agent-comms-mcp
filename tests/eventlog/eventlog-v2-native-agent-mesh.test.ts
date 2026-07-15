import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  openTurnCount,
  pendingV2NativeInternalHandoffs,
  routeV2NativeMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshExecutionFence,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { runV2NativeMeshTick } from '../../core/eventlog/worker'

const HEAD = 'e325d1e6607360a67d337a9b2a77d5df8dd11477'
const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta', 'gamma'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'deterministic-s0',
  runtime_instance_id: `fixture-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 1).repeat(40),
}))

function scope(): V2NativeMeshScopeV1 {
  return {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: 's0-matrix-run',
    stage_id: 'S0_IMPLEMENTATION',
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: HEAD,
    database_identity: 'sqlite:isolated:s0-matrix',
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

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'v2-native-mesh-'))
  db = new SqliteAdapter(join(dir, 'mesh.db'))
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('V2-native all-agent mesh S0', () => {
  test('three frozen agents complete direct and full fanout matrices with automatic replies', async () => {
    const s = scope()
    const f = fence(s)
    const ids = agents.map(agent => agent.agent_id)
    for (const source of ids) {
      for (const recipient of ids.filter(id => id !== source)) {
        await routeV2NativeMessage(db, s, f, {
          route_id: `direct:${source}:${recipient}`,
          route_kind: 'direct',
          source_agent_id: source,
          recipient_agent_ids: [recipient],
          content: `request:${source}:${recipient}`,
        })
      }
      await routeV2NativeMessage(db, s, f, {
        route_id: `fanout:${source}`,
        route_kind: 'fanout',
        source_agent_id: source,
        recipient_agent_ids: ids.filter(id => id !== source),
        content: `fanout-request:${source}`,
      })
    }

    const runtime = deterministicV2NativeMeshRuntime(({ seatId, sourceAgentId, content }) =>
      content.startsWith('reply:') ? null : `reply:${seatId}:${sourceAgentId}`,
    )
    const seats = ids.map(seatId => ({ seatId, runtime }))
    let guard = 0
    while ((await openTurnCount(db)) > 0 || (await pendingV2NativeInternalHandoffs(db, s, f)).length > 0) {
      await runV2NativeMeshTick(db, { scope: s, fence: f, seats, instanceId: `fixture-${guard}` })
      if (++guard > 8) throw new Error('mesh did not converge')
    }

    const count = async (where: string) => Number((await db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM event_log WHERE ${where}`))?.n ?? 0)
    expect(await count("event_type='message.received' AND CAST(payload AS TEXT) LIKE '%\"route_kind\":\"direct\"%'" )).toBe(6)
    expect(await count("event_type='message.received' AND CAST(payload AS TEXT) LIKE '%\"route_kind\":\"fanout_child\"%'" )).toBe(6)
    expect(await count("event_type='message.received' AND CAST(payload AS TEXT) LIKE '%\"route_kind\":\"reply\"%'" )).toBe(12)
    expect(await count("event_type='reply.handoff_accepted'" )).toBe(12)
    expect(await count("event_type='reply.delivered'" )).toBe(0)
    expect(await count("event_type='reply.provider_invocation_started'" )).toBe(0)
    expect(await count("event_type='turn.completed'" )).toBe(24)
    expect(await openTurnCount(db)).toBe(0)
    expect(await pendingV2NativeInternalHandoffs(db, s, f)).toEqual([])

    const duplicateCompletions = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT turn_id FROM event_log WHERE event_type='turn.completed'
          GROUP BY turn_id HAVING COUNT(*) > 1
       ) duplicates`,
    )
    const duplicateHandoffs = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT reply_id FROM event_log WHERE event_type='reply.handoff_accepted'
          GROUP BY reply_id HAVING COUNT(*) > 1
       ) duplicates`,
    )
    expect(Number(duplicateCompletions[0].n)).toBe(0)
    expect(Number(duplicateHandoffs[0].n)).toBe(0)
  })

  test('scope/runtime drift and partial fanout fail before any mutation', async () => {
    const s = scope()
    const driftedFence = { ...fence(s), runtime_snapshot_sha256: 'f'.repeat(64) }
    await expect(routeV2NativeMessage(db, s, driftedFence, {
      route_id: 'drift', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'x',
    })).rejects.toThrow('runtime snapshot drift')
    await expect(routeV2NativeMessage(db, s, fence(s), {
      route_id: 'partial', route_kind: 'fanout', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'x',
    })).rejects.toThrow('fanout must include every other frozen member')
    await expect(routeV2NativeMessage(db, { ...s, deadline_ms: Date.now() - 1 }, fence(s), {
      route_id: 'expired', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'x',
    })).rejects.toThrow('future Unix epoch')
    await expect(routeV2NativeMessage(db, s, fence(s), {
      route_id: 'atomic-crash', route_kind: 'fanout', source_agent_id: 'alpha', recipient_agent_ids: ['beta', 'gamma'], content: 'x',
    }, {
      onCommitPoint(point) {
        if (point.point === 'after_child' && point.child_index === 0) throw new Error('fixture fanout crash')
      },
    })).rejects.toThrow('fixture fanout crash')
    const runtime = deterministicV2NativeMeshRuntime(() => null)
    await expect(runV2NativeMeshTick(db, {
      scope: s,
      fence: fence(s),
      seats: [{ seatId: 'alpha', runtime }, { seatId: 'alpha', runtime }, { seatId: 'beta', runtime }],
      instanceId: 'missing-gamma',
    })).rejects.toThrow('complete frozen_enabled_set')
    expect(Number((await db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM event_log'))?.n ?? 0)).toBe(0)
  })
})
