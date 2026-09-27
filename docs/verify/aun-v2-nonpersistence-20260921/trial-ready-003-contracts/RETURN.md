# -003 contracts RETURN — implementation TRIAL_READY

**TRIAL_READY=true（実装席本人判定）/ TRIAL_PASSED=false。** D-CFG-1 / D-S0-1を実装し、AC8件の正負例、NP11の単一compatible releaseによるB3→start→restart→claim復旧を閉じた。最終source/test HEAD **`4a69acd4351f99738389882a58644800a682d176`**、主回帰142/142・59/59、起動49/49、configuration41/41、隔離統合104/104、全FAIL 0。独立cycle 2へ返却する。

- cell_id: `CELL-AUN-940-TRIAL-READY-20260921-003`
- risk_class: `R3`; active_function: `implementation_executor`; additional_subagents: `0`
- goal（owner原文）: arc の契約待ちに依存しない残りを全部閉じ、契約が決まった時点で「契約の実装 → 再監査」だけが残る状態にする
- control_source_ref: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757589027 / SHA256 `4923e637e2e2490e5a36f5201ffc35d3565dfb32828f481cab9c95ede3156f5e`
- current handoff: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759655462 / SHA256 `ede285301f047e43d77b15cceb767dd786b4be2a51a2cdc0782bba51f6afe256`
- arc contract: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759277196 / SHA256 `01f2259457e1b5c605a500c1db474bcaf374d5d9f0ab48a4e57192914e01a82b`
- D1–D4: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993 / SHA256 `8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791`
- 最終PR headはsource HEADに本証拠だけを加えたcommit。PR本文/#940返却にfull SHAを記載する。全最終runは同一source 728 filesのGit blob SHA256を照合済み。

## 修正済み一覧

| 指定対象 | 修正とtest |
|---|---|
| writer / profile doctor / launcher / lifecycle | 通常writerを論理値へ移行済み。B3も旧physical flagsを渡さず、既存/新規profileの論理releaseをhandoff。`test_runtime_nonpersist_profile`、`test_runtime_nonpersist_entrypoint`、`test_runtime_nonpersist_server_lifecycle`。 |
| claim取得→refresh | `test_runtime_nonpersist_claim_cycle`: 通常receiveで成功5件、refresh→done→finalizeを接続。SQLite通常adapterも通過。 |
| finalizeとruntime交代 | 同test: replacement拒否3件、claim競合拒否1件。旧claimを新UUIDで実行・完了できない。 |
| configuration | hostをscope/candidateから除去、observed INSERT禁止維持。完了は既存outboxとlogical audit。restartはlogical field限定、rollback release commit/tree、同一key収束。 |
| provider-free S0 | 非worker maintenance leaseのlogical markerとfresh OS process/socket、durable buildを照合。旧runtime physical列・LLM ancestryを読まず、欠落時dispatch0。 |
| NP11 | `test_runtime_nonpersist_server_lifecycle`: 同一source releaseでB3 1、B3冪等1、実起動2、停止2、再起動1、未完claim回収/再取得1、READY 1、冪等READY2、停止後READY拒否1、論理B3 rollback1。 |
| 旧47 FAIL | 前回[FAIL-CLOSURE](../trial-ready-003/FAIL-CLOSURE.md)の目的を維持し、主回帰分母142/59を変更せず最終再実測。 |

## AC正負例

| AC | 正例・負例 | exact test / raw |
|---|---|---|
| AC-CFG-1 | hostname/host_idなし・agent scope／host指定拒否 | `AC-CFG-1 fresh hostname stays outside candidate, logical scopes and durable records; supplied host is rejected` ([raw L152](integrated-final.log#L152)) |
| AC-CFG-2 | 通常apply 1→fresh readback 2→outbox完了1／期限切れleaseはaudit・deliveryとも拒否 | `AC-CFG-2 ordinary reconcile delivers existing outbox with logical audit and no observation sink; stale fence cannot deliver` ([raw L155](integrated-final.log#L155)) |
| AC-CFG-3 | B3→実server→READY 1・idempotent 2／停止後READY拒否。observed表を専用DBで除去して依存0を検証 | `NP11/AC-CFG-3 compatible B3 profile → managed start → fresh READY/idempotent READY → restart and claim recovery with no physical writes` ([raw L75](integrated-final.log#L75)) |
| AC-CFG-4 | 論理request INSERT・認証済CTO claim 1／物理field 4・ownerなし・rollback不一致・再実行・期限切れ拒否 | `AC-CFG-4 logical restart insert and authenticated one-shot execution pass; physical fields, ownerless and expired execution fail` ([raw L158](integrated-final.log#L158)) |
| AC-CFG-5 | 同一logical key 2要求→1行／異holder・fence不一致拒否 | `AC-CFG-5 duplicate logical restart requests converge; a stale holder cannot create another request` ([raw L161](integrated-final.log#L161)) |
| AC-S0-1 | 実Bun seat 2のlease/OS/build照合／build不一致拒否、旧物理列のquery 0 | `AC-S0-1 native selection uses logical build + lease + real socket; physical history is never queried` ([raw L126](integrated-final.log#L126)) |
| AC-S0-2 | 通常admission 1／失効・fence差替え・実process交代の各拒否、拒否後dispatch追加0 | `AC-S0-2 expire, changed fence and actual replacement deny S0 dispatch with no history fallback` ([raw L129](integrated-final.log#L129)) |
| AC-S0-3 | provider-free plain Bunで成立／marker欠落はABSENT、provider名の捏造0 | `AC-S0-3 plain Bun needs no provider identity; missing logical marker never invents one` ([raw L132](integrated-final.log#L132)) |

追加DB試験2件はPostgreSQL/SQLiteの旧request履歴保持、logical key重複時の原子的migration拒否、物理再書込拒否を測定。[旧migration試験の移行](config-final.log)では偽署名・wrong active_function・replay期限・不適格holder・終端二重記録の拒否も保持した。

NP11のB3/profile CLI、DB、managed entry/server、OS観測、claim復旧は実経路。tmux存在のcommand portとB8直前のMCP/plist readback入力は隔離fixture。B8のconfiguration完了transactionは本物を呼び、runtime/accountは毎回実OSから再観測する。**通常のB0–B8全体や実launchd/provider適用を完了したとはしない。** この限界はNP12/実適用と独立監査に残す。

## 最終版の生数

| run | PASS | FAIL | assertions | raw |
|---|---:|---:|---:|---|
| regression1-final | 142 | 0 | 719 | [regression1-final.log](regression1-final.log) |
| regression2-final | 59 | 0 | 308 | [regression2-final.log](regression2-final.log) |
| startup-final | 49 | 0 | 449 | [startup-final.log](startup-final.log) |
| config-final | 41 | 0 | 203 | [config-final.log](config-final.log) |
| integrated-final | 104 | 0 | 702 | [integrated-final.log](integrated-final.log) |

全run filtered=0。統合は旧95件を維持し新契約9件を追加した104件。AC-CFG-3/NP11は既存lifecycle testを拡張。run間の重複を加算してユニーク件数としない。Bun1.3.11 / Node24.20.0 / private PostgreSQL17.9（fixture role、UNIX socketのみ、TCP listenなし）/ SQLite。各test専用DBを破棄、cluster停止、依存module一時link除去は[fixture-stopped.json](fixture-stopped.json)。途中setup失敗で残ったDB4件とprocess2組は本人fixtureとして確認して片付けた。

実provider呼出し・外部試験送信・live DB/runtime/queue・他席変更・認証変更・NP12・mergeは0。GitHub返却/PR更新はcellの許可範囲。

## native過去拒否の閉じ方

採用: **再現不能の観測記録 + 監視assert**（最新handoffが明示許可）。旧`integrated-b4-failure`の94 PASS/1 FAILを保存し、原因未同定を維持。[前回RETURN](../trial-ready-003/RETURN.md)の診断付き単独5回・統合95件×3回の非再現を引き継ぐ。今回の固定HEAD統合も正常dispatch1、負例拒否3、native原本read2、observer18、provider0。`test_runtime_nonpersist_scheduler_native`へ、意図したOBSERVED/OBSERVATION_TIMEOUT以外のobserver理由を失敗させるassertを追加し、最初の正常dispatch拒否時は既存診断を残す。retryで正常扱いにせず、deadline/guard/assertを緩めていない。過去1件の原因修正を主張しない。

## design_judgments

```yaml
design_judgments:
  - summary: deploymentは既存agent_id。host別名/hashを作らず既存scope typeを維持。
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759277196', sha256: '01f2259457e1b5c605a500c1db474bcaf374d5d9f0ab48a4e57192914e01a82b'}
    status: implemented_and_isolated_tested
  - summary: observed_stateは履歴のみ。完了は既存outboxとlogical audit、exact desired/holder/fenceをSQLで照合。
    files_or_behavior: [core/aun-configuration-desired-state.ts, core/aun-configuration-reconciler.ts, bin/aun/bootstrap.ts]
    status: AC_CFG_1_to_3_pass
  - summary: restartの旧host列のみ削除。旧physical digestは変更不可の履歴、新規行はNULL。rollback先はrelease commit/tree。
    details: owner expiry・execution attempt・terminal historyは既存の論理統治として保持。logical key重複の既存行は削除せずmigrationを原子的に拒否。非null rollback envelopeには明示release identityを要求。
    status: AC_CFG_4_and_5_PG_SQLite_pass
  - summary: S0 kindはmaintenance lease metadata.native_runtime_kind。新列追加なし、OS/providerから推測しない。
    details: existing acquireControlPlaneLeaseで明示enrollmentし、lease・fresh process/start/socket・durable buildの3点で選択する。
    status: AC_S0_1_to_3_pass
  - summary: B3は論理profile/releaseのみ変更。rollbackは当該論理preimage、account start読取はUTC/C環境を保持。
    status: NP11_compatible_release_positive_pass
  - summary: 過去native拒否は原因未同定。許可された非再現記録と監視assertで実装席の残項目を閉じる。
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759655462', sha256: 'ede285301f047e43d77b15cceb767dd786b4be2a51a2cdc0782bba51f6afe256'}
    status: closed_by_authorized_nonreproduction_and_monitoring
```

## 未完・適用限界

1. 独立devauditor cycle2は未実施。旧REQUEST_CHANGESを自己承認で消さない。suite-leadが最終headへneeds:auditを戻して1回dispatchする。
2. NP12/実適用、実launchd・実provider、GoalRun/Task1・2、全B0–B8運用試験、全release checksは未実施。TRIAL_PASSED=false。mergeはowner。
3. macOS/Node24/private PG17の実測を非macOS精度/clock skewや別環境へ一般化しない。S0判定の修正を全旧V2 claim入口のruntime束縛証明へ一般化しない。
4. scope type語彙整理・同seat複数deploymentはarc契約の対象外台帳項目。今回のTRIAL_READYを阻む追加owner gateは設けない。

PR#958: 保持。close/merge/吸収完了宣言をしない。
PR#963: 保持。祖先に含むがclose/mergeをしない。
PR#968: 同cellの許可でfast-forward更新、非draft維持。自己承認/merge/ラベル変更なし。

```yaml
next_action:
  owner_agent: suite-lead
  required_function: orchestration_controller
  action: 最終PR headを対象にneeds:auditを戻しdevauditor cycle2を1回dispatchする
  handoff_method: issue940 comment + PR968
  input_refs:
    - https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759655462
    - https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5759277196
    - https://github.com/watchout/agent-comms-mcp/pull/968
    - 4a69acd4351f99738389882a58644800a682d176
    - docs/verify/aun-v2-nonpersistence-20260921/trial-ready-003-contracts/RETURN.md
    - docs/verify/aun-v2-nonpersistence-20260921/trial-ready-003-contracts/manifest.json
  scope: 同-003 cellのD1-D4/source/test/spec/evidence。独立監査のみ、mergeはowner。NP12/live/他席/認証は対象外。
  deliverable: 最終headに束縛された独立cycle2 gate_result
  completion_evidence: exact HEADとmanifest照合、AC8正負例・NP11・主回帰142/59のraw、独立監査の指摘または判定
  blocking: true
  stop_reason: independent gate after completed implementation handoff
```

## 今回の全途中版

各runのcommand、実行時刻、開始時source snapshot SHA、raw SHAは[runs.json](runs.json)。`0ee04fd5`行は未commit差分を含む開発中の試験で、HEADだけでは版を識別しない。最終5本はcommit固定・同一source SHAを全件照合。前回42runは[前回RETURN](../trial-ready-003/RETURN.md)と同directoryのruns.jsonに全保存し変更していない。

| run | HEAD | PASS | FAIL | filtered | error | assertions | raw |
|---|---|---:|---:|---:|---:|---:|---|
| config-units-v1 | `0ee04fd5` | 36 | 1 | 0 | 0 | 133 | [config-units-v1.log](config-units-v1.log) |
| s0-contract-v1 | `0ee04fd5` | 3 | 0 | 0 | 0 | 21 | [s0-contract-v1.log](s0-contract-v1.log) |
| config-units-v2 | `0ee04fd5` | 42 | 0 | 0 | 0 | 159 | [config-units-v2.log](config-units-v2.log) |
| cfg-contract-v1 | `0ee04fd5` | 2 | 4 | 0 | 0 | 13 | [cfg-contract-v1.log](cfg-contract-v1.log) |
| cfg-contract-v2 | `0ee04fd5` | 3 | 3 | 0 | 0 | 22 | [cfg-contract-v2.log](cfg-contract-v2.log) |
| cfg-contract-v3 | `0ee04fd5` | 4 | 2 | 0 | 0 | 28 | [cfg-contract-v3.log](cfg-contract-v3.log) |
| np11-v1 | `0ee04fd5` | 0 | 1 | 0 | 0 | 1 | [np11-v1.log](np11-v1.log) |
| np11-v2 | `0ee04fd5` | 0 | 1 | 0 | 0 | 1 | [np11-v2.log](np11-v2.log) |
| np11-v3 | `0ee04fd5` | 1 | 0 | 0 | 0 | 35 | [np11-v3.log](np11-v3.log) |
| cfg-contract-v4 | `0ee04fd5` | 6 | 0 | 0 | 0 | 45 | [cfg-contract-v4.log](cfg-contract-v4.log) |
| startup-v1 | `0ee04fd5` | 49 | 0 | 0 | 0 | 449 | [startup-v1.log](startup-v1.log) |
| regression1-v1 | `0ee04fd5` | 142 | 0 | 0 | 0 | 719 | [regression1-v1.log](regression1-v1.log) |
| regression2-v1 | `0ee04fd5` | 59 | 0 | 0 | 0 | 308 | [regression2-v1.log](regression2-v1.log) |
| cfg-migration-v1 | `0ee04fd5` | 4 | 0 | 0 | 0 | 67 | [cfg-migration-v1.log](cfg-migration-v1.log) |
| integrated-v1 | `0ee04fd5` | 104 | 0 | 0 | 0 | 699 | [integrated-v1.log](integrated-v1.log) |
| np11-v4 | `0ee04fd5` | 1 | 0 | 0 | 0 | 38 | [np11-v4.log](np11-v4.log) |
| regression2-final | `4a69acd4` | 59 | 0 | 0 | 0 | 308 | [regression2-final.log](regression2-final.log) |
| regression1-final | `4a69acd4` | 142 | 0 | 0 | 0 | 719 | [regression1-final.log](regression1-final.log) |
| config-final | `4a69acd4` | 41 | 0 | 0 | 0 | 203 | [config-final.log](config-final.log) |
| startup-final | `4a69acd4` | 49 | 0 | 0 | 0 | 449 | [startup-final.log](startup-final.log) |
| integrated-final | `4a69acd4` | 104 | 0 | 0 | 0 | 702 | [integrated-final.log](integrated-final.log) |

途中FAIL対応: config-units-v1はnonnull rollback fixtureのrelease指定漏れを補完。cfg-contract-v1はfixture agent_type欠落、v2はaccount-root読取時のUTC環境不適用とfixture CTO未登録、v2/v3は同名fixture process残存による複数runtime観測を修正/片付け、v4で全件通過。NP11 v1/v2はB3の旧physical CLI引数拒否、v3で論理profile呼出しに直し通過、v4で論理rollback正例も通過。assert削除で成功にしていない。

## 変更path

今回のsource/spec/testは31 paths。累積PR差分と比較baseは[changed-paths.json](changed-paths.json)。後続変更はこのverify directoryの証拠のみ。

```text
bin/aun/bootstrap.ts
bin/state-daemon.ts
core/aun-configuration-candidate.ts
core/aun-configuration-desired-state.ts
core/aun-configuration-reconciler.ts
core/host-runtime-observer.ts
core/runtime-inventory.ts
core/runtime-native-authority.ts
db/migrate-sqlite.ts
db/migrate.ts
db/migrations/2026-09-21-runtime-observation-restart-contract.down.sql
db/migrations/2026-09-21-runtime-observation-restart-contract.up.sql
docs/SSOT.md
docs/spec/seat-runtime-continuity.md
tests/aun-configuration-candidate.test.ts
tests/aun-configuration-reconciler.test.ts
tests/contract/test_aun_configuration_concurrent_revision.test.ts
tests/contract/test_aun_configuration_db_outage.test.ts
tests/contract/test_aun_configuration_endpoint_rebind.test.ts
tests/contract/test_aun_configuration_notification_loss.test.ts
tests/contract/test_aun_configuration_projection_readback.test.ts
tests/contract/test_aun_configuration_restart_gate.test.ts
tests/contract/test_runtime_nonpersist_configuration_contract.test.ts
tests/contract/test_runtime_nonpersist_s0_contract.test.ts
tests/contract/test_runtime_nonpersist_scheduler_native.test.ts
tests/contract/test_runtime_nonpersist_server_lifecycle.test.ts
tests/eventlog/eventlog-v2-native-agent-mesh-cutover.test.ts
tests/helpers/configuration-contract-fixture.ts
tests/helpers/native-process-fixture.ts
tests/helpers/nonpersist-host-fixture.ts
tests/migrations/aun-configuration-reconciliation.test.ts
```
