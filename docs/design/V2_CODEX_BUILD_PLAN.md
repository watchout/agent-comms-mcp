<!-- aun:v2-codex-build-plan/v1 -->

# AUN V2 Codex Build Plan

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: Codex-friendly implementation plan for AUN V2 under Shirube V3  
Implementation allowed from this document: false

## 1. Purpose

AUN V2 must be implementable quickly by Codex without reintroducing broad, low-signal refactors.

The unit of work is a small, contract-focused **Shirube V3 Cell**.

AUN V2 does not define an independent work-governance conveyor. AUN V2 implementation work must be represented through `watchout/ai-dev-framework` Shirube V3 Phase / Cell / Gate concepts.

## 2. Build principle

```text
Design first.
Schema second.
Read-only planner third.
Synthetic mutation fourth.
One-agent exact-fenced canary fifth.
Only then expand policy.
```

No Cell should mix broad refactor, migration, runtime behavior, and governance changes.

## 2A. Shirube V3 execution assumption

AUN V2 implementation assumes Shirube V3 is the controlling execution framework.

```text
Shirube V3 provides:
  - Phase / Cell modeling
  - Design Consolidation Gate
  - Cell Intake Gate
  - Goal Mode handoff
  - Machine Gate
  - Narrow Verification
  - Cell Done
  - Phase Completion Gate

AUN V2 provides:
  - runtime authorization contracts
  - V2 core schemas
  - V1 compatibility adapters
  - operational evidence contracts
  - runtime/projection/recovery implementation details
```

If a Shirube V3 CLI command is not available yet, the Cell may use structured repository records and/or structured GitHub-native evidence sinks, but the semantics must still match Shirube V3.

## 2B. High-speed Cell rule

The fastest acceptable implementation path is:

```text
one Cell = one contract delta = one narrow PR = one focused validation packet
```

Codex should optimize for many small mergeable Cells, not large mixed refactors.

AUN-specific PR names may be used for readability, but the authoritative planning unit is the Shirube V3 Cell.

## 3. PR / Cell size limits

Default limits:

```yaml
max_files_per_cell_pr: 6
max_new_runtime_behaviors_per_cell: 1
max_schema_domains_per_cell: 1
max_migration_files_per_cell: 1
max_adapter_boundaries_per_cell: 1
```

Exceeding these limits requires a Design Consolidation note and explicit reason.

## 4. Required PR body sections

Every V2 Cell PR must include:

```markdown
## Shirube V3 Cell

## V2 Contract Delta

## V1 Compatibility Boundary

## Files Changed

## Tests / Validation

## Generated Evidence

## Non-scope

## Rollback / Revert Plan

## Protected Surfaces
```

## 5. Risk routes

```yaml
R0_docs_only:
  allowed_changes:
    - docs/design/**
    - docs/spec/**
  required_validation:
    - git diff --check

R1_schema_or_test_only:
  allowed_changes:
    - schemas/**
    - tests/**
    - fixtures/**
  required_validation:
    - focused tests
    - schema validation

R2_read_only_planner:
  allowed_changes:
    - core/*plan*
    - bin/aun/*plan*
  required_validation:
    - no mutation tests
    - invalid argument tests
    - missing DB tests

R3_protected_runtime:
  protected_surfaces:
    - claim
    - lease
    - fencing
    - runtime invocation
    - connector credential
    - projection send
  required_validation:
    - design doc link
    - exact fence tests
    - synthetic fixture
    - rollback plan
    - no production DB mutation
    - Shirube V3 Cell Intake Gate evidence

R4_live_activation:
  default: blocked
  requires:
    - explicit operator approval
    - one-agent allowlist
    - exact queue/message/time fence
    - post-run evidence
    - Shirube V3 protected Cell authorization
```

## 6. Forbidden PR patterns

Codex must not produce Cell PRs that:

- rewrite broad directories without a contract delta;
- mix docs, migration, runtime mutation, and connector send behavior;
- remove V1 behavior without adapter test;
- change queue terminal semantics without typed outcome rule;
- introduce untyped `done`;
- use provider output as completion authority;
- make AUN own Shirube gate verdict, Done, merge, or production authority;
- require post-merge facts to be committed by follow-up repo-file PR;
- mutate production DB in tests;
- rely on Discord/tmux transcript reading as pass evidence;
- bypass Shirube V3 Cell Intake for protected runtime work.

## 7. V2 Cell sequence

### Cell AUN-V2-001: Clean rebuild architecture

Files:

```text
docs/design/REBOOT_ARCHITECTURE.md
docs/design/REBOOT_CHARTER_RECONCILIATION.md
docs/design/V2_CLEAN_CORE_CONTRACT.md
docs/design/V2_DELETION_MAP.md
docs/design/V2_CODEX_BUILD_PLAN.md
docs/design/V2_ENTERPRISE_ADOPTION_GATE.md
docs/decision-backlog.md
```

No code change.

### Cell AUN-V2-002: V2 schemas and examples

Files:

```text
schemas/aun-v2/agent.schema.json
schemas/aun-v2/conversation.schema.json
schemas/aun-v2/baton.schema.json
schemas/aun-v2/claim.schema.json
schemas/aun-v2/terminal-evidence.schema.json
tests/fixtures/aun-v2/*.json
```

No runtime behavior.

### Cell AUN-V2-003: V2 schema validator

Files:

```text
core/aun-v2/schema-validator.ts
bin/aun/v2-validate.ts
tests/aun-v2-schema-validator.test.ts
```

No DB mutation.

### Cell AUN-V2-004: V1 message queue read-only adapter

Files:

```text
core/aun-v2/adapters/message-queue-readonly.ts
tests/aun-v2-message-queue-readonly.test.ts
```

No mutation.

### Cell AUN-V2-005: V2 read-only planner

Files:

```text
core/aun-v2/planner.ts
bin/aun/v2-plan.ts
tests/aun-v2-planner.test.ts
```

No mutation.

### Cell AUN-V2-006: V2 synthetic claim

Files:

```text
core/aun-v2/claim-synthetic.ts
tests/aun-v2-claim-synthetic.test.ts
```

Test fixtures only.

### Cell AUN-V2-007: V2 terminal evidence validator

Files:

```text
core/aun-v2/terminal-evidence.ts
tests/aun-v2-terminal-evidence.test.ts
```

No live projection.

### Cell AUN-V2-008: GitHub-native post-merge evidence sink schema

Files:

```text
schemas/aun-v2/post-merge-evidence.schema.json
templates/aun-v2-post-merge-evidence.md
tests/aun-v2-post-merge-evidence.test.ts
```

No follow-up repo-file evidence requirement.

### Cell AUN-V2-009: One-agent exact-fenced canary planner

Files:

```text
core/aun-v2/canary-plan.ts
bin/aun/v2-canary-plan.ts
tests/aun-v2-canary-plan.test.ts
```

Read-only.

### Cell AUN-V2-010: Live canary executor behind explicit gate

Protected. Requires separate Shirube V3 protected Cell approval.

## 8. Required tests per Cell type

```yaml
docs_only:
  - git diff --check

schema:
  - valid fixture passes
  - invalid fixture blocks
  - unknown field policy tested

read_only_planner:
  - no mutation SQL
  - missing row
  - stale runtime
  - wrong owner
  - observer-not-owner
  - exact fence mismatch

synthetic_mutation:
  - atomic claim fixture
  - lease required
  - fence required
  - stale holder rejected
  - terminal evidence required

live_canary:
  - exact target only
  - one agent allowlist
  - rollback evidence
  - post-run evidence URL
```

## 9. Codex handoff prompt template

```text
You are implementing AUN V2 as a Shirube V3 Cell.
Use only the contract in docs/design/V2_CLEAN_CORE_CONTRACT.md.
Do not import V1 queue-work types as canonical V2 types.
Use V1 only through the named adapter boundary.
Keep this Cell PR within the declared file limit.
Do not mutate live DB.
Do not create provider output as completion authority.
Do not claim Shirube Cell Done from AUN runtime evidence alone.
Return changed files, contract delta, tests, evidence, and non-scope.
```

## 10. Stop conditions for Codex

Codex must stop and request design review if:

- a required concept is missing from V2_CLEAN_CORE_CONTRACT;
- V1 and V2 names conflict;
- terminal state needs new semantic outcome;
- adapter output is lossy without documented mapping;
- test requires live Discord/GitHub/DB access;
- post-merge evidence requires a committed follow-up file;
- a protected runtime change lacks Shirube V3 Cell Intake evidence.
