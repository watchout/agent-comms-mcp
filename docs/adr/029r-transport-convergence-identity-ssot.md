# ADR-029R — MCP Transport Convergence (single daemon) + Identity SSOT

> Status: PROPOSED (ARC design ACK: CONDITIONAL GO, 2026-06-12)
> Supersedes: the 2026-04 retreat decision (PR #86 / `bff1b41`) — narrowly, see §2
> Relates: ADR-029 (SSE transport), `docs/SSE_TRANSPORT_SPEC.md`, issue #722, PR #727,
> ARC design ACK (agent_messages `61d08a5b-b37f-4ded-a504-d71a7a2e9d90`, 2026-06-12)
> Risk: HIGH / protected — agent routing, queue delivery, MCP transport, runtime
> identity, restart/reconnect behavior, fleet-wide communication reliability

## 1. Context

ADR-029 identified the stdio-spawn problem (bot-count × 2 MCP processes, orphan
OOM kills, measured 47 processes / 1.4 GB) and built the SSE daemon mode
(Phase 3b per-bot server factory, `TRANSPORT_MODE=daemon`). The 2026-04-08 Q1
spike (`5b86523`) then proved that Claude Code's MCP client does not surface
server-initiated `notifications/message` into model context on either
transport, and PR #86 (`bff1b41`) retreated to stdio + channel plugin while
preserving the daemon code "for future use".

Measured on 2026-06-12, the stdio fleet had drifted into 29 `server.ts`
processes from 3+ sources (developer working tree ×17, a stale repo clone ×10,
two stale checkouts), plus a fleet identity incident: a global
`~/.codex/config.toml` `[mcp_servers.aun.env] AGENT_ID="codex-cto"` default
caused four product-bot sessions to identify as `codex-cto` (root cause of the
day's CLAIM_EXPIRED class), while the real CTO session's launcher identified as
`aun` and failed on a port conflict.

The #722 ARC update (2026-06-12) made communication DB-primary: the
state-daemon queue-work scheduler owns receiving; bot-session MCP is
request/response tooling only (`send` / `notify` / `next` / `processing` /
`done`).

## 2. Decision — supersede statement (required wording)

> 2026-04 retreat remains correct for server-initiated MCP notification
> surfacing. The decision is superseded for DB-primary pull/request-response
> communication because model-visible push is no longer an architectural
> requirement.

Do not frame this as "server push works now." Server push is no longer a
prerequisite. Server-initiated notifications are diagnostic-only and MUST NOT
appear as an acceptance criterion anywhere in this chain.

Decisions:

1. **Single daemon transport convergence.** One `server.ts` daemon process per
   host, started from the canonical checkout, serving all bots over
   **Streamable HTTP** (MCP SDK; the existing `SSEServerTransport` is
   deprecated upstream and is replaced, not extended). stdio spawn is demoted
   to emergency fallback (§6.4).
2. **Identity SSOT.** Bot identity is never written at spawn sites. It is
   resolved per §5 and verified fail-closed. Global identity defaults are
   forbidden across ALL MCP servers in the fleet (agent-comms/aun AND
   agent-memory/wasurezu and any future MCP).

## 3. Canonical source identity

- Daemon source of truth: `~/.agent-comms/state-daemon/checkouts/<git-sha>`,
  exposed to clients via the stable symlink `~/.agent-comms/state-daemon/current`.
  At ratification time: `90bbde67d20321c57237574ba88435d1313fec1e` (merged
  PR #727).
- **Per-bot working-tree `server.ts` execution is deprecated.** Per-bot
  `.mcp.json` may point at the daemon (or, during transition, at
  `current/server.ts`) but MUST NOT spawn `server.ts` from arbitrary working
  trees or clones.
- Health/bot_status MUST expose: repo path, git SHA, startup command, daemon
  pid — so source drift is mechanically detectable (sweep: `ps` command-line
  audit + hash check).

## 4. Client support evidence (2026-06 web verification, to be re-proven by Spike A)

- Codex CLI supports remote MCP via Streamable HTTP natively:
  `[mcp_servers.X] url = "..."` + `bearer_token_env_var` / `http_headers`,
  plus `codex mcp login` OAuth. (developers.openai.com/codex/mcp)
- Claude Code recommends HTTP transport for remote servers; SSE transport is
  deprecated; disconnects auto-reconnect with exponential backoff (5 attempts,
  1 s doubling), `/mcp` manual retry afterwards. (code.claude.com/docs/en/mcp)
- Documentation is evidence of intent, not of behavior: Spikes A/B/C (§7)
  record the actual behavior before any rollout.

## 5. Identity SSOT design

Principle: identity is derived per connection from one source; spawn sites
carry no identity.

### Phase 1 — workspace declaration (stdio/transition era)

- Each bot workspace declares identity once:
  `<workspace>/.agent/identity.json` → `{ "agent_id": "...", "project": "..." }`.
- One shared resolver (library, consumed by agent-comms AND agent-memory and
  future MCPs) with strict precedence:
  1. explicit operator override — see override discipline below
  2. workspace identity declaration
  3. **FAIL** — there is no default identity
- **Override discipline (ARC review condition 1).** A plain `AGENT_ID` env
  var — including anything inherited from a global config layer — is NOT an
  override and fails closed in fleet/protected mode. A valid override
  requires an explicit operator marker
  (`AGENT_ID_OVERRIDE_REASON` + `AGENT_ID_OVERRIDE_ACTOR`), is disabled by
  default in fleet/protected mode, and every use is audit-logged with reason
  and actor. (The 2026-06-12 incident's inherited global
  `AGENT_ID="codex-cto"` carried no marker and would have failed closed.)
- **Workspace cross-check precision (ARC review condition 2).** The check is:
  canonicalize the workspace path via `realpath` → resolve `workspace_id`
  from `agent_workspaces(org_id, local_path)` → require an **active**
  `agent_workspace_bindings(agent_id, workspace_id)` row. `identity.json` is
  a declaration, never authority: it cannot bypass the binding check and
  cannot create a binding. A copied workspace (same identity.json, different
  realpath) therefore fails closed.
- `AGENT_MEMORY_AGENT_ID` becomes a deprecated alias of the same resolver
  (cross-repo change with agent-memory; the global `="aun"` default is removed
  the same way the agent-comms global default was removed on 2026-06-12).

#### Identity negative cases (ARC review condition 3 — binding for Spike A/C and the resolver test suite; all MUST fail closed)

| case | expected |
|---|---|
| missing `identity.json` and no valid override | FAIL (no identity) |
| declared agent_id not present in `agents` | FAIL |
| no active `agent_workspace_bindings` row for (agent_id, workspace_id) | FAIL |
| copied workspace: identity.json present but realpath ≠ bound `local_path` | FAIL |
| env `AGENT_ID` present without override marker (incl. global-config inheritance) | FAIL |

### Phase 2 — auth-subject binding (daemon era; ARC frozen requirement 2)

- Each connection presents an auth credential (OAuth 2.1 / PKCE per `1148fa5`,
  or bearer token); the daemon resolves credential → agent_id and records the
  binding in DB/runtime evidence.
- bot_id-by-query alone is not sufficient for fleet acceptance. Local no-auth
  bypass is dev/test only and visibly disabled for fleet/protected rollout.
- Configuration files then carry no identity at all.

## 6. Frozen requirements (ARC ACK, restated — binding for the whole chain)

1. **Queue ownership boundary.** state-daemon / queue scheduler remains the
   DB-primary delivery authority. This ADR is transport/process convergence,
   not a queue lifecycle redesign. Routing semantics, queue finalization, and
   completion evidence never move into client-visible notifications.
2. **Identity and auth.** Per §5; connection identity binds to an auth subject
   or registered local identity, recorded in DB/runtime evidence.
3. **Single source / no drift.** One canonical daemon checkout; health exposes
   source hash/path; mechanical drift detection.
4. **Fallback discipline.** stdio fallback is emergency-only, time-boxed,
   owner-stamped, logged. No silent reintroduction of per-bot
   `DISCORD_BOT_TOKEN` + `server.ts` spawn as normal mode.
5. **Observability.** bot_status distinguishes: process healthy / MCP
   connected / queue claim working / end-to-end delivery working. The failure
   class "healthy but idle pending without delivery progress" surfaces as
   unhealthy/degraded for delivery.
6. **Restart safety.** Daemon restart, client restart, and bot reconnect lose
   no pending queue rows; stale session cleanup and endpoint lease recovery
   are tested; `missing_lease` never blocks recovery without an
   operator-visible remediation path.
7. **Rollout path.** Spec/ADR PR → spike PR(s) → canary (one or two low-risk
   bots) → expand only after QA live canary evidence → fleet rollout requires
   protected review (audit + QA/check + CTO/security). CEO direction is
   business direction, not technical completion evidence.

## 7. Spike scope and acceptance criteria

### Spike A — Codex / Claude remote MCP connection

- Verify Codex v0.139 remote (Streamable HTTP) connection; if not native,
  verify the `mcp-remote` bridge.
- Record: client config, auth mode, reconnect behavior, tool list visibility,
  and working request/response tools: `next`, `processing`, `done`, `send`,
  `notify`, `bot_status`.
- Server-initiated notifications: diagnostic only, never acceptance criteria.

### Spike B — daemon restart / reconnect

- Restart the daemon with ≥2 bots connected. Clients recover without stale
  duplicate sessions; same bot_id reconnect closes/replaces the prior
  connection deterministically; no duplicate Discord/native adapter ownership
  after reconnect; health transitions degraded → ok with timestamps.

### Spike C — end-to-end DB queue canary (may fold into B)

- A sends to B; B claims via `next`, marks `processing`, replies/`done`; the
  queue row reaches a terminal state with correct target identity.
- NOT delivery evidence: a pending row, outbound_queued, a connected session,
  or an ACK.
- Required evidence fields: message_queue id, message_id, target agent_id,
  status transitions, claimed_by, read_at/claimed_at/done_at or replied_at.

## 8. PR breakdown (ARC-requested, this document is PR 1)

1. **ADR/spec PR** — this document.
2. **Spike PR** — Codex/Claude remote MCP (+ bridge) test harness + recorded
   results.
3. **Spike/canary PR** — daemon restart/reconnect + DB queue end-to-end canary.
4. **Implementation PR** — daemon from canonical checkout + config generation
   (includes hooks/ops-script distribution per issue #733) + health/source
   identity + Streamable HTTP transport + Phase 1 identity resolver.
5. **Rollout PR** — canary → fleet, rollback runbook, emergency stdio fallback
   runbook.

## 9. Rollback

- Canary failure: unset the daemon-mode client configs (backups are
  timestamped), revert to `current/server.ts` stdio spawn (emergency fallback
  discipline §6.4 applies), revert daemon to prior canonical checkout.
- Queue recovery is queue_id-scoped reclaim/close only; queue rows are never
  deleted.

## 10. History (not rewritten)

- ADR-029 / `docs/SSE_TRANSPORT_SPEC.md`: original daemon decision and
  motivation (process proliferation).
- `7929e09`: Phase 3b per-bot server factory (`TRANSPORT_MODE=daemon`).
- `5b86523`: Q1 spike — both transports NG **for model-visible push**.
- `bff1b41` (PR #86): retreat to stdio — correct at the time, for the
  push-based design.
- `a913b5a` (#209): single entry point + `TRANSPORT_MODE` unification.
- 2026-06-12: #722 DB-primary redefinition, PR #727 merge, fleet unification
  window, identity incident and repair — the conditions that make this
  supersede valid.
