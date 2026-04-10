#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #132 — agent-com CLI MVP commands.
 *
 * Background:
 *   message-queue-spec §4-6 defines `agent-com next / send / agents` as the
 *   canonical CLI for bot message I/O. Issue #132 ships an MVP that wires
 *   these commands into the existing `cli/index.ts` on top of the current
 *   DB + filesystem-signal infrastructure (no new tables required).
 *
 * These tests are source-level + dispatch-level: we verify that
 *   1. cli/index.ts defines handler functions for next/send/agents,
 *   2. each command name is reachable from the top-level dispatch,
 *   3. the package.json `agent-com` bin entry points at this file, and
 *   4. running `agent-com next` without AGENT_ID prints the env-var error
 *      and exits non-zero (the only behavior we can verify without a DB).
 *
 * Live DB-backed integration tests are intentionally out of scope for the
 * MVP — those run in the post-merge verification step on dev environment.
 *
 * See:
 *   - cli/index.ts                                            (handlers + dispatch)
 *   - github.com/watchout/agent-comms-mcp/issues/132
 *   - docs/agent-com-message-queue-spec.md §4-6              (canonical spec)
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const CLI_PATH = join(REPO_ROOT, 'cli', 'index.ts')
const PKG_PATH = join(REPO_ROOT, 'package.json')

const CLI_SRC = readFileSync(CLI_PATH, 'utf-8')
const PKG = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { bin?: Record<string, string> }

// ─────────────────────────────────────────────────────────────────────────────
// T1: handler functions exist
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a refactor that renames or removes any of next / send /
// agents would silently break the spec-defined CLI surface. Anchor on the
// declared function names so the failure points at the offending rename.
describe('T1 — cli/index.ts defines handler functions for next/send/agents', () => {
  test('nextMessage handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function nextMessage\s*\(/)
  })
  test('sendMessage handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function sendMessage\s*\(/)
  })
  test('listAgents handler is defined', () => {
    expect(CLI_SRC).toMatch(/async function listAgents\s*\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: dispatch routes the three command names to their handlers
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: handlers exist but never get called because the top-level
// argv switch lost a branch. Pin both the command literal and the call site.
describe('T2 — top-level dispatch routes next/send/agents', () => {
  test("'next' command invokes nextMessage()", () => {
    expect(CLI_SRC).toMatch(/command === 'next'[\s\S]*?nextMessage\(\)/)
  })
  test("'send' command invokes sendMessage(...)", () => {
    expect(CLI_SRC).toMatch(/command === 'send'[\s\S]*?sendMessage\(/)
  })
  test("'agents' command invokes listAgents()", () => {
    expect(CLI_SRC).toMatch(/command === 'agents'[\s\S]*?listAgents\(\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: package.json bin entry points at cli/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the spec requires `agent-com` to be the canonical bin
// name (not `agent-comms-mcp`). A drift in package.json would silently break
// downstream installs that rely on `npx agent-com next`.
describe('T3 — package.json bin.agent-com points at cli/index.ts', () => {
  test('bin.agent-com resolves to cli/index.ts', () => {
    expect(PKG.bin).toBeDefined()
    // Allow either `./cli/index.ts` or `cli/index.ts` — npm normalises both.
    expect(PKG.bin?.['agent-com']).toMatch(/^\.?\/?cli\/index\.ts$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: `agent-com next` without AGENT_ID exits non-zero with the env error
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: the only end-to-end check we can run without a DB is the
// pre-flight env validation. If `requireAgentId` ever returns silently or the
// error message gets re-worded, this test catches it. Strip AGENT_ID from
// the spawned env explicitly so a developer who sets it locally still sees a
// deterministic test.
describe('T4 — `agent-com next` requires AGENT_ID', () => {
  test('exits non-zero with the AGENT_ID error message', () => {
    const env = { ...process.env }
    delete env.AGENT_ID
    const result = spawnSync('bun', [CLI_PATH, 'next'], {
      env,
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AGENT_ID')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: agent-com send fans out pg_notify per recipient with `to: <agent_id>`
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: lead-ama follow-up to PR#133 first cut. The original
// implementation built a single pg_notify with `to: state.channel_id`, but
// the agent_inbox LISTEN handler routes per-recipient — `to` MUST be an
// agent_id, and the notify must fire once per mention. Without this, the
// receiver pipeline never picks the CLI-sent rows up. Pin both invariants:
//   (a) the notify is emitted inside a `for (... of mentions)` loop
//   (b) the JSON payload uses `to: recipient`, not `to: state.channel_id`
describe('T5 — `agent-com send` pg_notify fans out per recipient', () => {
  test('pg_notify is wrapped in a per-mention loop with to: recipient', () => {
    // Find the sendMessage function body so the regex doesn't accidentally
    // match the unrelated pg_notify in the channel/agent admin commands.
    const fnStart = CLI_SRC.indexOf('async function sendMessage')
    expect(fnStart).toBeGreaterThan(-1)
    // Walk to the end of the function (next top-level `async function` or EOF).
    const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
    const body = CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)

    // (a) Loop header references `mentions`
    expect(body).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+mentions\s*\)/)
    // (b) The pg_notify payload uses `to: <loop var>` (not `state.channel_id`).
    //     We anchor on the loop variable name being either `recipient` (current)
    //     or any future rename, then assert it's used as the `to` value.
    expect(body).toMatch(/to:\s*recipient\b/)
    // Negative: must NOT carry the buggy `to: state.channel_id` shape.
    expect(body).not.toMatch(/to:\s*state\.channel_id/)
  })
})

// Helper: extract the body of sendMessage so T6/T7/T8 don't match unrelated text.
function sendMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function sendMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

// ─────────────────────────────────────────────────────────────────────────────
// T6: outbound Discord delivery is invoked after the INSERT (ARC codex audit)
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit (2026-04-10) flagged that the first cut
// committed the row + pg_notify but never relayed the message to Discord, so
// the reply only existed in the DB and was invisible to humans. The MVP fix
// is a direct Discord REST API call via deliverToDiscord. Pin that
// sendMessage actually awaits the helper, and that the helper is defined.
describe('T6 — `agent-com send` calls outbound Discord delivery', () => {
  test('deliverToDiscord helper is defined', () => {
    expect(CLI_SRC).toMatch(/async function deliverToDiscord\s*\(/)
  })
  test('sendMessage awaits deliverToDiscord with channel_id + threadId + content', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/await deliverToDiscord\s*\(\s*db\s*,\s*state\.channel_id\s*,\s*threadId\s*,\s*content\s*\)/)
  })
  test('deliverToDiscord uses Discord REST API v10 channels endpoint', () => {
    expect(CLI_SRC).toMatch(/discord\.com\/api\/v10\/channels\/\$\{externalId\}\/messages/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T7: HMAC auth metadata is built and stamped into the INSERT
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit (2026-04-10) flagged that CLI-originated
// rows had no metadata.auth, so receivers running with auth.mode === 'enforce'
// dropped them as [UNVERIFIED]. The fix mirrors server.ts:createAuthMetadata
// and folds the result into the INSERT metadata. Pin both the helper and
// the fold-in.
describe('T7 — `agent-com send` builds and stamps HMAC auth metadata', () => {
  test('buildAuthMetadata helper is defined and uses createHmac', () => {
    expect(CLI_SRC).toMatch(/function buildAuthMetadata\s*\(/)
    expect(CLI_SRC).toMatch(/createHmac\s*\(\s*'sha256'/)
  })
  test('sendMessage merges authMeta into the INSERT metadata', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/const authMeta\s*=\s*buildAuthMetadata\(/)
    // The fold can be `...(authMeta ?? {})` or equivalent — assert authMeta
    // is referenced inside the metadata literal.
    expect(body).toMatch(/metadata[\s\S]{0,100}authMeta/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T8: thread_id flows from `next` → state file → INSERT → outbound delivery
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit (2026-04-10) flagged that replies landed
// in the parent channel even when the original message was in a thread,
// because the in-flight state never carried thread_id. Pin the entire chain:
//   (a) `nextMessage` SELECTs thread_id and writes it into the state file
//   (b) `sendMessage` reads thread_id from state and passes it to INSERT
//   (c) `sendMessage` passes the same threadId to deliverToDiscord
function nextMessageBody(): string {
  const fnStart = CLI_SRC.indexOf('async function nextMessage')
  const fnEnd = CLI_SRC.indexOf('\nasync function ', fnStart + 1)
  return CLI_SRC.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
}

describe('T8 — thread_id flows from next → state → send → outbound', () => {
  // Phase 2 (Issue #128) routes thread_id through the message_queue payload
  // for queue mode and through the legacy /tmp state file (written by
  // `nextMessageFromSignal`) for Mixed-Mode signal mode. The intent is the
  // same as Phase 1: the reply must land in the same thread as the original.
  test('next path threads thread_id through queue payload OR signal-mode state file', () => {
    const queueBody = nextMessageBody()
    // Queue mode: payload.thread_id is surfaced on the response.
    expect(queueBody).toMatch(/thread_id:\s*payload\.thread_id\s*\?\?\s*null/)
    // Signal-mode helper still SELECTs thread_id from agent_messages and
    // writes it into the legacy /tmp state file.
    const helperStart = CLI_SRC.indexOf('async function nextMessageFromSignal')
    expect(helperStart).toBeGreaterThan(-1)
    const helperEnd = CLI_SRC.indexOf('\nasync function ', helperStart + 1)
    const helperBody = CLI_SRC.slice(helperStart, helperEnd === -1 ? undefined : helperEnd)
    expect(helperBody).toMatch(/SELECT[^;]*thread_id[^;]*FROM agent_messages/)
    expect(helperBody).toMatch(/thread_id:\s*row\.thread_id/)
  })
  test('sendMessage resolves threadId from target.thread_id (queue or signal)', () => {
    const body = sendMessageBody()
    // Phase 2: the target object carries thread_id from whichever path
    // resolved (queue payload or legacy state file). threadId is bound off
    // target.thread_id, which is itself populated via `?? null` in both
    // resolution branches.
    expect(body).toMatch(/const threadId:\s*string \| null\s*=\s*target\.thread_id/)
    // Both resolution branches MUST default null:
    //   queue:  thread_id: payload.thread_id ?? null
    //   signal: thread_id: state.thread_id ?? null
    expect(body).toMatch(/thread_id:\s*payload\.thread_id\s*\?\?\s*null/)
    expect(body).toMatch(/thread_id:\s*state\.thread_id\s*\?\?\s*null/)
  })
  test('sendMessage INSERTs thread_id (not the literal NULL)', () => {
    const body = sendMessageBody()
    // The INSERT must bind threadId rather than the previous hardcoded NULL.
    expect(body).toMatch(/'agent-comms',\s*\$8,\s*'outbound'/)
    expect(body).toMatch(/JSON\.stringify\(metadata\),\s*threadId/)
    // Negative: the previous shape hardcoded NULL between 'agent-comms' and 'outbound'.
    expect(body).not.toMatch(/'agent-comms',\s*NULL,\s*'outbound'/)
  })
  test('sendMessage passes threadId to deliverToDiscord', () => {
    const body = sendMessageBody()
    expect(body).toMatch(/deliverToDiscord\([^)]*threadId[^)]*\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T9: Discord delivery failure preserves the in-flight state and signal
// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: ARC codex audit follow-up (2026-04-10, msg
// 1492266518673887262) — the previous behavior unconditionally deleted the
// state file and inbox signal after the deliverToDiscord call, so a Discord
// failure left the operator with an orphan DB row and no recoverable handle.
// Fix invariants:
//   (a) failure branch returns BEFORE the unlinkSync calls
//   (b) failure response carries `ok: false`, `db_saved: true`, and a `retry`
//       hint so the caller can branch on the failure
//   (c) the success branch (which DOES unlink) is gated on
//       `deliveryResult.delivered === true`
describe('T9 — Discord delivery failure preserves state file and inbox signal', () => {
  test('sendMessage branches on !deliveryResult.delivered before any unlinkSync', () => {
    const body = sendMessageBody()
    // Find the failure branch start.
    const guardIdx = body.search(/if\s*\(\s*!deliveryResult\.delivered\s*\)/)
    expect(guardIdx).toBeGreaterThan(-1)
    // Phase 2 (Issue #128) renamed the unlink call sites: queue mode no longer
    // touches the filesystem at all (it UPDATEs message_queue + clears
    // current_message_id), and signal-mode unlinks `target.signal_path` /
    // `target.state_path`. Both finalisation paths must live AFTER the guard.
    const finalIdx = body.indexOf('unlinkSync(target.signal_path)')
    expect(finalIdx).toBeGreaterThan(guardIdx)
    // The replied-status UPDATE (queue mode finalisation) must also be after.
    const repliedIdx = body.indexOf("status = 'replied'")
    expect(repliedIdx).toBeGreaterThan(guardIdx)
  })

  test('failure branch reports ok:false, db_saved:true, and a retry hint', () => {
    const body = sendMessageBody()
    // Slice from the guard to the closing process.exit so the regex doesn't
    // accidentally match the success branch's response payload.
    const guardIdx = body.indexOf('if (!deliveryResult.delivered)')
    const exitIdx = body.indexOf('process.exit(1)', guardIdx)
    expect(guardIdx).toBeGreaterThan(-1)
    expect(exitIdx).toBeGreaterThan(guardIdx)
    const failureBranch = body.slice(guardIdx, exitIdx)
    expect(failureBranch).toMatch(/ok:\s*false/)
    expect(failureBranch).toMatch(/db_saved:\s*true/)
    expect(failureBranch).toMatch(/discord_delivered:\s*false/)
    expect(failureBranch).toMatch(/discord_skip_reason:/)
    expect(failureBranch).toMatch(/retry:/)
  })

  test('failure branch exits non-zero (does not fall through to success)', () => {
    const body = sendMessageBody()
    const guardIdx = body.indexOf('if (!deliveryResult.delivered)')
    // The very next process.exit after the guard must be exit(1).
    const tail = body.slice(guardIdx)
    expect(tail).toMatch(/process\.exit\(1\)/)
  })
})
