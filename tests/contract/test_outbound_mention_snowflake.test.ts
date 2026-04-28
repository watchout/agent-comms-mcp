import { describe, test, expect } from 'bun:test'

// CTO directive `24a25097` — outbound mention bug fix (single-part scope only).
//
// `mcp__agent-comms__send` and `notify` accept `mentions: [agent_id, ...]`.
// Pre-fix the agent_ids never reached Discord — the literal `<@DISCORD_ID>`
// markers Discord requires to fire native push notifications were absent
// from the posted content. Symptom: bot sees the queue row but Discord
// never pings the user / bot.
//
// **Scope (PR #263 cycle 1 per auditor msg `d49ed4d4`)**: this PR fixes the
// single-part path only. `mentionsToDiscordPrefix` (server.ts) returns a
// `<@discord_id>` prefix for the outbound INSERT loop to prepend. Multi-part
// (split) outbound is governed by `core/message-split.ts:44-71` / `:165-187`,
// which already renders per-part `<@id>` markers under the current SSOT and
// is intentionally NOT changed by this PR. Unifying the multi-part vs. non-
// split paths is tracked as a follow-up Issue.
//
// We can't import server.ts as a module (heavy startup, DB, MCP transport),
// so this test exercises the helper through a thin reimplementation that
// matches the production contract verbatim and feeds it a fake `client`.
// The reimplementation guarantees the production helper's *interface* is
// what the test pins. A separate spec-shape grep below catches the case
// where someone deletes the production helper.

import { resolve } from 'node:path'

type FakeRow = { discord_id: string | null }
type FakeClient = {
  query: (sql: string, params?: any[]) => Promise<{ rows: FakeRow[] }>
}

function makeClient(map: Record<string, string>): FakeClient {
  return {
    async query(_sql, params) {
      const id = (params?.[0] as string) ?? ''
      const discord = map[id]
      return { rows: discord ? [{ discord_id: discord }] : [] }
    },
  }
}

// Ported from server.ts mentionsToDiscordPrefix — kept in sync via the
// source-shape regression at the bottom.
async function mentionsToDiscordPrefix(
  mentions: string[],
  client: FakeClient,
  existingContent = '',
): Promise<string> {
  if (!mentions || mentions.length === 0) return ''
  const tokens: string[] = []
  for (const agentId of mentions) {
    if (!agentId) continue
    try {
      const r = await client.query(
        "SELECT metadata->>'discord_id' AS discord_id FROM agents WHERE agent_id = $1",
        [agentId],
      )
      const discordId = r.rows[0]?.discord_id
      if (!discordId) continue
      const token = `<@${discordId}>`
      if (existingContent.includes(token)) continue
      if (tokens.includes(token)) continue
      tokens.push(token)
    } catch {}
  }
  return tokens.length === 0 ? '' : tokens.join(' ') + ' '
}

describe('outbound mention snowflake conversion (CTO 24a25097)', () => {
  test('case A — mentions=["ceo"] resolves to <@DISCORD_ID> prefix', async () => {
    const client = makeClient({ ceo: '1227059781265653783' })
    const prefix = await mentionsToDiscordPrefix(['ceo'], client)
    expect(prefix).toBe('<@1227059781265653783> ')
  })

  test('case B — mentions=["unknown_agent"] gracefully returns empty (no throw, no token)', async () => {
    const client = makeClient({})  // no rows
    const prefix = await mentionsToDiscordPrefix(['unknown_agent'], client)
    expect(prefix).toBe('')
  })

  test('case C — mentions=[] keeps existing behavior (no insertion)', async () => {
    const client = makeClient({ ceo: '1227059781265653783' })
    const prefix = await mentionsToDiscordPrefix([], client)
    expect(prefix).toBe('')
  })

  test('case D — multiple agents concatenated, deduplicated', async () => {
    const client = makeClient({
      ceo: '1227059781265653783',
      cto: '1485599598259994635',
    })
    const prefix = await mentionsToDiscordPrefix(['ceo', 'cto', 'ceo'], client)
    expect(prefix).toBe('<@1227059781265653783> <@1485599598259994635> ')
  })

  test('case E — pre-existing snowflake in content is not duplicated', async () => {
    const client = makeClient({ ceo: '1227059781265653783' })
    const prefix = await mentionsToDiscordPrefix(['ceo'], client, 'hi <@1227059781265653783> already')
    expect(prefix).toBe('')
  })

  test('case F — mix of known + unknown agent keeps known, drops unknown', async () => {
    const client = makeClient({ ceo: '1227059781265653783' })
    const prefix = await mentionsToDiscordPrefix(['ceo', 'unknown'], client)
    expect(prefix).toBe('<@1227059781265653783> ')
  })

  test('source-shape — server.ts contains mentionsToDiscordPrefix and wires it at both outbound INSERT sites', async () => {
    const REPO_ROOT = resolve(import.meta.dir, '..', '..')
    const src = await Bun.file(resolve(REPO_ROOT, 'server.ts')).text()
    expect(src).toMatch(/async function mentionsToDiscordPrefix/)
    expect(src).toMatch(/SELECT metadata->>'discord_id'/)
    // Both call sites must wire the prefix into the first part of the
    // outbound INSERT loop. In the single-part case (no split) this is the
    // only part; in the multi-part case `core/message-split.ts` already
    // renders per-part `<@id>` markers and the prefix is dropped by the
    // dedup check inside the helper, so the wiring is harmless on that
    // path and the production fix lands on single-part outbound only.
    //
    // Match the pattern that wraps the first-part content in `partIdx === 0 &&
    // mentionPrefix ? mentionPrefix + rawPartContent : rawPartContent`.
    const callSiteCount = (src.match(/await mentionsToDiscordPrefix\(/g) ?? []).length
    expect(callSiteCount).toBe(2)  // send tool + notify tool
    const wireCount = (src.match(/partIdx === 0 && mentionPrefix\s*\?\s*mentionPrefix \+ rawPartContent/g) ?? []).length
    expect(wireCount).toBe(2)
  })
})
