import { expect, test } from 'bun:test'
import {
  activeTurnProjection,
  appendV2NativeInbound,
  claimNextTurn,
  completeTurn,
  frozenEnabledSetSha256,
  runtimeSnapshotSha256,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { createK1SqliteFixture } from './helpers/sqlite-fixture'

const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'k1-fixture',
  runtime_instance_id: `runtime-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 1).repeat(40),
}))

test('direct registry-derived V2 ingress opens only the intended V2 inbox with zero V1/provider effects', async () => {
  const fixture = await createK1SqliteFixture('v2_ingress')
  try {
    await fixture.db.execute('CREATE TABLE message_queue (id INTEGER PRIMARY KEY)')
    await fixture.db.execute('CREATE TABLE agent_messages (id INTEGER PRIMARY KEY)')
    await fixture.db.execute('CREATE TABLE outbound_queue (id INTEGER PRIMARY KEY)')
    const scope: V2NativeMeshScopeV1 = {
      schema_version: 'aun-v2-native-mesh-scope/v1',
      run_id: 'k1-v2-free',
      stage_id: 'S0_IMPLEMENTATION',
      repository: 'watchout/agent-comms-mcp',
      exact_implementation_head: '08a1bd144145ae0e5c46da49fcbc78898440d913',
      database_identity: 'sqlite:isolated:k1-v2-free',
      frozen_enabled_set: agents,
      frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
      runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
      provider_dispatch: 'disabled',
      V1_mode: 'observe_only_no_traversal',
      deadline_ms: Date.now() + 30_000,
    }
    const fence = {
      stage_id: 'S0_IMPLEMENTATION' as const,
      exact_implementation_head: scope.exact_implementation_head,
      database_identity: scope.database_identity,
      runtime_snapshot_sha256: scope.runtime_snapshot_sha256,
    }
    await appendV2NativeInbound(fixture.db, scope, fence, {
      message_id: 'k1-direct-1', delivery_id: 'delivery-1', route_id: 'route-1', route_kind: 'direct',
      source_agent_id: 'alpha', recipient_agent_id: 'beta', content: 'hello',
      conversation_id: 'conversation-1', correlation_id: 'correlation-1',
    })
    const projection = await activeTurnProjection(fixture.db, { seatId: 'beta' })
    expect(projection).toHaveLength(1)
    expect(projection[0]).toMatchObject({ message_id: 'k1-direct-1', availability: 'available' })

    const claim = await claimNextTurn(fixture.db, {
      seatId: 'beta', seatInstanceId: 'runtime-beta', executionMode: 'unit_conformance',
    })
    await completeTurn(fixture.db, {
      turnId: claim!.turn.turn_id, seatId: 'beta', seatInstanceId: 'runtime-beta',
      claimEventId: claim!.claimEventId, outcome: 'no_reply',
    })
    for (const table of ['message_queue', 'agent_messages', 'outbound_queue']) {
      expect(Number((await fixture.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n)).toBe(0)
    }
    const provider = await fixture.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.provider_invocation_started'`,
    )
    expect(Number(provider?.n)).toBe(0)
  } finally {
    await fixture.cleanup()
  }
})
