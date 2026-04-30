#!/usr/bin/env bun
/**
 * Spec-enforcement tests for Issue #130 Phase 4 — legacy push path removal +
 * MCP next tool addition.
 *
 * Background:
 *   Phase 1 (PR#131) added pushToChannelServer + SSE fallback to the send
 *   tool's pushTargets loop. Phase 2 (PR#134) added message_queue INSERT.
 *   Phase 3 (PR#135) moved outbound to outbound_queue. Phase 4 (Issue #130)
 *   removes the legacy push paths entirely — sendInboxSignal, pushToChannelServer,
 *   SSE fallback, channel-server.ts, filesystem signals, Mixed-Mode fallback.
 *
 *   These tests verify the removal is complete and the MCP `next` tool was
 *   added (spec §4.1 MCP surface).
 *
 * See:
 *   - server.ts              (legacy code removed, MCP next added)
 *   - cli/index.ts           (signal fallback removed)
 *   - github.com/watchout/agent-comms-mcp/issues/130
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// T1: Legacy push functions are completely removed from server.ts
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 — Legacy push functions removed from server.ts', () => {
  test('sendInboxSignal function is gone', () => {
    expect(SERVER_SRC).not.toMatch(/function sendInboxSignal\s*\(/)
  })
  test('pushToChannelServer function is gone', () => {
    expect(SERVER_SRC).not.toMatch(/function pushToChannelServer\s*\(/)
  })
  test('clearPushFailureWarning function is gone', () => {
    expect(SERVER_SRC).not.toMatch(/function clearPushFailureWarning\s*\(/)
  })
  test('countAndClearSignals function is gone', () => {
    expect(SERVER_SRC).not.toMatch(/function countAndClearSignals\s*\(/)
  })
  test('pushFailureWarned set is gone', () => {
    expect(SERVER_SRC).not.toMatch(/const pushFailureWarned\s*=/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2: channel-server.ts file is deleted
// ─────────────────────────────────────────────────────────────────────────────
describe('T2 — channel-server.ts is deleted', () => {
  test('channel-server.ts file does not exist', () => {
    expect(existsSync(join(REPO_ROOT, 'channel-server.ts'))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3: CLI legacy fallback code is removed
// ─────────────────────────────────────────────────────────────────────────────
describe('T3 — CLI legacy signal fallback code is removed', () => {
  test('nextMessageFromSignal helper is gone', () => {
    expect(CLI_SRC).not.toMatch(/async function nextMessageFromSignal\s*\(/)
  })
  test('listSignals helper is gone', () => {
    expect(CLI_SRC).not.toMatch(/function listSignals\s*\(/)
  })
  test('inboxDir helper is gone', () => {
    expect(CLI_SRC).not.toMatch(/function inboxDir\s*\(/)
  })
  test('AGENT_COMMS_LEGACY_QUEUE env check is gone', () => {
    expect(CLI_SRC).not.toMatch(/AGENT_COMMS_LEGACY_QUEUE/)
  })
  test('deliverToDiscord helper is gone (Phase 3 removal preserved)', () => {
    expect(CLI_SRC).not.toMatch(/async function deliverToDiscord\s*\(/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4: MCP next tool is registered and handled in server.ts
// ─────────────────────────────────────────────────────────────────────────────
describe('T4 — MCP next tool exists in server.ts (spec §4.1)', () => {
  test('next tool is registered in ListToolsRequestSchema', () => {
    expect(SERVER_SRC).toMatch(/name:\s*'next'/)
  })
  test('next handler dispatches from CallToolRequestSchema', () => {
    expect(SERVER_SRC).toMatch(/if\s*\(\s*name\s*===\s*'next'\s*\)/)
  })
  test('next handler pops from message_queue with FOR UPDATE SKIP LOCKED', () => {
    // Grab the handler body
    const start = SERVER_SRC.indexOf("if (name === 'next')")
    expect(start).toBeGreaterThan(-1)
    const end = SERVER_SRC.indexOf("if (name === 'send')", start)
    expect(end).toBeGreaterThan(start)
    const body = SERVER_SRC.slice(start, end)
    expect(body).toMatch(/FROM message_queue/)
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/)
    // Issue #278 (A) segment 3c — the legacy implicit-skip
    // (status='skipped' UPDATE on the prior current_message_id) is
    // gone; orphan recovery is structurally handled by the claim-TTL
    // sweeper (core/claim-ttl.ts) which flips orphans to
    // status='failed' / failed_reason='IMPLICIT_ABANDON' on a 5 min
    // cadence. The new contract: the next handler never writes
    // status='skipped' synchronously.
    expect(body).not.toMatch(/UPDATE message_queue\s+SET status\s*=\s*'skipped'/)
    // Issue #278 (A) segment 3d — agents.current_message_id is gone.
    // The claim-row UPDATE (claimed_by + claim_expires_at) is now the
    // sole record of the in-flight pointer; the agents UPDATE only
    // flips status='busy'.
    expect(body).not.toMatch(/UPDATE agents SET current_message_id/)
    expect(body).toMatch(/claimed_by\s*=\s*\$1/)
    expect(body).toMatch(/UPDATE agents SET status\s*=\s*'busy'/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5: send tool pushTargets loop writes ONLY to message_queue (no legacy)
// ─────────────────────────────────────────────────────────────────────────────
describe('T5 — send tool pushTargets loop is queue-only (no legacy push)', () => {
  test('pushTargets loop INSERTs into message_queue', () => {
    // Find the pushTargets loop
    const header = 'for (const recipient of delivery.pushTargets) {'
    const start = SERVER_SRC.indexOf(header)
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let i = start + header.length - 1
    for (; i < SERVER_SRC.length; i++) {
      if (SERVER_SRC[i] === '{') depth++
      else if (SERVER_SRC[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    const body = SERVER_SRC.slice(start, i + 1)
    // Must INSERT into message_queue
    expect(body).toMatch(/INSERT INTO message_queue/)
    // Must NOT call legacy push functions
    expect(body).not.toMatch(/sendInboxSignal/)
    expect(body).not.toMatch(/pushToChannelServer/)
    expect(body).not.toMatch(/botContexts\.get/)
    expect(body).not.toMatch(/notifications\/claude\/channel/)
  })
})
