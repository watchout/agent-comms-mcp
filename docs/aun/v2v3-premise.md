# AUN V2/V3 Foundation Premise

Parent issues: #794, #802

This document is the human-readable premise for the AUN / `agent-comms-mcp` V2/V3 rebuild. It complements `.shirube/specs/SPEC-MCP-AUN-V2V3-FOUNDATION-001.md` and keeps PR #805 as a foundation/design-consolidation PR, not an implementation-complete AUN V2 PR.

## Outcome

AUN becomes a durable agent control plane and agent operations mesh.

It should answer, from structured evidence:

- which logical agent owned a conversation;
- which runtime claimed work;
- which claim, lease, and fence permitted execution;
- which connector projected the result;
- which typed outcome closed the work;
- which evidence and audit records prove the outcome;
- why a protected runtime or queue mutation was allowed.

V2 is the clean core. V3 is the governed Shirube Cell rollout model.

## Full Shirube Application Posture

This repository is the primary target for this work:

```yaml
primary_target_repo: watchout/agent-comms-mcp
primary_target_pr: 805
primary_development_subject: AUN V2/V3 foundation premise and later AUN implementation Cells
```

The operating posture is now full Shirube application before AUN implementation, not loose partial adoption. The repo-local workflow gate, PR template, enforcement policy, and lifecycle state are part of the adoption. Behavior-changing AUN implementation must wait for full target-repo context, SPEC, CELL, IMPL, audit, evidence, exact-head owner authorization, and post-merge evidence.

Before implementation, the bot must report `pwd`, git root, origin remote, branch, `HEAD`, current work order, target repo, support repos, and changed files. If the actual repo is not `watchout/agent-comms-mcp`, implementation stops.

Support repositories are not implementation targets:

| Repository | Classification | Boundary |
| --- | --- | --- |
| `watchout/ai-dev-framework` | Framework feedback/support only | Shirube framework issues and PRs, including #431, #458, #487, and #488, do not become the current implementation target. |
| `watchout/omotenasuai-control` | Control source only | Control-source material may inform governance patterns, but it is not the agent-com implementation target. |
| OmotenasuAI product repos | Not current target unless explicitly assigned | Product runtime, DB, API, UI, workflow, and deployment work are out of scope for this AUN PR. |

## Core Premise

AUN V2 must not be a surface refactor of V1 queue-work, Discord, tmux, and state-daemon paths.

The architecture is:

```text
V2 Clean Core
  identity / conversation / baton / claim / lease / fence / runtime task / typed outcome / terminal evidence / audit

V1 Compatibility Edge
  message_queue adapter / queue-work adapter / Discord projection adapter / GitHub evidence adapter / state-daemon compatibility adapter
```

V1 paths may feed the V2 core through explicit adapters. V1 paths must not define V2 core semantics.

## What Is Legacy, Fallback, Projection, Or Transitional

| Current area | Classification | V2/V3 treatment |
| --- | --- | --- |
| V1 queue-work semantics | Legacy/transitional | Isolate behind adapters; do not import as canonical V2 semantics. |
| `message_queue` storage | Transitional substrate | Read-only projection first; mutation only in later approved R3 Cells. |
| Discord messages and IDs | Projection | Delivery evidence only; not identity or completion authority. |
| GitHub comments and checks | Source of truth/evidence sink | Durable review, authorization, and evidence records. |
| tmux panes and sessions | Runtime evidence/fallback | Operator/runtime evidence only; not logical identity. |
| TUI state | Operator projection | Visibility only; not ownership or completion. |
| Provider output | Runtime result input | Must be validated before terminal evidence. |
| State-daemon wake/readiness | Transitional runtime surface | Protected R3 behavior area. |
| Runtime-v2 exploration | Transitional proof | Useful as a safety slice; not final V2 authority. |
| #801 registry policy | Future material | HOLD_DRAFT until premise and inventory gates pass. |

## Surface Boundaries

AUN core owns logical coordination and evidence contracts:

- `agent_id`;
- conversation and baton;
- claim, lease, and fencing;
- runtime task authorization;
- typed outcome and terminal evidence;
- operational audit.

Queue is storage and coordination, not authority by itself.

Runtime executes through adapters, but runtime instance identity is not agent identity.

MCP and CLI are tool/operator surfaces. Behavior changes require governed Feature Spec, Cell, Impl, tests, and evidence.

Discord, Slack, Teams, GitHub writeback, and future UIs are connectors or projections. Provider output and connector delivery do not close work by themselves.

tmux and TUI are local runtime/operator surfaces. They are useful evidence, not source of truth.

State-daemon behavior is a protected runtime compatibility surface. Mutation requires R3 approval and exact evidence.

GitHub remains the durable source of truth for repository work, review, checks, comments, artifacts, merge records, and human authorization.

## GitHub Source-Of-Truth Boundary

AUN may:

- notify agents of GitHub-backed work;
- transport or summarize work items;
- collect runtime and projection evidence;
- attach structured evidence to GitHub comments, artifacts, or checks;
- accelerate handoff and recovery.

AUN must not:

- replace GitHub issues, PRs, reviews, checks, comments, or workflow artifacts as the only durable decision record;
- decide merge, production, or Shirube Done;
- mutate branch protection, rulesets, required checks, workflows, or secrets;
- mark PRs ready or merge without human maintainer authorization.

## Models

Agent identity:
`agent_id` is logical identity. Discord IDs, provider tokens, tmux panes, workspace paths, runtime IDs, and process IDs are bindings or evidence.

Runtime:
A runtime instance executes a task under an adapter, eligibility policy, claim, lease, and fence.

Queue:
Queue rows are transport and coordination records. Claim, lease, and fencing define recoverable ownership mechanics.

Connector:
Connectors project or receive messages through Discord, GitHub, MCP transports, Slack, Teams, or future UIs.

Delivery:
Delivery is a durable projection attempt. It does not imply ownership or completion.

Evidence:
Terminal evidence must include typed outcome and required artifact/projection/audit refs.

Audit:
Audit records must reconstruct actor, action, subject, approval, timestamp, previous state, resulting state, and evidence refs.

## Decision Authority

Human maintainer:
Merge handling, ready-for-review transition, final repository acceptance.

Repository owner:
Repository purpose, non-goals, AUN/GitHub boundary, ownership premise.

Domain designer:
Product/domain semantics, AUN vs Shirube boundary, identity and outcome vocabulary.

Security owner:
Secrets, credential boundaries, provider delivery risk, protected-setting risk.

CTO/release owner:
R3 authorization, release/production Go/No-Go, protected runtime activation.

Shirube command reviewer:
Schema, Cell, premise, and command review compliance.

Codex/agents:
Implementation inside approved scope, mechanical validation, draft PR updates, and evidence reporting. Agents must not merge, mark ready, activate AUN, access secrets, mutate protected runtime state, or change workflows/rulesets without explicit authorization.

## Risk Tiers

Shirube v1 uses R0-R3 only.

| Tier | Boundary |
| --- | --- |
| R0 | Docs-only or metadata-only with no behavior change. |
| R1 | Schema, fixture, or test-only with no runtime behavior change. |
| R2 | Read-only planning, diagnostics, inventory, or premise specification. |
| R3 | Protected runtime, queue, connector, migration, secret, workflow, ruleset, or live activation work. |

Live activation is R3 protected runtime activation requiring human maintainer, release owner, security owner, CTO, and operator approval.

## Agent Decisions Vs Human Decisions

Codex and agents may decide:

- local doc wording and organization inside approved scope;
- mechanical whitespace and metadata cleanup;
- validation command execution;
- whether a requested change touches forbidden paths;
- exact reporting of validation results.

Human/owner/security/CTO approval is required for:

- runtime behavior;
- MCP/tool behavior;
- queue/runtime/state-daemon mutation;
- provider delivery;
- DB migration;
- secrets or credentials;
- workflow, branch protection, ruleset, or required-check changes;
- AUN activation;
- merge, ready-for-review transition, or production authority.

## Inventory Plan

Before implementation, inventory must cover:

- CLI entrypoints;
- MCP tool surfaces;
- queue and lease model;
- runtime/state-daemon model;
- provider delivery paths;
- Discord projection paths;
- tmux/TUI projection paths;
- database or persistence surfaces;
- audit/evidence sinks;
- configuration and secret surfaces;
- GitHub issue/PR/check/comment integration;
- existing auto-merge or workflow behavior;
- legacy/fallback paths.

Each inventory entry must classify read/write capability, protected resources, authority boundary, evidence emitted, and required tests before mutation.

## Preconditions Before Behavior Changes

Behavior-changing work must wait until:

1. This premise is reviewed by Shirube command review and repository owner/domain-designer.
2. The relevant inventory area is complete or explicitly bounded.
3. A specific Shirube Cell exists with risk tier, allowed paths, forbidden paths, validation, evidence, rollback, and stop conditions.
4. R3 work has the required human maintainer, release owner, security owner, CTO, and operator approval.
5. Exact protected resource fences are recorded.
6. Dry-run or test evidence exists before mutation.
7. Post-run or post-merge evidence sink is defined without recursive follow-up repo-file commits.

## #801 Treatment

#801 should remain HOLD_DRAFT and future registry policy material.

It must not be marked ready or merged from this PR.

It may be revised later after the V2/V3 premise and inventory gates pass.

## PR #805 Identity

PR #805 is the foundation, premise, and design-consolidation PR that enables later AUN V2 implementation Cells.

It is not implementation-complete AUN V2.

It changes no runtime code, MCP/tool behavior, queue mutation, state-daemon behavior, provider delivery, DB migration, secret access, workflows, branch protection, rulesets, required checks, or AUN activation.
