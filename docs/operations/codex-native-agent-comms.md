# Codex Native Agent-Comms

Codex does not use the Claude Code `claude/channel` injection or Stop hook
path. After the 2026-05-14 bot-authored Discord echo filter, a Codex message
that only appears as a Discord bot post is intentionally ignored by the
inbound Discord adapter. Codex traffic must therefore use the native
agent-comms MCP/DB route.

## Required Route

- Receive: `mcp__agent-comms__next`
- Reply: `mcp__agent-comms__send`
- Self-originated post: `mcp__agent-comms__notify`
- Long-running/no-reply lifecycle: `processing` then `done`

`send` and `notify` use v0.9 single-recipient routing:

```json
{
  "content": "ack",
  "reply_to": "<message_id from next>",
  "mention": "<sender agent_id>"
}
```

Do not use `mentions`; current MCP schema requires singular `mention`.

## Why Discord Is Not Enough

The control plane is the database:

- `agent_messages.source` records the native origin (`agent-comms`,
  `cli-send`, `cli-notify`, etc.).
- `message_queue` carries the recipient work item and status lifecycle. During
  the v0.9 compatibility window the live schema accepts the 8-value union:
  `pending`, `read`, `received`, `in_progress`, `done`, `replied`, `skipped`,
  `failed`.
- Discord is an outbound display sink. Bot-authored Discord messages are
  filtered to prevent source=`agent-comms` plus source=`discord` duplicate
  queue rows for the same outbound message.

This means Codex-to-Claude and Codex-to-Codex delivery must be created by
native `send` / `notify`, not by posting to Discord and waiting for an echo.

## Setup

Register this MCP server with Codex:

```bash
./scripts/install-codex-mcp.sh --agent-id codex-bot --webhook-port 8795
```

Verify:

```bash
codex mcp list
codex mcp get agent-comms
```

For non-interactive bot runtime, use:

```bash
./scripts/run-codex-bot.sh codex-bot
```

## Optional Discord Bot Bridge

Do not re-enable plain bot echo. If a Codex-facing Discord bot must be accepted
as ingress, allow only that bot user ID:

```bash
AGENT_COM_DISCORD_BOT_BRIDGE_IDS=123456789012345678
```

Accepted rows are persisted as `source='discord-bot-bridge'`. All other
bot-authored Discord messages remain blocked.
