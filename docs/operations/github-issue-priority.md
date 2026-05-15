# GitHub Issue Priority Rules

> Canonical operational rule for GitHub issue ordering.
> This file is intentionally stored in the repository so agents do not need session memory to recover the rule.

## Purpose

All actionable work must be visible in GitHub Issues before it is implemented, delegated, or audited.

Priority must be unambiguous. Labels such as `P0` or `P1` are useful for urgency, but they do not define the exact next task when several issues have the same urgency. For execution order, use a single global sequence label.

## Required Labels

Every active work issue should have:

- `seq:NNN` when it is in the ordered execution queue.
- `area:*` for the affected domain.
- Optional urgency labels such as `priority:P0`, `priority:P1`, `priority:P2`, or `priority:P3`.

Examples:

```text
seq:001
seq:002
seq:003
area:db
area:runtime
area:routing
area:dispatcher
area:workflow
area:docs
priority:P0
priority:P1
```

## Execution Rule

Agents must process issues by ascending `seq:NNN`.

If no `seq:NNN` label exists, the issue is not in the active execution queue yet. It may be valid backlog, but it is not the next task.

## Reordering Rule

When a new urgent issue appears:

1. Create or update the GitHub issue first.
2. Reassign `seq:NNN` labels so the active queue has one clear order.
3. Record the reason for the reorder in an issue comment when the change affects already planned work.
4. Then dispatch implementation or review.

There must not be two open issues with the same active `seq:NNN` label.

## Area Labels

Use area labels to make ownership and review routing obvious:

- `area:db` — schema, migration, persistence, data contracts.
- `area:runtime` — agent process, identity, hooks, state daemon, receive runners.
- `area:routing` — recipient resolution, ACLs, channel membership.
- `area:dispatcher` — DB-to-chat or chat-to-DB projection.
- `area:workflow` — audit chain, PR flow, orchestration.
- `area:docs` — public positioning, runbooks, contributor docs.
- `area:test` — test harness, CI, fixture isolation.

Add a new `area:*` label only when the existing set does not describe the work.

## Urgency Labels

Urgency labels describe impact, not order:

- `priority:P0` — communication outage, production DB corruption risk, or development-wide blocker.
- `priority:P1` — major flow is blocked, but a manual workaround exists.
- `priority:P2` — design hardening, public quality, maintainability, or operational improvement.
- `priority:P3` — cleanup, documentation, or non-blocking follow-up.

When `priority:*` and `seq:*` seem to disagree, `seq:*` is the actual execution order.

## Agent Behavior

Before starting implementation, an agent should:

1. Check the issue has an active `seq:NNN` label or an explicit human directive.
2. Confirm there is no lower-numbered unresolved issue that blocks the task.
3. Link PRs back to the issue.
4. Keep status updates in the issue or PR so the queue is recoverable after session loss.

For small emergency fixes, an agent may act immediately when directed, but must create or update the issue before closing the task.

