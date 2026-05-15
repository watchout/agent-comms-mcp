# Durable Reply Close Path

Issue: #401

## Decision

Long-running reviews need a durable reply close path that does not treat a
short claim TTL as the only proof of reply authority.

The public invariant is:

```text
claim = concurrency control
reply authority = routed queue identity + agent identity + channel membership
```

`notify` remains a new-message operation. It must never close a queue row,
update `replied_at`, or set `replied_with`.

`reply` remains the queue-closing operation. It must be able to close an
intended row by explicit `queue_id` and/or `message_id` after validating that
the caller is the routed agent for that queue item and is permitted to reply in
the destination channel.

## Problem

The current CLI reply path is claim-relative:

1. `next` claims a `message_queue` row and marks it `received`.
2. `send` finds the caller's active `received` claim.
3. `send` posts a reply and marks that queue row `replied`.

That is correct for short work, but long reviews can exceed the claim TTL. Once
the row is reclaimed or no longer active, the reply path fails with
`INVALID_REPLY_TO`. Operators then have a tempting fallback: `notify`. That
posts a visible message, but it does not close the original queue row. The
result is public conversation drift and private queue-state drift.

The durable close design separates "who may reply to this work item" from "who
currently holds the short-lived processing lock."

## Non-Negotiable Invariants

1. `notify` is not a reply.
   - It creates a new outbound message.
   - It does not require or consume `queue_id`.
   - It does not mutate `message_queue` close state.
   - Passing `--reply-to` or `--queue-id` to notify must fail closed.

2. `reply` is explicit and close-capable.
   - It can target the active claim, as today.
   - It can target `--queue-id <id>` and/or `--message-id <uuid>`.
   - If both are supplied, they must identify the same queue row.
   - Success writes `agent_messages`, enqueues outbound delivery, then marks
     the target row `replied` with `replied_at` and `replied_with`.

3. A claim is a lock, not a capability token.
   - Active `claimed_by = agent_id` is sufficient to reply.
   - Expired or missing claim is not automatically sufficient to reject a
     reply if explicit queue identity and permission checks pass.
   - A different active owner is still a hard conflict.

4. Close is idempotent and observable.
   - Already closed rows return `ALREADY_CLOSED` with the closing message id
     when known.
   - Ambiguous queue identity returns a machine-readable error, not a best
     effort notify.
   - Every failure code is stable enough for scripts to branch on.

5. Tests must not touch production DB.
   - Contract tests use isolated SQLite or disposable PostgreSQL fixtures.
   - Tests seed their own `agents`, `channels`, `agent_messages`, and
     `message_queue` rows.
   - Tests must prove no accidental notify fallback closes a queue item.

## Initial Implementation Scope

Initial implementation should include:

- explicit reply close by `queue_id`
- optional cross-check by `message_id`
- claim conflict detection
- bounded reclaim-at-close for expired/self-owned or unowned rows
- machine-readable failure codes
- isolated DB contract tests

Initial implementation should not include:

- DB migrations
- `state-daemon` rewrite
- heartbeat-driven claim extension
- long-lived claim leases stored outside `message_queue`
- silent conversion of notify into reply

### Why Bounded Reclaim First

For #401, bounded reclaim-at-close is the smallest safe bridge:

- It fixes the operator-visible long-review failure.
- It keeps the durable authority check in one close transaction.
- It does not require background heartbeats to be correct before reply close is
  reliable.
- It preserves the existing claim TTL as a concurrency lock.

Claim extension and heartbeat refresh are useful later, but they solve a
different problem: keeping work visibly active while processing continues. They
should be designed after the durable close path exists, because extending a
claim still does not define reply authority when the runtime loses state.

## Proposed CLI Surface

```bash
aun reply \
  --agent-id agent-com-dev \
  --queue-id 71496 \
  --message-id e0d15adb-b43f-43a0-8cb6-eb00bd147a3b \
  --content "done" \
  --mentions codex-cto
```

`--message-id` is optional when `--queue-id` is supplied, but recommended for
human-visible audit logs. If both are present, mismatch returns
`QUEUE_MESSAGE_MISMATCH`.

The lower-level `agent-com send` command may expose the same fields, but the
public AUN wrapper should be the stable operator entry point.

## Close Transaction

The close path should run in one DB transaction:

1. Resolve target row:
   - by `queue_id`, or
   - by `(agent_id, message_id)` when queue id is absent.

2. Lock the row:
   - PostgreSQL: `FOR UPDATE`
   - SQLite: adapter transaction with equivalent write serialization

3. Validate identity:
   - `message_queue.agent_id = caller agent_id`
   - if `claimed_by` is set and different from caller while status is active,
     fail with `NOT_CLAIM_OWNER`
   - if status is terminal, fail with `ALREADY_CLOSED`

4. Validate route/permission:
   - payload channel must resolve to a channel containing the caller, or to a
     permitted DM/system route
   - mentions must resolve through the existing send/route policy
   - no channel membership means `NOT_MENTIONED` or `NOT_CHANNEL_MEMBER`

5. Reclaim if needed:
   - if row is `pending` or `received` with no active owner, set
     `claimed_by = caller`, refresh `claimed_at`, and set a short
     `claim_expires_at`
   - if row is `received` by caller but expired, refresh the claim inside the
     same transaction before close
   - if row is actively held by another owner, fail `NOT_CLAIM_OWNER`

6. Insert outbound reply:
   - create `agent_messages` for the reply
   - enqueue `outbound_queue`
   - preserve current send semantics for channel/thread/reply projection

7. Close queue row:
   - set `status = 'replied'`
   - set `replied_at = now()`
   - set `replied_with = reply message id`

8. Commit and return structured JSON.

## Failure Codes

All failures should return JSON with `ok: false`, `code`, and enough context for
scripts to decide whether to retry, reclaim, or escalate.

| Code | Meaning | Retry policy |
|---|---|---|
| `CLAIM_EXPIRED` | Active claim was held by caller but expired before close. | Retry via explicit close path. |
| `RECLAIM_REQUIRED` | Row is reclaimable but caller did not opt into durable close. | Retry with explicit `queue_id` close. |
| `ALREADY_CLOSED` | Row is already `replied` or otherwise terminal. | Do not retry; surface closing metadata. |
| `NOT_CLAIM_OWNER` | Another agent owns an active claim. | Do not steal; wait or escalate. |
| `NOT_MENTIONED` | Caller is not the routed recipient for this queue item. | Do not retry without route change. |
| `NOT_CHANNEL_MEMBER` | Caller cannot reply in destination channel. | Fix channel membership. |
| `QUEUE_MESSAGE_MISMATCH` | Supplied queue id and message id disagree. | Correct operator input. |
| `QUEUE_NOT_FOUND` | No target row exists. | Correct operator input or history lookup. |
| `NOTIFY_IS_NOT_REPLY` | Notify was asked to close a queue item. | Use reply. |

`INVALID_REPLY_TO` should remain for legacy active-claim send failures, but AUN
wrappers should translate it into a more specific durable-close hint when the
operator supplied enough identity to close safely.

## Contract Test Matrix

Use isolated DB fixtures only.

Required tests:

- `notify --queue-id` fails with `NOTIFY_IS_NOT_REPLY` and leaves queue rows
  unchanged.
- active claim by caller closes by `queue_id`.
- expired claim by caller closes by explicit `queue_id`.
- unclaimed pending row for caller closes by explicit `queue_id`.
- row actively claimed by another agent fails `NOT_CLAIM_OWNER`.
- already replied row fails `ALREADY_CLOSED` and returns `replied_with`.
- queue id and message id mismatch fails `QUEUE_MESSAGE_MISMATCH`.
- missing queue id fails `QUEUE_NOT_FOUND`.
- caller not matching `message_queue.agent_id` fails `NOT_MENTIONED`.
- non-member caller fails `NOT_CHANNEL_MEMBER`.
- no test connects to the production PostgreSQL socket or uses the operator's
  default `DATABASE_URL`.

Optional PostgreSQL parity tests can run against disposable CI services, but the
core contract must pass on SQLite to keep local OSS installs safe.

## Relationship To #400

#400 adds batch receive/drain. This design does not modify that surface.

The durable reply close path should compose with drain:

- drain claims or observes work in batches
- long-running runtime processing may exceed TTL
- reply close targets the original queue row explicitly
- notify remains available for out-of-band status but never closes the drained
  work item

## Rollout Plan

1. Land this design PR as public contract.
2. Add contract tests for the failure-code matrix.
3. Implement explicit close in the lower-level send path or a dedicated helper.
4. Expose stable AUN wrapper flags.
5. Update operator docs to prefer `aun reply --queue-id` for long reviews.
6. Later, design heartbeat/claim extension as observability and scheduling
   improvements, not as the sole reply authority mechanism.
