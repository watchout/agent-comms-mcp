import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import {
  buildCommandPlan,
  repoRoot,
  type CommandPlan,
  type ReceiveOptions,
  type ReceiveResult,
} from './receive'
import {
  buildTerminalBaton,
  detectNoReplyIntent,
  existingNoReplyBaton,
  parseQueuePayload,
  withTerminalBaton,
  type TerminalBaton,
} from '../../core/no-reply-policy'
import {
  assertMessageQueueStatusVocabularyCompatible,
  formatMessageQueueStatusCodeDrift,
  isDbCodeDriftError,
} from '../../core/message-queue-schema-guard'

export type LifecycleMode = 'processing' | 'done' | 'record-no-reply'

export interface LifecycleOptions extends ReceiveOptions {
  queueId?: string
  reason?: string
  ttlSeconds?: number
}

export interface LifecycleTransitionSummary {
  ok: boolean
  mode: LifecycleMode
  agent_id: string
  expected_agent_id: string
  queue_id: string
  message_id: string | null
  status: 'in_progress' | 'done'
  already_transitioned?: boolean
  no_reply_required?: boolean
  terminal_baton?: TerminalBaton
  lease_renewed?: boolean
  claimed_runtime_instance_id?: string | null
  claim_expires_at?: string | null
  final_close_contract: string
}

export interface LifecycleResult extends ReceiveResult {
  summary?: LifecycleTransitionSummary
}

export interface RenewClaimSummary {
  ok: boolean
  mode: 'renew-claim'
  agent_id: string
  expected_agent_id: string
  queue_id: string
  message_id: string | null
  status: 'received' | 'in_progress'
  claimed_by: string
  claimed_runtime_instance_id: string | null
  prior_claim_expires_at: string | null
  new_claim_expires_at: string
  ttl_seconds: number
  reason: string
  audit_event_type: 'queue.claim_renewed'
  authorization: 'exact_queue_id_and_same_claim_owner'
  free_form_text_authorizes_renewal: false
  final_close_contract: string
}

export interface RenewClaimResult extends ReceiveResult {
  summary?: RenewClaimSummary
}

const MAX_RENEW_TTL_SECONDS = 15 * 60

function dbKind(env: Record<string, string>): 'postgres' | 'sqlite' {
  return env.AGENT_COM_DB === 'sqlite' ? 'sqlite' : 'postgres'
}

async function withDb<T>(
  env: Record<string, string>,
  candidates: string[],
  fn: (db: DbAdapter) => Promise<T>,
): Promise<T> {
  if (dbKind(env) === 'sqlite') {
    const db = new SqliteAdapter(env.AGENT_COM_SQLITE_PATH)
    try {
      return await fn(db)
    } finally {
      await db.close()
    }
  }

  let lastErr: unknown
  for (const candidate of candidates) {
    const { PgAdapter } = await import('../../core/db/pg-adapter')
    const db = new PgAdapter(candidate)
    try {
      return await fn(db)
    } catch (err) {
      lastErr = err
      const message = String((err as Error).message ?? err)
      if (!message.includes('/var/run/postgresql/.s.PGSQL.5432')) throw err
    } finally {
      await db.close().catch(() => {})
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function errorResult(
  code: number,
  label: string,
  message: string,
  opts: LifecycleOptions,
): LifecycleResult {
  return {
    ok: false,
    code,
    stdout: '',
    stderr: `Error [${label}]: ${message}\n`,
    plan: {
      repoRoot: opts.cwd ?? repoRoot(),
      argv: ['bun', 'bin/aun.ts'],
      env: { ...(opts.env ?? process.env) } as Record<string, string>,
      databaseUrlCandidates: [],
    },
  }
}

function requireQueueId(opts: LifecycleOptions): string {
  const queueId = opts.queueId?.trim()
  if (!queueId) throw new Error('--queue-id is required')
  if (!/^\d+$/.test(queueId)) throw new Error('--queue-id must be a positive integer')
  return queueId
}

function finalCloseContract(noReplyRequired: boolean): string {
  return noReplyRequired
    ? 'terminal_baton.no_reply_required recorded; no reply required'
    : 'aun reply --close --queue-id <id> --message-id <uuid> OR aun record-no-reply --queue-id <id>'
}

function boundedRenewTtlSeconds(opts: LifecycleOptions, env: Record<string, string>): number {
  const raw = opts.ttlSeconds ?? Number.parseInt(env.AGENT_COMMS_CLAIM_TTL_SEC ?? '60', 10)
  const ttl = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60
  return Math.min(ttl, MAX_RENEW_TTL_SECONDS)
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function dateMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const normalized = normalizeDate(value)?.trim()
  if (!normalized) return Number.NaN
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)
    ? `${normalized.replace(' ', 'T')}Z`
    : normalized
  return Date.parse(sqliteUtc)
}

export async function renewClaim(opts: LifecycleOptions = {}): Promise<RenewClaimResult> {
  let plan: CommandPlan
  let queueId: string
  try {
    queueId = requireQueueId(opts)
    plan = buildCommandPlan(opts, ['bun', 'bin/aun.ts', 'renew-claim', '--queue-id', queueId])
  } catch (err) {
    return {
      ok: false,
      code: 2,
      stdout: '',
      stderr: `Error [AUN_RENEW_CLAIM_INVALID]: ${(err as Error).message}\n`,
      plan: {
        repoRoot: opts.cwd ?? repoRoot(),
        argv: ['bun', 'bin/aun.ts'],
        env: { ...(opts.env ?? process.env) } as Record<string, string>,
        databaseUrlCandidates: [],
      },
    }
  }

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      return db.transaction<RenewClaimSummary>(async (tx) => {
        const row = await tx.queryOne<{
          id: string | number
          agent_id: string
          message_id: string | null
          status: string
          claimed_by: string | null
          claim_expires_at: string | Date | null
          claimed_runtime_instance_id: string | null
          replied_with: string | null
        }>(
          `SELECT id, agent_id, message_id, status, claimed_by, claim_expires_at,
                  claimed_runtime_instance_id, replied_with
             FROM message_queue
            WHERE id = $1
            FOR UPDATE`,
          [queueId],
        )
        if (!row || row.agent_id !== plan.env.AGENT_ID) {
          throw new Error(`NOT_FOUND: queue_id=${queueId} is not owned by agent_id=${plan.env.AGENT_ID}`)
        }
        if (row.replied_with) {
          throw new Error(`RECONCILE_REQUIRED: queue_id=${queueId} already has replied_with=${row.replied_with}`)
        }
        if (row.status !== 'received' && row.status !== 'in_progress') {
          throw new Error(`INVALID_STATE: queue_id=${queueId} status=${row.status}; expected received|in_progress`)
        }
        if (row.claimed_by !== plan.env.AGENT_ID) {
          throw new Error(`NOT_CLAIM_OWNER: queue_id=${queueId} claimed_by=${row.claimed_by ?? 'null'}; expected ${plan.env.AGENT_ID}`)
        }
        const runtimeInstanceId = plan.env.AGENT_COM_RUNTIME_INSTANCE_ID?.trim() || null
        if (row.claimed_runtime_instance_id && row.claimed_runtime_instance_id !== runtimeInstanceId) {
          throw new Error(`CLAIM_FENCED: queue_id=${queueId} belongs to runtime_instance_id=${row.claimed_runtime_instance_id}`)
        }
        const expiresAtMs = dateMillis(row.claim_expires_at)
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
          throw new Error(`CLAIM_EXPIRED: queue_id=${queueId} requires exact fenced recovery before renewal`)
        }

        const ttlSeconds = boundedRenewTtlSeconds(opts, plan.env)
        const newClaimExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString()
        const reason = opts.reason?.trim() || 'operator_exact_id_same_owner_renewal'
        await tx.execute(
          `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            'queue.claim_renewed',
            plan.env.AGENT_ID,
            String(row.id),
            JSON.stringify({
              mode: 'renew-claim',
              queue_id: String(row.id),
              message_id: row.message_id,
              status: row.status,
              claimed_by: row.claimed_by,
              claimed_runtime_instance_id: runtimeInstanceId,
              prior_claim_expires_at: normalizeDate(row.claim_expires_at),
              new_claim_expires_at: newClaimExpiresAt,
              ttl_seconds: ttlSeconds,
              reason,
              authorization: 'exact_queue_id_and_same_claim_owner',
              free_form_text_authorizes_renewal: false,
            }),
            'default',
          ],
        )
        const updated = await tx.execute(
          `UPDATE message_queue
              SET claim_expires_at = $1,
                  claimed_at = COALESCE(claimed_at, now()),
                  claimed_runtime_instance_id = $4
            WHERE id = $2
              AND agent_id = $3
              AND claimed_by = $3
              AND status IN ('received', 'in_progress')
              AND claim_expires_at > now()
              AND (claimed_runtime_instance_id IS NULL OR claimed_runtime_instance_id = $4)`,
          [newClaimExpiresAt, queueId, plan.env.AGENT_ID, runtimeInstanceId],
        )
        if (updated.rowCount !== 1) {
          throw new Error(`RACE: queue_id=${queueId} changed before renew-claim`)
        }
        return {
          ok: true,
          mode: 'renew-claim',
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          queue_id: String(row.id),
          message_id: row.message_id,
          status: row.status as 'received' | 'in_progress',
          claimed_by: row.claimed_by,
          claimed_runtime_instance_id: runtimeInstanceId,
          prior_claim_expires_at: normalizeDate(row.claim_expires_at),
          new_claim_expires_at: newClaimExpiresAt,
          ttl_seconds: ttlSeconds,
          reason,
          audit_event_type: 'queue.claim_renewed',
          authorization: 'exact_queue_id_and_same_claim_owner',
          free_form_text_authorizes_renewal: false,
          final_close_contract: finalCloseContract(false),
        }
      })
    })

    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(summary) + '\n',
      stderr: '',
      plan,
      summary,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [AUN_RENEW_CLAIM_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}

export async function lifecycleTransition(
  mode: LifecycleMode,
  opts: LifecycleOptions = {},
): Promise<LifecycleResult> {
  let plan: CommandPlan
  let queueId: string
  try {
    queueId = requireQueueId(opts)
    plan = buildCommandPlan(opts, ['bun', 'bin/aun.ts', mode, '--queue-id', queueId])
  } catch (err) {
    return errorResult(2, 'AUN_LIFECYCLE_INVALID', (err as Error).message, opts)
  }

  const toStatus = mode === 'processing' ? 'in_progress' : 'done'

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      await assertMessageQueueStatusVocabularyCompatible(db, { operation: `aun ${mode}` })
      return db.transaction<LifecycleTransitionSummary>(async (tx) => {
        const row = await tx.queryOne<{
          id: string | number
          agent_id: string
          message_id: string | null
          status: string
          payload: string | null
          stored_content: string | null
          stored_message_type: string | null
          claimed_by: string | null
          claimed_at: string | Date | null
          claim_expires_at: string | Date | null
          claimed_runtime_instance_id: string | null
        }>(
          `SELECT mq.id, mq.agent_id, mq.message_id, mq.status, mq.payload,
                  mq.claimed_by, mq.claimed_at, mq.claim_expires_at,
                  mq.claimed_runtime_instance_id,
                  am.content AS stored_content, am.message_type AS stored_message_type
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id::text = mq.message_id
            WHERE mq.id = $1 AND mq.agent_id = $2`,
          [queueId, plan.env.AGENT_ID],
        )
        if (!row) {
          throw new Error(`NOT_FOUND: queue_id=${queueId} is not owned by agent_id=${plan.env.AGENT_ID}`)
        }
        const payload = parseQueuePayload(row.payload)
        const decision = detectNoReplyIntent({
          payload,
          storedContent: row.stored_content,
        })
        const existingBaton = existingNoReplyBaton(payload)
        const noReplyRequired = mode === 'record-no-reply' || decision.no_reply_required
        const terminalBaton = existingBaton ?? (noReplyRequired
          ? buildTerminalBaton({
              reason: opts.reason?.trim() || decision.reason || 'record_no_reply_command',
              setBy: plan.env.AGENT_ID,
              source: mode === 'record-no-reply' ? 'record_no_reply_command' : 'deterministic_no_reply_policy',
            })
          : undefined)
        const stampedPayload = terminalBaton && !existingBaton
          ? JSON.stringify(withTerminalBaton(payload, terminalBaton))
          : null
        if (row.status === toStatus && mode !== 'processing') {
          return {
            ok: true,
            mode,
            agent_id: plan.env.AGENT_ID,
            expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
            queue_id: String(row.id),
            message_id: row.message_id,
            status: toStatus,
            already_transitioned: true,
            no_reply_required: noReplyRequired || undefined,
            terminal_baton: terminalBaton,
            final_close_contract: finalCloseContract(noReplyRequired),
          }
        }

        const activeStatus = row.status === 'received' || row.status === 'in_progress'
        const runtimeInstanceId = plan.env.AGENT_COM_RUNTIME_INSTANCE_ID?.trim() || null
        if (activeStatus) {
          if (row.claimed_by !== plan.env.AGENT_ID) {
            throw new Error(`NOT_CLAIM_OWNER: queue_id=${queueId} claimed_by=${row.claimed_by ?? 'null'}; expected ${plan.env.AGENT_ID}`)
          }
          if (row.claimed_runtime_instance_id && row.claimed_runtime_instance_id !== runtimeInstanceId) {
            throw new Error(`CLAIM_FENCED: queue_id=${queueId} belongs to runtime_instance_id=${row.claimed_runtime_instance_id}`)
          }
          const expiresAtMs = dateMillis(row.claim_expires_at)
          if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            throw new Error(`CLAIM_EXPIRED: queue_id=${queueId} requires exact fenced recovery before ${mode}`)
          }
        }

        let expectedStatus = 'received'
        let updateStatus = 'received'
        if (mode === 'processing') {
          if (row.status !== 'received' && row.status !== 'in_progress') {
            throw new Error(`INVALID_STATE: queue_id=${queueId} status=${row.status}; expected received|in_progress`)
          }
        } else {
          const canDirectCloseReceived = row.status === 'received' && noReplyRequired
          const canCloseInProgress = row.status === 'in_progress'
          const canRecordNoReply = mode === 'record-no-reply' && (row.status === 'received' || row.status === 'in_progress')
          if (!canCloseInProgress && !canDirectCloseReceived && !canRecordNoReply) {
            expectedStatus = mode === 'record-no-reply'
              ? 'received|in_progress'
              : "in_progress or received with terminal_baton.no_reply_required"
            throw new Error(`INVALID_STATE: queue_id=${queueId} status=${row.status}; expected ${expectedStatus}`)
          }
          updateStatus = row.status
        }

        const renewedClaimExpiresAt = mode === 'processing'
          ? new Date(Date.now() + boundedRenewTtlSeconds(opts, plan.env) * 1000).toISOString()
          : null
        const updated = mode === 'processing'
          ? await tx.execute(
              `UPDATE message_queue
                  SET status = 'in_progress',
                      claimed_at = COALESCE(claimed_at, now()),
                      claim_expires_at = $3,
                      claimed_runtime_instance_id = $4
                WHERE id = $1
                  AND agent_id = $2
                  AND claimed_by = $2
                  AND status IN ('received', 'in_progress')
                  AND claim_expires_at > now()
                  AND (claimed_runtime_instance_id IS NULL OR claimed_runtime_instance_id = $4)`,
              [queueId, plan.env.AGENT_ID, renewedClaimExpiresAt, runtimeInstanceId],
            )
          : stampedPayload
            ? await tx.execute(
              `UPDATE message_queue
                    SET status = 'done', done_at = now(), payload = $4
                  WHERE id = $1 AND agent_id = $2 AND status = $3`,
                [queueId, plan.env.AGENT_ID, updateStatus, stampedPayload],
              )
            : await tx.execute(
              `UPDATE message_queue
                    SET status = 'done', done_at = now()
                  WHERE id = $1 AND agent_id = $2 AND status = $3`,
                [queueId, plan.env.AGENT_ID, updateStatus],
              )
        if (updated.rowCount !== 1) {
          throw new Error(`RACE: queue_id=${queueId} changed before ${mode}`)
        }
        await tx.execute(
          `UPDATE agents SET
             status = CASE WHEN EXISTS(
               SELECT 1 FROM message_queue
                WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
             ) THEN 'busy' ELSE 'idle' END,
             status_detail = CASE WHEN EXISTS(
               SELECT 1 FROM message_queue
                WHERE claimed_by = $1 AND status IN ('received', 'in_progress')
             ) THEN 'メッセージ処理中' ELSE NULL END,
             status_updated_at = now()
           WHERE agent_id = $1`,
          [plan.env.AGENT_ID],
        )
        return {
          ok: true,
          mode,
          agent_id: plan.env.AGENT_ID,
          expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
          queue_id: String(row.id),
          message_id: row.message_id,
          status: toStatus,
          already_transitioned: mode === 'processing' && row.status === 'in_progress' ? true : undefined,
          lease_renewed: mode === 'processing' ? true : undefined,
          claimed_runtime_instance_id: mode === 'processing' ? runtimeInstanceId : undefined,
          claim_expires_at: renewedClaimExpiresAt,
          no_reply_required: noReplyRequired || undefined,
          terminal_baton: terminalBaton,
          final_close_contract: finalCloseContract(noReplyRequired),
        }
      })
    })

    return {
      ok: true,
      code: 0,
      stdout: JSON.stringify(summary) + '\n',
      stderr: '',
      plan,
      summary,
    }
  } catch (err) {
    if (isDbCodeDriftError(err)) {
      return {
        ok: false,
        code: 1,
        stdout: '',
        stderr: `${formatMessageQueueStatusCodeDrift(err.report)}\n`,
        plan,
      }
    }
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [AUN_LIFECYCLE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}
