import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PgAdapter } from '../../core/db/pg-adapter'
import { AunConfigurationReconciler, type ConfigurationProjectionPort } from '../../core/aun-configuration-reconciler'
import { markConfigurationEventDelivered, supersedeConfigurationEvents } from '../../core/aun-configuration-desired-state'
import { configurationContractFixture, contractRef } from '../helpers/configuration-contract-fixture'
import { insert, repo } from '../helpers/runtime-observation-nonpersistence-db-fixture'

// Real PG schema, trigger, store, leases and reconciler. Only projection readback
// is a matching fixture: these tests prove outbox progress, not OS application.
function matchingProjection(): ConfigurationProjectionPort {
  return {
    async render({ desired }) {
      return {
        agentId: desired.agentId, desiredRevision: desired.desiredRevision,
        desiredDigest: desired.desiredDigest, candidateDigest: 'c'.repeat(64),
        releaseCommit: desired.releaseCommit, releaseTree: desired.releaseTree,
        restartRequired: false,
      } as any
    },
    async validate() { return { ok: true, reasonCodes: [] } },
    async readback() { return {
      matchesCandidate: true, providerNativeDigest: 'd'.repeat(64),
      launchagentPlistDigest: 'e'.repeat(64), launchctlEnvironmentDigest: 'f'.repeat(64),
      runtimeIdentityDigest: 'a'.repeat(64), driftReasonCodes: [],
    } },
    async applyFenced() { throw new Error('MATCHING_PROJECTION_MUST_NOT_APPLY') },
    async rollbackFenced() { throw new Error('MATCHING_PROJECTION_MUST_NOT_ROLLBACK') },
  }
}
async function advance(s: Awaited<ReturnType<typeof configurationContractFixture>>, count: number) {
  for (let i = 0; i < count; i++) {
    await s.f.query('UPDATE agents SET profile_enabled=NOT profile_enabled WHERE agent_id=$1', [s.desired.agentId])
  }
  return (await s.store.readDesired(s.desired.agentId))!
}
function authority(desired: any, lease: any) {
  return {
    agentId: desired.agentId, desiredRevision: desired.desiredRevision, desiredDigest: desired.desiredDigest,
    leaseId: lease.lease_id, fencingToken: lease.fencing_token,
    holderAgentId: lease.holder_agent_id, holderRuntimeInstanceId: lease.holder_runtime_instance_id,
  }
}

for (const revisions of [3, 101]) {
  test(`F-CFG-OUTBOX-01: ${revisions} normal revisions cannot starve current delivery or another due agent`, async () => {
    const s = await configurationContractFixture()
    try {
      const reconciler = new AunConfigurationReconciler(s.store, s.leases, matchingProjection())
      const initial = (await s.store.listPendingEvents(100))[0]
      expect((await reconciler.reconcileAgent(s.desired.agentId, initial)).eventDelivered).toBe(true)
      const initialRow = (await s.f.query('SELECT * FROM aun_configuration_desired_outbox WHERE event_id=$1', [initial.eventId]))[0]
      await insert(s.f, 'agents', {
        agent_id: 'other-due', display_name: 'other due', agent_type: 'bot', profile_enabled: true,
        desired_release_commit: 'a'.repeat(40), desired_release_tree: 'b'.repeat(40),
        desired_control_refs: JSON.stringify([contractRef]), ordinary_communication_enrollment: true,
      })
      const otherEvent = (await s.store.listPendingEvents(100)).find(e => e.agentId === 'other-due')!
      expect((await reconciler.reconcileAgent('other-due', otherEvent)).eventDelivered).toBe(true)
      await s.f.query("UPDATE audit_log SET created_at=clock_timestamp()-interval '31 seconds' WHERE agent_id='other-due' AND event_type='configuration.reconciled'")

      const current = await advance(s, revisions)
      const beforePending = (await s.f.query('SELECT event_id FROM aun_configuration_desired_outbox WHERE agent_id=$1 AND delivered_at IS NULL AND superseded_at IS NULL', [current.agentId])).length
      expect(beforePending).toBe(revisions)
      expect(current.desiredRevision).toBe(initial.desiredRevision + revisions)
      const pending = await s.store.listPendingEvents(100)
      expect(pending).toHaveLength(1)
      expect(pending[0].desiredRevision).toBe(current.desiredRevision)
      const rounds = await reconciler.sweepOnce()
      expect(rounds.find(r => r.agentId === s.desired.agentId)).toMatchObject({
        status: 'READY', desiredRevision: current.desiredRevision,
        eventDelivered: true, supersededEventCount: revisions - 1, applyCount: 0,
      })
      expect(rounds.find(r => r.agentId === 'other-due')).toMatchObject({ status: 'READY', applyCount: 0 })
      expect((await s.f.query("SELECT id FROM audit_log WHERE agent_id='other-due' AND event_type='configuration.reconciled'"))).toHaveLength(2)
      const rows = await s.f.query('SELECT * FROM aun_configuration_desired_outbox WHERE agent_id=$1 ORDER BY desired_revision', [s.desired.agentId])
      const retired = rows.filter(r => r.superseded_at !== null)
      expect(retired).toHaveLength(revisions - 1)
      expect(retired.every(r => r.delivered_at === null && r.attempt_count === 0
        && Number(r.superseded_by_revision) === current.desiredRevision
        && r.superseded_by_digest === current.desiredDigest)).toBe(true)
      expect(retired.some(r => r.desired_digest === current.desiredDigest)).toBe(true)
      expect(rows.at(-1).delivered_at).not.toBeNull()
      expect(rows.at(-1).superseded_at).toBeNull()
      expect(rows[0]).toEqual(initialRow)
      expect(await s.store.listPendingEvents(100)).toEqual([])
      expect(await reconciler.sweepOnce()).toEqual([])
      console.log(JSON.stringify({ case: 'F-CFG-OUTBOX-01', revisions, beforePending, currentRevision: current.desiredRevision,
        superseded: retired.length, currentDelivered: 1, falseOldDeliveries: 0, otherDueProgress: 1,
        remainingPending: 0, applyCount: 0, projection: 'matching-fixture' }))
    } finally { await s.close() }
  }, 30000)
}

test('supersession preserves current desired, holder, runtime, scope, fence and expiry refusals', async () => {
  const s = await configurationContractFixture()
  try {
    const current = await advance(s, 2), lease = (await s.leases.acquire(current.agentId))!
    const good = authority(current, lease)
    const before = await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')
    for (const patch of [
      { desiredRevision: current.desiredRevision - 1 }, { desiredDigest: '0'.repeat(64) },
      { holderAgentId: 'foreign-holder' }, { holderRuntimeInstanceId: randomUUID() },
      { fencingToken: lease.fencing_token + 1 }, { leaseId: randomUUID() }, { agentId: 'foreign-agent' },
    ]) expect(await supersedeConfigurationEvents(s.db, { ...good, ...patch })).toBe(0)
    await s.f.query("UPDATE control_plane_leases SET lease_scope_id='configuration-reconciler:foreign' WHERE lease_id=$1", [lease.lease_id])
    expect(await supersedeConfigurationEvents(s.db, good)).toBe(0)
    await s.f.query("UPDATE control_plane_leases SET lease_scope_id=$2,expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=$1", [lease.lease_id, lease.lease_scope_id])
    expect(await supersedeConfigurationEvents(s.db, good)).toBe(0)
    expect(await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')).toEqual(before)
    const fresh = (await s.leases.acquire(current.agentId))!
    expect(await supersedeConfigurationEvents(s.db, authority(current, fresh))).toBe(2)
    expect(await supersedeConfigurationEvents(s.db, good)).toBe(0)
    expect(await markConfigurationEventDelivered(s.db, before[0].event_id, Number(before[0].desired_revision), before[0].desired_digest, authority(current, fresh))).toBe(false)
    const rows = await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')
    expect(rows.at(-1).superseded_at).toBeNull()
    expect(rows.at(-1).delivered_at).toBeNull()
  } finally { await s.close() }
}, 30000)

test('outbox lock wait beyond lease expiry supersedes zero rows', async () => {
  const s = await configurationContractFixture()
  try {
    const current = await advance(s, 2), lease = (await s.leases.acquire(current.agentId))!
    await s.f.query("UPDATE control_plane_leases SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE lease_id=$1", [lease.lease_id])
    await s.f.exec('BEGIN')
    await s.f.query('SELECT event_id FROM aun_configuration_desired_outbox WHERE desired_revision<$1 FOR UPDATE', [current.desiredRevision])
    const pending = supersedeConfigurationEvents(s.db, authority(current, lease))
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    const deadline = Date.now() + 2000
    let waits = 0
    while (Date.now() < deadline) {
      waits = (await s.f.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'WITH authority AS MATERIALIZED%' ")).length
      if (waits) break
      await Bun.sleep(10)
    }
    expect(waits).toBe(1)
    await Bun.sleep(500)
    expect(settled).toBe(false)
    await s.f.exec('COMMIT')
    expect(await pending).toBe(0)
    expect((await s.f.query('SELECT event_id FROM aun_configuration_desired_outbox WHERE superseded_at IS NOT NULL'))).toEqual([])
  } finally { await s.f.exec('ROLLBACK'); await s.close() }
}, 30000)

test('bounded retirement is idempotent under concurrent callers and migration preserves terminal history', async () => {
  const s = await configurationContractFixture(), second = new PgAdapter(s.url.href)
  const up = readFileSync(join(repo, 'db/migrations/2026-09-22-configuration-outbox-supersession.up.sql'), 'utf8')
  const down = readFileSync(join(repo, 'db/migrations/2026-09-22-configuration-outbox-supersession.down.sql'), 'utf8')
  try {
    const current = await advance(s, 4), lease = (await s.leases.acquire(current.agentId))!
    const grant = authority(current, lease)
    await s.f.exec(down); await s.f.exec(up); await s.f.exec(up)
    await expect(supersedeConfigurationEvents(s.db, grant, 101)).rejects.toThrow('OUTBOX_LIMIT_INVALID')
    expect(await supersedeConfigurationEvents(s.db, grant, 1)).toBe(1)
    const counts = await Promise.all([supersedeConfigurationEvents(s.db, grant), supersedeConfigurationEvents(second, grant)])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3)
    expect(await supersedeConfigurationEvents(s.db, grant)).toBe(0)
    const rows = await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')
    expect(rows.filter(r => r.superseded_at !== null)).toHaveLength(4)
    expect(rows.every(r => r.delivered_at === null && r.attempt_count === 0)).toBe(true)
    await s.f.exec(up)
    expect(await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')).toEqual(rows)
    await expect(s.f.exec(down)).rejects.toThrow('CONFIGURATION_SUPERSESSION_HISTORY_MUST_BE_PRESERVED')
    await s.f.exec('ROLLBACK')
    expect(await s.f.query('SELECT * FROM aun_configuration_desired_outbox ORDER BY desired_revision')).toEqual(rows)
  } finally { await second.close(); await s.close() }
}, 30000)
