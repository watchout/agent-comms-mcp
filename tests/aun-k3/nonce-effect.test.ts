import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ProviderNonceCollisionError,
  dispatchV2OutboxOnce,
  ensureEventLogSchema,
  reserveProviderNonce,
  type ProviderNonceReservationPayloadV1,
} from '../../core/eventlog'
import { DiscordV2DeliveryTransportAdapter } from '../../adapters/eventlog/discord-transport'
import { FakeV2Adapter, appendUnit, makeDeliveryFixture } from './delivery-truth.test'

async function withDb<T>(run: (db: SqliteAdapter) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'aun-k3-nonce-'))
  const db = new SqliteAdapter(join(dir, 'eventlog.db'))
  await ensureEventLogSchema(db)
  try {
    return await run(db)
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('K3 nonce and effect cardinality', () => {
  test('TC004 same material twice performs one reservation, start, attempt, and effect', async () => withDb(async db => {
    const fixture = makeDeliveryFixture('provider_ack', 'same-material')
    const adapter = new FakeV2Adapter('provider_ack')
    await appendUnit(db, fixture)
    const options = {
      dispatcherId: 'aun-k3-dispatcher', dispatcherInstanceId: 'dispatcher-1',
      targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
      loadRegistration: () => fixture.registration,
    }
    await dispatchV2OutboxOnce(db, adapter, options)
    await dispatchV2OutboxOnce(db, adapter, { ...options, dispatcherInstanceId: 'dispatcher-2' })
    const counts = await db.query<{ event_type: string; n: number }>(
      `SELECT event_type, COUNT(*) AS n FROM event_log
       WHERE event_type IN ('reply.provider_nonce_reserved','reply.provider_invocation_started','reply.delivered')
       GROUP BY event_type`,
    )
    expect(Object.fromEntries(counts.map(row => [row.event_type, Number(row.n)]))).toEqual({
      'reply.delivered': 1,
      'reply.provider_invocation_started': 1,
      'reply.provider_nonce_reserved': 1,
    })
    expect(adapter.calls).toBe(1)
  }))

  test('TC005 nonce collision with different canonical material authorizes no second effect', async () => withDb(async db => {
    const base: ProviderNonceReservationPayloadV1 = {
      key: {
        connector_instance_id: '33333333-3333-4333-8333-333333333333',
        concrete_dedupe_scope_identity: 'f'.repeat(64),
        provider_nonce: 'a1_collision_fixture',
      },
      value: { business_nonce: 'business-1', delivery_digest: '1'.repeat(64), adapter_build_digest: 'a'.repeat(64) },
    }
    await reserveProviderNonce(db, base)
    let error: unknown
    try {
      await reserveProviderNonce(db, { ...base, value: { ...base.value, delivery_digest: '2'.repeat(64) } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ProviderNonceCollisionError)
    expect((error as ProviderNonceCollisionError).code).toBe('PROVIDER_NONCE_COLLISION')
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.provider_invocation_started'"))?.n)).toBe(0)
  }))

  test('TC006 Discord numeric 40062 is unknown, never success or receipt truth', async () => withDb(async db => {
    const fixture = makeDeliveryFixture('provider_ack', 'discord-40062', 'discord')
    await appendUnit(db, fixture)
    let providerCalls = 0
    const adapter = new DiscordV2DeliveryTransportAdapter({
      capability_authority: fixture.authority,
      provider: {
        async sendFrozenProviderRequest() {
          providerCalls += 1
          throw Object.assign(new Error('nonce already used'), { code: 40062 })
        },
      },
      now: () => '2026-07-17T00:00:00Z',
    })
    const result = await dispatchV2OutboxOnce(db, adapter, {
      dispatcherId: 'aun-k3-dispatcher', dispatcherInstanceId: 'dispatcher-1',
      targetConnectorInstanceId: fixture.unit.destination.connector_instance_id,
      loadRegistration: () => fixture.registration,
    })
    expect(providerCalls).toBe(1)
    expect(result.deliveryUnknown).toEqual([fixture.unit.reply_id])
    expect(result.delivered).toEqual([])
    expect(Number((await db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM event_log WHERE event_type='reply.delivered'"))?.n)).toBe(0)
  }))
})
