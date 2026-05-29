import type { DbAdapter } from '../../core/db/adapter'
import { SqliteAdapter } from '../../core/db/sqlite-adapter'
import { lifecycleTransitionCore } from '../../core/lifecycle-transition'
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

  const toStatus = mode === 'processing' ? 'in_progress' : 'done'

  try {
    const summary = await withDb(plan.env, plan.databaseUrlCandidates, async (db) => {
      return db.transaction<LifecycleTransitionSummary>(async (tx) => {
        const transition = await lifecycleTransitionCore(tx, {
          mode,
          queueId,
          agentId: plan.env.AGENT_ID,
          ownerAgentId: plan.env.AGENT_ID,
        })
        if (!transition.ok) {
          throw new Error(transition.message)
        }
        if (transition.already_transitioned) {
          return {
            ok: true,
            mode,
            agent_id: plan.env.AGENT_ID,
            expected_agent_id: plan.env.AGENT_COM_EXPECTED_AGENT_ID,
            queue_id: String(transition.queue_id),
            message_id: transition.message_id,
            status: toStatus,
            already_transitioned: true,
            final_close_contract: 'aun reply --close --queue-id <id> --message-id <uuid>',
          }
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
          queue_id: String(transition.queue_id),
          message_id: transition.message_id,
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
