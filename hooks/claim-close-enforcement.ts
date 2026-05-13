#!/usr/bin/env bun
/**
 * Issue #278 (§C + §G-3) — Stop hook v8 claim-close enforcement.
 *
 * Fires on Claude Code Stop. Confirms that the bot's per-row claims
 * are closed (status='replied' / 'failed' / 'skipped') before the turn
 * is allowed to end:
 *
 *   - Any row with `claimed_by=$AGENT_ID AND status='read'` blocks
 *     the turn; the LLM is re-prompted to call send/skip/fail to
 *     close the claim.
 *   - `pending_count > 0 AND no active claim` also blocks — the LLM
 *     is told to call `next` to claim before stopping (Issue #278
 *     §F-1 Stop hook auto-pull guard).
 *
 * Retry-limit-reached escalation (§G-3):
 *   When the same (agent_id, session_id, claim_id-set) gets blocked
 *   N times in a row (default 3, env override AUN_STOP_HOOK_RETRY_LIMIT),
 *   the (N+1)-th invocation:
 *     1. Writes a bypass log line (legacy, audit trail).
 *     2. INSERTs an audit_log row keyed on the
 *        (agent_id, session_id, claim_id-set) triple so dashboards
 *        can list bypassed sessions per-claim-set.
 *     3. Runs `bun cli/index.ts notify` against the channel
 *        AUN_STOP_HOOK_ESCALATION_TARGET (default: agent-com) with
 *        the CEO mentioned, asking for manual intervention.
 *     4. Returns exit-code 0 so the session isn't permanently stuck.
 *
 * Cycle 2 fix (auditor BLOCK 2 verbatim, msg `fc38ea68`):
 *   - `inspectQueue()` returns ALL open claims (no LIMIT 1) so the
 *     dedup key reflects the full claim_id-set, not just the most
 *     recent claim.
 *   - `claimKey()` sorts the open claim ids and hashes them with
 *     SHA-256 (16-hex prefix) so the key is stable, set-aware, and
 *     compact. A fresh claim added to or removed from the set
 *     produces a different key, isolating its retry budget.
 *   - `counterPath()` / `escalatedPath()` derive the basename from a
 *     SHA-256 hash of `(agent_id, session_id, claim_key)` (32-hex
 *     prefix). This is the "filename hash で collision 回避" the PR
 *     body claimed — basename concat without hashing was vulnerable
 *     to crafted session_ids producing the same basename across
 *     different agents.
 */

import { Client } from 'pg'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const AGENT_ID = process.env.AGENT_ID
const DATABASE_URL = process.env.DATABASE_URL
const HOME = process.env.HOME ?? '/tmp'
const STATE_DIR = process.env.AUN_STATE_DIR ?? join(HOME, '.aun/state/claim-close-enforcement')
const LOG_DIR = process.env.AUN_LOG_DIR ?? join(HOME, '.aun/logs')
const RETRY_LIMIT = parseInt(process.env.AUN_STOP_HOOK_RETRY_LIMIT ?? '3', 10)
const ESCALATION_TARGET = process.env.AUN_STOP_HOOK_ESCALATION_TARGET ?? 'agent-com'
const BYPASS_LOG = join(LOG_DIR, 'claim-close-bypass.log')
const ERROR_LOG = join(LOG_DIR, 'claim-close-errors.log')

interface StopPayload { transcript_path?: string; session_id?: string }

function ensureDir(d: string): void {
  try { mkdirSync(d, { recursive: true }) } catch {}
}

function appendLog(path: string, line: string): void {
  ensureDir(LOG_DIR)
  try {
    const ts = new Date().toISOString()
    const fs = require('node:fs')
    fs.appendFileSync(path, `${ts} | ${line}\n`)
  } catch {}
}

function readPayload(): StopPayload {
  // node Bun `process.stdin` is a Readable; read synchronously via fd.
  try {
    const fs = require('node:fs')
    const data = fs.readFileSync(0, 'utf-8') as string
    return data.trim() ? (JSON.parse(data) as StopPayload) : {}
  } catch {
    return {}
  }
}

// Cycle 2 (auditor BLOCK 2 verbatim): the retry counter and the
// escalation sentinel are keyed by (agent_id, session_id, claim_key)
// where claim_key is a stable hash over the SET of open claim ids.
// The same set produces the same key on every Stop firing; any
// addition or removal of a claim within the same session yields a
// different key and a fresh retry budget.
//
// claim_key shape:
//   - "open=<sha256:0..16>" hash of sorted open claim ids
//   - "pending=<n>"         when no claim but pending count blocks
//   - "none"                no open claims and no pending (idle pass)
function claimKey(state: { openClaims: Array<{ id: number | string }>; pendingCount: number } | null): string {
  if (!state) return 'none'
  if (state.openClaims.length > 0) {
    const sortedIds = state.openClaims.map(c => String(c.id)).sort()
    const setHash = createHash('sha256').update(sortedIds.join(',')).digest('hex').slice(0, 16)
    return `open=${setHash}`
  }
  if (state.pendingCount > 0) return `pending=${state.pendingCount}`
  return 'none'
}

// Cycle 2 (auditor BLOCK 2 verbatim): basename = SHA-256(triple)[:32]
// so the path key is collision-safe across (agent_id, session_id,
// claim_key) tuples. Pre-cycle-2 used safeBaseName concatenation,
// which left adversarial / unicode-mangled session_ids able to
// produce the same basename across different agents.
function pathKey(agentId: string, sessionId: string, ckey: string): string {
  return createHash('sha256').update(`${agentId}|${sessionId}|${ckey}`).digest('hex').slice(0, 32)
}

function counterPath(agentId: string, sessionId: string, ckey: string): string {
  return join(STATE_DIR, `${pathKey(agentId, sessionId, ckey)}.count`)
}
function escalatedPath(agentId: string, sessionId: string, ckey: string): string {
  return join(STATE_DIR, `${pathKey(agentId, sessionId, ckey)}.escalated`)
}

function readCounter(p: string): number {
  if (!existsSync(p)) return 0
  try {
    const n = parseInt(readFileSync(p, 'utf-8').trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch { return 0 }
}
function writeCounter(p: string, n: number): void {
  ensureDir(STATE_DIR)
  try { writeFileSync(p, String(n)) } catch {}
}

function emitBlock(reason: string): void {
  const additional = reason === 'open_claim'
    ? 'ERROR: You still hold an open per-row claim on message_queue (status=read). You MUST close it via mcp__agent-comms__send (reply), mcp__agent-comms__skip (operator drop), or mcp__agent-comms__fail (error path) before the turn ends. Do not stop with a claim still open.'
    : 'ERROR: pending message_queue rows for your agent_id remain unprocessed. Call mcp__agent-comms__next to claim and process the next message before stopping.'
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: additional },
  }) + '\n')
}

interface QueueState {
  // Cycle 2 (auditor BLOCK 2): full claim_id-set, not just the latest.
  openClaims: Array<{ id: number | string; messageId: string | null }>
  pendingCount: number
}

async function inspectQueue(client: Client, agentId: string): Promise<QueueState> {
  // Cycle 2: LIMIT 1 撤去 — return every open claim so claimKey() can
  // hash the full set. ORDER BY id ASC gives a stable iteration that
  // matches the sort claimKey() applies, so a debug log can compare
  // the rows here against the hashed key directly.
  const claims = await client.query<{ id: number | string; message_id: string | null }>(
    `SELECT id, message_id FROM message_queue
       WHERE claimed_by = $1 AND status = 'received'
       ORDER BY id ASC`,
    [agentId],
  )
  const pending = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM message_queue
       WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  )
  return {
    openClaims: claims.rows.map(r => ({ id: r.id, messageId: r.message_id })),
    pendingCount: pending.rows[0]?.n ?? 0,
  }
}

async function escalateOnce(
  client: Client | null,
  sessionId: string,
  agentId: string,
  state: QueueState,
  ckey: string,
): Promise<void> {
  // 1. bypass.log — record the full claim_id-set so the operator can
  // reconstruct what triggered the escalation without re-querying.
  const claimIds = state.openClaims.map(c => String(c.id)).sort()
  const claimDesc = state.openClaims.length > 0
    ? `claim_ids=[${claimIds.join(',')}]`
    : `pending_count=${state.pendingCount}`
  appendLog(BYPASS_LOG, `agent=${agentId} session=${sessionId} claim_key=${ckey} retry_limit_reached ${claimDesc}`)

  // 2. dedupe per (agent_id, session_id, claim_key) — the path key is
  // a SHA-256 hash so collision is cryptographically infeasible.
  const sentinel = escalatedPath(agentId, sessionId, ckey)
  if (existsSync(sentinel)) return
  ensureDir(STATE_DIR)
  try { writeFileSync(sentinel, new Date().toISOString()) } catch {}

  // 3. audit_log row (best-effort)
  if (client) {
    try {
      await client.query(
        `INSERT INTO audit_log (event_type, agent_id, target, detail, org_id)
         VALUES ('stop_hook.escalation', $1, $2, $3::jsonb, 'default')`,
        [
          agentId,
          ESCALATION_TARGET,
          JSON.stringify({
            session_id: sessionId,
            claim_key: ckey,
            retry_limit: RETRY_LIMIT,
            open_claim_ids: claimIds,
            pending_count: state.pendingCount,
          }),
        ],
      )
    } catch (err) {
      appendLog(ERROR_LOG, `audit_log insert failed: ${err}`)
    }
  }

  // 4. CEO mention via CLI notify.
  const reasonText = state.openClaims.length > 0
    ? `claim_ids=[${claimIds.join(',')}] を ${RETRY_LIMIT} 回 close しなかった、要 manual intervention`
    : `pending=${state.pendingCount} を ${RETRY_LIMIT} 回 drain しなかった、要 manual intervention`
  const content = `[STOP HOOK ESCALATION] bot ${agentId} session=${sessionId.slice(0, 8)} — ${reasonText}`
  try {
    const r = spawnSync(
      'bun',
      [
        'cli/index.ts',
        'notify',
        '--channel', ESCALATION_TARGET,
        '--mentions', 'ceo',
        '--content', content,
      ],
      { encoding: 'utf-8', timeout: 5000, env: { ...process.env, AGENT_ID: agentId } },
    )
    if (r.status !== 0) {
      appendLog(ERROR_LOG, `notify failed status=${r.status} stderr=${(r.stderr ?? '').slice(0, 200)}`)
    }
  } catch (err) {
    appendLog(ERROR_LOG, `notify spawn failed: ${err}`)
  }
}

async function main(): Promise<number> {
  if (!AGENT_ID || !DATABASE_URL) return 0

  const payload = readPayload()
  const sessionId = payload.session_id ?? 'no-session-id'

  const client = new Client({ connectionString: DATABASE_URL })
  let connected = false
  try { await client.connect(); connected = true } catch (err) {
    appendLog(ERROR_LOG, `db connect failed: ${err}`)
    return 0 // fail-safe
  }

  let state: QueueState
  try {
    state = await inspectQueue(client, AGENT_ID)
  } catch (err) {
    appendLog(ERROR_LOG, `inspect failed: ${err}`)
    if (connected) await client.end().catch(() => {})
    return 0
  }

  const ckey = claimKey(state)

  // Pass: no open claims and no pending → reset counter, exit 0.
  if (state.openClaims.length === 0 && state.pendingCount === 0) {
    writeCounter(counterPath(AGENT_ID, sessionId, ckey), 0)
    if (connected) await client.end().catch(() => {})
    return 0
  }

  // Block decision: open claim takes precedence over pending.
  const reason = state.openClaims.length > 0 ? 'open_claim' : 'pending_unclaimed'
  const cur = readCounter(counterPath(AGENT_ID, sessionId, ckey)) + 1

  if (cur > RETRY_LIMIT) {
    await escalateOnce(connected ? client : null, sessionId, AGENT_ID, state, ckey)
    writeCounter(counterPath(AGENT_ID, sessionId, ckey), cur)
    if (connected) await client.end().catch(() => {})
    return 0 // §G-3: pass after escalation, never silently
  }

  writeCounter(counterPath(AGENT_ID, sessionId, ckey), cur)
  if (connected) await client.end().catch(() => {})
  emitBlock(reason)
  return 2
}

try {
  const code = await main()
  process.exit(code)
} catch (err) {
  appendLog(ERROR_LOG, `fatal (caught, exit 0): ${err}`)
  process.exit(0)
}
