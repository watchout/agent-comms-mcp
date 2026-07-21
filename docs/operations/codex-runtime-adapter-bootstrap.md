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
- `claim_lease.runtime_instance_id`
- `claim_lease.claim_expires_at`

For long-running reviews, `queue_id` and `message_id` must survive summarization
and task handoff. The lease expiry and runtime instance must survive with them.
These values distinguish a live claimant from an expired or fenced runtime.

## Keep A Live Claim Renewed

After targeted work enters `received`, mark it `in_progress` and renew it before
the current lease expires:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
AGENT_COM_RUNTIME_INSTANCE_ID="<runtime-instance-id>" \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts processing \
  --agent-id codex-aun \
  --queue-id 71552

AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
AGENT_COM_RUNTIME_INSTANCE_ID="<runtime-instance-id>" \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts renew-claim \
  --agent-id codex-aun \
  --queue-id 71552 \
  --reason "long-running review"
```

Renewal is exact-row, same-owner, same-runtime, and live-lease only. Success
returns `prior_claim_expires_at`, `new_claim_expires_at`, the runtime instance,
and `queue.claim_renewed` audit evidence. `CLAIM_EXPIRED` and `CLAIM_FENCED`
must fail without reply, close, or outbound projection.

## Exact Recovery After Expiry

An expired `in_progress` row must not be renewed or closed directly. Copy both
`queue_id` and `expected_claim_expires_at` from the `CLAIM_EXPIRED` result and
preview the exact row:

```bash
AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/cli/index.ts queue reclaim-expired \
  --agent-id codex-aun \
  --queue-id 71552 \
  --expected-claim-expires-at 2026-07-21T00:00:00.000Z \
  --dry-run
```

After confirming that the preview names exactly one intended expired row, use
the same immutable fence values with `--execute`:

```bash
AGENT_ID=codex-aun \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/cli/index.ts queue reclaim-expired \
  --agent-id codex-aun \
  --queue-id 71552 \
  --expected-claim-expires-at 2026-07-21T00:00:00.000Z \
  --execute
```

Success moves only that row to `pending`, clears the old claim and runtime
fence, and writes `queue.reclaim_expired` audit evidence. It does not create a
message, enqueue outbound delivery, reply, or close work. Reclaim the same row
through the normal targeted receive path before processing or replying:

```bash
AGENT_ID=codex-aun \
AGENT_COM_EXPECTED_AGENT_ID=codex-aun \
AGENT_COM_RUNTIME_INSTANCE_ID="<new-runtime-instance-id>" \
DATABASE_URL="postgresql:///agent_comms?host=/tmp" \
bun /Users/yuji/Developer/codex-aun/agent-comms-mcp-main/bin/aun.ts receive \
  --agent-id codex-aun \
  --queue-id 71552
```

If the expected timestamp is absent or differs from the locked row, the command
returns `CLAIM_FENCE_REQUIRED` or `CLAIM_FENCE_MISMATCH` and changes nothing.
Never replace exact recovery with a bulk `in_progress` reclaim.

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

Long-running Codex work closes by explicit queue identity only while the caller
holds the current live claim. An expired row must complete the exact recovery
and targeted receive sequence above first:

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

## Notify Policy

`aun notify` is not a reply substitute. It creates a new message and must not
close queue rows.

Codex must not use notify after `CLAIM_EXPIRED`, `CLAIM_FENCED`,
`CLAIM_EXPIRED_OR_MISSING`, or another reply failure. Notify remains appropriate
only for self-originated status, startup, watchdog, and genuinely out-of-band
messages that do not claim to answer or close a queue item.

## Failure-Code Handling

Codex adapters should branch on stable machine-readable codes.

| Code | Codex behavior |
|---|---|
| `CLAIM_EXPIRED` | Stop reply/close. Use the returned exact `queue_id` and `expected_claim_expires_at` for fenced recovery, then targeted receive. |
| `CLAIM_FENCED` | Stop. This runtime is stale and must not retry, reply, close, or notify. |
| `CLAIM_FENCE_REQUIRED` | Supply both exact fence inputs from `CLAIM_EXPIRED`; no state changed. |
| `CLAIM_FENCE_MISMATCH` | Stop and re-read current state; the row or lease changed and no state was mutated. |
| `CLAIM_EXPIRED_OR_MISSING` | Treat as legacy active-claim failure; diagnose the exact queue row and do not notify. |
| `INVALID_REPLY_TO` | Treat as legacy active-claim failure; diagnose the retained queue identity and do not notify. |
| `RECLAIM_REQUIRED` | Use exact fenced recovery when the row is expired; do not retry close directly. |
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
- A live same-owner, same-runtime claim renews only through exact
  `aun renew-claim --queue-id <id>`.
- An expired `in_progress` item requires exact `queue_id` plus
  `expected_claim_expires_at` fenced recovery, followed by targeted receive,
  before reply-close.
- A stale runtime is fenced before any message or outbound write.
- `aun reply --queue-id <id> --message-id <uuid>` verifies both identifiers
  identify the same queue row.
- Active-claim reply without explicit queue id remains compatible for short
  work.
- A row actively claimed by another agent fails with a stable conflict code and
  is not stolen.
- `aun notify` rejects queue-close flags and never marks queue rows replied.
- Notify absence or failure does not change durable reply-close evidence.
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
