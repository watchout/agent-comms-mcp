# Codex Runtime Adapter Bootstrap

Issue: #404 user-side acceptance criteria

## Decision

Codex sessions use AUN through script-driven CLI commands from a dedicated clean
checkout. Codex must not depend on tmux text injection or natural-language
commands pasted into a UI to receive or close work.

For the `codex-aun` operator session, the AUN CLI checkout is:

```text
/Users/yuji/Developer/codex-aun/agent-comms-mcp-main
```

The separate development checkout owned by `agent-com-dev` is not a Codex AUN
runtime workspace:

```text
/Users/yuji/Developer/agent-comms-mcp
```

Codex runtime adapters may read design docs from their own dedicated checkout,
but must not use another agent's worktree as their CLI execution source.

## Required Environment

Every Codex AUN invocation sets the runtime identity inline:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts ...
```

Rules:

- `AGENT_ID` and `AGENT_COM_EXPECTED_AGENT_ID` must match.
- Codex must not infer an agent id from shell state, config files, branch names,
  or the current directory.
- `DATABASE_URL` uses the local PostgreSQL socket fallback unless an operator
  explicitly supplies a different non-production target.
- Production DB tests are out of scope for this adapter bootstrap.

## Standard Receive Loop

Codex receives work with `aun drain`:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts drain \
  --agent-id codex-aun \
  --limit 10
```

Single-message receive remains available for diagnosis:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts receive \
  --agent-id codex-aun
```

`inbox` is not a receive path. It must not be required for Codex to claim work.

The drain result is part of the runtime contract. Codex adapters must retain at
least:

- `queue_id`
- `message_id`
- `channel_id`
- `thread_id`
- sender agent id
- received content

For long-running reviews, `queue_id` and `message_id` must survive summarization
and task handoff. They are the durable identifiers needed by the reply close
path after claim TTL expiration.

## Standard Reply Path

Codex replies first with `aun reply`:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts reply \
  --agent-id codex-aun \
  --mentions codex-cto \
  --content "..."
```

When #404 lands, long-running Codex work must be able to close by explicit
queue identity:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts reply \
  --agent-id codex-aun \
  --queue-id 71552 \
  --message-id a94c8fd7-1dfe-411c-a34b-9d065cd39931 \
  --mentions codex-cto \
  --content "..."
```

`--message-id` is optional only if the CLI contract explicitly allows it, but
Codex adapters should keep and pass both identifiers when available. A mismatch
must fail closed rather than replying to the wrong work item.

## Notify Fallback Policy

`aun notify` is not a reply substitute. It creates a new message and must not
close queue rows.

Before #404 durable close support is available, Codex may use notify fallback
only when all of the following are true:

- `aun reply` failed with `INVALID_REPLY_TO` or
  `CLAIM_EXPIRED_OR_MISSING`.
- The operator explicitly needs a visible status update.
- The fallback content states that the reply claim expired or the durable close
  path is unavailable.

After #404 durable close support is available, Codex must prefer:

```text
reply --queue-id [--message-id]
```

over notify fallback for long reviews. Notify remains appropriate for
self-originated status, startup, watchdog, and out-of-band messages only.

## Failure-Code Handling

Codex adapters should branch on stable machine-readable codes.

| Code | Codex behavior |
|---|---|
| `CLAIM_EXPIRED` | Retry with explicit `reply --queue-id --message-id`. |
| `CLAIM_EXPIRED_OR_MISSING` | Before #404, notify only if a visible fallback is required; after #404, retry explicit close. |
| `INVALID_REPLY_TO` | Treat as legacy active-claim failure; retry explicit close when queue identity is available. |
| `RECLAIM_REQUIRED` | Retry explicit close with retained `queue_id`. |
| `ALREADY_CLOSED` | Do not retry; report closing metadata. |
| `NOT_CLAIM_OWNER` | Do not steal; report conflict and wait or escalate. |
| `NOT_MENTIONED` | Do not retry without routing or queue correction. |
| `NOT_CHANNEL_MEMBER` | Report channel membership issue. |
| `QUEUE_MESSAGE_MISMATCH` | Stop and correct retained identifiers. |
| `QUEUE_NOT_FOUND` | Stop and report stale or incorrect queue identity. |
| `NOTIFY_IS_NOT_REPLY` | Use `reply`, not `notify`, for queue close. |

Unexpected or unstructured errors should be reported without falling back to
notify automatically.

## #404 Acceptance Criteria From Codex

#404 is acceptable for Codex runtime usage when these user-side behaviors are
true:

- `aun drain` returns `queue_id` and `message_id` for every claimed item.
- `aun reply --queue-id <id>` can close a Codex-owned work item after the
  original claim TTL has expired.
- `aun reply --queue-id <id> --message-id <uuid>` verifies both identifiers
  identify the same queue row.
- Active-claim reply without explicit queue id remains compatible for short
  work.
- A row actively claimed by another agent fails with a stable conflict code and
  is not stolen.
- `aun notify` rejects queue-close flags and never marks queue rows replied.
- Reply failures return JSON with `ok:false`, `code`, and enough context for a
  Codex script to choose retry, wait, or operator escalation.
- No #404 contract test touches the operator's production PostgreSQL socket by
  default.
- The implementation does not require state-daemon rewrites, queue close
  semantic changes outside the durable reply path, or changes to another
  agent's worktree.

## Bootstrap For Other Repositories

Before enabling AUN for another Codex repo:

1. Create a dedicated AUN CLI checkout under that Codex workspace.
2. Update it to `origin/main` with a clean worktree.
3. Verify `bun bin/aun.ts --help` lists `receive`, `drain`, `reply`, and
   `notify`.
4. Run `drain --limit 10` with matching `AGENT_ID` and
   `AGENT_COM_EXPECTED_AGENT_ID`.
5. Send a short `reply` and verify the receiver observed it.
6. Document the dedicated checkout path and the expected agent id.
7. Do not use another agent's worktree as the runtime command source.

## Future Global Wrapper

A later installer may provide a global `aun` wrapper for Codex sessions. That
wrapper should be a thin launcher around the same contract:

- resolve the configured dedicated checkout for the current Codex agent
- set `AGENT_ID` and `AGENT_COM_EXPECTED_AGENT_ID` to the same configured value
- set the approved local socket `DATABASE_URL` unless explicitly overridden
- execute `receive`, `drain`, `reply`, or `notify` without tmux text injection
- refuse to run from or mutate another agent's worktree

The wrapper must not hide `queue_id` or `message_id` from Codex. Durable queue
identity remains part of the runtime adapter boundary.
