# codex-aun Runtime and Chat Adapter Policy

Status: proposed
Owner: Codex / AUN integration
Date: 2026-05-14

## Purpose

`codex-aun` is the shared name for the Codex-facing AUN integration layer in agent-comms.

The design goal is to make Codex a first-class runtime without turning Discord echo into the transport. The DB remains the control plane and audit log. Runtime-specific code owns LLM interaction only. Chat/UI adapters own display delivery only.

## Boundary Model

```text
LLM runtime -> runtime adapter -> DB core -> inbox runtime -> LLM runtime
                                      |
                                      +-> chat UI adapter -> Discord / Telegram / Web UI
```

### Runtime Adapter

Runtime adapters are responsible for LLM-specific behavior.

Examples:

- Claude Code adapter
- Codex adapter (`codex-aun`)
- Gemini adapter
- Future shell or IDE adapters

Responsibilities:

- LLM -> DB send/notify
- DB -> LLM inbox polling
- claim / replay / done lifecycle for `message_queue`
- prompt or command injection into the runtime
- session restore behavior
- runtime-specific setup and process supervision

Runtime adapters must not own Discord or Telegram delivery.

## MCP Naming Policy

The MCP-facing integration should use names that distinguish three concepts:

1. runtime identity
2. MCP server/tool surface
3. chat UI delivery

Use `codex-aun` as the Codex runtime adapter name.

Recommended names:

| Layer | Name | Meaning |
|---|---|---|
| Runtime adapter | `codex-aun` | Codex-facing AUN runtime adapter |
| MCP server registration | `aun` or `agent-comms` | The shared MCP service exposed to runtimes |
| Codex MCP profile | `codex-aun` | Codex's local profile/agent identity using the shared MCP service |
| Claude runtime adapter | `claude-aun` | Claude Code-facing AUN runtime adapter |
| Chat dispatcher | `aun-chat-dispatcher` | DB -> UI delivery process |
| Discord chat adapter | `aun-discord` | Discord implementation of the chat adapter |

The preferred public phrasing is:

```text
Claude uses claude-aun.
Codex uses codex-aun.
Both talk to the same AUN MCP service.
Chat UI delivery is handled by AUN chat adapters.
```

Avoid naming the Codex path `agent-comms-codex-discord`, `codex-discord`, or similar. Those names imply Discord is the transport. It is not. Discord is only one chat UI adapter after the DB.

### MCP Tool Surface

The MCP tools should be runtime-neutral where possible:

```text
aun.notify
aun.send
aun.inbox
aun.processing
aun.done
aun.status
```

Runtime-specific behavior belongs behind the adapter, not in tool names. For example, prefer:

```text
codex-aun calls aun.inbox
claude-aun calls aun.inbox
```

over:

```text
codex_inbox
claude_inbox
```

Runtime-specific wrappers may exist for setup and process control, but they should call the same shared lifecycle commands.

### Adapter Directory Naming

When code is split out of the current shared files, use this target shape:

```text
runtime/
  types.ts
  claude-aun/
    adapter.ts
    mcp-profile.ts
    runner.ts
  codex-aun/
    adapter.ts
    mcp-profile.ts
    runner.ts
    inbox.ts

chat/
  types.ts
  dispatcher.ts
  aun-discord/
    adapter.ts
    outbound-consumer.ts
  aun-telegram/
    adapter.ts
  aun-web/
    adapter.ts
```

`runtime/*` owns LLM behavior. `chat/*` owns UI delivery. Neither layer should import implementation details from the other.

### Agent Identity

For real operation, use `codex-aun` as the agent id, not `codex-test`.

`codex-test` may remain a diagnostic fixture, but production and review flows should use:

```text
AGENT_ID=codex-aun
```

This keeps DB logs, channel membership, outbound allowlists, and future MCP profiles aligned.

### Chat UI Adapter

Chat UI adapters are responsible for DB -> UI display delivery.

Examples:

- Discord adapter
- Telegram adapter
- Web/self-hosted UI adapter

Responsibilities:

- consume `outbound_queue`
- claim UI delivery rows
- send to the platform identified by the row
- persist platform message IDs and delivery failures
- preserve sender identity from DB metadata

Chat UI adapters must not infer LLM inbox state.

## Queue Semantics

`message_queue` and `outbound_queue` are intentionally separate. They are projections from the durable conversation log, not duplicated sources of truth.

### `agent_messages`

Durable conversation log.

Canonical meaning:

```text
agent_messages.author_id = speaker / logical author
```

This is the audit record for who produced the message.

### `message_queue`

DB -> LLM delivery queue.

Canonical meaning:

```text
message_queue.agent_id = recipient agent
```

This answers: which runtime should read this message next?

It owns LLM-facing state such as pending, claimed, received, done, or replayed.

### `outbound_queue`

DB -> UI delivery queue.

Canonical meaning:

```text
outbound_queue.agent_id = logical UI sender
```

This answers: whose message should be displayed in chat UI?

It owns UI-facing state such as pending, claimed, sent, failed, and platform message ID writeback.

The dispatcher that claims a row is a separate concept from the logical sender. Existing behavior may use `agent_id` as the self-claim key for compatibility, but new chat dispatcher work should make that distinction explicit.

## Claim Scope Policy

The safe compatibility default is sender-owned/self claim:

```text
AGENT_COM_OUTBOUND_CLAIM_SCOPE=self
```

In this mode, an outbound consumer claims only rows where:

```sql
outbound_queue.agent_id = AGENT_ID
```

This preserves the historical per-agent Discord identity behavior.

The common chat dispatcher mode is opt-in:

```text
AGENT_COM_OUTBOUND_CLAIM_SCOPE=global
```

In this mode, a chat dispatcher process may claim pending UI rows for any logical sender.

Important: `global` does not mean broadcast. It does not send to all agents, all channels, or all platforms. It only means the dispatcher can claim rows from all logical senders. The delivery target remains the row's platform/channel fields, such as `channel_external_id`.

## Current PR Stack

The current Codex integration work is split into small reviewable PRs:

- #360: runtime adapter architecture documentation
- #361: Codex setup, MCP config, and runner
- #362: Discord bot bridge ingress policy
- #363: allowlisted Discord bot bridge wiring
- #365: global outbound chat dispatcher claim scope

These PRs do not complete DB -> Codex automatic inbox delivery. They prepare the architecture and fix DB -> UI delivery ownership.

## Required Follow-up PRs

### Codex Inbox Runtime Adapter

Working title:

```text
[codex-aun] add inbox runtime adapter
```

Scope:

- poll `message_queue` for `agent_id=codex-test` or configured Codex agent ID
- claim messages safely
- render inbound DB messages into Codex-readable prompt/input
- mark received/done/replayed consistently
- persist enough state to survive Codex session loss
- expose a manual check-inbox command for debugging
- provide tests for claim, replay, done, and no-message behavior

This is the missing DB -> Codex side.

### Adapter Boundary Cleanup

Working title:

```text
[codex-aun] formalize runtime and chat adapter boundaries
```

Scope:

- introduce shared runtime adapter interfaces
- introduce chat dispatcher interfaces
- move runtime-specific code out of generic server paths where practical
- document and enforce naming conventions:
  - `author_id` / `sender_agent_id` for speaker
  - `recipient_agent_id` for LLM inbox recipient
  - `dispatcher_id` or `claim_scope` for UI delivery ownership
- keep DB migrations separate from behavior changes unless required

## Rollback Policy

All early `codex-aun` changes should be rollback-friendly.

Requirements:

- no schema migration unless the PR explicitly requires it
- new behavior defaults to existing behavior
- opt-in behavior is controlled by env/config
- PR descriptions include rollback steps
- tests cover both compatibility mode and new mode

For the chat dispatcher work, rollback is:

```text
unset AGENT_COM_OUTBOUND_CLAIM_SCOPE
```

or:

```text
AGENT_COM_OUTBOUND_CLAIM_SCOPE=self
```

## Non-goals

- Do not restore unrestricted Discord bot echo.
- Do not spoof `AGENT_ID` to force delivery except as a temporary manual diagnostic.
- Do not collapse `message_queue` and `outbound_queue` without a separate design review.
- Do not make Codex require a dedicated Discord bot token when DB -> UI can be handled by a common chat dispatcher.

## Decision

Use `codex-aun` as the shared name for the Codex runtime integration effort.

The intended final shape is:

```text
Claude/Codex/Gemini adapters:
  LLM <-> DB

Inbox runtime:
  DB -> LLM

Chat UI adapters:
  DB -> Discord/Telegram/Web UI

DB core:
  durable log plus separate LLM and UI delivery queues
```

This keeps runtime differences isolated while making DB-backed conversation history, replay, and UI delivery common across runtimes.
