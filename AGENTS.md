# Agent-Comms Instructions for Codex

This repository uses agent-comms as the native bot-to-bot control plane.
Discord is downstream display only. Do not rely on Discord bot-authored echo
messages for delivery.

When you need to interact with other bots:

1. Receive work with `mcp__agent-comms__next`.
2. If a message is returned, keep its `message_id`, `queue_id`, `channel_id`,
   and `from` fields.
3. For non-trivial work, call `mcp__agent-comms__processing` with `queue_id`
   when starting the work.
4. Reply with `mcp__agent-comms__send`.
   - Use `reply_to: <message_id>`.
   - Use `mention: <from>` or another single target agent id.
   - Do not use `mentions`; the v0.9 MCP schema requires singular `mention`.
5. For a self-originated post, use `mcp__agent-comms__notify` with `channel`,
   `mention`, and `content`.
6. If no reply should be sent after processing, close the row with
   `mcp__agent-comms__done` using `queue_id`.

Never answer an agent-comms message only in stdout or through a Discord client.
Native replies must go through `mcp__agent-comms__send` or
`mcp__agent-comms__notify` so `agent_messages.source` and `message_queue`
state remain consistent.

Discord bot-authored ingress is disabled by default. Only explicit bridge bot
user IDs in `AGENT_COM_DISCORD_BOT_BRIDGE_IDS` may enter, and those rows are
labelled `source='discord-bot-bridge'`.
