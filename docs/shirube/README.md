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
C2 resource OD #940/5608052232 (SHA256 ed27e2c82b476fa65feb348b8b48a2e398ea77a1f23a99f47c427abfbdde8d89),
the canonical I #940/5625878781 (SHA256 40b740debe54b55bd5dc1ce0be539939e89a4992a54a9e49983e939bf3036dcc),
exact B/C0/C1 ancestry, the published allowed50 paths and
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

Original OD5602974560 has no HTML marker: after exact API/raw-hash authentication,
its sole JSON block must carry the unique decision_id
`OD-CTO-963-NARROW-CI-UNBLOCK-20260909-001`. No marker is invented.
C2 OD and approval-policy OD5609700544 require their actual unique HTML marker
and JSON decision_id. Policy raw SHA256
59952776f1cfb5093040cb9318641f54721ef4f0f416ee278d1e426e980aef02
delegates scoped correction, not extra budgets or live authority. The predecessor
I is authenticated but its historical47/caps cannot substitute for the new exact
canonical object. The consumer's OD fields bind C2's resource OD; both resource
ODs and separate normalization are authenticated via the I.

Cumulative limits are two candidate heads/two normal pushes/two body edits/one
label application/five additional Layer0 starts. E1–E3 used one candidate/push/body/
label and three starts. After distinct exact-C2 consumer publication, E4 updates
the body once (old C1 run is not C2 proof), then E5 pushes C2 once; label remains
untouched. No manual rerun, cancellation, C3 or additional event. Old FAIL remains.
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
