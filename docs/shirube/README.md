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
retains R4 and the frozen bounded-admission design. The current local integration
source admission binds [I2](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5656920748),
raw SHA256 `9eff608923ce62135e63192890dd101c24148e4078b689d3720229bc94f5c676`,
and [normalization OD](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5609700544),
raw SHA256 `59952776f1cfb5093040cb9318641f54721ef4f0f416ee278d1e426e980aef02`.
The exact published JSON fixes 122 paths, C2 `8d38f3bd6a99a2f4615949dd747d708f8b6943d6`
and seat-continuity `81be7f051f85973bb9533e87d3258825082ad158` ancestry, companion
Was `e49abc24838227776dc01be111aeb035ec7c9aad`, and expiry `2026-09-14T03:00:00Z`.
The only admitted workflow path is `.github/workflows/pr-checks.yml`.
I2 permits local source and isolated tests only: zero push, body-edit, manual CI,
Ready, merge or live effects. Source admission does not grant execution authority.
Historical C2 budgets and receipts retain their original subjects and are not renewed.

The PR body uniquely binds CELL-ID, Risk Tier, Workflow Supply,
control_handoff_comment_ref and raw control_handoff_body_sha256. The gate checks
the actual OWNER/watchout issue940 publication, exact raw bytes, canonical I2
object, both donor ancestries, and actual candidate path/tree/binary diff.
An authenticated current-head consumer receipt from `codex-cto/goal_gap`, separate
from maker `codex-cto/runtime_status`, remains mandatory. It binds actual restore
and runtime-adapter evidence plus the current I2 and normalization OD digests.
Stale, missing, duplicate, malformed, foreign or conflicting current-head records
block; removing I2 by its exact comment ID is an explicit negative fixture.

Offline `--comments` and `--control-comments` API-shaped fixtures prove parser and
admission behavior only. They cannot replace the independently published receipt
or authorize remote CI. A later exact remote-effect handoff is still required.
Original source-form tests retain markerless OD5602974560 and marked OD syntax;
the historical predecessor I cannot substitute for I2. The local15/private2/public
CI29 stage partition, all 21 distinct required IDs, clean-candidate private byte
checks, draft handling, non-draft owner decision and merge-method checks remain.
Green CI and source admission do not establish applied real use.

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
