# ADR-040 D1–D4 Implementation Sketches

> Author: agent-com-dev
> Date: 2026-04-08
> Status: Sketch (pending CEO approval of ADR-040)
> Source: `tech-lead/docs/decisions/active/040-mention-validation-cascade-failure.md`
> Authority: CTO will issue formal task tickets after CEO approves ADR-040

These are first-draft implementation outlines for the four hardening items called out in ADR-040 (mention-validation cascade failure postmortem). Each is intentionally small and independent so they can ship as separate PRs without coupling.

Order of attack (smallest blast radius first): **D1 → D2 → D4 → D3**.

D3 (CI strengthening) is last because the patterns it codifies are easier to design after D1/D2/D4 land — the CI checks should reflect the kind of validation that just got added.

---

## D1 — Bot 起動時 Discord ID 自己登録

**Goal**: every per-bot Discord client, on Gateway `ready`, writes its own Discord user ID into `agents.metadata.discord_id` so the database is the authoritative source instead of an external maintenance script.

**Why**: Today's incident root cause was `agents.metadata.discord_id` being NULL for some bots, which broke `routeInbound` because it could not resolve sender → agent_id. The bot itself is the only entity that knows its own Discord identity at the time it connects — registering it from inside the `ready` handler closes the gap permanently.

**Code sketch** — `adapters/discord.ts`:

Current code at line 350:

```ts
this.client.once('ready', (c) => {
  process.stderr.write(`discord-adapter: connected as ${c.user.tag}\n`)
})
```

Proposed:

```ts
this.client.once('ready', async (c) => {
  process.stderr.write(`discord-adapter: connected as ${c.user.tag}\n`)

  // D1: self-register Discord identity
  if (this.agentId) {
    try {
      const db = await tryGetDb()
      if (db) {
        await db.query(
          `UPDATE agents
              SET metadata = COALESCE(metadata, '{}'::jsonb)
                           || jsonb_build_object('discord_id', $1::text)
            WHERE agent_id = $2
              AND COALESCE(metadata->>'discord_id', '') <> $1::text`,
          [c.user.id, this.agentId]
        )
        process.stderr.write(
          `discord-adapter: self-registered discord_id=${c.user.id} for agent=${this.agentId}\n`
        )
      }
    } catch (err) {
      process.stderr.write(`discord-adapter: self-register failed (non-fatal): ${err}\n`)
    }
  }
})
```

The conditional `WHERE COALESCE(metadata->>'discord_id', '') <> $1::text` makes the UPDATE idempotent and silent on every restart after the first.

**Constructor**: the adapter must know its `agentId`. The current `DiscordAdapter` is constructed per-bot in the daemon at `connectBotDiscord(botId, ...)`; pass `botId` into the constructor and store as `this.agentId`. One small change to the constructor signature, one line in each call site.

**Tests**:
- `tests/discord-adapter.test.ts` — add a unit test that mocks the `Client.ready` event and asserts the UPDATE call shape (already has discord-adapter tests; extend that pattern)
- Integration test in `tests/inbound-router.test.ts` — set `metadata.discord_id` to NULL, simulate ready, assert the row is updated

**Estimate**: ~30 lines code + ~40 lines test. 1 PR.

---

## D2 — `bot_status` / `watchdog_check` identity integrity check

**Goal**: surface mismatches between `EXPECTED_BOTS`, the running tmux/MCP processes, and `agents.metadata.discord_id` so the next "discord_id is NULL" incident is detected before it cascades.

**What to add to `bot_status`** (`server.ts:2347`):

For each bot in `EXPECTED_BOTS`, report:

| Field | Source | Healthy state |
|-------|--------|---------------|
| `tmux_session_alive` | existing check | true |
| `port_listening` | existing check | true |
| `agent_row_exists` | `SELECT 1 FROM agents WHERE agent_id = $1` | true |
| **`discord_id_set`** | `metadata->>'discord_id' IS NOT NULL` | **true (new)** |
| **`discord_id_matches_token`** | compare `metadata->>'discord_id'` against the user ID returned by `users/@me` for that bot's token | **true (new)** |

The `discord_id_matches_token` check is the strongest one — it catches the exact failure mode from today (bot token belongs to one Discord user, `agents` row says it's a different user).

**What to add to `watchdog_check`** (`server.ts:2365`):

Same five fields. If any per-bot row has a `false`, the watchdog reports `degraded` and (optionally with `--auto-fix`) writes the corrected `discord_id` from `users/@me` and logs the discrepancy to `audit_log` with `code: IDENTITY_MISMATCH`.

**Code sketch** — token → discord user ID resolution helper:

```ts
async function fetchDiscordUserId(token: string): Promise<string | null> {
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    })
    if (!r.ok) return null
    const body = await r.json() as { id: string }
    return body.id ?? null
  } catch {
    return null
  }
}
```

Call once per bot in `bot_status` / `watchdog_check`. Cache the result for the duration of the call (don't hammer Discord on every probe).

**Tests**:
- `tests/per-bot-discord.test.ts` likely the right home — add a case where `metadata.discord_id` is intentionally wrong and verify watchdog reports `IDENTITY_MISMATCH`

**Estimate**: ~80 lines + ~60 test lines. 1 PR.

---

## D3 — 配信判定 PR の CI 強化

**Goal**: prevent another PR#87-#90 cascade by blocking changes to the routing/delivery code paths unless they pass an expanded checklist.

**Three layers**:

### D3.1 — Required test surface for routing changes

A new CI job runs whenever a PR touches any of:

```
server.ts (lines containing routeInbound, handleInboundMessage, resolveSendDestination,
           or the send tool handler)
core/route-message.ts        (after PR-A lands)
core/route-message-db.ts     (after PR-A lands)
adapters/discord.ts          (lines containing onMessage or routeInbound caller)
```

The job runs:
- Full `bun test tests/`
- An `npm-run-all`-style explicit list of routing-relevant test files (so a test deletion is detected)
- A new `tests/regression/cascade-coverage.test.ts` that asserts each of the 6 layers from ADR-040 has at least one test (source-level grep against the test files)

### D3.2 — Caller grep check

A pre-merge script greps the codebase for callers of any function whose signature is being changed. Implementation:

```bash
# scripts/check-routing-callers.sh
set -e
SYMBOLS="routeInbound handleInboundMessage resolveSendDestination resolveDestination getMessageById"
for sym in $SYMBOLS; do
  COUNT=$(rg -c "\\b${sym}\\b" --type ts | wc -l)
  echo "${sym}: ${COUNT} call sites"
done
```

The PR description must reference each call site count. Reviewer enforces by checklist.

### D3.3 — PR description template

`.github/PULL_REQUEST_TEMPLATE.md` gets a new section that PRs touching routing **must** fill in:

```markdown
## Routing impact (required if PR touches server.ts routing or core/route-message.ts)

- [ ] Functions changed: <list>
- [ ] Caller count per function (run `scripts/check-routing-callers.sh`):
- [ ] Test coverage for each of the 6 cascade layers (ADR-040):
  - [ ] L1 (Discord push delivery)
  - [ ] L2 (mention parsing)
  - [ ] L3 (routeInbound filtering)
  - [ ] L4 (destination resolution)
  - [ ] L5 (send-tool member check)
  - [ ] L6 (response handler)
- [ ] Manual round-trip verified locally
```

**Estimate**: ~150 lines (script + template + workflow yaml + cascade-coverage test). 1 PR.

---

## D4 — トークン hygiene チェック

**Goal**: catch invisible-character corruption in bot tokens (the U+2028 issue from today's incident) at the **earliest possible moment** — at config load, before any Discord login attempt.

**Where**: a new helper invoked from `resolveDiscordToken(botId)` (currently in `server.ts`, search for that name).

**Code sketch**:

```ts
const FORBIDDEN_TOKEN_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF]/g
const TOKEN_SHAPE = /^[A-Za-z0-9_.-]+$/

function sanitizeAndValidateToken(rawToken: string, botId: string): string {
  const cleaned = rawToken.replace(FORBIDDEN_TOKEN_CHARS, '').trim()
  if (!cleaned) {
    throw new Error(`[${botId}] Discord token is empty after stripping invisible characters`)
  }
  if (!TOKEN_SHAPE.test(cleaned)) {
    throw new Error(`[${botId}] Discord token contains unexpected characters after sanitization`)
  }
  if (cleaned !== rawToken) {
    process.stderr.write(
      `[${botId}] WARN: Discord token contained invisible characters (likely U+2028); sanitized\n`
    )
  }
  return cleaned
}
```

Then a one-shot startup probe — same `users/@me` helper from D2 — runs on every bot at boot time and aborts with a clear error if the call returns 401/403. This is the second half of D4: token hygiene + token reachability.

**Tests**:
- Unit test: feed a token with U+2028 and assert it's stripped
- Unit test: feed a malformed token and assert it throws with the bot ID in the message
- (Integration test against the real Discord API is out of scope; mock `fetch` for the `users/@me` probe)

**Estimate**: ~50 lines + ~50 test lines. 1 PR.

---

## Summary table

| Item | Surface | LOC est. | Tests | PR count |
|------|---------|---------:|-------|---------:|
| D1 | adapters/discord.ts ready handler | ~30 | 2 new | 1 |
| D2 | server.ts bot_status / watchdog_check | ~80 | 1 new | 1 |
| D3 | CI workflow + script + template + test | ~150 | 1 meta-test | 1 |
| D4 | server.ts resolveDiscordToken + startup probe | ~50 | 2 new | 1 |
| **Total** | | **~310** | **6** | **4** |

All four can ship in 4 small independent PRs after CEO approval of ADR-040. None depends on PR-A or PoC PR-B; they can run in parallel with the v0.2.0 work.

---

## Sequencing

```
ADR-040 CEO approval
  │
  ├── D1 (smallest, lowest risk)        ──┐
  ├── D2 (depends on users/@me helper) ──┤
  ├── D4 (introduces users/@me helper) ──┴── ship in any order
  └── D3 (CI hardening, last)              ── ship after D1/D2/D4 patterns are concrete
```

If D2 and D4 race for the `fetchDiscordUserId` helper, the first PR adds it and the second imports it. Coordinate via PR description or land sequentially.
