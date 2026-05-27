# AUN Logical Thread Reply Contract

Issue: #576

Status: proposed

Last updated: 2026-05-28

## Summary

AUN needs a first-class logical thread layer above messages and queue rows.

The current reply model is still too easy to misuse because the LLM can combine
independent inputs:

```text
content = answer to A/alpha
reply_to = message for B/beta
mention = A
```

That produces a visible reply that may be addressed to A while attached to the
wrong parent message or work item. A valid reply chain cannot allow the parent,
recipient, and content scope to be chosen independently by the LLM.

This spec promotes AUN-owned logical threads to the durable unit for reply,
task, PR, UI, and archive workflows:

```text
channel
  -> logical_thread
      -> agent_messages
          -> message_queue rows
```

Normal queue replies become:

```text
reply(queue_id, content)
```

The server derives the parent message, destination, UI projection, and queue
close target from `queue_id`. The LLM supplies only the reply body.

## Problem Statement

AUN already stores `agent_messages.reply_to`, and `next` can return a bounded
reply chain. That is useful context, but it is not a sufficient operational
unit.

The unsafe failure mode is:

1. A sends alpha.
2. B sends beta.
3. The bot claims or remembers the wrong queue item.
4. The bot sends alpha's answer while attaching it to B/beta, or selects A as
   recipient while closing B's queue row.

The root cause is not only prompt quality. It is a data-model and API boundary
problem: a reply operation currently accepts caller-controlled pieces that must
instead be derived from one queue-owned work item.

## Design Goals

1. Make the logical work unit explicit and durable.
2. Prevent cross-thread reply drift by construction.
3. Let Web UI, Discord, and future app surfaces project the same AUN thread.
4. Let unresolved queues, tasks, and PRs block archive/close.
5. Keep `notify`, `reply`, and `forward/quote` semantically distinct.
6. Preserve `agent_messages.reply_to` as the message-level parent link.
7. Avoid making Discord native thread IDs the AUN primary key.

## Non-Goals

1. This spec does not implement the full migration.
2. This spec does not require every Discord message to create a native Discord
   thread immediately.
3. This spec does not remove legacy `send(reply_to, mention, content)` in one
   step.
4. This spec does not make the LLM responsible for selecting destinations in
   normal reply mode.

## Terminology

`logical_thread`

: An AUN-owned conversation/work unit. It groups messages, queue rows, tasks,
  PRs, and UI projection bindings.

`root_message`

: The first message that created a logical thread.

`parent_message`

: The immediate message being answered. This is represented by
  `agent_messages.reply_to`.

`queue item`

: A `message_queue` row assigning one agent the right/responsibility to process
  one message in one logical thread.

`reply target`

: The logical recipient derived from the queue item's parent/root context. This
  may be an AUN agent id, an external user id, or relay-origin metadata.

`projection`

: A UI/platform representation of an AUN logical thread, for example a Discord
  native thread or a Web UI thread route.

## Data Model

### logical_threads

The concrete table name may be `threads` if that is the existing canonical name.
The important contract is that this row is the AUN-owned thread SSOT.

```sql
CREATE TABLE logical_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  root_message_id UUID UNIQUE,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'active', 'waiting', 'resolved', 'archived')),
  owner_agent_id TEXT REFERENCES agents(agent_id),
  reply_target_agent_id TEXT REFERENCES agents(agent_id),
  reply_target_external_id TEXT,
  reply_target_source TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ
);
```

Required semantics:

- `channel_id` is the canonical channel containment boundary.
- `root_message_id` points to the first `agent_messages` row after both rows
  exist.
- `reply_target_agent_id` is preferred when the requester maps to a registered
  AUN agent.
- `reply_target_external_id` preserves external human/user identity when no AUN
  agent row exists.
- `reply_target_source` records how the target was derived, for example
  `author`, `relay_originator`, `manual`, or `system`.
- `status='archived'` removes the thread from default active views and normal
  notification loops.

### thread_adapters

Platform-specific thread identifiers are projection data.

```sql
CREATE TABLE thread_adapters (
  thread_id UUID NOT NULL REFERENCES logical_threads(id),
  platform TEXT NOT NULL,
  external_id TEXT NOT NULL,
  channel_external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, platform)
);
```

Rules:

- Discord native thread id belongs here, not in `message_queue`.
- A Web UI thread route may also be represented here if needed, but Web UI may
  use the AUN thread id directly.
- Multiple projection bindings may exist over time, but only one active binding
  per `(thread_id, platform)` is allowed unless an explicit versioning column is
  added.

### agent_messages

`agent_messages` remains the canonical message table.

Required changes:

```sql
ALTER TABLE agent_messages
  ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES logical_threads(id);
```

Existing `reply_to` remains the immediate parent message link.

Required semantics:

- `thread_id` groups messages into the work unit.
- `reply_to` links one message to its parent message.
- If `reply_to` is not null, the child message's `thread_id` must equal the
  parent message's `thread_id`.
- If the message is the root, `reply_to` is null and
  `logical_threads.root_message_id` points to it.

### message_queue

`message_queue` represents work assignment, not destination selection.

Required changes:

```sql
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES logical_threads(id);
```

Required semantics:

- `message_queue.thread_id` must match `agent_messages.thread_id` for
  `message_queue.message_id`.
- `message_queue.agent_id` is the assigned processing agent.
- A queue row grants reply authority only for its own `(thread_id, message_id,
  agent_id)` tuple.
- `message_queue.payload.channel_id` may remain during migration, but it is not
  the SSOT for reply routing once `thread_id` is present.

### thread_tasks

Task/PR leakage must be observable from thread state.

```sql
CREATE TABLE thread_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES logical_threads(id),
  title TEXT NOT NULL,
  owner_agent_id TEXT REFERENCES agents(agent_id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  repo TEXT,
  branch TEXT,
  pr_url TEXT,
  due_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This table is optional for the first implementation slice, but the thread
contract must reserve the integration point.

## Core Invariants

### Reply Invariant

Normal replies consume `queue_id`.

```text
reply(queue_id, content)
```

The server must derive:

- `thread_id` from `message_queue.thread_id`
- parent message from `message_queue.message_id`
- channel from `logical_threads.channel_id`
- reply target from thread/message metadata
- native Discord reply id from the parent message projection
- queue close target from `message_queue.id`

The LLM must not provide `reply_to`, `mention`, `mentions`, `channel`, or
`thread_id` for normal reply mode.

### Containment Invariant

A message created by `reply(queue_id, content)` must be inserted into the same
logical thread as the queue row.

```text
new_message.thread_id = queue.thread_id
new_message.reply_to = queue.message_id
```

The reply must close exactly the consumed queue row.

```text
closed_queue.id = queue_id
closed_queue.replied_with = new_message.id
```

### Recipient Invariant

The normal reply recipient is derived from the queued source message and thread
reply target. Caller-provided recipient overrides are invalid in reply mode.

Priority order:

1. `logical_threads.reply_target_agent_id`
2. relay/originator metadata on the parent/root message
3. parent message author resolved to an AUN agent
4. `logical_threads.reply_target_external_id` for platform-only replies

If none resolve, the reply may still be projected as a native platform reply
when a parent platform message exists, but it must not create an agent queue row
for an unknown recipient.

### Projection Invariant

AUN logical thread id is canonical. Platform thread ids are projections.

For Discord:

- If a `thread_adapters` row exists, outbound messages should be posted into
  that Discord thread.
- If no Discord thread projection exists, the adapter may create one according
  to channel policy or reply inline to the parent message.
- The outbound Discord native `reply_to` must be the parent message's
  `discord_message_id` when available.
- The adapter must not fall back to "latest message in channel" for replies
  created from `queue_id`.

### Archive Invariant

Archive is blocked by active work unless an operator explicitly overrides.

Default archive blockers:

- pending/received/in_progress queue rows in the thread
- open/in_progress/blocked `thread_tasks`
- open PR metadata linked through `thread_tasks.pr_url`
- unresolved human-rooted terminal baton requirements

Archived threads:

- are hidden from active default UI views
- do not receive normal reply operations
- may be reopened before a new reply is accepted

## API Contract

### next

`next` returns one queued message plus thread context.

Response additions:

```typescript
interface NextResponse {
  queue_id: string;
  message_id: string;
  thread_id: string;
  channel_id: string;
  content: string;
  from: string;
  reply_chain: ReplyChainEntry[];
  thread: {
    id: string;
    title: string | null;
    status: 'open' | 'active' | 'waiting' | 'resolved' | 'archived';
    root_message_id: string;
    reply_target_agent_id: string | null;
    reply_target_external_id: string | null;
  };
}
```

`channel_id` may remain in the response for diagnostics and legacy clients, but
reply code must use `queue_id` rather than trusting caller-supplied channel
values.

### reply

New canonical tool:

```typescript
reply({
  queue_id: string;
  content: string;
  message_type?: 'chat' | 'report' | 'approval' | 'instruction' | 'emergency';
  metadata?: object;
})
```

Behavior:

1. Lock `message_queue.id = queue_id`.
2. Validate `message_queue.agent_id = caller`.
3. Validate status is active or safely reclaimable by the caller.
4. Load `logical_threads.id = queue.thread_id`.
5. Reject if thread is archived unless `reopen` happened first.
6. Load parent `agent_messages.id = queue.message_id`.
7. Insert outbound `agent_messages` with same `thread_id` and
   `reply_to = queue.message_id`.
8. Enqueue platform delivery using thread projection and parent native reply id.
9. Mark exactly that queue row `replied`.

Failure codes:

| Code | Meaning |
|---|---|
| `QUEUE_NOT_FOUND` | No queue row exists for `queue_id`. |
| `NOT_QUEUE_OWNER` | Queue row belongs to another agent. |
| `THREAD_NOT_FOUND` | Queue row has no resolvable logical thread. |
| `PARENT_MESSAGE_NOT_FOUND` | Queue row message is missing. |
| `THREAD_MISMATCH` | Queue thread and parent message thread disagree. |
| `THREAD_ARCHIVED` | Thread is archived and must be reopened first. |
| `ALREADY_CLOSED` | Queue row is terminal. |
| `ACTIVE_CLAIM_CONFLICT` | Another runtime owns the active claim. |
| `REPLY_TARGET_UNRESOLVED` | No logical or platform reply target exists. |
| `OUTBOUND_ENQUEUE_FAILED` | Reply row could not be projected. |

### send

Legacy `send(reply_to, mention, content)` remains compatibility only.

Migration requirements:

- If called while the caller has a current active queue row, `reply_to` must
  match that queue row's `message_id`; otherwise reject with
  `QUEUE_REPLY_MISMATCH`.
- Caller-provided `mention`/`mentions` must not override the reply recipient
  when a queue-derived reply target exists.
- Success responses should include a deprecation hint pointing to
  `reply(queue_id, content)`.

### notify

`notify` is new-thread creation.

Behavior:

1. Resolve destination channel from caller input and policy.
2. Create a new logical thread.
3. Insert root `agent_messages` row.
4. Set `logical_threads.root_message_id`.
5. Enqueue queue rows for recipients according to routing policy.

`notify` must not close queue rows.

### forward / quote

Cross-agent delegation is not a reply. It must create a new queue item while
preserving provenance.

```typescript
forward({
  queue_id: string;
  to: string;
  comment?: string;
})
```

Behavior:

- Preserve source `thread_id` unless an explicit cross-thread delegation mode is
  selected.
- Insert a child message or baton message linked to the parent.
- Create a queue row for the target agent.
- Do not close the original queue row unless the operation explicitly records a
  durable baton close according to the terminal baton invariant.

### close / resolve / archive

Thread lifecycle commands:

```typescript
resolve_thread({ thread_id: string, reason?: string })
archive_thread({ thread_id: string, force?: boolean, reason?: string })
reopen_thread({ thread_id: string, reason?: string })
```

Rules:

- `resolve_thread` marks the thread resolved but does not hide it from history.
- `archive_thread` hides the thread from active views.
- Archive fails with `THREAD_HAS_ACTIVE_WORK` if blockers exist and `force` is
  not true.
- `reopen_thread` returns `archived/resolved -> active`.

## Receive Flow

### New external message

If an inbound message has no resolvable parent:

1. Create logical thread.
2. Insert root `agent_messages` with `thread_id`.
3. Set `logical_threads.root_message_id`.
4. Derive initial reply target from author/originator.
5. Create queue rows with matching `thread_id`.

### External reply

If an inbound message references an existing platform message:

1. Resolve platform message id to parent `agent_messages.id`.
2. Use parent `agent_messages.thread_id`.
3. Insert child `agent_messages` with same `thread_id` and
   `reply_to = parent.id`.
4. Create queue rows with matching `thread_id`.

If parent resolution fails:

- Create a new logical thread.
- Record orphan metadata with the unresolved platform parent id.
- Do not attach the message to an arbitrary latest thread.

## UI Projection

### Web UI

The Web UI should use AUN `logical_threads.id` directly.

Default views:

- Inbox: threads with pending work for the current agent.
- Active: open/active/waiting threads with unresolved queues/tasks.
- Resolved: resolved but not archived threads.
- Archived: archived history.

Thread detail view should show:

- message timeline
- queue rows and status
- linked tasks/PRs
- reply target
- projection bindings
- archive blockers

### Discord

Discord native threads are projections.

Policy options:

- `create_discord_thread_on_root=true`: create a Discord thread for each AUN
  root thread when channel supports it.
- `reply_inline_until_threshold=N`: keep short one-off threads inline unless
  message count exceeds N.
- `never_create_discord_thread`: project as native replies only.

Regardless of projection policy, outbound replies from `queue_id` must use the
parent message as the native reply reference when available.

## Migration Plan

### Phase 0: Spec and audit

- Land this spec.
- Audit current paths where `reply_to`, `mention`, `channel_id`, or latest
  Discord message fallback can be selected independently.
- Identify tables already named `threads` and `thread_adapters`.

### Phase 1: Add logical thread columns

- Add or normalize `logical_threads`.
- Add `agent_messages.thread_id`.
- Add `message_queue.thread_id`.
- Backfill thread rows from existing root messages and `reply_to` chains.
- Add consistency checks in tests before enforcing DB constraints.

### Phase 2: Introduce canonical reply tool

- Add `reply(queue_id, content)`.
- Keep legacy `send` but mark it compatibility.
- Update `next` to return `thread` metadata.
- Add machine-readable failure codes.

### Phase 3: Projection hardening

- Ensure Discord outbound from `reply` never falls back to latest channel
  message.
- Persist or reuse `thread_adapters` for Discord native threads.
- Add Web UI projection contract.

### Phase 4: Archive and task gates

- Add thread lifecycle commands.
- Add archive blocker checks.
- Add `thread_tasks` integration for PR/task leakage detection.

### Phase 5: Legacy restriction

- Reject queue replies through `send` when `reply_to`, `mention`, or channel
  overrides do not match the caller's active queue context.
- Move normal bot templates and hooks to `reply(queue_id, content)`.

## Contract Test Matrix

Required tests:

1. A/alpha queue reply inserts a child message with the same `thread_id` and
   `reply_to = alpha.id`.
2. A/alpha reply cannot close B/beta queue row.
3. Caller-provided `mention=B` is ignored or rejected when `queue_id` points to
   A/alpha.
4. Caller-provided `reply_to=beta.id` is rejected when `queue_id` points to
   alpha.
5. Discord reply projection uses alpha's `discord_message_id`, not latest
   channel message.
6. External reply with resolvable parent joins parent thread.
7. External reply with orphan parent creates a new thread with orphan metadata.
8. `notify` creates a new logical thread and does not close any queue row.
9. `forward` creates a durable baton queue row without pretending to be a
   normal reply.
10. Archive fails when pending queue rows exist.
11. Archive fails when open thread tasks exist.
12. Reopen allows reply after archive.

## Open Decisions

1. Whether the physical table should be named `threads` or
   `logical_threads`.
2. Whether Discord native thread creation should happen on every root message
   or only after a threshold/policy decision.
3. Whether `reply_target_agent_id` should be immutable after root creation or
   changeable by operator action.
4. Whether resolved threads should auto-archive after a retention window.
5. How much of `thread_tasks` belongs in AUN core versus an integration table.

## Relationship to Existing Work

- Extends #415 by making reply confinement thread/queue-native rather than only
  channel/thread containment.
- Complements the durable reply close path (#401): durable close needs a stable
  queue identity, and this spec makes that queue identity point at one logical
  thread.
- Complements the terminal baton invariant (#572): baton/forward is explicitly
  not the same operation as normal reply.
