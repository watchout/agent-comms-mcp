import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import {
  KODAMA_CANARY_SUSPENSION_AGENT_ID,
  SEAT_DISPOSITION_CONTROL_SOURCE_SHA256,
  SD_C8_REGISTRY_RETIREMENT_AGENT_IDS,
  transitionKodamaCanaryDelivery,
  transitionSdC8RegistryCohort,
} from '../../core/registry-retirement'

let db: Client

function explicitScratchDatabaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim() ?? ''
  if (!value) throw new Error('registry retirement contract requires explicit DATABASE_URL')
  const parsed = new URL(value)
  const database = parsed.pathname.replace(/^\//, '')
  if (!database || database === 'agent_comms') {
    throw new Error('registry retirement contract refuses the production agent_comms database')
  }
  return value
}

async function clean(): Promise<void> {
  await db.query(
    `DELETE FROM audit_log
      WHERE agent_id = $1
        AND event_type IN ('registry.identity.delivery_suspended', 'registry.identity.delivery_reinstated')`,
    [KODAMA_CANARY_SUSPENSION_AGENT_ID],
  )
  await db.query(
    `DELETE FROM audit_log
      WHERE agent_id = ANY($1::text[])
        AND event_type IN ('registry.identity.retired', 'registry.identity.reinstated')`,
    [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
  )
  await db.query(`DELETE FROM message_queue WHERE agent_id = $1`, [KODAMA_CANARY_SUSPENSION_AGENT_ID])
  await db.query(`DELETE FROM agent_runtime_instances WHERE agent_id = $1`, [KODAMA_CANARY_SUSPENSION_AGENT_ID])
  await db.query(`DELETE FROM agents WHERE agent_id = $1`, [KODAMA_CANARY_SUSPENSION_AGENT_ID])
  await db.query(`DELETE FROM message_queue WHERE agent_id = ANY($1::text[])`, [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]])
  await db.query(`DELETE FROM agents WHERE agent_id = ANY($1::text[])`, [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]])
}

beforeAll(async () => {
  db = new Client({ connectionString: explicitScratchDatabaseUrl() })
  await db.connect()
  await clean()
  const oldDisabledAt = '2026-05-27T01:36:24.050Z'
  for (const agentId of SD_C8_REGISTRY_RETIREMENT_AGENT_IDS) {
    const previouslyDisabled = agentId === 'auditor' || agentId === 'codex-aun'
    const sqlNullMetadata = agentId === 'auditor'
    await db.query(
      `INSERT INTO agents
         (agent_id, display_name, agent_type, runtime, status, profile_enabled,
          disabled_at, status_updated_at, metadata)
       VALUES ($1, $1, $2, $3, 'idle', $4, $5, $6, $7::jsonb)`,
      [
        agentId,
        agentId === 'ceo' ? 'human' : 'dev',
        agentId.includes('test') || agentId.startsWith('lead-override-') ? 'mcp' : 'TUI',
        !previouslyDisabled,
        previouslyDisabled ? oldDisabledAt : null,
        '2026-08-20T00:00:00.000Z',
        sqlNullMetadata ? null : JSON.stringify({ fixture: agentId, nested: { preserved: true } }),
      ],
    )
  }
  await db.query(
    `INSERT INTO agents
       (agent_id, display_name, agent_type, runtime, status, profile_enabled,
        disabled_at, status_updated_at, metadata)
     VALUES ($1, $1, 'dev', 'TUI', 'busy', true, NULL, $2, $3::jsonb)`,
    [
      KODAMA_CANARY_SUSPENSION_AGENT_ID,
      '2026-08-25T00:00:00.000Z',
      JSON.stringify({ canary: 'n40', nested: { preserved: true } }),
    ],
  )
  await db.query(
    `INSERT INTO message_queue (agent_id, message_id, payload, status)
     VALUES ($1, $2, $3::jsonb, 'pending')`,
    [KODAMA_CANARY_SUSPENSION_AGENT_ID, 'sd-c8-kodama-sentinel', JSON.stringify({ kind: 'sentinel' })],
  )
})

afterAll(async () => {
  if (!db) return
  await clean()
  await db.end()
})

describe('SD-C8 exact registry retirement transition', () => {
  test('retire then reinstate restores the exact active preimage and records both audits', async () => {
    const retiredAt = new Date('2026-08-22T13:15:00.000Z')
    const retired = await transitionSdC8RegistryCohort(db as any, {
      action: 'retire',
      execute: true,
      now: retiredAt,
    })
    expect(retired.transitioned).toBe(12)
    expect(retired.control_source_ref.sha256).toBe('fc6e120540c34cac9ea760265d9d34cfd36ccc32ae1acac6b5d93d56bd15032b')
    expect(retired.readback.every(row => row.status === 'retired' && !row.profile_enabled && row.retired)).toBe(true)

    const stored = await db.query<{
      agent_id: string
      status: string
      profile_enabled: boolean
      disabled_at: Date | null
      metadata: Record<string, any>
    }>(
      `SELECT agent_id, status, profile_enabled, disabled_at, metadata
         FROM agents
        WHERE agent_id = ANY($1::text[])
        ORDER BY agent_id`,
      [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
    )
    expect(stored.rows).toHaveLength(12)
    expect(stored.rows.every(row => row.metadata.registry_retirement.cell_id === 'CH-ARC-940-SD-C8-REGISTRY-HYGIENE-20260822-001')).toBe(true)
    for (const row of stored.rows) {
      const preimage = row.metadata.registry_retirement.preimage
      if (row.agent_id === 'auditor') {
        expect(preimage.metadata).toBeNull()
        expect(preimage.metadata_is_sql_null).toBe(true)
      } else {
        expect(preimage.metadata.fixture).toBe(row.agent_id)
        expect(preimage.metadata_is_sql_null).toBe(false)
      }
    }

    const reinstated = await transitionSdC8RegistryCohort(db as any, {
      action: 'reinstate',
      execute: true,
      now: new Date('2026-08-22T13:20:00.000Z'),
    })
    expect(reinstated.transitioned).toBe(12)
    expect(reinstated.readback.every(row => row.status === 'idle' && !row.retired)).toBe(true)

    const restored = await db.query<{
      agent_id: string
      profile_enabled: boolean
      disabled_at: Date | null
      metadata: Record<string, any>
    }>(
      `SELECT agent_id, profile_enabled, disabled_at, metadata
         FROM agents
        WHERE agent_id = ANY($1::text[])
        ORDER BY agent_id`,
      [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
    )
    for (const row of restored.rows) {
      const previouslyDisabled = row.agent_id === 'auditor' || row.agent_id === 'codex-aun'
      expect(row.profile_enabled).toBe(!previouslyDisabled)
      expect(row.disabled_at === null).toBe(!previouslyDisabled)
      if (row.agent_id === 'auditor') expect(row.metadata).toBeNull()
      else expect(row.metadata).toEqual({ fixture: row.agent_id, nested: { preserved: true } })
    }

    const audit = await db.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count
         FROM audit_log
        WHERE agent_id = ANY($1::text[])
          AND event_type IN ('registry.identity.retired', 'registry.identity.reinstated')
        GROUP BY event_type
        ORDER BY event_type`,
      [[...SD_C8_REGISTRY_RETIREMENT_AGENT_IDS]],
    )
    expect(audit.rows).toEqual([
      { event_type: 'registry.identity.reinstated', count: '12' },
      { event_type: 'registry.identity.retired', count: '12' },
    ])
  })

  test('kodama canary suspension is reversible, claim-safe, and queue-neutral', async () => {
    const dryRun = await transitionKodamaCanaryDelivery(db as any, {
      action: 'suspend',
      execute: false,
      now: new Date('2026-08-25T01:00:00.000Z'),
    })
    expect(dryRun).toMatchObject({
      action: 'suspend',
      execute: false,
      transitioned: false,
      readback: { status: 'busy', profile_enabled: true, disabled_at: null, suspended: false },
    })

    await db.query(
      `UPDATE message_queue
          SET status = 'received'
        WHERE agent_id = $1 AND message_id = 'sd-c8-kodama-sentinel'`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )
    await expect(transitionKodamaCanaryDelivery(db as any, {
      action: 'suspend',
      execute: true,
      now: new Date('2026-08-25T01:01:00.000Z'),
    })).rejects.toThrow('KODAMA_CANARY_SUSPENSION_ACTIVE_CLAIM')
    await db.query(
      `UPDATE message_queue
          SET status = 'pending'
        WHERE agent_id = $1 AND message_id = 'sd-c8-kodama-sentinel'`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )

    const suspended = await transitionKodamaCanaryDelivery(db as any, {
      action: 'suspend',
      execute: true,
      now: new Date('2026-08-25T01:02:00.000Z'),
    })
    expect(suspended.control_source_ref.sha256).toBe(SEAT_DISPOSITION_CONTROL_SOURCE_SHA256)
    expect(suspended).toMatchObject({
      action: 'suspend',
      execute: true,
      transitioned: true,
      readback: { status: 'offline', profile_enabled: true, disabled_at: null, suspended: true },
    })
    const storedSuspension = await db.query<{ status: string; profile_enabled: boolean; disabled_at: Date | null; metadata: any }>(
      `SELECT status, profile_enabled, disabled_at, metadata FROM agents WHERE agent_id = $1`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )
    expect(storedSuspension.rows[0].metadata.registry_canary_delivery_suspension.preimage).toMatchObject({
      status: 'busy',
      profile_enabled: true,
      disabled_at: null,
      metadata: { canary: 'n40', nested: { preserved: true } },
      metadata_is_sql_null: false,
    })

    await expect(transitionKodamaCanaryDelivery(db as any, {
      action: 'reinstate',
      execute: true,
      now: new Date('2026-08-25T01:03:00.000Z'),
      canaryReceipt: {
        url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5402944050',
        sha256: 'not-a-digest',
      },
    })).rejects.toThrow('KODAMA_CANARY_RECEIPT_SHA256_INVALID')

    const reinstated = await transitionKodamaCanaryDelivery(db as any, {
      action: 'reinstate',
      execute: true,
      now: new Date('2026-08-25T01:04:00.000Z'),
      canaryReceipt: {
        url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5402944050',
        sha256: SEAT_DISPOSITION_CONTROL_SOURCE_SHA256,
      },
    })
    expect(reinstated).toMatchObject({
      action: 'reinstate',
      execute: true,
      transitioned: true,
      readback: { status: 'busy', profile_enabled: true, disabled_at: null, suspended: false },
    })

    const restored = await db.query<{ status: string; profile_enabled: boolean; disabled_at: Date | null; metadata: any }>(
      `SELECT status, profile_enabled, disabled_at, metadata FROM agents WHERE agent_id = $1`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )
    expect(restored.rows[0]).toMatchObject({
      status: 'busy',
      profile_enabled: true,
      disabled_at: null,
      metadata: { canary: 'n40', nested: { preserved: true } },
    })
    const queue = await db.query<{ status: string }>(
      `SELECT status FROM message_queue WHERE agent_id = $1 AND message_id = 'sd-c8-kodama-sentinel'`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )
    expect(queue.rows).toEqual([{ status: 'pending' }])
    const audit = await db.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count
         FROM audit_log
        WHERE agent_id = $1
          AND event_type IN ('registry.identity.delivery_suspended', 'registry.identity.delivery_reinstated')
        GROUP BY event_type
        ORDER BY event_type`,
      [KODAMA_CANARY_SUSPENSION_AGENT_ID],
    )
    expect(audit.rows).toEqual([
      { event_type: 'registry.identity.delivery_reinstated', count: '1' },
      { event_type: 'registry.identity.delivery_suspended', count: '1' },
    ])
  })
})
