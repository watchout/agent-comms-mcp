# Startup Safety Contract

Issue: #739

## Purpose

Bot startup and restart paths must fail closed before they mutate tmux sessions,
ports, runtime rows, or Discord/AUN connector state. Communication recovery work
is not reliable until every local launcher uses the same startup safety checks.

## Entry Points

The contract applies to:

- `scripts/restart-bot.sh`
- `server.ts` `restart_bot`
- watchdog restart paths
- future launchd restore helpers that start bot runtimes

## Preflight Blockers

A launcher must not start or replace a runtime when any blocker is present:

- `forbidden_codex_agent_comms_disable`: command contains
  `mcp_servers.agent-comms.enabled=false`.
- `expected_agent_mismatch`: requested `AGENT_ID` differs from
  `AGENT_COM_EXPECTED_AGENT_ID` or command-level identity overrides disagree.
- `managed_checkout_stale`: launcher runs from a managed state-daemon checkout
  that is not the `current` checkout.
- `launcher_root_unapproved`: launcher root is outside the explicit approved
  roots supplied by the operator.
- `port_owned_by_different_agent`: requested port is listening for a different
  live agent.
- `port_owner_unknown`: requested port has a non-orphan listener whose agent
  identity cannot be proven.
- `tmux_session_bound_to_different_agent`: requested tmux session already has
  live runtime evidence for another agent.
- `codex_normal_screen_enter`: launcher would send an extra Enter to a normal
  Codex start screen instead of only responding to an explicit update prompt.

## Allowed Conditions

- No listener exists on the requested port.
- The listener is owned by the same expected agent.
- The listener is an orphan and will be handled by canonical orphan cleanup.
- The launcher root is outside the managed state-daemon checkout tree, unless
  explicit approved roots are supplied.
- The Codex post-start policy is `update_prompt_only` or `none`.

## Startup Success Evidence

Current #739 packaging implements the pre-mutation fail-closed gate only. The
post-start evidence below is required before deploy activation, fleet rollout,
or treating an automated restart as complete. It is intentionally split out as
a follow-up activation gate and this PR does not authorize deploy activation.

A restart is not complete until a post-start check can prove:

- tmux session exists for the DB profile.
- MCP server listens on the expected port.
- process env/command resolves to the expected `AGENT_ID`.
- `agent_runtime_instances` has a fresh running row for the same agent, port,
  checkout, and process id.
- `agents.last_seen_at` is fresh under the configured threshold.

## Rollout Boundary

This contract does not authorize #722 scheduler enablement, fleet-wide runner
rollout, production launchd mutation, or Discord gateway recovery. Those remain
separate protected operations after startup safety is implemented and audited.
