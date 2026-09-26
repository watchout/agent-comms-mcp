D-OWN-1 public-regression correction, CELL-AUN-940-TRIAL-READY-20260921-003 / R3.

Continues the same implementation handoff and arc contract pinned in the preceding down1-ownership-contract packet. Parent subject 9ae613946cbc7b560bc0e9a2504a520fedaebc03 / tree fc2d0a6394aeddac6a4ebff75bcabbd7c9f2fe44. This correction changes five test/helper files only; product, spec, migration, workflow and existing evidence are unchanged.

| Public run | PASS | FAIL | SKIP | Tests | Bun / JUnit assertions | Seconds |
|---|---:|---:|---:|---:|---|---:|
| 35707219725 | 3315 | 8 | 59 | 3382 | 18423 / 18422 | 1306.023453548 |
| 35707224775 | 3316 | 7 | 59 | 3382 | 18426 / 18425 | 1439.794796786 |

Both ran 362 files. Both tested merge trees match the submitted tree and complete binary-diff digest. The six requested standalone cases each pass and also pass in full, including the revised NP04 startup rejection and all five preexisting positives. Old 59 SKIP names/multiplicity match exactly, original full-case multiset is retained with the two published D-OWN-1 name mappings, and all original 166 (=142+24) and 59 primary regression names pass in both full runs. Neither full is green.

Seven failures are common: one port fixture still expected acquired_at to reject ownership; six pure-function tests imported server.ts and therefore now reached its required startup acquisition barrier instead of running the parser. The port predicate now follows D-OWN-1 (time alone cannot change ownership), retaining the case and assertion count. The parser tests execute the exact exported function source in subprocesses; function code/location and every original assertion remain unchanged, without importing runtime side effects.

The extra first-run failure was `outbox lock wait beyond lease expiry supersedes zero rows`: observed waits=0, expected=1. Competing hypotheses were expiry before the contender reaches the lock versus a transaction-local pg_stat_activity snapshot hiding a later wait. The owned-PG measurement deliberately primes the lock holder's snapshot before the contender, then polls from a separate autocommit connection: before=0, cached=0, fresh=1, pending_settled=false. This demonstrates the stale-observation defect; it does not claim that the historical failure log alone excludes pre-lock expiry. The fixture now uses a warmed independent observer, a 5-second lease instead of 250ms to keep initial acquisition separate from the expiry-under-lock assertion, and database-clock confirmation of expiry before releasing the held outbox row. Every original waits=1 / settled=false / returned0 / updatedRows0 assertion remains; database-confirmed expiry is added. The original 2-second wait-observation deadline and 30-second test timeout are unchanged. Product lease/expiry checks are unchanged.

New NP04 fixture reports are published by atomic rename, and the actual-server fixture waits for stream close before checking its stderr. These remove partial report/output observations without delaying the UUID replay or changing its criterion.

Local v06-public-corrections: 35 PASS / 0 FAIL / 274 assertions, 33.465082 seconds (exact JUnit/metadata in archive). It includes all eight first-run failures, all fourteen NP04 authority cases and related port/outbox cases. All source-before/after hashes match and the submitted manifest has 798 source files.

Also retained: source-admission-only failures 35706911752 (push event held old PR-body HEAD) and 35706941177 (PR-body required-field omission); both had zero standalone/full test starts. The corrected body passed local source admission before the two full runs above. Complete raw log/JUnit/subjects/versions/job metadata and both failed full verifications are archived with member hashes. The verifier's final nonzero exit is the intended full-zero-failure assertion, after identity, six-case and denominator checks passed.

Next required verification is two full executions of the corrected immutable subject, followed by maker-external cycle3 and owner exact-head R3 disposition. Trial readiness remains false; NP12/live trial remains unperformed. No additional agents, live/shared DB/provider/queue, owner labels, approval or merge effects.
next_action: none (continue the authorized corrected-input public verification).
