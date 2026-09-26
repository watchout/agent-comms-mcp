# PR #968 full-suite corrective return

cell_id: CELL-AUN-940-TRIAL-READY-20260921-003
risk_class: R3
maker: independent AUN implementation_executor (no additional subagent)
trial_ready: false
trial_passed: false
NP12: NOT_RUN

## Scope and authority

Objective retained verbatim: **arc の契約待ちに依存しない残りを全部閉じ、契約が決まった時点で「契約の実装 → 再監査」だけが残る状態にする**。

[Corrective handoff](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5761615659), body SHA256 `b0433559dcaac95fa94d3ba78600ef74009f5d5b9b402f28adcb2f86a63730ac`, authorizes the same PR/cell to migrate old fixtures under the guard, repair inventory/queue/daemon regressions, and return a changed head with full-suite evidence. The unchanged failing public head was not rerun.

[Current implementation cell](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757589027), body SHA256 `4923e637e2e2490e5a36f5201ffc35d3565dfb32828f481cab9c95ede3156f5e`, remains the primary cell. The owner transferred execution to this independent seat; no live/shared DB, runtime, queue, provider, credential, release or merge action occurred.

[Cycle-3 routing](https://github.com/watchout/agent-comms-mcp/pull/968#issuecomment-5768672897), body SHA256 `9c55621c662ce4dadc0d366766b8a7679863ecf1a31fbe0330c722b8aab1f3d2`, now explicitly adds F-CFG-OUTBOX-01 to this same maker/cell/PR and authorizes the cycle-3 return.

Completion of this corrective slice is observed through a changed-head public full test run with raw JUnit/logs, the original failure classification, and independent acceptance. Source/test success alone does not establish TRIAL_READY.

## Changes

- Logical identity now reaches ordinary inventory, status, receive, heartbeat/finalizer and queue-repair paths without consulting or updating historical physical columns.
- Bootstrap reads its current native root/session, including clean-host PostgreSQL; workspace enrollment uses a logical ID and rejects a foreign active binding. No stored path supplies current identity.
- The host observer distinguishes the same process's MCP socket from its runtime socket, and proves an unrelated process has exited before ignoring enumeration churn. Other ambiguity remains a refusal.
- Multi-bot HTTP claims use the target holder; shutdown releases only an actually acquired receipt. Enabled mention lookup does not filter on NULL legacy status.
- Watchdog, smoke, memory-ready inventory and self-kick obtain current observations. Sender feedback uses active logical claims and confirmed current absence, with a database-clock expiry check on SQLite and PostgreSQL.
- Fixtures keep the non-persistence guard active, bind runtime identity before exec, and use real owned processes/sockets/native MCP plus isolated databases. Historical migration cases seed before cutover and install the guard before assertions.
- Configuration outbox events now have separate superseded timestamps/current revision references. Supersession keeps delivered_at/attempts unchanged, locks current profile/lease and at most 100 old events, and checks expiry after an aggregate lock barrier. Newest-per-agent selection preserves current-event and periodic-agent progress. The migration is additive/idempotent and its down path refuses to erase supersession history.
- PR963's historical checker contract runs in its own frozen fixture checkout. Current checker policy was not changed.

`changed-paths.txt` is the exact corrective path inventory. `original-448-classification.json` indexes all 448 original failures; their complete texts remain in the archive, distinguishes the original trigger from additional corrections, and links each case to test/shared-source paths. Two original latency failures retain their thresholds; their cause is not inferred from timing alone.

## Evidence and denominators

Original public head `bd99af218050a42891b0d2995970bf77b628548e`: **2768 PASS / 448 FAIL / 59 SKIP**, 3275 reported tests, 13661 assertions. [Run 35606520517](https://github.com/watchout/agent-comms-mcp/actions/runs/35606520517), [job 106354833777](https://github.com/watchout/agent-comms-mcp/actions/runs/35606520517/job/106354833777). Source admission passed; full tests failed. The raw public JUnit and job log are retained under `original-public/` in `repair-evidence.tar.xz`.

Local full measurements: v1 **3069 PASS / 144 FAIL / 59 SKIP / 1 error**, 16527 assertions; v2 **3253 PASS / 20 FAIL / 59 SKIP**, 17901 assertions; v3 **3290 PASS / 3 FAIL / 59 SKIP**, 18153 assertions. V3’s three minimal-schema failures are corrected by sender-behavior-v1 as described below.

All intermediate versions, failures and source manifests are retained in `repair-evidence.tar.xz`; `runs.json` and `RUNS.md` list their raw counts separately. Early local runs were diagnosis, including failures and runs before per-invocation DB isolation. Full-local-v1 used a changing source tree and is not a fixed-source acceptance result. Full-local-v2 and v3 used separate frozen source copies. V3 predates the final SQLite sender-feedback expiry correction; sender-clock-v1 verifies that correction on both backends (8 PASS / 0 FAIL / 25 assertions). V3 also exposed three old minimal-schema sender-feedback cases; sender-behavior-v1 migrates them under the guard and passes 37 cases / 0 failures / 1 existing skip / 131 assertions. The public changed-head run is the final full-source check, including the later cycle-3 outbox correction. Cycle3-final measured 82 PASS / 1 FAIL / 776 assertions; its sole failure compared a randomly UUID-sorted outbox prefix with historical rows. The corrected assertion matches exact historical event IDs and still compares complete preserved rows; bootstrap-history-final reruns that case. Bun's reported test total can increase after a failing beforeAll no longer prevents test enumeration; no original public denominator is silently replaced.

The two primary regression commands retain their original file sets. Baseline 142 cases are all present and pass in the 166-case run (24 added observer cases); baseline 59 cases are all present and pass in the 59-case run. `regression-denominators.json` records the exact-name multiset comparison. These selected suites are separate from public full-suite acceptance.

Local PostgreSQL is owned PG17.9 on private UNIX sockets with no TCP listener. The bounded stage is `local17`; it does not prove PG16 or the separately controlled private stage. Public CI owns PG16 and PG17. Existing 59 skips are reported, not promoted to passes. Harmless fixture executables named codex do not invoke an LLM or use a user's provider account.

## Remaining work and next action

The independent [cycle-2 review](https://github.com/watchout/agent-comms-mcp/pull/968#pullrequestreview-5271747805), body SHA256 `f0c47e2cce5168fc4e6d51da983d33fdc99489fcfb4f7b0aa67c497496d2480d`, remains BLOCK on the old head. Suite-lead subsequently authorized this cycle-3 correction. The new real-PG tests cover 3/101 normal revisions, old-event supersession without false delivery, latest delivery, another due agent, exact desired/holder/runtime/scope/fence/expiry negatives, lock waits past expiry, concurrent idempotency, bounded batches and migration history retention. This is maker evidence, not independent acceptance.

Final cycle-3 boundary evidence: **5 PASS / 0 FAIL / 62 assertions**. The 101-revision probe records current revision 102, original pending 101, superseded 100, current delivered 1, false old deliveries 0, other due progress 1, remaining pending 0. Bootstrap historical-row fix: **1 PASS / 0 FAIL / 16 filtered / 11 assertions**; it is a targeted rerun, not a full-suite result.

Pending at this source submission: the final corrected-head public full-suite result; independent cycle-3 audit; exact-head owner R3 decision; NP12/live application and actual trial evidence. No self-audit, approval or merge.

PR#958: 保持。close/merge/吸収完了宣言をしない。
PR#963: 保持。祖先に含むがclose/mergeをしない。

next_action: owner_agent=suite-lead; active_function=orchestration_controller; action=consume the changed-head public test evidence and route independent cycle-3 acceptance; delivery=#940 and PR#968 with exact input head; input_refs=this return + public run + cycle-3 routing + cycle-2 review; scope=same -003 cell and existing R3 boundaries; deliverable=independent gate result on the corrected head, followed by owner exact-head decision if accepted; completion_evidence=published independent review and owner decision; blocking=true after the authorized corrective source/test return is delivered.

## Public 23-failure follow-up

The first corrected-head public full run, [35667230626](https://github.com/watchout/agent-comms-mcp/actions/runs/35667230626/job/106555582176), tested `038e14cf7b6d01c86a7c9c37fb0a16f455ef06b5`: **3281 PASS / 23 FAIL / 59 SKIP / 3363 tests**, Bun **18159** assertions (JUnit root **18158**), 1045.90 seconds, Bun 1.4.2 on Linux. All raw log/artifact bytes are archived under `public-35667230626/`; `public-23-classification.json` retains every failure and its correction paths. The earlier metadata-triggered run 35666933796 stopped at source admission because this maker omitted three required PR-body headings; corrected metadata passed admission. Duplicate 35666933775 was cancelled, with full tests skipped. There was no manual retry of the failing source.

Corrections after that public run:

- Two UUID-replay negatives exposed a real precision defect: Linux `ps lstart` seconds had been padded into apparent milliseconds. Whole-second observations now keep their precision; authority within that interval is unproven. First acquisition waits at most one second, re-reads the DB clock and the same OS holder before commit; renewal preserves original acquisition time. Real PostgreSQL tests cover the conservative boundary and rollback on holder replacement. Darwin keeps its kernel microsecond observation.
- Sixteen daemon failures came from the fixture business clock beginning before slow real native setup. A 1.5-second delayed startup reproduced `stale_runtime_restore`; moving the fixture clock origin to completed setup makes the actual runner invocation pass. The product receipt-time guard remains enforced.
- NP11's historical fixture explicitly applies the new supersession migration. The existing B3/start/restart/claim recovery assertions now complete again.
- B4 uses a private real HOME so clean-host authority reaches the intended mutation/deadline/recovery assertions.
- B5's aggregate contract exceeded its 30-second test limit. Tuple and incremental-binding checks are separate cases with the same 30-second limit; every rejection remains. The original heartbeat-count threshold of seven remains in the incremental case; the tuple subset additionally requires four. Readback connections close before assertions so a failure does not leak into the next case.
- PG16's ordinary claim/retry fixtures now provide genuine isolated native holders and unique logical seat IDs. The same assertions have two PG17 counterpart tests; their PASS does not replace required PG16 public execution. A self-authored setup message found during this correction was restored to the distinct requester, preserving normal routing behavior.

Latest local Bun 1.4.2 results: primary regression **166/0/843 assertions** and **59/0/308**; authority/NP11/bootstrap **35/0/406**; ordinary PG17 claim/retry **2/0/30**; final native/B5/ordinary set **5/0/84** (52 filtered). These are separate selected runs, never an aggregate full-suite PASS. The diagnostic 85/2/2-error run and all intermediate failures remain in the archive and version table. The new corrected-head public full run and independent cycle-3 acceptance remain required.

Updated design_judgments: coarse OS time is an uncertainty interval, not a precise birth timestamp; an authority grant must follow its conservative end, and replacement before commit aborts the transaction. This implements adopted D1 without saving process time/path/PID/provider. Outbox supersession remains logical terminal history, distinct from delivery/application. No guard, fence, product deadline, or required test is disabled.

## Public four-failure follow-up

[Run 35670508795](https://github.com/watchout/agent-comms-mcp/actions/runs/35670508795/job/106565676010) on `66c973aa4ee6bf823f783b58baae39962e6024e4` measured **3308 PASS / 4 FAIL / 59 SKIP / 3371 tests**, Bun **18309** assertions (JUnit **18308**), 1435.37 seconds. Source admission and native fixture preparation passed; full tests failed, so bounded-stage and current-overlay steps did not execute. The raw artifacts and job log are retained under `public-35670508795/` in the archive. This result is not full-suite readiness.

Two aggregated clean-host cases exceeded 30 seconds. All tuple drifts, incremental release/digest bindings, identity/evidence/expiry/transport refusals and all four native CLI scenarios are retained as smaller separately timed cases. The existing incremental heartbeat threshold of seven remains; no assertion, guard or product/test timeout is removed or relaxed. The live-account-root case's connection was terminated immediately after the preceding timed-out case; cascading cleanup is the hypothesis, to be checked by a full clean-host file execution after partitioning, not treated as established solely from ordering.

The plain S0 fixture independently granted its maintenance lease before the conservative end of a whole-second process-start observation. Its enrolment now waits against the owned DB clock, confirms the same live OS holder, and asserts the actual acquired_at boundary. AC-S0-2 uses a coarse view of the actual OS timestamp on macOS too, so this boundary executes locally. Expiry, fence replacement and actual process replacement still refuse dispatch. This changes fixture setup only; production authority refusal is preserved.

Public corrected-head full execution and independent cycle-3 acceptance are still required. New local measurements, including failures, are in RUNS.md/runs.json; no selected result replaces that requirement.

The first local partition measured **25 PASS / 1 FAIL / 461 assertions**: splitting fixtures also split the old heartbeat counter, so it read five rather than seven. This failed version is retained. The final B5 group shares one actual holder across cases, uses bounded beforeAll/afterAll setup/cleanup, and confirms both bound and unbound normal readback after rejecting a successor digest. The seven-heartbeat assertion remains. All other files still clean up after each case. Whole-file re-execution measured **26 PASS / 0 FAIL / 435 assertions / 105.13 seconds**; setup assertions now execute once on the shared holder, instead of being duplicated for each part. B5 case times were 3.97 / 5.03 / 10.02 / 6.01 seconds and CLI scenario times 6.11 / 6.20 / 3.23 / 2.98 seconds. All retain their 30-second case budget.

Standalone incremental execution initially exposed six rather than seven heartbeats (**0 PASS / 1 FAIL / 22 filtered / 13 assertions**), retained as `public4-incremental-independent`. Adding normal bootstrap re-entry after a rejected successor binding proves the original receipt is reused and removes dependence on preceding cases. Standalone final result: **1 PASS / 0 FAIL / 22 filtered / 15 assertions / 23.20 seconds including setup**. Final unchanged-source whole-file result: **26 PASS / 0 FAIL / 437 assertions / 108.90 seconds**. Public full-suite execution remains the next check; these local results do not declare it passed.
