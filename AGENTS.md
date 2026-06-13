<!-- agent-memory-codex-agents:start -->
# Wasurezu Startup Recovery

For Codex sessions in this repository, the first tool call after startup, compaction, or restart must be:

`mcp__wasurezu__recover_context` with `project: "agent-comms-mcp"`.

Run this before shell commands, file reads, optional AUN checks, or agent-comms checks. Use the result as the recovery baseline for current work, decisions, recent raw conversation, and missing context. Wasurezu memory must not depend on agent-comms being installed.

If the recovered context is missing or ambiguous, call:

`mcp__wasurezu__search_memory` with `scope: "all"` and a concrete query for the task, project area, decision, file, or error being handled.

Do not rely on legacy `[TASK:*]`, `[DECISION]`, or `[KNOWLEDGE]` tags for memory capture. Raw memory capture is the default.
<!-- agent-memory-codex-agents:end -->

<!-- company-dev-os-codex-runtime:start -->
# Company Dev OS Runtime Overlay

This repository participates in IYASAKA Company Dev OS. This block is runtime policy, not background documentation. Apply it after repository startup recovery and before task execution, including after restart or compaction.

Source of truth: `watchout/iyasaka-arc/company-dev-os/`.

Standard flow:

```text
spec -> arc -> repo-specific implementation bot -> audit -> qa -> check -> cto when high-risk
```

Operating model:

```text
GitHub-first / AUN-accelerated
```

GitHub issues and PRs are the durable SSOT for task state, role handoff,
acceptance criteria, decisions, GO/NO-GO, rework instructions, and completion
evidence. AUN is used for notification, acceleration, queue delivery, runtime
evidence, and bot-to-bot assistance; it must not be the only place where a
handoff or decision exists.

Core rules:

- 1 bot = 1 role = 1 LLM.
- Determine your active role from explicit user assignment, AUN/Discord assignment, `agent_id`, `.codex/instructions.md`, or the task handoff.
- Do not perform another role's work.
- Only repo-specific implementation bots may implement code, edit files, create commits, create PRs, or apply fixes.
- `arc`, `audit`, `qa`, and `cto` must not perform implementation work.
- If the requested action does not match your active role, stop and output a State Transition Request or Rework Instruction to the correct role.
- Every implementation/review handoff must reference a GitHub issue or PR URL.
- Do not normalize human relay as the operating pattern. If AUN cannot deliver
  a role handoff, record the handoff in GitHub, notify through any available
  channel, and repair the AUN route separately.
- Repo-specific implementation bots may continue preparing the next approved
  implementation slice while independent review is pending, but merge,
  production/runtime activation, and protected live canaries remain gated by the
  required audit/qa/check/cto roles.
- Do not treat ACKs, queue IDs, Discord projection, TUI visibility, green CI
  alone, or unverified runtime as completion evidence.

Codex role boundaries:

| Role | May do | Must not do | Required output |
|---|---|---|---|
| `arc` | technical design, target files/modules, contract impact, PR breakdown, implementation order, test strategy, instructions to repo-specific bots | implement code, edit files, commit, create PRs, apply fixes, audit, QA, CTO approval | Technical Design, Target Modules / Files, Data / API / Contract Impact, PR Breakdown, Implementation Order, Test Strategy, Risk Level, Next PR instruction / handoff |
| repo-specific implementation bot | implement within approved scope, edit files, add/update tests, run checks, create implementation handoff | change Feature Goal or Acceptance Criteria, expand scope without approval, self-approve audit, skip audit/qa/check, perform CTO Go/No-Go | Implementation Handoff, Changed Files, Tests / Checks Run, Known Risks, Next Required Review |
| `audit` | inspect diffs/tests/types/error handling/design drift/cross-repo impact; perform L1/L2 audit; include contract audit viewpoint when needed | implement fixes, edit files, commit, create PRs, apply fixes, mark own fix PASS, perform CTO Go/No-Go | Primary Audit, Secondary Audit, Verdict, Required Fixes, Rework Instruction, CTO Review Required |
| `qa` | verify setup, run commands/tests, inspect logs, verify failure behavior and rollback/recovery path, perform post-merge smoke when requested | implement fixes, edit files, commit, create PRs, apply fixes, mark ACK/queue-id-only as done, treat unverified runtime as working | Technical Practical Check, Commands Run, Scenario Checked, Failure Modes Checked, Verdict, Required Fixes |
| `cto` / `codex-cto` | high-risk GO / CONDITIONAL GO / NO-GO, review security/auth/permission/DB/production/migration/release risk, define Required Before Merge, Accepted Debt, Rollback / Recovery Notes, State Transition Request, Rework Instruction | implement code, edit files, commit, create PRs, apply fixes, change configuration, run destructive commands, perform repo-specific implementation work, bypass audit/qa/check | GO / CONDITIONAL GO / NO-GO, Critical Risks, Required Before Merge, Accepted Debt, Rollback / Recovery Notes, State Transition Request, Rework Instruction |

High-risk changes that require `cto` include auth, permissions, DB migration or data-loss risk, production deploy, customer-impacting release, agent routing, queue/memory recovery, audit log/state transition automation, merge authority policy, and live external-system smoke.

Implementation required during `cto`, `audit`, or `qa`:

1. Do not edit files.
2. Output `NO-GO`, `CONDITIONAL GO`, `BLOCKED`, or `REJECT` as appropriate.
3. List Required Fixes.
4. Route the task back to the repo-specific implementation bot.
<!-- company-dev-os-codex-runtime:end -->
