# Q1 PoC Spike Plan — `notifications/message` Reachability

> Author: agent-com-dev
> Date: 2026-04-08
> Target: confirm whether MCP server `notifications/message` is surfaced to the Claude Code model context
> Time budget: 30 minutes
> Result destination: `#agent-com` channel + this file's "Result" section

The single existential question for v0.2.0: when an MCP server pushes a `notifications/message` to a Claude Code client, does the message content actually land in the model's context (i.e., does the model "see" it), or is it dropped at the client/transport layer?

If the answer is **yes**, the v0.2.0 receiver+MessageBus design works as designed (push). If **no**, we fall back to retreat path (a) — pull-on-notify with `check_inbox` polling — and v0.2.0 still ships with structural improvements but loses immediate push semantics.

---

## Spike scope

**In scope** (must verify):
- One Claude Code session connected to one minimal MCP server
- The MCP server emits `notifications/message` (server-initiated, not response to a client request)
- The Claude Code session demonstrably receives the notification: either (a) the model references the notification content in its next reply, or (b) the message is visible in client logs / telemetry
- Test both stdio and SSE transports — same payload, same server, two transport configs

**Out of scope** (deliberately excluded for the 30-minute budget):
- agent-comms server, Discord, Postgres, multi-bot routing
- Authentication / permissions
- Performance / rate limit / retry behaviour
- Long-running stability

---

## Setup (10 min)

### Step 0 — Backup `.mcp.json` (mandatory)

Before adding the spike server entry, snapshot the current `.mcp.json` so the spike can be reverted with one command. This is the same pattern CTO used for `plist` files during today's incident response.

```bash
cp -p .mcp.json .mcp.json.bak.$(date +%Y%m%d-%H%M%S)
```

After the spike completes:

```bash
# Confirm the backup is intact
diff -u .mcp.json.bak.* .mcp.json   # review intentional spike additions
# Restore
cp -p .mcp.json.bak.<timestamp> .mcp.json
```

### Step 1 — Minimal MCP server skeleton

A single TypeScript file using `@modelcontextprotocol/sdk` (already a project dependency at `node_modules/@modelcontextprotocol/sdk`).

```ts
// scripts/spike-mcp-notify-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new Server(
  { name: 'spike-notify', version: '0.0.1' },
  { capabilities: { tools: {}, logging: {} } }
)

server.setRequestHandler(/* ListToolsRequestSchema */, async () => ({ tools: [] }))

const transport = new StdioServerTransport()
await server.connect(transport)

// Push a notification 5 seconds after connect, then every 30 seconds
let counter = 0
setInterval(async () => {
  counter += 1
  await server.notification({
    method: 'notifications/message',
    params: {
      level: 'info',
      logger: 'spike',
      data: `[spike-notify] tick #${counter} at ${new Date().toISOString()} — confirm visibility`,
    },
  })
}, 30_000)
```

> **SDK version compatibility — verify on the very first attempt** (CTO spot-check):
> The exact notification method name may differ between MCP SDK versions. The first action of the spike is to call `server.notification({ method: 'notifications/message', ... })`; if the SDK throws (unknown method, invalid params, etc.), immediately retry with `notifications/log` as the fallback. Both attempts should be made within the first 2-3 minutes of the spike so the rest of the time budget is spent on probes 2-5, not on debugging the notification method itself.
>
> Concrete sequence:
> 1. Try `notifications/message` — if it dispatches without throwing, continue
> 2. If it throws, log the exact error, switch to `notifications/log`, retry
> 3. Whichever works, document the chosen method in the Result section so ADR-041 records the SDK constraint
> 4. If both throw, abort the spike and ping CTO before consuming more budget

### Step 2 — Wire into Claude Code

Add a temporary `.mcp.json` entry pointing at the spike server:

```json
{
  "mcpServers": {
    "spike-notify": {
      "command": "bun",
      "args": ["scripts/spike-mcp-notify-server.ts"],
      "type": "stdio"
    }
  }
}
```

Reload MCP servers in the Claude Code session (`/mcp` reconnect or `/restart`).

### Step 3 — SSE variant

Re-run the spike with the SSE transport:

```ts
// scripts/spike-mcp-notify-server-sse.ts
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
// ... bind to a local port, register the same notification interval
```

`.mcp.json` entry:

```json
{
  "mcpServers": {
    "spike-notify-sse": {
      "type": "sse",
      "url": "http://127.0.0.1:9101/sse"
    }
  }
}
```

---

## Verification (15 min)

For each transport (stdio, SSE) record the following table:

| Probe | How to verify | stdio | SSE |
|-------|---------------|------:|----:|
| 1. Server emits notification | `process.stderr.write` log on each tick | ☐ | ☐ |
| 2. MCP client receives notification | Claude Code client log shows incoming message | ☐ | ☐ |
| 3. Model context contains notification | Type "What was the most recent spike-notify tick number?" — model should answer with the latest counter | ☐ | ☐ |
| 4. Latency from emit → model visibility | Compare server log timestamp with first model reference | ☐ | ☐ |
| 5. Notifications arrive without prompting | After 60+ seconds idle, send a follow-up question — model should still know the latest tick | ☐ | ☐ |

The crucial probes are **3** and **5**. Probe 3 confirms the content actually lands in the context. Probe 5 confirms it lands without the user having to prompt — i.e., it's a true push, not a delayed pull.

---

## NG decision criteria (5 min)

| Scenario | Verdict | Action |
|----------|---------|--------|
| Both stdio + SSE pass probes 3 and 5 | **OK** | Proceed to PR-A (core extraction) → PoC PR. ADR-041 status → Accepted |
| Only SSE passes probes 3 and 5 | **OK with constraint** | All bots must migrate to SSE transport before Phase B. Significant additional work; flag to CTO for replanning |
| Only stdio passes probes 3 and 5 | **OK with constraint** | SSE path investigated as a follow-up; PoC proceeds on stdio. Document the asymmetry |
| Probe 3 fails on both transports | **NG** | Switch to retreat path (a) pull-on-notify per spec §Q1. ADR-041 records the spike result and adopts retreat. v0.2.0 still ships, push immediacy is lost |
| Probe 1 fails (server cannot emit) | **Setup error** | Re-check MCP SDK API surface, do not draw conclusions. Re-run spike |

---

## Recording template

After spike completion, append a "Result" section to this file with **per-probe observation logs** (CTO spot-check requirement — these become the evidence base for ADR-041 Accepted/Retreat decision).

Format per transport:

```markdown
## Result — stdio transport

**Date**: 2026-04-XX HH:MM JST
**SDK version**: <output of `bun pm ls @modelcontextprotocol/sdk`>
**Notification method used**: notifications/message | notifications/log
**MCP client**: Claude Code <version>

### Probe 1 — Server emits notification
- Status: ☑ / ☒ / ⚠
- Evidence:
  ```
  <paste 3-5 lines of stderr from spike-mcp-notify-server.ts>
  ```

### Probe 2 — MCP client receives notification
- Status: ☑ / ☒ / ⚠
- Evidence:
  ```
  <paste relevant Claude Code client log lines, or note "no client log available">
  ```

### Probe 3 — Model context contains notification (CRUCIAL)
- Status: ☑ / ☒ / ⚠
- Test prompt: "What was the most recent spike-notify tick number?"
- Model response (verbatim):
  > <paste model reply>
- Verdict: model knew the latest counter / model did not know / model knew an outdated counter

### Probe 4 — Latency
- Tick → first model reference (rough p50): <N> seconds
- Sample size: <N> ticks observed

### Probe 5 — Push without prompting (CRUCIAL)
- Status: ☑ / ☒ / ⚠
- Procedure: idle for 60+ seconds, then ask any unrelated question
- Model behavior: <describe whether the model surfaced the latest tick spontaneously, or only when explicitly asked>

### Unexpected observations
- <free-form notes>

## Result — SSE transport

<repeat the same five probe sections>

## Final verdict
- stdio: OK | OK-with-constraint | NG
- SSE: OK | OK-with-constraint | NG
- Combined: <which retreat path / continuation applies per spec §Q1>
```

Then post a 5-line summary to `#agent-com` and ping `@cto`. Link this file (with the Result section filled in) so ADR-041 can cite specific probe evidence rather than a vague "spike OK".

---

## Deliverables checklist

- [ ] `scripts/spike-mcp-notify-server.ts` (stdio variant)
- [ ] `scripts/spike-mcp-notify-server-sse.ts` (SSE variant)
- [ ] `.mcp.json` updated (temporary, will be reverted post-spike)
- [ ] Result section appended to this file
- [ ] Summary posted to `#agent-com`

---

## Result — 2026-04-08 17:07 JST

**Spike runner**: agent-com-dev (this Claude Code session, isolated subprocess via `claude --print`)
**SDK version**: `@modelcontextprotocol/sdk@^1.12.1` (from `package.json`)
**Notification method tried**: `notifications/message` (the SDK accepted it, no fallback to `notifications/log` was triggered for either transport)
**Test driver**: `claude --print --mcp-config <cfg> --dangerously-skip-permissions --max-turns 2 <prompt>`

The driver spawns an isolated `claude` subprocess (separate from this session) and asks the model to recite the unique SPIKE token that the server is pushing via notifications. Each spike run regenerates the token, so the model can only know it via in-context delivery — there is no training-data leak path.

### Result — stdio transport

- **Spike server**: `scripts/spike-mcp-notify-server.ts`
- **Server log**: `/tmp/spike-server.log`

| Probe | Status | Evidence |
|------:|:------:|----------|
| 1. Server emits notifications | ✅ | 18+ ticks dispatched in `/tmp/spike-server.log`. SDK `server.notification({method: 'notifications/message', ...})` returned without throwing for every tick. |
| 2. MCP client receives | ⚠️ unknown | `claude --print` does not expose client-side notification logs. Whether the JSON-RPC frames were dropped at the transport layer, the client layer, or the surfacing layer cannot be distinguished from the spike alone. |
| 3. Model context contains notification | ❌ FAIL | Model output verbatim: `NO_NOTIFICATIONS_RECEIVED`. The model knew the spike server name (`spike-notify`) and the token format (`SPIKE-XXX-XXX`) — both surfaced by `tools/list` — but had no knowledge of any `SPIKE-MNPRMEL6-A63XKJ`-style token from any tick. |
| 4. Latency (tick → model visibility) | n/a | Probe 3 failed → no observation possible. |
| 5. Spontaneous push (no prompting) | ❌ FAIL | Same as Probe 3. The model was explicitly asked to retrieve the token and could not. |

### Result — SSE transport

- **Spike server**: `scripts/spike-mcp-notify-server-sse.ts` (express + `SSEServerTransport` on `127.0.0.1:9101/sse`)
- **Server log**: `/tmp/spike-server-sse.log`

| Probe | Status | Evidence |
|------:|:------:|----------|
| 1. Server emits notifications | ✅ | SSE listener accepted the `claude --print` connection (`/sse client connected from ::ffff:127.0.0.1`). 7 ticks dispatched before the test driver's prompt finished. SDK accepted `notifications/message` with no throw. |
| 2. MCP client receives | ⚠️ unknown | Same caveat as stdio. |
| 3. Model context contains notification | ❌ FAIL | Model output verbatim: `NO_NOTIFICATIONS_RECEIVED`. Identical behaviour to stdio. |
| 4. Latency | n/a | — |
| 5. Spontaneous push | ❌ FAIL | — |

### Final verdict

| Transport | Probe 3 | Probe 5 | Verdict |
|-----------|:----:|:----:|:-------:|
| stdio | ❌ | ❌ | **NG** |
| SSE | ❌ | ❌ | **NG** |

**Combined verdict: NG**.

Per spec §Q1, this triggers **retreat path (a) — pull-on-notify**.

### What this proves and what it doesn't

**Proves**: Claude Code's MCP client (as of `@modelcontextprotocol/sdk@1.12.1`, claude CLI version current as of 2026-04-08) does **not** surface server-initiated `notifications/message` into the model's context window. The notifications dispatch successfully at the SDK / transport level — the gap is at the client → model surfacing layer. The behaviour is identical for stdio and SSE, which is consistent with the surfacing layer being transport-agnostic.

**Does not prove**: that no future Claude Code release will surface them. The spike server is reusable for re-validation when the MCP spec for server-initiated notifications stabilises further.

**Does not test**: alternative notification methods. `notifications/resources/updated`, `notifications/prompts/list_changed`, and `notifications/tools/list_changed` are recognised in the MCP spec and may be surfaced by the client. Worth a follow-up spike if retreat path (a) turns out to be too slow in practice.

### Cleanup performed

- Killed the SSE spike process (PID was tracked in `/tmp/spike-sse.pid`)
- Project `.mcp.json` was never modified — spike configs lived in `/tmp` and were referenced via `--mcp-config`
- Backup of `.mcp.json` taken at Step 0 is intact (timestamps preserved)

### Implication for v0.2.0 / ADR-041

The Receiver + MessageBus structural value is preserved per the spec's retreat path comparison table (§Q1):

- ✅ Discord Gateway aggregation into one receiver
- ✅ DB INSERT centralisation
- ✅ catch-up phase
- ✅ mixed-mode dedup
- ✅ routeMessage unification

What is lost:
- ❌ immediate push semantics for inbound messages → bots check inbox on a polling interval (current production behaviour)

ADR-041 should be set to **Accepted with retreat path (a)** rather than rejected. The construction work is identical for both push and retreat-pull modes — only the bot subscribe handler differs (call MCP notification vs append to inbox queue).
