# codex-aun Manual Inbox

Status: initial runtime primitive
Date: 2026-05-14

This document describes the first DB -> Codex receiving path for `codex-aun`.

It is intentionally manual. It does not inject text into an active Codex TUI session yet. It gives operators and wrappers a stable CLI contract for reading and closing DB-backed inbox messages.

## Flow

```text
CTO / agent -> agent_messages
            -> message_queue(agent_id='codex-aun', status='pending')
            -> agent-com inbox
            -> status='received'
            -> agent-com processing
            -> status='in_progress'
            -> agent-com done
            -> status='done'
```

## Commands

Claim pending messages:

```bash
AGENT_ID=codex-aun DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts inbox --limit 1
```

The command returns JSON:

```json
{
  "ok": true,
  "agent_id": "codex-aun",
  "waiting": 0,
  "claimed": 1,
  "messages": [
    {
      "queue_id": 69782,
      "message_id": "d7111724-6cdd-47d4-b747-0ef31e3a489a",
      "status": "received",
      "from": "cto",
      "content": "..."
    }
  ]
}
```

Mark work started:

```bash
AGENT_ID=codex-aun DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts processing --queue-id 69782
```

Mark work complete without sending a reply:

```bash
AGENT_ID=codex-aun DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts done --queue-id 69782
```

## Semantics

`inbox` performs an atomic claim:

```text
pending -> received
```

It stamps:

- `claimed_by`
- `claimed_at`
- `claim_expires_at`
- `read_at`

`processing` performs:

```text
received -> in_progress
```

`done` performs:

```text
in_progress -> done
```

`done` is for messages that have been handled without sending a reply. If the agent replies, the existing send path should transition the queue row to `replied`.

## Relationship To Future Runtime Adapter

This CLI is the stable lower-level primitive for the future `codex-aun` runtime adapter.

The future runner can wrap these operations as:

```text
poll inbox
render prompt for Codex
run Codex turn
send reply or mark done
persist status
```

The CLI exists first so DB -> Codex can be validated before automatic prompt injection is added.
