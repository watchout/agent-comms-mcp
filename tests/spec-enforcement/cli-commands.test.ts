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
