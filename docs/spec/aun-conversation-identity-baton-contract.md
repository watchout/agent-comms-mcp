# AUN Conversation Identity And Baton Contract

Status: pre-implementation contract

Last updated: 2026-05-31

## Purpose

The control-plane charter requires:

```text
one open conversation = one active baton
one active baton = one responsible agent
```

That invariant is not enforceable until `conversation` has a deterministic
identity. This contract defines the minimum conversation model needed before
the baton schema or compatibility layer is implemented.

This is intentionally narrower than the broader logical-thread reply contract
in PR #577. That work can still define UI, archive, task, and canonical reply
behavior. This contract only defines the ownership unit that baton and runner
code must enforce.

## Core Terms

| Term | Meaning |
|---|---|
| conversation | An AUN-owned logical work thread that groups related messages, deliveries, outcomes, projections, and audit events under one response-responsibility lifecycle. |
| conversation key | A deterministic, durable key that resolves a message or delivery to exactly one conversation. |
| conversation root | The first logical message or typed child request that starts a conversation. |
| open conversation | A conversation whose response responsibility has not reached a typed terminal outcome. |
| active baton | The single current response-responsibility record for an open conversation. |
| observer visibility | Read-only visibility for `cc` or `fyi` recipients; it is never claimable work and never owns a baton. |
| child request | An explicit typed request created from a parent conversation, with its own conversation key and baton. |

## Conversation Is Not

A conversation must not be inferred from these values alone:

- a Discord channel
- a Discord native thread id
- the latest message in a channel
- one `message_queue` row
- a batch of queue rows returned by a receiver
- a free-form prompt or progress ACK
- an observer visibility record

Provider thread ids and channel ids are projection and containment evidence.
They may participate in resolution, but they are not the AUN conversation
primary identity.

## Conversation Key

The implementation may store a UUID, a structured key, or both. The resolver
must be deterministic and must preserve these components as durable evidence:

| Component | Requirement |
|---|---|
| `surface` | The initiating surface, such as `mcp`, `cli`, `discord`, `github`, or `system`. |
| `channel_id` | The AUN channel containment boundary. |
| `thread_scope_id` | The AUN thread/surface scope if one is already known; otherwise the channel scope. |
| `root_message_id` | The canonical AUN root `agent_messages.id` for normal root messages. |
| `root_request_id` | The typed request id for non-message roots, including fanout child requests. |
| `parent_conversation_id` | Present only for explicit child requests. |
| `conversation_kind` | A typed value such as `request`, `audit`, `handoff`, `fanout_child`, or `system`. |

Exactly one of `root_message_id` or `root_request_id` is required after the
root has been committed. A pre-insert resolver may use temporary input, but the
committed conversation must be re-addressable through durable root evidence.

## Derivation Rules

### Start A New Conversation

Create a new conversation when:

- `notify` or an inbound message has no resolvable parent conversation
- an operator creates a new root request
- deterministic routing creates an explicit child request from a parent
  conversation
- an external provider reply references an unknown parent and the orphan policy
  chooses isolation

The resolver must not attach a rootless message to the latest active channel
or thread.

### Continue An Existing Conversation

Use the existing conversation when:

- `reply_to` resolves to an `agent_messages` row that already belongs to a
  conversation
- a provider reply resolves to a known projected message in a conversation
- a projection chunk, delivery retry, progress event, or audit event is linked
  to an existing conversation root
- a handoff transfers the active baton inside the same conversation

Continuing a conversation can create messages, deliveries, projections, or
audit events, but it must not create a second active baton.

### Observer Visibility

`cc` and `fyi` recipients receive observer visibility only.

Valid observer implementations include:

- read-only projection rows
- audit events that record observer ids
- non-claimable delivery rows explicitly marked `observer`

Invalid observer implementations include:

- claimable `message_queue` rows
- baton records
- wake prompts
- receiver work items

Observer visibility must be queryable for history and audit, but it must not
appear in `next`, receive-runner claim selection, or active-baton counts.

### Fanout

Multi-agent work is not multiple active owners on one conversation.

Valid fanout is:

```text
parent conversation
  -> explicit child request A -> child conversation A -> baton A
  -> explicit child request B -> child conversation B -> baton B
```

Each child conversation has:

- its own conversation key
- its own active baton
- a parent audit link
- an explicit result relationship back to the parent conversation

Child completion must not implicitly close the parent. Parent close requires a
typed outcome recorded by the parent baton owner or deterministic coordinator.

### Escalation

Escalation does not fork a conversation by default.

Valid escalation outcomes are:

- transfer the active baton to the escalation owner inside the same
  conversation
- move the same baton to an `escalated` state with a responsible owner
- create an explicit child request if the escalation requires independent work

Invalid escalation outcomes are:

- leaving the original conversation without a responsible owner
- creating a second active baton in the same conversation
- relying on free-form text to imply ownership transfer

## Baton Mapping

The baton schema or compatibility layer must enforce:

1. An open conversation has exactly one active baton after response
   responsibility exists. Root creation and baton creation must be atomic or
   guarded by a deterministic pending-baton state.
2. An active baton has exactly one responsible owner.
3. A claimable delivery row must link to the active baton or to a deterministic
   pending-baton creation operation.
4. Handoff transfers the baton within the same conversation unless it creates
   an explicit child request.
5. `done` is not terminal by itself. It means an agent turn completed, while
   final reply, handoff, no-reply close, retry, quarantine, or escalation still
   needs deterministic resolution.
6. A conversation becomes closed only through a typed terminal outcome with
   audit evidence.

## Turn Bounds

An agent turn is bounded by durable runner state, not by prompt text.

The runner implementation must record at least:

- baton id
- queue id or delivery id
- claim owner
- claim or lease id
- start time
- expiry or heartbeat policy
- completion outcome or failure evidence

The exact timeout values belong in the runner implementation contract, but
the conversation and baton schema must allow expired turns to be reclaimed
without losing or duplicating the active baton.

## Required Implementation Tests

The baton-schema slice must include tests for:

1. two messages in the same reply chain resolve to one conversation key
2. a new `notify` root creates a new conversation key
3. a provider reply with known parent joins the parent conversation
4. a provider reply with unknown parent does not attach to the latest channel
   message
5. observer-only recipients create no claimable queue rows and no batons
6. projection chunks share the parent conversation
7. handoff transfers the active baton and does not fork it
8. escalation either transfers the baton or creates an explicit child request
9. explicit fanout creates child conversations with parent audit links
10. `done` without a final typed outcome leaves the conversation open
11. a unique-active-baton guard rejects two active baton records for one open
    conversation

## Migration Boundary

This contract does not:

- add tables or migrations
- restart `state_daemon`
- activate script-controlled receive runners
- implement fanout child requests
- replace PR #577's broader logical-thread reply design

The next implementation slice may choose a compatibility layer over existing
tables, but it must expose enough durable identity to enforce the rules above.

## Acceptance Criteria

This contract is satisfied when:

- implementers can derive one conversation key for any root or reply message
- the baton schema PR can define a unique active-baton guard over that key
- observers are visible in audit/history without becoming claimable work
- fanout and escalation cannot accidentally create multiple owners for one
  conversation
- `done` cannot be mistaken for a terminal conversation close
