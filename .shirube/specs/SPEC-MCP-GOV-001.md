# Shirube Governance Scaffold Feature Spec

SPEC-ID: SPEC-MCP-GOV-001
Risk Tier: R2

## Background

`agent-comms-mcp` is adopting the Shirube AI Development Governance Standard v1 in warn-only mode. The upstream rollout source of truth is `watchout/ai-dev-framework#431`.

## Purpose

Create the repository-premise scaffold required before behavior-changing Feature Specs, Cells, or Impls are treated as governed by Shirube.

## Non-goals

- This spec does not authorize runtime behavior changes.
- This spec does not authorize MCP/tool behavior changes.
- This spec does not enable active workflow checks, required checks, branch protection, ruleset changes, deployment, or AUN activation.
- This spec does not make `.shirube/repo-spec.yaml` authoritative before repository owner/domain designer confirmation.
- Behavior-changing Feature Specs must be created later through the full Feature Spec -> Cell -> Impl chain.

## Target Users

- Shirube command reviewers
- Repository owner/domain designer
- Implementation agents preparing future governed work

## Target Scope

- `.shirube/repo-spec.yaml`
- `.shirube/agent-policy.yaml`
- `.shirube/cells/CELL-MCP-001.yaml` through `.shirube/cells/CELL-MCP-006.yaml`
- Placeholder directories for contracts, specs, impls, audits, evidence, and waivers

## Changed Areas

- Warn-only `.shirube/**` scaffold only

## Requirements

| ID | Statement |
| --- | --- |
| REQ-MCP-GOV-001 | Add a schema-aligned draft repository premise spec. |
| REQ-MCP-GOV-002 | Add a schema-aligned draft agent policy. |
| REQ-MCP-GOV-003 | Add six schema-aligned draft Cell candidates for MCP governance pilot topics. |
| SEC-MCP-GOV-001 | Do not change secrets, runtime behavior, active workflows, required checks, branch protection, rulesets, deployment, or AUN activation. |
| NFR-MCP-GOV-001 | Keep this PR warn-only and scaffold-only. |
| AI-MCP-GOV-001 | Document agent-neutral execution profiles for Codex, Claude, generic coding agents, and human executors. |
| DATA-MCP-GOV-001 | Document protected queue, runtime, audit, evidence, and credential boundaries without changing them. |

## Acceptance Criteria

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-MCP-GOV-001 | REQ-MCP-GOV-001 | `.shirube/repo-spec.yaml` uses the `shirube-repo-spec/v1` canonical shape. |
| AC-MCP-GOV-002 | REQ-MCP-GOV-002 | `.shirube/agent-policy.yaml` uses the `shirube-agent-policy/v1` canonical shape. |
| AC-MCP-GOV-003 | REQ-MCP-GOV-003 | `CELL-MCP-001` through `CELL-MCP-006` use the `shirube-cell/v1` canonical shape. |
| AC-MCP-GOV-004 | SEC-MCP-GOV-001 | The PR changes only `.shirube/**`. |
| AC-MCP-GOV-005 | NFR-MCP-GOV-001 | The PR states the next gate is Shirube command review and repository owner/domain designer confirmation. |

## Negative Cases

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-NEG-MCP-GOV-001 | SEC-MCP-GOV-001 | The scaffold must not change runtime, MCP, queue, workflow, deployment, branch protection, rulesets, or AUN behavior. |
| AC-NEG-MCP-GOV-002 | NFR-MCP-GOV-001 | The scaffold must not claim full Shirube rollout completion. |

## Impact

- Security impact: Governance documentation only; no control activation.
- Privacy impact: Documentation only; no data access change.
- AI usage impact: Documents agent-neutral execution profiles; no runtime AI behavior change.
- Data impact: Documents boundaries; no database or schema change.
- API changes: N/A.
- DB changes: N/A.
- Audit log requirements: Future audit expectations are documented; no audit writer change.

## Migration Plan

N/A. This is a scaffold-only repository premise spec.

## Rollback Plan

Revert the `.shirube/**` scaffold commit.

## Test Plan

| TEST-ID | Linked Requirements | Description |
| --- | --- | --- |
| TEST-MCP-GOV-001 | AC-MCP-GOV-004 | Run `git diff --check`. |
| TEST-MCP-GOV-002 | AC-MCP-GOV-001 AC-MCP-GOV-002 AC-MCP-GOV-003 | Parse `.shirube/**/*.yaml` as YAML. |
| TEST-MCP-GOV-003 | AC-MCP-GOV-004 | Run existing lightweight smoke checks if available. |

## Unresolved Questions

- Repository owner/domain designer must confirm or correct the draft repo-spec boundaries.
