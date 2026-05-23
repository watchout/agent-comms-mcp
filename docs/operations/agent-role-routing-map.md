# Agent Role Routing Map

Issue: #440 / #470 coordination

## Decision

Operational roles are not delivery identities. AUN delivery still uses
canonical `agent_id`, and role labels must resolve through
`config/agent-role-routing.json` before a message is sent.

Current PR governance routing:

| Role | Canonical agent_id | Notes |
|---|---|---|
| AUN development lead | `codex-aun` | Codex/AUN operator session. Its MCP registration must run with `AGENT_ID=codex-aun`. |
| L1 PR audit | `auditor` | Independent L1 audit recipient. |
| L2 PR audit | `codex-audit` | Independent L2 audit recipient. Runtime dispatch is determined by the live `agents.runtime` row. |
| L3 / CTO approval | `codex-cto` | CTO approval recipient. Legacy `cto` is history-only and must not receive new governance work. |

## Failure Mode This Prevents

If an AUN lead session tries to notify L3 and receives `SELF_SEND` for
`codex-cto`, the problem is not that L3 needs a relay. The local MCP server is
running under the wrong sender identity. Fix the session registration so the
AUN lead sends as `codex-aun`.

Do not work around this by sending L3 through a human relay as normal process.
Relay is acceptable only as a temporary incident workaround while the mapping or
registration is being repaired.

## Required AUN Lead Registration

For the AUN development lead session:

```bash
AGENT_ID=codex-aun
AGENT_COM_EXPECTED_AGENT_ID=codex-aun
DATABASE_URL='postgresql:///agent_comms?host=/tmp'
```

The MCP registration name should be `aun`. Legacy `agent-comms` registrations
may remain only as temporary compatibility aliases and must carry the same
`AGENT_ID` / `AGENT_COM_EXPECTED_AGENT_ID` pair.

## Codex Runtime Restart SSOT

Codex-backed governance runtimes must be restarted through
`scripts/bot-registry.txt`, not ad hoc tmux commands. Codex reads
`~/.codex/config.toml` before project `.mcp.json`, so the registry command must
carry explicit MCP overrides for the runtime identity.

Required registry rows:

| Session | Project dir | agent_id | Port | Notes |
|---|---|---:|---:|---|
| `codex-audit` | `~/Developer/codex-audit` | `codex-audit` | `8840` | L2 audit runtime. Disable `wasurezu` unless explicitly needed. |
| `discord-cto` | `~/Developer/codex` | `codex-cto` | `8789` | L3/CTO runtime. Keep `wasurezu` identity aligned to `codex-cto` / `codex`. |

Restart commands:

```bash
scripts/restart-bot.sh codex-audit
scripts/restart-bot.sh discord-cto
```

Pass criteria after restart:

- `agent_runtime_instances` has fresh `running` rows for `codex-audit` and
  `codex-cto`.
- `codex-audit` listens on `127.0.0.1:8840`.
- `codex-cto` listens on `127.0.0.1:8789`.
- Both runtime rows report the same `commit_sha` as the deployed AUN checkout.
- `message_queue` active count and `outbound_queue` active count do not
  increase during restart.

## Read-Only Preflight

Before PR governance handoff, verify the role map against live registration
facts without mutating production state:

```bash
psql 'postgresql:///agent_comms?host=/tmp' -P pager=off -c "
BEGIN READ ONLY;
SELECT agent_id, display_name, agent_type, runtime, status,
       metadata->>'tmux_session' AS tmux_session
  FROM agents
  WHERE agent_id IN ('codex-aun','auditor','codex-audit','codex-cto','cto')
  ORDER BY agent_id;
SELECT id, members
  FROM channels
  WHERE id = '1487368919613444156';
ROLLBACK;"
```

Pass criteria:

- `codex-aun`, `auditor`, `codex-audit`, and `codex-cto` exist.
- `cto` may exist only as a disabled or history-only legacy alias.
- Channel `1487368919613444156` includes the canonical role recipients.
- No new PR governance request targets `cto`.
- AUN lead MCP registration uses `AGENT_ID=codex-aun`; if it sends as
  `codex-cto`, restart or re-register that MCP session before continuing.

## Relationship To Identity Issues

- #440 owns the broader alias/UI-ready identity model.
- #470 owns separation of AUN author identity, outbound consumer identity, and
  Discord projection identity.
- This map is the operational bridge until those broader models are fully
  implemented. It must not introduce projection semantics or Discord token
  ownership into role routing.
