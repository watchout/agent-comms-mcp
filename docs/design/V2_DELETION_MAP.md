<!-- aun:v2-deletion-map/v1 -->

# AUN V2 Deletion Map

Date: 2026-06-22
Status: PR-001 design consolidation draft
Scope: remove or isolate V1 concepts from AUN V2
Implementation allowed from this document: false

## 1. Purpose

AUN V2 must not carry V1 complexity into the clean core.

This document identifies V1 concepts that must be deleted, renamed, isolated, or downgraded to adapter/projection/evidence status.

## 2. Rule

V1 compatibility is allowed only at the edge.

```text
V1 concept may feed V2 through an adapter.
V1 concept must not define V2 core semantics.
```

## 3. Deletion / isolation table

| V1 concept | V2 action | Reason | Replacement |
|---|---|---|---|
| tmux session as authority | downgrade to runtime evidence | tmux is not identity or ownership | runtime_instance + supervisor_evidence |
| local path as authority | downgrade to profile/evidence | path can drift or move | agent_profile_ref + workspace evidence |
| Discord bot/user id as identity | downgrade to provider identity | provider-scoped, not logical identity | agent_id + provider_identity binding |
| raw Discord token in diagnostics | delete | enterprise security blocker | secret_ref + token_fingerprint |
| provider message as completion authority | delete | projection can fail or duplicate | terminal_evidence |
| queue status as sole ownership | replace | insufficient for recovery | claim + lease + fencing_token |
| untyped `done` | replace | semantic collision | terminal evidence + typed_outcome |
| plain text handoff | replace | loses responsibility semantics | typed handoff contract |
| observer delivery as owner | delete | cc/fyi must not transfer responsibility | observer-not-owner invariant |
| state-daemon hardcoded startup lists | replace | operational drift | DB policy / runtime eligibility planner |
| per-agent env drift | replace | unreviewable configuration | agent profile + derived runtime/connector evidence |
| broad queue cleanup | replace | destructive and unauditable | stale recovery planner + exact fence |
| GitHub comment as terminal Done | downgrade | provider projection only | terminal evidence + post-merge structured URL |
| repo-file post-merge evidence per merge | delete | evidence recursion | GitHub-native structured sink URL |
| LLM prose as gate verdict | delete | not machine-decidable | Shirube gate record / structured evidence |
| V1 queue-work result as core result | isolate | adapter-specific | V2 runtime_task_result contract |
| legacy `received` meaning claim | isolate | naming drift | V2 claim state |
| legacy `in_progress` meaning turn | isolate | storage mechanics | V2 runtime_task state |
| legacy `skipped` semantic ambiguity | normalize | could mean no_reply, policy denial, or projection skip | typed outcome + reason |

## 4. Rename map

| Old term | New V2 term | Notes |
|---|---|---|
| bot | agent | `bot` may remain provider/UI wording only. |
| Discord owner | connector owner | Must not become agent identity. |
| queue work | runtime task | Queue is storage/transport, not semantic work. |
| done | terminal evidence with typed outcome | `done` alone is invalid. |
| wake | runtime activation request | Wake is not execution authority. |
| send reply | projection or reply outcome | Sending is projection; reply outcome is semantic. |
| final reply | terminal evidence with `semantic_outcome=reply` | Requires artifact/projection refs. |
| no reply | `semantic_outcome=no_reply` | Requires explicit reason. |

## 5. V1 adapters that may remain

Allowed compatibility adapters:

```text
message_queue_to_v2_input_adapter
queue_work_result_to_v2_runtime_result_adapter
outbound_queue_to_projection_adapter
discord_event_to_v2_message_adapter
github_writeback_to_projection_ref_adapter
state_daemon_runtime_evidence_adapter
tmux_supervisor_evidence_adapter
```

Each adapter must have:

- input schema;
- output schema;
- lossiness notes;
- invariant tests;
- non-authority statement;
- deprecation path.

## 6. Deletion phases

### Phase D0: Document only

- Define this deletion map.
- No code changes.

### Phase D1: Adapter names

- Introduce V2 adapter names and tests.
- Keep V1 behavior.

### Phase D2: Read-only projection

- Produce V2-shaped read-only records from V1 data.
- No mutation.

### Phase D3: Synthetic V2 execution

- Use fixtures only.
- No live DB mutation.

### Phase D4: One-agent canary

- Single allowlisted agent.
- Exact fence required.
- Rollback plan required.

### Phase D5: V1 edge shrink

- Remove direct V1 semantics from core paths.
- Preserve compatibility through adapters.

## 7. Stop conditions

Stop and return to design if:

- V2 core imports V1 queue-work types directly as canonical types;
- runtime task completion can close work without typed outcome;
- observer projection can create ownership;
- GitHub/Discord projection is treated as completion authority;
- post-merge evidence requires follow-up repo-file commits;
- Shirube gate verdict is produced by AUN runtime code.

## 8. Codex implementation warning

Codex may modify V1 files only when the PR explicitly declares the V1 compatibility boundary.

Every Codex PR touching V1 compatibility must include:

```text
V1 compatibility boundary:
  source:
  adapter:
  V2 output:
  invariants:
  deletion path:
```
