# Codex Runner Lifecycle Gate

Issues: #422, #426

## Decision

Codex auto-receive must be a DB-primary runner that preserves request lifecycle
truth. It must not infer completion from free-form prose, Discord projection, or
the mere existence of an outbound reply.

The runner contract is:

```text
DB request state is primary.
message_queue delivery state is claim/close transport.
agent_messages is the event log.
Discord is projection only.
```

#420 introduced the reply close split that Codex must use:

- `reply --no-close` for ACK, plan, and progress.
- `reply --close --queue-id --message-id` for final queue close.
- `notify` for self-originated notices only, not normal completion.

#422 should automate receive around that contract. #426 should make request
lifecycle state queryable without reading LLM prose.

## Non-Mutation Boundary

This design does not restart or mutate production `state-daemon`, launchd, DB
config, or bot registry. Formal state-daemon restart remains gated on #421.

Draft PRs for #422 or #426 must remain draft until #421/#427 dependencies are
settled and L1/L2 review is requested.

## #422 Codex Auto-Receive Runner

### Runtime Shape

The Codex runner is a local process owned by the Codex workspace:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun bin/aun.ts drain --agent-id codex-aun --limit 10
```

The runner may be implemented as a thin wrapper around `aun drain` first. It
must keep enough durable metadata to survive a long Codex turn:

- `queue_id`
- `message_id`
- `channel_id`
- `thread_id`
- sender
- message type / lifecycle type
- content digest or payload reference

The runner must not rely on `inbox`, tmux natural-language prompt injection, or
manual command paste as the primary receive path.

### Receive Loop

Minimum loop:

1. Poll or wait for pending work for the configured `AGENT_ID`.
2. Call the same deterministic claim path as `aun drain` / `next`.
3. Persist the claimed `queue_id` and `message_id` in runner-local state before
   handing the task to Codex.
4. Emit a structured `ack` event via `reply --no-close` when the task is
   accepted.
5. Emit optional progress events via `reply --no-close`.
6. Emit final completion via `reply --close --queue-id --message-id`.

The runner must treat `work_closed=false` as expected for ACK/progress and
`work_closed=true` as required for final completion.

### Crash And Recovery

If the runner crashes after claim but before final close:

- the DB row remains recoverable by `queue_id` and `message_id`
- #419/#423 prevent stale age alone from terminal-failing owned work
- #404 durable close lets a resumed runner close explicitly after TTL expiry
- #420 prevents early ACK/progress from hiding unfinished work

On restart, the runner should:

1. inspect local in-flight state
2. diagnose the corresponding DB row
3. resume final close if the work result is known
4. otherwise leave the request visible and report `needs_info` or an operator
   recoverable state

## #426 Request Lifecycle Gate

### Separation From Message Queue

`message_queue.status` is not the whole request lifecycle.

`message_queue` answers:

```text
Was this message delivered, claimed, and terminally closed for this assignee?
```

The request lifecycle answers:

```text
Who has responsibility, what is the latest lifecycle event, and is the request
terminal?
```

#426 should add structured lifecycle events rather than overloading
`message_queue.status`.

### Minimal Lifecycle Events

| Event | Terminal | Responsibility after event | Queue close behavior |
|---|---:|---|---|
| `request` | no | assignee | enqueue assignee |
| `question` | no | assignee | enqueue assignee |
| `ack` | no | assignee | `reply --no-close` |
| `progress` | no | assignee | `reply --no-close` |
| `needs_info` | no | requester | `reply --no-close` |
| `answer` | no | requester or assignee by context | `reply --no-close` by default |
| `result` | no | requester confirmation | `reply --no-close` by default |
| `close` | yes | none | `reply --close --queue-id --message-id` |
| `cancel` | yes | none | explicit terminal event |
| `supersede` | yes | successor request | explicit terminal event |
| `fail` | yes | none or operator | explicit terminal event |
| `notice` | no close required | none | `notify` or non-request message |
| `chat` | no close required | none | ordinary message |

`result` is intentionally non-terminal unless the request type explicitly allows
auto-close. This keeps the requester confirmation gate visible.

### Queryable View

The lifecycle gate should expose a queryable status view with:

- request id / root message id
- requester
- assignee
- current responsibility
- latest lifecycle event
- latest event author
- related queue ids
- terminal state and terminal event id
- whether there is an open delivery row for the current responsible actor

Operators should be able to answer "what is still waiting on whom?" without
reading Discord or LLM prose.

## Dependency Matrix

| Dependency | Required behavior for #422/#426 |
|---|---|
| #404 durable close | final close can target original `queue_id/message_id` after TTL expiry |
| #420 close split | ACK/progress use `--no-close`; final uses `--close` |
| #421 state/action runner | state-daemon should schedule runner actions from DB state, not prose |
| #423 stale sweep fix | stale age alone must not terminal-fail active request work |
| #426 lifecycle gate | Codex runner emits typed lifecycle events instead of ambiguous free-form replies |

#422 can start with polling. #421 can later replace polling with
state/action-triggered runner invocation, but the runner's public contract must
stay the same.

## Proposed Test Plan

Use isolated DB fixtures only.

### #422 Runner Tests

- pending request for `codex-aun` is claimed by runner without `inbox`
- runner emits `ack` with `reply --no-close` and original queue remains open
- progress event returns `work_closed=false`
- final event uses `reply --close --queue-id --message-id` and closes only the
  intended queue row
- claim TTL expiry before final close still allows explicit durable close
- runner crash after ACK leaves request visible and recoverable
- identity mismatch between `AGENT_ID` and `AGENT_COM_EXPECTED_AGENT_ID` fails
  closed before receiving work

### #426 Lifecycle Tests

- `request -> ack -> progress` remains non-terminal
- `request -> result` remains open with requester responsibility
- `request -> result -> close` becomes terminal
- `request -> needs_info` moves responsibility to requester
- `question -> answer` records answer without treating notify fallback as close
- `cancel`, `supersede`, and `fail` are explicit terminal alternatives
- request status view reports requester, assignee, current responsibility, latest
  event, and terminal state
- notify fallback creates a visible fallback event but does not satisfy or close
  the original request

## Touched Files For Future Implementation

Likely #422 implementation files:

- `bin/aun.ts`
- `bin/aun/receive.ts`
- `bin/aun/reply.ts`
- new `bin/aun/codex-runner.ts` or `scripts/codex-auto-receive.ts`
- `tests/contract/` runner fixtures
- `docs/operations/codex-runtime-adapter-bootstrap.md`

Likely #426 implementation files:

- new lifecycle core module under `core/`
- DB migration or SQLite-compatible fixture schema for lifecycle events
- `cli/index.ts` typed lifecycle commands
- `bin/aun/reply.ts` mapping for lifecycle events
- request status diagnostic script
- tests under `tests/contract/`

Implementation should avoid state-daemon rewrites until #421 defines the
state/action runner boundary.

## Acceptance Criteria

- Codex can receive a request without manual relay or `inbox`.
- ACK/progress from Codex are represented as structured non-terminal lifecycle
  events and return `work_closed=false`.
- Final completion uses explicit close and returns `work_closed=true`.
- A request remains queryably open after ACK/progress/result until a terminal
  lifecycle event occurs.
- `notify` is visible as fallback/notice and never normal request completion.
- The runner keeps `queue_id/message_id` across long work and can close after
  TTL expiry.
- Tests run against isolated DB fixtures and do not mutate production DB.
