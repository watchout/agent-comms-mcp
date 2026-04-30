#!/usr/bin/env bun
/**
 * Issue #278 (F-1) — SessionStart drain (script-controlled bounded auto-pull).
 *
 * Goal (per Issue #278 §F): force a query path under script control,
 * not LLM judgment. Bound LLM context inflow with a hard limit (default
 * 5, env override). Apply the same auto-skip patterns the receiver
 * uses at INSERT time to opportunistically clear noise rows that
 * slipped through (e.g. config changed since they were enqueued).
 *
 * Behavior:
 *   1. SELECT pending count for $AGENT_ID. If 0 → no-op.
 *   2. SELECT the latest N pending rows (newest first; the older tail
 *      is left to the operator / TTL sweeper).
 *   3. For each row: hydrate content + message_type from payload, run
 *      `matchesAutoSkipPattern`. If matched, UPDATE status='skipped'
 *      with failed_reason='AUTO_SKIP_PATTERN:<reason>'. If not matched,
 *      leave it pending so the LLM turn can claim it via next.
 *   4. Print a one-line summary on stderr (the wrapper hook discards
 *      stdout to keep Claude Code's hookSpecificOutput JSON clean).
 *
 * Fail-safe: any thrown error is caught at the top level so the script
 * exits 0; missing AGENT_ID / DATABASE_URL is also a silent no-op. The
 * wrapper additionally caps wall time at 5 s.
 *
 * Per-agent override:
 *   AGENT_COMMS_DRAIN_LIMIT_<AGENT_ID_UPPER_UNDERSCORE> overrides the
 *   global AGENT_COMMS_DRAIN_LIMIT (default 5). e.g. lead-ama keeps
 *   `AGENT_COMMS_DRAIN_LIMIT_LEAD_AMA` higher to drain its full
 *   backlog (Issue #278 §F-3).
 */

import { Client } from 'pg'
import { matchesAutoSkipPattern } from '../config/auto-skip-patterns'

interface DrainSummary {
  drained: number
  skipped: number
}

async function main(): Promise<DrainSummary> {
  const agentId = process.env.AGENT_ID
  const databaseUrl = process.env.DATABASE_URL
  if (!agentId || !databaseUrl) {
    return { drained: 0, skipped: 0 }
  }

  const perAgentKey = `AGENT_COMMS_DRAIN_LIMIT_${agentId.replace(/-/g, '_').toUpperCase()}`
  const perAgentLimit = process.env[perAgentKey]
  const globalLimit = process.env.AGENT_COMMS_DRAIN_LIMIT
  const parsed = parseInt(perAgentLimit ?? globalLimit ?? '5', 10)
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 5

  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
  } catch {
    // DB unreachable → silent no-op
    return { drained: 0, skipped: 0 }
  }

  let drained = 0
  let skipped = 0
  try {
    const pending = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message_queue
        WHERE agent_id = $1 AND status = 'pending'`,
      [agentId],
    )
    const pendingCount = pending.rows[0]?.n ?? 0
    if (pendingCount === 0) {
      return { drained: 0, skipped: 0 }
    }

    const rows = await client.query<{
      id: number | string
      payload: string
    }>(
      `SELECT id, payload FROM message_queue
        WHERE agent_id = $1 AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT $2`,
      [agentId, limit],
    )

    for (const row of rows.rows) {
      drained++
      let payload: Record<string, unknown> = {}
      try { payload = JSON.parse(row.payload) } catch {}
      const content = typeof payload.content === 'string' ? payload.content : ''
      const messageType = typeof payload.message_type === 'string' ? payload.message_type : 'chat'
      const authorAgentId = typeof payload.author_id === 'string' ? payload.author_id : null

      const m = matchesAutoSkipPattern({ content, messageType, authorAgentId, recipientAgentId: agentId })
      if (m.matched) {
        await client.query(
          `UPDATE message_queue
              SET status = 'skipped', failed_reason = $1
            WHERE id = $2 AND status = 'pending'`,
          [`AUTO_SKIP_PATTERN:${m.reason ?? 'unknown'}`, row.id],
        )
        skipped++
      }
    }
  } catch (err) {
    process.stderr.write(`session-start-drain: query failed (non-fatal): ${err}\n`)
  } finally {
    await client.end().catch(() => {})
  }
  return { drained, skipped }
}

try {
  const summary = await main()
  process.stderr.write(
    `session-start-drain: drained=${summary.drained} skipped=${summary.skipped} unmatched=${summary.drained - summary.skipped}\n`,
  )
} catch (err) {
  process.stderr.write(`session-start-drain: fatal (caught, exit 0): ${err}\n`)
}
process.exit(0)
