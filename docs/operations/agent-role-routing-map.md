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
| Evidence audit gate | `codex-audit` | Requires `active_function=evidence_audit_gate` and `canonical_seat=codex-audit`. There is no fallback to `l2auditor` or `devauditor`. |
| Scenario verification gate | `devauditor` | Failure/recovery reproduction only. It cannot issue `evidence_audit_gate` verdicts. |
| L3 / CTO approval | `codex-cto` | CTO approval recipient. Legacy `cto` is history-only and must not receive new governance work. |

Historical `pr_audit_l1` / `pr_audit_l2` role keys and the `l2auditor`
identity are retained only for old artifacts. They are not normal search,
directory, mention, or routing targets. Use explicit include-historical
diagnostics to inspect them.

## Per-Slice Overrides

CEO may override the default route for a specific slice. The override must be
recorded in the slice plan so later gates do not silently fall back to the
default table.

The row below is historical_only, non-routable, and closed to new work. It is
retained as provenance for old NORM-022 artifacts, not as current operational
guidance.

| Slice | L1 | L2 | L3 | Source | Current status |
|---|---|---|---|---|---|
| NORM-022 runtime endpoint lease | `devauditor` | `l2auditor` | `cto` | CEO directive 2026-05-27 | historical_only / non-routable / no new work |

At the time of the NORM-022 route update, live DB rows existed for
`devauditor`, `l2auditor`, and `cto`; `cto` was disabled. Under current
Shirube V3 routing, this record must not activate a delivery route:
`l2auditor` and `cto` are historical-only tombstones, and `devauditor` is
active only for `scenario_verification_gate`.

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
facts without mutating production state. Use canonical CLI diagnostics, not
direct SQL:

```bash
bun cli/index.ts audit-route --active-function evidence_audit_gate --canonical-seat codex-audit
bun cli/index.ts audit-route --active-function evidence_audit_gate --canonical-seat devauditor
bun cli/index.ts audit-route --active-function scenario_verification_gate --agent-id devauditor
bun cli/index.ts directory --format json
bun cli/index.ts directory --include-historical --format json
bun cli/index.ts agent retire l2auditor --dry-run --reason "role-routing live dry-run"
```

Pass criteria:

- `codex-aun`, `codex-audit`, and `codex-cto` exist as active routable
  identities.
- `l2auditor` and `cto` may exist only as disabled or historical-only legacy
  identities.
- Default directory output omits `l2auditor`; include-historical diagnostics
  expose the historical tombstone, and `agent retire l2auditor --dry-run`
  lists any active projections that execute mode would disable before the
  final tombstone.
- `evidence_audit_gate` without `canonical_seat=codex-audit` fails closed.
- `devauditor` is accepted only for `scenario_verification_gate`.
- Channel `1487368919613444156` includes the canonical current role recipients.
- No new PR governance request targets `cto` unless a per-slice CEO override
  records that legacy target and its live route has been repaired.
- AUN lead MCP registration uses `AGENT_ID=codex-aun`; if it sends as
  `codex-cto`, restart or re-register that MCP session before continuing.

## Relationship To Identity Issues

- #440 owns the broader alias/UI-ready identity model.
- #470 owns separation of AUN author identity, outbound consumer identity, and
  Discord projection identity.
- This map is the operational bridge until those broader models are fully
  implemented. It must not introduce projection semantics or Discord token
  ownership into role routing.
