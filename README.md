# agent-comms-mcp

Agent-to-agent communication MCP plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

Enables bot-to-bot messaging without platform restrictions (e.g., Discord's `msg.author.bot` filter). Messages are stored in PostgreSQL, with optional forwarding to Discord/Telegram for human visibility.

## Features

- **MCP-native** — Works as a Claude Code `--channels` plugin
- **PostgreSQL storage** — All messages persisted, searchable, backed up
- **Inbox signals** — Lightweight file-based notifications (no message data in files)
- **Loop detection** — Prevents infinite bot-to-bot loops (depth + rate limiting)
- **Rate limiting** — Configurable per-agent message rate
- **Channel retention** — Per-channel auto-delete (like Telegram's auto-delete timer)
- **Discord/Telegram forwarding** — Optional message forwarding for human visibility
- **Auth tokens** — Optional authentication for multi-machine deployments
- **Single config file** — Everything in one `config.json`

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- PostgreSQL 14+

### Setup

```bash
# Clone
git clone https://github.com/watchout/agent-comms-mcp.git
cd agent-comms-mcp

# Install dependencies
bun install

# Create database
createdb agent_comms

# Configure
cp config.example.json config.json
# Edit config.json with your settings

# Run migrations
bun run migrate

# Test
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | AGENT_ID=test bun server.ts
```

### Use with Claude Code

```bash
claude --channels plugin:agent-comms@local --dangerously-skip-permissions
```

Or with environment overrides:

```bash
AGENT_ID=cto claude --channels plugin:agent-comms@local --dangerously-skip-permissions
```

## Configuration

All settings live in `config.json`:

```json
{
  "agent_id": "cto",
  "database_url": "postgresql://localhost/agent_comms",

  "channels": {
    "approvals":   { "retention_days": null, "description": "Permanent" },
    "dev-chat":    { "retention_days": 30, "description": "Auto-delete after 30 days" }
  },

  "rate_limit": { "max_per_minute": 30 },
  "loop_detection": { "max_depth": 10, "max_count": 20, "window_seconds": 300 },
  "auth": { "token": "your-secret-token-here" },

  "forwarding": {
    "discord": { "webhook_url": "https://discord.com/api/webhooks/..." },
    "telegram": { "bot_token": "123:ABC...", "chat_id": "-100..." }
  }
}
```

Environment variables override config values:
- `AGENT_ID` — Agent identifier
- `DATABASE_URL` — PostgreSQL connection string
- `AGENT_COMMS_TOKEN` — Auth token
- `AGENT_COMMS_CONFIG` — Path to config file
- `DISCORD_WEBHOOK_URL` — Discord webhook for forwarding
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — Telegram forwarding

## Tools

### send_message

Send a message to another agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | Yes | Target agent ID |
| `channel` | Yes | Logical channel name |
| `content` | Yes | Message content |
| `message_type` | No | `instruction`, `report`, `approval`, `chat` |
| `reply_to` | No | Message ID to reply to |
| `depth` | No | Conversation depth (loop detection) |
| `metadata` | No | Additional JSON metadata |
| `auth_token` | No | Auth token (if configured) |

### fetch_messages

Fetch recent messages from a channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel` | Yes | Channel name |
| `limit` | No | Max messages (default: 20, max: 100) |
| `since` | No | ISO timestamp — messages after this time |

### check_inbox

Check for new messages addressed to this agent.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `limit` | No | Max messages (default: 20) |

## Maintenance

### Daily cleanup (cron)

```bash
# Delete expired messages based on retention policy
0 4 * * * bun /path/to/agent-comms-mcp/db/cleanup.ts

# Backup database
30 3 * * * bash /path/to/agent-comms-mcp/scripts/backup-to-conoha.sh
```

### Manual cleanup

```bash
bun db/cleanup.ts
```

## Design

```
Agent A ──→ MCPPlugin ──→ PostgreSQL (source of truth)
                │              │
                ├──→ inbox/ signal (lightweight notification)
                ├──→ Discord webhook (optional, for human visibility)
                └──→ Telegram API (optional, for notifications)

Agent B ──→ check_inbox ──→ reads signals → fetches from DB
```

Inspired by:
- **Discord**: DB as single source of truth, Gateway push for realtime, REST API for history
- **Telegram**: Per-channel auto-delete timers, client-side caching

## License

MIT
