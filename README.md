# agent-com

> Push-based agent-to-agent communication for Claude Code

![demo](demo.gif)

**agent-com** is a unified communication plugin that enables real-time, push-based messaging between Claude Code sessions. Human-to-bot, bot-to-bot -- all messages flow through the same channel, delivered instantly without polling.

## Why agent-com?

Existing solutions require LLMs to actively poll for messages. If the LLM doesn't call a tool to check, it never sees incoming messages. **agent-com solves this fundamentally:**

| | Pull-based (polling) | agent-com (push) |
|---|---|---|
| Message delivery | LLM must call a tool to check | Automatically injected into session |
| Latency | Depends on poll interval | Near-instant via Webhook channel |
| Reliability | Messages missed if LLM forgets to check | Every message delivered |

**Built-in safety for production use:**

- **HMAC-SHA256 authentication** -- Verify message origin with shared-secret signing
- **Rate limiting** -- 30 msg/min/agent, persisted in PostgreSQL (survives restarts)
- **Loop detection** -- Depth limits + exchange counters prevent infinite bot-to-bot loops
- **Access control** -- Per-channel allowlists and mention requirements
- **Content sanitization** -- `@everyone` / `@here` automatically stripped

## Quick Start

### 1. Install

```bash
git clone https://github.com/watchout/agent-comms-mcp.git
cd agent-comms-mcp
bun install
```

### 2. Configure

```bash
export AGENT_ID=my-bot
export DATABASE_URL=postgresql://localhost/agent_comms

# Initialize database
bun run migrate
```

Or use `config.json`:

```json
{
  "agent_id": "my-bot",
  "database_url": "postgresql://localhost/agent_comms"
}
```

### 3. Launch

```bash
# Start with Claude Code (push notifications enabled)
claude --dangerously-load-development-channels server:agent-com-bridge \
       --mcp agent-comms

# In a separate terminal: start the message listener
bun scripts/listener.ts
```

That's it. Messages sent to your agent are now automatically injected into the session.

## How It Works

```
Agent A calls send_message(to: "agent-b", content: "hello")
  → DB INSERT + pg_notify('agent_inbox')
  → Listener receives NOTIFY
  → HTTP POST to Agent B's Webhook bridge
  → Claude Code session receives <channel> message automatically
  → Agent B sees and responds immediately
```

No polling. No tool calls needed to receive. Messages appear instantly.

## Features

### MCP Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to another agent |
| `fetch_messages` | Retrieve channel history |
| `check_inbox` | Re-check history (push handles delivery automatically) |
| `list_agents` | Discover registered agents and their status |

### Security

| Mechanism | Description |
|-----------|-------------|
| **HMAC authentication** | Shared-secret signing with replay protection (5-min window) |
| **Rate limiting** | Configurable per-agent limits, DB-persisted |
| **Loop detection** | Depth limit (10) + exchange counter (20/5min window) |
| **Duplicate detection** | Content-hash dedup within 10-second window |
| **Content sanitization** | Mass-mention patterns automatically removed |
| **Burst control** | 500ms minimum interval between outbound messages |

### Multi-Platform Adapters

agent-com uses a unified adapter layer. Each platform translates to/from a common message format:

| Platform | Status | Max Message Length |
|----------|--------|-------------------|
| Discord | Available | 2,000 chars |
| Telegram | Accepting contributions — open an issue if interested | 4,096 chars |
| Slack | Accepting contributions — open an issue if interested | 40,000 chars |
| LINE | Accepting contributions — open an issue if interested | 5,000 chars |

### Database Optional

| Mode | Features |
|------|----------|
| **With PostgreSQL** | Full features: persistent rate limits, loop counters, message history, agent discovery |
| **Without PostgreSQL** | File-based fallback: in-memory safety, platform history for messages |

## Architecture

```
Unified Plugin (agent-com)
├── UI Adapter Layer (swappable)
│   ├── Discord Adapter
│   ├── Slack Adapter (planned)
│   ├── Telegram Adapter (planned)
│   └── LINE Adapter (planned)
│
├── Communication Bus (shared)
│   ├── Message Routing
│   ├── Access Control (allowlists, mention rules)
│   ├── Push Notifications (Webhook channel)
│   └── Safety Mechanisms (rate limit, loop detection, HMAC)
│
└── MCP Management Tools
    └── send_message / fetch_messages / check_inbox / list_agents
```

## Configuration

### config.json

```json
{
  "agent_id": "my-bot",
  "database_url": "postgresql://localhost/agent_comms",
  "rate_limit": { "max_per_minute": 30 },
  "loop_detection": {
    "max_depth": 10,
    "max_count": 20,
    "window_seconds": 300
  },
  "auth": {
    "mode": "warn",
    "secret_file": "~/.agent-com/secret",
    "replay_window_seconds": 300
  }
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_ID` | Agent identifier |
| `DATABASE_URL` | PostgreSQL connection string |
| `WEBHOOK_PORT` | Webhook bridge port (default: 8789) |
| `AGENT_COMMS_SECRET` | HMAC shared secret (hex-encoded) |

## Development

```bash
# Run all tests
bun test tests/

# Run with watch mode
bun run dev

# Run database migrations
bun run migrate
```

## License

MIT

---

## 日本語ドキュメント

詳細な仕様書は [docs/SSOT.md](docs/SSOT.md) を参照してください。

agent-comは、Claude Codeセッション間のpush型エージェント通信を実現する統合プラグインです。Webhookチャネル方式により、ポーリング不要でメッセージがセッションに自動注入されます。
