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
`e49abc24838227776dc01be111aeb035ec7c9aad` remain pinned. Source expiry stays
`2026-09-18T09:00:00Z`. The only admitted workflow path is
`.github/workflows/pr-checks.yml`; this correction does not edit workflows.

The PR body uniquely binds CELL-ID, Risk Tier, Workflow Supply,
`ci_supply_handoff_comment_ref` and raw `ci_supply_handoff_body_sha256` to I25.
Missing or duplicate CI fields fail closed, with no fallback to canonical fields.
Standard `control_handoff_comment_ref` and `control_handoff_body_sha256` identify
the distinct genuine whole-PR canonical workflow handoff. Source admission does
not establish that handoff's validity or any audit/release readiness. The trusted
resolver and external subject producer must consume its actual accepted bytes;
no hand-invented source metadata or external artifact is sufficient.

The source checker authenticates actual OWNER/watchout issue940 publications,
raw bytes, unchanged donor/history bindings, and the actual candidate135 paths,
tree and full-index binary diff. A current-head compatibility receipt from
`codex-cto/ci_sequence_plan_gate`, separate from maker `codex-cto/ci_sequence_fix`,
remains mandatory. It binds actual restore/adapter evidence, CI supply I25 and
normalization OD. It is not a full structured audit. Stale, missing, duplicate,
malformed, foreign or conflicting records block.

Offline API-shaped fixtures prove parser/admission behavior only. Current source,
private2 and local17 (15 required cases) need actual same-head evidence. Public CI
has19 required cases; private2 remains separate. Current genuine canonical/full
audit/external-subject and protected review obligations remain pending until
actually verified; report-only reports do not waive them. The base-only Cell scope
projection is separate from historical127 plus the eight explicitly admitted metadata paths.
I25/A1/A2 authorize no push, GitHub body edit, remote CI, Ready, merge or live effect.
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
