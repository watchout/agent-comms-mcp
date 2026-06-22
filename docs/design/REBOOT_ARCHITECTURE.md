<!-- aun:v2-clean-rebuild-architecture/v1 -->

# AUN V2 Clean Rebuild Architecture

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: AUN / agent-com V2 clean rebuild architecture  
Parent issue: #794  
Implementation allowed from this document: false

## 1. Verdict

AUN V2 must not be a surface-level refactor of the existing V1 queue-work / state-daemon / Discord / tmux path.

AUN V2 is a clean core with V1 compatibility at the edge.

```text
V2 Clean Core
  -> stable identity, conversation, baton, claim, lease, fence, typed outcome, terminal evidence, audit

V1 Compatibility Edge
  -> message_queue adapter, queue-work adapter, Discord projection adapter, GitHub writeback adapter, state-daemon compatibility adapter
```

The current runtime-v2 implementation is useful as a safety slice, but it is not the final V2 architecture. It still depends on legacy queue-work semantics and should be treated as a migration proof, not the V2 core authority.

## 2. North Star

AUN is a durable agent control plane / agent operations mesh for LLM agents.

AUN must answer from structured evidence:

- who owned a conversation;
- which runtime claimed work;
- which lease and fence allowed execution;
- what input was processed;
- what semantic outcome was produced;
- what terminal evidence closed the work;
- what connector projected the result;
- how stale or failed work can be recovered;
- why an operational mutation was allowed.

Discord, tmux, Codex, Claude Code, GitHub comments, MCP transports, local paths, provider tokens, and workflow artifacts are surfaces, runtimes, connectors, projections, or evidence sinks. They are not AUN identity.

## 3. Architecture rule

AUN V2 uses this boundary:

```text
Core semantics:
  conversation / baton / ownership / typed outcome

Coordination mechanics:
  claim / lease / fencing / runtime binding

Execution mechanics:
  runtime task / adapter invocation / result validation

Projection mechanics:
  Discord / GitHub / Slack / Teams / future UI delivery

Governance boundary:
  Shirube owns work governance.
  AUN owns runtime authorization and operational evidence.
```

AUN must not become a second Shirube governance state machine.

## 4. Shirube V3 execution assumption

AUN V2 implementation is expected to run under `watchout/ai-dev-framework` Shirube V3.

This means AUN V2 does not define its own implementation governance lifecycle. AUN V2 supplies product/runtime/evidence contracts; Shirube V3 supplies the development governance envelope.

```text
Shirube V3 owns:
  - Phase / Cell modeling
  - Design Consolidation Gate
  - Cell Intake Gate
  - Goal Mode handoff
  - Machine Gate
  - Narrow Verification
  - Cell Done
  - Phase Completion Gate
  - merge / release / production authority semantics

AUN V2 owns:
  - runtime authorization contract
  - claim / lease / fence contract
  - connector / projection evidence contract
  - operational audit evidence contract
  - V1 compatibility adapter contract
```

Every AUN V2 implementation PR after PR-001 must be expressible as a Shirube V3 Cell.

AUN V2 PR sequencing is therefore not a separate governance engine. It is an implementation-friendly projection of Shirube V3 Cells.

### 4.1 High-speed implementation mode

AUN V2 should optimize for fast Codex execution, but only inside the Shirube V3 boundaries:

```text
Design Consolidation accepted
-> Cell Intake accepted
-> one small Codex implementation Cell
-> exact-head Machine Gate
-> Narrow Verification
-> merge by release authority
-> structured post-merge evidence sink
```

If Shirube V3 CLI automation is not yet available for a step, the step may be represented by structured repository docs or structured GitHub-native evidence sinks, but the semantics must still match Shirube V3.

## 5. V2 clean core layers

```text
AUN V2 Clean Core
├── Identity Core
│   ├── agent_id
│   ├── agent_uri
│   ├── agent_profile_ref
│   └── identity_attestation_ref
│
├── Conversation Core
│   ├── conversation_id
│   ├── root_message_id
│   ├── active_baton_id
│   └── conversation_state
│
├── Baton / Ownership Core
│   ├── baton_id
│   ├── owner_agent_id
│   ├── observer_agent_ids
│   ├── semantic_state
│   └── handoff_contract
│
├── Claim / Lease Core
│   ├── claim_id
│   ├── owner_runtime_instance_id
│   ├── lease_expires_at
│   ├── fencing_token
│   └── stale_recovery_policy
│
├── Runtime Task Core
│   ├── task_id
│   ├── runtime_adapter_id
│   ├── input_ref
│   ├── result_ref
│   └── usage_ref
│
├── Typed Outcome Core
│   ├── semantic_outcome
│   ├── outcome_reason
│   ├── reply_ref
│   ├── handoff_ref
│   └── close_ref
│
├── Terminal Evidence Core
│   ├── evidence_id
│   ├── terminal_state
│   ├── typed_outcome
│   ├── artifact_refs
│   └── post_merge_evidence_url
│
└── Audit Core
    ├── audit_event_id
    ├── actor
    ├── action
    ├── subject
    ├── prev_hash
    ├── event_hash
    ├── cost_ref
    ├── redaction_ref
    └── attestation_ref
```

## 6. V1 compatibility edge

V1 compatibility is allowed only through explicit adapters.

```text
V1 source                     V2 boundary
-------------------------------------------------------------
message_queue                 Queue compatibility adapter
outbound_queue                Projection compatibility adapter
queue-work runner             Runtime task adapter
finalizeDoneQueueWork         Terminal evidence adapter
Discord message/send path      Connector projection adapter
GitHub comment/writeback       GitHub projection/evidence adapter
state-daemon wake path          Runtime activation compatibility adapter
tmux/session/process evidence  Runtime evidence adapter
```

V1 compatibility must not define V2 core semantics.

## 7. Non-negotiable V2 invariants

1. `agent_id` is logical identity.
2. Runtime identity is not agent identity.
3. Connector identity is not agent identity.
4. Provider output is projection, not authority.
5. Observer / cc / fyi is not owner.
6. Baton responsibility maps to claim + lease + fence.
7. One active baton owner per active conversation unless the handoff contract explicitly changes ownership.
8. Terminal close requires typed outcome and terminal evidence.
9. `done` cannot mean both non-terminal and terminal.
10. Post-merge evidence must not require a follow-up repository-file commit.
11. Shirube owns work governance, Cell Done semantics, merge authority, and production authority.
12. AUN owns runtime authorization, queue claim, lease, fencing, connector binding, projection evidence, and operational audit.
13. AUN implementation progress must be represented as Shirube V3 Cells, not as a separate AUN governance conveyor.

## 8. Required PR-001 documents

PR-001 must include these files:

```text
docs/design/REBOOT_ARCHITECTURE.md
docs/design/REBOOT_CHARTER_RECONCILIATION.md
docs/design/V2_CLEAN_CORE_CONTRACT.md
docs/design/V2_DELETION_MAP.md
docs/design/V2_CODEX_BUILD_PLAN.md
docs/design/V2_ENTERPRISE_ADOPTION_GATE.md
docs/decision-backlog.md
```

No runtime behavior changes are allowed in PR-001.

## 9. V2 implementation gate

V2 implementation is blocked until the following are true:

- charter reconciliation exists as repository docs, not only issue comments;
- V2 clean core contract exists;
- V1 deletion map exists;
- Codex build plan exists;
- enterprise adoption gate exists;
- Shirube V3 execution assumption is recorded;
- Shirube post-merge evidence sink dependency is recorded;
- outcome vocabulary is unified;
- AUN/Shirube governance boundary is explicit.

## 10. First implementation direction after PR-001

After PR-001 is accepted, implementation must start with read-only and schema-only Shirube V3 Cells:

```text
Cell AUN-V2-002: V2 schemas and fixture examples
Cell AUN-V2-003: V2 contract validator, no DB mutation
Cell AUN-V2-004: V1 message_queue -> V2 input adapter, read-only
Cell AUN-V2-005: V2 planner output for one synthetic queue row
Cell AUN-V2-006: V2 claim simulation using test fixture only
```

No live runtime expansion is allowed before the V2 core contract passes the enterprise adoption gate and the corresponding Shirube V3 Cell Intake Gate.
