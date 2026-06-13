# #417 Codex CTO Identity Normalization Runbook

> **ADR-060 legacy note (2026-05-21):** This runbook records the pre-ADR-060
> native-role outbound model used during the #417 identity normalization plan.
> It is still useful as historical execution context for moving the Discord CTO
> runtime from `cto` to `codex-cto`, but its outbound projection expectations are
> not the target model for new implementation work. For PR 2+ of ADR-060, treat
> `nativeRoleOutboundOwners` as deprecated compatibility input and keep
> `consumer_agent_id` as delivery adapter ownership only. Native Discord display
> intent must move to the ADR-060 projection identity model.

This runbook is planning-only until CEO/CTO approve an execution window. Do not run production DB mutation, `.mcp.json` edits, `bot-registry.txt` edits, or `discord-cto` restarts from this PR.

## Scope

CEO-approved Step 1 + Step 2:

1. Move the existing CTO Discord identity from legacy `cto` to `codex-cto`.
2. Migrate the `discord-cto` runtime to `AGENT_ID=codex-cto`.
3. Let `codex-cto` egress through the CTO native Discord adapter identity while preserving #411 `adapterOwner` fallback for other agents.

## Current State To Confirm

Before mutation:

```sql
SELECT agent_id, display_name, agent_type, status, metadata, last_seen_at
FROM agents
WHERE agent_id IN ('cto', 'codex-cto')
ORDER BY agent_id;

SELECT agent_id, status, count(*)::int AS n
FROM message_queue
WHERE agent_id IN ('cto', 'codex-cto')
GROUP BY agent_id, status
ORDER BY agent_id, status;

SELECT agent_id, coalesce(consumer_agent_id, '<null>') AS consumer, status, count(*)::int AS n
FROM outbound_queue
WHERE agent_id IN ('cto', 'codex-cto') OR consumer_agent_id IN ('cto', 'codex-cto')
GROUP BY agent_id, coalesce(consumer_agent_id, '<null>'), status
ORDER BY status, agent_id, consumer;
```

Expected pre-mutation facts observed on 2026-05-16:

- `cto.metadata.discord_id = 1485599598259994635`
- `cto.metadata.tmux_session = discord-cto`
- `codex-cto.metadata = {}`
- no active `pending` / `received` / `in_progress` `message_queue` rows for `cto` or `codex-cto`
- `codex-cto` has legacy pre-#411 `outbound_queue` rows with `consumer_agent_id IS NULL`; do not release them as part of this migration

## DB Mutation Plan

Snapshot first:

```sql
CREATE TABLE IF NOT EXISTS ops_identity_migration_417_snapshot AS
SELECT now() AS snapshot_at, agent_id, display_name, metadata
FROM agents
WHERE false;

INSERT INTO ops_identity_migration_417_snapshot (snapshot_at, agent_id, display_name, metadata)
SELECT now(), agent_id, display_name, metadata
FROM agents
WHERE agent_id IN ('cto', 'codex-cto');
```

Apply after approval:

```sql
BEGIN;

UPDATE agents
SET display_name = 'codex-cto',
    metadata = jsonb_set(
      jsonb_set(coalesce(metadata, '{}'::jsonb), '{discord_id}', '"1485599598259994635"'::jsonb, true),
      '{tmux_session}', '"discord-cto"'::jsonb,
      true
    )
WHERE agent_id = 'codex-cto';

UPDATE agents
SET display_name = 'legacy-cto',
    metadata = (coalesce(metadata, '{}'::jsonb) - 'discord_id' - 'tmux_session')
      || '{
        "deprecated": true,
        "alias_for": "codex-cto",
        "legacy_discord_id": "1485599598259994635",
        "legacy_tmux_session": "discord-cto",
        "deprecated_reason": "identity_normalization_417"
      }'::jsonb
WHERE agent_id = 'cto';

COMMIT;
```

Do not rewrite historical `agent_messages.author_id = 'cto'` or `message_queue.agent_id = 'cto'` rows.

## Runtime Migration Plan

After DB mutation approval:

1. Update the runtime source to `~/Developer/codex`.
   Codex reads `~/.codex/config.toml` before project `.mcp.json`, so the
   controlled runtime command must pass explicit MCP overrides:
   - `mcp_servers.aun.env.AGENT_ID="codex-cto"`
   - `mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="codex-cto"`
   - `mcp_servers.aun.env.WEBHOOK_PORT="8789"`
   - `mcp_servers.aun.env.DISCORD_STATE_DIR="/Users/yuji/.claude/channels/discord-cto"`
   - Do not pass `mcp_servers.agent-comms.enabled=false`. Codex 0.139 treats
     that as an incomplete MCP server definition when no legacy `agent-comms`
     registration exists, and fails startup with `invalid transport`.
2. Update `scripts/bot-registry.txt` operational mapping:
   - `discord-cto|~/Developer/codex|codex-cto|8789|...`
3. Controlled restart:
   - stop/restart `discord-cto`
   - verify the runtime registers as `codex-cto`

Do not rename the tmux session in the first cut. Keeping `discord-cto` reduces operational churn while the DB identity changes.

## Native-Role Outbound Override

This section describes the legacy compatibility behavior that existed before
ADR-060. Do not use it as the design target for new outbound projection slices.
Under ADR-060, `nativeRoleOutboundOwners` may be read only to infer legacy
intent during migration; it must not become a consumer-owner override in the new
model. `consumer_agent_id` answers "which adapter runtime consumes this outbound
row?", while Discord display identity belongs in the projection identity model.

`config/bot-routing.json` supports `nativeRoleOutboundOwners` per channel:

```json
{
  "channels": {
    "1487368919613444156": {
      "adapterOwner": "agent-com-dev",
      "nativeRoleOutboundOwners": {
        "codex-cto": "codex-cto"
      }
    }
  }
}
```

Resolution order:

1. explicit thread adapter metadata owner
2. explicit channel adapter metadata owner
3. `nativeRoleOutboundOwners[senderAgentId]`
4. #411 `adapterOwner`
5. `primary`

This preserves #411 `adapterOwner=agent-com-dev` for fine-grained agents while letting `codex-cto` rows be claimed by the `codex-cto` runtime.

## Rollback

1. Restore `agents` from `ops_identity_migration_417_snapshot` for `cto` and `codex-cto`.
2. Restore `/Users/yuji/Developer/tech-lead/.mcp.json` to `AGENT_ID=cto` and remove/restore `AGENT_COM_EXPECTED_AGENT_ID`.
3. Restore `scripts/bot-registry.txt` to `discord-cto|~/Developer/tech-lead|cto|8789|...`.
4. Restart `discord-cto`.
5. Verify:

```sql
SELECT agent_id
FROM agents
WHERE metadata->>'discord_id' = '1485599598259994635';
```

Rollback success returns exactly `cto`.

## E2E Smoke Plan

Do this after approved DB/runtime mutation and controlled restart.

This smoke plan validates the legacy #417 native-role migration. For ADR-060 PR
2+ implementation smoke, update the outbound expectations so native-unavailable
projection falls back to the channel adapter owner while recording the intended
projection identity and fallback reason.

1. Discord/DB ingress:
   - inject or send in channel `1487368919613444156`:
     - `<@1485599598259994635> identity normalization smoke <timestamp>`
   - expected resolver output: `codex-cto`, not `cto`
2. State daemon wake:
   - confirm `message_queue` row exists for `agent_id='codex-cto'`
   - confirm wake path targets the `discord-cto` runtime now running as `codex-cto`
3. Receive claim:
   - `AGENT_ID=codex-cto AGENT_COM_EXPECTED_AGENT_ID=codex-cto DATABASE_URL=... bun cli/index.ts next`
   - expected queue row status transitions to `received` with `claimed_by='codex-cto'`
4. Durable reply:
   - reply with explicit `--queue-id` / `--message-id`
   - expected inbound row becomes `replied`
5. Outbound queue:
   - expected reply `outbound_queue.agent_id='codex-cto'`
   - expected `outbound_queue.consumer_agent_id='codex-cto'`
6. Discord projection:
   - expected status `sent`
   - expected non-null `discord_message_id`

Stop and roll back if the Discord ID resolves to multiple agents, if `cto` receives the ingress row, if `consumer_agent_id` is `agent-com-dev` for a `codex-cto` reply in the configured channel, or if the restarted runtime still registers as `cto`.
