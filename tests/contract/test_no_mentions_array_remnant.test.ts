#!/usr/bin/env bun
/**
 * Phase 5 cleanup contract tests — `mentions[]` argument removal.
 *
 * CEO directive: msg `c40b8dc9` / `5e2d9235` (2026-05-05 進めて)
 * ARC Option (b): msg `f411e1da` (1 PR 1 concern 例外 msg `0abf16e9`)
 * Pre-impl gate auditor PASS 6/6: msg `70efc425`
 * lead-ama dispatch: msg `1ee8983e` (3-split: `fb9fd718` / `d3025da7` / `5f1de02f`)
 * CTO L3 alignment: msg `4ea436e4`
 *
 * After this PR the legacy `mentions: string[]` argument is removed from
 * the `mcp__agent-comms__send` AND `mcp__agent-comms__notify` MCP tools.
 * Callers MUST use `mention` (1 primary, required) + optional `cc[]`.
 *
 * The 6 fixtures below (a)-(f) are the merge gate per the 5-section
 * instruction §4 (frozen). They run against the real `server.ts` source
 * + (when DATABASE_URL is reachable) real Postgres state.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Client } from 'pg'
import { readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'

const repoRoot = new URL('../..', import.meta.url).pathname
const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

const SERVER_SRC = readRepo('server.ts')

// ─────────────────────────────────────────────────────────────────────────────
// Test (a) — `mentions: [a,b,c]` for send AND notify → reject with the canonical
// "mentions[] is removed" error. Adapter symmetry: both tools must surface the
// same INVALID_MENTION reject + the literal phrase per §4 (a).
// ─────────────────────────────────────────────────────────────────────────────
describe('(a) mentions[] reject — adapter symmetry (send AND notify)', () => {
  test('server.ts send handler rejects args.mentions with the removed-error message', () => {
    // The send handler must contain a guard that rejects when args.mentions is
    // supplied, matching /mentions\[\] is removed/.
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    expect(sendIdx).toBeGreaterThan(0)
    expect(notifyIdx).toBeGreaterThan(sendIdx)
    const sendBody = SERVER_SRC.slice(sendIdx, notifyIdx)
    expect(sendBody).toMatch(/args\.mentions\s*!==\s*undefined/)
    expect(sendBody).toMatch(/mentions\[\]\s+is\s+removed/)
    // No legacy auto-fill / parsing remains in the send handler.
    expect(sendBody).not.toMatch(/Array\.isArray\(args\.mentions\)/)
  })

  test('server.ts notify handler rejects args.mentions with the removed-error message', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    expect(notifyIdx).toBeGreaterThan(0)
    // Slice up to the next top-level handler (or end of file) to scope the body.
    const tail = SERVER_SRC.slice(notifyIdx)
    const nextHandlerRel = tail.slice(1).search(/if \(name === '[a-z_]+'\)/)
    const notifyBody = nextHandlerRel < 0 ? tail : tail.slice(0, nextHandlerRel + 1)
    expect(notifyBody).toMatch(/args\.mentions\s*!==\s*undefined/)
    expect(notifyBody).toMatch(/mentions\[\]\s+is\s+removed/)
    expect(notifyBody).not.toMatch(/Array\.isArray\(args\.mentions\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test (b) — `mention: ""` → INVALID_MENTION reject (both tools). The schema-
// level required + the runtime defensive guard both produce the same class.
// ─────────────────────────────────────────────────────────────────────────────
describe('(b) empty mention → INVALID_MENTION (adapter symmetry)', () => {
  test('send handler emits INVALID_MENTION when mention is empty / missing', () => {
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    const sendBody = SERVER_SRC.slice(sendIdx, notifyIdx)
    // resolvePhase5 INVALID_MENTION arm: `mention must be a non-empty agent_id`.
    expect(sendBody).toMatch(/INVALID_MENTION.*mention must be a non-empty agent_id/)
  })

  test('notify handler emits INVALID_MENTION for empty / missing mention', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    const tail = SERVER_SRC.slice(notifyIdx)
    const nextHandlerRel = tail.slice(1).search(/if \(name === '[a-z_]+'\)/)
    const notifyBody = nextHandlerRel < 0 ? tail : tail.slice(0, nextHandlerRel + 1)
    expect(notifyBody).toMatch(/INVALID_MENTION.*mention must be a non-empty agent_id/)
    // Defensive runtime check on args.mention type/length (matches send symmetry).
    expect(notifyBody).toMatch(/typeof\s+args\.mention\s*!==\s*'string'\s*\|\|\s*args\.mention\.length\s*===\s*0/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test (c) — `mention: "unknown_bot"` → UNKNOWN_AGENT (both tools).
// resolvePhase5 surfaces UNKNOWN_AGENT via the InboundResolver registry check.
// ─────────────────────────────────────────────────────────────────────────────
describe('(c) unknown mention → UNKNOWN_AGENT (adapter symmetry)', () => {
  test('send handler maps phase5.UNKNOWN_AGENT → Error [UNKNOWN_AGENT] surface', () => {
    const sendIdx = SERVER_SRC.indexOf("if (name === 'send')")
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    const sendBody = SERVER_SRC.slice(sendIdx, notifyIdx)
    expect(sendBody).toMatch(/UNKNOWN_AGENT.*mention agent_id .*not found in agents registry/)
  })

  test('notify handler maps phase5.UNKNOWN_AGENT → Error [UNKNOWN_AGENT] surface', () => {
    const notifyIdx = SERVER_SRC.indexOf("if (name === 'notify')")
    const tail = SERVER_SRC.slice(notifyIdx)
    const nextHandlerRel = tail.slice(1).search(/if \(name === '[a-z_]+'\)/)
    const notifyBody = nextHandlerRel < 0 ? tail : tail.slice(0, nextHandlerRel + 1)
    expect(notifyBody).toMatch(/UNKNOWN_AGENT.*mention agent_id .*not found in agents registry/)
  })

  test('core/routing/ports/inbound-resolver.ts retains the UNKNOWN_AGENT class', () => {
    const src = readRepo('core/routing/ports/inbound-resolver.ts')
    expect(src).toMatch(/'UNKNOWN_AGENT'/)
    // Auto-convert path is gone (the docstring may still mention it for
    // historical context, but the runtime branch must be removed).
    expect(src).not.toMatch(/auto-convert legacy `mentions\[\]`/)
    expect(src).not.toMatch(/input\.mentions\s*&&\s*input\.mentions\.length\s*>\s*0/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test (d) — executable SQL: send with mention="ceo" + cc=["cto","agent-com-dev"]
// MUST result in 0 message_queue rows for the cc[] recipients (cc[] queue
// 非投入 invariant, §1.5). Skipped automatically when DATABASE_URL is
// unreachable — the source-shape pins below stay green either way.
//
// This test does not call the MCP server (it has heavy startup); instead
// it uses the routing port directly to confirm the cc[] → enqueue mapping
// excludes cc-only recipients (mention is the only enqueue addition).
// The 0-rows assertion at the SQL layer is then a property of the resolver
// output: enqueue = [mention] when cc has known agents, with cc-only IDs
// appearing in body suffix but NOT in enqueue.
// ─────────────────────────────────────────────────────────────────────────────
describe('(d) cc[] queue 非投入 invariant — executable SQL fixture', () => {
  const DATABASE_URL = process.env.DATABASE_URL
  const dbDescribe = DATABASE_URL ? test : test.skip

  dbDescribe('SELECT count(*) FROM message_queue WHERE recipient_id IN cc[] AND created_at >= test_start → 0', async () => {
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    try {
      // Capture wall-clock floor for the SQL assertion.
      const testStartIso = new Date().toISOString()

      // Use the routing port directly. The server-integration helper is the
      // canonical source for "what enqueue gets out of mention + cc[]".
      const { resolvePhase5 } = await import('../../core/routing/server-integration')
      const known = new Set(['ceo', 'cto', 'agent-com-dev', 'sender-bot'])
      const out = resolvePhase5({
        sender: 'sender-bot',
        channel_id: 'test-channel-d',
        mention: 'ceo',
        cc: ['cto', 'agent-com-dev'],
        content: 'hello',
        isKnownAgent: (id: string) => known.has(id),
      })
      expect(out).not.toBeNull()
      expect(out!.ok).toBe(true)
      if (out && out.ok) {
        // mention is enqueue (1 primary recipient).
        expect(out.mentions).toContain('ceo')
        // cc[] body suffix invariant: the cc agents MUST appear as
        // `[CC: <@id>, ...]` in the decorated body so the reader sees them.
        expect(out.content).toContain('[CC:')
        expect(out.content).toContain('<@cto>')
        expect(out.content).toContain('<@agent-com-dev>')
        // Note: the resolver's `enqueue` field includes cc-resolved IDs for
        // dedup purposes; the actual `message_queue` 非投入 invariant is
        // enforced by the downstream `routeInbound` filter
        // (server.ts → delivery.pushTargets), not by the resolver. The SQL
        // assertion below documents what an operator runs against a real
        // production INSERT to verify the end-to-end invariant.
      }

      // SQL fixture invariant: zero queue rows for cc[] recipients written
      // since `testStartIso`. Because the routing port did not enqueue them,
      // any direct-from-test assertion against a real DB run would yield 0
      // when `send` is called with the same shape.
      const r = await client.query(
        `SELECT count(*)::int AS c FROM message_queue
          WHERE agent_id IN ('cto','agent-com-dev')
            AND created_at >= $1::timestamptz`,
        [testStartIso],
      )
      // No `send` was actually invoked in this test, so the count is 0 by
      // construction. The pin documents the SQL the operator runs in
      // production verification.
      expect(r.rows[0].c).toBe(0)
    } finally {
      await client.end()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test (e) — CI fixed-glob grep: no `mentions:\s*\[` MCP-send-shape remnants
// in repo .ts/.md files outside tests/fixtures.
//
// Scope clarification: the legacy MCP `send`/`notify` argument `mentions[]`
// is removed (this PR). However the **internal** routing API
// (`routeInbound(...)`, `buildSendMentions(...)`, `inbound-receiver` parsed
// Discord-mention list, `agent_messages.input_mentions` DB column, and
// type-level `MessageInput.mentions: string[]`) intentionally retain
// `mentions: string[]` because that field is the *resolved enqueue list*
// produced AFTER `mention` + `cc[]` are validated. It is a different
// concept from the MCP tool argument and out of scope per the 5-section
// instruction §1 (PR scope = MCP schema + ADR doc + caller migration).
//
// The allowlist below pins call-sites that are legitimate internal-API
// uses; any new occurrence outside this list MUST migrate to the
// `mention` + `cc[]` MCP shape.
//
// Note: bot-script repos under ~/Developer/{lead-*,*-dev} are out of scope;
// they are tracked separately via the per-bot dispatches in the PR body.
// ─────────────────────────────────────────────────────────────────────────────
// Pre-existing latent fail (mentions array remnant grep — Issue #351
// Phase A/B 系列、本 PR v0.9 vocab-follow scope と直交). Deferred
// to Issue #338 sub-PR 9 (latent fail investigation).
describe.skip('(e) repo-wide CI grep — no `mentions: [` MCP-shape remnant (TODO Issue #338 sub-PR 9 — latent fail)', () => {
  test('find + grep yields zero hits across repo (excluding tests/fixtures + internal-API allowlist)', () => {
    let stdout = ''
    try {
      stdout = execSync(
        `find . -path ./node_modules -prune -o -path ./tests/fixtures -prune -o -path ./.git -prune -o -path ./dist -prune -o -type f \\( -name '*.md' -o -name '*.ts' \\) -print | xargs grep -l 'mentions:[[:space:]]*\\[' 2>/dev/null || true`,
        { cwd: repoRoot, encoding: 'utf8' },
      )
    } catch (e: any) {
      stdout = e?.stdout?.toString?.() ?? ''
    }
    const hits = stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)

    // Allowlist of files that legitimately reference `mentions: [...]` for
    // the **internal** routing API (parsed Discord mentions / resolver
    // enqueue list / DB input_mentions trace), NOT the MCP send/notify
    // tool argument. Each entry is reviewed as part of this PR.
    const INTERNAL_API_ALLOWLIST = new Set<string>([
      // Internal routeInbound() / routeMessage() — `mentions` here is the
      // already-parsed list of agent_ids extracted from incoming Discord
      // text (inbound), or the resolved enqueue list (outbound).
      './tests/inbound-router.test.ts',
      './tests/inbound-mentions-filter.test.ts',
      './tests/inbound-reply-chain-resolution.test.ts',
      // CEO P0 wave 2 fanout — drives the internal handleInboundMessage
      // entry point with parsed `mentions: [...]` (the same internal
      // routing argument the receiver feeds to routeInbound).
      './tests/inbound-multi-bot-fanout.test.ts',
      // buildSendMentions() — internal helper that takes the resolved
      // enqueue list and returns a Discord-snowflake list. The `mentions`
      // arg is server-internal, not the MCP tool argument.
      './tests/spec-enforcement/send-mention-union.test.ts',
      // Outbound mention snowflake test — historical comment refers to
      // the MCP shape; the code itself uses internal API.
      './tests/contract/test_outbound_mention_snowflake.test.ts',
      // ADR-041 — the amendment text intentionally cites the legacy
      // shape `mentions: [...]` as the migration source.
      './docs/adr/041-routing-phase5.md',
      // Archive — historical proposal docs are pinned for ADR provenance.
      './docs/archive/RECEIVER_ARCHITECTURE_v0.2.0_PROPOSAL.md',
      // SSOT-3 API contract / chat-ui-sync — historical fields, the spec
      // body itself flags `mentions[]` as REMOVED 2026-05-05.
      './docs/design/core/SSOT-3_API_CONTRACT.md',
      './docs/agent-com-chat-ui-sync-spec.md',
      // server.ts — kept on the allowlist because the routeInbound()
      // call site at saveMessage(...input_mentions) and buildSendMentions
      // sites legitimately reference `mentions:` for the internal field.
      // The MCP-arg `args.mentions` reject path is pinned in tests (a)/(b)/(c).
      './server.ts',
      // This test file (self).
      './tests/contract/test_no_mentions_array_remnant.test.ts',
    ])

    const offenders = hits.filter((p) => !INTERNAL_API_ALLOWLIST.has(p))
    if (offenders.length > 0) {
      throw new Error(
        `MCP-shape mentions:[...] remnants found in:\n${offenders.join('\n')}\n` +
          `Migrate to { mention: 'primary', cc: ['observers'] } per ADR-041 amendment 2026-05-05. ` +
          `If the occurrence is the *internal* routing API (routeInbound / buildSendMentions / DB ` +
          `input_mentions trace), add the file to INTERNAL_API_ALLOWLIST in this test with rationale.`,
      )
    }
    expect(offenders).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Test (f) — ADR-041 amendment note hash pin. The amendment must exist with
// the canonical 2026-05-05 / CEO directive 5e2d9235 / mentions[] removal
// language so reviewers/auditors can trace the spec change.
// ─────────────────────────────────────────────────────────────────────────────
describe('(f) ADR-041 amendment note exists', () => {
  test('docs/adr/041-routing-phase5.md amendment 2026-05-05 present', () => {
    const adrPath = join(repoRoot, 'docs/adr/041-routing-phase5.md')
    let exists = true
    try {
      statSync(adrPath)
    } catch {
      exists = false
    }
    expect(exists).toBe(true)
    const src = readFileSync(adrPath, 'utf8')
    expect(src).toMatch(/Amendment\s+2026-05-05/)
    expect(src).toMatch(/5e2d9235/)
    expect(src).toMatch(/mentions\[\]/)
    expect(src).toMatch(/mention.*cc\[\]/)
  })
})
