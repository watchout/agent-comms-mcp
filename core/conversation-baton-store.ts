import type { DbAdapter } from './db/adapter'

export const ACTIVE_BATON_STATES = ['pending', 'active', 'escalated'] as const
export type ActiveBatonState = (typeof ACTIVE_BATON_STATES)[number]

export type BatonTerminalState = 'transferred' | 'closed' | 'failed' | 'quarantined'
export type BatonState = ActiveBatonState | BatonTerminalState

export type BatonStoreError =
  | 'ACTIVE_BATON_EXISTS'
  | 'ACTIVE_BATON_NOT_FOUND'
  | 'BATON_INSERT_FAILED'
  | 'BATON_TRANSFER_FAILED'

export interface ConversationBaton {
  baton_id: string
  conversation_id: string
  owner_agent_id: string
  state: BatonState
  source_queue_id: string | null
  lease_id: string | null
  claim_id: string | null
  completion_outcome: string | null
}

export interface BatonStoreOk {
  ok: true
  baton: ConversationBaton
}

export interface BatonTransferOk {
  ok: true
  previous_baton_id: string
  baton: ConversationBaton
}

export interface BatonStoreErr {
  ok: false
  error: BatonStoreError
  detail?: string
}

export type BatonStoreResult = BatonStoreOk | BatonStoreErr
export type BatonTransferResult = BatonTransferOk | BatonStoreErr

const ACTIVE_STATE_SQL = `'pending', 'active', 'escalated'`

function err(error: BatonStoreError, detail?: string): BatonStoreErr {
  return detail ? { ok: false, error, detail } : { ok: false, error }
}

function mapBaton(row: any): ConversationBaton {
  return {
    baton_id: String(row.baton_id),
    conversation_id: String(row.conversation_id),
    owner_agent_id: String(row.owner_agent_id),
    state: String(row.state) as BatonState,
    source_queue_id: row.source_queue_id == null ? null : String(row.source_queue_id),
    lease_id: row.lease_id == null ? null : String(row.lease_id),
    claim_id: row.claim_id == null ? null : String(row.claim_id),
    completion_outcome: row.completion_outcome == null ? null : String(row.completion_outcome),
  }
}

const BATON_SELECT = `
  SELECT
    baton_id::text AS baton_id,
    conversation_id::text AS conversation_id,
    owner_agent_id,
    state,
    source_queue_id::text AS source_queue_id,
    lease_id::text AS lease_id,
    claim_id,
    completion_outcome
  FROM conversation_batons
`

export async function findActiveConversationBaton(
  db: DbAdapter,
  conversationId: string,
): Promise<ConversationBaton | null> {
  const row = await db.queryOne(`
    ${BATON_SELECT}
    WHERE conversation_id = $1
      AND state IN (${ACTIVE_STATE_SQL})
    ORDER BY created_at ASC
    LIMIT 1
  `, [conversationId])
  return row ? mapBaton(row) : null
}

async function insertBaton(
  db: DbAdapter,
  input: {
    conversation_id: string
    owner_agent_id: string
    state?: ActiveBatonState
    source_queue_id?: number | string | null
    lease_id?: string | null
    claim_id?: string | null
  },
): Promise<ConversationBaton | null> {
  const row = await db.queryOne(`
    INSERT INTO conversation_batons (
      conversation_id,
      owner_agent_id,
      state,
      source_queue_id,
      lease_id,
      claim_id,
      started_at
    ) VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      NOW()
    )
    RETURNING
      baton_id::text AS baton_id,
      conversation_id::text AS conversation_id,
      owner_agent_id,
      state,
      source_queue_id::text AS source_queue_id,
      lease_id::text AS lease_id,
      claim_id,
      completion_outcome
  `, [
    input.conversation_id,
    input.owner_agent_id,
    input.state ?? 'active',
    input.source_queue_id ?? null,
    input.lease_id ?? null,
    input.claim_id ?? null,
  ])
  return row ? mapBaton(row) : null
}

export async function createConversationBaton(
  db: DbAdapter,
  input: {
    conversation_id: string
    owner_agent_id: string
    state?: ActiveBatonState
    source_queue_id?: number | string | null
    lease_id?: string | null
    claim_id?: string | null
  },
): Promise<BatonStoreResult> {
  return db.transaction(async (tx) => {
    const existing = await findActiveConversationBaton(tx, input.conversation_id)
    if (existing) return err('ACTIVE_BATON_EXISTS', existing.baton_id)
    const baton = await insertBaton(tx, input)
    return baton ? { ok: true, baton } : err('BATON_INSERT_FAILED', input.conversation_id)
  })
}

export async function transferConversationBaton(
  db: DbAdapter,
  input: {
    conversation_id: string
    from_baton_id: string
    to_owner_agent_id: string
    source_queue_id?: number | string | null
    lease_id?: string | null
    claim_id?: string | null
    completion_outcome?: string | null
  },
): Promise<BatonTransferResult> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(`
      UPDATE conversation_batons
         SET state = 'transferred',
             completed_at = NOW(),
             completion_outcome = $3,
             updated_at = NOW()
       WHERE baton_id = $1
         AND conversation_id = $2
         AND state IN (${ACTIVE_STATE_SQL})
    `, [
      input.from_baton_id,
      input.conversation_id,
      input.completion_outcome ?? 'handoff',
    ])
    if (updated.rowCount !== 1) return err('ACTIVE_BATON_NOT_FOUND', input.from_baton_id)

    const baton = await insertBaton(tx, {
      conversation_id: input.conversation_id,
      owner_agent_id: input.to_owner_agent_id,
      state: 'active',
      source_queue_id: input.source_queue_id ?? null,
      lease_id: input.lease_id ?? null,
      claim_id: input.claim_id ?? null,
    })
    if (!baton) return err('BATON_TRANSFER_FAILED', input.conversation_id)
    return {
      ok: true,
      previous_baton_id: input.from_baton_id,
      baton,
    }
  })
}
