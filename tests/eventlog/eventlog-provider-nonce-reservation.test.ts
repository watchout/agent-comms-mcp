import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  InvocationStartCollisionError,
  ProviderNonceCollisionError,
  ensureEventLogSchema,
  reserveProviderNonce,
  startProviderInvocation,
  type ProviderInvocationStartPayloadV1,
  type ProviderNonceReservationPayloadV1,
} from '../../core/eventlog'

let dir: string
let path: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-nonce-'))
  path = join(dir, 'eventlog.db')
  db = new SqliteAdapter(path)
  await ensureEventLogSchema(db)
})

afterEach(async () => {
  await db.close().catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})

const reservation: ProviderNonceReservationPayloadV1 = {
  key: {
    connector_instance_id: '11111111-1111-4111-8111-111111111111',
    concrete_dedupe_scope_identity: '1'.repeat(64),
    provider_nonce: 'a1_abcdefghijklmnopqrstuv',
  },
  value: {
    business_nonce: 'business-1',
    delivery_digest: '2'.repeat(64),
    adapter_build_digest: '3'.repeat(64),
  },
}

const start: ProviderInvocationStartPayloadV1 = {
  delivery_id: 'delivery-1',
  reply_id: 'reply-1',
  recipient_seat_id: 'spec',
  attempt_ordinal: 0,
  provider_nonce: reservation.key.provider_nonce,
  delivery_digest: reservation.value.delivery_digest,
  provider_request_digest: '4'.repeat(64),
}

describe('ProviderNonceReservationPort', () => {
  test('two dispatchers converge to one durable reservation and same_delivery is not send authority', async () => {
    const results = await Promise.all([
      reserveProviderNonce(db, reservation),
      reserveProviderNonce(db, structuredClone(reservation)),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['reserved', 'same_delivery'])
    expect(results[0].eventId).toBe(results[1].eventId)
  })

  test('same key with different value is PROVIDER_NONCE_COLLISION and later provider calls remain zero', async () => {
    let providerInvocations = 0
    await reserveProviderNonce(db, reservation)
    const collision = structuredClone(reservation)
    collision.value.business_nonce = 'different-business'
    await expect(reserveProviderNonce(db, collision)).rejects.toBeInstanceOf(ProviderNonceCollisionError)
    expect(providerInvocations).toBe(0)
  })

  test('reservation survives file-backed WAL close/restart', async () => {
    expect((await reserveProviderNonce(db, reservation)).status).toBe('reserved')
    await db.close()
    db = new SqliteAdapter(path)
    expect((await reserveProviderNonce(db, reservation)).status).toBe('same_delivery')
  })

  test('separate processes race one SQLite reservation with one winner', async () => {
    const repoRoot = process.cwd()
    const payload = JSON.stringify(reservation)
    const script = `
      import { SqliteAdapter } from './core/db/sqlite-adapter.ts'
      import { reserveProviderNonce } from './core/eventlog/outbox.ts'
      const db = new SqliteAdapter(process.argv[1])
      const result = await reserveProviderNonce(db, JSON.parse(process.argv[2]))
      console.log(result.status)
      await db.close()
    `
    const children = [0, 1].map(() => Bun.spawn(['bun', '-e', script, path, payload], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' }))
    const outputs = await Promise.all(children.map(async child => {
      const stdout = await new Response(child.stdout).text()
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited).toBe(0)
      expect(stderr).toBe('')
      return stdout.trim()
    }))
    expect(outputs.sort()).toEqual(['reserved', 'same_delivery'])
  })
})

describe('ProviderInvocationStartPort', () => {
  test('only the inserted attempt CAS authorizes one provider invocation', async () => {
    await reserveProviderNonce(db, reservation)
    const results = await Promise.all([
      startProviderInvocation(db, start),
      startProviderInvocation(db, structuredClone(start)),
    ])
    expect(results.filter(result => result.providerInvocationAuthorized)).toHaveLength(1)
    expect(results.map(result => result.status).sort()).toEqual(['already_started', 'started'])
  })

  test('same attempt identity with different request is INVOCATION_START_COLLISION', async () => {
    await startProviderInvocation(db, start)
    const collision = { ...start, provider_request_digest: '5'.repeat(64) }
    await expect(startProviderInvocation(db, collision)).rejects.toBeInstanceOf(InvocationStartCollisionError)
  })

  test('already-started survives restart and never reauthorizes invocation', async () => {
    expect((await startProviderInvocation(db, start)).providerInvocationAuthorized).toBe(true)
    await db.close()
    db = new SqliteAdapter(path)
    const replay = await startProviderInvocation(db, start)
    expect(replay.status).toBe('already_started')
    expect(replay.providerInvocationAuthorized).toBe(false)
  })
})
