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

PR963's separate product cell `CELL-AUN-940-NARROW-USE-CORRECTION-20260908-001`
is R4, not this adoption cell. Its CI_TEST_SUPPLY_ONLY admission is bounded by
owner #940/5602974560 (raw SHA256
c64781ebc64f72b0191fb32e85cd87c96bcfa26eba56d5582cc8e1679cb3ff73),
the canonical I #940/5604405614, exact B/C0, the published allowed47 paths and
expiry 2026-09-11T00:00:00Z. The only workflow in that supply is
`.github/workflows/pr-checks.yml`; no required check or merge rule is weakened.
The PR body must uniquely bind its real CELL-ID/Risk Tier, Workflow Supply,
control_handoff_comment_ref and raw control_handoff_body_sha256. The unchanged
canonical resolver validates the actual OWNER/watchout publication, not an old
CH001 mirror or a local assertion. Private source is never published by this route.

For every exact candidate, one authenticated OWNER/watchout publication on PR963
with marker `<!-- shirube-v3:ci-consumer-verdict -->` and a single flat scalar
`shirube_consumer_verdict` YAML record must bind independent checker/maker,
base/origin/head/tree/binary diff, handoff/OD digests and actual restore/runtime
consumer evidence. Stale, duplicate, malformed or conflicting current-head records
block. `breaking-change-verified` alone is not evidence or merge authorization.
Offline `--comments` and `--control-comments` API-shaped fixtures test only parsing;
CI authenticates real GitHub GETs with the existing token. Ruby is the existing
canonical YAML resolver prerequisite; unavailable input/dependency blocks.

The delegated event budget is one body edit E1, normal push E2, one verified label
E3, and at most one changed-input corrective push E4, all after independent
consumer readback. Every edited/labeled/synchronize event counts toward at most
four additional Layer0 starts and two new candidate heads. No manual rerun,
unchanged resubmission, extra body/label mutation or cancellation. Old FAIL remains.
Draft status, existing adoption constraints below, non-draft/exact-head owner and
merge-method checks are unchanged. CI admission/green CI is not applied real use.

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
