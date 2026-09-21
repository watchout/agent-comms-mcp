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

Pending at source submission: changed-head public full-suite result; independent cycle-3 audit; exact-head owner R3 decision; NP12/live application and actual trial evidence. No self-audit, approval or merge.

PR#958: 保持。close/merge/吸収完了宣言をしない。
PR#963: 保持。祖先に含むがclose/mergeをしない。

next_action: owner_agent=suite-lead; active_function=orchestration_controller; action=consume the changed-head public test evidence and route independent cycle-3 acceptance; delivery=#940 and PR#968 with exact input head; input_refs=this return + public run + cycle-3 routing + cycle-2 review; scope=same -003 cell and existing R3 boundaries; deliverable=independent gate result on the corrected head, followed by owner exact-head decision if accepted; completion_evidence=published independent review and owner decision; blocking=true after the authorized corrective source/test return is delivered.
