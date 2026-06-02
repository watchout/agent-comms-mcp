# AUN Local Supervisor Adapter Implementation Plan

> Issues: #602, #603
> Prerequisite: #669 runtime supervisor adapter contract
> Status: draft implementation slice
> Last updated: 2026-06-02

## Purpose

This slice defines the first local supervisor adapter implementation under the
runtime-neutral contract from #669. It is deliberately local and host-specific:
launchd and tmux are adapter evidence sources for this machine class, not AUN
core architecture.

AUN core continues to own desired runtime state, endpoint identity, queue
readiness, wake-up semantics, and GO/NO-GO policy. The local launchd/tmux
adapter owns only host supervisor evidence and future host-state actions.

## Scope

The implementation prepares persistent state-daemon recovery without executing
recovery:

- local launchd supervisor adapter evidence for `state_daemon`
- optional tmux session inspection as evidence only
- persistent approved checkout and build artifact paths
- ProgramArguments and WorkingDirectory preflight before any load/start action
- atomic LaunchAgent update plan as dry-run evidence
- cleanup protection for paths referenced by the active LaunchAgent

This slice does not restart state_daemon, load launchd jobs, activate Discord,
drain queue rows, or call a live runtime.

## Local Launchd Adapter

The local launchd adapter consumes an existing LaunchAgent plist or a proposed
restore plan and emits normalized runtime-supervisor evidence:

| Field | Evidence |
|---|---|
| `runtime_kind` | `state_daemon` |
| `supervisor_kind` | `launchd` |
| `endpoint_identity` | LaunchAgent label plus expected listener `agent_id=state_daemon` |
| `paths` | ProgramArguments[0], ProgramArguments[1], WorkingDirectory, plist, logs |
| `capabilities` | `inspect` and `readiness` supported; `start`/`restart` disabled unless a future execution slice explicitly enables them |
| `health.failure_codes` | LaunchAgent preflight issue codes |

The adapter is read-only in this slice. It returns `mutation_performed:false`
and `restart_performed:false` for every report.

## Persistent Path Policy

LaunchAgent ProgramArguments and WorkingDirectory must point at durable,
operator-owned paths. `/tmp` and `/private/tmp` are blocker paths unless a
separate approved restore-owned exception is introduced.

Required path checks:

- ProgramArguments[0] exists, is a file, and is executable
- ProgramArguments[1] exists before launchd is asked to load or start anything
- WorkingDirectory exists and is a directory
- ProgramArguments[1] is not an unowned volatile checkout
- WorkingDirectory is not an unowned volatile checkout
- build verification artifacts are outside the managed checkout so repeat
  restore does not dirty the checkout

Missing executable, missing entrypoint, missing WorkingDirectory, wrong listener
identity, or volatile path evidence is NO-GO.

## Atomic LaunchAgent Update Plan

The local adapter can produce a dry-run install/update plan. The plan includes:

1. proposed persistent checkout path
2. proposed build artifact path
3. final LaunchAgent plist path
4. temporary plist path
5. rendered plist text
6. preflight result for the rendered plist
7. atomic update method: write temp plist, then rename over the final plist

The dry-run plan does not write files, rename plists, load launchd jobs, or
start state_daemon. A future execution slice must require exact approval
evidence before any host-state mutation.

## Cleanup Protection

Cleanup is planned from LaunchAgent evidence, not from age alone. Any checkout
referenced by the active LaunchAgent ProgramArguments or WorkingDirectory is
`protect`, not `delete`.

Cleanup output is dry-run only in this slice. An execution slice must keep
exact path evidence, approval, and rollback/audit evidence separate.

## Optional Tmux Inspector

tmux is local adapter evidence only. The optional inspector may report whether a
named session is present and whether its current path is volatile. It does not
send keys, create sessions, kill sessions, or provide queue-processing
authority.

tmux evidence must not be used as AUN identity, channel ownership, endpoint
authority, or proof that queue work was processed.

## Mutation Policy

Host-state mutation requires all of the following:

1. requested capability is explicitly supported by the adapter
2. requested capability does not rely on prompt-driven queue processing
3. approval evidence exactly matches `agent_id`, `supervisor_kind`, and intent
4. CP-70 and CP-80 preflight inputs are GO for the exact scope
5. execution command is in a separate approved slice

An adapter without `start`/`restart` capability cannot mutate host state. A
capability marked `requires_approval:true` is NO-GO without exact matching
approval, regardless of intent.

## Non-Recovery Mechanisms

The following are never recovery mechanisms:

- TUI prompt injection
- asking an LLM to call queue lifecycle tools
- FIFO queue drain
- bulk terminalization of active rows
- state_daemon restart as a substitute for queue/projection evidence

Queue recovery must be bounded, exact-scope, and canary-first.

## Relationship To Other Slices

- #667 provides the current local LaunchAgent readiness diagnostic. It is local
  launchd evidence, not the general recovery architecture.
- #668 provides the reboot recovery runbook. It consumes supervisor evidence but
  does not define the adapter architecture.
- #669 defines the runtime supervisor adapter contract. This plan implements the
  first persistent local adapter under that contract.

## Acceptance

- `/private/tmp` LaunchAgent targets are NO-GO
- missing ProgramArguments or WorkingDirectory is rejected before launchd load
- active LaunchAgent referenced checkout paths are cleanup-protected
- adapter without `start`/`restart` capability cannot mutate host state
- approval evidence is required for any approval-required host-state capability
- optional tmux inspector is evidence-only
- reports and plans always include `mutation_performed:false`
- no state_daemon restart, launchd load/start, Discord write, queue drain, or
  live runtime call is executed
