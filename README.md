# agent-com

> Push-based agent-to-agent communication for AI coding assistants

![demo](demo.gif)

**agent-com** is an MCP server that enables real-time, push-based messaging between AI coding agent sessions. Works with **Claude Code**, **OpenAI Codex CLI**, and any MCP-compatible client. Human-to-bot, bot-to-bot — all messages flow through the same channel, delivered instantly without polling.

## Why agent-com?

Existing solutions require LLMs to actively poll for messages. If the LLM doesn't call a tool to check, it never sees incoming messages. **agent-com solves this fundamentally:**

| | Pull-based (polling) | agent-com (push) |
|---|---|---|
| Message delivery | LLM must call a tool to check | Automatically injected into session |
| Latency | Depends on poll interval | Near-instant via pg_notify + Webhook |
| Reliability | Messages missed if LLM forgets to check | Every message delivered |
| Multi-LLM | Single vendor | Claude Code + Codex CLI + any MCP client |

## Features

- **Push notifications** — Messages injected into sessions automatically via pg_notify
- **Discord integration** — Full send/receive with threads, DMs, typing indicators, and mention notifications
- **Multi-LLM support** — Verified with Claude Code and OpenAI Codex CLI
- **LLM Adapter** — Built-in Anthropic, OpenAI, and Google Gemini adapters for API-based agents
- **All messages persisted** — Every Discord and agent message stored in PostgreSQL
- **HMAC-SHA256 auth** — Shared-secret signing with replay protection
- **Rate limiting** — Per-agent limits, DB-persisted (survives restarts)
- **Loop detection** — Depth limits + exchange counters prevent infinite bot-to-bot loops
- **Zombie process cleanup** — Auto-kills stale processes on port conflict at startup
- **Database optional** — Full features with PostgreSQL, file-based fallback without

## Quick Start

### 1. Install

```bash
git clone https://github.com/watchout/agent-comms-mcp.git
cd agent-comms-mcp
bun install
```

### 2. Configure

```bash
# Initialize database (optional but recommended)
export DATABASE_URL=postgresql://localhost/agent_comms
bun run migrate
```

### 3. Add to Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-comms": {
      "command": "bun",
      "args": ["run", "server.ts"],
      "cwd": "/path/to/agent-comms-mcp",
      "env": {
        "AGENT_ID": "my-bot",
        "DATABASE_URL": "postgresql://localhost/agent_comms",
        "DISCORD_BOT_TOKEN": "your-discord-bot-token"
      }
    }
  }
}
```

### 4. Add to Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp.agent-comms]
command = "bun"
args = ["run", "server.ts"]
cwd = "/path/to/agent-comms-mcp"

[mcp.agent-comms.env]
AGENT_ID = "codex-bot"
DATABASE_URL = "postgresql://localhost/agent_comms"
```

## How It Works

```
Agent A calls send_message(to: "agent-b", content: "hello")
  → DB INSERT + pg_notify('agent_inbox')
  → Listener receives NOTIFY
  → HTTP POST to Agent B's Webhook bridge
  → Session receives message automatically
  → Agent B sees and responds immediately
```

Discord messages follow the same path:

```
Discord message received
  → DB INSERT (with discord metadata) + pg_notify
  → MCP notification injected into session
  → Agent processes and replies via Discord adapter
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to another agent |
| `reply` | Reply to a Discord channel or thread |
| `fetch_messages` | Retrieve channel history |
| `fetch_discord_history` | Fetch Discord channel/thread history |
| `check_inbox` | Re-check for new messages |
| `list_agents` | Discover registered agents and their status |

## Architecture

```
agent-com MCP Server
├── UI Adapter Layer
│   ├── Discord Adapter (send/receive, threads, DMs, typing)
│   └── More adapters planned (Slack, Telegram, LINE)
│
├── Communication Bus
│   ├── Message Routing (pg_notify push)
│   ├── Access Control (allowlists, mention rules)
│   ├── Safety (rate limit, loop detection, HMAC auth)
│   └── DB Persistence (all messages stored)
│
├── LLM Adapter Layer
│   ├── Anthropic (Claude)
│   ├── OpenAI (GPT)
│   └── Google (Gemini)
│
└── MCP Tools
    └── send_message / reply / fetch_messages / check_inbox / list_agents
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

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_ID` | Yes | Agent identifier |
| `DATABASE_URL` | No | PostgreSQL connection string |
| `AUN_WEBHOOK_PORT` | No | HTTP bridge port (preferred override; Issue #248 cycle 1) |
| `WEBHOOK_PORT` | No | HTTP bridge port (legacy override). If neither this nor `AUN_WEBHOOK_PORT` is set, the bridge picks a free port via real-bind probe in 8801-8900 (8800 is reserved for `AGENT_COMMS_PORT` / SSE). The pre-cycle-1 fixed default of `8789` was removed because it was the cascade-disconnect cause (Issue #248). |
| `DISCORD_BOT_TOKEN` | No | Discord bot token for Discord integration |
| `DISCORD_STATE_DIR` | No | Directory for Discord access control state |
| `AGENT_COMMS_SECRET` | No | HMAC shared secret (hex-encoded) |
| `LLM_PROVIDER` | No | LLM provider: anthropic, openai, google |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (for LLM adapter) |
| `OPENAI_API_KEY` | No | OpenAI API key (for LLM adapter) |
| `GOOGLE_API_KEY` | No | Google API key (for LLM adapter) |

### Security

| Mechanism | Description |
|-----------|-------------|
| **HMAC authentication** | Shared-secret signing with replay protection (5-min window) |
| **Rate limiting** | Configurable per-agent limits, DB-persisted |
| **Loop detection** | Depth limit (10) + exchange counter (20/5min window) |
| **Duplicate detection** | Content-hash dedup within 10-second window |
| **Content sanitization** | Mass-mention patterns (`@everyone`, `@here`) automatically removed |
| **Burst control** | 500ms minimum interval between outbound messages |

### Database Optional

| Mode | Features |
|------|----------|
| **With PostgreSQL** | Full features: persistent rate limits, loop counters, message history, agent discovery, pg_notify push |
| **Without PostgreSQL** | File-based fallback: in-memory safety, platform history for messages |

## Development

```bash
# Run tests
bun test tests/

# Run with watch mode
bun run dev

# Run database migrations
bun run migrate
```

## License

MIT — see [LICENSE](LICENSE)

---

## 日本語ドキュメント

詳細な仕様書は [docs/SSOT.md](docs/SSOT.md) を参照してください。

agent-comは、AIコーディングエージェント間のpush型通信を実現するMCPサーバーです。Claude CodeとOpenAI Codex CLIの両方で動作確認済み。pg_notify + Webhook方式により、ポーリング不要でメッセージがセッションに自動注入されます。
