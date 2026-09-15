# Shirube Registry Schema Policy

Status: warn-only policy/design pilot
SPEC-ID: SPEC-MCP-001
CELL-ID: CELL-MCP-001
IMPL-ID: IMPL-MCP-001
SSOT: #799
Depends: #798
Work Order: #800

## Purpose

This document defines the registry schema policy for the first `agent-comms-mcp` Shirube pilot. It describes what registry classes must be tracked, who owns them, where their source of truth lives, what evidence is required, and which operations require approval.

This policy is not an implementation. It does not create registry tables, migrations, tool enforcement, runtime checks, active workflows, required checks, rulesets, deployments, secrets, or AUN activation.

## Source Boundaries

- `docs/SSOT.md` is the product-level source of truth for `agent-com`.
- `docs/agent-com-message-queue-spec.md` is the detailed queue and transport specification under `docs/SSOT.md`.
- `docs/design/aun-normalization-roadmap.md` is normative for AUN normalization planning.
- GitHub issues, pull requests, reviews, checks, and workflow artifacts are durable governance evidence.
- AUN may notify, accelerate, and collect evidence, but it must not be the only decision record.
- Queue IDs, ACKs, Discord projection, TUI visibility, green CI, or unverified runtime are not completion evidence by themselves.

## Common Registry Fields

Every registry class should define these policy fields before behavior-changing implementation:

| Field | Meaning |
| --- | --- |
| `registry_id` | Stable policy identifier for the class or object family. |
| `owner` | Accountable owner for policy decisions and approval. |
| `source_of_truth` | Durable record that wins on conflict. |
| `resource_class` | Protected resource category. |
| `risk_tier` | Default Shirube risk tier for changes to this class. |
| `read_only_operations` | Operations that inspect state without mutation. |
| `mutation_operations` | Operations that create, update, delete, claim, deliver, or change state. |
| `approval_required_operations` | Mutations requiring explicit owner, security, CTO, or human maintainer approval. |
| `forbidden_operations` | Operations blocked in this policy pilot. |
| `evidence_required` | Evidence needed before completion can be claimed. |
| `audit_event_expectation` | Expected audit or review artifact for future behavior-changing work. |
| `post_merge_verification_expectation` | Mechanical evidence expected after merge when behavior changes. |

## Registry Classes

### MCP Tools and CLI Surfaces

| Field | Policy |
| --- | --- |
| `registry_id` | `mcp_cli_surface` |
| `owner` | release owner, repo owner |
| `source_of_truth` | `docs/SSOT.md`, `docs/agent-com-message-queue-spec.md`, future Feature Specs and Cells |
| `resource_class` | MCP tools, CLI commands, command arguments, JSON outputs, stdio/transport surfaces |
| `risk_tier` | R2 for documentation-only policy changes; R3 for MCP contract, endpoint, or behavior changes |
| `read_only_operations` | inspect docs, list commands, inspect output contracts, run local smoke checks |
| `mutation_operations` | add, remove, rename, or change MCP tools, CLI commands, arguments, or outputs |
| `approval_required_operations` | public contract changes, endpoint/transport changes, required output schema enforcement |
| `forbidden_operations` | changing MCP/tool behavior in this pilot, activating enforcement from this pilot |
| `evidence_required` | Feature Spec, Cell, Impl, tests for command/output behavior, PR review/check evidence |
| `audit_event_expectation` | GitHub PR review and Shirube command review for behavior-changing work |
| `post_merge_verification_expectation` | command smoke or contract test evidence at the merged SHA when behavior changes |

### Agent Identities

| Field | Policy |
| --- | --- |
| `registry_id` | `agent_identity` |
| `owner` | repo owner, domain designer |
| `source_of_truth` | AUN registry design docs, `agents` table when implemented, GitHub governance artifacts for policy changes |
| `resource_class` | `agent_id`, `agent_uri`, agent profile, workspace reference, human/bot identity |
| `risk_tier` | R2 for policy/design; R3 for identity schema or routing authority changes |
| `read_only_operations` | inspect identity docs, inspect non-secret profile evidence, list known agents |
| `mutation_operations` | register/update identities, profiles, workspaces, aliases, routing authority |
| `approval_required_operations` | identity canonicalization, migration, duplicate handling, routing-authority changes |
| `forbidden_operations` | treating Discord IDs, tmux sessions, local paths, or provider tokens as core identity |
| `evidence_required` | deterministic profile or DB evidence plus GitHub PR/review evidence |
| `audit_event_expectation` | audit record for identity changes and conflict handling |
| `post_merge_verification_expectation` | profile/registry doctor evidence when identity behavior changes |

### Runtime Instances and Endpoint Leases

| Field | Policy |
| --- | --- |
| `registry_id` | `runtime_instance_endpoint_lease` |
| `owner` | runtime owner, release owner, CTO for high-risk activation |
| `source_of_truth` | runtime instance records, endpoint lease evidence, supervisor evidence, future Cells |
| `resource_class` | runtime process, endpoint lease, supervisor evidence, runner profile |
| `risk_tier` | R2 for policy/design; R3 for restart, cleanup, lease, scheduler, or runtime adapter behavior |
| `read_only_operations` | inspect liveness/readiness docs and non-mutating diagnostics |
| `mutation_operations` | start, stop, restart, cleanup, claim lease, release lease, invoke runner |
| `approval_required_operations` | runtime supervisor changes, restart/cleanup, lease takeover, runner activation |
| `forbidden_operations` | using tmux, port number, local path, ACK, or TUI output as sole authority |
| `evidence_required` | exact runtime identity, endpoint lease/fencing evidence, approved Cell, audit evidence |
| `audit_event_expectation` | audit event for lifecycle mutation and approval scope |
| `post_merge_verification_expectation` | runtime inventory/doctor evidence and no stale owner evidence when behavior changes |

### Connectors and Provider UI Bindings

| Field | Policy |
| --- | --- |
| `registry_id` | `connector_provider_ui_binding` |
| `owner` | security owner, release owner |
| `source_of_truth` | connector credential registry, provider identity evidence, UI binding evidence, GitHub PR evidence |
| `resource_class` | connector instance, credential reference, provider subject, provider channel access, UI binding |
| `risk_tier` | R2 for policy/design; R3 for credential, provider access, or external delivery behavior |
| `read_only_operations` | inspect non-secret fingerprints, binding status, provider access evidence |
| `mutation_operations` | create/update connector, bind provider subject, refresh access evidence, change delivery owner |
| `approval_required_operations` | secret reference changes, provider delivery changes, credential rotation, external send changes |
| `forbidden_operations` | raw token output, raw token storage in diagnostics, provider mutation from this pilot |
| `evidence_required` | non-secret credential fingerprint/reference, provider access evidence, security approval when applicable |
| `audit_event_expectation` | audit event for credential/binding/delivery-owner mutation |
| `post_merge_verification_expectation` | connector readiness and provider access evidence when behavior changes |

### Agent Messages and Queue Resources

| Field | Policy |
| --- | --- |
| `registry_id` | `agent_message_queue_resource` |
| `owner` | domain designer, release owner |
| `source_of_truth` | `agent_messages`, `message_queue`, queue specs, GitHub issue/PR evidence |
| `resource_class` | inbound message, per-agent queue row, claim state, terminal state, reply/fail/skip state |
| `risk_tier` | R2 for policy/design; R3 for claim, finalize, recovery, routing, or terminal-state behavior |
| `read_only_operations` | inspect queue specs, count/read diagnostic rows when an approved Cell allows it |
| `mutation_operations` | insert, claim, mark processing, reply, fail, skip, reclaim, finalize |
| `approval_required_operations` | queue lifecycle changes, recovery/cleanup, terminal-state semantics, production DB mutation |
| `forbidden_operations` | treating pending row, queue ID, ACK, Discord projection, or TUI visibility as completion evidence |
| `evidence_required` | queue row transition evidence, exact queue/message IDs, terminal state, audit evidence |
| `audit_event_expectation` | audit event for claim/finalize/recovery work and failed/waived paths |
| `post_merge_verification_expectation` | deterministic queue claim/finalize check when behavior changes |

### Outbound Delivery Resources

| Field | Policy |
| --- | --- |
| `registry_id` | `outbound_delivery_resource` |
| `owner` | release owner, security owner |
| `source_of_truth` | `outbound_queue`, provider delivery evidence, audit evidence, GitHub PR evidence |
| `resource_class` | outbound queue row, provider send attempt, nonce/dedup evidence, delivery terminal state |
| `risk_tier` | R2 for policy/design; R3 for external send or provider delivery behavior |
| `read_only_operations` | inspect delivery specs and non-mutating delivery diagnostics |
| `mutation_operations` | enqueue outbound delivery, claim outbound row, send to provider, mark sent/failed |
| `approval_required_operations` | provider delivery changes, live external sends, credential-linked mutation |
| `forbidden_operations` | live outbound send, provider mutation, or external dispatch from this pilot |
| `evidence_required` | outbound row state, provider response when applicable, nonce/dedup evidence, audit evidence |
| `audit_event_expectation` | audit event for live sends, delivery failure, and retry/recovery actions |
| `post_merge_verification_expectation` | delivery smoke or dry-run evidence appropriate to risk when behavior changes |

### Audit and Evidence Anchors

| Field | Policy |
| --- | --- |
| `registry_id` | `audit_evidence_anchor` |
| `owner` | evidence owner |
| `source_of_truth` | GitHub issue/PR/review/check artifacts, `.shirube/evidence/**`, audit logs when behavior changes |
| `resource_class` | evidence artifact, audit event, validation result, waiver, review decision |
| `risk_tier` | R2 for policy/design; R3 for audit model or evidence enforcement behavior |
| `read_only_operations` | inspect evidence artifacts, reviews, checks, and audit summaries |
| `mutation_operations` | append evidence, submit review/comment, create waiver, write audit event |
| `approval_required_operations` | waivers, audit model changes, evidence enforcement changes |
| `forbidden_operations` | erasing audit/evidence history, using chat-only state as completion evidence |
| `evidence_required` | changed files, commands run, validation results, scope confirmation, next gate |
| `audit_event_expectation` | explicit audit/review artifact for Cell completion and merge handling |
| `post_merge_verification_expectation` | post-merge evidence appropriate to risk tier before completion claim |

### GitHub Governance Artifacts

| Field | Policy |
| --- | --- |
| `registry_id` | `github_governance_artifact` |
| `owner` | repo owner, release owner, human maintainer |
| `source_of_truth` | GitHub issue, PR, review, check, comment, merge record |
| `resource_class` | issue, PR, review thread, check run, workflow artifact, merge authorization |
| `risk_tier` | R2 for policy/design; R3 for merge authority, ruleset, workflow, or required-check behavior |
| `read_only_operations` | inspect issue/PR/check/review state |
| `mutation_operations` | create/update issue or PR comment, labels, review, merge handling |
| `approval_required_operations` | merge authorization, ready-for-review, required-check/ruleset/workflow changes |
| `forbidden_operations` | branch protection/ruleset mutation, required-check activation, merge attempt from this pilot |
| `evidence_required` | exact head SHA, check summary, review/owner authorization, merge actor when applicable |
| `audit_event_expectation` | durable GitHub comment/review/check evidence for decisions |
| `post_merge_verification_expectation` | merged SHA and post-merge verification evidence before completion claim |

## Approval Boundary Summary

Read-only planning and diagnostics are allowed only within an approved Cell and only when they do not mutate protected resources. Mutation-capable operations require future behavior-changing Cells with exact fences.

R3 owner/security/CTO approval is required for production activation, external delivery changes, secret/ruleset changes, runtime supervisor changes, queue lifecycle changes, endpoint lease mutation, provider delivery mutation, or audit/evidence enforcement changes.

## Completion Evidence Boundary

Completion evidence must be anchored in durable artifacts:

- GitHub issue or PR URL
- exact head SHA
- changed files
- validation commands and results
- review or owner decision when required
- DB/runtime/provider evidence when behavior changes
- post-merge verification evidence appropriate to risk

The following are operator hints only unless backed by the above evidence:

- ACK text
- queue ID alone
- Discord projection
- TUI visibility
- green CI alone
- unverified runtime state
- local path or tmux session name

## Post-Merge Verification Expectation

For this policy/design pilot, post-merge verification is mechanical confirmation that the merged SHA contains only the approved policy artifacts and that no runtime/workflow/package/DB paths changed.

For later behavior-changing Cells, post-merge verification must include deterministic command output, CI/check evidence, relevant DB rows or runtime evidence, audit evidence, and rollback/rework notes when applicable.
