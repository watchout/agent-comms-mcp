import { createHash } from 'node:crypto'
import type { DbAdapter } from './db'
import type {
  D1AuthorizationEnvelope,
  D1ExecutionState,
  D1InvocationPersistencePort,
  D1PersistencePort,
} from './shirube-d1-execution-adapter'

type ClaimRow = {
  claim_key: string
  handoff_id: string
  authorization_digest: string
  control_source: string
  exact_base_sha: string
  allowed_paths_digest: string
  status: 'claimed'
}

type InvocationRow = {
  invocation_key: string
  claim_key: string
  handoff_id: string
  authorization_digest: string
  effect: D1ExecutionState['effect']
  status: D1ExecutionState['status']
  internal_reply_receipt: string | null
  github_writeback_receipt: string | null
  external_send_receipt: string | null
}

const transactionTails = new WeakMap<DbAdapter, Promise<void>>()

export async function runD1Transaction<T>(db: DbAdapter, fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
  const prior = transactionTails.get(db) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = prior.then(() => current)
  transactionTails.set(db, tail)
  await prior
  try {
    return await db.transaction(fn)
  } finally {
    release()
    if (transactionTails.get(db) === tail) transactionTails.delete(db)
  }
}

export function d1AllowedPathsDigest(paths: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...new Set(paths)].sort()), 'utf8')
    .digest('hex')
}

function claimState(row: ClaimRow): D1ExecutionState {
  return {
    handoff_id: row.handoff_id,
    authorization_digest: row.authorization_digest,
    claim_key: row.claim_key,
    invocation_key: null,
    effect: null,
    status: 'claimed',
    internal_reply_receipt: null,
    github_writeback_receipt: null,
    external_send_receipt: null,
  }
}

function invocationState(row: InvocationRow): D1ExecutionState {
  return {
    handoff_id: row.handoff_id,
    authorization_digest: row.authorization_digest,
    claim_key: row.claim_key,
    invocation_key: row.invocation_key,
    effect: row.effect,
    status: row.status,
    internal_reply_receipt: row.internal_reply_receipt,
    github_writeback_receipt: row.github_writeback_receipt,
    external_send_receipt: row.external_send_receipt,
  }
}

function assertClaimAuthority(row: ClaimRow, authorization: D1AuthorizationEnvelope): void {
  if (
    row.handoff_id !== authorization.handoff_id
    || row.authorization_digest !== authorization.authorization_digest
    || row.control_source !== authorization.control_source
    || row.exact_base_sha !== authorization.exact_base_sha
    || row.allowed_paths_digest !== d1AllowedPathsDigest(authorization.allowed_paths)
    || row.status !== 'claimed'
  ) {
    throw new Error('D1_CLAIM_IMMUTABLE_CONFLICT')
  }
}

function assertInvocationAuthority(row: InvocationRow, state: D1ExecutionState): void {
  if (
    row.claim_key !== state.claim_key
    || row.handoff_id !== state.handoff_id
    || row.authorization_digest !== state.authorization_digest
    || row.effect !== state.effect
  ) {
    throw new Error('D1_INVOCATION_IMMUTABLE_CONFLICT')
  }
}

const CLAIM_COLUMNS = `claim_key, handoff_id, authorization_digest, control_source,
  exact_base_sha, allowed_paths_digest, status`
const INVOCATION_COLUMNS = `invocation_key, claim_key, handoff_id, authorization_digest,
  effect, status, internal_reply_receipt, github_writeback_receipt, external_send_receipt`

export function createD1PersistencePorts(
  db: DbAdapter,
  authorization: D1AuthorizationEnvelope,
  now: () => Date = () => new Date(),
): { claim_persistence: D1PersistencePort; invocation_persistence: D1InvocationPersistencePort } {
  return {
    claim_persistence: {
      async load(key) {
        const row = await db.queryOne<ClaimRow>(
          `SELECT ${CLAIM_COLUMNS} FROM shirube_d1_claims WHERE claim_key = $1`,
          [key],
        )
        if (!row) return null
        assertClaimAuthority(row, authorization)
        return claimState(row)
      },
      async persist_once(state) {
        return runD1Transaction(db, async (tx) => {
          await tx.execute(
            `INSERT INTO shirube_d1_claims
               (claim_key, handoff_id, authorization_digest, control_source, exact_base_sha,
                allowed_paths_digest, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'claimed', $7, $7)
             ON CONFLICT (claim_key) DO NOTHING`,
            [
              state.claim_key,
              authorization.handoff_id,
              authorization.authorization_digest,
              authorization.control_source,
              authorization.exact_base_sha,
              d1AllowedPathsDigest(authorization.allowed_paths),
              now().toISOString(),
            ],
          )
          const row = await tx.queryOne<ClaimRow>(
            `SELECT ${CLAIM_COLUMNS} FROM shirube_d1_claims WHERE claim_key = $1`,
            [state.claim_key],
          )
          if (!row) throw new Error('D1_CLAIM_PERSIST_FAILED')
          assertClaimAuthority(row, authorization)
          return claimState(row)
        })
      },
    },
    invocation_persistence: {
      async load(key) {
        const row = await db.queryOne<InvocationRow>(
          `SELECT ${INVOCATION_COLUMNS} FROM shirube_d1_invocations WHERE invocation_key = $1`,
          [key],
        )
        return row ? invocationState(row) : null
      },
      async reserve_once(state) {
        return runD1Transaction(db, async (tx) => {
          const inserted = await tx.execute(
            `INSERT INTO shirube_d1_invocations
               (invocation_key, claim_key, handoff_id, authorization_digest, effect, status,
                internal_reply_receipt, github_writeback_receipt, external_send_receipt,
                reserved_at, completed_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'reserved', NULL, NULL, NULL, $6, NULL, $6)
             ON CONFLICT (invocation_key) DO NOTHING`,
            [
              state.invocation_key,
              state.claim_key,
              state.handoff_id,
              state.authorization_digest,
              state.effect,
              now().toISOString(),
            ],
          )
          const row = await tx.queryOne<InvocationRow>(
            `SELECT ${INVOCATION_COLUMNS} FROM shirube_d1_invocations WHERE invocation_key = $1`,
            [state.invocation_key],
          )
          if (!row) throw new Error('D1_INVOCATION_RESERVE_FAILED')
          assertInvocationAuthority(row, state)
          return { acquired: inserted.rowCount === 1, state: invocationState(row) }
        })
      },
      async complete_once(state) {
        return runD1Transaction(db, async (tx) => {
          const completedAt = now().toISOString()
          await tx.execute(
            `UPDATE shirube_d1_invocations
                SET status = 'completed',
                    internal_reply_receipt = $2,
                    github_writeback_receipt = $3,
                    external_send_receipt = $4,
                    completed_at = $5,
                    updated_at = $5
              WHERE invocation_key = $1
                AND claim_key = $6
                AND handoff_id = $7
                AND authorization_digest = $8
                AND effect = $9
                AND status = 'reserved'`,
            [
              state.invocation_key,
              state.internal_reply_receipt,
              state.github_writeback_receipt,
              state.external_send_receipt,
              completedAt,
              state.claim_key,
              state.handoff_id,
              state.authorization_digest,
              state.effect,
            ],
          )
          const row = await tx.queryOne<InvocationRow>(
            `SELECT ${INVOCATION_COLUMNS} FROM shirube_d1_invocations WHERE invocation_key = $1`,
            [state.invocation_key],
          )
          if (!row) throw new Error('D1_INVOCATION_COMPLETE_FAILED')
          assertInvocationAuthority(row, state)
          const persisted = invocationState(row)
          if (
            persisted.status !== 'completed'
            || persisted.internal_reply_receipt !== state.internal_reply_receipt
            || persisted.github_writeback_receipt !== state.github_writeback_receipt
            || persisted.external_send_receipt !== state.external_send_receipt
          ) {
            throw new Error('D1_INVOCATION_RECEIPT_CONFLICT')
          }
          return persisted
        })
      },
    },
  }
}
