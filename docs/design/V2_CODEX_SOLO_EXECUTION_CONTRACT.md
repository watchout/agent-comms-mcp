<!-- aun:v2-codex-solo-execution-contract/v1 -->

# AUN V2 Codex Solo Execution Contract

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: make AUN V2 implementable by Codex without human interpretation drift  
Implementation allowed from this document: false

## 1. Purpose

This document turns the AUN V2 design into an execution contract that a Codex agent can follow alone.

Goal:

```text
A Codex agent can take the next approved Shirube V3 Cell, implement it, test it, and prepare the next Cell without guessing architecture intent, file names, field names, test requirements, or stop conditions.
```

This document is not runtime implementation. It defines the contract for autonomous implementation.

## 2. Authority order

Codex must use sources in this order:

```text
1. docs/design/V2_CLEAN_CORE_CONTRACT.md
2. docs/design/REBOOT_CHARTER_RECONCILIATION.md
3. docs/design/V2_DELETION_MAP.md
4. docs/design/V2_CODEX_SOLO_EXECUTION_CONTRACT.md
5. docs/design/V2_CODEX_BUILD_PLAN.md
6. docs/design/V2_ENTERPRISE_ADOPTION_GATE.md
7. docs/decision-backlog.md
8. existing V1 code, only as adapter input
```

If existing V1 code conflicts with the V2 clean core contract, the V2 contract wins for new V2 code.

## 3. Codex autonomy rule

Codex may proceed without human clarification only when all of the following are true:

```text
- the target Cell has a single contract delta;
- all required files are named by the Cell packet;
- all schema fields are specified or explicitly optional;
- tests can run without live DB, Discord, GitHub, tmux, or production state;
- no protected runtime mutation is performed;
- any uncertainty is DETAIL-level and can be recorded as a default with a decision-backlog entry.
```

Codex must stop when any of the following are true:

```text
- CORE or CONTRACT meaning is ambiguous;
- a new semantic outcome is needed;
- a V1 term must become canonical V2 vocabulary;
- implementation would require live DB mutation;
- implementation would require connector send/write;
- implementation would require AUN to decide Shirube Done, merge, or production state;
- post-merge evidence would require a follow-up repo-file commit;
- tests require external credentials;
- the file count would exceed the Cell limit and no split is defined.
```

## 4. Cell packet format

Every autonomous Codex Cell must have this packet before implementation:

```yaml
cell_id: AUN-V2-XXX
risk_route: R0_docs_only | R1_schema_or_test_only | R2_read_only_planner | R3_protected_runtime | R4_live_activation
design_refs:
  - docs/design/V2_CLEAN_CORE_CONTRACT.md
  - docs/design/V2_CODEX_SOLO_EXECUTION_CONTRACT.md
goal: <one sentence>
non_scope: []
contract_delta:
  adds: []
  changes: []
  forbids: []
input_files: []
output_files: []
allowed_imports: []
forbidden_imports: []
validation_commands: []
required_tests: []
evidence_sink:
  pre_merge: repository_file | test_output | pr_comment
  post_merge: github_pr_comment | github_issue_comment | github_workflow_artifact | github_check_run | none
rollback_plan: <text>
next_cell: <cell_id|null>
```

If a Cell lacks this packet, Codex must not implement it.

## 5. Fixed implementation defaults

These defaults remove unnecessary questions.

```yaml
runtime_language: TypeScript
runtime_package_manager: bun
schema_format: JSON Schema draft 2020-12
schema_directory: schemas/aun-v2
test_directory: tests
fixture_directory: tests/fixtures/aun-v2
module_style: existing repository TypeScript module style
json_output: required for CLI surfaces
external_services_in_tests: forbidden
production_db_in_tests: forbidden
provider_send_in_tests: forbidden
max_files_per_cell_pr: 6
```

Default validation commands:

```bash
git diff --check
bun test tests/aun-v2-*.test.ts
```

If repository conventions require a narrower path, Codex may use the nearest existing test convention and must state the adaptation in the PR body.

## 6. Naming conventions

```yaml
schema_files:
  agent: schemas/aun-v2/agent.schema.json
  conversation: schemas/aun-v2/conversation.schema.json
  baton: schemas/aun-v2/baton.schema.json
  claim: schemas/aun-v2/claim.schema.json
  runtime_task: schemas/aun-v2/runtime-task.schema.json
  typed_outcome: schemas/aun-v2/typed-outcome.schema.json
  terminal_evidence: schemas/aun-v2/terminal-evidence.schema.json
  audit_event: schemas/aun-v2/audit-event.schema.json
  post_merge_evidence: schemas/aun-v2/post-merge-evidence.schema.json

fixtures:
  valid: tests/fixtures/aun-v2/valid/<name>.json
  invalid: tests/fixtures/aun-v2/invalid/<name>.json

core_code:
  validator: core/aun-v2/schema-validator.ts
  planner: core/aun-v2/planner.ts
  adapters: core/aun-v2/adapters/<adapter>.ts
  terminal_evidence: core/aun-v2/terminal-evidence.ts

cli:
  validate: bin/aun/v2-validate.ts
  plan: bin/aun/v2-plan.ts
  canary_plan: bin/aun/v2-canary-plan.ts
```

## 7. Cell dependency graph

```text
AUN-V2-001 architecture docs
  -> AUN-V2-002A identity/conversation/baton/claim schemas
    -> AUN-V2-002B runtime/outcome/evidence/audit schemas
      -> AUN-V2-003 schema validator
        -> AUN-V2-004 V1 message_queue read-only adapter
          -> AUN-V2-005 V2 read-only planner
            -> AUN-V2-006 synthetic claim
              -> AUN-V2-007 terminal evidence validator
                -> AUN-V2-008 post-merge evidence sink schema
                  -> AUN-V2-009 one-agent canary planner
                    -> AUN-V2-010 live canary executor, protected
```

No Cell may skip its dependency unless a Design Consolidation record explicitly supersedes the graph.

## 8. Detailed Cell specs

### AUN-V2-002A: Identity / conversation / baton / claim schemas

```yaml
risk_route: R1_schema_or_test_only
goal: Define the V2 ownership and claim schemas that prevent identity and responsibility drift.
non_scope:
  - no TypeScript runtime validator
  - no runtime task schema
  - no terminal evidence schema
  - no DB access
  - no adapter
  - no CLI
output_files:
  - schemas/aun-v2/agent.schema.json
  - schemas/aun-v2/conversation.schema.json
  - schemas/aun-v2/baton.schema.json
  - schemas/aun-v2/claim.schema.json
  - tests/fixtures/aun-v2/valid/minimal-baton-claim.json
  - tests/fixtures/aun-v2/invalid/observer-as-owner.json
acceptance:
  - every schema declares schema_version
  - agent schema makes agent_id logical identity
  - conversation schema supports active_baton_id
  - baton schema distinguishes owner_agent_id from observer_agent_ids
  - claim schema requires lease_expires_at and fencing_token
  - observer-as-owner invalid fixture is documented
  - no V1 queue-work terms are canonical schema names
validation_commands:
  - git diff --check
next_cell: AUN-V2-002B
```

### AUN-V2-002B: Runtime task / typed outcome / terminal evidence / audit schemas

```yaml
risk_route: R1_schema_or_test_only
goal: Define execution, outcome, terminal evidence, and audit schemas without making provider output the authority.
non_scope:
  - no TypeScript runtime validator
  - no DB access
  - no adapter
  - no CLI
input_files:
  - schemas/aun-v2/agent.schema.json
  - schemas/aun-v2/conversation.schema.json
  - schemas/aun-v2/baton.schema.json
  - schemas/aun-v2/claim.schema.json
output_files:
  - schemas/aun-v2/runtime-task.schema.json
  - schemas/aun-v2/typed-outcome.schema.json
  - schemas/aun-v2/terminal-evidence.schema.json
  - schemas/aun-v2/audit-event.schema.json
  - tests/fixtures/aun-v2/valid/minimal-terminal-reply.json
  - tests/fixtures/aun-v2/invalid/done-without-outcome.json
acceptance:
  - every schema declares schema_version
  - terminal evidence requires typed outcome
  - typed outcome uses semantic_outcome plus outcome_reason
  - terminal evidence does not treat projection_refs as authority
  - audit event reserves prev_hash, event_hash, cost_ref, redaction_ref, and attestation_ref
  - done-without-outcome invalid fixture is documented
validation_commands:
  - git diff --check
next_cell: AUN-V2-003
```

### AUN-V2-003: Schema validator

```yaml
risk_route: R1_schema_or_test_only
goal: Add deterministic validator for AUN V2 schemas and fixtures.
input_files:
  - schemas/aun-v2/*.schema.json
  - tests/fixtures/aun-v2/**/*.json
output_files:
  - core/aun-v2/schema-validator.ts
  - bin/aun/v2-validate.ts
  - tests/aun-v2-schema-validator.test.ts
acceptance:
  - valid fixtures pass
  - invalid fixtures fail with stable error codes
  - CLI emits JSON only with --json
  - no DB access
  - no network access
validation_commands:
  - bun test tests/aun-v2-schema-validator.test.ts
  - git diff --check
next_cell: AUN-V2-004
```

### AUN-V2-004: V1 message_queue read-only adapter

```yaml
risk_route: R2_read_only_planner
goal: Project a V1 message_queue row into a V2 candidate input without treating V1 state as V2 authority.
output_files:
  - core/aun-v2/adapters/message-queue-readonly.ts
  - tests/aun-v2-message-queue-readonly.test.ts
forbidden_imports:
  - core/aun-runtime-v2.ts as canonical V2 type source
  - core/queue-work.ts as canonical V2 type source
acceptance:
  - adapter output uses V2 schema names
  - adapter marks lossy mappings
  - queue status maps to compatibility_state, not semantic outcome
  - no mutation SQL
  - no live DB
validation_commands:
  - bun test tests/aun-v2-message-queue-readonly.test.ts
  - git diff --check
next_cell: AUN-V2-005
```

### AUN-V2-005: V2 read-only planner

```yaml
risk_route: R2_read_only_planner
goal: Build a read-only planner that evaluates whether a V2 baton/claim can be planned from V2-shaped input.
output_files:
  - core/aun-v2/planner.ts
  - bin/aun/v2-plan.ts
  - tests/aun-v2-planner.test.ts
acceptance:
  - no mutation SQL
  - exact fence mismatch blocks
  - observer cannot be owner
  - stale runtime blocks
  - conflicting active claim blocks
  - plan output includes evidence_refs array
  - --json required for CLI
validation_commands:
  - bun test tests/aun-v2-planner.test.ts
  - git diff --check
next_cell: AUN-V2-006
```

### AUN-V2-006: Synthetic claim

```yaml
risk_route: R2_read_only_planner
note: synthetic only; no live DB mutation
goal: Prove claim/lease/fence mechanics with in-memory or fixture-backed data.
output_files:
  - core/aun-v2/claim-synthetic.ts
  - tests/aun-v2-claim-synthetic.test.ts
acceptance:
  - claim requires baton_id, owner_agent_id, runtime_instance_id, lease_expires_at, fencing_token
  - stale holder cannot finalize
  - wrong fencing_token cannot finalize
  - observer cannot claim as owner
  - no production DB mutation
validation_commands:
  - bun test tests/aun-v2-claim-synthetic.test.ts
  - git diff --check
next_cell: AUN-V2-007
```

### AUN-V2-007: Terminal evidence validator

```yaml
risk_route: R1_schema_or_test_only
goal: Validate terminal evidence before any queue or projection close path can use it.
output_files:
  - core/aun-v2/terminal-evidence.ts
  - tests/aun-v2-terminal-evidence.test.ts
acceptance:
  - terminal done requires semantic_outcome and outcome_reason
  - provider projection alone does not pass
  - handoff requires handoff_ref
  - reply requires reply_ref or explicit no-output reason
  - fail requires failure reason
validation_commands:
  - bun test tests/aun-v2-terminal-evidence.test.ts
  - git diff --check
next_cell: AUN-V2-008
```

### AUN-V2-008: Post-merge evidence sink schema

```yaml
risk_route: R1_schema_or_test_only
goal: Define GitHub-native post-merge evidence sink schema without requiring follow-up repo-file commits.
output_files:
  - schemas/aun-v2/post-merge-evidence.schema.json
  - templates/aun-v2-post-merge-evidence.md
  - tests/aun-v2-post-merge-evidence.test.ts
acceptance:
  - schema requires durable URL
  - schema records source PR and merge_commit_sha
  - schema requires post_merge_checks_classified
  - repo-file post-merge evidence per merge is not required
validation_commands:
  - bun test tests/aun-v2-post-merge-evidence.test.ts
  - git diff --check
next_cell: AUN-V2-009
```

### AUN-V2-009: One-agent canary planner

```yaml
risk_route: R2_read_only_planner
goal: Produce a read-only one-agent exact-fenced canary plan.
output_files:
  - core/aun-v2/canary-plan.ts
  - bin/aun/v2-canary-plan.ts
  - tests/aun-v2-canary-plan.test.ts
acceptance:
  - exact queue/message/time fence required
  - one-agent allowlist required
  - emits executable command only as disabled preview
  - no mutation
  - rollback plan field required
validation_commands:
  - bun test tests/aun-v2-canary-plan.test.ts
  - git diff --check
next_cell: AUN-V2-010
```

### AUN-V2-010: Live canary executor

```yaml
risk_route: R4_live_activation
goal: Execute one exact-fenced canary behind explicit approval.
status: blocked until separate protected Cell Intake Gate
acceptance:
  - must not start from PR-001
  - must not start before AUN-V2-002A through AUN-V2-009 pass
  - must have release/operator approval
  - must produce post-run evidence URL
```

## 9. Default PR body for Codex

```markdown
<!-- aun:v2-cell/<cell-id>/v1 -->

## Shirube V3 Cell

cell_id: AUN-V2-XXX
risk_route: R0|R1|R2|R3|R4
source_design:
- docs/design/V2_CLEAN_CORE_CONTRACT.md
- docs/design/V2_CODEX_SOLO_EXECUTION_CONTRACT.md

## Goal

## V2 Contract Delta

## V1 Compatibility Boundary

## Files Changed

## Tests / Validation

## Generated Evidence

## Non-scope

## Rollback / Revert Plan

## Protected Surfaces

## Next Cell
```

## 10. Success criteria for this contract

This contract is successful when a Codex agent can implement AUN-V2-002A through AUN-V2-009 without asking what files to create, what fields are canonical, what tests are required, how to validate, or when to stop.

Human review remains required for protected Cell authorization and semantic changes to the V2 contract.
