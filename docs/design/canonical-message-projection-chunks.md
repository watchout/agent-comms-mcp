# Canonical Messages And Projection Chunks

Issue: #392

## Decision

AUN stores one canonical logical message in `agent_messages`. Chat UI length
limits are projection concerns and must not change durable message identity.

The public invariant is:

```text
agent_messages.id = canonical logical message id
message_queue.message_id = canonical logical message id
outbound/chat chunks = projection records that reference the canonical id
```

Discord, Slack, Telegram, terminal UIs, and future proprietary chat surfaces may
split or decorate messages for display, but receiving runtimes must see one
logical task, not `1/3`, `2/3`, `3/3` as independent work items.

## Current Risk

The current send/notify path splits long content before durable fanout. Each
part can get its own `agent_messages` row, `message_queue` row, and
`outbound_queue` row. Metadata such as `split_part` and `split_total` preserves
some relationship, but it still lets transport chunking leak into the core
queue model.

That creates three classes of bugs:

- the receiver LLM may process multiple chunk rows as multiple tasks
- dedup/idempotency applies to chunk content instead of the original logical
  message
- reply/thread mapping can anchor to a projection part instead of the logical
  parent message

The target model keeps split parts below the outbound adapter boundary.

## Scope Of `agent_messages` As SSOT

`agent_messages` is the system of record for logical communication:

- full canonical content before any platform-specific split
- author, channel, thread, reply parent, message type, direction, and role
- input mentions and core routing metadata
- canonical `message_id` used by `message_queue`
- canonical reply-chain identity used by receive runners and history tools

`agent_messages` must not store one row per Discord chunk merely because a
platform has a length limit. If an implementation needs to remember projection
chunks, those chunks must point back to the canonical row instead of replacing
it.

For inbound externally chunked messages, the adapter must either:

- reassemble chunks before inserting the canonical `agent_messages` row, or
- record a stable grouping key and mark the message as incomplete until the
  receive path can present one canonical body.

The receive runner must never present transport part markers as separate queue
items.

## Queue Responsibilities

### `message_queue`

`message_queue` is delivery and claim state for a canonical message:

- one row per `(recipient agent, canonical message)` delivery target
- `message_id` points to `agent_messages.id`
- payload may include a compact preview, but the canonical body is in
  `agent_messages`
- status, claim owner, claim TTL, and close metadata apply to the logical
  message, not to projection chunks

Splitting a message for Discord must not multiply `message_queue` rows.

### `outbound_queue`

`outbound_queue` is the durable handoff to outbound delivery. It can support
projection chunks in either of two ways:

1. Adapter-only initial approach:
   - enqueue one `outbound_queue` row with canonical `message_id` and canonical
     content
   - outbound consumer or adapter splits content immediately before posting
   - adapter records best-effort delivery metadata in logs or existing
     `discord_message_id` when there is only one platform message

2. Projection-record approach:
   - enqueue one row per outbound chunk
   - every chunk row references the same canonical `message_id`
   - chunk-specific identity lives in projection metadata such as
     `projection_group_id`, `chunk_index`, `chunk_total`, and
     `platform_message_id`
   - no chunk row becomes a new `agent_messages` row or a new
     `message_queue` work item

The initial implementation should prefer adapter-only splitting when possible
because it avoids a schema migration. If reliable per-chunk resend/writeback
requires durable chunk rows, add a projection table or explicit projection
columns in a separate migration PR after this invariant is locked.

## Chunk Ordering

Projection chunks must be ordered by canonical message id plus chunk index:

```text
projection_group_id = canonical message id + platform + destination
chunk_index         = 1-based integer
chunk_total         = total chunks in the group
```

Adapters may render human markers like `(1/3)`, but those markers are display
syntax only. Ordering must be machine-readable and independent of the rendered
text.

For outbound posting:

- post chunks in ascending `chunk_index`
- use a bounded inter-part delay only in the projection layer
- keep the canonical message committed before projection starts
- if one chunk fails, retry from projection state without duplicating
  `agent_messages` or `message_queue`

For inbound reassembly:

- group chunks by platform thread/channel, author, reply parent, and stable
  chunk marker when available
- accept only complete ordered groups for canonical insertion when the platform
  provides all parts synchronously
- otherwise insert a canonical message with metadata that indicates incomplete
  projection and keep it out of receive fanout until complete

## Idempotency

Canonical idempotency and projection idempotency are separate.

Canonical idempotency:

- prevents duplicate logical messages
- keys on author, channel/thread, logical content hash, and a short dedup window
- controls `agent_messages` and `message_queue`

Projection idempotency:

- prevents duplicate platform posts for the same chunk
- keys on canonical `message_id`, platform, destination, and `chunk_index`
- controls outbound adapter retries and platform writeback

Do not use chunk text alone as the durable dedup key for receive delivery.

## Reply And Thread Mapping

Canonical reply/thread fields remain platform-independent:

- `agent_messages.reply_to` points to a canonical `agent_messages.id`
- `agent_messages.thread_id` points to the AUN thread identity
- `message_queue.payload.message_id` points to the canonical row

Projection mapping translates canonical identity to platform identity:

- Discord native reply should target the first successful projection chunk for
  the canonical parent, unless a platform-specific rule requires another chunk
- thread/channel external ids are adapter lookups, not core queue ids
- inbound platform replies to any chunk in a projection group must resolve back
  to the canonical parent message

This keeps reply-chain context stable even when one logical message produced
several chat posts.

## Platform Independence

The core model must not encode Discord as the only projection target.

Adapters define:

- maximum display length
- mention rendering syntax
- whether native reply can target one or many platform messages
- whether platform APIs expose message grouping metadata
- delivery/writeback capabilities

Core code defines:

- canonical message identity
- routing and queue fanout
- reply-chain identity
- failure semantics and audit records

Slack, Telegram, Discord, and custom chat UIs should all consume the same
canonical row and produce their own projection.

## Existing `send` / `notify` Compatibility

The public command behavior should stay compatible:

- `send` still closes the intended reply queue row after successful canonical
  enqueue
- `notify` still creates a new canonical message and does not close queue rows
- command responses may continue to report that projection split occurred
- existing `split into N parts` user feedback can remain, but part ids should
  become projection ids rather than independent canonical message ids

Compatibility bridge:

- keep accepting existing metadata keys such as `split_part` and `split_total`
  during the migration window
- receive runners should prefer canonical grouping over raw chunk rows when
  those legacy rows appear
- new code must not introduce additional independent work items for projection
  chunks

## Migration Position

This design PR should not introduce a DB migration.

Initial implementation can be adapter-only:

1. save one canonical `agent_messages` row
2. enqueue one `message_queue` row per recipient for that canonical id
3. split only for outbound posting
4. keep projection chunk metadata in outbound adapter memory/logs where durable
   resend is not required

If durable per-chunk retries and writeback are required, introduce a follow-up
migration with one of these shapes:

- `outbound_projection_chunks` table keyed by
  `(message_id, platform, destination, chunk_index)`
- or explicit nullable projection columns on `outbound_queue`

That migration must be separate from the invariant-setting design so reviewers
can audit data preservation independently.

## Contract Test Plan

Tests must use isolated DB fixtures and must not touch production DB.

Required contract tests:

- long `send` creates one canonical `agent_messages` row for the full content
- long `send` creates one `message_queue` row per recipient, not per chunk
- outbound projection emits ordered chunks that all reference the same
  canonical `message_id`
- retrying projection does not create duplicate canonical messages
- native reply/writeback from any chunk resolves to the canonical parent
- `notify` follows the same canonical/projection split without closing a queue
  row
- externally chunked inbound messages are reassembled or withheld until the
  receiver can see one logical message
- Discord, Slack, and Telegram fixtures exercise different length limits
  through the same adapter contract
- legacy split metadata is read as compatibility input but not emitted as
  independent queue work by new code

Source-level guardrails:

- no `message_queue INSERT` inside a loop over projection chunks
- no `saveMessage` per projection chunk in new send/notify code
- `outbound_queue.message_id` remains the canonical id

## Rollout Plan

1. Land this design PR as the public invariant.
2. Add failing contract tests for canonical DB identity vs projection chunks.
3. Refactor send/notify to save canonical messages before splitting.
4. Move platform splitting to outbound projection.
5. Add inbound reassembly/grouping for externally chunked messages.
6. Decide whether adapter-only projection is enough or whether a projection
   chunk table is needed for durable resend/writeback.
