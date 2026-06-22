<!-- aun:v2-clean-core-contract/v1 -->

# AUN V2 Clean Core Contract

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: AUN V2 clean core contract  
Implementation allowed from this document: false

## 1. Purpose

This document defines the AUN V2 core without depending on V1 queue-work, state-daemon, Discord, tmux, or GitHub writeback terminology.

V1 systems may be integrated through adapters, but they must not define V2 core semantics.

## 2. Core model

```text
Agent
  owns identity

Conversation
  groups work

Baton
  defines response responsibility

Claim
  makes baton execution exclusive and recoverable

Runtime Task
  runs work under a claim

Typed Outcome
  states semantic result

Terminal Evidence
  closes work with proof

Audit Event
  records operational mutation and evidence
```

## 3. Agent

```yaml
agent:
  agent_id: string
  agent_uri: string
  profile_ref: string
  enabled: boolean
  identity_attestation_ref: string | null
```

Rules:

- `agent_id` is logical identity.
- Runtime engine, provider identity, connector, token, workspace, and process are not identity.
- One agent may have multiple runtime instances over time.
- One agent may have multiple connector bindings.

## 4. Conversation

```yaml
conversation:
  conversation_id: string
  root_message_id: string
  state: open | closing | closed | failed
  active_baton_id: string | null
  created_at: string
  closed_at: string | null
```

Rules:

- All turns, handoffs, claims, outcomes, and projections must be traceable to a conversation.
- A conversation may have at most one active baton owner unless an explicit multi-owner policy exists.
- Conversation state is semantic, not provider-thread state.

## 5. Baton

```yaml
baton:
  baton_id: string
  conversation_id: string
  owner_agent_id: string
  observer_agent_ids: string[]
  state: open | claimed | in_turn | handed_off | closed | failed
  created_at: string
  updated_at: string
```

Rules:

- Baton is response responsibility.
- Baton ownership may change only through typed handoff or terminal close.
- Observer list is projection-only and never creates ownership.

## 6. Claim

```yaml
claim:
  claim_id: string
  baton_id: string
  owner_agent_id: string
  owner_runtime_instance_id: string
  claim_source: string
  claimed_at: string
  lease_expires_at: string
  fencing_token: string
  state: active | released | expired | superseded | terminal
```

Rules:

- Claim is the exclusive execution mechanism for a baton.
- Claim must have a lease expiration.
- Claim must have a fencing token or equivalent stale-holder protection.
- Terminal close must prove that the closer holds a valid claim or authorized recovery role.

## 7. Runtime task

```yaml
runtime_task:
  task_id: string
  claim_id: string
  runtime_adapter_id: string
  input_ref: string
  result_ref: string | null
  state: planned | running | result_ready | failed | cancelled
  started_at: string | null
  finished_at: string | null
  usage_ref: string | null
```

Rules:

- Runtime task is execution evidence, not semantic outcome.
- A runtime may fail without closing the conversation.
- Runtime result must be validated before terminal evidence is written.

## 8. Typed outcome

```yaml
typed_outcome:
  semantic_outcome: reply | handoff | no_reply | close | fail
  outcome_reason: string
  reply_ref: string | null
  handoff_ref: string | null
  close_ref: string | null
```

Rules:

- `semantic_outcome` is the canonical communication outcome.
- `outcome_reason` is an operational/domain subtype.
- Queue terminal state is storage mechanics, not outcome semantics.
- `done` alone is never sufficient.

## 9. Terminal evidence

```yaml
terminal_evidence:
  evidence_id: string
  conversation_id: string
  baton_id: string
  claim_id: string
  task_id: string | null
  terminal_state: done | failed | skipped | expired | superseded
  typed_outcome:
    semantic_outcome: reply | handoff | no_reply | close | fail
    outcome_reason: string
  artifact_refs: string[]
  projection_refs: string[]
  post_merge_evidence_url: string | null
  created_at: string
```

Rules:

- Terminal evidence is the authority for completion.
- Provider output is a projection ref, not terminal authority.
- Post-merge evidence may be a structured GitHub-native sink URL.

## 10. Audit event

```yaml
audit_event:
  audit_event_id: string
  actor_type: human | agent | runtime | connector | system
  actor_id: string
  action: string
  subject_type: string
  subject_id: string
  evidence_refs: string[]
  prev_hash: string | null
  event_hash: string | null
  cost_ref: string | null
  redaction_ref: string | null
  attestation_ref: string | null
  created_at: string
```

Rules:

- Every operational mutation must have an audit event.
- V2 reserves tamper-evidence fields now, even if hash chaining is not implemented in MVP.
- V2 reserves cost, DLP/redaction, and identity attestation fields now.

## 11. Minimal V2 command surface

Initial V2 commands should be script-friendly and JSON-only.

```bash
aun v2 plan --agent-id <id> --conversation-id <id> --json

aun v2 claim --agent-id <id> --conversation-id <id> --baton-id <id> --dry-run --json

aun v2 execute --claim-id <id> --fencing-token <token> --json

aun v2 finalize --claim-id <id> --fencing-token <token> --result-file <path> --json

aun v2 recover-plan --conversation-id <id> --json
```

V1 compatibility commands may exist, but the clean core contract should not be named after V1 queue-work states.

## 12. Required validators

Before live implementation, create deterministic validators for:

- schema shape;
- `agent_id` identity rules;
- observer-not-owner;
- one active baton per conversation;
- claim lease/fencing required;
- terminal evidence requires typed outcome;
- post-merge evidence URL shape;
- audit event envelope;
- V1 adapter output mapping.

## 13. MVP non-goals

AUN V2 clean core MVP does not implement:

- hosted multi-tenant control plane;
- full OAuth/OIDC enforcement;
- remote worker federation;
- complete V1 removal;
- complete Discord removal;
- production activation;
- full web UI;
- cross-region HA.

It must remain compatible with those future directions without identity or evidence model rewrites.
