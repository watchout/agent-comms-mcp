import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { evaluateDoneTransition, formatDoneTransitionRejection } from '../../core/terminal-baton-invariant'
import {
  buildCommandPlan,
  repoRoot,
  type CommandPlan,
  type ReceiveOptions,
  type ReceiveResult,
} from './receive'

export interface LifecycleOptions extends ReceiveOptions {
  queueId?: string
}

export interface LifecycleTransitionSummary {
  ok: boolean
  mode: 'processing' | 'done'
  agent_id: string
  expected_agent_id: string
  queue_id: string
  message_id: string | null
  status: 'in_progress' | 'done'
  already_transitioned?: boolean
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

export async function lifecycleTransition(
  mode: 'processing' | 'done',
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

  const fromStatus = mode === 'processing' ? 'received' : 'in_progress'
  const toStatus = mode === 'processing' ? 'in_progress' : 'done'

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      return db.transaction<LifecycleTransitionSummary>(async (tx) => {
        const row = await tx.queryOne<{
          id: string | number
          agent_id: string
          message_id: string | null
          status: string
        }>(
          `SELECT id, agent_id, message_id, status
             FROM message_queue
            WHERE id = $1 AND agent_id = $2`,
          [queueId, plan.env.AGENT_ID],
        )
        if (!row) {
          throw new Error(`NOT_FOUND: queue_id=${queueId} is not owned by agent_id=${plan.env.AGENT_ID}`)
        }
        if (row.status === toStatus) {
          return {
            ok: true,
            mode,
            agent_id: plan.env.AGENT_ID,
            expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
            queue_id: String(row.id),
            message_id: row.message_id,
            status: toStatus,
            already_transitioned: true,
            final_close_contract: 'aun reply --close --queue-id <id> --message-id <uuid>',
          }
        }
        if (row.status !== fromStatus) {
          throw new Error(`INVALID_STATE: queue_id=${queueId} status=${row.status}; expected ${fromStatus}`)
        }

        if (mode === 'done') {
          const decision = await evaluateDoneTransition(
            async (sql, params) => tx.query(sql, params as any[] | undefined),
            { queueId, agentId: plan.env.AGENT_ID },
          )
          if (!decision.allowed) {
            throw new Error(formatDoneTransitionRejection(decision))
          }
        }

        const setClause = mode === 'done'
          ? `status = 'done', done_at = now()`
          : `status = 'in_progress'`
        const updated = await tx.execute(
          `UPDATE message_queue
              SET ${setClause}
            WHERE id = $1 AND agent_id = $2 AND status = $3`,
          [queueId, plan.env.AGENT_ID, fromStatus],
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
          final_close_contract: 'aun reply --close --queue-id <id> --message-id <uuid>',
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
