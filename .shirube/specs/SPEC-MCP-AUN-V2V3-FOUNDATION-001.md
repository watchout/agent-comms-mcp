# AUN V2/V3 Foundation Premise Feature Spec

SPEC-ID: SPEC-MCP-AUN-V2V3-FOUNDATION-001
Risk Tier: R2
CELL-ID: CELL-MCP-AUN-FOUNDATION-001

## Background

`agent-comms-mcp` is moving from the current V1 runtime, queue, Discord, tmux, and state-daemon implementation toward an AUN V2 clean rebuild. The rebuild must not copy V1 complexity into a new surface. It must define a clean AUN core and keep V1 behavior behind compatibility adapters until later governed Cells replace or retire it.

This Feature Spec satisfies the foundation premise requested by issue #802 while preserving the AUN V2 clean rebuild architecture prepared for issue #794.

## Purpose

Create the repository-level premise layer required before behavior-changing AUN V2 implementation Cells begin. This spec defines what AUN becomes in V2/V3, what remains legacy or transitional, where authority lives, which decisions agents may make, and which preconditions must be met before runtime, queue, provider delivery, MCP/tool behavior, or AUN activation work starts.

## Non-goals

- No runtime code changes.
- No MCP/tool behavior changes.
- No queue mutation.
- No state-daemon changes.
- No provider delivery changes.
- No Discord, tmux, or TUI behavior changes.
- No database migration.
- No secret or credential access.
- No dependency or package changes.
- No active GitHub workflow changes.
- No branch protection, ruleset, or required-check changes.
- No AUN activation.
- No multi-agent automation activation.
- No merge, ready-for-review transition, or activation of #801.

## Source Documents

| Source | Role |
| --- | --- |
| `.shirube/repo-spec.yaml` | Repository premise and allowed-path boundary. |
| `docs/aun/v2v3-premise.md` | Human-readable premise narrative and inventory plan. |
| `docs/design/REBOOT_ARCHITECTURE.md` | Clean core and V1 compatibility edge architecture. |
| `docs/design/REBOOT_CHARTER_RECONCILIATION.md` | Baton, turn, outcome, and claim/lease/fence reconciliation. |
| `docs/design/V2_CLEAN_CORE_CONTRACT.md` | V2 clean core entities and command surface. |
| `docs/design/V2_DELETION_MAP.md` | V1 deletion, isolation, and adapter map. |
| `docs/design/V2_CODEX_BUILD_PLAN.md` | Small Shirube Cell execution plan for Codex. |
| `docs/design/V2_CODEX_SOLO_EXECUTION_CONTRACT.md` | Defaults that let Codex implement later Cells without guessing. |
| `docs/design/V2_ENTERPRISE_ADOPTION_GATE.md` | Enterprise readiness checks and reservations. |
| `docs/decision-backlog.md` | Open decisions before implementation expansion. |

## V2/V3 Product Premise

AUN / `agent-comms-mcp` becomes a durable agent control plane and agent operations mesh for LLM agents. It coordinates logical agents, runtime instances, work claims, leases, fencing, typed outcomes, projections, and evidence.

V2 is the clean core:

- logical agent identity independent of Discord, tmux, process ID, workspace path, or provider token;
- conversation, baton, claim, lease, fence, runtime task, typed outcome, terminal evidence, and audit records;
- V1 compatibility only through explicit adapters;
- read-only planning and schema validation before mutation.

V3 is the governed rollout model:

- all implementation work is decomposed into Shirube Cells;
- protected work requires Cell Intake evidence and exact-head validation;
- AUN does not own Shirube Phase, Cell, Gate, Done, merge, or production authority;
- AUN supplies runtime authorization, connector evidence, and operational audit contracts.

## Current Repository Classification

| Area | Classification | Premise |
| --- | --- | --- |
| V2 clean core docs | Foundation | Authoritative design basis after owner/domain-designer review. |
| Existing `message_queue` and queue-work paths | Transitional | May feed V2 through adapters; must not define V2 core semantics. |
| Runtime-v2 slices already explored | Transitional proof | Useful safety slice, not final V2 authority. |
| Discord send/projection paths | Projection | External delivery evidence only; not identity or completion authority. |
| GitHub issue, PR, check, comment, artifact records | Source of truth and evidence sink | Durable governance and review records. |
| tmux and TUI paths | Runtime or operator projection | Evidence and operator surface only; not identity. |
| State-daemon wake/readiness paths | Compatibility runtime surface | Protected runtime area requiring approved Cell before behavior changes. |
| Provider messages and model output | Runtime result/projection input | Must be validated before terminal evidence closes work. |
| #801 registry policy material | Future Cell material | HOLD_DRAFT until this premise and inventory gates pass. |

## Surface Boundaries

| Surface | Boundary |
| --- | --- |
| AUN core | Owns agent identity, conversation, baton, claim, lease, fencing, runtime authorization, typed outcome, terminal evidence, and operational audit contracts. |
| Queue | Storage and coordination substrate. Queue state alone is not ownership or completion. Mutation requires approved Cell and exact fence. |
| Runtime | Executes work through adapters. Runtime instance is not logical agent identity. Runtime activation is protected R3 work. |
| MCP tools | Tool surface for transport, diagnostics, and evidence operations. Behavior changes require Feature Spec, Cell, Impl, tests, and evidence. |
| CLI | Operator/developer surface. CLI changes that alter behavior require governed Cell approval. |
| Discord | Connector/projection surface. Discord IDs and messages are not canonical identity or completion evidence. |
| tmux | Local runtime evidence and operator surface. tmux panes/sessions are not authority. |
| TUI | Operator visibility surface. TUI display does not confer ownership or completion. |
| Provider | Model/runtime provider surface. Provider output is not completion authority until validated and recorded. |
| GitHub | Durable source of truth for issue/PR/review/check/comment/workflow evidence and human authorization. |
| State daemon | Compatibility runtime orchestration surface. Behavior changes require R3 approval and exact evidence. |

## GitHub Source-of-Truth Boundary

GitHub owns durable repository governance records:

- issues and work orders;
- pull requests and reviews;
- check runs and workflow artifacts;
- comments used as structured evidence sinks;
- human maintainer authorization;
- merge and release records.

AUN may transport, summarize, notify, accelerate, or attach evidence to GitHub-native records. AUN must not replace GitHub as the only durable decision record. AUN must not decide merge, production, Shirube Done, or protected repository settings.

## Core Models

| Model | V2/V3 premise |
| --- | --- |
| Agent identity | `agent_id` is the logical identity. Discord user, provider token, tmux pane, local path, process ID, and runtime instance are evidence or bindings, not identity. |
| Runtime | A runtime instance executes a task under an eligible adapter and approved authorization boundary. |
| Queue | Queue rows are transport and coordination records. Claim, lease, and fencing create recoverable ownership mechanics. |
| Connector | Discord, GitHub writeback, Slack, Teams, MCP transports, and future UI surfaces are connectors/projections. |
| Delivery | Delivery is a durable projection attempt. Delivery does not imply ownership, semantic completion, or final evidence. |
| Evidence | Terminal evidence closes work only when typed outcome, artifact refs, projection refs, and audit refs are present as required. |
| Audit | Audit records must reconstruct actor, action, subject, reason, approval, timestamp, previous state, resulting state, and evidence refs. |

## Decision Authority

| Actor | May decide | Must not decide |
| --- | --- | --- |
| Human maintainer | Merge handling, ready-for-review transition, final repository acceptance. | Runtime facts without evidence. |
| Repository owner | Repository purpose, non-goals, ownership boundaries, GitHub SSOT boundary. | Security approval alone when security impact exists. |
| Domain designer | Product/domain semantics, AUN vs Shirube boundary, model vocabulary. | Protected runtime activation alone. |
| Security owner | Secrets, credential boundaries, external delivery risk, protected settings risk. | Product acceptance alone. |
| CTO/release owner | R3 authorization, release/production Go/No-Go, protected runtime activation. | Implementation details that belong to the implementation Cell. |
| Shirube command reviewer | Shirube schema/Cell/premise compliance and command review. | Repository owner confirmation or merge authority. |
| Codex/agents | Docs edits, schema/test/scaffold work inside approved scope, mechanical validation, draft PR updates. | Merge, ready-for-review transition, AUN activation, workflow/ruleset changes, secrets access, or protected runtime mutation without approval. |

## Risk-Tier Mapping

Shirube v1 risk tiers for this repository are R0 through R3 only.

| Tier | Meaning | Examples |
| --- | --- | --- |
| R0 | Docs-only or metadata-only with no behavior change. | Design notes, premise text, decision backlog updates. |
| R1 | Schema, fixture, or test-only changes without runtime behavior. | JSON Schema, validators, fixture tests. |
| R2 | Read-only planning, diagnostics, or premise specification. | Inventory plan, read-only adapter plan, dry-run planner. |
| R3 | Protected runtime, queue, connector, migration, secret, workflow, ruleset, or live activation work. | Claim/lease mutation, provider delivery, runtime activation, DB migration, workflow mutation. |

Live activation is not a separate tier. It is R3 protected runtime activation requiring human maintainer, release owner, security owner, CTO, and operator approval, plus exact queue/message/time fences and post-run evidence.

## Agent Decision Matrix

Codex or other implementation agents may decide:

- how to format docs within accepted scope;
- how to split an approved Cell when the Cell packet permits splitting;
- how to run listed validation commands;
- how to preserve existing design while adding required #802 artifacts;
- how to report validation failures exactly.

Codex or other agents must ask for or wait on human/owner/security/CTO approval before:

- changing runtime, queue, state-daemon, provider delivery, MCP/tool behavior, DB schema, workflow, branch protection, ruleset, deployment, or secrets;
- marking #801 or #805 ready for review;
- merging a PR;
- activating AUN, multi-agent automation, live dispatch, or live runtime mutation;
- claiming production readiness or Shirube Done without independent review.

## Repository Inventory Plan

Before runtime implementation begins, a governed inventory must map:

| Area | Required inventory output |
| --- | --- |
| CLI entrypoints | Commands, flags, mutation capability, evidence behavior. |
| MCP tool surfaces | Tool names, inputs, outputs, protected resources, read/write classification. |
| Queue and lease model | Tables/rows, status vocabulary, claim, lease, fencing, stale recovery. |
| Runtime/state-daemon model | Runtime instances, wake/readiness paths, supervisor boundaries, health evidence. |
| Provider delivery paths | Provider adapters, output validation, failure modes, token/secret boundaries. |
| Discord projection paths | Send/edit/delete behavior, IDs, retry behavior, evidence refs. |
| tmux/TUI projection paths | Operator visibility, runtime evidence, non-authority statements. |
| Database/persistence surfaces | Tables, migrations, read-only adapters, mutation guards. |
| Audit/evidence sinks | GitHub comments, artifacts, check runs, local evidence, hash-chain reservations. |
| Configuration/secrets | Env vars, secret refs, fingerprints, redaction policy. |
| GitHub integration | Issue, PR, check, comment, workflow, merge, and review boundaries. |
| Existing auto-merge behavior | Draft PR failure behavior, required checks, non-authoritative automation. |
| Legacy/fallback paths | V1 paths to retain, isolate, adapt, or delete later. |

## Preconditions Before Behavior-Changing Work

Runtime, MCP/tool behavior, queue/runtime/state-daemon, provider delivery, DB migration, or AUN activation work must not begin until:

1. This foundation premise is reviewed by Shirube command review and repository owner/domain designer.
2. The relevant inventory area is completed or explicitly bounded.
3. A specific Shirube Cell exists with risk tier, allowed paths, forbidden paths, validation, evidence, rollback, and stop conditions.
4. Protected R3 work has human maintainer, release owner, security owner, CTO, and operator approval where applicable.
5. Exact head SHA and exact protected resource fences are recorded.
6. Tests or dry-run evidence exist before mutation.
7. Post-run or post-merge evidence sink is defined without requiring recursive follow-up repo-file commits.

## Treatment of #801

#801 should remain HOLD_DRAFT and future registry policy material.

It must not be marked ready or merged from this PR.

It may be revised later after the V2/V3 premise and inventory gates pass.

## Requirements

| ID | Statement |
| --- | --- |
| REQ-MCP-AUN-FOUNDATION-001 | Define what AUN / `agent-comms-mcp` becomes in V2/V3. |
| REQ-MCP-AUN-FOUNDATION-002 | Classify current repository areas as foundation, legacy, fallback, projection, or transitional. |
| REQ-MCP-AUN-FOUNDATION-003 | Define boundaries for AUN core, Discord, tmux, TUI, provider, MCP, CLI, queue, runtime, GitHub, and state-daemon surfaces. |
| REQ-MCP-AUN-FOUNDATION-004 | Define GitHub source-of-truth boundary. |
| REQ-MCP-AUN-FOUNDATION-005 | Define agent identity, runtime, queue, connector, delivery, evidence, and audit models. |
| REQ-MCP-AUN-FOUNDATION-006 | Define decision authority for humans, owners, security, CTO/release owner, Shirube reviewer, and agents. |
| REQ-MCP-AUN-FOUNDATION-007 | Use Shirube v1 R0-R3 risk tiers only. |
| REQ-MCP-AUN-FOUNDATION-008 | Define decisions agents may make and decisions requiring human/owner/security/CTO approval. |
| REQ-MCP-AUN-FOUNDATION-009 | Define repository inventory plan before implementation. |
| REQ-MCP-AUN-FOUNDATION-010 | Define preconditions before runtime, MCP/tool, queue/runtime/state-daemon, provider delivery, or AUN activation work begins. |
| REQ-MCP-AUN-FOUNDATION-011 | State #801 treatment. |

## Acceptance Criteria

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-MCP-AUN-FOUNDATION-001 | REQ-MCP-AUN-FOUNDATION-001 | V2/V3 target state is defined. |
| AC-MCP-AUN-FOUNDATION-002 | REQ-MCP-AUN-FOUNDATION-002 | Legacy, fallback, projection, and transitional classifications are documented. |
| AC-MCP-AUN-FOUNDATION-003 | REQ-MCP-AUN-FOUNDATION-003 | Surface boundaries are documented. |
| AC-MCP-AUN-FOUNDATION-004 | REQ-MCP-AUN-FOUNDATION-004 | GitHub SSOT boundary is explicit. |
| AC-MCP-AUN-FOUNDATION-005 | REQ-MCP-AUN-FOUNDATION-005 | Identity, runtime, queue, connector, delivery, evidence, and audit models are documented. |
| AC-MCP-AUN-FOUNDATION-006 | REQ-MCP-AUN-FOUNDATION-006 REQ-MCP-AUN-FOUNDATION-008 | Decision authority and agent decision boundaries are documented. |
| AC-MCP-AUN-FOUNDATION-007 | REQ-MCP-AUN-FOUNDATION-007 | Only R0, R1, R2, and R3 risk tiers are used. |
| AC-MCP-AUN-FOUNDATION-008 | REQ-MCP-AUN-FOUNDATION-009 | Repository inventory plan exists. |
| AC-MCP-AUN-FOUNDATION-009 | REQ-MCP-AUN-FOUNDATION-010 | Preconditions before behavior-changing work are explicit. |
| AC-MCP-AUN-FOUNDATION-010 | REQ-MCP-AUN-FOUNDATION-011 | #801 treatment is explicitly stated. |

## Test Plan

| TEST-ID | Linked Acceptance Criteria | Description |
| --- | --- | --- |
| TEST-MCP-AUN-FOUNDATION-001 | AC-MCP-AUN-FOUNDATION-007 | Run `git diff --check`. |
| TEST-MCP-AUN-FOUNDATION-002 | AC-MCP-AUN-FOUNDATION-001 AC-MCP-AUN-FOUNDATION-010 | Parse `.shirube/**/*.yaml` as YAML. |
| TEST-MCP-AUN-FOUNDATION-003 | AC-MCP-AUN-FOUNDATION-001 AC-MCP-AUN-FOUNDATION-010 | Run `bash scripts/detect-breaking-changes.sh origin/main` if available without modifying dependencies or scripts. |

## Rollback Plan

Revert the foundation premise docs and `.shirube/**` artifacts added for this Cell. No runtime rollback is required because this spec does not change runtime behavior.

## Review Gate

This PR must remain draft until Shirube command review and repository owner/domain-designer review complete. Human maintainer merge authorization is required later. This spec does not authorize merge, runtime changes, AUN activation, or #801 promotion.
