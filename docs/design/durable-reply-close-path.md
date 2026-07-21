# Durable Reply Close Path

Issues: #401, #881

## Decision

Long-running work uses a renewable lease and a runtime fence. Explicit queue
identity selects the intended row, but does not let an expired or stale runtime
revive and close it.

The current public invariant is:

```text
live reply authority
  = routed queue identity
  + agent identity and channel membership
  + current claim owner
  + current runtime fence
  + unexpired lease

expired recovery
  = exact queue_id
  + exact expected_claim_expires_at
  + compare-and-swap to pending
  + targeted receive by the next runtime
```

`reply` is the only queue-closing message operation. `notify` remains a new,
out-of-band message operation and is neither required for nor evidence of a
durable terminal close.

## Problem

The current CLI reply path is claim-relative:

1. `next` claims a `message_queue` row and marks it `received`.
2. `send` finds the caller's active `received` claim.
3. `send` posts a reply and marks that queue row `replied`.

That is correct for short work, but long reviews can exceed the claim TTL. A
runtime may also be replaced while the original process still has queue ids in
memory. Allowing either process to revive the old claim at reply time creates a
stale-writer and duplicate-terminal risk.

The current design renews a live same-owner claim during processing, rejects an
expired or stale runtime before message/outbound projection, and requires exact
fenced recovery before another runtime receives the row.

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
   - Explicit identity never bypasses the live lease or runtime fence.
   - Success writes `agent_messages`, enqueues outbound delivery, then marks
     the target row `replied` with `replied_at` and `replied_with`.

3. A claim is a fenced, renewable lock.
   - A live claim renews only for the exact `queue_id`, same agent, and same
     runtime instance.
   - Renewal fails after expiry; reply-close cannot renew implicitly.
   - A stale runtime fails `CLAIM_FENCED` before message or outbound writes.
   - An expired row returns its exact lease timestamp as
     `expected_claim_expires_at` for recovery.

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

6. Notify is outside the terminal proof.
   - Notify absence or delivery failure does not block durable reply-close.
   - Notify success does not prove that the queue row closed.
   - A reply error must never be converted into notify automatically.

## Lease Lifecycle

1. `receive` establishes `claimed_by`, `claim_expires_at`, and the current
   `claimed_runtime_instance_id` when runtime evidence is available.
2. `processing` advances `received` to `in_progress` and renews a live lease.
   Repeated `processing` heartbeats may renew the same exact live row.
3. `renew-claim --queue-id <id>` extends only a live `received` or
   `in_progress` same-owner claim for the same runtime instance.
4. `reply` or `done` rejects expired work with `CLAIM_EXPIRED` and rejects a
   displaced runtime with `CLAIM_FENCED` before any terminal effect.
5. Exact recovery moves one expired row back to `pending` only when both
   `queue_id` and `expected_claim_expires_at` still match under lock.
6. A targeted `receive --queue-id <id>` establishes the next live claim. Only
   then may processing and reply-close continue.

Bulk legacy reclaim is `received`-only. It never selects `in_progress` rows.

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

5. Validate the lease and runtime fence:
   - current runtime must match `claimed_runtime_instance_id` when present
   - `claim_expires_at` must be present and later than current time
   - an expired lease fails `CLAIM_EXPIRED`; it is not refreshed in the close
     transaction
   - a mismatched runtime fails `CLAIM_FENCED`

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
| `CLAIM_EXPIRED` | The selected claim expired before renewal or close. | Stop terminal work; exact fenced recovery, then targeted receive. |
| `CLAIM_FENCED` | Another runtime instance owns the current fence. | Stop; stale runtime must not retry or notify. |
| `CLAIM_FENCE_REQUIRED` | Exact recovery omitted `queue_id` or `expected_claim_expires_at`. | Supply both values from the expiry evidence. |
| `CLAIM_FENCE_MISMATCH` | The row, state, or lease timestamp changed. | Stop and re-read; no mutation occurred. |
| `RECLAIM_REQUIRED` | Legacy active-claim reply has no current row. | Diagnose exact queue state; never close an expired row directly. |
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
- live claim renews only for exact same-owner, same-runtime `queue_id`.
- expired claim cannot renew, reply, or close.
- stale runtime fails before message and outbound projection.
- exact recovery requires matching `queue_id` and
  `expected_claim_expires_at`, then clears the old runtime fence.
- a mismatched expected expiry changes no state.
- row actively claimed by another agent fails `NOT_CLAIM_OWNER`.
- already replied row fails `ALREADY_CLOSED` and returns `replied_with`.
- queue id and message id mismatch fails `QUEUE_MESSAGE_MISMATCH`.
- missing queue id fails `QUEUE_NOT_FOUND`.
- caller not matching `message_queue.agent_id` fails `NOT_MENTIONED`.
- non-member caller fails `NOT_CHANNEL_MEMBER`.
- no test connects to the production PostgreSQL socket or uses the operator's
  default `DATABASE_URL`.
- exactly one terminal reply and outbound projection exist after a successful
  recovery, targeted receive, and retry.
- notify remains absent from the successful terminal path.

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

## Operator Recovery Sequence

```text
CLAIM_EXPIRED(queue_id, expected_claim_expires_at)
  -> exact reclaim dry-run
  -> exact reclaim execute with the same two values
  -> row is pending and old runtime fence is cleared
  -> targeted receive of the same queue_id
  -> processing / live renewal
  -> exactly one reply-close
```

Every arrow is fail-closed. A failure before targeted receive produces no
reply, no close, and no outbound projection. A notification is not part of the
sequence.
