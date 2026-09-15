# Registry Schema Policy Feature Spec

SPEC-ID: SPEC-MCP-001
CELL-ID: CELL-MCP-001
IMPL-ID: IMPL-MCP-001
Risk Tier: R2 policy/design pilot
SSOT: #799
Depends: #798
Work Order: #800

## Purpose

Define the first Shirube pilot policy for registry schema boundaries in `agent-comms-mcp`.

This is a warn-only policy/design Cell. It documents registry classes, expected policy fields, ownership boundaries, approval boundaries, durable evidence anchors, and non-goals before any runtime or behavior-changing implementation.

## Background

The repository scaffold from #798 established the repository premise for Shirube v1 adoption. #799 selected `CELL-MCP-001: registry schema policy` as the first low-risk pilot. #800 authorizes this policy/design pilot while explicitly blocking runtime, workflow, ruleset, DB migration, secret, and AUN activation changes.

Relevant source references:

- `docs/SSOT.md`
- `docs/agent-com-message-queue-spec.md`
- `docs/design/aun-normalization-roadmap.md`
- #722
- #799
- #800

## Scope

Allowed paths:

- `.shirube/**`
- `docs/**`
- `README.md`

Expected artifacts:

- `.shirube/specs/SPEC-MCP-001.md`
- `.shirube/cells/CELL-MCP-001.yaml`
- `.shirube/impls/IMPL-MCP-001.md`
- `.shirube/evidence/CELL-MCP-001.md`
- `docs/shirube-registry-schema-policy.md`

## Non-Goals

- No runtime code changes.
- No MCP tool or CLI behavior changes.
- No queue, runtime, state-daemon, provider delivery, or AUN activation changes.
- No active workflow, required-check, branch protection, ruleset, deployment, or release process changes.
- No secret access or secret mutation.
- No DB migration, production DB access, or schema enforcement.
- No claim that Shirube rollout is complete.

## Requirements

| ID | Statement |
| --- | --- |
| REQ-MCP-001-001 | Define registry classes for MCP tools and CLI surfaces, agent identities, runtime instances and endpoint leases, connectors and provider UI bindings, agent message and queue resources, outbound delivery resources, audit/evidence anchors, and GitHub governance artifacts. |
| REQ-MCP-001-002 | Define expected policy fields for each registry class, including `registry_id`, `owner`, `source_of_truth`, `resource_class`, `risk_tier`, read-only operations, mutation operations, approval-required operations, forbidden operations, evidence required, audit event expectation, and post-merge verification expectation. |
| REQ-MCP-001-003 | Preserve the source-of-truth boundary: GitHub remains durable governance evidence; AUN may notify, accelerate, and collect evidence but must not be the only decision record. |
| REQ-MCP-001-004 | Provide an executable Impl handoff and evidence record for bounded policy/design work. |
| SEC-MCP-001-001 | Preserve all stop-condition boundaries: no runtime behavior, MCP/tool behavior, queue/runtime/state-daemon behavior, workflow, ruleset, required-check, deployment, secret, DB migration, or AUN activation changes. |
| DATA-MCP-001-001 | Document protected resources and distinguish read-only diagnostics from mutation-capable queue, runtime, lease, delivery, audit, and evidence operations. |
| AI-MCP-001-001 | Treat agent/AI outputs as proposals until anchored by GitHub issue, PR, review, check, or evidence artifact. |
| NFR-MCP-001-001 | Keep the pilot warn-only and require Shirube command review before merge handling. |

## Acceptance Criteria

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-MCP-001-001 | REQ-MCP-001-001 REQ-MCP-001-002 | The registry schema policy defines the required registry classes and common fields. |
| AC-MCP-001-002 | REQ-MCP-001-003 DATA-MCP-001-001 | The policy documents GitHub/AUN, queue/runtime/state-daemon, resource access, audit, and evidence boundaries. |
| AC-MCP-001-003 | REQ-MCP-001-004 | `IMPL-MCP-001.md` is executable by a bounded coding agent and stays within allowed paths. |
| AC-MCP-001-004 | SEC-MCP-001-001 | Changed files stay within `.shirube/**` and `docs/**`; no forbidden runtime/workflow/package/DB paths are changed. |
| AC-MCP-001-005 | NFR-MCP-001-001 | Evidence records validation commands, conveyor availability, scope confirmation, and next gate. |

## Negative Cases

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-NEG-MCP-001-001 | SEC-MCP-001-001 | The pilot must not implement registry tables, migrations, runtime checks, tool allowlist enforcement, or workflow gates. |
| AC-NEG-MCP-001-002 | REQ-MCP-001-003 | Queue IDs, ACKs, Discord projection, TUI visibility, green CI, or unverified runtime must not be treated as completion evidence by themselves. |
| AC-NEG-MCP-001-003 | DATA-MCP-001-001 | Read-only diagnostics must not be represented as authorization to mutate queue, runtime, lease, delivery, audit, secret, or provider resources. |

## Registry Policy Content

The registry schema policy must cover at least:

- MCP tools and CLI surfaces
- agent identities, `agent_id`, and `agent_uri`
- runtime instances, endpoint leases, and supervisor evidence
- connectors and provider UI bindings
- agent message and queue resources
- outbound delivery resources
- audit and evidence anchors
- GitHub issues, PRs, reviews, and checks as durable governance evidence

Each class must define the expected fields listed in `REQ-MCP-001-002`.

## Test Plan

| TEST-ID | Linked Requirements | Description |
| --- | --- | --- |
| TEST-MCP-001-001 | AC-MCP-001-004 | Run `git diff --check`. |
| TEST-MCP-001-002 | AC-MCP-001-003 AC-MCP-001-005 | Parse `.shirube/**/*.yaml` as YAML. |
| TEST-MCP-001-003 | AC-MCP-001-004 | Run existing lightweight smoke checks if available. |
| TEST-MCP-001-004 | AC-MCP-001-005 | Run Shirube conveyor check in warn-only mode if available; otherwise record unavailable without adding dependencies or workflows. |

## Impact

- Security impact: Policy documentation only; no enforcement or secret access.
- Privacy impact: Documentation only; no data access change.
- AI usage impact: Documents AI evidence boundaries; no runtime AI behavior change.
- Data impact: Documents protected resources; no database or schema change.
- API changes: N/A.
- DB changes: N/A.
- Runtime changes: N/A.

## Rollback Plan

Revert this policy/design pilot PR.

## Next Gate

Stop for Shirube command review. Do not claim rollout completion and do not activate runtime/AUN behavior.
