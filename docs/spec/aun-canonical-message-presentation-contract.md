# AUN Canonical Message Presentation Contract

> Status: proposed
> Slice: CP-40C canonical message presentation
> Last updated: 2026-06-01

## Purpose

AUN receive runners must present one logical work item to a runtime even when
the human or provider surface had to split that work across multiple transport
messages.

This contract closes the failure mode where a long audit request, bridge
instruction, or provider projection is split into chunks such as `1/3`, `2/3`,
and `3/3`, then each chunk becomes independent claimable work for the runtime.
Transport segmentation is a projection concern. It must not create extra
batons, duplicate active owners, or multiple runtime tasks unless a separate
typed child-request workflow explicitly asks for that behavior.

## Terms

| Term | Meaning |
|---|---|
| canonical message | The complete logical message body stored as one AUN work unit. |
| transport fragment | One provider/UI chunk created only because a surface has size or formatting limits. |
| presentation group | A stable grouping key that lets fragments reconstruct one canonical message. |
| claimable work | A `message_queue` row that a receive runner may claim for runtime execution. |
| child request | A deliberately separate task with its own active owner, queue row, baton, and parent audit link. |

The current canonical message identity is `agent_messages.id`. A future
`canonical_message_id` may be added, but it must be an alias or grouping layer
over the same logical-work invariant, not a second active work identity.

## Product Invariants

1. One logical instruction creates at most one claimable runtime task for one
   active owner.
2. Transport fragments are not claimable runtime tasks.
3. Fragment rows, if stored, must point back to one canonical message or one
   presentation group.
4. Receive and process runners pass the reassembled canonical body to the
   runtime.
5. Batons attach to canonical messages or deliberate child requests, not to
   projection fragments.
6. A long message split for Discord, Slack, terminal display, or MCP output
   remains one message for queue, baton, audit, and runtime purposes.
7. Deliberate fanout or multi-part work must use typed child requests with
   explicit parent links. It must not rely on transport chunking.
8. A missing or inconsistent fragment group fails closed before runtime
   invocation.

## Required Data Shape

Implementation may use the existing tables or add explicit columns, but it must
represent these fields in durable data:

```ts
type CanonicalPresentation = {
  message_id: string
  presentation_group_id: string
  fragment_count: number
  fragment_index: number
  is_claimable: boolean
  canonical_body_hash: string
  fragment_body_hash: string
  parent_message_id?: string
  child_request_id?: string
}
```

Rules:

- `message_id` identifies the canonical work item when no transport split
  occurred.
- `presentation_group_id` is required when a logical message is represented by
  more than one stored or projected fragment.
- `fragment_count` and `fragment_index` must be stable and bounded.
- only the canonical row, or an explicit child request row, may be claimable.
- fragment rows must be non-claimable or must not enter `message_queue`.
- `canonical_body_hash` lets runner code verify that the assembled body matches
  the body that was audited or sent.

## Receive Runner Contract

When a receive runner claims work:

1. It loads the exact `message_queue` row selected by policy or `queue_id`.
2. It verifies that the row represents a canonical message or explicit child
   request.
3. It resolves the presentation group, if present.
4. It assembles or loads one canonical body.
5. It passes one body and one queue/baton context to the runtime adapter.
6. It records the presentation evidence in runner output.

The runner must not invoke a runtime once per transport fragment. It must not
ask the runtime to infer continuation state from prose markers such as
`(1/2)`, `continued`, or `last part`.

## Send And Notify Contract

Send and notify surfaces must distinguish logical work from provider display.

Required behavior:

- store one canonical `agent_messages` row for the logical message
- create at most one active-owner `message_queue` row
- record observer visibility without claimable observer rows, per the
  owner/observer contract
- create provider chunks only in outbound/projection data
- link all chunks to the canonical message or presentation group

If an existing provider adapter cannot store projection fragments separately,
the implementation must still avoid creating extra active-owner queue rows. A
temporary body marker is acceptable only if the receive runner still presents
one canonical body.

## Externally Chunked Input

If a provider or operator sends split input into AUN, ingestion must choose one
of these paths:

1. Reassemble all fragments before writing the canonical message and queue row.
2. Store fragments as non-claimable rows linked by `presentation_group_id`, then
   create one claimable canonical row after the group is complete.
3. Reject the incomplete group with a stable failure code.

It must not create one claimable queue row per fragment by default.

## Failure Codes

| Code | Meaning |
|---|---|
| `CANONICAL_MESSAGE_REQUIRED` | Runner found a claimable row that is only a fragment. |
| `PRESENTATION_GROUP_INCOMPLETE` | Required fragments are missing or not yet durable. |
| `PRESENTATION_GROUP_CONFLICT` | Fragment count, index, hashes, or owner scope disagree. |
| `FRAGMENT_NOT_CLAIMABLE` | Caller tried to claim a non-claimable fragment row. |
| `CHILD_REQUEST_REQUIRED` | Caller attempted multi-task fanout through transport chunking. |

## Audit Evidence

Successful runner invocation must record:

- `queue_id`
- canonical `message_id`
- `presentation_group_id` or null
- `fragment_count`
- `canonical_body_hash`
- active owner
- conversation id and baton id when available
- whether this was a canonical message or explicit child request

Projection/outbound audit must record:

- canonical `message_id`
- provider message ids for every fragment, when available
- fragment count and indexes
- the reason for splitting
- proof that fragments did not create extra claimable work

## Tests Required For Implementation

Implementation PRs must include focused coverage for:

1. long notify creates one `agent_messages` logical message and one active queue
   row even when provider projection chunks exist.
2. receive runner returns one canonical body for a split presentation group.
3. direct claim of a fragment row fails with `FRAGMENT_NOT_CLAIMABLE`.
4. incomplete fragment group fails with `PRESENTATION_GROUP_INCOMPLETE`.
5. conflicting fragment metadata fails with `PRESENTATION_GROUP_CONFLICT`.
6. deliberate child request fanout creates explicit parent/child links and
   separate batons; it is not inferred from chunk labels.
7. audit evidence includes canonical `message_id`, `presentation_group_id`,
   `fragment_count`, and `canonical_body_hash`.
8. existing unsplit messages keep the same receive behavior.
9. observer-only visibility still does not create claimable rows.
10. targeted `--queue-id` receive cannot be used to bypass fragment
    non-claimability.

## Non-Goals

- This contract does not implement the child-request fanout schema.
- This contract does not require changing provider message size limits.
- This contract does not define completion outcomes; CP-50/CP-60 own that.
- This contract does not permit multiple active owners in one send/notify call.

## Acceptance Criteria

CP-40C is complete when:

- transport chunks cannot become duplicate runtime tasks
- runner input contains one canonical logical body per claimed work item
- fragment grouping is durable and auditable
- incomplete or inconsistent groups fail closed
- explicit child requests are the only supported way to turn one parent message
  into multiple active tasks
