# Shirube Rapid/Lite Overlay

This repository uses a Shirube Rapid/Lite control-plane overlay.

This overlay is report-only at adoption time. It records machine-readable control state under `.shirube/**` and local guidance under `docs/shirube/**`.

## Authority

LLM output is not authority. GitHub Control source evidence, owner decisions, machine reports, and exact-head evidence are the control inputs.

The source mirror at `.shirube/source-mirrors/control-issue.yaml` is a machine-readable snapshot. It is not a second source of truth.

## Merge Discipline

`BLOCKED` or `would_block=true` means the owner must not merge unless an explicit exact-head pilot exception is recorded.

`PASS_WITH_WARN` requires owner acknowledgement before promotion or enforcement graduation.

## Enforcement State

`report_only` is not the final enforcement state. Graduation to `owner_block`, `ci_hard_block`, or `required_check` requires later owner-approved work.

This overlay does not enable required checks, branch protection, rulesets, CI hard-blocking, production behavior, AUN automation, or external repo mutation.

## Control State Completeness

Full control requires the Control State Completeness gate to pass. A repo with partial metadata must not claim V3 complete, enforced, fully controlled, or required-check protected status.

## Adoption PR Scope

PR963's product cell `CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001`
retains R4 and the [bounded-admission design](../design/aun-bounded-admission.md),
which is subordinate to `docs/SSOT.md`. Current CI source admission binds
[I25](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5713693956),
raw SHA256 `eb8bd44526c94bdb7c8158ed23d48d087ce0e41d3907dc92131031cc715beed8`,
plus [I25-A1](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5713769510),
raw SHA256 `7ff80f50c1d9958c951f6312bc11a6896a699448f20af0656ed9ea12fba715be`,
and [I25-A2](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5713927431),
raw SHA256 `2a46980a2a0781eb7e5adc5a159389d33c7ce928aa9e1e527bf620932e2f0af4`.
The [normalization OD](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5609700544)
remains SHA256 `59952776f1cfb5093040cb9318641f54721ef4f0f416ee278d1e426e980aef02`.
Original127 integration paths and all earlier source/budget history remain fixed;
A1 adds exactly one canonical handoff metadata file; A2 adds exactly seven
current support metadata files, giving135 actual changed paths. C2 `8d38f3bd6a99a2f4615949dd747d708f8b6943d6`, seat-continuity
`81be7f051f85973bb9533e87d3258825082ad158` and Was companion
`e49abc24838227776dc01be111aeb035ec7c9aad` remain pinned. Historical I25 source expiry stays
`2026-09-18T09:00:00Z`. The strict fa94 successor additionally authenticates
[I26](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5726524883),
raw SHA256 `2977acc9b8ad46867a11eb1f52748ad1570764d2ae76ce3477d236f464915c12`,
for the finite effective cap `2026-09-18T13:15:00Z`. Exactly five files may change
in original I26; [I26-A2](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5726585940),
raw SHA256 `05b111c3a5f4929401d177695187890c8431f916879b97d1892b3681e457dd85`,
adds exactly the existing execution-context and repo-spec projections, so the actual
fa94 successor must change exactly7 paths. Every historical raw pin, old5/12-path
meaning and135 cumulative paths remain enforced. The only admitted workflow path is
`.github/workflows/pr-checks.yml`; this correction does not edit workflows.

The PR body uniquely binds CELL-ID, Risk Tier, Workflow Supply,
`ci_supply_handoff_comment_ref` and raw `ci_supply_handoff_body_sha256` to I25.
Unique `ci_supply_window_amendment_ref` and `ci_supply_window_amendment_sha256`
additionally pin I26. Missing or duplicate CI fields fail closed, with no fallback
to canonical fields. The current consumer handoff fields bind I26, not old I25.
Standard `control_handoff_comment_ref` and `control_handoff_body_sha256` identify
the distinct genuine whole-PR canonical workflow handoff. Source admission does
not establish that handoff's validity or any audit/release readiness. The trusted
resolver and external subject producer must consume its actual accepted bytes;
no hand-invented source metadata or external artifact is sufficient.

The source checker authenticates actual OWNER/watchout issue940 publications,
raw bytes, unchanged donor/history bindings, and the actual candidate135 paths,
tree and full-index binary diff. A current-head compatibility receipt from
`codex-cto/recovery_path_author`, separate from current maker
`codex-cto/ci_sequence_plan_gate`, remains mandatory under
[I26-A1](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5726556100),
raw SHA256 `20b3f667f32ae28f8d66acfeb6743583f7e38b6ebe2a17a12c777fec8fce803a`.
Historical maker/checker identities remain immutable. This checker only reviews
the new delta and binds unchanged evidence through its original independent
acceptance; runtime checker is separately unbound. The consumer binds actual
restore/adapter evidence, CI supply I26 and
normalization OD. It is not a full structured audit. Stale, missing, duplicate,
malformed, foreign or conflicting records block.

Offline API-shaped fixtures prove parser/admission behavior only. Current source,
private2 and local17 (15 required cases) need actual same-head evidence. Public CI
has19 required cases; private2 remains separate. Current genuine canonical/full
audit/external-subject and protected review obligations remain pending until
actually verified; report-only reports do not waive them. The base-only Cell scope
projection is separate from historical127 plus the eight explicitly admitted metadata paths.
I25/A1/A2 and I26/I26-A1 authorize no push, GitHub body edit, remote CI, Ready, merge or live effect.
A separately bounded publication is required. Full non-draft owner decision and
merge-method checks remain fatal. Green quality does not establish applied use.

The adoption PR must not mix runtime, API, DB, package, deploy, branch protection, ruleset, or required-check changes.

Allowed adoption paths:

- `.shirube/**`
- `docs/shirube/**`
- `.github/workflows/shirube-rapid-lite-gates-report.yml` only when an approved thin workflow caller slice generated it

Forbidden in the adoption PR:

- `scripts/shirube/**`
- `src/**`
- `app/**`
- `api/**`
- `lib/**`
- `db/**`
- `migrations/**`
- package or lock files
- `.env*`
- deploy or production files
- branch protection, ruleset, or required-check changes


### I26-A3: candidate and tested checkout subjects (2026-09-18)

Published amendment https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5727595761
(raw SHA256 `52d917d96e51c72bd043bfa18e9de25ef43f9e7e40c0467775561532d183e0c2`)
authenticates one direct successor of exact `d982dc2c0284a633b2b1f82d6780b3f77b8e0dd1`
with only the gate, its test, this design document and Shirube README changed.
The original fa94→d982 seven-path history and cumulative135 paths remain fixed.
PR metadata adds unique `ci_supply_correction_amendment_ref` and
`ci_supply_correction_amendment_sha256`; the existing24-field current consumer
binds its handoff reference/digest to A3, retaining authenticated I26/A1/A2 history.
The effective source cap remains 2026-09-18T13:15:00Z; owner/runtime authority is not granted.

Fixtures resolve candidate from the actual PR event and tested commit from HEAD.
CI missing/malformed/wrong-repository events fail closed; no HEAD fallback is allowed.
Local direct checkout and an owned offline merge fixture are separate observations.
A merge checkout must have ordered parents [base,candidate] and the candidate tree.
Neither synthetic event nor fixture consumer is published authority. Historical raw34
control fixtures are retained byte-for-byte and the authenticated A3 is appended.
Direct and merge focused checks and one final merge-form full/private execution
retain original quality thresholds, failure history, counters and owner boundaries.
