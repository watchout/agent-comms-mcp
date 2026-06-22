<!-- aun:v2-enterprise-adoption-gate/v1 -->

# AUN V2 Enterprise Adoption Gate

Date: 2026-06-22  
Status: PR-001 design consolidation draft  
Scope: enterprise-readiness criteria for AUN V2  
Implementation allowed from this document: false

## 1. Purpose

AUN V2 should be credible to large technology organizations as an agent operations mesh / durable agent control plane.

This gate converts that ambition into concrete checks.

## 2. Gate verdicts

```text
PASS:
  ready for implementation or adoption review

WARN:
  acceptable for MVP if reservation exists and migration path is documented

BLOCK:
  must not proceed as V2 core
```

## 3. Enterprise adoption checklist

| Area | Required condition | Verdict |
|---|---|---|
| Identity | `agent_id` survives runtime, provider, workspace, and connector replacement | BLOCK if missing |
| Runtime portability | Codex, Claude Code, command-json, and future remote workers fit one runtime contract | BLOCK if runtime-specific semantics leak into core |
| Connector portability | Discord, GitHub, Slack, Teams, and future UI are projections/connectors | BLOCK if provider output is authority |
| Security | raw secrets are not emitted in diagnostics or ordinary evidence records | BLOCK if raw token can leak |
| Secret handling | secret reference + non-secret fingerprint exist or are reserved | BLOCK if token identity is ambiguous |
| Audit | who/what/why/when/outcome can be reconstructed | BLOCK if completion relies on transcript reading |
| Tamper evidence | hash-chain or external append-only export is reserved | WARN if not implemented, BLOCK if impossible |
| DLP | redaction / classification / egress policy hook is reserved | WARN if not implemented, BLOCK if impossible |
| FinOps | cost / quota / runtime usage attribution is reserved | WARN if not implemented, BLOCK if impossible |
| Identity attestation | runtime / workload / provider subject attestation is reserved | WARN if not implemented, BLOCK if impossible |
| Recovery | stale claim / orphan / retry / quarantine are machine-decidable | BLOCK if manual Discord/tmux inspection is required |
| Governance boundary | Shirube owns work governance; AUN owns runtime authorization | BLOCK if AUN owns merge/Done/production |
| Evidence sink | post-merge evidence can be a GitHub-native structured URL | BLOCK if follow-up repo-file PR is mandatory |
| Migration | V1 compatibility is isolated through adapters | BLOCK if V1 types define V2 core |
| Local-first | SQLite/local operation remains viable | WARN if only Postgres, BLOCK if enterprise infra is required for MVP |
| Standards path | OAuth/OIDC, OTel, remote workers, RBAC can be added without identity rewrite | WARN if reserved, BLOCK if incompatible |

## 4. Required enterprise reservations

AUN V2 MVP does not need to implement everything, but must reserve these fields/concepts now.

### 4.1 FinOps

Reserve:

```yaml
cost_ref:
  runtime_id: string | null
  model_id: string | null
  token_input: number | null
  token_output: number | null
  wall_clock_ms: number | null
  estimated_cost_usd: number | null
  quota_policy_ref: string | null
```

### 4.2 Tamper evidence

Reserve:

```yaml
tamper_evidence:
  prev_hash: string | null
  event_hash: string | null
  signer_ref: string | null
  external_ledger_ref: string | null
```

### 4.3 DLP / redaction

Reserve:

```yaml
dlp:
  classification: public | internal | confidential | restricted | unknown
  redaction_status: none | redacted | blocked | pending
  egress_policy_ref: string | null
  denial_reason: string | null
```

### 4.4 Identity attestation

Reserve:

```yaml
identity_attestation:
  attestation_type: local_process | workload_identity | oidc_subject | key_fingerprint | provider_subject
  subject: string
  issuer: string | null
  verified_at: string | null
  trust_level: unverified | local | verified | enterprise
```

## 5. Enterprise anti-patterns

V2 must block these patterns:

- provider token equals agent identity;
- tmux pane equals runtime authority;
- Discord message equals completion;
- GitHub comment equals Done without terminal evidence;
- post-merge evidence requires recursive follow-up PRs;
- queue status alone equals ownership;
- untyped `done` closes work;
- observer delivery transfers responsibility;
- LLM prose approves a protected mutation;
- AUN decides Shirube Cell Done, merge, or production promotion.

## 6. Evaluation process

Before V2 implementation expands beyond read-only planning:

```text
1. Run V2 design review against this gate.
2. Mark each row PASS / WARN / BLOCK.
3. Add WARN reservations to decision backlog.
4. Stop on any BLOCK.
5. Only allow runtime-v2 expansion after all core rows are PASS or accepted WARN.
```

## 7. MVP target verdict

The acceptable MVP target is:

```text
Identity: PASS
Runtime portability: PASS
Connector portability: PASS
Security: PASS
Audit: PASS
Recovery: PASS
Governance boundary: PASS
Evidence sink: PASS
Migration: PASS
Local-first: PASS
FinOps / tamper / DLP / attestation: WARN with explicit reservations
```

Anything weaker is not enterprise-ready.
