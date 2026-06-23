# Shirube Full Adoption Overlay Spec

SPEC-ID: SPEC-MCP-SHIRUBE-FULL-ADOPTION-001
Risk Tier: R3
CELL-ID: CELL-MCP-SHIRUBE-FULL-ADOPTION-001

## Purpose

Complete the repository-local Shirube full adoption overlay for `watchout/agent-comms-mcp` so AUN work does not continue under loose partial adoption.

The goal is to stop subject drift before implementation by making the target repository, required PR controls, owner exact-head merge policy, and support-repo classifications machine-checked in the active PR workflow.

## Non-Goals

- No runtime code changes.
- No MCP/tool behavior changes.
- No queue mutation.
- No state-daemon changes.
- No provider delivery changes.
- No DB migration.
- No secret access.
- No AUN activation.
- No ruleset mutation when branch protection required checks provide the active merge gate.

## Requirements

| ID | Statement |
| --- | --- |
| REQ-MCP-SHIRUBE-FULL-001 | Add a repo-local hard gate that confirms `watchout/agent-comms-mcp` is the target repo. |
| REQ-MCP-SHIRUBE-FULL-002 | Require current-head evidence and owner exact-head controls before non-draft merge handling. |
| REQ-MCP-SHIRUBE-FULL-003 | Classify support repos as non-targets. |
| REQ-MCP-SHIRUBE-FULL-004 | Prevent CI green alone from becoming merge-ready. |
| REQ-MCP-SHIRUBE-FULL-005 | Add PR template fields for Shirube controls and post-merge evidence. |
| REQ-MCP-SHIRUBE-FULL-006 | Require `Layer 0 — machine gate` through branch protection required status checks. |
| REQ-MCP-SHIRUBE-FULL-007 | Require a machine-verifiable owner exact-head decision artifact before non-draft merge handling. |

## Acceptance Criteria

| ID | Linked Requirements | Statement |
| --- | --- | --- |
| AC-MCP-SHIRUBE-FULL-001 | REQ-MCP-SHIRUBE-FULL-001 REQ-MCP-SHIRUBE-FULL-003 | Workflow checks fail if the target repo or support-repo classifications drift. |
| AC-MCP-SHIRUBE-FULL-002 | REQ-MCP-SHIRUBE-FULL-002 REQ-MCP-SHIRUBE-FULL-004 REQ-MCP-SHIRUBE-FULL-007 | Auto-merge requires non-draft state, owner exact-head labels, and a machine-verified owner decision artifact; CI green alone is insufficient. |
| AC-MCP-SHIRUBE-FULL-003 | REQ-MCP-SHIRUBE-FULL-005 | New PRs receive a Shirube metadata and evidence template. |
| AC-MCP-SHIRUBE-FULL-004 | REQ-MCP-SHIRUBE-FULL-006 | Branch protection requires `Layer 0 — machine gate`, which includes the Shirube gate. |

## Test Plan

| TEST-ID | Linked Acceptance Criteria | Description |
| --- | --- | --- |
| TEST-MCP-SHIRUBE-FULL-001 | AC-MCP-SHIRUBE-FULL-001 | Run `node scripts/shirube-full-adoption-check.mjs` with a PR event and changed-files input. |
| TEST-MCP-SHIRUBE-FULL-002 | AC-MCP-SHIRUBE-FULL-002 | Verify `.github/workflows/pr-checks.yml` auto-merge condition requires non-draft and owner exact-head labels, and verify the gate rejects non-draft PRs without a matching owner decision comment. |
| TEST-MCP-SHIRUBE-FULL-003 | AC-MCP-SHIRUBE-FULL-003 AC-MCP-SHIRUBE-FULL-004 | Run `git diff --check` and YAML parse for `.shirube/**/*.yaml`. |
| TEST-MCP-SHIRUBE-FULL-004 | AC-MCP-SHIRUBE-FULL-004 | Verify GitHub branch protection required status checks include `Layer 0 — machine gate`. |

## Review Gate

This is an R3 governance/enforcement adoption Cell because it changes active workflow behavior and merge controls. It does not authorize AUN runtime implementation or activation.
