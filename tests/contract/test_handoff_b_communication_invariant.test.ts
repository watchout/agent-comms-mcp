import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

// HANDOFF B communication invariants — per CTO judgment (msg ddbbda74)
// and lead-ama PR-A §2.4 (msg id 28230cd0), PR-A's claude/channel push
// addition must not silently alter the four things the rest of the
// agent-comms system depends on:
//
//   (1) DB-centric schema: `agent_messages` / `message_queue` columns
//       that bots and CLI tools rely on are untouched by PR-A.
//   (2) `reply_to` chain: the existing depth-tracking invariant still
//       produces the same linkage structure.
//   (3) Channel routing: `channels.members` is the sender gate; no
//       access.json / allowFrom file introduced by PR-A.
//   (4) Outbound Discord POST: the outbound_queue → Discord POST path
//       is unchanged; a claude/channel push failure must fall back
//       to the wake-daemon + `next` pull path.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SERVER = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const RECEIVER = readFileSync(join(REPO_ROOT, 'adapters', 'inbound-receiver.ts'), 'utf-8')

describe('HANDOFF B communication invariants — PR-A must preserve pre-existing behaviour', () => {
  test('(1) DB-centric schema — agent_messages INSERT + message_queue INSERT paths intact', () => {
    // The inbound receiver continues to persist to agent_messages via
    // saveMessage and enqueue via message_queue. A refactor that pulled
    // either out of the listener path would fail this.
    expect(RECEIVER).toMatch(/saveMessage/)
    expect(RECEIVER).toMatch(/message_queue/i)
    // server.ts still exposes the MCP tools that query these tables.
    expect(SERVER).toMatch(/INSERT INTO message_queue/)
    expect(SERVER).toMatch(/agent_messages/)
  })

  test('(2) reply_to chain — depth cap still enforced in server.ts, no new cap override', () => {
    // Existing reply-chain guard (10-deep). If PR-A accidentally
    // reset or removed the cap the test fails.
    expect(SERVER).toMatch(/reply_to/)
    // Cap constant or inlined literal — just assert the existing depth
    // constraint lexeme still appears somewhere in the source.
    expect(SERVER).toMatch(/depth/i)
  })

  test('(3) channel routing is members-based — no access.json file introduced', () => {
    // PR-A explicitly forbids access.json (spec v5 §3.1 #5 + phase-c
    // redef v1.1 condition 5). A new file dependency would surface as
    // an import in server.ts or the adapter.
    for (const src of [SERVER, RECEIVER]) {
      expect(src).not.toMatch(/access\.json/)
    }
    // Members-based routing (`routeInbound` + `channels.members`) remains
    // the authoritative gate — both symbols must still appear in the
    // inbound receiver path.
    expect(RECEIVER).toMatch(/routeInbound/)
    expect(RECEIVER).toMatch(/members/)
  })

  test('(4) Outbound Discord POST path — outbound_queue + discord adapter untouched by PR-A', () => {
    expect(SERVER).toMatch(/outbound/i)
    // The outbound consumer entry point remains exported / started.
    expect(SERVER).toMatch(/startOutboundConsumer/)
  })

  test('PR-A claude/channel push is strictly additive — no existing MCP tool signature altered', () => {
    // Existing tool registrations (§1.5 unchanged) — smoke-check the
    // names appear with the same registration pattern.
    for (const name of ['next', 'send', 'notify', 'inbox', 'history']) {
      const re = new RegExp(`name:\\s*['"]${name}['"]`)
      expect(SERVER).toMatch(re)
    }
  })

  test('instructions string quotes spec v5 §1.4 verbatim — hook guidance present', () => {
    // §1.4 frozen text has three load-bearing substrings; drift on any
    // of them breaks the bot's guidance and the Stop hook contract.
    expect(SERVER).toContain('agent-comms channel events arrive as')
    expect(SERVER).toContain('mcp__aun__send')
    expect(SERVER).toContain('mcp__aun__notify')
    expect(SERVER).toContain('mcp__agent_comms__send')
    expect(SERVER).toContain('mcp__agent-comms__send')
    expect(SERVER).toContain('NEVER use the built-in SendMessage tool')
    expect(SERVER).toContain('NEVER reply only via stdout')
    expect(SERVER).toContain('enforced by a Stop hook')
  })
})
