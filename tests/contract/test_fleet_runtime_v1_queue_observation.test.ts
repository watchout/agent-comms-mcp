import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { PgAdapter } from '../../core/db'
import type { DbAdapter } from '../../core/db'
import { assertNoProductionDestructiveMigration } from '../../db/destructive-migration-gate'
import {
  FLEET_RUNTIME_QUEUE_OBSERVATION_V2,
  FleetRuntimeObservationError,
  assertFleetRuntimeFreshResumeObservation,
  assertFleetRuntimePreToPostObservation,
  assertFleetRuntimeQueueObservationV2,
  assertFleetRuntimeSealToPreObservation,
  canonicalFleetRuntimeObservationJson,
  digestFleetRuntimeObservationMaterial,
  fleetRuntimeProfileBindingMaterial,
  fleetRuntimeQueueObservationIdMaterial,
  readFleetRuntimeQueueObservationV2,
  type FleetRuntimeQueueObservationV2,
} from '../../core/fleet-runtime-v1-queue-observation'

const SAFE_TEST_DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/

interface TestDatabaseBindingEnvironment {
  AGENT_COM_TEST_DATABASE_NAME?: string
  AGENT_COM_TEST_DATABASE_URL?: string
  DATABASE_URL?: string
}

function resolveTestDatabaseBinding(environment: TestDatabaseBindingEnvironment): {
  databaseName: string
  databaseUrl: string
} {
  const databaseUrl = environment.AGENT_COM_TEST_DATABASE_URL ?? environment.DATABASE_URL
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0 || databaseUrl !== databaseUrl.trim()
    || !/^postgres(?:ql)?:\/\//.test(databaseUrl) || databaseUrl.includes('#')) {
    throw new Error('a strict PostgreSQL test database URL is required')
  }
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new Error('a strict PostgreSQL test database URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || parsed.searchParams.has('database') || parsed.searchParams.has('dbname') || parsed.searchParams.has('db')) {
    throw new Error('test database URL identity is ambiguous')
  }
  const hierarchy = databaseUrl.slice(databaseUrl.indexOf(':') + 1)
  const rawLocation = hierarchy.slice(2).split('?', 1)[0]
  const pathOffset = rawLocation.indexOf('/')
  const rawPath = pathOffset === -1 ? '' : rawLocation.slice(pathOffset)
  if (!/^\/[^/]+$/.test(rawPath)) throw new Error('test database URL must have one exact pathname segment')
  let databaseName: string
  try {
    databaseName = decodeURIComponent(rawPath.slice(1))
  } catch {
    throw new Error('test database URL pathname must be valid percent encoding')
  }
  if (!SAFE_TEST_DATABASE_NAME.test(databaseName) || databaseName === 'agent_comms' || databaseName === 'postgres') {
    throw new Error('test database URL must identify a safe non-production _test database')
  }
  const explicitName = environment.AGENT_COM_TEST_DATABASE_NAME
  if (explicitName !== undefined && (explicitName.length === 0 || explicitName !== explicitName.trim()
    || explicitName !== databaseName)) {
    throw new Error('AGENT_COM_TEST_DATABASE_NAME must exactly match the URL-derived database name')
  }
  return { databaseName, databaseUrl }
}

const TEST_DATABASE_BINDING = resolveTestDatabaseBinding(process.env)
const TEST_DATABASE_NAME = TEST_DATABASE_BINDING.databaseName
const TEST_DATABASE_URL = TEST_DATABASE_BINDING.databaseUrl
const UP_PATH = resolve(import.meta.dir, '../../db/migrations/2026-08-16-fleet-runtime-queue-observation-v2.up.sql')
const DOWN_PATH = resolve(import.meta.dir, '../../db/migrations/2026-08-16-fleet-runtime-queue-observation-v2.down.sql')
const UP_SQL = readFileSync(UP_PATH, 'utf8')
const DOWN_SQL = readFileSync(DOWN_PATH, 'utf8')

const PREDICATES = [
  'P-ADMISSION', 'P-SCHEMA', 'P-SNAPSHOT', 'P-FRESH', 'P-IDENTITY', 'P-OLDNEW', 'P-ABA', 'P-EPOCH',
  'P-BOOTSTRAP', 'P-ZERO', 'P-SEALPRE', 'P-PREPOST', 'P-PROFILE', 'P-BINDING', 'P-SECRECY', 'P-REVISION',
  'P-MIGRATION', 'P-ROLLOUT', 'P-BUDGET', 'P-TRACE', 'P-NOEFFECT', 'P-NESTEDTYPE', 'P-BOOTSTRAPSET',
  'P-PROFILEMAT', 'P-DOWNGATE', 'P-POST-CANARY', 'P-POST-ROLLBACK', 'P-POST-RECOVERY', 'P-POST-REAPPLY',
] as const

function expectObservationCode(operation: () => unknown, code: FleetRuntimeObservationError['code']): void {
  try {
    operation()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(FleetRuntimeObservationError)
    expect((error as FleetRuntimeObservationError).code).toBe(code)
  }
}

function observation(nowMs = Date.now()): FleetRuntimeQueueObservationV2 {
  const sourceBase = {
    dialect: 'postgres' as const,
    database_name: 'agent_comms',
    database_oid: '16384',
    database_user: 'yuji',
    system_identifier: '7612345678901234567',
  }
  const source = {
    ...sourceBase,
    profile_binding_digest: digestFleetRuntimeObservationMaterial(fleetRuntimeProfileBindingMaterial(sourceBase)),
    migration_epoch: '7',
  }
  const queueBase = {
    agent_id: 'kodama' as const,
    revision: '11',
    active_rows: [],
    active_rows_sha256: digestFleetRuntimeObservationMaterial([]),
    pending_count: 0,
    received_count: 0,
    in_progress_count: 0,
  }
  return {
    schema_version: 'fleet-runtime-v1/observation/v2',
    contract_revision: 2,
    observed_at: new Date(nowMs).toISOString(),
    source,
    queue: {
      ...queueBase,
      queue_observation_id: digestFleetRuntimeObservationMaterial(fleetRuntimeQueueObservationIdMaterial(source, queueBase)),
    },
    executor_profile: {
      agent_id: 'aun-runtime-executor', agent_type: 'system', runtime: 'local_process', status: 'offline',
      profile_enabled: true, profile_revision: 1, profile_source: 'agent.register',
    },
    kodama_registry: {
      agent_id: 'kodama', agent_type: 'dev', runtime: 'TUI', status: 'offline', profile_enabled: true,
      profile_revision: 1, home_directory: '/Users/yuji/Developer/kodama',
    },
    runtime_inventory: { latest_instance: null },
  }
}

function refreshQueueIdentity(value: FleetRuntimeQueueObservationV2): void {
  value.queue.active_rows_sha256 = digestFleetRuntimeObservationMaterial(value.queue.active_rows)
  const material = { ...value.queue }
  delete (material as Partial<typeof material>).queue_observation_id
  value.queue.queue_observation_id = digestFleetRuntimeObservationMaterial(
    fleetRuntimeQueueObservationIdMaterial(value.source, material),
  )
}

async function connect(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL })
  await client.connect()
  const identity = await client.query('SELECT current_database() AS database_name')
  expect(identity.rows[0].database_name).toBe(TEST_DATABASE_NAME)
  return client
}

async function objectDigest(client: Client): Promise<string> {
  const rows = await client.query(`
    SELECT c.relname AS name, c.relkind AS kind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname LIKE 'fleet_runtime_queue_%'
       AND c.relname <> 'fleet_runtime_queue_observation_epoch_seq'
    UNION ALL
    SELECT p.proname AS name, 'f' AS kind
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'fleet_runtime_bump_queue_agent_revision_v2'
    ORDER BY name, kind
  `)
  return createHash('sha256').update(canonicalFleetRuntimeObservationJson(rows.rows)).digest('hex')
}

describe('fleet runtime queue observation v2 semantic core', () => {
  test('predicate registry is exact, unique, and complete', () => {
    expect(PREDICATES).toHaveLength(29)
    expect(new Set(PREDICATES).size).toBe(29)
    expect(FLEET_RUNTIME_QUEUE_OBSERVATION_V2).toMatchObject({ contract_revision: 2, target_agent_id: 'kodama' })
    expect(UP_SQL.indexOf("SET LOCAL lock_timeout = '5000ms'")).toBeLessThan(UP_SQL.indexOf('LOCK TABLE message_queue'))
    expect(UP_SQL.indexOf("SET LOCAL statement_timeout = '30000ms'")).toBeLessThan(UP_SQL.indexOf('LOCK TABLE message_queue'))
    expect(UP_SQL.indexOf('LOCK TABLE message_queue')).toBeLessThan(UP_SQL.indexOf('CREATE SEQUENCE'))
    expect(() => assertNoProductionDestructiveMigration(DOWN_SQL, 'postgresql:///agent_comms', {})).toThrow(
      'Destructive migration targets production database',
    )
    const makerName = 'agent_comms_n40_queue_observation_ci_fallback_rework_test'
    const makerUrl = `postgresql:///${makerName}?host=/tmp`
    expect(resolveTestDatabaseBinding({
      AGENT_COM_TEST_DATABASE_NAME: makerName,
      AGENT_COM_TEST_DATABASE_URL: makerUrl,
      DATABASE_URL: 'postgresql:///agent_comms',
    })).toEqual({ databaseName: makerName, databaseUrl: makerUrl })
    const auditName = 'agent_comms_n40_queue_observation_ci_fallback_independent_audit_test'
    const auditUrl = `postgresql:///${auditName}?host=/tmp`
    expect(resolveTestDatabaseBinding({
      AGENT_COM_TEST_DATABASE_NAME: auditName,
      AGENT_COM_TEST_DATABASE_URL: auditUrl,
    })).toEqual({ databaseName: auditName, databaseUrl: auditUrl })
    const hostedUrl = ['postgresql://', 'postgres', ':', 'postgres', '@localhost:5432/agent_comms_test'].join('')
    const credentialOnlyUrl = ['postgresql://', 'user', ':', 'password', '@localhost'].join('')
    expect(resolveTestDatabaseBinding({ DATABASE_URL: hostedUrl })).toEqual({
      databaseName: 'agent_comms_test', databaseUrl: hostedUrl,
    })
    const invalidBindings: TestDatabaseBindingEnvironment[] = [
      {},
      { DATABASE_URL: 'not-a-url' },
      { DATABASE_URL: 'sqlite:///agent_comms_test' },
      { DATABASE_URL: credentialOnlyUrl },
      { DATABASE_URL: 'postgresql:///agent_comms' },
      { DATABASE_URL: 'postgresql:///postgres' },
      { DATABASE_URL: 'postgresql:///agent_comms_dev' },
      { DATABASE_URL: 'postgresql:///agent_comms_test/other' },
      { DATABASE_URL: 'postgresql:///agent_comms%2Ftest_test' },
      { DATABASE_URL: 'postgresql:///agent_comms_test?database=other_test' },
      { DATABASE_URL: hostedUrl, AGENT_COM_TEST_DATABASE_NAME: 'other_test' },
    ]
    for (const invalid of invalidBindings) expect(() => resolveTestDatabaseBinding(invalid)).toThrow()
  })

  test('exact envelope accepts only canonical nested keys, types, identities, and digests', () => {
    const valid = observation()
    expect(() => assertFleetRuntimeQueueObservationV2(valid)).not.toThrow()
    const mutations: Array<(value: any) => void> = [
      value => { value.schema_version = 'fleet-runtime-v1/observation/v1' },
      value => { value.contract_revision = 1 },
      value => { value.extra = true },
      value => { value.source.extra = true },
      value => { value.source.database_oid = 16384 },
      value => { value.source.profile_binding_digest = `sha256:${'a'.repeat(64)}` },
      value => { value.queue.revision = 1 },
      value => { value.queue.pending_count = '0' },
      value => { value.queue.active_rows_sha256 = `sha256:${'a'.repeat(64)}` },
      value => { value.queue.queue_observation_id = `sha256:${'a'.repeat(64)}` },
      value => { value.executor_profile.profile_enabled = false },
      value => { value.executor_profile.runtime = 'codex' },
      value => { value.kodama_registry.runtime = 'codex' },
      value => { value.kodama_registry.home_directory = '../kodama' },
      value => { value.runtime_inventory.extra = null },
    ]
    for (const mutate of mutations) {
      const candidate: any = structuredClone(valid)
      mutate(candidate)
      expectObservationCode(() => assertFleetRuntimeQueueObservationV2(candidate), 'QUEUE_OBSERVATION_INVALID')
    }
  })

  test('active rows are numerically sorted and all nested runtime nullability is exact', () => {
    const valid = observation()
    valid.queue.active_rows = [{ id: '2', status: 'received' }, { id: '10', status: 'in_progress' }]
    valid.queue.received_count = 1
    valid.queue.in_progress_count = 1
    refreshQueueIdentity(valid)
    expect(() => assertFleetRuntimeQueueObservationV2(valid)).not.toThrow()
    const reversed = structuredClone(valid)
    reversed.queue.active_rows.reverse()
    refreshQueueIdentity(reversed)
    expectObservationCode(() => assertFleetRuntimeQueueObservationV2(reversed), 'QUEUE_OBSERVATION_INVALID')
    const post = observation()
    post.runtime_inventory.latest_instance = {
      runtime_instance_id: '00000000-0000-4000-8000-000000000001', status: 'running', session_name: 'discord-kodama',
      port: 8803, checkout_path: '/safe/state/invocations/x/checkout', commit_sha: 'a'.repeat(40),
      started_at: post.observed_at, stopped_at: null, last_seen_at: post.observed_at, git_dirty: false,
    }
    expect(() => assertFleetRuntimeQueueObservationV2(post)).not.toThrow()
    const invalid = structuredClone(post) as any
    invalid.runtime_inventory.latest_instance.git_dirty = 'false'
    expectObservationCode(() => assertFleetRuntimeQueueObservationV2(invalid), 'QUEUE_OBSERVATION_INVALID')
  })

  test('observed_at is freshness-only while queue identity detects ABA and excludes inventory', () => {
    const now = Date.now()
    const sealed = observation(now - 1_000)
    const pre = structuredClone(sealed)
    pre.observed_at = new Date(now).toISOString()
    expect(() => assertFleetRuntimeSealToPreObservation(sealed, pre, now)).not.toThrow()
    const inventoryOnly = structuredClone(sealed)
    inventoryOnly.runtime_inventory.latest_instance = {
      runtime_instance_id: '00000000-0000-4000-8000-000000000001', status: 'running', session_name: 'discord-kodama',
      port: 8803, checkout_path: '/safe/state/run', commit_sha: 'a'.repeat(40), started_at: sealed.observed_at,
      stopped_at: null, last_seen_at: sealed.observed_at, git_dirty: false,
    }
    expect(inventoryOnly.queue.queue_observation_id).toBe(sealed.queue.queue_observation_id)
    const aba = structuredClone(sealed)
    aba.queue.revision = String(BigInt(aba.queue.revision) + 2n)
    refreshQueueIdentity(aba)
    expect(aba.queue.active_rows_sha256).toBe(sealed.queue.active_rows_sha256)
    expect(aba.queue.queue_observation_id).not.toBe(sealed.queue.queue_observation_id)
    expectObservationCode(() => assertFleetRuntimeSealToPreObservation(sealed, aba, now), 'QUEUE_OBSERVATION_DRIFT')
  })

  test('resume admission binding admits one exact fresh observation but still requires a zero queue', () => {
    const now = Date.now()
    const sealed = observation(now - 10_000)
    const admitted = structuredClone(sealed)
    admitted.observed_at = new Date(now).toISOString()
    admitted.queue.revision = '12'
    admitted.kodama_registry.status = 'busy'
    refreshQueueIdentity(admitted)
    const binding = {
      sealed_queue_revision: sealed.queue.revision,
      admitted_fresh_queue_revision: admitted.queue.revision,
      admitted_fresh_queue_observation_id: admitted.queue.queue_observation_id,
    }

    expect(() => assertFleetRuntimeFreshResumeObservation(sealed, admitted, now, binding)).not.toThrow()

    const drifted = structuredClone(admitted)
    drifted.queue.revision = '13'
    refreshQueueIdentity(drifted)
    expectObservationCode(
      () => assertFleetRuntimeFreshResumeObservation(sealed, drifted, now, binding),
      'QUEUE_OBSERVATION_DRIFT',
    )
    expectObservationCode(
      () => assertFleetRuntimeFreshResumeObservation(sealed, admitted, now, {
        ...binding,
        admitted_fresh_queue_observation_id: `sha256:${'f'.repeat(64)}`,
      }),
      'QUEUE_OBSERVATION_DRIFT',
    )
    expectObservationCode(
      () => assertFleetRuntimeFreshResumeObservation(sealed, admitted, now, {
        ...binding,
        sealed_queue_revision: '10',
      }),
      'QUEUE_OBSERVATION_DRIFT',
    )
    const nonzero = structuredClone(admitted)
    nonzero.queue.pending_count = 1
    nonzero.queue.active_rows = [{ id: '1', status: 'pending' }]
    refreshQueueIdentity(nonzero)
    expectObservationCode(
      () => assertFleetRuntimeFreshResumeObservation(sealed, nonzero, now, {
        ...binding,
        admitted_fresh_queue_observation_id: nonzero.queue.queue_observation_id,
      }),
      'QUEUE_OBSERVATION_DRIFT',
    )
  })

  test('seal/pre and pre/post matrices reject stale, queue/profile/source drift and admit one fresh runtime delta', () => {
    const now = Date.now()
    const pre = observation(now - 1_000)
    const stale = observation(now - 300_001)
    expectObservationCode(() => assertFleetRuntimeSealToPreObservation(stale, stale, now), 'QUEUE_OBSERVATION_STALE')
    for (const key of ['source', 'queue', 'executor_profile', 'kodama_registry'] as const) {
      const post: any = structuredClone(pre)
      if (key === 'source') { post.source.migration_epoch = '9'; refreshQueueIdentity(post) }
      if (key === 'queue') { post.queue.revision = '12'; refreshQueueIdentity(post) }
      if (key === 'executor_profile') post.executor_profile.profile_revision = 2
      if (key === 'kodama_registry') post.kodama_registry.profile_revision = 2
      expectObservationCode(() => assertFleetRuntimePreToPostObservation(pre, post, {
        approvedStateRoot: '/safe/state', canonicalCheckout: '/Users/yuji/Developer/kodama', nowMs: now,
      }), 'QUEUE_OBSERVATION_DRIFT')
    }
    const post = structuredClone(pre)
    post.observed_at = new Date(now).toISOString()
    post.runtime_inventory.latest_instance = {
      runtime_instance_id: '00000000-0000-4000-8000-000000000001', status: 'running', session_name: 'discord-kodama',
      port: 8803, checkout_path: '/safe/state/invocations/key/checkout', commit_sha: 'a'.repeat(40),
      started_at: new Date(now - 2_000).toISOString(), stopped_at: null, last_seen_at: new Date(now - 1_000).toISOString(),
      git_dirty: false,
    }
    expect(() => assertFleetRuntimePreToPostObservation(pre, post, {
      approvedStateRoot: '/safe/state', canonicalCheckout: '/Users/yuji/Developer/kodama', nowMs: now,
    })).not.toThrow()
    for (const mutate of [
      (value: any) => { value.status = 'stopped' },
      (value: any) => { value.session_name = 'other' },
      (value: any) => { value.port = 8804 },
      (value: any) => { value.checkout_path = '/Users/yuji/Developer/kodama' },
      (value: any) => { value.stopped_at = new Date(now).toISOString() },
      (value: any) => { value.git_dirty = true },
      (value: any) => { value.last_seen_at = new Date(now - 30_001).toISOString() },
    ]) {
      const candidate = structuredClone(post)
      mutate(candidate.runtime_inventory.latest_instance)
      expectObservationCode(() => assertFleetRuntimePreToPostObservation(pre, candidate, {
        approvedStateRoot: '/safe/state', canonicalCheckout: '/Users/yuji/Developer/kodama', nowMs: now,
      }), 'QUEUE_OBSERVATION_POSTIMAGE_MISMATCH')
    }
  })

  test('SQLite and transaction failure are typed fail-closed with rollback', async () => {
    const calls: string[] = []
    const sqlite = { dialect: 'sqlite' } as DbAdapter
    await expect(readFleetRuntimeQueueObservationV2(sqlite)).rejects.toMatchObject({ code: 'QUEUE_OBSERVATION_DIALECT_MISMATCH' })
    const failing: DbAdapter = {
      dialect: 'postgres',
      async query(sql) { calls.push(sql); if (sql.startsWith('BEGIN')) return []; if (sql === 'ROLLBACK') return []; throw new Error('fixture') },
      async queryOne(sql) { calls.push(sql); throw new Error('fixture') },
      async execute() { return { rowCount: 0 } },
      async transaction<T>() { throw new Error('unused') },
      async close() {},
    }
    await expect(readFleetRuntimeQueueObservationV2(failing)).rejects.toThrow('fixture')
    expect(calls[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(calls.at(-1)).toBe('ROLLBACK')
    expect(calls.filter(call => call === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')).toHaveLength(1)
  })

  test('isolated PostgreSQL migration proves bootstrap, OLD+NEW, ABA, idempotency, guarded down, and epoch monotonicity', async () => {
    const client = await connect()
    try {
      const initiallyActive = await client.query(`SELECT to_regclass('fleet_runtime_queue_observation_active')::text AS active`)
      if (initiallyActive.rows[0].active !== null) await client.query(DOWN_SQL)
      await client.query(`DELETE FROM message_queue WHERE agent_id IN ('kodama', 'queue-history-agent', 'cross-agent')`)
      await client.query(`DELETE FROM agent_runtime_instances WHERE agent_id = 'kodama'`)
      await client.query(`DELETE FROM agents WHERE agent_id IN ('aun-runtime-executor', 'kodama', 'zero-history-agent', 'queue-history-agent', 'cross-agent', 'disabled-agent', 'unrelated-enabled-fixture')`)
      await client.query(`
        INSERT INTO agents (agent_id, display_name, agent_type, runtime, status, home_directory, profile_enabled, profile_revision, profile_source, disabled_at)
        VALUES
          ('aun-runtime-executor', 'AUN Runtime Executor', 'system', 'local_process', 'offline', NULL, true, 1, 'agent.register', NULL),
          ('kodama', 'Kodama', 'dev', 'TUI', 'offline', '/Users/yuji/Developer/kodama', true, 1, 'legacy', NULL),
          ('zero-history-agent', 'Zero History', 'dev', 'codex', 'offline', '/tmp/zero-history', true, 1, 'legacy', NULL),
          ('cross-agent', 'Cross Agent', 'dev', 'codex', 'offline', '/tmp/cross-agent', true, 1, 'legacy', NULL),
          ('unrelated-enabled-fixture', 'Unrelated Enabled Fixture', 'dev', 'codex', 'offline', '/tmp/unrelated-enabled-fixture', true, 1, 'legacy', NULL),
          ('disabled-agent', 'Disabled', 'dev', 'codex', 'disabled', '/tmp/disabled', false, 1, 'legacy', transaction_timestamp())
      `)
      await client.query(`INSERT INTO message_queue (agent_id, payload, status) VALUES ('queue-history-agent', '{}', 'done')`)
      const expectedBootstrap = await client.query(`
        SELECT agent_id, '0'::text AS revision
          FROM (
            SELECT agent_id
              FROM agents
             WHERE profile_enabled = true
               AND disabled_at IS NULL
               AND status <> 'disabled'
               AND agent_id IS NOT NULL
               AND agent_id <> ''
            UNION
            SELECT agent_id
              FROM message_queue
             WHERE agent_id IS NOT NULL
               AND agent_id <> ''
          ) AS expected_source
         ORDER BY agent_id
      `)
      const beforeDigest = await objectDigest(client)
      await client.query(UP_SQL)
      const activeDigest = await objectDigest(client)
      expect(activeDigest).not.toBe(beforeDigest)
      const marker = await client.query(`SELECT migration_epoch::text AS epoch FROM fleet_runtime_queue_observation_active WHERE singleton = true`)
      const firstEpoch = marker.rows[0].epoch as string
      const bootstrapped = await client.query(`
        SELECT agent_id, revision::text AS revision
          FROM fleet_runtime_queue_agent_revisions
         WHERE migration_epoch = $1::bigint ORDER BY agent_id
      `, [firstEpoch])
      expect(bootstrapped.rows).toEqual(expectedBootstrap.rows)
      expect(bootstrapped.rows).toEqual(expect.arrayContaining([
        { agent_id: 'aun-runtime-executor', revision: '0' },
        { agent_id: 'cross-agent', revision: '0' },
        { agent_id: 'kodama', revision: '0' },
        { agent_id: 'queue-history-agent', revision: '0' },
        { agent_id: 'unrelated-enabled-fixture', revision: '0' },
        { agent_id: 'zero-history-agent', revision: '0' },
      ]))
      expect(bootstrapped.rows).not.toContainEqual({ agent_id: 'disabled-agent', revision: '0' })
      expect(bootstrapped.rows.every(row => row.revision === '0')).toBe(true)
      await client.query(UP_SQL)
      const markerAgain = await client.query(`SELECT migration_epoch::text AS epoch FROM fleet_runtime_queue_observation_active WHERE singleton = true`)
      expect(markerAgain.rows[0].epoch).toBe(firstEpoch)

      const inserted = await client.query(`INSERT INTO message_queue (agent_id, payload, status) VALUES ('kodama', '{}', 'pending') RETURNING id`)
      const queueId = inserted.rows[0].id
      await client.query(`UPDATE message_queue SET agent_id = 'cross-agent' WHERE id = $1`, [queueId])
      let revisions = await client.query(`
        SELECT agent_id, revision::text AS revision FROM fleet_runtime_queue_agent_revisions
         WHERE migration_epoch = $1::bigint AND agent_id IN ('kodama', 'cross-agent') ORDER BY agent_id
      `, [firstEpoch])
      expect(revisions.rows).toEqual([{ agent_id: 'cross-agent', revision: '1' }, { agent_id: 'kodama', revision: '2' }])
      await client.query(`DELETE FROM message_queue WHERE id = $1`, [queueId])
      revisions = await client.query(`
        SELECT agent_id, revision::text AS revision FROM fleet_runtime_queue_agent_revisions
         WHERE migration_epoch = $1::bigint AND agent_id IN ('kodama', 'cross-agent') ORDER BY agent_id
      `, [firstEpoch])
      expect(revisions.rows).toEqual([{ agent_id: 'cross-agent', revision: '2' }, { agent_id: 'kodama', revision: '2' }])

      const adapter = new PgAdapter(TEST_DATABASE_URL)
      const beforeAba = await readFleetRuntimeQueueObservationV2(adapter, { expectedDatabaseName: TEST_DATABASE_NAME })
      await client.query(`INSERT INTO message_queue (agent_id, payload, status) VALUES ('kodama', '{}', 'pending') RETURNING id`).then(async result => {
        await client.query(`DELETE FROM message_queue WHERE id = $1`, [result.rows[0].id])
      })
      const afterAba = await readFleetRuntimeQueueObservationV2(adapter, { expectedDatabaseName: TEST_DATABASE_NAME })
      await adapter.close()
      expect(afterAba.queue.active_rows_sha256).toBe(beforeAba.queue.active_rows_sha256)
      expect(afterAba.queue.revision).not.toBe(beforeAba.queue.revision)
      expect(afterAba.queue.queue_observation_id).not.toBe(beforeAba.queue.queue_observation_id)
      expect(canonicalFleetRuntimeObservationJson(afterAba)).not.toContain(TEST_DATABASE_URL)

      const updateRevertRow = await client.query(`
        INSERT INTO message_queue (agent_id, payload, status) VALUES ('kodama', '{}', 'done') RETURNING id
      `)
      const updateRevertBeforeAdapter = new PgAdapter(TEST_DATABASE_URL)
      const beforeUpdateRevert = await readFleetRuntimeQueueObservationV2(updateRevertBeforeAdapter, {
        expectedDatabaseName: TEST_DATABASE_NAME,
      })
      await updateRevertBeforeAdapter.close()
      await client.query(`UPDATE message_queue SET status = 'pending' WHERE id = $1`, [updateRevertRow.rows[0].id])
      await client.query(`UPDATE message_queue SET status = 'done' WHERE id = $1`, [updateRevertRow.rows[0].id])
      const updateRevertAdapter = new PgAdapter(TEST_DATABASE_URL)
      const afterUpdateRevert = await readFleetRuntimeQueueObservationV2(updateRevertAdapter, { expectedDatabaseName: TEST_DATABASE_NAME })
      await updateRevertAdapter.close()
      expect(afterUpdateRevert.queue.active_rows_sha256).toBe(beforeUpdateRevert.queue.active_rows_sha256)
      expect(afterUpdateRevert.queue.queue_observation_id).not.toBe(beforeUpdateRevert.queue.queue_observation_id)
      await client.query(`DELETE FROM message_queue WHERE id = $1`, [updateRevertRow.rows[0].id])

      const beforeMulti = await client.query(`
        SELECT agent_id, revision FROM fleet_runtime_queue_agent_revisions
         WHERE migration_epoch = $1::bigint AND agent_id IN ('kodama', 'cross-agent') ORDER BY agent_id
      `, [firstEpoch])
      const multi = await client.query(`
        INSERT INTO message_queue (agent_id, payload, status)
        VALUES ('kodama', '{}', 'pending'), ('kodama', '{}', 'received') RETURNING id
      `)
      await client.query(`UPDATE message_queue SET agent_id = 'cross-agent' WHERE id = ANY($1::bigint[])`, [multi.rows.map(row => row.id)])
      await client.query(`DELETE FROM message_queue WHERE id = ANY($1::bigint[])`, [multi.rows.map(row => row.id)])
      const afterMulti = await client.query(`
        SELECT agent_id, revision FROM fleet_runtime_queue_agent_revisions
         WHERE migration_epoch = $1::bigint AND agent_id IN ('kodama', 'cross-agent') ORDER BY agent_id
      `, [firstEpoch])
      expect(Number(afterMulti.rows[0].revision) - Number(beforeMulti.rows[0].revision)).toBe(4)
      expect(Number(afterMulti.rows[1].revision) - Number(beforeMulti.rows[1].revision)).toBe(4)

      const denied = Bun.spawnSync({
        cmd: [process.execPath, 'db/migrate.ts', `--down=${DOWN_PATH}`],
        cwd: resolve(import.meta.dir, '../..'),
        env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: TEST_DATABASE_URL! },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(denied.exitCode).not.toBe(0)
      expect(`${denied.stdout.toString()}${denied.stderr.toString()}`).toContain('Destructive migration blocked')
      expect(await objectDigest(client)).toBe(activeDigest)

      const allowed = Bun.spawnSync({
        cmd: [process.execPath, 'db/migrate.ts', `--down=${DOWN_PATH}`],
        cwd: resolve(import.meta.dir, '../..'),
        env: {
          ...process.env,
          AGENT_COM_DB: 'postgres',
          AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED: '1',
          AGENT_COM_TEST_DATABASE_URL: TEST_DATABASE_URL!,
          DATABASE_URL: TEST_DATABASE_URL!,
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(allowed.exitCode).toBe(0)
      const downDigest = await objectDigest(client)
      expect(downDigest).toBe(beforeDigest)
      const retained = await client.query(`SELECT to_regclass('fleet_runtime_queue_observation_epoch_seq')::text AS sequence`)
      expect(retained.rows[0].sequence).toBe('fleet_runtime_queue_observation_epoch_seq')
      const reapply = Bun.spawnSync({
        cmd: [process.execPath, 'db/migrate.ts', `--up=${UP_PATH}`],
        cwd: resolve(import.meta.dir, '../..'),
        env: { ...process.env, AGENT_COM_DB: 'postgres', DATABASE_URL: TEST_DATABASE_URL! },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(reapply.exitCode).toBe(0)
      const reup = await client.query(`SELECT migration_epoch::text AS epoch FROM fleet_runtime_queue_observation_active WHERE singleton = true`)
      expect(BigInt(reup.rows[0].epoch)).toBeGreaterThan(BigInt(firstEpoch))
    } finally {
      await client.end()
    }
  }, 30_000)
})
