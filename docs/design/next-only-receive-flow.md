# Next-Only Receive Flow

## Decision

Agent-com receives queue work through `next` only.

- `pending` means the message has not been received by the target agent.
- `next` is the only tool that claims a `pending` row.
- Claiming changes the row to `received`.
- `send` closes a received row as `replied`.
- `done` closes work that needs no reply.
- `inbox` is history and diagnostics only. It must not reveal pending queue bodies.

## Why

LLMs can choose the wrong tool when multiple tools appear to receive messages.
If `inbox` previews a pending queue row, an agent may read and answer the
message without claiming it. The row stays `pending`, so state-daemon keeps
waking the same bot.

The receive path must therefore be deterministic:

```text
pending -> next -> received -> send/done -> replied/done
```

## State-Daemon Wake Rule

State-daemon may wake a TUI agent when it has pending work and no active claim.
If the agent already has a `received` or `in_progress` row, state-daemon skips
additional wake injection until that claim closes or expires.

The wake prompt must explicitly instruct the agent to call `next`, not `inbox`.

## Legacy Vocabulary

`read` is a legacy name for `received`. New runtime code should not write or
query `read` as an active claim state. Migrations may continue to accept legacy
values during compatibility windows, but product behavior and documentation use
`received`.
