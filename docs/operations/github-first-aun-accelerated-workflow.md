# GitHub-First / AUN-Accelerated Workflow

Canonical SSOT: `watchout/iyasaka-arc#18`

Repo adoption / continuation issue: `watchout/agent-comms-mcp#742`

AUN/state-daemon implementation issue: `watchout/agent-comms-mcp#744`

## Purpose

AUN development must continue even when AUN delivery is degraded. The operating
model is:

```text
GitHub-first
+ runner-agnostic
+ phase-goal based
+ AUN-accelerated
+ protected-gate enforced
```

- GitHub issues and PRs are the durable source of truth for task state, role
  handoff, acceptance criteria, decisions, rework instructions, GO/NO-GO, and
  completion evidence.
- Shirube/ADF owns Work Order structure, phase goals, route classification,
  state transitions, and evidence contracts.
- Runners execute bounded phase goals according to runner policy. Codex, Claude
  Code, headless adapters, governed manual execution, and stop lanes are
  selected by policy rather than hard-coded into the workflow.
- AUN is an acceleration and evidence surface: notification, queue delivery,
  runtime evidence, and bot-to-bot assist.
- AUN queue IDs, ACKs, Discord projection, TUI visibility, and green CI are not
  completion evidence by themselves.

`watchout/agent-comms-mcp#744` implements the AUN/state-daemon side of
`watchout/iyasaka-arc#18`: supervised non-cron GitHub work discovery,
runner-policy aware dispatch, duplicate suppression, restart recovery,
protected stop gates, and GitHub evidence writeback. It must keep AUN as an
acceleration/evidence mirror, not the SSOT.

## Required Rule

Every implementation/review handoff must include a GitHub issue or PR URL.

AUN may notify that URL, but must not be the only location of:

- task instruction
- acceptance criteria
- role owner
- rework instruction
- GO / NO-GO
- completion evidence

If AUN cannot notify a role, the operator records the handoff in GitHub and uses
any available notification channel while the AUN route is repaired. Human relay
is an incident workaround, not the normal workflow.

## Parallelism

The role chain remains mandatory:

```text
spec -> arc -> repo-specific implementation bot -> audit -> qa -> check -> cto when high-risk
```

Repo-specific implementation bots may continue preparing the next approved
implementation slice while independent review is pending, provided that:

- the next slice has a GitHub issue or PR URL
- the slice is a bounded phase goal or links to one
- the slice has explicit scope and acceptance criteria
- no review role is skipped
- no merge, production/runtime activation, protected canary, or rollout occurs
  before the required gate role grants it

This prevents AUN degradation from turning the user into the queue while still
preserving independent review.

## Communication Normalization Evidence

For AUN communication recovery, record evidence in the issue or PR that owns the
workstream:

- state-daemon checkout commit
- running process environment relevant to the target
- startup-safety PASS
- stale process cleanup list
- canary target
- queue_id / message_id
- `payload.receive_claim.source`
- `payload.runner_result.invocation_source`
- exact terminal close by queue_id/message_id
- rollback command
- remaining risk and follow-up

ACK, Discord visibility, TUI output, queue ID existence, or CI green status may
support the narrative, but none of them replaces DB-primary lifecycle evidence.
