# Core Routing Agent ID SSOT

## Decision

Agent-com core routing uses `agent_id` as the only delivery identity.

- `channels.members` is the DB-owned recipient allowlist for a channel.
- `message_queue.agent_id` is the recipient inbox key.
- `agents.agent_id` is the registered bot/human identity.
- Chat adapters may map external platform IDs to `agent_id`, but only inside the channel member set.
- Discord/Telegram/Slack/user-interface IDs are adapter metadata, not core routing keys.

## Required Flow

For an agent-originated send or notify:

1. The caller selects a recipient from `channels.members`.
2. The tool writes `agent_messages`.
3. The tool inserts one `message_queue` row per selected `agent_id`.
4. Chat UI delivery is optional and downstream.

For a chat-adapter inbound message:

1. The adapter resolves the external channel to a core channel.
2. The adapter translates platform mentions to `agent_id` only if exactly one `channels.members` entry owns that external ID.
3. Ambiguous or non-member external IDs fail closed and do not enqueue.
4. Core routing receives only agent IDs or group keywords.

## Non-Goals

- Core routing must not globally resolve `<@discord_id>` to an arbitrary agent.
- Core routing must not require Discord metadata to deliver bot-to-bot messages.
- Chat UI configuration must not be required for DB-only operation.

## Rationale

Using global adapter IDs as routing input makes delivery depend on chat UI state. If two agents share the same `metadata.discord_id`, a Discord mention can be routed to the wrong inbox. The DB channel membership already contains the intended recipient set, so it is the correct source for scripted recipient selection.
