#!/usr/bin/env bun
/**
 * Issue #278 cycle 3 (CEO directive 3, action 3) — PreToolUse inbox gate.
 *
 * Fires before EVERY tool call. Blocks any tool that is not on a small
 * inbox-management allow-list when the bot has unread messages
 * (status='pending') waiting in its message_queue. The LLM is told it
 * must drain the inbox via send / notify / skip / next / fail /
 * reclaim before any other work resumes.
 *
 * Why this exists (CEO directive 3 of 3):
 *   - Stop hook v8 (cycle 0) catches the case where the turn is
 *     ABOUT to end with an open claim or pending row.
 *   - SessionStart drain (Component F) catches the case where a fresh
 *     session has stale pending rows.
 *   - This gate covers the third gap: a turn that started clean but
 *     then a NEW push arrived mid-task. Pre-cycle-3 the LLM could
 *     finish whatever it was doing without acknowledging the new row;
 *     this gate forces the LLM to handle the inbox first.
 *
 * Allow-list (every other tool is blocked while inbox > 0):
 *   - mcp__aun__next               (claim a pending row)
 *   - mcp__aun__send               (reply to an active claim)
 *   - mcp__aun__notify             (self-originated post, no claim)
 *   - mcp__aun__skip               (operator drop)
 *   - mcp__aun__fail               (error path)
 *   - mcp__aun__reclaim            (manual orphan reclaim)
 *   - legacy aliases: mcp__agent_comms__* / mcp__agent-comms__*
 *
 * Failure modes (all fail-safe exit 0):
 *   - DATABASE_URL / AGENT_ID unset → no-op pass.
 *   - DB unreachable → no-op pass.
 *   - Tool is on allow-list → no-op pass.
 *   - pending count = 0 → no-op pass.
 *   - any thrown exception → top-level catch, exit 0.
 *
 * Block path:
 *   - exit 2 + Claude Code hookSpecificOutput JSON with a re-prompt
 *     telling the LLM to drain the inbox first.
 *
 * Mentions semantics:
 *   The message_queue is already partitioned by agent_id (one row per
 *   recipient via fanout), so `agent_id = $AGENT_ID AND status =
 *   'pending'` already encodes "messages mentioning me that I haven't
 *   handled yet". The dispatch language ("mentions CONTAINS agent_id")
 *   is the higher-level intent, but the storage shape makes
 *   agent_id-based filtering the structurally correct predicate.
 */

import { Client } from 'pg'
import { join } from 'node:path'

const AGENT_ID = process.env.AGENT_ID
const DATABASE_URL = process.env.DATABASE_URL
const HOME = process.env.HOME ?? '/tmp'
const LOG_DIR = process.env.AUN_LOG_DIR ?? join(HOME, '.aun/logs')
const ERROR_LOG = join(LOG_DIR, 'pre-tool-use-inbox-gate-errors.log')

// Allow-list: any tool whose name matches one of these is permitted to
// run regardless of inbox state. Everything else gets gated when the
// inbox is non-empty.
const MCP_NAMESPACES = ['aun', 'agent_comms', 'agent-comms'] as const
const INBOX_TOOL_NAMES = ['next', 'send', 'notify', 'skip', 'fail', 'reclaim'] as const
const CANONICAL_ALLOWED_TOOLS = INBOX_TOOL_NAMES.map(tool => `mcp__aun__${tool}`)
const LEGACY_ALLOWED_TOOLS = MCP_NAMESPACES
  .filter(ns => ns !== 'aun')
  .flatMap(ns => INBOX_TOOL_NAMES.map(tool => `mcp__${ns}__${tool}`))

const ALLOW_LIST = new Set<string>([
  ...CANONICAL_ALLOWED_TOOLS,
  ...LEGACY_ALLOWED_TOOLS,
])

interface PreToolUsePayload { tool_name?: string }

function appendErrorLog(line: string): void {
  try {
    const fs = require('node:fs')
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(ERROR_LOG, `${new Date().toISOString()} | ${line}\n`)
  } catch {}
}

function readPayload(): PreToolUsePayload {
  try {
    const fs = require('node:fs')
    const data = fs.readFileSync(0, 'utf-8') as string
    return data.trim() ? (JSON.parse(data) as PreToolUsePayload) : {}
  } catch {
    return {}
  }
}

function emitBlock(pendingCount: number): void {
  const additional =
    `ERROR [INBOX_GATE]: agent ${AGENT_ID} has ${pendingCount} unread message_queue row(s) (status='pending'). ` +
    `You MUST drain the inbox before running any other tool. Allowed tools while gated: ` +
    `${CANONICAL_ALLOWED_TOOLS.join(', ')}. ` +
    `Legacy aliases are also accepted during migration: ${LEGACY_ALLOWED_TOOLS.join(', ')}. ` +
    `Call \`mcp__aun__next\` now to claim and process the next message.`
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: additional },
  }) + '\n')
}

async function main(): Promise<number> {
  if (!AGENT_ID || !DATABASE_URL) return 0

  const payload = readPayload()
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''

  // Allow-list short-circuit: never block the tools that drain the inbox.
  if (ALLOW_LIST.has(toolName)) return 0

  const client = new Client({ connectionString: DATABASE_URL })
  try { await client.connect() } catch (err) {
    appendErrorLog(`db connect failed: ${err}`)
    return 0 // fail-safe
  }

  try {
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM message_queue
        WHERE agent_id = $1 AND status = 'pending'`,
      [AGENT_ID],
    )
    const pendingCount = r.rows[0]?.n ?? 0
    if (pendingCount === 0) return 0
    emitBlock(pendingCount)
    return 2
  } catch (err) {
    appendErrorLog(`query failed: ${err}`)
    return 0
  } finally {
    await client.end().catch(() => {})
  }
}

try {
  const code = await main()
  process.exit(code)
} catch (err) {
  appendErrorLog(`fatal (caught, exit 0): ${err}`)
  process.exit(0)
}
