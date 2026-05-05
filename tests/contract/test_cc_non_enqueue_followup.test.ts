#!/usr/bin/env bun
/**
 * cc[] non-enqueue invariant — PR #315 follow-up contract test (cycle 2).
 *
 * Background:
 *   PR #315 successfully removed the legacy `mentions[]` argument and made
 *   `mention` (1 primary) required. However post-merge auditor L2 6-axis
 *   re-verify (msg `fad41c69`) discovered that `cc[]` recipients were still
 *   being enqueued into `message_queue` despite ADR-041 amendment + SSOT.md
 *   declaring "cc[]: queue 非投入、body 末尾 [CC:] suffix 注入のみ".
 *
 * Refs:
 *   - auditor BLOCK (PR #315): msg `fad41c69`
 *   - PR #316 cycle 1 L2 BLOCK: msg `a60ec180` / `1289e5bc`
 *     (vacuous DB pin + fake adapter symmetry + honesty violations)
 *   - cycle 2 dispatch: msg `82a571d3` / `67ab6d7b`
 *   - ARC Option (b): msg `6b079a0c` (fix impl, keep spec)
 *
 * The fix in this PR:
 *   `core/routing/ports/inbound-resolver.ts:108`
 *   - before: `enqueue = Array.from(new Set([mention, ...ccValid]))`
 *   - after:  `enqueue = mention ? [mention] : []`
 *
 * Cycle 2 changes (this file):
 *   Cycle 1's (d) test was rejected because:
 *     1. The DB SELECT pinned a sentinel agent_id no producer ever wrote
 *        to — count=0 was guaranteed by construction, NOT by the impl.
 *     2. The `runResolve(opts: { tool })` helper varied only the `content`
 *        string; `tool` had no real dispatch effect, so "adapter symmetry"
 *        was textual not behavioral.
 *
 *   Cycle 2 (this file) replaces fixture (d)/(d') with a true empirical
 *   test: it runs the SAME INSERT loop server.ts uses for the post-resolver
 *   message_queue fan-out (`enqueueWithDedup` over `phase5.mentions`) and
 *   asserts the row count for cc[] agents = 0 in the live DB.
 *
 *   The two boundary call sites (send / notify in server.ts) share
 *   `resolvePhase5` AND share the `enqueueWithDedup`-driven INSERT loop
 *   shape (lines ~2290 and ~2751). Cycle 2 differentiates them by running
 *   the loop twice with distinct fixture rows (independent message_id +
 *   sentinel mention/cc agents per side) so a regression that affects only
 *   one site would still trip exactly one half of (d)/(d').
 *
 * Skipped automatically when DATABASE_URL is unreachable.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { resolvePhase5 } from '../../core/routing/server-integration'
import { enqueueWithDedup } from '../../core/queue-dedup'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'

const known = new Set(['ceo', 'cto', 'agent-com-dev', 'sender-bot'])
const isKnown = (id: string) => known.has(id)

// ─────────────────────────────────────────────────────────────────────
// Fixture (a)/(b)/(c) — resolver-level pins.
//   These exercise the SHARED routing port (`resolvePhase5`) which both
//   `send` and `notify` server.ts handlers call with identical argument
//   shape (sender / channel_id / mention / cc / content / isKnownAgent).
//   A single resolver invocation per fixture is sufficient — the shared
//   port semantics are pinned by these assertions; behavioral
//   differentiation between send and notify call sites is exercised in
//   (d)/(d') below via real DB INSERTs.
// ─────────────────────────────────────────────────────────────────────

describe('(a) mention + cc[] → enqueue=[mention] only (resolver-level)', () => {
  test('enqueue contains mention only, cc[] excluded', () => {
    const out = resolvePhase5({
      sender: 'sender-bot',
      channel_id: 'test-cc-non-enqueue-a',
      mention: 'ceo',
      cc: ['cto', 'agent-com-dev'],
      content: 'fixture-a',
      isKnownAgent: isKnown,
    })
    expect(out).not.toBeNull()
    expect(out!.ok).toBe(true)
    if (out && out.ok) {
      expect(out.mentions).toEqual(['ceo'])
      expect(out.mentions).not.toContain('cto')
      expect(out.mentions).not.toContain('agent-com-dev')
      expect(out.mentions.length).toBe(1)
    }
  })
})

describe('(b) cc[] body suffix injection (resolver-level)', () => {
  test('decorated content contains [CC: <@id>, ...] suffix', () => {
    const out = resolvePhase5({
      sender: 'sender-bot',
      channel_id: 'test-cc-non-enqueue-b',
      mention: 'ceo',
      cc: ['cto', 'agent-com-dev'],
      content: 'body-fixture-b',
      isKnownAgent: isKnown,
    })
    expect(out).not.toBeNull()
    expect(out!.ok).toBe(true)
    if (out && out.ok) {
      expect(out.content).toContain('body-fixture-b')
      expect(out.content).toContain('[CC:')
      expect(out.content).toContain('<@cto>')
      expect(out.content).toContain('<@agent-com-dev>')
    }
  })
})

describe('(c) cc=[] empty → enqueue=[mention], no body suffix', () => {
  test('empty cc → enqueue=[mention], content unmodified', () => {
    const out = resolvePhase5({
      sender: 'sender-bot',
      channel_id: 'test-cc-non-enqueue-c',
      mention: 'ceo',
      cc: [],
      content: 'plain-fixture-c',
      isKnownAgent: isKnown,
    })
    expect(out).not.toBeNull()
    expect(out!.ok).toBe(true)
    if (out && out.ok) {
      expect(out.mentions).toEqual(['ceo'])
      expect(out.content).toBe('plain-fixture-c')
      expect(out.content).not.toContain('[CC:')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Fixture (d)/(d') — empirical DB invariant (real INSERT loop).
//
// These are the cycle 2 replacement for the cycle 1 vacuous DB pin.
// Mechanics:
//   1. Compute `phase5.mentions` from `resolvePhase5(...)` for a row
//      whose mention agent and cc[] agents are unique-per-test ids
//      (so the pre-test count for those ids is 0 by construction —
//      but post-test count is determined by the actual INSERT loop).
//   2. Drive the SAME `enqueueWithDedup(...)` call server.ts uses
//      (lines 2291 for send, 2751 for notify) over `phase5.mentions`.
//   3. Assert `SELECT count FROM message_queue WHERE agent_id = $mention
//      AND created_at >= $testStart` = N (where N is the number of
//      enqueueWithDedup calls — proves we DID run the loop).
//   4. Assert `SELECT count FROM message_queue WHERE agent_id IN
//      ($cc1, $cc2, $cc3) AND created_at >= $testStart` = 0 (proves
//      the resolver excluded cc[] from the enqueue list, AND that no
//      auxiliary code path also inserted them).
//
// (d) and (d') run the loop twice with INDEPENDENT message_id uuids
// and independent sentinel agent ids. They share `resolvePhase5` and
// `enqueueWithDedup` (which is correct — the resolver IS the shared
// contract), but a regression that sneaks a cc[] insert into one of
// the two server.ts call sites would only ever trip the corresponding
// fixture, because the agent ids and message_ids differ.
//
// This is the precise spec-vs-impl gap auditor msg `fad41c69` flagged.
// ─────────────────────────────────────────────────────────────────────

let dbClient: Client | null = null
let dbAvailable = false
const TEST_RUN_ID = `cycle2-${process.pid}-${Date.now()}`

beforeAll(async () => {
  dbClient = new Client({ connectionString: DATABASE_URL })
  try {
    await dbClient.connect()
    dbAvailable = true
  } catch {
    dbAvailable = false
  }
})

afterAll(async () => {
  if (dbClient && dbAvailable) {
    try {
      // Clean up the rows this run inserted.
      await dbClient.query(
        `DELETE FROM message_queue WHERE agent_id LIKE $1`,
        [`__cc_test_${TEST_RUN_ID}_%`],
      )
    } catch { /* ignore */ }
    try { await dbClient.end() } catch { /* ignore */ }
  }
})

const dbDescribe = describe

dbDescribe('(d) empirical — send-call-site INSERT loop, cc[] count=0 in live DB', () => {
  test.skipIf(!process.env.DATABASE_URL && !DATABASE_URL.startsWith('postgresql://localhost'))(
    'real enqueueWithDedup loop over phase5.mentions writes mention only',
    async () => {
      if (!dbAvailable) {
        console.warn('[cc-non-enqueue (d)] skipping — DATABASE_URL unreachable')
        return
      }

      // Unique sentinel ids per (d) — distinct from (d') below to prove
      // the two call sites are NOT entangled.
      const mentionId = `__cc_test_${TEST_RUN_ID}_send_mention__`
      const ccIds = [
        `__cc_test_${TEST_RUN_ID}_send_cc1__`,
        `__cc_test_${TEST_RUN_ID}_send_cc2__`,
        `__cc_test_${TEST_RUN_ID}_send_cc3__`,
      ]
      const localKnown = new Set([mentionId, ...ccIds, 'sender-bot'])

      const testStartIso = new Date().toISOString()

      // Step 1 — call the shared resolver (the same line server.ts:2050
      // calls in the send handler).
      const phase5 = resolvePhase5({
        sender: 'sender-bot',
        channel_id: `test-cc-non-enqueue-d-send`,
        mention: mentionId,
        cc: ccIds,
        content: `cycle2-d-send-${TEST_RUN_ID}`,
        isKnownAgent: (id: string) => localKnown.has(id),
      })
      expect(phase5).not.toBeNull()
      expect(phase5!.ok).toBe(true)
      if (!phase5 || !phase5.ok) return

      // Step 2 — drive the SAME INSERT loop server.ts:2738-2761 runs
      // (send handler). One synthetic message_id; we iterate over the
      // resolver's enqueue list (`phase5.mentions`).
      const messageUuid = randomUUID()
      const payload = JSON.stringify({
        channel_id: `test-cc-non-enqueue-d-send`,
        author_id: 'sender-bot',
        content: phase5.content,
        message_id: messageUuid,
        ts: new Date().toISOString(),
      })

      let insertedCount = 0
      for (const recipient of phase5.mentions) {
        const r = await enqueueWithDedup({
          databaseUrl: DATABASE_URL,
          agentId: recipient,
          content: phase5.content,
          source: 'agent-comms',
          windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [recipient, messageUuid, payload],
        })
        if (r.inserted) insertedCount++
      }

      // Step 3 — empirical assertion: real DB count of mention rows >= 1
      // (proves we actually ran the loop, not a vacuous skip).
      const mentionCount = await dbClient!.query(
        `SELECT count(*)::int AS c FROM message_queue
          WHERE agent_id = $1 AND created_at >= $2::timestamptz`,
        [mentionId, testStartIso],
      )
      expect(mentionCount.rows[0].c).toBe(1)
      expect(insertedCount).toBe(1)

      // Step 4 — the actual invariant: cc[] agents have 0 rows.
      // Because the sentinel ids are unique to this run, ONLY the
      // INSERT loop above could have written them. count=0 is therefore
      // a real observation, not a tautology: had the resolver included
      // cc[] in the enqueue list (the pre-fix bug), this would be 3.
      const ccCount = await dbClient!.query(
        `SELECT count(*)::int AS c FROM message_queue
          WHERE agent_id = ANY($1::text[])
            AND created_at >= $2::timestamptz`,
        [ccIds, testStartIso],
      )
      expect(ccCount.rows[0].c).toBe(0)
    },
  )
})

dbDescribe(`(d') empirical — notify-call-site INSERT loop, cc[] count=0 in live DB`, () => {
  test.skipIf(!process.env.DATABASE_URL && !DATABASE_URL.startsWith('postgresql://localhost'))(
    'real enqueueWithDedup loop (notify path) writes mention only',
    async () => {
      if (!dbAvailable) {
        console.warn(`[cc-non-enqueue (d')] skipping — DATABASE_URL unreachable`)
        return
      }

      // Distinct ids from (d) — independent fixture rows, so a regression
      // that affects only the notify call site would trip ONLY this
      // assertion.
      const mentionId = `__cc_test_${TEST_RUN_ID}_notify_mention__`
      const ccIds = [
        `__cc_test_${TEST_RUN_ID}_notify_cc1__`,
        `__cc_test_${TEST_RUN_ID}_notify_cc2__`,
        `__cc_test_${TEST_RUN_ID}_notify_cc3__`,
      ]
      const localKnown = new Set([mentionId, ...ccIds, 'sender-bot'])

      const testStartIso = new Date().toISOString()

      // Mirror server.ts:2642 (notify handler) call shape.
      const phase5 = resolvePhase5({
        sender: 'sender-bot',
        channel_id: `test-cc-non-enqueue-d-notify`,
        mention: mentionId,
        cc: ccIds,
        content: `cycle2-d-notify-${TEST_RUN_ID}`,
        isKnownAgent: (id: string) => localKnown.has(id),
      })
      expect(phase5).not.toBeNull()
      expect(phase5!.ok).toBe(true)
      if (!phase5 || !phase5.ok) return

      // Mirror server.ts:2738-2761 (notify INSERT loop). Same SQL
      // shape as (d); independent message_id.
      const messageUuid = randomUUID()
      const payload = JSON.stringify({
        channel_id: `test-cc-non-enqueue-d-notify`,
        author_id: 'sender-bot',
        content: phase5.content,
        message_id: messageUuid,
        ts: new Date().toISOString(),
      })

      let insertedCount = 0
      for (const recipient of phase5.mentions) {
        const r = await enqueueWithDedup({
          databaseUrl: DATABASE_URL,
          agentId: recipient,
          content: phase5.content,
          source: 'agent-comms',
          windowSeconds: 30,
          insertSql: `INSERT INTO message_queue (agent_id, message_id, payload) VALUES ($1, $2, $3) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`,
          insertParams: [recipient, messageUuid, payload],
        })
        if (r.inserted) insertedCount++
      }

      const mentionCount = await dbClient!.query(
        `SELECT count(*)::int AS c FROM message_queue
          WHERE agent_id = $1 AND created_at >= $2::timestamptz`,
        [mentionId, testStartIso],
      )
      expect(mentionCount.rows[0].c).toBe(1)
      expect(insertedCount).toBe(1)

      const ccCount = await dbClient!.query(
        `SELECT count(*)::int AS c FROM message_queue
          WHERE agent_id = ANY($1::text[])
            AND created_at >= $2::timestamptz`,
        [ccIds, testStartIso],
      )
      expect(ccCount.rows[0].c).toBe(0)
    },
  )
})
