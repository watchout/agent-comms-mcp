// CELL-4MCP-AUN-001 lane fixtures (frozen in agent-comms-mcp#853 /
// SPEC-4MCP-002 v0.2 Required Fixtures):
//   standalone create/read without peers; replay idempotency; negative =
//   AUN cannot write Shirube active_function; non-authority first-upsert
//   rejected — plus the SuiteEvent envelope, monotonic row_version, single
//   event path, and log-rebuild equivalence.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  ensureSchema,
  getRoutingProfile,
  listRoutingProfiles,
  registerAgentRoutingProfile,
  updateAgentRoutingProfile,
  deactivateAgentRoutingProfile,
  retireAgentRoutingProfile,
  suiteEventsFor,
  rebuildRoutingProfilesFromLog,
  subjectStream,
  NotMintedError,
  RegisterConflictError,
  RetiredAgentError,
  ROUTING_PROFILE_COLUMNS,
  SUITE_CONTRACT_VERSION,
} from '../../core/routing-profiles'

const ANCHOR = 'https://github.com/watchout/agent-comms-mcp/issues/853'

let dir: string
let db: SqliteAdapter

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'routing-profiles-'))
  db = new SqliteAdapter(join(dir, 'aun.db'))
  await ensureSchema(db)
})

afterEach(async () => {
  await db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('standalone (zero peer MCPs)', () => {
  test('create/read works against a fresh DB with no peer tables', async () => {
    const minted = await registerAgentRoutingProfile(db, {
      agentId: 'kodama',
      deliveryTargets: [{ kind: 'discord_channel', id: '123' }],
      channelBindings: [{ channel_id: '123', role: 'primary' }],
      queueVisibility: 'default',
      sourceRef: ANCHOR,
    })
    expect(minted.minted).toBe(true)
    const row = await getRoutingProfile(db, 'kodama')
    expect(row?.routing_status).toBe('active')
    expect(JSON.parse(row!.delivery_targets_json)).toEqual([{ kind: 'discord_channel', id: '123' }])
    expect((await listRoutingProfiles(db)).length).toBe(1)
  })

  test('table has EXACTLY the Contract B columns — forbidden peer-domain columns cannot exist', async () => {
    const cols = await db.query<{ name: string }>(
      `SELECT name FROM pragma_table_info('aun_agent_routing_profiles') ORDER BY cid`,
    )
    expect(cols.map(c => c.name)).toEqual([...ROUTING_PROFILE_COLUMNS])
    for (const forbidden of ['active_function', 'authority_scope', 'memory_partition', 'index_policy']) {
      expect(cols.map(c => c.name)).not.toContain(forbidden)
    }
  })
})

describe('minting authority (Contract C v0.2)', () => {
  test('non-authority first-upsert is rejected: no row, no event', async () => {
    expect(
      updateAgentRoutingProfile(db, { agentId: 'ghost', sourceRef: ANCHOR }),
    ).rejects.toThrow(NotMintedError)
    expect(await getRoutingProfile(db, 'ghost')).toBeNull()
    expect((await suiteEventsFor(db, 'ghost')).length).toBe(0)
  })

  test('re-register with a different profile is a conflict, not a silent overwrite', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    expect(
      registerAgentRoutingProfile(db, {
        agentId: 'kodama',
        deliveryTargets: [{ kind: 'discord_channel', id: 'other' }],
        sourceRef: ANCHOR,
      }),
    ).rejects.toThrow(RegisterConflictError)
  })
})

describe('replay idempotency', () => {
  test('identical registration retried → one row, one event', async () => {
    const a = await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    const b = await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    expect(a.minted).toBe(true)
    expect(b.minted).toBe(false)
    const events = await suiteEventsFor(db, 'kodama')
    expect(events.length).toBe(1)
    expect(events[0].event_type).toBe('suite.identity.agent_upserted')
  })

  test('identical update retried → one change event, no duplicate semantic effect', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    const first = await updateAgentRoutingProfile(db, {
      agentId: 'kodama',
      deliveryTargets: [{ kind: 'discord_channel', id: '999' }],
      sourceRef: `${ANCHOR}#change-1`,
    })
    const retry = await updateAgentRoutingProfile(db, {
      agentId: 'kodama',
      deliveryTargets: [{ kind: 'discord_channel', id: '999' }],
      sourceRef: `${ANCHOR}#change-1`,
    })
    expect(first.changed).toBe(true)
    expect(retry.changed).toBe(false)
    const events = await suiteEventsFor(db, 'kodama')
    expect(events.map(e => e.event_type)).toEqual([
      'suite.identity.agent_upserted',
      'suite.mcp_profile.aun_routing_changed',
    ])
  })
})

describe('SuiteEvent/v1 envelope + single event path', () => {
  test('every produced event carries all contract-required fields', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR, seatId: 'aun' })
    await updateAgentRoutingProfile(db, {
      agentId: 'kodama', queueVisibility: 'restricted', sourceRef: `${ANCHOR}#c1`,
    })
    const events = await suiteEventsFor(db, 'kodama')
    expect(events.length).toBe(2)
    for (const event of events) {
      // envelope columns
      expect(event.event_id).toMatch(/^suite:aun:kodama:v\d+$/)
      expect(event.correlation_id).toBe(subjectStream('kodama'))
      expect(event.occurred_at).toBeTruthy()
      // contract fields in payload
      const payload = JSON.parse(event.payload)
      expect(payload.producer_mcp).toBe('aun')
      expect(payload.contract_version).toBe(SUITE_CONTRACT_VERSION)
      expect(payload.subject.agent_id).toBe('kodama')
      expect(payload.source_ref).toBeTruthy()
      expect(payload.payload_schema).toBe('aun_routing_profile/v1')
      expect(payload.payload_hash).toMatch(/^[a-f0-9]{64}$/)
      expect(typeof payload.row_version).toBe('number')
    }
    // monotonic row_version + causation chain
    const versions = events.map(e => JSON.parse(e.payload).row_version)
    expect(versions).toEqual([1, 2])
    expect(events[1].causation_id).toBe(events[0].event_id)
    expect(events[0].causation_id).toBeNull()
  })

  test('events exist ONLY in event_log (no second event path)', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    // the only tables in this DB are the profile table + event_log machinery:
    // a second event path would need somewhere to live
    const tables = await db.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    expect(tables.map(t => t.name).sort()).toEqual(['aun_agent_routing_profiles', 'event_log'])
    const inLog = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'suite.identity.agent_upserted'`,
    )
    expect(inLog?.n).toBe(1)
  })
})

describe('lifecycle events', () => {
  test('deactivate/retire emit identity events; retired is terminal', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'old-bot', sourceRef: ANCHOR })
    const off = await deactivateAgentRoutingProfile(db, { agentId: 'old-bot', sourceRef: `${ANCHOR}#off` })
    expect(off.changed).toBe(true)
    expect(off.profile!.routing_status).toBe('disabled')
    await retireAgentRoutingProfile(db, { agentId: 'old-bot', sourceRef: `${ANCHOR}#retire` })
    expect((await getRoutingProfile(db, 'old-bot'))!.routing_status).toBe('retired')
    expect(
      updateAgentRoutingProfile(db, { agentId: 'old-bot', queueVisibility: 'x', sourceRef: ANCHOR }),
    ).rejects.toThrow(RetiredAgentError)
    const types = (await suiteEventsFor(db, 'old-bot')).map(e => e.event_type)
    expect(types).toEqual([
      'suite.identity.agent_upserted',
      'suite.identity.agent_deactivated',
      'suite.identity.agent_retired',
    ])
  })
})

describe('storage-layer guards', () => {
  test('agent_id is immutable (rename blocked by trigger)', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    expect(
      db.execute(`UPDATE aun_agent_routing_profiles SET agent_id = 'renamed' WHERE agent_id = 'kodama'`),
    ).rejects.toThrow(/immutable/)
  })

  test('AUN cannot write Shirube active_function — the column does not exist', async () => {
    await registerAgentRoutingProfile(db, { agentId: 'kodama', sourceRef: ANCHOR })
    expect(
      db.execute(`UPDATE aun_agent_routing_profiles SET active_function = 'arc' WHERE agent_id = 'kodama'`),
    ).rejects.toThrow(/no such column/)
  })
})

describe('rebuild from log (EventLogCore discipline)', () => {
  test('replaying the suite events into a fresh DB reproduces the table', async () => {
    await registerAgentRoutingProfile(db, {
      agentId: 'kodama', deliveryTargets: [{ id: '1' }], sourceRef: ANCHOR,
    })
    await updateAgentRoutingProfile(db, {
      agentId: 'kodama', deliveryTargets: [{ id: '2' }], sourceRef: `${ANCHOR}#c1`,
    })
    await registerAgentRoutingProfile(db, { agentId: 'lead', sourceRef: ANCHOR })
    await deactivateAgentRoutingProfile(db, { agentId: 'lead', sourceRef: `${ANCHOR}#off` })

    const rebuilt = new SqliteAdapter(join(dir, 'rebuilt.db'))
    await ensureSchema(rebuilt)
    for (const e of await db.query('SELECT * FROM event_log ORDER BY seq ASC')) {
      await rebuilt.execute(
        `INSERT INTO event_log (seq, event_id, event_type, occurred_at, seat_id,
           seat_instance_id, conversation_id, causation_id, correlation_id,
           turn_id, reply_id, claim_epoch, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [e.seq, e.event_id, e.event_type, e.occurred_at, e.seat_id,
         e.seat_instance_id, e.conversation_id, e.causation_id, e.correlation_id,
         e.turn_id, e.reply_id, e.claim_epoch, e.payload],
      )
    }
    const rebuiltCount = await rebuildRoutingProfilesFromLog(rebuilt)
    expect(rebuiltCount).toBe(2)
    // updated_at is written by two separate clock reads (row write vs event
    // append) and may differ at millisecond granularity — semantic state is
    // everything else
    const semantic = (rows: Awaited<ReturnType<typeof listRoutingProfiles>>) =>
      rows.map(({ updated_at, ...rest }) => rest)
    expect(semantic(await listRoutingProfiles(rebuilt))).toEqual(semantic(await listRoutingProfiles(db)))
    await rebuilt.close()
  })
})
