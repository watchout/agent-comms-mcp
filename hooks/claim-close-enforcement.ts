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
 *        can list bypassed sessions per-claim.
 *     3. Runs `bun cli/index.ts notify` against the channel
 *        AUN_STOP_HOOK_ESCALATION_TARGET (default: agent-com) with
 *        the CEO mentioned, asking for manual intervention.
 *     4. Returns exit-code 0 so the session isn't permanently stuck.
 *   Cycle 1 fix (auditor BLOCK 2): the dedup key is the
 *   (agent_id, session_id, claim_id-set) triple — NOT session_id
 *   alone. A new claim within the same session resets the retry
 *   counter and is eligible for its own escalation, while the same
 *   claim never produces duplicate alerts.
 *
 * Output contract:
 *   - JSON `block` printed to stdout (Claude Code Stop hook shape).
 *   - exit 2 = block + re-prompt; exit 0 = pass (escalation also exit 0).
 *   - Any unhandled error → exit 0 (fail-safe per spec §3.3 / §G-3).
 */

import { Client } from 'pg'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

function safeBaseName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
}

// Issue #278 cycle 1 (auditor BLOCK 2): the retry counter and the
// escalation sentinel are keyed by (agent_id, session_id, claim_key)
// where claim_key is a stable derivation of the current claim set.
// This way, a fresh claim in the same Claude session is eligible for
// its own retry budget and its own escalation, while a single claim
// never produces duplicate alerts no matter how many Stop firings
// happen against it.
//
// claim_key shape:
//   - "open=<id>"     when a single open claim is the block reason
//   - "pending=<n>"   when no claim but pending count blocks
//   - "none"          for the no-block early-return path (counter is
//                     reset under this key, harmless if never written)
function claimKey(state: { openClaim: { id: number | string } | null; pendingCount: number } | null): string {
  if (!state) return 'none'
  if (state.openClaim) return `open=${state.openClaim.id}`
  if (state.pendingCount > 0) return `pending=${state.pendingCount}`
  return 'none'
}

function counterPath(agentId: string, sessionId: string, claimKey: string): string {
  return join(STATE_DIR, `${safeBaseName(agentId)}__${safeBaseName(sessionId)}__${safeBaseName(claimKey)}.count`)
}
function escalatedPath(agentId: string, sessionId: string, claimKey: string): string {
  return join(STATE_DIR, `${safeBaseName(agentId)}__${safeBaseName(sessionId)}__${safeBaseName(claimKey)}.escalated`)
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
  openClaim: { id: number | string; messageId: string | null } | null
  pendingCount: number
}

async function inspectQueue(client: Client, agentId: string): Promise<QueueState> {
  const claim = await client.query<{ id: number | string; message_id: string | null }>(
    `SELECT id, message_id FROM message_queue
       WHERE claimed_by = $1 AND status = 'read'
       ORDER BY claimed_at DESC NULLS LAST
       LIMIT 1`,
    [agentId],
  )
  const pending = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM message_queue
       WHERE agent_id = $1 AND status = 'pending'`,
    [agentId],
  )
  return {
    openClaim: claim.rows[0] ? { id: claim.rows[0].id, messageId: claim.rows[0].message_id } : null,
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
  // 1. bypass.log
  const claimDesc = state.openClaim
    ? `claim_id=${state.openClaim.id} message_id=${state.openClaim.messageId ?? 'null'}`
    : `pending_count=${state.pendingCount}`
  appendLog(BYPASS_LOG, `agent=${agentId} session=${sessionId} claim_key=${ckey} retry_limit_reached ${claimDesc}`)

  // 2. dedupe per (agent_id, session_id, claim_key) — Issue #278 cycle 1
  // BLOCK 2 fix: a new claim in the same session must be eligible for
  // its own escalation while a single claim never duplicates alerts.
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
            open_claim_id: state.openClaim?.id ?? null,
            open_message_id: state.openClaim?.messageId ?? null,
            pending_count: state.pendingCount,
          }),
        ],
      )
    } catch (err) {
      appendLog(ERROR_LOG, `audit_log insert failed: ${err}`)
    }
  }

  // 4. CEO mention via CLI notify (subprocess so the hook stays
  //    independent of the MCP server lifecycle).
  const reasonText = state.openClaim
    ? `claim ${state.openClaim.id} を ${RETRY_LIMIT} 回 close しなかった、要 manual intervention`
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

  // Issue #278 cycle 1 (auditor BLOCK 2): the retry / escalation key is
  // the (agent_id, session_id, claim_key) triple, not session_id alone.
  // claim_key derives from the current block reason so a fresh claim
  // in the same session resets its own counter.
  const ckey = claimKey(state)

  // Pass: no open claim and no pending → reset counter for the
  // current block-reason key (harmless when none exists), exit 0.
  if (!state.openClaim && state.pendingCount === 0) {
    writeCounter(counterPath(AGENT_ID, sessionId, ckey), 0)
    if (connected) await client.end().catch(() => {})
    return 0
  }

  // Block decision: open claim takes precedence over pending.
  const reason = state.openClaim ? 'open_claim' : 'pending_unclaimed'
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
