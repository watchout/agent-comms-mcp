# GitHub-First / AUN-Accelerated Workflow

Issue: #742

## Purpose

AUN development must continue even when AUN delivery is degraded. The operating
model is GitHub-first / AUN-accelerated:

- GitHub issues and PRs are the durable source of truth for task state, role
  handoff, acceptance criteria, decisions, rework instructions, GO/NO-GO, and
  completion evidence.
- AUN is an acceleration and evidence surface: notification, queue delivery,
  runtime evidence, and bot-to-bot assist.
- AUN queue IDs, ACKs, Discord projection, TUI visibility, and green CI are not
  completion evidence by themselves.

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
