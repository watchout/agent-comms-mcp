import { randomUUID } from 'node:crypto'
import type { DbAdapter } from './db'
import { EventLog } from './eventlog'
import type { AppendEvent } from './eventlog/types'
import {
  validateDeliveryUnit,
  type DeliveryUnitV1,
  type LoadedConnectorRegistrationV1,
} from './eventlog/transport-contract'
import type { D1Effect, D1EffectPort, D1EffectResult } from './shirube-d1-execution-adapter'
import { runD1Transaction } from './shirube-d1-persistence'

type EffectRow = {
  invocation_key: string
  effect: D1Effect
  status: 'reserved' | 'completed'
  receipt: string | null
  lease_owner: string | null
  lease_expires_at: string | Date | null
}

export interface D1EffectPortOptions {
  now?: () => Date
  effectLeaseMs?: number
  effectWaitMs?: number
  effectPollMs?: number
  effectReadbacks?: Partial<Record<D1Effect, (invocationKey: string) => Promise<string | null>>>
}

const cleanString = (value: unknown): string | null => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
)
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function result(row: EffectRow): D1EffectResult {
  const receipt = cleanString(row.receipt)
  if (row.status !== 'completed' || !receipt) throw new Error('D1_EFFECT_RECEIPT_CONFLICT')
  return { invocation_key: row.invocation_key, effect: row.effect, receipt }
}

async function load(db: DbAdapter, invocationKey: string): Promise<EffectRow | null> {
  return db.queryOne<EffectRow>(
    `SELECT invocation_key, effect, status, receipt, lease_owner, lease_expires_at
       FROM shirube_d1_effect_deliveries
      WHERE invocation_key = $1`,
    [invocationKey],
  )
}

export function createD1EffectPort(
  db: DbAdapter,
  effect: D1Effect,
  perform: (invocationKey: string) => Promise<string>,
  readback: ((invocationKey: string) => Promise<string | null>) | undefined,
  options: D1EffectPortOptions = {},
): D1EffectPort {
  const now = options.now ?? (() => new Date())
  const effectLeaseMs = options.effectLeaseMs ?? 30_000
  const effectWaitMs = options.effectWaitMs ?? 30_000
  const effectPollMs = options.effectPollMs ?? 10
  return {
    async perform_once(state) {
      if (!state.invocation_key || state.effect !== effect) throw new Error('D1_EFFECT_INVOCATION_MISMATCH')
      const invocationKey = state.invocation_key
      const leaseOwner = randomUUID()
      const startedAt = now()
      let acquired = false

      await runD1Transaction(db, async (tx) => {
        const inserted = await tx.execute(
          `INSERT INTO shirube_d1_effect_deliveries
             (invocation_key, effect, status, receipt, lease_owner, lease_expires_at, created_at, updated_at)
           VALUES ($1, $2, 'reserved', NULL, $3, $4, $5, $5)
           ON CONFLICT (invocation_key) DO NOTHING`,
          [invocationKey, effect, leaseOwner, new Date(startedAt.getTime() + effectLeaseMs).toISOString(), startedAt.toISOString()],
        )
        acquired = inserted.rowCount === 1
      })

      const deadline = startedAt.getTime() + effectWaitMs
      while (!acquired) {
        const existing = await load(db, invocationKey)
        if (!existing || existing.effect !== effect) throw new Error('D1_EFFECT_RECEIPT_CONFLICT')
        if (existing.status === 'completed') return result(existing)
        const observedAt = now()
        const expiry = existing.lease_expires_at ? new Date(existing.lease_expires_at).getTime() : 0
        if (!Number.isFinite(expiry) || expiry <= observedAt.getTime()) {
          // Never replace an expired performer lease. The old performer may
          // still be executing outside the DB transaction, and a takeover
          // would permit the same external effect to run concurrently. An
          // expired reservation is recovered only through a read-only
          // mediated readback of the invocation key.
          const recoveredReceipt = cleanString(await readback?.(invocationKey))
          if (!recoveredReceipt) throw new Error(`D1_EFFECT_OUTCOME_UNKNOWN: ${invocationKey}`)
          return runD1Transaction(db, async (tx) => {
            await tx.execute(
              `UPDATE shirube_d1_effect_deliveries
                  SET status = 'completed', receipt = $3, lease_owner = NULL,
                      lease_expires_at = NULL, updated_at = $4
                WHERE invocation_key = $1
                  AND effect = $2
                  AND status = 'reserved'
                  AND receipt IS NULL`,
              [invocationKey, effect, recoveredReceipt, observedAt.toISOString()],
            )
            const completed = await tx.queryOne<EffectRow>(
              `SELECT invocation_key, effect, status, receipt, lease_owner, lease_expires_at
                 FROM shirube_d1_effect_deliveries WHERE invocation_key = $1`,
              [invocationKey],
            )
            if (!completed || completed.effect !== effect || completed.receipt !== recoveredReceipt) {
              throw new Error('D1_EFFECT_RECEIPT_CONFLICT')
            }
            return result(completed)
          })
        }
        if (observedAt.getTime() >= deadline) throw new Error(`D1_EFFECT_IN_PROGRESS: ${invocationKey}`)
        await pause(effectPollMs)
      }

      // Deliberately outside a DB transaction. The mediated boundary must use
      // the invocation key for readback/idempotency before any retry.
      const receipt = cleanString(await perform(invocationKey))
      if (!receipt) throw new Error('D1_EFFECT_RECEIPT_REQUIRED')

      return runD1Transaction(db, async (tx) => {
        await tx.execute(
          `UPDATE shirube_d1_effect_deliveries
              SET status = 'completed', receipt = $3, lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = $4
            WHERE invocation_key = $1
              AND effect = $2
              AND status = 'reserved'
              AND lease_owner = $5
              AND (receipt IS NULL OR receipt = $3)`,
          [invocationKey, effect, receipt, now().toISOString(), leaseOwner],
        )
        const completed = await tx.queryOne<EffectRow>(
          `SELECT invocation_key, effect, status, receipt, lease_owner, lease_expires_at
             FROM shirube_d1_effect_deliveries WHERE invocation_key = $1`,
          [invocationKey],
        )
        if (!completed || completed.effect !== effect || completed.receipt !== receipt) {
          throw new Error('D1_EFFECT_RECEIPT_CONFLICT')
        }
        return result(completed)
      })
    },
  }
}

export function createD1EffectPorts(
  db: DbAdapter,
  performers: Record<D1Effect, (invocationKey: string) => Promise<string>>,
  options: D1EffectPortOptions = {},
) {
  return {
    internal_reply: createD1EffectPort(db, 'internal_reply', performers.internal_reply, options.effectReadbacks?.internal_reply, options),
    github_writeback: createD1EffectPort(db, 'github_writeback', performers.github_writeback, options.effectReadbacks?.github_writeback, options),
    external_send: createD1EffectPort(db, 'external_send', performers.external_send, options.effectReadbacks?.external_send, options),
  }
}

export type D1ExternalEvent = Omit<AppendEvent, 'eventType' | 'replyId' | 'payload'> & {
  eventType: 'reply.enqueued'
  replyId: string
  payload: DeliveryUnitV1
  loaded_registration: LoadedConnectorRegistrationV1
}

export async function enqueueD1ExternalEvent(
  db: DbAdapter,
  invocationKey: string,
  event: D1ExternalEvent,
): Promise<string> {
  const expectedReplyId = `d1:${invocationKey}`
  const expectedEventId = `d1:reply-enqueued:${invocationKey}`
  if (
    event.eventId !== expectedEventId
    || event.replyId !== expectedReplyId
    || event.payload.reply_id !== expectedReplyId
  ) {
    throw new Error('D1_EXTERNAL_REPLY_ID_MISMATCH')
  }
  if (
    event.seatId !== event.payload.sender_seat_id
    || event.conversationId !== event.payload.conversation_id
    || event.causationId !== event.payload.causation_id
    || event.correlationId !== event.payload.correlation_id
    || event.turnId !== event.payload.turn_id
  ) throw new Error('D1_EXTERNAL_EVENT_ENVELOPE_MISMATCH')
  validateDeliveryUnit(event.payload, event.loaded_registration)
  const { loaded_registration: _registration, ...appendEvent } = event
  const appended = await new EventLog(db).append({
    ...appendEvent,
    payload: appendEvent.payload as unknown as Record<string, unknown>,
  })
  return appended.event.reply_id ?? expectedReplyId
}
