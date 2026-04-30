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

// Issue #278 (F-3) — role-differential default drain scope.
//
// When neither AGENT_COMMS_DRAIN_LIMIT (global) nor the per-agent
// override is set, the runner picks a default based on the agent's
// role:
//
//   - lead-bot (lead-ama / lead-tuk / lead-sus, agent_type='lead'):
//       large cap (100) — leads must drain their full backlog at
//       SessionStart so coordination signals do not age out.
//   - dev / org / C-suite (agent_type='dev' | 'org' | undefined):
//       N=5, the spec default.
//   - infra (agent_type='system' | 'infra'):
//       0 — drain disabled. Heartbeat / watchdog have no LLM and
//       no inbox semantics; running the hook on them would just
//       cost a DB round-trip.
//
// `agent_type` is read from the agents table once. If the row is
// missing or DB unreachable, fall back to the spec default (5).
const ROLE_DRAIN_DEFAULTS: Record<string, number> = {
  lead: 100,
  dev: 5,
  org: 5,
  human: 5,
  system: 0,
  infra: 0,
}
const SPEC_DEFAULT_LIMIT = 5

async function lookupRoleLimit(client: Client, agentId: string): Promise<number | null> {
  // Lead bots are recognised either by agent_type='lead' (preferred)
  // or by the agent_id prefix `lead-` (fallback for legacy rows that
  // never had the column populated).
  if (agentId.startsWith('lead-')) return ROLE_DRAIN_DEFAULTS.lead
  try {
    const r = await client.query<{ agent_type: string | null }>(
      `SELECT agent_type FROM agents WHERE agent_id = $1`,
      [agentId],
    )
    const role = r.rows[0]?.agent_type ?? null
    if (role && role in ROLE_DRAIN_DEFAULTS) return ROLE_DRAIN_DEFAULTS[role]
    return null
  } catch {
    return null
  }
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

  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
  } catch {
    // DB unreachable → silent no-op
    return { drained: 0, skipped: 0 }
  }

  // Resolution order (most → least specific):
  //   1. AGENT_COMMS_DRAIN_LIMIT_<AGENT_ID> per-agent env override
  //   2. AGENT_COMMS_DRAIN_LIMIT global env
  //   3. Role-differential default from agents.agent_type
  //   4. Spec default (5)
  let limit: number
  if (perAgentLimit !== undefined) {
    const n = parseInt(perAgentLimit, 10)
    limit = Number.isFinite(n) && n >= 0 ? n : SPEC_DEFAULT_LIMIT
  } else if (globalLimit !== undefined) {
    const n = parseInt(globalLimit, 10)
    limit = Number.isFinite(n) && n >= 0 ? n : SPEC_DEFAULT_LIMIT
  } else {
    const roleLimit = await lookupRoleLimit(client, agentId)
    limit = roleLimit ?? SPEC_DEFAULT_LIMIT
  }

  // limit=0 → drain disabled (infra / system bots). Skip the rest of
  // the pipeline to avoid the SELECT count + SELECT rows round-trips.
  if (limit === 0) {
    await client.end().catch(() => {})
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
