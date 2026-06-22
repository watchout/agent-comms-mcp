<!-- aun:v2-charter-reconciliation/v1 -->

# AUN V2 Charter Reconciliation

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: communication charter ↔ AUN V2 clean core reconciliation  
Parent issue: #794  
Implementation allowed from this document: false

## 1. Layer relationship

The communication charter and AUN V2 do not compete.

```text
Communication charter:
  communication semantics layer
  baton / turn / typed outcome / observer-not-owner

AUN V2 clean core:
  coordination mechanics layer
  claim / lease / fencing / runtime binding / terminal evidence
```

A baton is a semantic responsibility. A claim, lease, and fencing token are the mechanics that make that responsibility durable and recoverable.

## 2. Mapping table

| Charter semantic concept | AUN V2 mechanics concept | Required invariant |
|---|---|---|
| message | normalized input event / agent message | Message content must be immutable after canonical ingestion. |
| delivery | queue/projection delivery record | Delivery does not imply ownership. |
| conversation | `conversation_id` / `conversation_root` | Turns, handoffs, claims, outcomes, and projections must be groupable under one conversation. |
| baton | `baton_id` + active owner | One active response owner per conversation unless handoff explicitly transfers ownership. |
| owner | `owner_agent_id` | Owner has semantic responsibility and may claim work through an eligible runtime. |
| observer / cc / fyi | projection-only recipient | Observer never becomes owner because of copy, delivery, or projection. |
| agent turn | runtime task span | A turn runs inside a claim lease/fence boundary. |
| handoff | typed handoff contract | Handoff must preserve source owner, target owner, expected outcome, and observer list. |
| typed outcome | `semantic_outcome` + `outcome_reason` | Terminal close must include machine-readable outcome. |
| stalled | lease expiration / recovery planner | Stalled work is recovered by deterministic policy, not by transcript reading. |
| projection | connector output evidence | Provider output is projection evidence, not authority. |
| audit event | audit event / terminal evidence | Operational mutations must produce durable evidence. |

## 3. State-machine alignment

| Charter baton state | V2 clean core state | Queue compatibility note |
|---|---|---|
| open | conversation open + baton open | May map to `pending` in V1 queue adapter. |
| claimed | claim active + lease active | May map to `received` / `claimed` depending on V1 adapter. |
| in_turn | runtime task running | May map to `in_progress`. |
| replied | terminal evidence with `semantic_outcome=reply` | May map to terminal queue state. |
| handed_off | terminal or transitional handoff evidence | Must not be represented as untyped reclaim only. |
| no_reply_close | terminal evidence with `semantic_outcome=no_reply` | Must include reason. |
| closed | terminal evidence with `semantic_outcome=close` | Must include reason. |
| failed | terminal evidence with `semantic_outcome=fail` | Must include reason and recovery/refusal semantics. |
| stalled | expired lease / recovery required | Must be machine-detectable. |

## 4. `done` collision rule

The word `done` is unsafe unless scoped.

Required rule:

```text
A queue terminal state named `done` must mean terminal completion only.
Terminal `done` requires typed outcome and terminal evidence.
`done` must not mean “turn finished but final outcome unresolved.”
```

If a non-terminal state is needed for a turn that completed execution but has not produced final semantic outcome, use a different name:

```text
turn_complete_pending_outcome
```

or another explicit non-terminal name.

## 5. Unified outcome vocabulary

AUN V2 must not create three competing outcome vocabularies.

Canonical model:

```yaml
semantic_outcome:
  - reply
  - handoff
  - no_reply
  - close
  - fail

outcome_reason:
  - resolved
  - blocked
  - delegated
  - rejected
  - not_applicable
  - failed
  - superseded
  - timeout
  - policy_denied
  - validation_failed
  - runtime_failed
  - connector_failed
```

Meaning:

```text
semantic_outcome:
  charter-level communication meaning

outcome_reason:
  operational or domain reason under the semantic outcome

queue terminal state:
  mechanics-level storage state, not semantic outcome
```

### 5.1 `fail` vs `failed`

`fail` is the semantic outcome.

`failed` is an outcome reason only when the system needs a compatibility or provider-derived reason value.

Preferred explicit reasons for new V2 records:

```text
validation_failed
runtime_failed
connector_failed
policy_denied
timeout
```

If `outcome_reason=failed` appears, it must be treated as legacy or generic failure and should be normalized before enterprise-facing reporting.

## 6. Handoff contract

A handoff is not a plain text mention or untyped queue reclaim.

Minimum typed handoff fields:

```yaml
handoff:
  handoff_id: <id>
  conversation_id: <id>
  from_agent_id: <agent_id>
  to_agent_id: <agent_id>
  reason: <reason>
  expected_semantic_outcome: reply | handoff | no_reply | close | fail
  observer_agent_ids: []
  created_by_claim_id: <claim_id>
  created_at: <timestamp>
```

Handoff transfers baton ownership only after the target claim is accepted or the transfer policy explicitly marks it as delegated.

## 7. Observer is not owner

Hard rule:

```text
Projection recipient != owner.
Observer != owner.
cc != owner.
fyi != owner.
```

A connector may deliver a projection to many agents or humans. Only the active baton owner has response responsibility.

## 8. Shirube governance boundary

AUN must not own Shirube work governance.

```yaml
shirube_owns:
  - work governance
  - Cell lifecycle
  - Design Consolidation Gate
  - Cell Intake Gate
  - canonical gate verdict
  - canonical development Done
  - merge authorization
  - production promotion authority

aun_owns:
  - runtime authorization
  - claim
  - lease
  - fencing
  - runtime binding
  - connector binding
  - delivery/projection evidence
  - operational audit evidence
```

AUN may emit evidence consumed by Shirube gates. AUN must not become a second governance state machine.

## 9. Post-merge evidence sink rule

AUN consumes Shirube evidence, but must not inherit a recursive repo-file post-merge evidence requirement.

```text
Pre-merge evidence:
  repository structured files

Machine gate evidence:
  repository structured file for checked PR head SHA

Post-merge evidence:
  structured GitHub PR/Issue comment, workflow artifact, or check run with durable URL
```

Repository files define schemas, templates, validators, and sink policy. They should not be required to contain final post-merge facts after every merge.

## 10. Reconciliation acceptance criteria

This document is acceptable only if it preserves all of the following:

- charter CORE vocabulary;
- `baton = responsibility`, `claim/lease/fence = mechanics`;
- conversation grouping;
- typed handoff;
- unified outcome vocabulary;
- observer-not-owner invariant;
- `done` collision rule;
- Shirube/AUN ownership boundary;
- post-merge evidence sink dependency.
