import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/runtime-binding-valid-v1.json'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import type { DbAdapter } from '../../core/db/adapter'
import {
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  receiveMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { runSeatWorkerOnce, runV2NativeMeshTick } from '../../core/eventlog/worker'
import {
  resolveRuntimeBinding,
  resolvedRuntimeBindingDigest,
  RuntimeBindingResolutionError,
  type ResolvedRuntimeBindingV1,
} from '../../core/eventlog/runtime-binding'

const EXPECTED_DIGEST = '884dad9171c1800576b689fec0ec336a04322d412583a960a80d74904e535cd5'

function clone(): Record<string, unknown> {
  return structuredClone(fixture) as Record<string, unknown>
}

describe('K2 exact runtime binding', () => {
  test('K2-TC-001 canonical fixture resolves to the frozen digest', () => {
    const binding = resolveRuntimeBinding({ binding: clone() })
    expect(resolvedRuntimeBindingDigest(binding)).toBe(EXPECTED_DIGEST)
    expect(Object.keys(binding)).toHaveLength(14)
  })

  test('K2-TC-002 every missing/extra/unsorted shape fails closed', () => {
    for (const key of Object.keys(fixture)) {
      const missing = clone()
      delete missing[key]
      expect(() => resolveRuntimeBinding({ binding: missing })).toThrow(RuntimeBindingResolutionError)
    }
    const extra = clone()
    extra.unknown = 'forbidden'
    expect(() => resolveRuntimeBinding({ binding: extra })).toThrow('binding keys differ')
    for (const field of ['allowed_tools', 'allowed_env_keys'] as const) {
      const reversed = clone()
      reversed[field] = [...(reversed[field] as string[])].reverse()
      expect(() => resolveRuntimeBinding({ binding: reversed })).toThrow(`${field} must be sorted and unique`)
    }
  })

  test('K2-TC-003 every observed authority drift rejects before real worker effects', async () => {
    const binding = resolveRuntimeBinding({ binding: clone() })
    const driftCases: Array<keyof ResolvedRuntimeBindingV1 | 'checkout_dirty' | 'unknown_field'> = [
      'runtime_instance_id', 'workspace_realpath', 'active_function', 'policy_digest',
      'authority_snapshot_digest', 'build_sha', 'tree_hash', 'config_digest', 'checkout_dirty', 'unknown_field',
    ]
    for (const axis of driftCases) {
      const db = new SqliteAdapter(':memory:')
      try {
        await ensureEventLogSchema(db)
        await receiveMessage(db, { messageId: `drift-${axis}`, seatId: 'arc' })
        const current = structuredClone(binding) as ResolvedRuntimeBindingV1 & {
          checkout_dirty?: boolean
          unknown_field?: string
        }
        const mutable = current as unknown as Record<string, unknown>
        if (axis === 'checkout_dirty') current.checkout_dirty = true
        else if (axis === 'unknown_field') current.unknown_field = 'forbidden'
        else if (axis === 'workspace_realpath') mutable[axis] = '/workspace/drift'
        else if (axis.endsWith('digest')) mutable[axis] = 'f'.repeat(64)
        else if (axis === 'build_sha' || axis === 'tree_hash') mutable[axis] = 'f'.repeat(40)
        else mutable[axis] = `${String(mutable[axis])}-drift`
        let modelCalls = 0
        await expect(runSeatWorkerOnce(db, {
          seatId: 'arc', seatInstanceId: `runtime-${axis}`,
          runtime: { async runTurn() { modelCalls += 1; return { outcome: 'no_reply' } } },
          maxTurns: 1,
          runtimeBinding: binding,
          currentRuntimeBinding: () => current,
        })).rejects.toBeInstanceOf(RuntimeBindingResolutionError)
        expect(modelCalls).toBe(0)
        expect(Number((await db.queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.claimed'`,
        ))?.n)).toBe(0)
        expect(Number((await db.queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM event_log WHERE event_type='turn.completed'`,
        ))?.n)).toBe(0)
        expect((await db.queryOne<{ availability: string }>(
          'SELECT availability FROM event_log_turn_projection',
        ))?.availability).toBe('available')
      } finally {
        await db.close()
      }
    }
  })

  test('unadmitted model adapter is rejected by the pure resolver', () => {
    const unknown = clone()
    unknown.model_adapter = 'unknown-engine'
    try {
      resolveRuntimeBinding({ binding: unknown })
      throw new Error('expected runtime binding rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBindingResolutionError)
      expect((error as RuntimeBindingResolutionError).code).toBe('RUNTIME_ENGINE_UNADMITTED')
    }
  })

  test('complete production binding admission is atomic before adapter construction', async () => {
    const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
      agent_id: agent,
      profile_revision: '1',
      runtime_engine: 'codex',
      runtime_instance_id: `runtime-${agent}`,
      runtime_checkout_root: `/workspace/${agent}`,
      runtime_checkout_sha: String(index + 1).repeat(40),
    }))
    const scope: V2NativeMeshScopeV1 = {
      schema_version: 'aun-v2-native-mesh-scope/v1',
      run_id: 'k2-binding-admission',
      stage_id: 'S0_IMPLEMENTATION',
      repository: 'watchout/agent-comms-mcp',
      exact_implementation_head: '9'.repeat(40),
      database_identity: 'sqlite:isolated:k2-binding-admission',
      frozen_enabled_set: agents,
      frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
      runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
      provider_dispatch: 'disabled',
      V1_mode: 'observe_only_no_traversal',
      deadline_ms: Date.now() + 30_000,
    }
    const db: DbAdapter = {
      dialect: 'sqlite',
      async query() { return [] },
      async queryOne() { return null },
      async execute() { return { rowCount: 0 } },
      async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) },
      async close() {},
    }
    let runtimeAdapters = 0
    let databaseAdapters = 0
    const seats = agents.map((agent, index) => {
      const source = clone()
      source.agent_id = agent.agent_id
      source.runtime_instance_id = agent.runtime_instance_id
      source.workspace_realpath = agent.runtime_checkout_root
      source.build_sha = agent.runtime_checkout_sha
      const binding = resolveRuntimeBinding({ binding: source })
      const current = index === 1 ? { ...binding, config_digest: 'f'.repeat(64) } : binding
      return {
        seatId: agent.agent_id,
        runtime: { async runTurn() { return { outcome: 'no_reply' as const } } },
        runtimeFactory: () => {
          runtimeAdapters += 1
          return { async runTurn() { return { outcome: 'no_reply' as const } } }
        },
        runtimeInstanceId: agent.runtime_instance_id,
        runtimeCheckoutRoot: agent.runtime_checkout_root,
        runtimeCheckoutSha: agent.runtime_checkout_sha,
        resolvedRuntimeBinding: binding,
        currentRuntimeBinding: () => current,
      }
    })
    await expect(runV2NativeMeshTick(db, {
      scope,
      fence: {
        stage_id: scope.stage_id,
        exact_implementation_head: scope.exact_implementation_head,
        database_identity: scope.database_identity,
        runtime_snapshot_sha256: scope.runtime_snapshot_sha256,
      },
      seats,
      instanceId: 'k2-binding-admission',
      dbFactory: async () => {
        databaseAdapters += 1
        return db
      },
    })).rejects.toBeInstanceOf(RuntimeBindingResolutionError)
    expect(runtimeAdapters).toBe(0)
    expect(databaseAdapters).toBe(0)
  })

  test('valid production bindings construct one isolated adapter per supervision unit', async () => {
    const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
      agent_id: agent,
      profile_revision: '1',
      runtime_engine: 'codex',
      runtime_instance_id: `runtime-${agent}`,
      runtime_checkout_root: `/workspace/${agent}`,
      runtime_checkout_sha: String(index + 3).repeat(40),
    }))
    const scope: V2NativeMeshScopeV1 = {
      schema_version: 'aun-v2-native-mesh-scope/v1', run_id: 'k2-valid-admission',
      stage_id: 'S0_IMPLEMENTATION', repository: 'watchout/agent-comms-mcp',
      exact_implementation_head: '8'.repeat(40), database_identity: 'sqlite:isolated:k2-valid-admission',
      frozen_enabled_set: agents, frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
      runtime_snapshot_sha256: runtimeSnapshotSha256(agents), provider_dispatch: 'disabled',
      V1_mode: 'observe_only_no_traversal', deadline_ms: Date.now() + 30_000,
    }
    const primary: DbAdapter = {
      dialect: 'sqlite', async query() { return [] }, async queryOne() { return null },
      async execute() { return { rowCount: 0 } },
      async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) }, async close() {},
    }
    let runtimeAdapters = 0
    const connections: Array<{ id: string; closed: boolean }> = []
    const seats = agents.map(agent => {
      const source = clone()
      source.agent_id = agent.agent_id
      source.runtime_instance_id = agent.runtime_instance_id
      source.workspace_realpath = agent.runtime_checkout_root
      source.build_sha = agent.runtime_checkout_sha
      const binding = resolveRuntimeBinding({ binding: source })
      return {
        seatId: agent.agent_id,
        runtime: { async runTurn() { return { outcome: 'no_reply' as const } } },
        runtimeFactory: () => {
          runtimeAdapters += 1
          return { async runTurn() { return { outcome: 'no_reply' as const } } }
        },
        runtimeInstanceId: agent.runtime_instance_id,
        runtimeCheckoutRoot: agent.runtime_checkout_root,
        runtimeCheckoutSha: agent.runtime_checkout_sha,
        resolvedRuntimeBinding: binding,
        currentRuntimeBinding: () => binding,
      }
    })
    const result = await runV2NativeMeshTick(primary, {
      scope,
      fence: {
        stage_id: scope.stage_id, exact_implementation_head: scope.exact_implementation_head,
        database_identity: scope.database_identity, runtime_snapshot_sha256: scope.runtime_snapshot_sha256,
      },
      seats,
      instanceId: 'k2-valid-admission',
      dbFactory: async unit => {
        const connection = { id: unit.unitId, closed: false }
        connections.push(connection)
        return {
          dialect: 'sqlite', async query() { return [] }, async queryOne() { return null },
          async execute() { return { rowCount: 0 } },
          async transaction<T>(fn: (tx: DbAdapter) => Promise<T>) { return fn(this) },
          async close() { connection.closed = true },
        }
      },
      supervision: { maxConcurrency: 1, unitTimeoutMs: 1_000 },
    })
    expect(runtimeAdapters).toBe(2)
    expect(connections.map(connection => connection.id).sort()).toEqual([
      'outbox:v2-native-internal-handoff', 'seat:alpha', 'seat:beta',
    ])
    expect(connections.every(connection => connection.closed)).toBeTrue()
    expect(result.supervision.units.every(unit => unit.status === 'completed')).toBeTrue()
    expect(result.seatResults).toEqual({
      alpha: { claimed: 0, completed: 0, failed: 0, staleLost: 0 },
      beta: { claimed: 0, completed: 0, failed: 0, staleLost: 0 },
    })
  })
})
