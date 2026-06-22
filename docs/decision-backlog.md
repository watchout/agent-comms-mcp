<!-- aun:v2-decision-backlog/v1 -->

# AUN V2 Decision Backlog

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: open decisions for AUN V2 clean rebuild under Shirube V3  
Implementation allowed from this document: false

## DB-REBOOT-001: Shirube V3 sequencing dependency

Status: open  
Owner: Shirube owner + AUN architecture owner + CTO  
Blocks: SSOT freeze, automated work dispatch, runtime-generated implementation Cells

### Question

Which Shirube V3 capabilities are available for AUN reboot execution now?

### Known risk

AUN V2 implementation is intended to run under `watchout/ai-dev-framework` Shirube V3, but some CLI automation may lag the accepted V3 semantics.

If AUN assumes unavailable commands such as `retrofit`, `plan`, `run`, or full automated Cell dispatch, implementation may stall or create parallel AUN-specific governance.

### Required direction

AUN V2 must use Shirube V3 as the governing execution model.

AUN must not create its own replacement for Shirube V3 Phase / Cell / Gate / Done semantics.

### Default safe policy

Treat PR-001 and early schema/read-only work as Shirube V3 Design Consolidation / Cell Intake records represented by repository docs and structured GitHub-native evidence sinks where CLI automation is not yet available.

### Required resolution

Map every AUN V2 implementation slice to a Shirube V3 Cell before implementation begins.

---

## DB-REBOOT-002: Shirube post-merge evidence sink dependency

Status: open  
Owner: Shirube owner + AUN architecture owner + CTO  
Blocks: Cell Done automation, Phase Completion Gate integration, AUN/Shirube evidence handoff design

### Question

Does Shirube require post-merge evidence to be committed as repository files, or can canonical post-merge evidence live in GitHub PR/Issue comments, check runs, or workflow artifacts?

### Known risk

If AUN requires post-merge facts to be committed as repository files, every merged Cell can create a follow-up record-only PR, which itself requires post-merge evidence.

This creates an evidence recursion and slows AUN normalization.

### Required direction

AUN reboot must not depend on follow-up repository-file commits for post-merge evidence.

### Default safe policy

Use a structured GitHub comment, artifact, or check-run URL as canonical post-merge evidence sink. Repository files define schema, template, validator, and sink policy only.

---

## DB-REBOOT-003: V2 schema persistence target

Status: open  
Owner: AUN architecture owner  
Blocks: database migration planning

### Question

Should AUN V2 clean core records be stored in new V2 tables first, or projected from V1 tables through adapters until runtime-v2 is stable?

### Default safe policy

Start with JSON schemas and read-only projections from V1 data. Add V2 tables only after schema validation and adapter tests pass.

---

## DB-REBOOT-004: `done` terminal vocabulary

Status: open  
Owner: AUN architecture owner + charter owner  
Blocks: queue terminal-state contract freeze

### Question

Can the existing `done` vocabulary be retained as a terminal queue state if terminal evidence and typed outcome are mandatory?

### Default safe policy

Allow `done` only as a terminal storage state. Non-terminal turn completion must use another name such as `turn_complete_pending_outcome`.

---

## DB-REBOOT-005: Semantic outcome model

Status: open  
Owner: AUN architecture owner + charter owner  
Blocks: terminal evidence schema

### Question

Should `semantic_outcome` remain exactly `reply | handoff | no_reply | close | fail`, or should `fail` be modeled only as terminal state plus reason?

### Default safe policy

Use `semantic_outcome=fail` for communication-level failure, and reserve precise failure classes under `outcome_reason` such as `runtime_failed`, `validation_failed`, and `connector_failed`.

---

## DB-REBOOT-006: V1 compatibility adapter boundaries

Status: open  
Owner: AUN architecture owner  
Blocks: first V1 adapter PR

### Question

Which V1 paths may be read by V2 adapters without importing V1 semantics into V2 core?

### Default safe policy

Allow read-only adapters for `message_queue`, `agent_messages`, runtime evidence, and connector evidence. Do not import V1 queue-work types as canonical V2 types.

---

## DB-REBOOT-007: Enterprise reservation implementation timing

Status: open  
Owner: AUN architecture owner + CTO  
Blocks: enterprise adoption gate PASS

### Question

Which enterprise reservations must be schema fields in MVP, and which may remain documented reservations?

### Default safe policy

Reserve fields in schema for FinOps, tamper evidence, DLP/redaction, and identity attestation. Implementation may be WARN-level in MVP if future compatibility is preserved.

---

## DB-REBOOT-008: Live canary authorization

Status: open  
Owner: release owner + AUN operator  
Blocks: first live V2 mutation

### Question

What exact approval and evidence are required before a one-agent V2 canary mutates live queue state?

### Default safe policy

Require exact queue/message/time fence, one-agent allowlist, dry-run planner PASS, rollback plan, and structured post-run evidence URL.

---

## DB-REBOOT-009: Shirube V3 high-speed Cell execution contract

Status: open  
Owner: Shirube owner + AUN architecture owner  
Blocks: Codex implementation prompt standardization

### Question

What is the exact minimum record packet needed for a high-speed AUN V2 Codex Cell under Shirube V3?

### Known risk

If every small Codex PR requires heavy manual ceremony, AUN V2 will slow down. If the ceremony is skipped, AUN may fork the governance model or lose evidence discipline.

### Required direction

Define a lightweight Shirube V3 Cell packet for AUN V2:

```text
Cell ID
Design source
Contract delta
V1 compatibility boundary
Risk route
Validation commands
Evidence sink
Non-scope
Rollback / revert plan
```

### Default safe policy

Use the lightweight packet for R0/R1/R2 Cells. Require full protected Cell Intake evidence for R3/R4 runtime, connector, queue, or migration changes.
