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
  parseQueuePayload,
  withTerminalBaton,
  type TerminalBaton,
} from '../../core/no-reply-policy'

export type LifecycleMode = 'processing' | 'done' | 'record-no-reply'

export interface LifecycleOptions extends ReceiveOptions {
  queueId?: string
  reason?: string
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
  final_close_contract: string
}

export interface LifecycleResult extends ReceiveResult {
  summary?: LifecycleTransitionSummary
}

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
      return db.transaction<LifecycleTransitionSummary>(async (tx) => {
        const row = await tx.queryOne<{
          id: string | number
          agent_id: string
          message_id: string | null
          status: string
          payload: string | null
          stored_content: string | null
          stored_message_type: string | null
        }>(
          `SELECT mq.id, mq.agent_id, mq.message_id, mq.status, mq.payload,
                  am.content AS stored_content, am.message_type AS stored_message_type
             FROM message_queue mq
             LEFT JOIN agent_messages am ON am.id = mq.message_id
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
        const noReplyRequired = mode === 'record-no-reply' || decision.no_reply_required
        const terminalBaton = noReplyRequired
          ? buildTerminalBaton({
              reason: opts.reason?.trim() || decision.reason || 'record_no_reply_command',
              setBy: plan.env.AGENT_ID,
              source: mode === 'record-no-reply' ? 'record_no_reply_command' : 'deterministic_no_reply_policy',
            })
          : undefined
        const stampedPayload = terminalBaton
          ? JSON.stringify(withTerminalBaton(payload, terminalBaton))
          : null
        if (row.status === toStatus) {
          if (stampedPayload) {
            await tx.execute(
              `UPDATE message_queue SET payload = $3 WHERE id = $1 AND agent_id = $2`,
              [queueId, plan.env.AGENT_ID, stampedPayload],
            )
          }
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

        let expectedStatus = 'received'
        let updateStatus = 'received'
        if (mode === 'processing') {
          if (row.status !== 'received') {
            throw new Error(`INVALID_STATE: queue_id=${queueId} status=${row.status}; expected received`)
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

        const updated = mode === 'processing'
          ? await tx.execute(
              `UPDATE message_queue
                  SET status = 'in_progress'
                WHERE id = $1 AND agent_id = $2 AND status = $3`,
              [queueId, plan.env.AGENT_ID, 'received'],
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
    return {
      ok: false,
      code: 1,
      stdout: '',
      stderr: `Error [AUN_LIFECYCLE_FAILED]: ${(err as Error).message}\n`,
      plan,
    }
  }
}
