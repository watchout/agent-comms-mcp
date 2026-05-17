# AUN MCP Registration And Namespace Runbook

## Naming Policy

- Product/user-facing name: `AUN`.
- Canonical MCP server registration name for new sessions: `aun`.
- Canonical tool namespace for new sessions: `mcp__aun__*`.
- Temporary legacy aliases during migration: `agent-comms` registration, `mcp__agent_comms__*`, and `mcp__agent-comms__*`.

Hooks and operator prompts must list `mcp__aun__*` first. Legacy aliases may remain accepted where the MCP host exposes them, but new configs should not introduce fresh `agent-comms` registrations unless they are explicitly rollback aliases.

## Environment

Use the runtime identity for the bot being registered:

```bash
AGENT_ID=<agent-id>
AGENT_COM_EXPECTED_AGENT_ID=<agent-id>
DATABASE_URL='postgresql:///agent_comms?host=/tmp'
AGENT_COM_PG_NOTIFY=false
AGENT_COMMS_TTL_SWEEP_DISABLED=1
```

Do not mutate production DB identity rows, CTO tokens, bot registry, launchd state-daemon plist, or broad `.mcp.json` files as part of this runbook unless a separate approval explicitly authorizes that mutation.

## Codex Registration

Config path:

- User config: `~/.codex/config.toml`
- Inspect current entries: `codex mcp list` and `codex mcp get aun`

Canonical registration:

```bash
codex mcp add aun \
  --env AGENT_ID=<agent-id> \
  --env AGENT_COM_EXPECTED_AGENT_ID=<agent-id> \
  --env DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  --env AGENT_COM_PG_NOTIFY=false \
  --env AGENT_COMMS_TTL_SWEEP_DISABLED=1 \
  -- bun run --cwd /path/to/agent-comms-mcp server.ts
```

Rollback alias, only if an old session cannot yet load `aun`:

```bash
codex mcp add agent-comms \
  --env AGENT_ID=<agent-id> \
  --env AGENT_COM_EXPECTED_AGENT_ID=<agent-id> \
  --env DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  --env AGENT_COM_PG_NOTIFY=false \
  --env AGENT_COMMS_TTL_SWEEP_DISABLED=1 \
  -- bun run --cwd /path/to/agent-comms-mcp server.ts
```

Remove a rollback alias after the session has moved:

```bash
codex mcp remove agent-comms
```

## Claude Registration

Config paths:

- User scope: `~/.claude.json`
- Project scope: `<repo>/.mcp.json`
- Claude settings and hooks: `~/.claude/settings.json`

Canonical user-scope registration:

```bash
claude mcp add --scope user --transport stdio aun -- \
  /path/to/bun run --cwd /path/to/agent-comms-mcp server.ts
```

For env-bearing installs, use `aun init` or pass `-e` values explicitly:

```bash
claude mcp add --scope user --transport stdio \
  -e AGENT_ID=<agent-id> \
  -e AGENT_COM_EXPECTED_AGENT_ID=<agent-id> \
  -e DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  -e AGENT_COM_PG_NOTIFY=false \
  -e AGENT_COMMS_TTL_SWEEP_DISABLED=1 \
  aun -- /path/to/bun run --cwd /path/to/agent-comms-mcp server.ts
```

Temporary rollback alias:

```bash
claude mcp add --scope user --transport stdio \
  -e AGENT_ID=<agent-id> \
  -e AGENT_COM_EXPECTED_AGENT_ID=<agent-id> \
  -e DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  -e AGENT_COM_PG_NOTIFY=false \
  -e AGENT_COMMS_TTL_SWEEP_DISABLED=1 \
  agent-comms -- /path/to/bun run --cwd /path/to/agent-comms-mcp server.ts
```

Remove the rollback alias after migration:

```bash
claude mcp remove --scope user agent-comms
```

## Hook Compatibility

The bundled hooks enforce and document namespace compatibility:

- `hooks/pre-tool-use-inbox-gate.ts` allows `mcp__aun__{next,send,notify,skip,fail,reclaim}` and both legacy namespace forms.
- `hooks/aun-send-tool-enforcement.sh` treats `mcp__aun__send` / `mcp__aun__notify` as canonical and accepts both legacy send/notify aliases.
- `hooks/claim-close-enforcement.ts`, `hooks/auto-next.sh`, `hooks/aun-session-start-drain.sh`, and `hooks/aun-session-start-self-kick.sh` prompt for `mcp__aun__next` first and mention legacy aliases only as migration support.

## Smoke Plan

Fresh `aun` direct delivery:

1. Start a new MCP session with only the `aun` registration enabled.
2. Send a DB or Discord ingress message addressed to the target agent.
3. Confirm the state daemon wakes the session.
4. Call `mcp__aun__next` and verify it claims the expected `message_queue` row.
5. Reply with `mcp__aun__send`.
6. Confirm a durable `outbound_queue` row exists and the Discord projection posts the reply.

Legacy alias behavior:

1. Start a controlled rollback session with only `agent-comms` enabled.
2. Confirm the client exposes either `mcp__agent_comms__next` or `mcp__agent-comms__next`.
3. Repeat direct delivery with the exposed legacy `next` and `send` names.
4. Confirm hook prompts still recommend `mcp__aun__*` while accepting the legacy tool call.

Useful DB checks:

```sql
SELECT id, message_id, agent_id, status, claimed_by, created_at, claimed_at
FROM message_queue
WHERE agent_id = '<agent-id>'
ORDER BY id DESC
LIMIT 10;

SELECT id, agent_id, channel_id, status, created_at, sent_at
FROM outbound_queue
WHERE agent_id = '<agent-id>'
ORDER BY id DESC
LIMIT 10;
```

## Rollback

1. Leave the canonical `aun` entry in place.
2. Add a temporary `agent-comms` alias for the affected client only.
3. Restart only that local MCP client session, not production daemon services.
4. Verify delivery through the legacy namespace.
5. Remove the alias after the client can expose `mcp__aun__*`.
