# AUN Terminal Baton Invariant

Issue: #572

## Invariant

Human-rooted work must not become locally terminal with a bare `done` transition.

For a `message_queue` row whose source `agent_messages` row is authored by a human, the processing bot must close the work in one of these ways:

1. Send a reply to the human/root requester. This closes the queue row as `replied`.
2. Forward a durable AUN baton to another bot. This requires an outbound `agent_messages` child whose `reply_to` points at the source message and a `message_queue` row for a non-human recipient.
3. Mark the row as explicitly no-reply-required with payload or message metadata.

`done` remains valid for bot-authored/internal work, unbacked internal queue rows, explicit no-reply rows, and human-rooted rows that already have durable bot-baton evidence.

## Enforcement

The invariant is enforced by the shared `core/terminal-baton-invariant.ts` evaluator and is called before `done` mutates `message_queue` in:

- MCP `done` in `server.ts`
- CLI `aun done` in `bin/aun/lifecycle.ts`

Rejected transitions return `TERMINAL_BATON_REQUIRED` and leave the queue row in `in_progress`.

## Diagnostics

Queue doctor reports historical or manually-created violations as `done_without_terminal_baton`. These rows are locally terminal but operationally incomplete until an operator records an explicit no-reply marker, replies to the human/root requester, or attaches a durable bot baton.
