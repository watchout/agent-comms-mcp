# AUN Agent Communication Control Plane WBS

Date: 2026-06-01
Status: Working breakdown for the control-plane redesign in
[`aun-agent-communication-control-plane-charter.md`](./aun-agent-communication-control-plane-charter.md).

This document keeps the implementation endpoint stable while individual PRs
move through L1/L2/L3 audit. It is not a replacement for the charter or the
slice specs; it is the task ledger used to prevent drift.

## Target Endpoint

AUN must process communication through deterministic control-plane code:

```text
message -> delivery -> conversation -> baton -> agent turn
        -> reply | handoff | close | no-reply | retry | quarantine
```

The runtime may be Codex, Claude Code, OpenClaw, or another adapter. The
control-plane semantics must not depend on which LLM or TUI is behind the
adapter.

The required receive path is:

```text
pending queue row
  -> runner claims exactly one row or one explicit batch by policy
  -> runner records received / in_progress / turn evidence
  -> runtime receives only the claimed work and baton context
  -> runner records typed completion
  -> deterministic code writes replied / closed / no-reply / retry / quarantine
```

LLMs must not decide queue claim, baton ownership, close, retry, or recovery.

## Current Stack

| Slice | Status | Evidence / next gate |
|---|---|---|
| CP-00 restart preflight and loop-prompt blocker | merged | queue preflight and loop-prompt backlog detection merged before scheduler activation |
| CP-10 single active owner + observers | merged | send/notify owner-observer contract and canonical channel-id contract landed |
| CP-20 conversation identity and baton schema/store | merged | conversation identity, persistence, baton store, and one-active-baton guard landed |
| CP-30 send-side control-plane allocation | in audit / stacked | CLI send/notify merged through #633; MCP send/notify #634 remains draft/DIRTY and needs rebase/L1 refresh |
| CP-40 script-controlled receive runner | in progress / stacked | CP-40A targeted receive and CP-40B runtime-neutral adapter contract are stacked for audit |
| CP-50 process/completion runner | not started | depends on CP-40 and typed lifecycle outcome contract |
| CP-60 typed outcomes and lifecycle view | not started | close/no-reply/handoff/escalate/retry/quarantine result model |
| CP-70 doctor/preflight/repair | partial | must detect stuck baton, stale turn, duplicate owner, split request, and loop-prompt rows |
| CP-80 scheduler activation | blocked until CP-40/50/70 | state-daemon may schedule runners only after preflight-clean evidence |

## Required Task Additions

### CP-40A Targeted Receive Runner

Implement a runner path that can claim a specific `queue_id` without draining
older FIFO rows.

Acceptance:

- `runner receive --queue-id <id>` or equivalent claims only that row.
- If the row is not pending for the target `agent_id`, the runner fails closed
  with a stable reason.
- No implementation asks an LLM to call `next` repeatedly to reach a row.
- Audit requests can be bridged by queue_id without processing unrelated work.

### CP-40B Runtime-Neutral Runner Adapter Contract

Define one adapter contract used by Codex, Claude Code, and future runtimes.

Acceptance:

- adapter input is claimed queue payload plus conversation/baton context
- adapter output is a typed runner result, not free-form completion prose
- runtime-specific details are limited to launch, IO, timeout, and result
  parsing
- Codex and Claude use the same queue/baton state machine

### CP-40C Canonical Message Presentation

Prevent outbound projection chunks or split audit requests from becoming
multiple independent runtime tasks.

Acceptance:

- receive runner presents one canonical logical message body to the runtime
- split transport chunks share a grouping key or canonical message id
- queue rows created for projection chunks are not independently claimable
  runtime work unless explicitly modeled as child requests

### CP-50A Agent Turn Ledger

Record durable turn evidence before invoking a runtime.

Acceptance:

- a turn records baton id, queue id, message id, runtime kind, claim/lease id,
  start time, timeout, and heartbeat/last-observed activity
- stale turns are recoverable without creating a second active baton
- `received -> in_progress` happens before the runtime sees the work

### CP-50B Completion Runner

Finalize runtime results through deterministic typed outcomes.

Acceptance:

- reply closes through `send` and links the original queue id
- no-reply is explicit and auditable
- handoff/escalation transfers or creates a child baton by deterministic code
- runtime failure leaves a reclaimable state or a typed quarantine; it does not
  silently strand `received`, `in_progress`, or `done`

### CP-70A Loop And Drain Defect Doctor

Add doctor checks for LLM-driven `next` loops and drain-to-target behavior.

Acceptance:

- natural-language loop prompts are reported as blockers
- split audit requests and stuck active rows are grouped in one diagnostic
- recommended repair uses exact `queue_id`, never "keep calling next"
- state-daemon activation is blocked while these findings exist

## Audit Flow

Every implementation slice follows:

```text
spec/contract -> L1 -> L2 -> L3 -> merge -> post-merge verification
```

Audit delivery itself must move to targeted queue processing as soon as CP-40A
exists. Until then, bridge messages must stay short enough to avoid avoidable
transport splits, and operators must not ask auditors to drain FIFO queues.

## Explicit Non-Tasks

- Do not restart state-daemon to compensate for pending work.
- Do not add runtime-specific queue semantics for Codex or Claude.
- Do not make Discord channel, tmux session, or UI prompt text the identity of
  a conversation or baton.
- Do not close active rows in bulk to recover from a runner defect.
