# AUN Canonical Channel ID Control-Plane Contract

> Status: proposed
> Slice: Send/Receive Control Plane canonical routing
> Last updated: 2026-05-31

## Purpose

AUN control-plane traffic must be routed by durable identifiers, not by mutable display names.

This contract closes the class of failures where audit or runner automation tries to send to a channel by name, hits an environment-specific alias, or silently lands in the wrong conversation surface.

The target behavior is:

- scripted send/notify paths use canonical IDs only
- channel names are human convenience aliases only
- every alias resolution is explicit, unique, fail-closed, and audit logged
- thread, message, queue, agent, conversation, and baton references are validated as a single coherent routing tuple

## Core Terms

### Canonical Channel ID

`channel_id` is the AUN DB channel identifier. It is an opaque string.

In the current Discord deployment it may equal a Discord snowflake, but control-plane code must not infer provider, workspace, membership, or write capability from its shape.

### Channel Name

`channel.name` is a mutable human display alias. It is not a routing identifier for automation.

### Provider Channel ID

Provider-specific IDs, such as Discord channel snowflakes when they differ from `channels.id`, belong in connector/adapter tables and delivery evidence. They are not accepted as substitutes for `channel_id` unless a resolver explicitly maps them to one canonical AUN channel row and records that mapping.

### Scripted Path

A scripted path is any non-interactive sender, including:

- MCP tool calls used by agents
- state_daemon or runner invocations
- audit bridge notifications
- migration and repair scripts
- queue replay, retry, or recovery jobs

### Human CLI Alias Path

A human CLI alias path is an explicitly interactive/operator path that may accept a channel name for convenience, resolve it to a canonical `channel_id`, print the resolution, and write audit evidence.

## Product Invariants

1. Scripted/control-plane send and notify require canonical `channel_id`.
2. Scripted/control-plane code must not resolve channel names implicitly.
3. A channel name can resolve only in an explicit human alias path.
4. Alias resolution must be unique; zero or multiple matches fail closed.
5. Alias resolution must be audit logged with input alias, resolved `channel_id`, resolver mode, operator/agent, and command surface.
6. `thread_id` must be validated against its parent `channel_id` before write or delivery.
7. `message_id`, `queue_id`, `conversation_id`, and `baton_id` must be validated against the same channel/thread scope when present.
8. Provider channel IDs must flow through connector evidence, not string-shape guesses.
9. Error messages must include stable error codes and the canonical field that is missing or invalid.
10. Logs and audit packets must show resolved IDs, not only human names.

## Send/Notify Contract

### Scripted Notify

Required inputs:

- `channel_id`
- exactly one active owner, per the owner/observer contract
- content
- message type

Optional inputs:

- `thread_id`, if validated as belonging to `channel_id`
- `cc[]` / `fyi[]`, observer-only
- idempotency key
- parent audit link

Forbidden scripted inputs:

- `channel` when it may be a name
- `channel_name`
- provider channel id without explicit resolver evidence
- any fallback from failed channel ID validation to channel-name lookup

### Scripted Send

Reply/send paths that target an existing message must derive channel scope from `reply_to` / `message_id` and validate any provided `channel_id` matches that stored message.

If no existing message anchors the send, scripted send follows the scripted notify requirements.

### Human CLI Alias

Human CLI may offer an alias option only with explicit naming such as:

- `--channel-name <name> --resolve-channel-name`
- `--dry-run` preview showing the canonical `channel_id`

The CLI must not use a positional `channel` argument that silently accepts both ID and name in scripted mode.

## Failure Codes

Implementations must expose stable error codes:

- `CHANNEL_ID_REQUIRED`: scripted path omitted canonical `channel_id`
- `CHANNEL_ID_NOT_FOUND`: no channel row exists for the provided `channel_id`
- `CHANNEL_ALIAS_NOT_ALLOWED`: scripted path provided a name/alias field
- `CHANNEL_NAME_NOT_FOUND`: human alias resolver found no match
- `CHANNEL_NAME_AMBIGUOUS`: human alias resolver found multiple matches
- `THREAD_CHANNEL_MISMATCH`: `thread_id` does not belong to `channel_id`
- `MESSAGE_CHANNEL_MISMATCH`: `message_id` scope does not match provided `channel_id` / `thread_id`
- `QUEUE_CHANNEL_MISMATCH`: `queue_id` scope does not match provided channel/thread/message tuple
- `PROVIDER_CHANNEL_UNRESOLVED`: provider external id has no unique canonical mapping

## Audit Evidence

Every send/notify write from a scripted path must record:

- `channel_id`
- `thread_id` or null
- `message_id` or null
- `queue_id` or null
- active owner `agent_id`
- observer lists
- sender `agent_id`
- command/tool surface
- whether any alias resolution occurred, which must be false for scripted paths
- idempotency key when provided

Human alias paths must additionally record:

- input alias
- resolved `channel_id`
- candidate count
- resolver mode
- dry-run vs execute

## Migration Slices

1. Spec gate: land this contract.
2. Inventory: find scripted call sites passing channel names or ambiguous `channel` values.
3. CLI split: separate `--channel-id` from explicit human-only alias options.
4. MCP schema: make scripted notify/send require canonical `channel_id` or an anchored `reply_to`.
5. Server enforcement: reject implicit name resolution in scripted paths with stable codes.
6. Audit metadata: stamp resolved IDs and alias-resolution evidence.
7. Fleet migration: update audit bridge, runner, repair, and state_daemon calls to channel IDs.
8. Deprecation: remove or quarantine ambiguous `channel id (or name)` wording from scripted docs.

## Required Tests

Implementation PRs must include tests for:

- scripted notify rejects channel name with `CHANNEL_ALIAS_NOT_ALLOWED`
- scripted notify without `channel_id` fails with `CHANNEL_ID_REQUIRED`
- valid `channel_id` writes one message and one owner queue row
- unknown `channel_id` fails before writing
- human alias path resolves a unique name and logs the resolved ID
- human alias path rejects ambiguous names
- `thread_id` parent mismatch fails before writing
- `message_id` mismatch fails before reply/send write
- provider external id cannot masquerade as canonical channel id without resolver evidence
- audit log contains canonical IDs for every successful scripted send/notify

## Non-Goals

- This contract does not implement baton schema.
- This contract does not remove human-friendly channel names from displays.
- This contract does not require changing existing DB primary keys.
- This contract does not define provider credential ownership; that remains connector evidence.

## Acceptance Criteria

The slice is complete when:

- scripted send/notify has no implicit channel-name resolution
- audit bridge messages use canonical channel IDs
- invalid channel/thread/message tuples fail before DB mutation
- human alias resolution is explicit, unique, and audit logged
- CI has contract tests covering all required failure codes
