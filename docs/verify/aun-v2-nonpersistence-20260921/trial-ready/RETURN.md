# Trial-ready cell return — 実装候補 / REWORK_REQUIRED

- cell_id: `CELL-AUN-940-TRIAL-READY-20260921-002`
- risk_class: **R3**（累積scopeはDB migrationsを含む。このcellのproduction差分は2ファイル）
- executor / active_function: `codex-aun` / `implementation_executor`。追加subagent 0。
- source HEAD: `ef42f44abcfdec35888aee8da4ea37afea14c64f`。この後のcommitは証拠/docのみ。返却HEADからこのsourceへ到達でき、manifestの全source SHAを照合する。
- base / frozen PR#968: `23b6f055ecc8f0971e7eed2f5546188a5a5f2fef`
- branch: `codex/aun-v2-nonpersist-trial-ready-20260921`
- lifecycle_state: `REWORK_REQUIRED`; TRIAL_READY: **不可 / false**; TRIAL_PASSED: false; NP12: NOT_RUN。

目的（cell原文）：「採択済み D1〜D4 / NP01〜11 の実装を『主回帰 FAIL 0、または残る FAIL 全件に原因と対応の分類が付いた』状態まで進め、TRIAL_READY の可否を本人が判定できる固定候補を返す」。完了観測は固定sourceで主回帰2本を実行し、全FAILの原名・raw停止点・原因・対応・未対応理由を照合すること。今回は全FAIL分類の返却条件を満たす。v2通常経路の完成は主張しない。

## 権限と独立監査

- [current cell](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757045662)、本文SHA256 `e0f7c4b854e771b0a9423dc8eb4bde4470f9c70c53bc32f43a189b56b3d98bd6`。
- [独立席への移管](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755777052)、本文SHA256 `8b135ba67e36071b94c834e02f5b78e9d7c8b298936163c155b33af520c778a4`。allowed scopeのみ継承。
- [D1〜D4採択](https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993)、本文SHA256 `8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791`。
- 作業中に届いた[devauditor review](https://github.com/watchout/agent-comms-mcp/pull/968#pullrequestreview-5264270722)、本文SHA256 `e2b646123cd368891fafa6f9ee1c5d9c522d599cd34a9159f99116010c26f32e` は **BLOCKED / REQUEST_CHANGES**。監査対象は23b6f055。新候補へのPASSとは扱わない。原文を`audit-pr968.json`に保存。

## 変更と根拠

1. daemonのreadiness gateへ同じ`runtimeInspector`を渡す。native readerのDIは既存gateのreader型を継承し、未指定時は本物の原本readが既定。旧`providerObserver`だけを差していたscheduler/E7試験を、logical anchorと明示unit seamへ移行。D1/D2のguardは維持。
2. LLM frozen-setはfresh provider/UUID/cwdとそのcwdのgit HEADから作る。manifestは論理workspace/repository所属とlogical UUIDを照合し、物理pathは現在のobserverから読む。旧DB provider/status/path/seenでLLMを選ばない。denominator/未分類seatの扱いを維持。
3. continuity試験の歴史provider fallbackをD3どおり拒否へ修正。held socketはpublish前/lease失効時503、同じseatの複数holderは拒否、旧runtime履歴は不変。ancestry/endpointの一部は明示unit OS seamであり、実OS証明とは区別。
4. native fixtureのUUID/text共用SQLパラメータを分離し、PostgreSQLでも原本readを通す。新しい通常daemon入口試験では実OS holder/原本MCP/専用PGを使用し、runnerだけをrecorderに置換。最終rawは **native reads=2 / dispatch=1 / denial=3 / provider invocation=0 / observer calls=18**。
5. diagnostics-format移行は固定旧schemaで旧行をseedしてから、現guard適用後のhistory不変と新物理write拒否を検証する。guardを無効化しない。B3通常writerの合格証明にはしない。

### このcellのsource/test変更path

- `core/runtime-inventory.ts`
- `core/state-daemon/index.ts`
- `tests/contract/test_aun_configuration_runtime_diagnostics.test.ts`
- `tests/contract/test_runtime_nonpersist_scheduler_native.test.ts`
- `tests/eventlog/eventlog-v2-native-agent-mesh-cutover.test.ts`
- `tests/helpers/logical-runtime-unit-fixture.ts`
- `tests/helpers/seat-native-runtime-fixture.ts`
- `tests/runtime-inventory.test.ts`
- `tests/seat-runtime-continuity.test.ts`
- `tests/state-daemon-queue-work-concurrency.test.ts`
- `tests/state-daemon-queue-work-scheduler.test.ts`

証拠追加path: `docs/verify/aun-v2-nonpersistence-20260921/trial-ready/*`。PR#968 branchへのpush、PR新規作成、merge、shared DB/runtime/queue、NP12、他席操作、認証変更、public CI再実行はいずれも0。

## 同一sourceの実測（重複は合算しない）

専用PostgreSQL17.9（UNIX socketのみ、listen_addresses空）/ SQLite / Bun1.3.11 / Node24.20.0。Wasurezu原本fixtureは既存の明示build `e49abc24838227776dc01be111aeb035ec7c9aad` を読取り使用。資格情報/実providerは使わない。fixtureはこのcellで作成し、全試験後に所有PGのみ停止（`fixture-stopped.json`）。実行argv、時刻、exit、raw SHA、全source snapshotは各`.json` / `.sources.json`。

| run | PASS | FAIL | assertions | 分母/範囲 |
|---|---:|---:|---:|---|
| [regression1-final](regression1-final.log) | 119 | 23 | 530 | 142 tests / 7 files |
| [regression2-final](regression2-final.log) | 35 | 24 | 209 | 59 tests / 5 files |
| [startup-concurrency-final](startup-concurrency-final.log) | 49 | 0 | 449 | 49 tests / 4 files |
| [integrated-final](integrated-final.log) | 42 | 0 | 357 | 42 tests / 10 files、旧41件＋通常native daemon1件 |
| [manifest-final](manifest-final.log) | 7 | 0 | 23 | manifest 7 tests、無関係のreport 4件は明示filter（主回帰分母には影響なし） |

[残47FAILの全表](FAIL-CLASSIFICATION.md) / [機械可読47行](fail-classification.json)。原因分類は試験の停止点であり、consumerが正常という免責ではない。旧主回帰でFAILだった83件の処遇は[原名対応表](prior-fail-disposition.json)へ保存。36件が今回PASS、47件は未検証assertを残す。旧版の85P/57F、33P/26Fを今回実測として転記していない。

## 未完と監査指摘の処遇

| 項目 | 状態 / 実証・未完理由 |
|---|---|
| B3/config host-scope・restart / audit P1-1 | **未完 / needs:arc**。bootstrap.ts:1907は`AUN_HOST_ID || hostname()`、desired-state.ts:479/537はhost_id/物理digestのINSERT、09-21 guardは当該table INSERTを拒否。論理deploymentの発行主体、scope/holder、restart receiptで許されるdurable fieldsが未定。hostnameの別名/hashで埋めない。writerまで到達する通常B3/B8は未検証。 |
| LLM frozen-set / manifest / audit P1-2 | **該当LLM reader修正済み**。`LLM selector uses fresh provider and checkout with NULL physical anchors, never historical preference`、manifest7件、integratedのfresh inventory負例で確認。**指摘全体は未完**：S0互換経路はDB physical snapshotを読むまま。provider-free S0をLLM observer必須にする変更はせず、S0の論理authority proof/checkout入力をneeds:arcとして返す。 |
| reader/writer残存 | **未完**。`cli/index.ts`のprofile doctorはruntime/profile/active connector保存値を読む。`bin/aun/receive.ts:578,1826`等のagents.status/status_detail書込がguardと不整合。全server boot/launcher/lifecycle writerも未閉鎖。NORM-022の8件はguardでseed停止しており、readerの合格根拠にならない。 |
| claim renewal | **修正済みの既存経路を再確認**。`NP02/04/08 daemon eligibility and claim renewal work with NULL physical rows and reject a changed fence`（private PG）はexact runtime/lease/fence失効で更新0、旧claim fields不変。 |
| claim取得 | **未完**。`bin/aun/receive.ts:541,1812`の非bounded UPDATEはclaimed_by/claimed_at/expiryだけでclaimed_runtime_instance_idを束縛しない。続く旧status writerもguardに拒否される。new claimからrefreshまでの通常経路は未通。 |
| dispatch | **入口は修正済み**。通常native daemon試験、scheduler46件、E7 F5で入口判定を確認。ただしrunner recorder/DIの成功は実LLM dispatch成功ではなく、全呼出し境界・claim acquisitionとの連結は未完。 |
| finalize | **部分確認 / 未完**。schedulerの`done generic queue events...`・`sweep resumes a stored-result finalizer...`、queue-work既存試験は通過。`core/queue-work.ts:1035,1199`等はclaim owner/time/expiryを検証するがruntime incarnationとの連結を証明していない。replacementが旧claimをfinishできない通常経路の全証明が残る。 |
| E7 sweep | **修正済み / 同一source再実測**。F5は不明provider時dispatch0、3回deferralでDB writes0/rewoken0、slot解放後invoke1。通常PG/native入口の否定3条件は別途実測。 |
| NP11 / compatible binary rollback | **未完**。統合42件に旧physical-writing down拒否、guard・history/FK保持は含む。特定compatible binaryによるB3/start/restart/claim復旧の正例は0。down拒否PASSをbinary rollback成功へ置き換えない。 |
| その他 | 主回帰47 FAILの原因/対応/未対応理由は全件表。非macOS PID-start精度、DB/OS clock skewの許容、全server起動、実LLM/GoalRun/Task1・2は未受入。 |

TRIAL_READY不可の直接理由は通常writer/claim/restartの未接続と未検証回帰。NP12は今回禁止された適用段階としてNOT_RUNを維持するが、この内容判定の代わりにはしていない。再開時は採択内の通常修正を一般的なACK待ちにしない。

## design_judgments

```yaml
design_judgments:
  - summary: UUIDとlease receipt/fenceはDBの論理権限、現在のprovider/endpointは共通observerに束縛する
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993', sha256: '8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791'}
    files_or_behavior: [core/state-daemon/index.ts, core/runtime-inventory.ts]
  - summary: 未指定native readerは本物の原本read。unit seamは正常挙動の総合受入とはしない
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755777052', sha256: '8b135ba67e36071b94c834e02f5b78e9d7c8b298936163c155b33af520c778a4'}
    files_or_behavior: [tests/contract/test_runtime_nonpersist_scheduler_native.test.ts]
  - summary: macOSのmicrosecond startとDB時刻の既存実装を他platform/clock skewへ一般化しない
    files_or_behavior: [core/process-start-time.ts, core/runtime-heartbeat.ts]
    status: inherited_limit_not_closed
  - summary: guardを維持し旧physical writer rollbackを拒否。正のcompatible binary復旧受入は未完
    files_or_behavior: [db/migrations/2026-09-21-runtime-observation-nonpersistence.down.sql]
    status: positive_binary_rollback_not_proven
  - summary: configurationとprovider-free S0の論理deployment契約をこの実装席が独自決定しない
    files_or_behavior: [bin/aun/bootstrap.ts, core/aun-configuration-desired-state.ts, core/runtime-inventory.ts]
    status: needs:arc
```

PR#958: 保持。吸収完了・close・mergeをしない（23b6f055でancestorでなかったという旧監査事実を引継ぎ）。
PR#963: 保持。baseは56b52283を含むが、close・mergeをしない。
PR#968: head23b6f055を固定したまま。今回のsource/証拠は新branchにだけ保存。新PRは起票しない。

## 全途中版の生数

途中版のsource_headは23b6f055＋未commit差分であり、最終版の証明ではない。各source manifestのSHAで識別する。`scheduler-native-v4`のUUID/textパラメータ不整合、`continuity-v6`のfixture inspectorがexact UUIDで絞らない誤りも隠さず保持。

| run | source HEAD | PASS | FAIL | assertions | source snapshot SHA256 |
|---|---|---:|---:|---:|---|
| [scheduler-v1](scheduler-v1.log) | `23b6f055` | 39 | 7 | 157 | `f0883332581c0da7f024e90dee74c96821ee01eccc51002fafe535aab8bc4ae6` |
| [scheduler-e7-v2](scheduler-e7-v2.log) | `23b6f055` | 58 | 0 | 274 | `752a7aa2d014ef8e55d631d15b7f07fd434af7dbd14b81d473e58f51a8758731` |
| [regression2-v3](regression2-v3.log) | `23b6f055` | 33 | 26 | 130 | `752a7aa2d014ef8e55d631d15b7f07fd434af7dbd14b81d473e58f51a8758731` |
| [regression1-v3](regression1-v3.log) | `23b6f055` | 115 | 27 | 498 | `752a7aa2d014ef8e55d631d15b7f07fd434af7dbd14b81d473e58f51a8758731` |
| [scheduler-native-v4](scheduler-native-v4.log) | `23b6f055` | 0 | 1 | 0 | `dd7ec8d8d1bd99001af5708a3e507e37f8f8e22340ff0d39f4da7b00e608bb16` |
| [scheduler-native-v5](scheduler-native-v5.log) | `23b6f055` | 1 | 0 | 16 | `19d6eaf29c07cc4c3b19a8407e288a3e9059151e87ee04cc5ed757e4fbce86b4` |
| [continuity-v6](continuity-v6.log) | `23b6f055` | 9 | 1 | 72 | `c617a588a8bfe7387ee5033e4fa1e6258cc3fe855872a74fcac8c6c477ebca50` |
| [continuity-v7](continuity-v7.log) | `23b6f055` | 10 | 0 | 83 | `c678615f177b7236921b25035bfecf9e4822aa2e6fdfece5b513671291801baf` |
| [frozen-llm-s0-v8](frozen-llm-s0-v8.log) | `23b6f055` | 5 | 0 | 23 | `ba54ec562ec3a2ea5e5f7176e1296eff0ff46a114c935332e47b55048ef01084` |
| [manifest-v8](manifest-v8.log) | `23b6f055` | 7 | 0 | 23 | `ba54ec562ec3a2ea5e5f7176e1296eff0ff46a114c935332e47b55048ef01084` |
| [diagnostics-legacy-v9](diagnostics-legacy-v9.log) | `23b6f055` | 2 | 0 | 81 | `1878c78387cd4c2acabea42376d1898e6cfe1d80b029e01d04ac7487948454ca` |
| [manifest-final](manifest-final.log) | `ef42f44a` | 7 | 0 | 23 | `3b951e993f5f38f21ff7f3d3e2ab5f6fa742e5a4014a8c8f3444cfc13ea12c72` |
| [regression2-final](regression2-final.log) | `ef42f44a` | 35 | 24 | 209 | `3b951e993f5f38f21ff7f3d3e2ab5f6fa742e5a4014a8c8f3444cfc13ea12c72` |
| [startup-concurrency-final](startup-concurrency-final.log) | `ef42f44a` | 49 | 0 | 449 | `3b951e993f5f38f21ff7f3d3e2ab5f6fa742e5a4014a8c8f3444cfc13ea12c72` |
| [regression1-final](regression1-final.log) | `ef42f44a` | 119 | 23 | 530 | `3b951e993f5f38f21ff7f3d3e2ab5f6fa742e5a4014a8c8f3444cfc13ea12c72` |
| [integrated-final](integrated-final.log) | `ef42f44a` | 42 | 0 | 357 | `3b951e993f5f38f21ff7f3d3e2ab5f6fa742e5a4014a8c8f3444cfc13ea12c72` |

## 返却先のnext_action

```yaml
next_action:
  owner_agent: suite-lead
  required_function: orchestration_controller
  action: 本候補とPR968監査を合わせ、arcへconfiguration/S0の論理契約を回付し、採択内の残writer・claim・回帰修正を本人へ具体化する
  handoff_method: issue940 comment
  input_refs:
    - https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757045662
    - https://github.com/watchout/agent-comms-mcp/pull/968#pullrequestreview-5264270722
    - trial-ready/RETURN.md
    - trial-ready/FAIL-CLASSIFICATION.md
    - trial-ready/manifest.json
  scope: 既存allowed source/test/docs、新branchのみ。PR968/958/963変更、merge、live DB/runtime/queue、NP12、他席、認証変更、追加subagentは禁止
  deliverable: 論理deployment契約の決定と、残writer/claim/47回帰およびcompatible binary復旧証拠を閉じる次の具体handoff
  completion_evidence: 新headの通常/否定/復旧raw evidenceと2監査指摘・影響回帰の独立再監査
  blocking: true
  stop_reason: configuration/S0の設計契約が未確定、独立gateはBLOCK。現cellを全FAIL分類の条件で返却
```
