import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { PgAdapter } from '../../core/db/pg-adapter'
import {
  dispatchV2NativeInternalHandoffs,
  ensureEventLogSchema,
  frozenEnabledSetSha256,
  routeV2NativeMessage,
  runtimeSnapshotSha256,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog'
import { deterministicV2NativeMeshRuntime } from '../../core/eventlog/runtimes'
import { runSeatWorkerOnce } from '../../core/eventlog/worker'

const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
  agent_id: agent, profile_revision: '1', runtime_engine: 'deterministic-k3',
  runtime_instance_id: `runtime-${agent}`, runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 4).repeat(40),
}))

const K1_UP = fileURLToPath(new URL('../../db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql', import.meta.url))
const PG_EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), seat_id TEXT, seat_instance_id TEXT,
    conversation_id TEXT, causation_id TEXT, correlation_id TEXT, turn_id TEXT, reply_id TEXT,
    claim_epoch INTEGER, payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE UNIQUE INDEX uq_el_turn_claim ON event_log(turn_id, claim_epoch) WHERE event_type='turn.claimed';
  CREATE UNIQUE INDEX uq_el_turn_completed ON event_log(turn_id) WHERE event_type='turn.completed';
  CREATE UNIQUE INDEX uq_el_delivery_claim ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_turn ON event_log(event_type, turn_id);
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
  CREATE INDEX idx_el_conversation ON event_log(conversation_id, seq);
  CREATE INDEX idx_el_seat_type ON event_log(seat_id, event_type);
  CREATE INDEX idx_el_causation ON event_log(causation_id);
`

const pgEnabled = () => process.env.AUN_K3_DB_SCOPE === 'isolated_disposable_fixture'

async function pgFixture() {
  const url = process.env.AUN_K3_TEST_DATABASE_URL
  if (!url) throw new Error('AUN_K3_TEST_DATABASE_URL is required')
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.startsWith('aun_k3_fixture_')) throw new Error(`unsafe K3 fixture database ${name}`)
  const schema = `k3_internal_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  const first = new PgAdapter(url)
  await first.execute(`CREATE SCHEMA "${schema}"`)
  await first.execute(`SET search_path TO "${schema}", public`)
  await first.execute(PG_EVENT_LOG_DDL)
  await first.execute(readFileSync(K1_UP, 'utf8'))
  const second = new PgAdapter(url)
  await second.execute(`SET search_path TO "${schema}", public`)
  return {
    first, second,
    async cleanup() { await second.close(); await first.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await first.close() },
  }
}

function scope(): V2NativeMeshScopeV1 {
  return {
    schema_version: 'aun-v2-native-mesh-scope/v1', run_id: 'k3-internal-exactly-once',
    stage_id: 'S0_IMPLEMENTATION', repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: 'f793b71d44af08b69490bf1e4f80f53493330d40',
    database_identity: 'sqlite:isolated:k3-internal', frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents), runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled', V1_mode: 'observe_only_no_traversal', deadline_ms: Date.now() + 30_000,
  }
}

describe('K3 V2-native internal handoff', () => {
  test('TC011 concurrent dispatchers place one received and one handoff with zero provider/V1 effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-k3-internal-'))
    const dbPath = join(dir, 'eventlog.db')
    const db = new SqliteAdapter(dbPath)
    await ensureEventLogSchema(db)
    try {
      const s = scope()
      const fence = {
        stage_id: 'S0_IMPLEMENTATION' as const, exact_implementation_head: s.exact_implementation_head,
        database_identity: s.database_identity, runtime_snapshot_sha256: s.runtime_snapshot_sha256,
      }
      await routeV2NativeMessage(db, s, fence, {
        route_id: 'alpha-beta', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'request',
      })
      const runtime = deterministicV2NativeMeshRuntime(({ seatId }) => seatId === 'beta' ? 'reply' : null)
      await runSeatWorkerOnce(db, { seatId: 'beta', seatInstanceId: 'beta-1', runtime })
      // SQLite is the local conformance backend and has one writer. Production
      // PostgreSQL exercises these as concurrent processes; the same claim
      // arbiter is exercised here by two competing dispatcher identities.
      const results = [
        await dispatchV2NativeInternalHandoffs(db, s, fence, { dispatcherInstanceId: 'handoff-1' }),
        await dispatchV2NativeInternalHandoffs(db, s, fence, { dispatcherInstanceId: 'handoff-2' }),
      ]
      expect(results.reduce((n, item) => n + item.accepted.length, 0)).toBe(1)
      expect(results.every(item => item.providerInvocations === 0 && item.externalSendAttempts === 0 && item.V1Invocations === 0)).toBe(true)
      const counts = await db.query<{ event_type: string; n: number }>(
        `SELECT event_type, COUNT(*) AS n FROM event_log
         WHERE event_type IN ('message.received','reply.handoff_accepted','reply.delivered','reply.provider_invocation_started')
         GROUP BY event_type`,
      )
      const byType = Object.fromEntries(counts.map(row => [row.event_type, Number(row.n)]))
      expect(byType['message.received']).toBe(2)
      expect(byType['reply.handoff_accepted']).toBe(1)
      expect(byType['reply.delivered'] ?? 0).toBe(0)
      expect(byType['reply.provider_invocation_started'] ?? 0).toBe(0)
    } finally {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.if(pgEnabled())('K3 PostgreSQL internal handoff concurrency', () => {
  test('TC011-PG concurrent dispatchers have one claim winner and one atomic placement', async () => {
    const pg = await pgFixture()
    try {
      const s = { ...scope(), database_identity: 'postgres:isolated:k3-internal' }
      const fence = {
        stage_id: 'S0_IMPLEMENTATION' as const, exact_implementation_head: s.exact_implementation_head,
        database_identity: s.database_identity, runtime_snapshot_sha256: s.runtime_snapshot_sha256,
      }
      await routeV2NativeMessage(pg.first, s, fence, {
        route_id: 'pg-alpha-beta', route_kind: 'direct', source_agent_id: 'alpha', recipient_agent_ids: ['beta'], content: 'request',
      })
      const runtime = deterministicV2NativeMeshRuntime(({ seatId }) => seatId === 'beta' ? 'reply' : null)
      await runSeatWorkerOnce(pg.first, {
        seatId: 'beta', seatInstanceId: 'beta-pg', runtime, claimExecutionMode: 'production_multi_worker',
      })
      const settled = await Promise.allSettled([
        dispatchV2NativeInternalHandoffs(pg.first, s, fence, { dispatcherInstanceId: 'pg-handoff-1' }),
        dispatchV2NativeInternalHandoffs(pg.second, s, fence, { dispatcherInstanceId: 'pg-handoff-2' }),
      ])
      const fulfilled = settled.filter(item => item.status === 'fulfilled').map(item => item.value)
      expect(fulfilled.reduce((n, item) => n + item.accepted.length, 0)).toBe(1)
      expect(Number((await pg.first.queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.handoff_accepted'"))?.n ?? 0)).toBe(1)
      expect(Number((await pg.first.queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type IN ('reply.delivered','reply.provider_invocation_started')"))?.n ?? 0)).toBe(0)
    } finally { await pg.cleanup() }
  })
})
