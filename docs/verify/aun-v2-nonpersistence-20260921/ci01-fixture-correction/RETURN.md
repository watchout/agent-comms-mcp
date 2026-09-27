# CI-01 historical workflow fixture correction

cell_id: CELL-AUN-940-TRIAL-READY-20260921-003
risk_class: R3
active_function: implementation_executor
TRIAL_READY: false

Control source: https://github.com/watchout/agent-comms-mcp/pull/968#issuecomment-5773161834
Body SHA256: `d96e08ae362935bd5478466578297de5d071961dbc15d44247042bcb9c88eaf8`.
Input head: `aa91e435c5ad858185e27950f9f083e6349d2f69`.

Completion for this slice is the original CI-01 full-byte assertion passing,
all other existing assertions retained, and a returned changed head. NP04 stays
pending arc's published contract; it is outside this corrective slice.

## Choice and implementation

design_judgments: Choose option (a): reverse only four exact, context-bound
declared workflow hunks before the original baseline byte comparison; this
admits the documented aa91 delta while detecting any undeclared edit.

`tests/fixtures/ci01-declared-reproducibility-workflow.json` fixes the complete
before/after bytes of the four diff hunks from 5ee25082 to aa91e435, their
immutable source commits, whole-workflow hashes and current instruction ref.
This fixture data grants no workflow/runtime authority.

Each hunk must match exactly once, including its surrounding context. Only that
match is reversed. The existing test then reverses the original source/full
gate placement and compares **every byte** against its original C17 baseline.
The original 19 assertions, their order and expected values are unchanged.
There is no blanket step removal, pattern-wide allowance or new baseline drawn
from the current working tree.

The added case verifies exact immutable before/after hashes and restoration,
then detects ten undeclared changes: checksum substitution, standalone timeout,
standalone relocation before source admission, artifact substitution, duplicate
delta, missing delta, permissions, runner, full-suite timeout and auto-merge.
Changes outside the declared hunks remain visible to the full-byte comparison.

## Actual validation

| Run | PASS | FAIL | Filtered | Assertions | Duration |
|---|---:|---:|---:|---:|---:|
| Original CI-01 assertion plus new mutation case | 2 | 0 | 45 | 42 | 0.129 s |
| Complete shirube-current-overlay-check.test.ts | 47 | 0 | 0 | 635 | 59.106352 s |

Bun 1.4.2, Node 24.20.0, macOS. These are selected local tests, not a public
full-suite result. The full-file invocation used a private RUNNER_TEMP and no
DB credentials; it did not start PostgreSQL. Its exact command, start/end,
exit, source hashes and raw-log hash are in `full-file.json`. The focused
invocation's raw log/JUnit retains its counts and duration; separate wall-clock
start/end metadata was not captured for that initial focused command.

All 46 prior file cases are retained; one mutation case was added, as verified
against the previous public JUnit (`denominators.json`). Removing only the
new helper/case and undoing the single normalization-input change reconstructs
all previous test code (excluding explanatory comments); this independently
checks that no existing assertions were changed (`preservation.json`).

The workflow, process-start helper, host observer, endpoint resolver, NP04 test
and seat-runtime contract are byte-identical to aa91e435. The source manifest
was unchanged through the full-file invocation. Raw evidence hashes are in
`manifest.json`.

## Remaining and handoff

CI-01 is locally corrected. The old public aa91 run remains **3315 PASS /
2 FAIL / 59 SKIP**, with NP04 and the now-corrected CI-01 failure retained as
history. No old full-suite result qualifies this new head. Public full-suite
repetition is deferred while NP04's contract is pending; push/body-triggered
runs are to be cancelled before tests.

Still required: arc's published NP04 contract, its same-cell implementation,
the six cases individually and globally passing, two public full runs with
zero failures on the repaired head, one maker-external cycle-3 acceptance,
owner exact-head R3 decision, NP12/live application and actual trial.

PR#958: retain without close/merge.
PR#963: retain without close/merge.

next_action: owner_agent=arc; required_function=control_artifact_author;
action=publish the already-routed NP04 ownership-proof contract on issue 940;
delivery=GitHub control_source comment;
input_refs=5773161834 and the suite-lead NP04 referral on issue 940;
scope=existing NP04 contract decision, no implementation/live/provider/merge;
deliverable=published contract with exact acceptance conditions;
completion_evidence=comment URL and body SHA256 for same-cell implementation;
blocking=true after this CI-01 return;
stop_reason=external dependency that this implementation function cannot legally mutate.
