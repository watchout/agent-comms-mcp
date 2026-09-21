# Independent AUN implementation return — 2026-09-21

**WIP_SAVED; NOT TRIAL_READY; NOT TRIAL_PASSED; NP12 NOT_RUN.**

Owner objective, verbatim: 「DB非保存の食い違いから修正し、チェックリストに沿ってv2.0.0を試運転可能まで進める」

Completion means all AUN2-01 through AUN2-21 acceptance predicates are evidenced against one candidate, independently accepted, and the authorized applied version is observable before Task 1. Measurement is the checklist's ordinary-path, negative and recovery tests plus independent review and applied-version readback. This return is partial implementation evidence; it does not replace those predicates.

## Authority and exact subject

- Executor: `codex-aun`, `implementation_executor`, independent repository seat. No additional agent was started.
- [Independent handoff 5755777052](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755777052), body SHA256 `8b135ba67e36071b94c834e02f5b78e9d7c8b298936163c155b33af520c778a4`. It replaces the old Work-only restriction and confirms no additional bootstrap commit exists.
- [D1–D4 adoption 5755364993](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993), body SHA256 `8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791`.
- [WB01–08 review of 307](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755634848), body SHA256 `815eb171e5f79cf47dc10ef955d78e50c7f1616c011d4014267a54bad561921f`.
- [Checklist 5753716854](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5753716854), body SHA256 `c375849c4a8e50f1624b7f6ab3930bcdfc70213f22bcce42bce583da8ad2f81c`.
- Initial HEAD `0a262881c501b7b5767f9a861f269a2e41d643a1`, tree `dfda76d1b0fd36d6e33bc9437b57e7603602acfd`.
- **Source candidate `7ed0d7f2aa51dc8474a7511fa49e1b8d1b4bb696`**, tree `b5e955bb2afbefa7377f153ee9de2a71cb7a9987`. The final evidence-only commit is identified by the GitHub return. Product source and test files are unchanged by that child commit.
- Branch `codex/aun-v2-nonpersist-design-20260921`; existing dedicated worktree retained. Start 14:23:30 JST; original work boundary 15:27:17 JST. This packet fixes a candidate within that window and leaves further implementation and protected application uncompleted.

The historical [WIP-HANDOFF.md](WIP-HANDOFF.md) remains available with its measurements and its obsolete bootstrap-wait instruction corrected. Earlier PASS counts are not reused for this candidate.

## Changes and distinguishing measurements

1. **Native original receipt.** The initial actual native run failed `stale_runtime_restore`. Possible explanations were a genuinely stale host/native receipt or an incorrectly regenerated completion time. Reading the native original and adapter showed the adapter assigned the current time on every read; the gate's earlier captured time then treated the receipt as future-dated. `seat-context-recovery.ts` now retains `native.delivered_at`. Repeated reads retain the original completion; ordinary gate success and unavailable/pending original, wrong project/start/session and expired/copied evidence negatives are tested. The future-time rejection was retained.
2. **Logical incarnation authority.** A new UUID anchor and its lease are acquired in one transaction. An existing valid UUID cannot be acquired again. Renewal and release require the acquiring process's lease ID/fencing token. `server.ts` retains that receipt, serializes heartbeat calls, and uses a dedicated PostgreSQL client so transaction boundaries do not include unrelated queries. Fresh host identity is checked across DB operations; expiry uses advancing `clock_timestamp()`, including after SQL waits. The actual replacement-process test keeps the old active lease and reuses its valid UUID in another PID/workspace; endpoint, admission and renewal deny it.
3. **Process start precision.** macOS `proc_pidinfo(PROC_PIDTBSDINFO)` supplies fresh microsecond process start times. The local SDK struct size and offsets were compiled and read back: 136 bytes, PID offset 12, start seconds/useconds offsets 120/128. A lease rounded to milliseconds must be provably later than the process start. This closes same-second replay on the tested macOS platform. Other platforms still use the prior process-start observation precision and are not accepted by these measurements.
4. **Publication and cleanup.** Held HTTP sockets deny business callbacks before committed authority and after authority loss. Cleanup now fails on DB/observer uncertainty, binds the whole planned holder to a fresh observation, requires no active/unknown work and no active lease, and rechecks before a single owned-process kill. Orphan kill-only and unproven tmux effects deny. Logical anchors/history remain. Tests kill only synthetic fixture children and retain rows/FKs.
5. **Durable values.** Runtime/readiness projections validate UUIDs, commit/digest shapes and complete logical native proof bindings. Machine source/failure/log identifiers reject raw paths; the new SQLite/PostgreSQL guards cover these allowed scalar columns too. Operator bypass keeps array scopes, nested target, exact action/status/queue constraints and original reason text. The actual gate after storage roundtrip allows the specified queues and rejects others. Arbitrary renamed scalar encodings across every producer are still unproven.
6. **Callers.** CLI heartbeat is a read-only observation rather than a second lease registrant. Managed pre-exec launch sets a new UUID every time and enforces exact agent identity. B5 resolves the actual held endpoint/session and creates ordinary plus sealed logical readiness without physical runtime columns. Daemon eligibility and claim renewal work on NULL physical anchors, preserving the claim and checking the exact selected lease/fence in SQL. Inventory's ordinary report uses fresh observation and retains unknown agents in its denominator. Full server boot, all claim-acquisition writers, configuration and the remaining inventory selectors are not closed.
7. **Regression fixtures.** The B4 deadline test and Codex adapter's positive tuples lacked the newly required workspace/session launch inputs. Supplying those explicit inputs restored their intended normal/rollback test path. No assertions were removed; new mismatched workspace/session negatives retain zero mutation. The prior failing run is kept. The daemon shebang was also restored to line 1, removing the earlier import-time syntax error.

## Actual tests on this source

Every named run has a raw `.log` and command/result `.json` in [independent/](independent/). Recent runs also have SHA256 source manifests. [INDEPENDENT-manifest.json](INDEPENDENT-manifest.json) binds the selected runs to the source candidate and preserves the historical run hashes. Runs overlap; do not sum their PASS counts.

The two primary regression source snapshots omitted the then-untracked `core/process-start-time.ts`; that limitation is explicit in the manifest. The later `integrated-final` snapshot includes it and has no candidate-input mismatch. All other recorded production inputs and each selected run's invoked tests/helpers were compared to the candidate. Do not describe the earlier primary snapshots as complete source manifests.

| Run | Actual result | Scope and limits |
|---|---|---|
| `integrated-final` | **41 PASS / 0 FAIL / 341 assertions**, 9 files, 34.63 s | Real owned PostgreSQL/SQLite, OS processes/listeners, native original transport, B5, claim renewal, cleanup and pre-exec entry. Contains scoped injection at race/error boundaries. |
| `regression1-final` | **85 PASS / 57 FAIL / 419 assertions**, 142 tests | Required heartbeat/seat/endpoint/current/scheduler/queue suite. Physical fixture inserts reject and old observer injection paths fail; scheduler timeouts remain. This is unresolved regression evidence. |
| `regression2-final` | **33 PASS / 26 FAIL / 130 assertions**, 59 tests | Required readiness/native/configuration suites. Old physical fixture inserts and two PostgreSQL desired-state cases fail. Owned PostgreSQL URL is now valid; these are not credited as environment setup errors. |
| `startup-concurrency-corrected` | **47 PASS / 2 FAIL / 438 assertions**, 49 tests | Startup safety, bootstrap state machine, E7, S0. Remaining failures: E7 production `sweepStale` deferral and LLM frozen-set selector. Provider-free S0 tests pass. |
| `codex-adapter-final` | **28 PASS / 0 FAIL / 262 assertions** | Fake provider CLI plus owned filesystem/child-process crash recovery; exact registration, foreign winner preservation, timeout/SIGKILL rollback and mismatch denials. No real account mutation. |
| `syntax` | exit 0 | Bun bundle/syntax check of 30 changed TypeScript files. Not a typecheck or full server startup. Later changes were two successfully executed test files and documentation. |

`git diff --check` passed for source and authored documents. Raw failure logs retain Bun's original whitespace; they are excluded from the whitespace-only check so their bytes and hashes remain unchanged. Tests were not skipped to produce a green result. The full public CI, full typecheck and full repository suite were not run.

Environment: macOS, Bun 1.3.11, owned PostgreSQL 17.9 (Homebrew), Unix socket only (`listen_addresses=''`), test actor `fixture`; private SQLite files. Only the selected migration fixture process received `AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1`. Was candidate source `e49abc24838227776dc01be111aeb035ec7c9aad` was read only, with `release.json` SHA256 `811f8e1fde08da746d02ed750cef584bb29c0f6a4e89da597a20cdfafe982023` verified. Native fixtures use a Node process named `codex`, genuine ancestry/PID/socket/native hook pipe and original Was receipts. They do not prove a real LLM conversation or current live-seat readiness.

The default Node executable became unable to load `libsimdjson.30.dylib` during this window. That raw failure remains in `native-cleanup-proof.log`. Testing an already installed Node 24.20.0 succeeded; only the private test runner PATH changed. No Homebrew/package/system configuration repair was performed. [fixture-stop.json](independent/fixture-stop.json) records owned PostgreSQL shutdown and the bounded fixture-process check.

## WB01–08 disposition

These are maker measurements addressing the old review, not a new independent gate PASS.

| Finding | Concrete source/test evidence | Remaining limit |
|---|---|---|
| WB01 scope preservation | `runtime-durable-data.ts`; integrated bypass storage/gate array + nested-target assertions | Independent acceptance pending |
| WB02 valid UUID replay | `runtime-heartbeat.ts`, endpoint/selector, `process-start-time.ts`; actual old-process stop/new-process valid-UUID replay | macOS measured; other platform precision unresolved |
| WB03 fresh expiry/fence | DB wall clock, dedicated transaction, before/after observations; actual SQL wait/fence mutation tests | Whole server and every caller not executed |
| WB04 held socket | Delayed commit/registration failure/authority-loss callback assertions | Full server ordinary boot not run |
| WB05 cleanup | Real owned kill once; unknown work/DB/start/fence/orphan negatives | No live-seat cleanup authorized or claimed |
| WB06 real callers | Actual B5 + native/SQLite, daemon + PostgreSQL claim renewal, pre-exec child; B4 adapter regression | B3, full dispatch/claim acquisition, remaining readers/writers open |
| WB07 typed durable values | Logical UUID/proof/identifier validators and PG/SQLite scalar guards; original operator text retained | Configuration host-scope and exhaustive renamed-scalar sink closure open |
| WB08 native original | Actual hook/pipe/Was original reread; pending/absent originals and gate negatives | Synthetic provider host; live Codex/Claude applied acceptance absent |

## NP and checklist disposition

`PARTIAL` below describes this maker's coverage, not an alteration of the canonical acceptance state or denominator.

| Predicate | This candidate's evidence | Unclosed acceptance |
|---|---|---|
| NP01 | Typed projections, physical-free DB anchors, positive logical writes and guard negatives | Full startup→configuration→error→stop→restart producer inventory |
| NP02 | Old rows/FKs, logical lease acquisition/renew/release, exact claim renewal, valid UUID replay denial | All claim-acquisition/finalization callers |
| NP03 | Held port-0 callback order and own-socket failure | Ordinary whole-server startup |
| NP04 | Fresh macOS process/start/socket, valid UUID replay, fence/expiry/replacement negatives | All dispatch paths and other platform precision |
| NP05 | No history-based cold fallback; DB unknown does not become empty; provider-free S0 tests | All launchers and actual LLM frozen-set path |
| NP06 | Fresh independent host reader and ordinary inventory report | Frozen set and communication manifest selectors still use legacy physical rows |
| NP07 | Actual original receipt and physical-free proof gate/B5 | Real provider/live-seat application and complete matrix |
| NP08 | DB/observer unknown, shared observation deadline, cleanup/claim denials | Failing scheduler and E7 sweep paths |
| NP09 | Stable desired policy trigger advances once; diagnostic/physical changes excluded in tested cases | Configuration host-scope/restart contract and desired-state regression failures |
| NP10 | Both DBs: legacy/FK digests unchanged, guard negatives, reapply, migration rollback | All ordinary producers and optional-table creation order |
| NP11 | Migration failure recovery, old writer denial, owned-process/B4 recovery | Compatible binary rollback and full configuration restart path |
| NP12 | Candidate source + current maker test hashes | Independent acceptance and authorized applied version: **NOT_RUN** |

| Checklist | Coverage in this return | Readiness status |
|---|---|---|
| AUN2-01 / 02 | Existing queue/task tests included in primary regression | PARTIAL; ordinary receive→invoke→save→reply→completion not accepted |
| AUN2-03 / 04 | Nonpersistence guards, logical writes, retained history/FKs | PARTIAL; full sink inventory open |
| AUN2-05 / 06 / 07 | Held socket, current incarnation and exact lease/claim tests | PARTIAL; whole launch/dispatch/finalize paths open |
| AUN2-08 / 09 | Deadline/unknown/cleanup and bounded child-recovery assertions | PARTIAL; main scheduler failures open |
| AUN2-10 / 11 | Actual native original + same-proof gate/B5 | PARTIAL; applied conversation continuity absent |
| AUN2-12 / 13 | E7 direct scheduling and deferral tests | PARTIAL; production sweep case fails |
| AUN2-14 | Existing isolated startup/child/adapter tests | PARTIAL; complete credential/child boundary acceptance not run |
| AUN2-15 | Fixed candidate, input hashes, actual failures retained | BLOCKED; maker-separated review not run |
| AUN2-16 | Two-backend legacy/migration failure/old writer guards | PARTIAL; full compatible runtime rollback not run |
| AUN2-17 | Entry/pre-exec and B5 isolated success | PARTIAL; B3/configuration scope and external bootstrap open |
| AUN2-18 | Source branch saved | NOT_RUN; v2 distribution/release not performed |
| AUN2-19 / 20 / 21 | Read-only Was source binding and scoped fixture evidence | BLOCKED; operator/checker, applied authority/version/GoalRun absent |
| AUN2-22 / 23 | No real Task 1/2 performed | NOT_RUN; TRIAL_PASSED remains false |

## Concrete remaining implementation

1. **B3/configuration scope:** `bin/aun/bootstrap.ts` still supplies `AUN_HOST_ID || hostname()` to the existing configuration contract. `core/aun-configuration-desired-state.ts` observed-state/restart writers retain physical host-scoped rows and lease predicates; the new guard intentionally rejects them. Define/use the adopted logical deployment authority before migrating these writers and restart receipts. A renamed/hashed observed hostname is not that authority. The normal B0–B8 run cannot be claimed from the B5 fixture.
2. **Caller closure:** migrate `runtime-inventory.ts` frozen-set and communication-manifest readers, remaining profile/receive/lifecycle/launcher writers and NULL-incarnation claim-acquisition paths. Recheck the DB fallback strings still present in bootstrap/adapter command generation; the new explicit-URL check in DB open does not prove every generated caller lacks the old shared default. Preserve the provider-free S0 contract and denominator.
3. **Regressions:** migrate the affected fixtures to logical anchors plus actual/fresh observation, then distinguish any remaining product failures. `regression1-final.log` and `regression2-final.log` retain all failures. Do not globally disable DB guards, delete assertions, substitute direct function stubs for actual effect boundaries, or call all failures fixture-only. The E7 sweep and LLM selector currently have explicit failed tests.
4. **Final acceptance:** after implementation is complete, obtain review from an existing maker-separated independent seat, then the separately authorized exact applied-version acceptance. This executor must not accept its own work. No new subagent, PR/public CI, merge, live DB/runtime/queue or provider mutation is authorized by this return.

Additional measurement limit: lease acquisition times are compared with OS process start times. The owned PostgreSQL and host were on the same machine; cross-machine DB/host clock skew has not been demonstrated safe. Include that condition in the remaining incarnation/expiry acceptance rather than treating the local replay test as its proof.

No shared DB/runtime, other seat, live queue, provider/account, credential, PR, public CI, merge, tag, release or deploy operation was performed. Repository commits/push and the requested #940 result are the delivery surface. Native/DB effects were owned synthetic fixtures only.

`next_action`: owner_agent=`codex-cto`; owner_function=`orchestration_controller`; action=consume this candidate and remaining failures, establish the next bounded independent-repository execution window and resolve the configuration logical deployment-scope input, then route the completed candidate to an existing maker-separated checker; handoff_method=GitHub #940; input_refs=5755777052 with the above body digest, source `7ed0d7f2aa51dc8474a7511fa49e1b8d1b4bb696`, this packet and `INDEPENDENT-manifest.json`; scope=existing source/test/docs scope, no extension to live DB/runtime/queue, provider/account, PR/public CI, merge or additional agents; deliverable=published bounded continuation with the configuration scope and exact candidate, later independent gate and authorized applied evidence; completion_evidence=remaining normal/negative/recovery failures resolved at the fixed source and checklist AUN2-01..21 accepted; blocking=true at the original work boundary; stop_reason=continuation beyond the authorized time window and protected applied surfaces requires a new explicit scope. This packet grants no extension of the original 15:27:17 JST window and requests no generic ACK.
