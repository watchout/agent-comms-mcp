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

> Note: the exact `notifications/message` schema may differ between MCP SDK versions. If the SDK rejects this method, fall back to `notifications/log` or another server-initiated notification method documented in the SDK.

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

After spike completion, append a "Result" section to this file with:

- Transport: stdio / SSE (one section each)
- Each probe: ☑ pass / ☒ fail / ⚠ partial — with one-line evidence
- Latency observation (probe 4): rough p50 in seconds
- Final verdict: OK / OK-with-constraint / NG
- Any unexpected behavior

Then post a 5-line summary to `#agent-com` and ping `@cto`.

---

## Deliverables checklist

- [ ] `scripts/spike-mcp-notify-server.ts` (stdio variant)
- [ ] `scripts/spike-mcp-notify-server-sse.ts` (SSE variant)
- [ ] `.mcp.json` updated (temporary, will be reverted post-spike)
- [ ] Result section appended to this file
- [ ] Summary posted to `#agent-com`
