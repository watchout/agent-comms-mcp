<!-- aun:v2-codex-build-plan/v1 -->

# AUN V2 Codex Build Plan

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: Codex-friendly implementation plan for AUN V2  
Implementation allowed from this document: false

## 1. Purpose

AUN V2 must be implementable quickly by Codex without reintroducing broad, low-signal refactors.

The unit of work is a small, contract-focused PR.

## 2. Build principle

```text
Design first.
Schema second.
Read-only planner third.
Synthetic mutation fourth.
One-agent exact-fenced canary fifth.
Only then expand policy.
```

No PR should mix broad refactor, migration, runtime behavior, and governance changes.

## 3. PR size limits

Default limits:

```yaml
max_files_per_pr: 6
max_new_runtime_behaviors_per_pr: 1
max_schema_domains_per_pr: 1
max_migration_files_per_pr: 1
max_adapter_boundaries_per_pr: 1
```

Exceeding these limits requires a Design Consolidation note and explicit reason.

## 4. Required PR body sections

Every V2 PR must include:

```markdown
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

R4_live_activation:
  default: blocked
  requires:
    - explicit operator approval
    - one-agent allowlist
    - exact queue/message/time fence
    - post-run evidence
```

## 6. Forbidden PR patterns

Codex must not produce PRs that:

- rewrite broad directories without a contract delta;
- mix docs, migration, runtime mutation, and connector send behavior;
- remove V1 behavior without adapter test;
- change queue terminal semantics without typed outcome rule;
- introduce untyped `done`;
- use provider output as completion authority;
- make AUN own Shirube gate verdict, Done, merge, or production authority;
- require post-merge facts to be committed by follow-up repo-file PR;
- mutate production DB in tests;
- rely on Discord/tmux transcript reading as pass evidence.

## 7. V2 PR sequence

### PR-001: Clean rebuild architecture

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

### PR-002: V2 schemas and examples

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

### PR-003: V2 schema validator

Files:

```text
core/aun-v2/schema-validator.ts
bin/aun/v2-validate.ts
tests/aun-v2-schema-validator.test.ts
```

No DB mutation.

### PR-004: V1 message queue read-only adapter

Files:

```text
core/aun-v2/adapters/message-queue-readonly.ts
tests/aun-v2-message-queue-readonly.test.ts
```

No mutation.

### PR-005: V2 read-only planner

Files:

```text
core/aun-v2/planner.ts
bin/aun/v2-plan.ts
tests/aun-v2-planner.test.ts
```

No mutation.

### PR-006: V2 synthetic claim

Files:

```text
core/aun-v2/claim-synthetic.ts
tests/aun-v2-claim-synthetic.test.ts
```

Test fixtures only.

### PR-007: V2 terminal evidence validator

Files:

```text
core/aun-v2/terminal-evidence.ts
tests/aun-v2-terminal-evidence.test.ts
```

No live projection.

### PR-008: GitHub-native post-merge evidence sink schema

Files:

```text
schemas/aun-v2/post-merge-evidence.schema.json
templates/aun-v2-post-merge-evidence.md
tests/aun-v2-post-merge-evidence.test.ts
```

No follow-up repo-file evidence requirement.

### PR-009: One-agent exact-fenced canary planner

Files:

```text
core/aun-v2/canary-plan.ts
bin/aun/v2-canary-plan.ts
tests/aun-v2-canary-plan.test.ts
```

Read-only.

### PR-010: Live canary executor behind explicit gate

Protected. Requires separate approval.

## 8. Required tests per PR type

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
You are implementing AUN V2. Use only the contract in docs/design/V2_CLEAN_CORE_CONTRACT.md.
Do not import V1 queue-work types as canonical V2 types.
Use V1 only through the named adapter boundary.
Keep this PR within the declared file limit.
Do not mutate live DB.
Do not create provider output as completion authority.
Return changed files, contract delta, tests, and non-scope.
```

## 10. Stop conditions for Codex

Codex must stop and request design review if:

- a required concept is missing from V2_CLEAN_CORE_CONTRACT;
- V1 and V2 names conflict;
- terminal state needs new semantic outcome;
- adapter output is lossy without documented mapping;
- test requires live Discord/GitHub/DB access;
- post-merge evidence requires a committed follow-up file.
