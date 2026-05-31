# AUN Send/Notify Owner-Observer Contract

Date: 2026-05-31
Status: Proposed implementation contract for Agent Communication Control Plane slice 2
Depends on: `docs/design/aun-agent-communication-control-plane-charter.md`

## Purpose

This spec defines the send/notify contract that prevents one logical message
from creating multiple active response responsibilities.

AUN communication is baton-based. A send operation must decide exactly one
active owner for the next response responsibility. Visibility for other agents
is allowed, but visibility must not create claimable queue work.

## Terms

| Term | Meaning |
|---|---|
| active owner | The single agent expected to act or reply. |
| observer | An agent that may see the message but does not own a baton. |
| active recipient input | User/API field that can create `message_queue` work. |
| observer input | User/API field that can create read-only visibility only. |
| multi-active fanout | One send/notify call that tries to create active work for more than one agent. |

## Canonical API Shape

The canonical shape is:

```json
{
  "mention": "agent-id",
  "cc": ["observer-agent-id"],
  "fyi": ["observer-agent-id"]
}
```

Rules:

1. `mention` is the canonical active owner field.
2. Exactly one active owner is allowed.
3. `cc[]` and `fyi[]` are observer fields.
4. Observer fields must not create `message_queue` rows.
5. Observer fields must not create or transfer a baton.
6. Unknown active owner fails closed.
7. Unknown observers may be stripped with warnings if the caller can still see
   the warning; otherwise fail closed is acceptable for stricter surfaces.
8. Group keywords such as `all`, `everyone`, and `here` are not valid active
   owners for MCP/CLI send/notify. Explicit fanout needs a separate typed
   workflow.

## Legacy `mentions[]`

`mentions[]` has been used historically for active fanout. Slice 2 narrows the
field to a compatibility alias only:

- absent `mentions[]`: use `mention`
- one-item `mentions[]`: treat as the single active owner, with a deprecation or
  compatibility warning where the surface supports warnings
- zero-item `mentions[]`: `INVALID_MENTION`
- two-or-more `mentions[]`: `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`

If both `mention` and `mentions[]` are present, the resolver must normalize the
combined active-owner inputs and still require exactly one unique active owner.
If the unique count is greater than one, reject with
`MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`.

This preserves a migration path for existing callers while stopping the
behavior that amplified one logical message into multiple active queue rows.

## Observer Visibility

MVP observer visibility is projection-only.

Allowed mechanisms:

- append explicit `[CC: ...]` and `[FYI: ...]` suffixes to the canonical message
  body or provider projection
- include observer ids in message metadata for audit/search
- include observer ids in outbound provider display where the connector can
  render them safely

Forbidden mechanisms:

- claimable `message_queue` rows for observers
- baton rows for observers
- pending rows that require observers to call `next`
- natural-language wake prompts to observers

A future observer receipt table may be added, but it must be explicitly
non-claimable. It may record visibility, read receipt, or notification evidence;
it must not be interpreted as work ownership.

## Queue And Baton Effects

For one successful send/notify call:

```text
agent_messages: exactly one logical message, unless transport chunking requires
                projection-only chunks linked to the same logical message
message_queue:  at most one active-owner row
baton:          at most one active baton, once baton schema exists
outbox:         provider projection rows may exist, but do not create active owners
audit:          sender, active owner, observers, and policy decision are recorded
```

Transport splitting must not create additional active-owner rows. A long Discord
message may become several outbound chunks, but the receiving agent must still
see one logical message and one baton.

## Error Codes

| Code | Meaning |
|---|---|
| `INVALID_MENTION` | Missing, empty, or syntactically invalid active owner input. |
| `UNKNOWN_AGENT` | Active owner does not resolve to a known agent. |
| `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED` | Inputs resolve to more than one active owner. |
| `OUTBOUND_ACL_VIOLATION` | Sender, active owner, or observers violate channel policy. |

## Surface Requirements

### MCP `send` / `notify`

- schema documents `mention` as canonical
- schema may retain `mentions[]` only as a legacy single-owner alias
- schema documents `cc[]` and `fyi[]` as reference-only observers
- multi-active input returns `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`

### CLI `send` / `notify`

- `--mention <agent>` is canonical
- `--mentions <agent>` is a legacy single-owner alias
- `--mentions a,b` fails with `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`
- `--cc a,b` and `--fyi a,b` do not enqueue observer rows
- output includes active owner and observer lists for auditability

### Server routing port

The shared resolver must produce:

```ts
{
  mentions: [activeOwner],
  cc: observers,
  fyi: observers,
  warnings: string[],
  content: decoratedContent
}
```

The name `mentions` may remain internally during migration, but its cardinality
must be one. A later cleanup may rename the output to `activeOwner`.

## ACL And Policy

Channel policy must validate:

- sender
- active owner
- observers

An observer that is not allowed to see the channel must not be silently included
in projection output. The implementation may either strip with warning or reject
the whole send, but the behavior must be consistent per surface and covered by
tests.

## Tests Required For Implementation

Implementation PR must include focused coverage for:

1. `mention: a` enqueues exactly one active-owner row.
2. `mentions: [a]` enqueues exactly one active-owner row and emits compatibility
   warning where supported.
3. `mentions: [a, b]` rejects with `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED`.
4. `mention: a, cc: [b], fyi: [c]` enqueues only `a`.
5. observer ids appear in body/projection or metadata according to this spec.
6. unknown active owner fails `UNKNOWN_AGENT`.
7. unknown observers strip/warn or fail according to the documented surface
   policy.
8. group keywords are rejected as active owners.
9. CLI and MCP behavior are symmetric.
10. Tests pin that no observer row enters `message_queue`.

## Migration Notes

Existing callers using `mentions[]` with more than one active recipient must
change to either:

```json
{ "mention": "owner", "cc": ["observer"], "fyi": ["observer"] }
```

or create separate typed child requests, each with its own active owner and
parent audit link. The child-request fanout model is outside this slice and
must be specified separately before implementation.

## Acceptance Criteria

Slice 2 is complete when:

- send/notify cannot create more than one active-owner queue row
- observer visibility exists without observer queue ownership
- errors make multi-active fanout explicit
- CLI and MCP callers have a clear migration path
- audit evidence records active owner and observers
- the implementation can later attach a single baton id without changing the
  API contract again
