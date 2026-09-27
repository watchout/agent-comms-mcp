Exact DB-expiry observation, CELL-AUN-940-TRIAL-READY-20260921-003 / R3.

One fixture changes two SQL lines; every assertion, case, duration and timeout is identical to parent 2a5270af. Product/spec/migration/workflow are unchanged. This corrects the v06 observation before claiming reproducibility.

Evidence review found that the returned expires_at was parsed through the PG driver's JavaScript Date, which loses sub-millisecond precision. An owned-PG, read-only counterexample used expiry 2026-09-22T00:00:00.123456Z and comparison clock .123200Z: the Date is .123Z, comparison through the Date returns true while comparison against the original DB timestamp returns false. This is a deterministic counterexample, not an inferred cause of the earlier public outbox failure.

The fixture now asks `clock_timestamp()>expires_at` on the actual lease row, using lease_id; no expiry timestamp leaves the DB and re-enters the decision. Diagnostic RETURNING casts expiry to TEXT to preserve its original precision. The independent autocommit monitor and expiry-under-held-lock predicate remain unchanged.

Local v07-exact-db-expiry: **5 PASS / 0 FAIL / 63 assertions / 6.211364 seconds**, all five real-PG outbox cases. The lock probe again measured before0 / cached0 / fresh1 / expired_at_release=true / pending_settled=false, followed by superseded0. 798 source hashes match before/after execution and the submitted source manifest. Source, raw logs, JUnit, metadata and the precision counterexample are archived with hashes.

Parent 2a5270af public runs were deliberately cancelled after this finding:

| Run | Six standalone cases | Full state | Full interval UTC | Completed full |
|---|---|---|---|---:|
| 35710379579 | each 1 PASS | cancelled mid-run | 09:27:37–09:34:28 (411s) | 0 |
| 35710382710 | each 1 PASS | cancelled mid-run | 09:27:21–09:34:14 (413s) | 0 |

Both final run states are cancelled. Full JUnit was not produced, so partial log lines are not reported as a complete test denominator or green run. Normal cancel requests were followed by force-cancel while both remained active. Full and standalone job logs, standalone JUnit, subjects/versions and final job metadata are retained. Preparation-only run35710334676 failed source admission because the push event held the old body HEAD; standalone/full starts0. Manual rerun0.

Public full2 on the corrected immutable subject, six-case standalone/full agreement, old skip/case preservation, maker-external cycle3, owner exact-head R3 disposition and NP12 remain pending. Trial readiness is false. No live/shared DB/provider/queue, owner approval/labels/merge or additional agents.
next_action: none (continue corrected-subject public verification).
