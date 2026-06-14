# PR Conveyor Script Control

Issue: https://github.com/watchout/agent-comms-mcp/issues/751

GitHub is the durable SSOT for Company Dev OS task state. Role comments carry
the evidence, but PR label/state changes must be made through
`scripts/pr-conveyor.ts` so stale exact-head evidence cannot advance a PR.

## Contract

The controller is dry-run by default.

```bash
bun scripts/pr-conveyor.ts \
  --pr 750 \
  --head 09ab4639a05513e28b360373d3f0520d803d952f \
  --transition l2-pass \
  --evidence-url https://github.com/watchout/agent-comms-mcp/pull/750#issuecomment-...
```

Add `--execute` only after reviewing the JSON plan.

The script fails closed when:

- the current PR head differs from `--head`
- the expected head is not a full 40-character SHA
- the transition name is unknown
- required target labels do not exist in the repository
- the target is not a pull request or cannot be loaded by `gh`

The output JSON includes current labels, labels to add, labels to remove, the
exact head comparison, the evidence URL, and the planned `gh pr edit` command.

## Transitions

| Transition | Use |
| --- | --- |
| `impl-to-l2` | Implementation handoff requests L2 audit. |
| `l2-pass` | L2 audit passed at the exact head. |
| `needs-rework` | Audit, QA, check, or CTO requires implementation rework. |
| `check-pass` | Check passed; merge authority review may proceed. |
| `cto-go` | Exact-head merge authority GO. |
| `blocked` | Protected or external blocker stops the conveyor. |

## Role Usage

Implementation bot:

```bash
bun scripts/pr-conveyor.ts --pr <pr> --head <exact-head> --transition impl-to-l2 --evidence-url <handoff-url> --execute
```

Audit:

```bash
bun scripts/pr-conveyor.ts --pr <pr> --head <exact-head> --transition l2-pass --evidence-url <audit-url> --execute
```

Failure or rework:

```bash
bun scripts/pr-conveyor.ts --pr <pr> --head <exact-head> --transition needs-rework --evidence-url <review-url> --execute
```

Check:

```bash
bun scripts/pr-conveyor.ts --pr <pr> --head <exact-head> --transition check-pass --evidence-url <check-url> --execute
```

CTO:

```bash
bun scripts/pr-conveyor.ts --pr <pr> --head <exact-head> --transition cto-go --evidence-url <cto-url> --execute
```

## Boundaries

This controller does not authorize runtime activation, LaunchAgent mutation,
state-daemon restart, #722 scheduler enablement, Discord gateway recovery, DB
mutation, queue cleanup, PR merge, or fleet rollout.

It also does not treat ACKs, queue IDs, Discord projection, TUI visibility, or
green CI alone as completion evidence. Those may be notifications or supporting
signals, but the transition still requires an exact-head GitHub evidence URL.
