# PR-A Sketch — `core/route-message.ts` Extraction

> Author: agent-com-dev
> Date: 2026-04-08
> Status: Sketch (pre-implementation)
> Priority: Top (PoC prerequisite per CTO 2026-04-08 decision)
> Constraint: **Pure refactor — zero behavioural change**

This PR extracts the routing/destination logic from the 3000+ line `server.ts` into a dedicated `core/route-message.ts` module so that the upcoming receiver process (PR-B) and the existing daemon can share a single implementation.

The change is **pre-PoC** and **must not alter behaviour**. All existing tests must continue to pass without modification. New tests may be added.

---

## Why this is a prerequisite, not part of the PoC

CTO position (2026-04-08, agent-com-dev concurred):

- PR-A is a pure refactor with no behavioural change → can be reviewed and merged in isolation
- The PoC PR (PR-B) imports from `core/route-message.ts`; it cannot land cleanly while routing logic is still inside `server.ts`
- Bundling a refactor with a feature was the structural cause of today's PR#87-#90 cascade failure (`040-mention-validation-cascade-failure.md`). Avoid repeating the pattern
- PR-A merged early also benefits the current daemon — same code paths, same tests, simpler grep targets

---

## Files & symbols to extract

### From `server.ts`

| Symbol | Current location | Notes |
|--------|------------------|-------|
| `interface AgentInfo` | server.ts:1249 | Move as-is |
| `interface ChannelInfo` | server.ts:1255 | Move as-is |
| `interface RouteResult` | server.ts:1262 | Move as-is |
| `function routeInbound` | server.ts:1278 | Pure function, move as-is. Rename TBD (see below) |
| `function isEmergencyMessage` | server.ts:1032 | Pure helper used by `routeInbound`. Move |
| `function parseMentions` | server.ts:1226 | Pure helper used by `routeInbound` and `resolveSendDestination`. Move |
| `async function resolveSendDestination` | server.ts:1140 | Has DB I/O via `getMessageById`. Move with DB injection |
| `async function getMessageById` | server.ts:1190 | DB I/O. Move with DB injection |
| `async function isHumanAgent` | server.ts:1039 | DB I/O. Move with DB injection |
| `async function resolveInboundChannel` | server.ts:1085 | DB I/O. Move with DB injection |
| `async function resolveAgentFromDiscordId` | server.ts:1074 | DB I/O. Move with DB injection |
| `async function loadAgentInfo` | server.ts:1468 | DB I/O. Move with DB injection |

### Stay in `server.ts` (caller boundary)

- `handleInboundMessage` — wraps the pure function with I/O orchestration. **Stays** in server.ts (or moves to a separate `inbound-handler.ts` later — out of PR-A scope).
- The MCP `send` tool handler — calls `resolveSendDestination` and `routeInbound`. **Stays**, just imports from core.
- Discord adapter glue, `tryGetDb`, `tmuxSession`, transport selection, `EXPECTED_BOTS` — all stay in `server.ts`.

---

## Module boundary

**Pure layer** (no `pg` dependency, fully unit-testable):

```ts
// core/route-message.ts
export interface AgentInfo { /* ... */ }
export interface ChannelInfo { /* ... */ }
export interface RouteResult { /* ... */ }

export function routeInbound(msg, channel, agents): RouteResult { /* unchanged */ }
export function parseMentions(content: string): string[] { /* unchanged */ }
export function isEmergencyMessage(content: string, type: string): boolean { /* unchanged */ }
```

**DB-bound layer** (uses an injected `DbAdapter` interface so the receiver and bot MCP can share it):

```ts
// core/route-message-db.ts
import type { Pool } from 'pg'
import { routeInbound, type RouteResult, type AgentInfo, type ChannelInfo } from './route-message.js'

export interface DbAdapter {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export async function getMessageById(db: DbAdapter, messageId: string) { /* ... */ }
export async function isHumanAgent(db: DbAdapter, agentId: string): Promise<boolean> { /* ... */ }
export async function resolveInboundChannel(db: DbAdapter, externalChannelId: string) { /* ... */ }
export async function resolveAgentFromDiscordId(db: DbAdapter, discordId: string) { /* ... */ }
export async function loadAgentInfo(db: DbAdapter, agentId: string) { /* ... */ }
export async function resolveSendDestination(db: DbAdapter, agentId: string, replyTo: string | undefined) { /* ... */ }
```

The pure layer can be unit-tested with no DB; the DB-bound layer is integration-tested against a real Postgres (matching the existing `tests/inbound-router.test.ts` pattern).

---

## Naming question (defer to PR review)

The v0.2.0 spec talks about renaming `routeInbound` → `routeMessage` with a `sourceType` parameter (§C2). PR-A could either:

- **(A)** Keep `routeInbound` as the function name during extraction, rename in PR-B (smaller diff per PR)
- **(B)** Rename to `routeMessage` and add `sourceType: 'inbound'` in PR-A so PR-B only adds new branches

**Recommendation: (A)**. Keeps PR-A a pure mechanical move with zero call-site changes. PR-B introduces both the new sourceType parameter and the receiver logic. Smaller PRs, safer review, easier to bisect if a regression appears.

---

## Step-by-step plan

1. Create `core/` directory at repo root
2. Add `core/route-message.ts` with the pure functions and types (copy verbatim from `server.ts`)
3. Add `core/route-message-db.ts` with the DB-bound functions, accepting an injected adapter
4. In `server.ts`, replace each function definition with `import { ... } from './core/route-message.js'` and `import { ... } from './core/route-message-db.js'`
5. Wrap existing `tryGetDb()` callers to expose a `DbAdapter`-shaped object (one-line wrapper, no behavioural change)
6. Run `bun test tests/` — must show **125 pass / 0 fail** (same as PR#91 baseline)
7. Open PR with diff stat target: ~+400/-300 (mostly mechanical move + import updates)
8. Request CTO review

---

## Tests touched

- **`tests/inbound-router.test.ts`** — already uses `SERVER_SOURCE.includes(...)` for source-level checks. After extraction, those checks must point at `core/route-message.ts` instead. Update `SERVER_SOURCE` constants or add `CORE_SOURCE` constant.
- **`tests/inbound-mentions-filter.test.ts`** — likely imports `parseMentions` indirectly. Check imports.
- **No new test logic** in PR-A. New tests for the unit-testable pure layer can come in a follow-up.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| Bun's TypeScript path resolution differs from Node | Use relative imports with explicit `.js` extension as already done elsewhere in the repo |
| Circular dependency: `core/` imports from `server.ts` for some helper | Identify and extract the helper too, OR inject as a parameter. Block PR-A if this can't be cleanly resolved |
| Source-level test patterns break (they grep `server.ts` content) | Update test constants to include `core/route-message.ts` source |
| Hidden coupling to `process.stderr.write` calls embedded in routing | Keep all `stderr` calls inside the DB-bound wrapper functions, not the pure functions |
| `tryGetDb()` lazy connection semantics | Wrap it in an adapter constructor that callers pass through; do not change its lifecycle |

---

## Out of scope for PR-A

- Renaming to `routeMessage` + `sourceType` parameter (PR-B)
- New `proactive` send mode (Mode B, deferred to ADR-041 implementation)
- `discord_message_id` column / migration (separate PR with the v0.2.0 schema changes)
- New unit tests for the extracted pure layer (follow-up PR)
- Touching `handleInboundMessage`, the `send` tool handler, or the MCP transport setup

---

## Definition of done

- [ ] `core/route-message.ts` and `core/route-message-db.ts` exist and are imported from `server.ts`
- [ ] `bun test tests/` → 125 pass / 0 fail
- [ ] No call-site behaves differently (verified by passing the existing test suite)
- [ ] PR description references `040-mention-validation-cascade-failure.md` and ADR-041 (draft)
- [ ] CTO review LGTM
