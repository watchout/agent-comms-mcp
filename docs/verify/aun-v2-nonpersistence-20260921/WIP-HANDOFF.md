# AUN D1–D4 implementation WIP — stopped for owner reassignment

Historical packet for `0a262881`. The independent executor resumed under
[5755777052](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755777052)
(body SHA256 `8b135ba67e36071b94c834e02f5b78e9d7c8b298936163c155b33af520c778a4`).
There is **no additional bootstrap commit to wait for**. The current return is
[INDEPENDENT-RETURN.md](INDEPENDENT-RETURN.md); the following measurements remain historical.

State: **implementation incomplete; NOT TRIAL_READY; NP12 NOT_RUN**. This packet saves source and actual failures; it is not independent acceptance or a deployment authorization.

Actual start: 2026-09-21T04:27:17.424702Z. Owner steering stopped new work on 2026-09-21 around 05:18Z, before original deadline 06:27:17.424702Z. No new tests or investigation after stop. Existing native test finished; owned PostgreSQL was stopped normally. No running product/test command remains.

Branch: `codex/aun-v2-nonpersist-design-20260921`.
Worktree: `/Users/yuji/Developer/.worktrees/agent-comms-aun-v2-nonpersist-design-20260921`.
Baseline: `174c04e7db86b5fbc89c4bce08dbe48583c5ffac`.
WIP checkpoints: `307672d47eee320b6e9a82ef2509a0fbad4599b0`, `32e149cb1ffdfd942e2d7231423ae7f372a6ba33`.
DB author commits `982e0fbab76feb7c443e876a812627e8d136e081` / `c8b62c1bf48259902d91b3ddf81e0977242b05c3` are integrated as `54817d23` / `55c3900f`. The old worktree stopped editing bootstrap.ts and bootstrap-adapter-codex.ts at 32e. Correction from the latest handoff: the proposed bootstrap successor performed only a read and produced no code or commit; continue the unfinished bootstrap source already in `0a262881`.

## Implemented slices (not full acceptance)

- Request-local OS observer, pre-exec UUID wrapper, dynamic held endpoint, fresh logical lease joins, publication gate before HTTP business callbacks, DB-time conditional renewal and post-write identity recheck.
- Positive logical serializers for runtime/readiness; original native receipt reread path instead of persisted native snapshot; nested audit/error copies reduced; bypass scope arrays and target constraints preserved.
- Runtime/readiness physical columns nullable with PostgreSQL/SQLite old-writer guards; legacy rows/FKs and logical queue/lease operations preserved in DB author's actual fixtures.
- Partial daemon/status/claim caller migration; cold provider history fallback removed. Documentation records adopted D1–D4 and incomplete application.

## Actual tests — do not add overlapping runs into a PASS denominator

| Evidence | Result / interpretation |
|---|---|
| focused-01 | syntax failure before genuine suite; preserved |
| focused-02 | 8 PASS / 1 FAIL |
| focused-03 | 9 PASS / 0 FAIL at that earlier source |
| focused-04 | 11 PASS / 0 FAIL / 50 assertions; OS/socket, held HTTP and logical bypass projection |
| required-command1-first | 95 PASS / 46 FAIL / 141 tests; original failures retained |
| required-command2-first | 39 PASS / 20 FAIL / 59 tests; includes two invalid private-PG URL setup errors, subsequently corrected URL, not rerun |
| db/run-7 | DB author: 10 PASS / 0 FAIL / 105 assertions with PG17 and SQLite; raw logs and author result retained |
| native-integration01 | 11 PASS / 1 FAIL; native fixture startup timed out |
| native-integration02 | 0 PASS / 1 FAIL; captured actual relocated Node dylib failure |
| native-integration03 | 0 PASS / 1 FAIL; Node symlink fixed fixture startup, actual hook/pipe/receipt progressed; ordinary readiness gate failed `stale_runtime_restore` |

The initial full sink list is an inventory, not a proof that all callers were migrated. No full product PASS, public CI, PR update, merge, runtime application, live DB mutation, queue operation or independent review was performed by this final packet.

## Concrete next work for the independent AUN repo executor

1. Resume from this final saved head under the independent executor handoff. No separate bootstrap return exists. Read current raw failures before changing fixtures; retain old assertions unless the adopted contract makes the old input invalid.
2. Fix `MEMORY_NATIVE_ORDINARY_GATE_FAILED:stale_runtime_restore` on the actual native receipt path (`native-integration03.log`), then measure real native positives and wrong project/start/unavailable original negatives. Original receipt is in Was; AUN copies must remain logical only.
3. Address legal UUID reuse with an old active lease. Malformed UUID rejection and same-time duplicate detection do not prove stale legal UUID rejection. No substitute persisted PID/start snapshot is authorized.
4. Resolve existing physical host-scoped configuration fence/target contract. `AUN_HOST_ID || hostname()` is not an independently defined logical deployment ID. Do not silently hash/rename it or claim current configuration migration complete. Existing new physical observed-state/restart inserts are deliberately rejected by DB guard.
5. Finish remaining CLI/profile/receive/lifecycle writers and runtime-inventory/status readers. Guard rejection alone does not make their normal paths work. Preserve provider-free deterministic S0 and owner text; do not blanket-ban all logical runtime/status/fence metadata.
6. Queue claim acquisition must bind the freshly observed incarnation and preserve exact claim/fence; current claim heartbeat skips NULL claimed_runtime_instance_id and is not proof that old claim writers are migrated. Check scheduler's workspace/provider observation-to-effect ordering.
7. Complete WB01–08 from fixed-307 review: exact bypass roundtrip at actual gate; legal UUID reuse; expiry/holder replacement during observation/SQL; publication callbacks; cleanup orphan kill-only/PID reuse/unknown work; bootstrap/daemon; typed stored values; native original negatives. Some source fixes are present but unmeasured.
8. Run relevant existing regression suites on the integrated source using owned fixtures. Current FAIL counts above remain unresolved. Finally obtain a maker-separated source/evidence review and later separately authorized NP12 applied acceptance.

DB guard limitation: generic logical metadata recursively rejects known physical keys, but arbitrary renamed scalar encodings are not comprehensively proven; producer projection coverage is required. Optional configuration tables created after migration require guard installation too.

Fixture status: core private PostgreSQL stopped (core-fixture-stop.json); native helper cleanup ran in test finally. Was built candidate was read only. No new development after owner stop.

Historical next_action superseded by 5755777052: the independent AUN repo executor consumes this fixed source and failures directly. No bootstrap-commit wait or subagent continuation.
