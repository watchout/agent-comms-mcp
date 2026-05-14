# Runtime Adapter Architecture

agent-comms has one control plane: the database-backed native MCP protocol.
Runtime-specific integrations are adapters around that protocol, not alternate
delivery semantics.

## Control Plane

- `agent_messages` is the message log.
- `message_queue` is the per-agent delivery and work queue.
- `outbound_queue` is the external display sink queue.
- Native MCP tools are the write/read API: `next`, `send`, `notify`,
  `processing`, `done`.

Bot-to-bot delivery must be created by native MCP tools or by an explicitly
configured ingress bridge that writes the same DB shape. Plain Discord echo is
not a control-plane input.

## Runtime Adapters

| Runtime | Receive | Reply | Enforcement |
| --- | --- | --- | --- |
| Claude Code | `claude/channel` plus `next` fallback | `send` / `notify` | Stop hook blocks stdout-only replies |
| Codex CLI | `next` via MCP | `send` / `notify` via MCP | Repo instructions + Codex runner |
| Gemini / other CLI | `next` via MCP or CLI runner | `send` / `notify` via MCP/CLI | Runner contract |

Claude Code-specific hooks must not be treated as generic runtime behavior.
Codex and Gemini need native MCP instructions or a runner/wrapper because they
do not receive Claude Code Stop hook enforcement.

## Discord Surfaces

Discord has two supported roles:

- Human ingress: `author.isBot=false` messages can enter the control plane.
- Display sink: outbound messages are posted for human visibility.

Discord bot-authored messages are rejected by default. A bot-authored message
can enter only through an explicit bridge allowlist:

- Environment: `AGENT_COM_DISCORD_BOT_BRIDGE_IDS=<discord_bot_user_id,...>`
- Accepted source: `discord-bot-bridge`
- Rejected default source: plain `discord` bot echo

This prevents the 2026-05-14 duplicate-row class where one native
`agent-comms` send produced both source=`agent-comms` and source=`discord`
rows with different message IDs.

## Invariants

1. DB is the SSOT; runtime adapters never bypass `agent_messages` and
   `message_queue`.
2. Discord outbound echo is not a delivery source.
3. Bot-authored Discord ingress is opt-in by Discord bot user ID.
4. Bridge ingress is labelled `source='discord-bot-bridge'`.
5. Runtime adapters must preserve v0.9 single-recipient `mention` semantics on
   MCP `send` / `notify`.
6. During the compatibility window, tooling must tolerate the 8-value
   `message_queue.status` union:
   `pending`, `read`, `received`, `in_progress`, `done`, `replied`, `skipped`,
   `failed`.
