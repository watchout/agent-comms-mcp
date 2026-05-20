# Queue P0 Blockers

Status: Proposed
Owner: codex-cto
Date: 2026-05-20

## Problem

`message_queue` is intended to be the SSOT for bot work, but the current runtime
cannot yet prove that a queued item will be processed in a predictable order and
closed with durable evidence.

The core design is still usable: durable rows, per-row claims, and
`FOR UPDATE SKIP LOCKED` are the right foundation. The blocker is that several
state vocabularies, runners, and wake paths coexist without one operator-facing
diagnostic that explains why a row is stuck.

## Blockers

### B1. Status Vocabulary Split

Observed statuses still include both old and new vocabulary:

- old: `read`, `skipped`, `failed`
- new: `pending`, `received`, `in_progress`, `done`, `replied`

Risk:

- Operators cannot tell which terminal state is authoritative.
- Tests and migrations keep carrying compatibility branches.
- `replied` and `done` compete as terminal states.

Immediate response:

- Add `agent-com diagnose-queue` / `agent-com queue doctor` so mixed status
  rows are visible before any merge or runtime probe.

Target response:

- Define one queue job state machine:
  `pending -> received -> in_progress -> done`.
- Treat reply messages as output events, not as the job terminal state.
- Migrate or explicitly archive legacy `read/skipped/failed` rows.

Acceptance criteria:

- `diagnose-queue` reports zero `legacy_status_mix` rows in production.
- New code does not create `read`.
- `done_at` is present for every terminal job close.

### B2. TUI Wake Is Not Processing

`state_daemon` can wake a TUI, but the actual claim still depends on the TUI
calling `next`. A tmux prompt can be interrupted, ignored, or manually
overwritten.

Risk:

- `pending` can remain pending despite "wake ok".
- Manual `tmux send-keys` can bypass queue order.
- A bot can be visually active while queue state stays unchanged.

Immediate response:

- Ban direct task injection into tmux. Only generic wake text is allowed.
- Queue doctor surfaces stale pending rows and TUI rows without a managed
  `tmux_session`.

Target response:

- The daemon should only claim work through deterministic command runners.
- TUI wake should be a notification path, not the execution authority.

Acceptance criteria:

- For any queue row, a diagnostic explains whether it is waiting, claimed,
  running, blocked by active claim, or un-routable.
- No operational runbook requires typing the task body into tmux.

### B3. Active Claim Semantics Are Split

`received` is used as both "claimed but not started" and "work currently owned".
`in_progress` exists, but many flows do not require it.

Risk:

- Monitoring cannot distinguish claimed/idle from actively processing.
- `done` requires `in_progress`, while reply close can end from `received`.
- Long-running audits can look stale.

Immediate response:

- Diagnose `received` / `in_progress` rows missing owners or expired
  `claim_expires_at`.

Target response:

- Make `received` a short claim state.
- Require `in_progress` for long work.
- Require `done` or explicit terminal close for every retained claim.

Acceptance criteria:

- No `received` row exceeds the claim TTL unless renewed by a deterministic
  heartbeat.
- Long audits transition to `in_progress`.

### B4. Retired And Offline Agents Keep Backlog

Retired or offline identities can still have pending rows, for example after an
identity migration such as `lead-ama -> codex-aun`.

Risk:

- Work is silently stranded on an identity that will never process it.
- Relay identities continue to attract work after retirement.

Immediate response:

- Queue doctor flags `retired_or_offline_recipient`.

Target response:

- Add a reassign/retire migration command:
  `agent-com queue reassign --from lead-ama --to codex-aun`.
- Prevent enqueue to `metadata.retired=true` agents unless an explicit override
  is supplied.

Acceptance criteria:

- Retired agents have zero non-terminal queue rows.
- Enqueue to retired agents fails closed with a clear diagnostic.

### B5. ACK/Progress Messages Become Work

ACK rows such as `ACK: received by ...` can remain as pending work for the
recipient.

Risk:

- ACK spam blocks real work.
- Bots repeatedly consume system-info messages instead of actionable tasks.

Immediate response:

- Queue doctor flags `ack_spam_pending`.

Target response:

- Store ACK/progress as delivery evidence or system notifications, not normal
  actionable queue work.
- Auto-close known ACK/progress rows or mark them non-actionable.

Acceptance criteria:

- ACK/progress rows do not appear in actionable receive.
- System info rows are searchable as evidence without blocking work.

### B6. Outbound Projection Completion Is Separate

`message_queue` delivery can succeed while `outbound_queue` remains pending.
This happened when `codex-aun -> codex-cto` resolved to `codex-cto` but no
`codex-cto` Discord consumer was running.

Risk:

- "Queue delivered" is mistaken for "Discord displayed".
- Projection bugs are hidden behind inbound success.

Immediate response:

- Queue doctor includes stale `outbound_queue` pending rows.

Target response:

- Surface inbound and outbound health together in one matrix.
- Require `sent` or terminal `failed` before closing Discord-display probes.

Acceptance criteria:

- Runtime probes report both message_queue and outbound_queue terminal state.

### B7. Observability Is Too Manual

Operators currently query SQL directly to understand queue health.

Risk:

- Different operators make different judgments.
- Old rows, active claims, and projection gaps are missed.

Immediate response:

- Add `agent-com diagnose-queue` as the first canonical view.

Target response:

- Add a compact terminal matrix for agent x queue state.
- Add CI/source tests to prevent state vocabulary drift.

Acceptance criteria:

- A single command can answer: who owns the ball, what is blocked, and what the
  next deterministic action is.

## Priority

1. `diagnose-queue` / `queue doctor`.
2. Stop direct tmux task injection.
3. Retired/offline queue cleanup and reassign command.
4. State vocabulary migration and terminal-state decision.
5. ACK/progress evidence channel.
6. Outbound/inbound combined probe reporting.

## Current Runtime Findings

Snapshot command:

```bash
DATABASE_URL='postgresql:///agent_comms?host=/tmp' \
  bun cli/index.ts diagnose-queue --format json --stale-minutes 15
```

Observed on 2026-05-20:

| Code | Severity | Count | Current cause | Immediate action |
| --- | --- | ---: | --- | --- |
| `legacy_status_mix` | warning | 7103 | Historical `read/skipped/failed` rows remain in the table. | Do not treat this as active work, but keep it visible until a terminal-state migration archives it. |
| `stale_pending` | blocker | 26 | Rows are older than the operator SLA and no deterministic consumer has closed them. | Classify each row as obsolete, reassignable, or wakeable before changing state. |
| `expired_active_claim` | blocker | 1 | Rows in `received` / `in_progress` exceeded `claim_expires_at`. | Reclaim through a deterministic command; do not type task bodies into tmux. |
| `retired_or_offline_recipient` | blocker | 9 | `lead-ama` was retired and `arc` is offline but both still have pending rows. | Add a guarded reassign/retire cleanup command. |
| `tui_without_tmux_session` | blocker | 9 | Pending work targets TUI identities without usable `tmux_session` metadata. | Fix identity metadata or route to a managed consumer identity. |
| `ack_spam_pending` | warning | 3 | ACK rows are still represented as actionable queue work. | Move ACK/progress to evidence or auto-close as non-actionable system info. |
| `outbound_pending_stale` | blocker | 85 | Outbound projection rows are pending without a running responsible consumer. | Start the consumer or mark/re-project obsolete rows. |

## Repair Slices

### Slice 1: Diagnosis

Status: implemented in this PR.

- Add `agent-com diagnose-queue`.
- Add alias `agent-com queue doctor`.
- Report counts, samples, per-agent sample distribution, and recommended action
  for each P0 blocker class.
- Keep diagnosis read-only.

### Slice 2: Deterministic Cleanup

Add guarded write commands:

- `agent-com queue reassign --from <old> --to <new> [--dry-run]`
- `agent-com queue close-obsolete --agent-id <id> --reason <text> [--dry-run]`
- `agent-com queue reclaim-expired [--agent-id <id>] [--dry-run]`

Rules:

- Every command must support dry-run.
- Every mutation must write `audit_log`.
- Retired identities must end with zero non-terminal rows.
- No command may depend on direct tmux task injection.

### Slice 3: State Machine Narrowing

Decide and enforce the canonical job states:

```text
pending -> received -> in_progress -> done
```

Compatibility policy:

- Keep reading legacy terminal states until migration is complete.
- Stop writing new `read`.
- Treat `replied` as an output event until the final terminal-state decision is
  merged.

### Slice 4: Evidence Channels

ACK/progress should not block the operator queue.

Options:

- Store progress in an evidence table keyed by `queue_id`.
- Or auto-close known ACK/progress queue rows with an explicit system reason.

Acceptance:

- `agent-com next` never returns pure ACK/progress rows as actionable work.
- `diagnose-queue` reports zero `ack_spam_pending`.

### Slice 5: Projection Completion

Inbound and outbound must be diagnosed together.

Acceptance:

- A Discord-display probe is not closeable until both inbound and outbound rows
  are terminal.
- Missing consumer token, offline consumer, and stale outbound rows appear in
  one operator-facing report.
