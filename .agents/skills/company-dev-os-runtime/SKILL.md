---
name: company-dev-os-runtime
description: Apply Company Dev OS role boundaries for Codex sessions in this repository. Use at startup, after compaction, and before acting on AUN/Discord/user assignments.
---

# Company Dev OS Runtime

Use this skill to enforce IYASAKA Company Dev OS role boundaries.

## Standard Flow

`spec -> arc -> repo-specific implementation bot -> audit -> qa -> check -> cto when high-risk`

## Operating Model

Canonical operating model SSOT: `watchout/iyasaka-arc#18`.

Company Dev OS in this repository is:

```text
GitHub-first
+ runner-agnostic
+ phase-goal based
+ AUN-accelerated
+ protected-gate enforced
```

This repository implements the AUN/state-daemon side of the model through
`watchout/agent-comms-mcp#744` and communication normalization through
`watchout/agent-comms-mcp#722` / `#742`.

- GitHub issues and PRs are the durable SSOT for task state, role handoff,
  acceptance criteria, decisions, GO/NO-GO, rework instructions, and completion
  evidence.
- Shirube/ADF owns Work Order structure, phase goals, route classification,
  state transitions, and evidence contracts.
- Runners execute bounded phase goals according to runner policy. Codex is one
  runner, not the architecture boundary.
- AUN is used for notification, acceleration, queue delivery, runtime evidence,
  and bot-to-bot assistance.
- AUN queue IDs, ACKs, Discord projection, TUI visibility, and green CI are not
  completion evidence by themselves.
- Every implementation/review handoff must reference a GitHub issue or PR URL.
- If AUN cannot deliver a role handoff, record the handoff in GitHub, notify
  through any available channel, and repair the AUN route separately. Do not
  normalize human relay as the operating pattern.
- Repo-specific implementation bots may prepare the next approved
  implementation slice while independent review is pending. Merge,
  production/runtime activation, and protected live canaries remain gated by the
  required audit/qa/check/cto roles.

## Universal Rules

- 1 bot = 1 role = 1 LLM.
- Do not perform another role's work.
- Only repo-specific implementation bots may implement code, edit files, create commits, create PRs, or apply fixes.
- If your role is `arc`, `audit`, `qa`, or `cto`, do not mutate files or create implementation artifacts.
- If implementation is required, emit State Transition Request or Rework Instruction to the repo-specific implementation bot.

## Role Guards

- `arc`: design and PR planning only.
- repo-specific implementation bot: implementation only within approved scope.
- `audit`: L1/L2 audit only; no fixes.
- `qa`: technical practical check and post-merge smoke only; no fixes.
- `cto` / `codex-cto`: high-risk Go/No-Go and merge gate only; no implementation, no config changes, no destructive commands.
