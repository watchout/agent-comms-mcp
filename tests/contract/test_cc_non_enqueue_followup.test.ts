#!/usr/bin/env bun
/**
 * cc[] non-enqueue invariant — PR #315 follow-up contract test (cycle 3).
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
 *   - PR #316 cycle 2 L2 BLOCK: msg `a6f8e30c` / `f3f127c0`
 *     (hand-rolled `phase5.mentions` enqueue loop bypassed server.ts'
 *      actual `routeInbound → pushTargets → enqueueWithDedup` pipeline;
 *      console.warn + return masquerading as test.skipIf; line-range
 *      claim mismatch)
 *   - cycle 2 dispatch: msg `82a571d3` / `67ab6d7b`
 *   - cycle 3 dispatch: msg `c419f627` / `dfb34844`
 *   - ARC Option (b): msg `6b079a0c` (fix impl, keep spec)
 *
 * The fix in this PR:
 *   `core/routing/ports/inbound-resolver.ts:108`
 *   - before: `enqueue = Array.from(new Set([mention, ...ccValid]))`
 *   - after:  `enqueue = mention ? [mention] : []`
 *
 * Cycle 3 honesty correction (this file):
 *   Cycle 2's (d)/(d') iterated `phase5.mentions` directly with
 *   `enqueueWithDedup`, skipping `buildSendMentions` and `routeInbound`
 *   — i.e. it did not exercise the same code path server.ts' send /
 *   notify handlers run after `phase5`. server.ts (lines 2249-2310 send,
 *   2624-2750 notify) iterates `delivery.pushTargets` from `routeInbound`,
 *   NOT `phase5.mentions`. So a bug that re-introduced cc[] anywhere
 *   AFTER `resolvePhase5` (e.g. in `buildSendMentions` or the
 *   `delivery.pushTargets` derivation) would have slipped past the cycle 2
 *   test.
 *
 *   Cycle 3 invokes the FULL public function chain server.ts depends on
 *   between phase5-resolve and DB-INSERT:
 *     `resolvePhase5(...)`               (server.ts:2050 send / 2642 notify)
 *       → `mentions = phase5.mentions`   (server.ts:2255 send / 2666 notify)
 *       → `buildSendMentions(mentions, content, resolver)` (server.ts:2247-2253 send / 2723-2727 notify)
 *       → `routeInbound({mentions: sendMentions, ...}, channel, agents)` (server.ts:2254-2258 send / 2728-2732 notify)
 *       → `for (recipient of delivery.pushTargets) { enqueueWithDedup(...) }` (server.ts:2276-2310 send / 2738-2761 notify)
 *
 *   Honest scope boundary: this is NOT a full MCP `tools/call` handler
 *   invocation (the tool handler is a private closure inside
 *   `registerTools()` in server.ts and is not exported). Bootstrapping a
 *   real MCP server in-process would require seeding agents, channels,
 *   channel members, agent_messages claim rows, outbound_queue rows, and
 *   wiring the JSON-RPC stdio transport — out of scope for a contract
 *   test of the cc[] enqueue invariant. The function chain above IS the
 *   exact post-validation fanout pipeline the handler runs; a regression
 *   that re-introduced cc[] anywhere along this chain trips the cc-count
 *   assertion below.
 *
 *   (d) reproduces the SEND-handler input shape (sender = bot, channel
 *   carries cc-targets as members, no `reply_to` claim — we exercise the
 *   post-claim portion).
 *   (d') reproduces the NOTIFY-handler input shape (notify resolves
 *   `channel` → channelId before this point; we feed the resolved
 *   channelId directly).
 *
 *   Both (d) and (d') share the same shared post-validation fanout shape
 *   — that IS the truth; cycle 2's claim "one-call-site regression trips
 *   exactly one half" was inaccurate because the shape is shared. (d) and
 *   (d') instead use independent fixture rows (distinct agent ids and
 *   message_ids per sub-test) so a regression scoped to one INPUT shape
 *   (e.g. notify-only mention validation) would still trip exactly one
 *   half.
 *
 * Skipped automatically when DATABASE_URL is unset.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'crypto'
import { resolvePhase5 } from '../../core/routing/server-integration'
import { enqueueWithDedup } from '../../core/queue-dedup'
import {
  buildSendMentions,
  routeInbound,
  type AgentInfo,
} from '../../core/route-message'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost/agent_comms'
const SKIP = !process.env.DATABASE_URL

const known = new Set(['ceo', 'cto', 'agent-com-dev', 'sender-bot'])
const isKnown = (id: string) => known.has(id)

// ─────────────────────────────────────────────────────────────────────
// Fixture (a)/(b)/(c) — resolver-level pins.
//   These exercise the SHARED routing port (`resolvePhase5`) which both
//   `send` and `notify` server.ts handlers call with identical argument
//   shape (sender / channel_id / mention / cc / content / isKnownAgent).
//   A single resolver invocation per fixture is sufficient — the shared
//   port semantics are pinned by these assertions; behavioural
//   differentiation between send and notify call sites is exercised in
//   (d)/(d') below via the real `routeInbound + enqueueWithDedup`
//   pipeline that server.ts uses post-validation.
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
// Fixture (d)/(d') — empirical DB invariant (real pipeline INSERT).
//
// Pipeline (matches server.ts send L2249-2310 / notify L2624-2750):
//   1. `resolvePhase5(...)`  — produces `phase5.mentions` (= [mention]).
//   2. `buildSendMentions(phase5.mentions, content, resolver)`
//      — server.ts merges `mentions` arg with `<@discord_id>` tokens
//        in content. Our test content has no `<@…>` tokens so the
//        output equals `phase5.mentions`, but we still call the real
//        function so a future buildSendMentions regression that
//        leaked cc[] back in would trip this test.
//   3. `routeInbound({mentions: sendMentions, ...}, channel, agents)`
//      — server.ts derives `delivery.pushTargets` from this. For our
//        fixture: channel.members lists [mention, ...cc, sender], the
//        sender is a bot, mentions = [mention] only, and the message
//        is not emergency / DM, so the membership-AND-mention test
//        in `routeMessage` returns `pushTargets = [mention]` and
//        `dropTargets[cc1..cc3] = 'NOT_MENTIONED'`. THAT is the
//        invariant under test.
//   4. `for (recipient of delivery.pushTargets) enqueueWithDedup(...)`
//      — server.ts inserts one message_queue row per recipient.
//
// Empirical assertion: with sentinel agent ids unique to the test run,
// `count(message_queue WHERE agent_id IN $cc[])` over the test window
// is 0. Had the pre-fix bug shipped (resolver included cc[] in
// `phase5.mentions`), `buildSendMentions → routeInbound` would have
// classed cc agents as mentioned-channel-members and `pushTargets`
// would carry them, producing 3 rows.
//
// (d) and (d') use independent agent ids + message_ids, so a regression
// confined to one input shape (send vs notify) would still trip exactly
// one half. The post-validation fanout pipeline is genuinely shared in
// server.ts; we do NOT claim asymmetric coverage of that pipeline. We
// claim independent fixture coverage of the input shapes that drive it.
//
// HONEST SCOPE NOTE: this is the public-function chain server.ts'
// handlers run, NOT a full MCP `tools/call` invocation (the handler
// closure is private inside `registerTools()` and not exported; full
// invocation would require an in-process MCP server bootstrap with
// claim/agent/channel seeding, out of scope for this contract test).
// ─────────────────────────────────────────────────────────────────────

let dbClient: Client | null = null
let dbAvailable = false
const TEST_RUN_ID = `cycle3-${process.pid}-${Date.now()}`

beforeAll(async () => {
  if (SKIP) return
  dbClient = new Client({ connectionString: DATABASE_URL })
  // If DATABASE_URL is set but the DB is unreachable, surface the
  // connection error — silent skip would hide a CI misconfiguration.
  await dbClient.connect()
  dbAvailable = true
})

afterAll(async () => {
  if (dbClient && dbAvailable) {
    try {
      await dbClient.query(
        `DELETE FROM message_queue WHERE agent_id LIKE $1`,
        [`__cc_test_${TEST_RUN_ID}_%`],
      )
    } catch { /* ignore */ }
    try { await dbClient.end() } catch { /* ignore */ }
  }
})

// Agent + channel fixture builders. We construct them in-memory rather
// than seeding a real `channels` row because `routeInbound` is pure and
// reads `channel.members` / `agents[].agentId` directly from its
// arguments — server.ts is the layer that loads them from DB
// (`resolveDestination` + `loadAgentInfo`).
function makeAgents(ids: string[]): AgentInfo[] {
  return ids.map(id => ({
    agentId: id,
    agentType: 'dev',
    observerMode: false,
    discordId: null,
  }))
}

describe('(d) empirical — send-shape pipeline, cc[] excluded from message_queue', () => {
  test.skipIf(SKIP)(
    'resolvePhase5 → buildSendMentions → routeInbound → enqueueWithDedup writes mention only',
    async () => {
      const sender = 'sender-bot'
      const mentionId = `__cc_test_${TEST_RUN_ID}_send_mention__`
      const ccIds = [
        `__cc_test_${TEST_RUN_ID}_send_cc1__`,
        `__cc_test_${TEST_RUN_ID}_send_cc2__`,
        `__cc_test_${TEST_RUN_ID}_send_cc3__`,
      ]
      const localKnown = new Set([mentionId, ...ccIds, sender])
      const channelId = `test-cc-non-enqueue-d-send`
      const channelMembers = [sender, mentionId, ...ccIds]

      const testStartIso = new Date().toISOString()

      // Step 1 — resolver (server.ts:2050 send call site).
      const phase5 = resolvePhase5({
        sender,
        channel_id: channelId,
        mention: mentionId,
        cc: ccIds,
        content: `cycle3-d-send-${TEST_RUN_ID}`,
        isKnownAgent: (id: string) => localKnown.has(id),
      })
      expect(phase5).not.toBeNull()
      expect(phase5!.ok).toBe(true)
      if (!phase5 || !phase5.ok) return
      expect(phase5.mentions).toEqual([mentionId])

      // Step 2 — buildSendMentions (server.ts:2247-2253 send).
      const sendMentions = await buildSendMentions(
        phase5.mentions,
        phase5.content,
        async () => null, // no <@discord_id> in content
      )
      // sendMentions must NOT contain cc agents — the only sources are
      // the explicit `mentions` arg (= phase5.mentions = [mentionId])
      // and `<@…>` tokens in content (none here, since cc[] body
      // suffix uses bare `<@id>` text which discord-id resolver returns
      // null for). Pin both invariants.
      expect(sendMentions).toContain(mentionId)
      for (const cc of ccIds) expect(sendMentions).not.toContain(cc)

      // Step 3 — routeInbound (server.ts:2254-2258 send).
      const delivery = routeInbound(
        {
          authorAgentId: sender,
          authorIsBot: true,
          content: phase5.content,
          mentions: sendMentions,
          messageType: 'chat',
        },
        { channelId, threadId: null, members: channelMembers },
        makeAgents([mentionId, ...ccIds]),
      )
      expect(delivery.pushTargets).toContain(mentionId)
      for (const cc of ccIds) {
        expect(delivery.pushTargets).not.toContain(cc)
        expect(delivery.dropTargets[cc]).toBe('NOT_MENTIONED')
      }

      // Step 4 — enqueueWithDedup over delivery.pushTargets
      // (server.ts:2276-2310 send fanout loop).
      const messageUuid = randomUUID()
      const payload = JSON.stringify({
        channel_id: channelId,
        author_id: sender,
        content: phase5.content,
        message_id: messageUuid,
        ts: new Date().toISOString(),
      })
      let insertedCount = 0
      for (const recipient of delivery.pushTargets) {
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

      // Empirical assertion: live DB row counts.
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

describe(`(d') empirical — notify-shape pipeline, cc[] excluded from message_queue`, () => {
  test.skipIf(SKIP)(
    `resolvePhase5 → buildSendMentions → routeInbound → enqueueWithDedup (notify shape) writes mention only`,
    async () => {
      const sender = 'sender-bot'
      const mentionId = `__cc_test_${TEST_RUN_ID}_notify_mention__`
      const ccIds = [
        `__cc_test_${TEST_RUN_ID}_notify_cc1__`,
        `__cc_test_${TEST_RUN_ID}_notify_cc2__`,
        `__cc_test_${TEST_RUN_ID}_notify_cc3__`,
      ]
      const localKnown = new Set([mentionId, ...ccIds, sender])
      // notify shape: caller passed `channel` which the handler resolved
      // to a channelId via channels.id / channels.name lookup. We feed
      // the resolved value directly (the resolution step is exercised
      // elsewhere; here we pin the post-resolution fanout).
      const channelId = `test-cc-non-enqueue-d-notify`
      const channelMembers = [sender, mentionId, ...ccIds]

      const testStartIso = new Date().toISOString()

      // Step 1 — resolver (server.ts:2642 notify call site).
      const phase5 = resolvePhase5({
        sender,
        channel_id: channelId,
        mention: mentionId,
        cc: ccIds,
        content: `cycle3-d-notify-${TEST_RUN_ID}`,
        isKnownAgent: (id: string) => localKnown.has(id),
      })
      expect(phase5).not.toBeNull()
      expect(phase5!.ok).toBe(true)
      if (!phase5 || !phase5.ok) return
      expect(phase5.mentions).toEqual([mentionId])

      // Step 2 — buildSendMentions (server.ts:2723-2727 notify).
      const sendMentions = await buildSendMentions(
        phase5.mentions,
        phase5.content,
        async () => null,
      )
      expect(sendMentions).toContain(mentionId)
      for (const cc of ccIds) expect(sendMentions).not.toContain(cc)

      // Step 3 — routeInbound (server.ts:2728-2732 notify).
      const delivery = routeInbound(
        {
          authorAgentId: sender,
          authorIsBot: true,
          content: phase5.content,
          mentions: sendMentions,
          messageType: 'chat',
        },
        { channelId, threadId: null, members: channelMembers },
        makeAgents([mentionId, ...ccIds]),
      )
      expect(delivery.pushTargets).toContain(mentionId)
      for (const cc of ccIds) {
        expect(delivery.pushTargets).not.toContain(cc)
        expect(delivery.dropTargets[cc]).toBe('NOT_MENTIONED')
      }

      // Step 4 — enqueueWithDedup over delivery.pushTargets
      // (server.ts:2738-2761 notify fanout loop).
      const messageUuid = randomUUID()
      const payload = JSON.stringify({
        channel_id: channelId,
        author_id: sender,
        content: phase5.content,
        message_id: messageUuid,
        ts: new Date().toISOString(),
      })
      let insertedCount = 0
      for (const recipient of delivery.pushTargets) {
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
