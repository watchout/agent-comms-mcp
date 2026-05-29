#!/usr/bin/env bun
/**
 * spec §4.1 / §11 — Phase C v2.1.0 fail / skip / reclaim / implicit-fail /
 * DISCORD_MAX truncate source + dispatch pins.
 *
 * Live DB-backed integration tests are out of scope for this PR (the existing
 * CLI tests treat DB-backed paths as post-merge verification). Instead this
 * file pins the contract at three layers:
 *
 *   1. CLI source — the handlers, flags, and dispatch branches exist
 *   2. MCP tools — server.ts registers the new tools + handles them
 *   3. Pure truncate helper — unit-tests the 1900-char cap
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { truncateForDiscord, DISCORD_MAX } from '../core/truncate'

const REPO_ROOT = join(import.meta.dir, '..')
const CLI_SRC = readFileSync(join(REPO_ROOT, 'cli', 'index.ts'), 'utf-8')
const SERVER_SRC = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const MIGRATE_PG = readFileSync(join(REPO_ROOT, 'db', 'migrate.ts'), 'utf-8')
const MIGRATE_SQLITE = readFileSync(join(REPO_ROOT, 'db', 'migrate-sqlite.ts'), 'utf-8')

// ─────────────────────────────────────────────────────────────────────────────
// T1 — DB migration: failed_reason/done_at + extended CHECK
// ─────────────────────────────────────────────────────────────────────────────
describe('T1 — message_queue failed_reason/done_at + failed status (PG + SQLite)', () => {
  test('PG migrate.ts adds failed_reason TEXT column (idempotent)', () => {
    expect(MIGRATE_PG).toContain('ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT')
  })
  test('PG migrate.ts swaps status CHECK to the v0.9 8-value union', () => {
    // Issue #338 / CEO 2026-05-14 hotfix: the DO block swaps the
    // constraint to the additive 8-value union (legacy v0.8 + new v0.9
    // states). Pin both the drop and the new union literal.
    expect(MIGRATE_PG).toMatch(/DROP CONSTRAINT message_queue_status_check/)
    expect(MIGRATE_PG).toMatch(/CHECK \(status IN \('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'\)\)/)
  })
  test('PG CREATE TABLE message_queue carries the v0.9 8-value CHECK + failed_reason', () => {
    // New DBs should get the v0.9 hotfix shape from the initial CREATE.
    expect(MIGRATE_PG).toMatch(/CHECK \(status IN \('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'\)\)/)
    expect(MIGRATE_PG).toMatch(/failed_reason TEXT\s+--\s+v2\.1\.0/)
  })
  test('SQLite CREATE TABLE message_queue carries the v0.9 8-value CHECK + failed_reason', () => {
    expect(MIGRATE_SQLITE).toMatch(/CHECK \(status IN \('pending', 'read', 'received', 'in_progress', 'done', 'replied', 'skipped', 'failed'\)\)/)
    expect(MIGRATE_SQLITE).toContain('failed_reason TEXT')
    expect(MIGRATE_SQLITE).toContain('done_at TEXT')
  })
  test('SQLite migration idempotently adds failed_reason/done_at to older DBs', () => {
    // SQLite lacks ALTER TABLE ADD COLUMN IF NOT EXISTS; the migration checks
    // PRAGMA table_info first. Pin that shape so a refactor doesn't drop it.
    expect(MIGRATE_SQLITE).toContain(`PRAGMA table_info(message_queue)`)
    expect(MIGRATE_SQLITE).toMatch(/ALTER TABLE message_queue ADD COLUMN failed_reason TEXT/)
    expect(MIGRATE_SQLITE).toMatch(/ALTER TABLE message_queue ADD COLUMN done_at TEXT/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T2 — CLI handlers + dispatch
// ─────────────────────────────────────────────────────────────────────────────
describe('T2 — cli/index.ts fail / skip / reclaim handlers + dispatch', () => {
  test('failMessage / skipMessage / reclaimMessages handlers are defined', () => {
    expect(CLI_SRC).toMatch(/async function failMessage\s*\(/)
    expect(CLI_SRC).toMatch(/async function skipMessage\s*\(/)
    expect(CLI_SRC).toMatch(/async function reclaimMessages\s*\(/)
  })

  test(`'fail' command dispatches to failMessage(...)`, () => {
    expect(CLI_SRC).toMatch(/command === 'fail'[\s\S]{0,200}?failMessage\(/)
  })
  test(`'skip' command dispatches to skipMessage(...)`, () => {
    expect(CLI_SRC).toMatch(/command === 'skip'[\s\S]{0,200}?skipMessage\(/)
  })
  test(`'reclaim' command dispatches to reclaimMessages(...)`, () => {
    expect(CLI_SRC).toMatch(/command === 'reclaim'[\s\S]{0,200}?reclaimMessages\(/)
  })

  test('fail/skip share a transactional helper that sets status + close evidence + idles the agent', () => {
    // Anchor on the shared helper so a future refactor that splits them
    // doesn't silently drop the transactional invariants (status update →
    // agent idle → COMMIT). Issue #278 segment 3d: the legacy
    // current_message_id WHERE filter is gone, the agent idle flip is
    // unconditional once the message_queue UPDATE matched a row.
    expect(CLI_SRC).toMatch(/async function failOrSkipMessage/)
    expect(CLI_SRC).toMatch(/SET status = \$1,\s*failed_reason = \$2,\s*done_at = now\(\)/)
    expect(CLI_SRC).toMatch(/claimed_by = NULL,\s*claimed_at = NULL,\s*claim_expires_at = NULL/)
    expect(CLI_SRC).not.toMatch(/current_message_id = NULL/)
  })

  test('reclaim uses the 15-minute cutoff + idles the agent', () => {
    expect(CLI_SRC).toMatch(/INTERVAL '15 minutes'/)
    expect(CLI_SRC).toMatch(/reclaimed_count/)
    // Issue #278 segment 3d — agents.current_message_id is gone; the
    // reclaim path no longer references it.
    expect(CLI_SRC).not.toMatch(/UPDATE agents[\s\S]{0,200}?current_message_id = NULL/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T3 — §4.1 implicit-skip renamed to implicit-fail (CLI + server)
// ─────────────────────────────────────────────────────────────────────────────
// v0.9 (sub-PR 1 #347 + sub-PR 7): 'failed' status + 'failed_reason'
// column removed. The IMPLICIT_ABANDON write that this block pins on
// core/claim-ttl.ts is gone. Abandonment-tracking redesign is
// deferred to Issue #349; T3 will be rewritten against the new
// taxonomy when that lands.
describe.skip('T3 — §4.1 implicit abandon (deferred to Issue #349)', () => {
  test('IMPLICIT_ABANDON is emitted by the claim-TTL sweeper only (Issue #278 segment 3d)', () => {
    // The legacy in-line implicit-abandon UPDATE was hosted in
    // cli/index.ts nextMessage and server.ts next handler. Both are
    // gone post-segment-3c/3d; the sole writer of the
    // 'IMPLICIT_ABANDON' SQL is now core/claim-ttl.ts.
    expect(CLI_SRC).not.toMatch(/SET status = 'failed', failed_reason = 'IMPLICIT_ABANDON'/)
  })
  test('IMPLICIT_ABANDON is emitted by the claim-TTL sweeper, not the server.ts next handler', () => {
    // Issue #278 (A) segment 3c — the legacy priorId implicit-skip path
    // has moved out of the MCP server next handler into the periodic
    // claim-TTL sweeper (core/claim-ttl.ts). The IMPLICIT_ABANDON write
    // still exists, but in a different file; assertions that pinned it
    // to server.ts must follow the move. The sweeper pattern uses a
    // multi-line UPDATE (status='failed', failed_reason=$1 with a
    // claim_expires_at predicate) so the original single-line regex no
    // longer matches; we pin the new shape directly on the sweeper module.
    const claimTtlSrc = readFileSync(join(REPO_ROOT, 'core/claim-ttl.ts'), 'utf-8')
    expect(claimTtlSrc).toMatch(/SET status = 'failed', failed_reason = \$1/)
    expect(claimTtlSrc).toMatch(/IMPLICIT_ABANDON/)
    // Negative pin: server.ts next handler must not have re-introduced
    // the synchronous IMPLICIT_ABANDON UPDATE. The sweeper is the only
    // path now. We pin on the SQL shape rather than the bare keyword
    // so explanatory comments referencing the failure code do not
    // accidentally trip the assertion.
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const nextIdx = SERVER_SRC.indexOf("if (name === 'next')")
    const nextHandler = SERVER_SRC.slice(nextIdx, sendIdx === -1 ? SERVER_SRC.length : sendIdx)
    expect(nextHandler).not.toMatch(/SET status = 'failed', failed_reason = 'IMPLICIT_ABANDON'/)
  })
  test('legacy implicit status="skipped" write is gone', () => {
    // Negative pin: the old code wrote status='skipped' under the exact phrase
    // "UPDATE message_queue SET status = 'skipped'". If a refactor brings it
    // back (e.g. reverting 1 line), this catches it.
    expect(CLI_SRC).not.toMatch(/UPDATE message_queue SET status = 'skipped'\s+WHERE id/)
    expect(SERVER_SRC).not.toMatch(/UPDATE message_queue SET status = 'skipped' WHERE id/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T4 — MCP tools: fail / skip / reclaim
// ─────────────────────────────────────────────────────────────────────────────
describe('T4 — server.ts MCP tools: fail / skip / reclaim', () => {
  test('tool list registers fail (deprecated) and reclaim; skip is removed (sub-PR 3)', () => {
    expect(SERVER_SRC).toMatch(/name: 'fail'/)
    expect(SERVER_SRC).toMatch(/name: 'reclaim'/)
    // sub-PR 3 (v0.9 spec §1.3): skip tool fully removed; CC fanout was its
    // sole caller and CC is removed in v0.9. Registration must be absent.
    expect(SERVER_SRC).not.toMatch(/name: 'skip'/)
  })

  test('CallToolRequestSchema branches: fail (deprecated) + reclaim; combined fail||skip handler removed', () => {
    expect(SERVER_SRC).toMatch(/if \(name === 'fail'\)/)
    expect(SERVER_SRC).toMatch(/if \(name === 'reclaim'\)/)
    // sub-PR 3: the legacy `name === 'fail' || name === 'skip'` combined
    // branch is removed in favor of a fail-only no-op deprecation shim.
    expect(SERVER_SRC).not.toMatch(/if \(name === 'fail' \|\| name === 'skip'\)/)
  })

  test('fail tool is a no-op deprecation shim (sub-PR 3): returns deprecated:true without DB write', () => {
    const failIdx = SERVER_SRC.indexOf("if (name === 'fail')")
    expect(failIdx).toBeGreaterThan(-1)
    const reclaimIdx = SERVER_SRC.indexOf("if (name === 'reclaim')", failIdx)
    const handler = SERVER_SRC.slice(failIdx, reclaimIdx === -1 ? SERVER_SRC.length : reclaimIdx)
    // No DB write — must not contain UPDATE message_queue / UPDATE agents.
    expect(handler).not.toMatch(/UPDATE message_queue/)
    expect(handler).not.toMatch(/UPDATE agents/)
    // No status enum literal write — the v0.9 CHECK constraint would trip on
    // any failed/skipped/read attempt and crash the fleet (2026-05-13 PR #347
    // incident anchor).
    expect(handler).not.toMatch(/SET status = \$1, failed_reason = \$2/)
    // Returns the deprecation marker.
    expect(handler).toMatch(/deprecated:\s*true/)
  })

  test('reclaim handler uses 15-minute cutoff + returns reclaimed_queue_ids', () => {
    expect(SERVER_SRC).toMatch(/INTERVAL '15 minutes'/)
    expect(SERVER_SRC).toMatch(/reclaimed_queue_ids/)
  })

  test('reclaim handler clears claim ownership when resetting rows to pending', () => {
    const reclaimIdx = SERVER_SRC.indexOf("if (name === 'reclaim')")
    const handler = SERVER_SRC.slice(reclaimIdx, SERVER_SRC.indexOf('\n  if (name ===', reclaimIdx + 1) === -1 ? SERVER_SRC.length : SERVER_SRC.indexOf('\n  if (name ===', reclaimIdx + 1))
    expect(handler).toMatch(/SET status = 'pending',\s*read_at = NULL,\s*claimed_by = NULL,\s*claimed_at = NULL,\s*claim_expires_at = NULL/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T5 — DISCORD_MAX truncate helper + call-site pins
// ─────────────────────────────────────────────────────────────────────────────
describe('T5 — truncateForDiscord (DISCORD_MAX=1900)', () => {
  test('DISCORD_MAX is 1900 per spec §5.3', () => {
    expect(DISCORD_MAX).toBe(1900)
  })

  test('identity for content under the cap', () => {
    const msg = 'x'.repeat(1900)
    expect(truncateForDiscord(msg)).toBe(msg)
    expect(truncateForDiscord('hello').length).toBe(5)
  })

  test('clamps over-length content with [truncated] suffix', () => {
    const msg = 'x'.repeat(2500)
    const out = truncateForDiscord(msg)
    expect(out.length).toBeLessThanOrEqual(1900)
    expect(out.endsWith('... [truncated]')).toBe(true)
    // Head should be preserved (no leading chars dropped).
    expect(out.startsWith('xxxxx')).toBe(true)
  })

  test('multibyte-safe (JS slice indexes by UTF-16 code unit)', () => {
    const base = 'あ'.repeat(2000) // 2000 multi-byte chars, 2000 UTF-16 code units
    const out = truncateForDiscord(base)
    // 1900 - 15-char suffix = 1885 leading chars + suffix
    expect(out.length).toBe(1900)
    expect(out.endsWith('... [truncated]')).toBe(true)
  })
})

describe('T5b — CLI + server outbound_queue INSERTs route through truncateForDiscord', () => {
  test('cli/index.ts imports + uses truncateForDiscord before outbound_queue INSERT', () => {
    expect(CLI_SRC).toContain(`import { truncateForDiscord } from '../core/truncate'`)
    // send + notify both feed the INSERT via truncateForDiscord(...) while
    // preserving canonical author and the adapter-owner consumer key. The
    // display-only projection decorator may wrap content before truncation.
    expect(CLI_SRC).toContain('decorateProjectedContent')
    expect(CLI_SRC).toMatch(
      /\[\s*id,\s*agentId,\s*projection\.consumerAgentId,\s*projection\.consumerEvidence\?\.connector_instance_id\s*\?\?\s*null,\s*projection\.consumerEvidence\?\.channel_binding_id\s*\?\?\s*null,\s*projection\.projectionIdentityId,\s*projection\.intendedProjectionIdentityId,\s*projection\.projectionSource,\s*projection\.projectionFallbackReason,\s*discordExternalId,\s*truncateForDiscord\(decorateProjectedContent\(/,
    )
  })

  test('server.ts imports + uses truncateForDiscord on outbound_queue INSERT', () => {
    expect(SERVER_SRC).toContain(`import { truncateForDiscord } from './core/truncate'`)
    // Both INSERT sites (send tool + notify tool) should use truncateForDiscord.
    const matches = SERVER_SRC.match(/truncateForDiscord\(partContent\)/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})
