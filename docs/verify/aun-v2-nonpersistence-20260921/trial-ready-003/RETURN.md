# CELL-AUN-940-TRIAL-READY-20260921-003 RETURN

主回帰は142/142・59/59、起動/並行回帰49/49、隔離統合95/95（各FAIL 0）。旧47 FAILを全件移行し、通常receive claim→refresh→done/finalize、実server起動→停止→再起動→未完claim再取得を接続した。**TRIAL_READY=false / TRIAL_PASSED=false**。configuration論理deployment・provider-free S0 authority proofの契約は未着、NP11の「単一compatible binaryでB3から復旧」の正例は未完。native schedulerには原因未同定の一過性拒否1件も残す。

- cell_id: `CELL-AUN-940-TRIAL-READY-20260921-003`
- risk_class: `R3`（PR累積差分にDB migration/protected surfaceを含む）
- active_function: `implementation_executor`、本人実行、追加subagent 0
- goal（原文）: arc の契約待ちに依存しない残りを全部閉じ、契約が決まった時点で「契約の実装 → 再監査」だけが残る状態にする
- control_source_ref: https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757589027 / body SHA256 `4923e637e2e2490e5a36f5201ffc35d3565dfb32828f481cab9c95ede3156f5e`
- cell base: `4be7a6d3c49507a8fbe1ca4e5b2ec4b6dee08775`
- exact source/test HEAD: `592d00654145d0c3db1295c82dacd6ecb5841655`。実装commit `d5936568f1cf2592e126d0af2e1c9385b3827ded` と、既存connector保持fixtureの補強・native拒否時診断のtest-only commits。
- 最終PR headは本RETURNとmanifestだけを加えた後続commit。PR本文と#940返却でfull SHAを束縛する。4本の最終runは同一source manifestであり、Git blobの全件SHA照合を行った。
- 契約掲載確認: `2026-09-21T10:28:10.693900+00:00`、指定cellより新しい#940 comment 0件。契約実装: configuration=false / S0=false。hostname別名/hashによる代替0。

## 修正と観測

| 対象 | 判定とtest名 |
|---|---|
| 47 FAIL | **移行済み**。[FAIL-CLOSURE.md](FAIL-CLOSURE.md)に原名→現在名・目的assert・raw行を47件掲載。主回帰142/59の分母不変。unit seamを実原本証明へ読み替えない。 |
| receive / CLI / profile writer | **修正済み**。`test_runtime_nonpersist_claim_cycle`: 通常receiveから新規claim 5件、refresh→done→finalize。`test_runtime_nonpersist_profile`: PG/SQLiteで通常登録・安定属性変更・旧物理flag拒否・論理membership projection・履歴不変。doctorはNORM-022全11件で検証。status/status_detail新規書込みを除去。 |
| server boot / launcher / lifecycle | **修正済み**。`test_runtime_nonpersist_server_lifecycle`: 本物のmanaged entry/serverを起動2回・停止2回・再起動1回・未完claim回収/再取得1件、UUID交代、物理DB列NULL、lease解放を確認。`test_runtime_nonpersist_entrypoint`: pre-exec UUIDを実child launchで確認。 |
| claim取得→refresh | **修正済み**。`test_runtime_nonpersist_claim_cycle`のPG通常receiveは`claimed_runtime_instance_id`とexact lease/fenceを同じUPDATEで束縛。競合時1件拒否。SQLiteは通常adapterでclaim SQL→done/finalizeが通過。 |
| queue-work advance / result / error / finalize | **修正済み（普通のincarnation-bound claim）**。同claim-cycle testでreplacement拒否3件、遅延旧result保存拒否、新holderによる旧received実行拒否・旧done完了拒否。終端直前再観測とSQL owner/time/UUID/lease fenceを維持。既存queue-work45件・startup/E7回帰を維持。 |
| native original | **追加修正済み**。移行後に目的assertへ到達すると原本receipt内外のagent/project/target/pack/input/work/response digest不一致が露呈したため照合を追加。`test_runtime_nonpersist_native`と通常daemon `test_runtime_nonpersist_scheduler_native`で実原本再読と拒否を確認。 |
| NP11 | **部分証拠あり / 未完**。同sourceで実server再起動→claim回復と、guard/旧FK/履歴保持・旧physical writer rollback拒否は通過。B3を含む単一compatible binaryの正例は0。configuration契約実装後に全行程を1本で再実測する。 |

観測→識別: 停止失敗はraw `server-v10`の`RUNTIME_RELEASE_HOLDER_UNVERIFIED`。停止時socketを先に閉じる仮説と別の所有不一致を実serverで切り分け、release→socket stopへ変更するとv11の2回停止が正常化した。SQLite claimはv18で`CLAIM_OWNERSHIP_LOST`、SQL形式lease日時とISO日時の文字比較をparsed instant比較へ合わせたv19で同じclaim→done→finalizeが通過。raw途中FAILを削除していない。

## 最終同一sourceの生数

| run | PASS | FAIL | filtered | assertions | source HEAD | raw |
|---|---:|---:|---:|---:|---|---|
| regression1-final | 142 | 0 | 0 | 719 | `592d00654145d0c3db1295c82dacd6ecb5841655` | [regression1-final.log](regression1-final.log) |
| regression2-final | 59 | 0 | 0 | 308 | `592d00654145d0c3db1295c82dacd6ecb5841655` | [regression2-final.log](regression2-final.log) |
| startup-final | 49 | 0 | 0 | 449 | `592d00654145d0c3db1295c82dacd6ecb5841655` | [startup-final.log](startup-final.log) |
| integrated-final | 95 | 0 | 0 | 618 | `592d00654145d0c3db1295c82dacd6ecb5841655` | [integrated-final.log](integrated-final.log) |

重複するtestを複数commandが含むため、run間を足してユニーク件数としない。`syntax-v20`: 18 TS filesの構文変換成功（test-only最終補強は主回帰で再変換/実行）。Bun 1.3.11 / Node 24.20.0 / PostgreSQL 17.9、private UNIX socketのみ・fixture role・TCP listenなし。各PG testは別DBを作成/破棄し、SQLiteは専用fixture。実provider呼出し・外部テスト送信・live DB/runtime/queue操作・他席変更・認証変更・NP12は0。GitHub PR/返却書込みはcellによる別途許可範囲。private cluster停止証拠はfixture-stopped.json。

## 変更path

今回のsource/test/docs 21 paths（以下）。累積PR pathは[changed-paths.json](changed-paths.json)にPR baseも併記。後続はこのverify directoryの証拠のみ。

```text
bin/aun/receive.ts
bin/aun/run-queue-work.ts
cli/index.ts
core/inbox-cursor.ts
core/queue-work.ts
core/runtime-memory-ready.ts
core/runtime-queue-claim.ts
docs/SSOT.md
docs/spec/seat-runtime-continuity.md
server.ts
tests/agent-status-lifecycle.test.ts
tests/contract/test_runtime_nonpersist_claim_cycle.test.ts
tests/contract/test_runtime_nonpersist_profile.test.ts
tests/contract/test_runtime_nonpersist_scheduler_native.test.ts
tests/contract/test_runtime_nonpersist_server_lifecycle.test.ts
tests/inbox-cursor-db-persist.test.ts
tests/inbox-cursor.test.ts
tests/norm-022-runtime-endpoint-lease.test.ts
tests/runtime-current-resolver.test.ts
tests/runtime-heartbeat.test.ts
tests/runtime-memory-ready.test.ts
```

## design_judgments

```yaml
design_judgments:
  - summary: 保存するのはopaque UUID/claim owner/time/expiry/lease fence。現在provider/socketは操作ごとの観測。
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5755364993', sha256: '8414bb149e2a8b9aee4fb62b87f11d6109d5bc9bf9beb67019e282e21bcc1791'}
    files_or_behavior: [core/runtime-queue-claim.ts, core/queue-work.ts, bin/aun/receive.ts]
    status: implemented_and_isolated_tested
  - summary: 旧物理期待をD1–D4へ移行し、論理権限・原本native証拠・DB guardを弱めない。
    basis_ref: {url: 'https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757589027', sha256: '4923e637e2e2490e5a36f5201ffc35d3565dfb32828f481cab9c95ede3156f5e'}
    files_or_behavior: [tests/runtime-heartbeat.test.ts, tests/runtime-current-resolver.test.ts, tests/runtime-memory-ready.test.ts, tests/norm-022-runtime-endpoint-lease.test.ts]
    status: primary_regressions_142_and_59_pass
  - summary: 通常profileは安定属性のみ、shutdownはsocket保有中にexact leaseを解放する。
    files_or_behavior: [cli/index.ts, server.ts, core/inbox-cursor.ts]
    status: implemented_and_isolated_tested
  - summary: configuration論理deploymentとprovider-free S0 authority proofを実装席が独自決定しない。
    files_or_behavior: [bin/aun/bootstrap.ts, core/aun-configuration-desired-state.ts, core/runtime-inventory.ts, core/aun-runtime-v2.ts, core/aun-runtime-v2-live-claim.ts]
    status: needs:arc
    contract_published: false
    implemented: false
  - summary: compatible binaryのB3連結復旧正例は、start/restart/claim正例や旧writer拒否だけでは閉じない。
    status: NP11_positive_B3_binary_recovery_not_proven
  - summary: macOS実プロセス/DB時刻の実測を非macOS start精度・clock skewへ一般化しない。
    status: inherited_platform_limit
```

## 未完と次の入力

1. configurationの論理deployment契約、reconcilerの通常保存/B3/restartとの接続（needs:arc）。契約未着のため未実装。
2. provider-free S0のauthority proof/checkout契約（needs:arc）。S0/旧V2 claim入口へLLM providerを捏造して束縛していない。今回のunbounded通常claim証明を、全S0/旧V2 claimへ一般化しない。
3. 上記契約実装後、単一compatible binaryのB3→start→restart→claim回復を1本で実測しNP11を閉じる。正常B0–B8全体の受入はまだ0。
4. `integrated-b4-failure`は94 PASS / 1 FAIL（native schedulerの正常dispatch 0）。直前同一product sourceで95 PASS、拒否診断追加後は単独1回+3回と統合95 PASSだが原因は再現せず未同定。環境要因／製品不具合のどちらかを断定しない。現在のPASSで過去FAILの原因修正を主張せず、診断付きの再現性確認を残す。
5. その最終HEADへの独立cycle2監査は未実施。旧REQUEST_CHANGESは消さず、新head PASS扱いにしない。非macOS精度/clock skewの限界、全release checksは別途受入に残る。NP12/実適用・実LLM/GoalRun/Task1・2は今回対象外/未実施。

PR#958: 保持。吸収完了・close・mergeをしない。
PR#963: 保持。祖先に含むがclose・mergeをしない。
PR#968: -003 cellの許可に基づきこのsourceと証拠へfast-forward更新。非draft維持、自己承認/merge/needs:auditへの早期変更なし。

```yaml
next_action:
  owner_agent: suite-lead
  required_function: orchestration_controller
  action: arcのconfiguration論理deploymentとS0 authority proof契約を#940に掲載し本席へ通知する。既存cell内で契約実装とNP11正例を閉じた後、その最終headをcycle2へ1回提出する。
  handoff_method: issue940 comment + PR968
  input_refs:
    - https://github.com/watchout/agent-comms-mcp/issues/940#issuecomment-5757589027
    - https://github.com/watchout/agent-comms-mcp/pull/968
    - https://github.com/watchout/agent-comms-mcp/pull/968#pullrequestreview-5264270722
    - 592d00654145d0c3db1295c82dacd6ecb5841655
    - docs/verify/aun-v2-nonpersistence-20260921/trial-ready-003/RETURN.md
    - docs/verify/aun-v2-nonpersistence-20260921/trial-ready-003/manifest.json
  scope: 採択D1–D4のsource/test/docsと専用隔離環境。PR968更新可。guard無効化、assert削除、hostname別名/hashによる契約代替、live DB/runtime/queue、NP12、他席、認証、追加subagent、PR958/963変更、mergeは禁止。
  deliverable: publishされた2契約と、それを実装しNP11を閉じた再監査対象HEAD
  completion_evidence: 契約URL/body SHA256、同一HEADの主回帰FAIL0とNP11全行程raw、独立cycle2 gate_result
  blocking: true
  stop_reason: external dependency that the current function cannot legally mutate — arcの設計契約が未掲載。指定writer/claim/finalize修正と主回帰は完了。native一過性拒否の原因は未同定として保持し、契約実装後のNP11統合でも診断する。
```

## 全途中版の生数

各runのcommand/time/source snapshot SHAとlog SHAは同名JSONおよび[runs.json](runs.json)。`4be7a6d3`のrunは未commit差分を含み、headだけでは版を識別しない。`d593`は最初のcommit後、`b4b62502`は既存connector実在fixture補強後、最終`592d0065`はnative拒否時の診断追加後（ともにtest-only）。失敗も全件保存。

| run | HEAD | PASS | FAIL | filtered | error | assertions | raw |
|---|---|---:|---:|---:|---:|---:|---|
| heartbeat-v1 | `4be7a6d3` | 8 | 0 | 0 | 0 | 133 | [heartbeat-v1.log](heartbeat-v1.log) |
| resolver-v1 | `4be7a6d3` | 6 | 4 | 0 | 0 | 25 | [resolver-v1.log](resolver-v1.log) |
| resolver-v2 | `4be7a6d3` | 9 | 1 | 0 | 0 | 40 | [resolver-v2.log](resolver-v2.log) |
| memory-v1 | `4be7a6d3` | 34 | 2 | 0 | 0 | 142 | [memory-v1.log](memory-v1.log) |
| norm-memory-v2 | `4be7a6d3` | 31 | 6 | 0 | 0 | 137 | [norm-memory-v2.log](norm-memory-v2.log) |
| norm-memory-v3 | `4be7a6d3` | 37 | 0 | 0 | 0 | 145 | [norm-memory-v3.log](norm-memory-v3.log) |
| regression1-v4 | `4be7a6d3` | 142 | 0 | 0 | 0 | 718 | [regression1-v4.log](regression1-v4.log) |
| regression2-v4 | `4be7a6d3` | 59 | 0 | 0 | 0 | 308 | [regression2-v4.log](regression2-v4.log) |
| queue-v5 | `4be7a6d3` | 45 | 0 | 0 | 0 | 183 | [queue-v5.log](queue-v5.log) |
| claim-cycle-v6 | `4be7a6d3` | 0 | 1 | 0 | 0 | 1 | [claim-cycle-v6.log](claim-cycle-v6.log) |
| claim-cycle-v7 | `4be7a6d3` | 1 | 0 | 0 | 0 | 35 | [claim-cycle-v7.log](claim-cycle-v7.log) |
| server-v8 | `4be7a6d3` | 0 | 1 | 0 | 1 | 0 | [server-v8.log](server-v8.log) |
| server-v9 | `4be7a6d3` | 0 | 1 | 0 | 0 | 4 | [server-v9.log](server-v9.log) |
| server-v10 | `4be7a6d3` | 0 | 1 | 0 | 0 | 4 | [server-v10.log](server-v10.log) |
| server-v11 | `4be7a6d3` | 1 | 0 | 0 | 0 | 17 | [server-v11.log](server-v11.log) |
| profile-queue-v12 | `4be7a6d3` | 47 | 1 | 0 | 0 | 233 | [profile-queue-v12.log](profile-queue-v12.log) |
| lifecycle-v13 | `4be7a6d3` | 42 | 8 | 0 | 0 | 178 | [lifecycle-v13.log](lifecycle-v13.log) |
| lifecycle-v14 | `4be7a6d3` | 48 | 2 | 0 | 0 | 192 | [lifecycle-v14.log](lifecycle-v14.log) |
| integrated-v15 | `4be7a6d3` | 94 | 0 | 0 | 0 | 610 | [integrated-v15.log](integrated-v15.log) |
| restart-profile-v16 | `4be7a6d3` | 2 | 1 | 0 | 0 | 37 | [restart-profile-v16.log](restart-profile-v16.log) |
| profile-v17 | `4be7a6d3` | 2 | 0 | 0 | 0 | 30 | [profile-v17.log](profile-v17.log) |
| sqlite-claim-v18 | `4be7a6d3` | 0 | 1 | 1 | 0 | 2 | [sqlite-claim-v18.log](sqlite-claim-v18.log) |
| sqlite-claim-v19 | `4be7a6d3` | 1 | 0 | 1 | 0 | 4 | [sqlite-claim-v19.log](sqlite-claim-v19.log) |
| regression2-d593 | `d5936568` | 59 | 0 | 0 | 0 | 308 | [regression2-d593.log](regression2-d593.log) |
| regression1-d593 | `d5936568` | 142 | 0 | 0 | 0 | 718 | [regression1-d593.log](regression1-d593.log) |
| startup-d593 | `d5936568` | 49 | 0 | 0 | 0 | 449 | [startup-d593.log](startup-d593.log) |
| integrated-d593 | `d5936568` | 95 | 0 | 0 | 0 | 618 | [integrated-d593.log](integrated-d593.log) |
| regression1-b4 | `b4b62502` | 142 | 0 | 0 | 0 | 719 | [regression1-b4.log](regression1-b4.log) |
| regression2-b4 | `b4b62502` | 59 | 0 | 0 | 0 | 308 | [regression2-b4.log](regression2-b4.log) |
| startup-b4 | `b4b62502` | 49 | 0 | 0 | 0 | 449 | [startup-b4.log](startup-b4.log) |
| integrated-b4-failure | `b4b62502` | 94 | 1 | 0 | 0 | 603 | [integrated-b4-failure.log](integrated-b4-failure.log) |
| native-diagnostic-v21 | `b4b62502` | 1 | 0 | 0 | 0 | 16 | [native-diagnostic-v21.log](native-diagnostic-v21.log) |
| native-diagnostic-v22 | `b4b62502` | 3 | 0 | 0 | 0 | 48 | [native-diagnostic-v22.log](native-diagnostic-v22.log) |
| integrated-diagnostic-v23 | `b4b62502` | 95 | 0 | 0 | 0 | 618 | [integrated-diagnostic-v23.log](integrated-diagnostic-v23.log) |
| startup-final | `592d0065` | 49 | 0 | 0 | 0 | 449 | [startup-final.log](startup-final.log) |
| regression1-final | `592d0065` | 142 | 0 | 0 | 0 | 719 | [regression1-final.log](regression1-final.log) |
| regression2-final | `592d0065` | 59 | 0 | 0 | 0 | 308 | [regression2-final.log](regression2-final.log) |
| integrated-final | `592d0065` | 95 | 0 | 0 | 0 | 618 | [integrated-final.log](integrated-final.log) |
