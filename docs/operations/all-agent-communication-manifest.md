# Ordinary all-agent communication manifest

This support layer governs the ordinary agent-to-agent/AUN communication lane.
It does not grant or expand Shirube D1 authority. Each target row must state
`protected_d1` as a boolean, but that field is read-back/isolation evidence
only. Protected D1 admission, the exact-five allowlist, receipts, and effects
remain governed by their existing independent policy.

## Safety state

The state-daemon integration is default-off:

```text
STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED=0
```

The bootstrap-safe-defaults command writes that value explicitly. Code and
migration deployment alone therefore performs no queue claim, model run,
provider effect, Discord write, or manifest activation. Production enablement,
manifest publication, canaries, and fleet waves require a separate exact owner
decision and rollout handoff.

When enforcement is enabled in a future authorized rollout, missing gate
wiring or any denial stops ordinary traffic before claim. Protected D1 is
classified first and remains independent.

## Manifest contract

The JSON artifact uses
`schemas/all-agent-communication-manifest-v1.schema.json`. It is closed-world:
unknown or missing top-level/target fields reject the artifact. Targets are
unique by canonical `agent_id`, sorted by RFC 8785-compatible canonical JSON,
and hashed without silently reducing the active registry denominator.

Required identity includes the exact repository, control source, active
function, primary workspace, workspace path, runtime engine, non-secret runtime
profile reference, verified provider identity reference, explicit ordinary
auto-receive flag, explicit D1 isolation flag, and Discord mode.

The target digest is SHA-256 over canonical target bytes. The artifact digest
and owner pin are SHA-256 over canonical manifest bytes excluding the two digest
fields themselves. Admission additionally requires an external trusted owner
decision ref and pinned digest; a self-consistent file is not authority.

Lifecycle is fail-closed:

- lower revision: `MANIFEST_ROLLBACK_REJECTED`
- same revision, different digest: `MANIFEST_EQUIVOCATION`
- higher revision without a new exact owner decision:
  `MANIFEST_OWNER_DECISION_REQUIRED`
- missing/mismatched owner pin: `MANIFEST_UNTRUSTED`
- expired/revoked: deny new ordinary admission
- stored projection mismatch: `PROJECTION_TRUST_MISMATCH`
- missing, additional, ambiguous, or changed target: `TARGET_DRIFT`; overall
  readiness is `NOT_DONE`

## Candidate and persistence workflow

`generateAllAgentCommunicationManifestCandidates` reads the production-enabled
`dev` registry denominator and resolves each seat against one active primary
workspace, one fresh live runtime, a profile revision, verified provider/UI or
AUN gateway evidence, and an explicit Control binding. The caller must supply
both `communication_auto_receive` and `protected_d1` for every seat. Neither is
derived from agent names or D1 allowlists.

Generated rows are evidence, not a published manifest. An unresolved or newly
observed seat stays in `expected_target_count`, produces blockers, and leaves
`target_sha256` null until every row resolves.

The PostgreSQL migration adds only:

- `all_agent_communication_manifest_revisions`
- `all_agent_communication_manifest_targets`
- `all_agent_communication_manifest_projections`

It does not alter queue or Shirube D1 tables. The down migration refuses to
erase non-empty history.

## Future rollout preflight

The restore helper accepts a bounded JSON object through
`--all-agent-manifest-env-json`. Enabling requires all of:

```text
STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED=1
STATE_DAEMON_ALL_AGENT_MANIFEST_ID=<exact-id>
STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION=<positive-integer>
STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST=<sha256>
STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256=<sha256>
STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF=<github-url>
STATE_DAEMON_ALL_AGENT_MANIFEST_PATH=<absolute-durable-file>
```

The helper is dry-run unless `--execute` is supplied, and this implementation
handoff does not authorize `--execute`. Readiness reports the live LaunchAgent
values separately from the protected D1 values and reports the accepted
manifest identity, revision, canonical digest, target digest/count, owner ref,
per-target drift, and explicit D1 isolation state.

## Verification

Focused verification covers strict parsing/canonicalization, owner pin,
revision/equivocation/expiry/revocation, denominator drift, explicit D1
isolation, inventory ambiguity, preclaim zero-effect denial, default-off
compatibility, readiness read-back, installer preflight, disposable PostgreSQL
up/up/down/up, and the unchanged protected D1 regression suite.
