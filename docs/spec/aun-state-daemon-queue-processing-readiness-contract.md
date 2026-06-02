# AUN State-Daemon Queue Processing Readiness Contract

Status: proposed
Issue: #603
Scope: read-only queue-processing readiness evidence for AUN Discord recovery.

## Purpose

AUN recovery must not confuse Discord transport health with queue-processing
readiness. A Discord client can be healthy while state-daemon is unloaded, or
state-daemon can be running while queue wake progress is stuck. This contract
adds a read-only diagnostic surface that reports those axes separately before
any live smoke or host lifecycle action is requested.

## Invariants

1. `agent-com state-daemon queue-readiness` is read-only.
2. The command may run DB `SELECT` statements and read-only runtime inspection.
   It must not insert smoke rows, close queue rows, call `next`/`inbox`, restart
   state_daemon, call launchctl bootstrap/kickstart, write Discord, or mutate
   schema/data.
3. The report must separate:
   - `transport_readiness`: state-daemon/launchd/process/path/fatal stderr
     evidence.
   - `queue_processing_readiness`: pending/active queue counts, queue wake
     state counts, and exact stuck agent evidence.
4. `STATE_DAEMON_TRANSPORT_NOT_READY` blocks when the state-daemon transport
   axis is not ready.
5. `QUEUE_WAKE_STUCK` blocks when pending queue work has no safe wake progress
   or active work is suppressing pending wake growth.
6. `GO` means read-only evidence is clean. It does not authorize a live queue
   wake smoke, state_daemon restart, launchctl mutation, or Discord write.

## Required JSON Fields

- `go_no_go`
- `transport_readiness.ready`
- `transport_readiness.state_daemon_status`
- `transport_readiness.blocker_codes`
- `queue_processing_readiness.ready`
- `queue_processing_readiness.pending_total`
- `queue_processing_readiness.active_claim_total`
- `queue_processing_readiness.wake_state_counts`
- `queue_processing_readiness.stuck_agents`
- `queue_processing_readiness.blocker_codes`
- `policy.no_db_mutation`
- `policy.no_state_daemon_restart`
- `policy.no_launchctl_mutation`
- `policy.no_next_inbox_fifo_drain`
- `policy.no_live_smoke`
- `mutation_performed`
- `restart_performed`

## Non-Goals

- No live queue wake smoke.
- No state_daemon restart.
- No launchctl bootstrap/kickstart.
- No Discord live write.
- No DB mutation, schema migration, or queue terminalization.
