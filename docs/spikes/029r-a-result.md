# ADR-029R Spike A — Result (2026-06-13)

> Verdict: **GO** — both fleet clients connect to the experimental Streamable
> HTTP MCP endpoint natively (no bridge), list the real tools, and execute
> real request/response tool calls with bearer auth enforced.
> Scope per ARC ACK: this is connection-capability evidence only — not fleet
> rollout approval. Server-initiated notifications were not tested and are
> not acceptance criteria (diagnostic-only per ADR-029R §2).

## Setup

- Server: real `server.ts` (branch spike/029r-a-remote-mcp) booted with
  `AGENT_COMMS_EXPERIMENTAL_HTTP_MCP=1` (off-by-default flag, frozen req 4),
  `AUTH_TOKEN` set, `AUTH_SKIP_LOCALHOST=false` (auth enforced even on
  localhost), ephemeral `sd-test-spikea-*` agent IDs, dev Postgres.
- Endpoint: `POST /mcp?bot_id=<id>` → per-bot real `Server` via
  `createBotServer` + `StreamableHTTPServerTransport` (SDK 1.12.1), session
  continuation via `mcp-session-id`, DELETE terminates.
- Identity via `bot_id` query param is SPIKE-ONLY (ADR-029R §5 Phase 2
  replaces it with auth-subject binding before fleet use).
- Harness: `scripts/spike-029r-a-remote-mcp.ts` (reproducible; two LLM calls).

## Evidence

### Codex CLI — native streamable HTTP, no bridge

| item | value |
|---|---|
| version | codex-cli **0.139.0** |
| client config | `[mcp_servers.spikea] url="http://127.0.0.1:39850/mcp?bot_id=…"` + `bearer_token_env_var="SPIKE_A_TOKEN"` |
| approval mode | `--dangerously-bypass-approvals-and-sandbox` required for non-interactive MCP tool calls (first run without it: tool call auto-cancelled — recorded as operational note for headless runner configs) |
| tools/list | full 18-tool list returned (`bot_status, notify, send, …, next, reclaim, done`) |
| tool call | `bot_status` succeeded; returned live daemon status: `state-daemon=ok … pid=80424 path=…/checkouts/90bbde67…/bin/state-daemon.ts` |
| exit status | 0 |

### Claude Code — http transport

| item | value |
|---|---|
| version | 2.1.170 (Claude Code) |
| client config | `--mcp-config '{"mcpServers":{"spikea":{"type":"http","url":…,"headers":{"Authorization":"Bearer …"}}}}'` |
| tools/list | full 18-tool list returned |
| tool call | `bot_status` succeeded (same live daemon status) |
| exit status | 0 |

### Auth enforcement

- POST `/mcp` without bearer → **401** (expected 401). Bearer required even on
  localhost in the spike configuration.

### Protocol-level coverage (CI, no LLM)

`tests/contract/test_http_mcp_transport.test.ts` — 5/5 pass:

1. initialize + tools/list exposes the real tools (`next`, `processing`,
   `done`, `send`, `notify`, `bot_status` all present)
2. `bot_status` responds over the new transport
3. **full queue lifecycle over HTTP against real Postgres**: seeded pending
   row → `next` claims (status `received`, `claimed_by` correct) →
   `processing` (`in_progress`) → `done` (`done` + `done_at` set)
4. session termination (DELETE) + new session establishment
5. missing `bot_id` fails closed with 400 (spike-only identity gate)

## Notes for the chain

- ARC acceptance items covered: client config ✓, auth mode ✓ (bearer; OAuth
  deferred to Phase 2 identity work), tool list visibility ✓, request/response
  tools ✓ (`next`/`processing`/`done`/`bot_status` exercised; `send`/`notify`
  registered and protocol-reachable — full reply-path semantics are exercised
  in Spike C's end-to-end canary), reconnect behavior → Spike B.
- Identity negative cases (ADR-029R §5 table) land with the Phase 1 resolver
  (implementation PR 4) as resolver tests, per ARC's "Spike A/C **or**
  resolver tests".
- Operational note: Codex headless runner configs must set the approval
  bypass (or equivalent approval policy) for MCP tool calls, otherwise calls
  are auto-cancelled in `codex exec`.
- The SSE transport remains untouched; `/mcp` is additive and off by default.
