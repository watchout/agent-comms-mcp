# agent-com 仕様書インデックス

> 最終更新: 2026-06-01
> **Canonical source: GitHub** (`docs/`)。gdrive は read-only mirror。
> agent-com 仕様書の索引です。

---

## 有効な仕様書

| ファイル | バージョン | 内容 | 最終更新 |
|----------|-----------|------|----------|
| agent-com-message-queue-spec.md | v2.0.0 | 統合メッセージキュー仕様（コア）— OSS primary / SQLite default / 1 daemon 集約 / LLM-agnostic / Reply Chain Context (Phase C 再定義 CEO 承認) | 2026-04-17 |
| agent-com-source-awareness.md | v1.1.0 (PROPOSED) | source-aware routing / Single-Recipient 拡張仕様（実装着手は Phase C 完了後） | 2026-04-16 |
| agent-com-attachment-spec.md | v1.0.0 | ファイル添付の送受信仕様 — receiver + message_queue + outbound_queue ベース | 2026-04-17 |
| agent-com-chat-ui-sync-spec.md | v0.1.0 | Discord↔DB同期仕様（新 Phase C 条件で scope 再評価予定） | 2026-04-07 |
| phase-c-redef-approval.md | — | Phase C 完了条件の再定義 (CEO 承認 2026-04-17) | 2026-04-17 |
| wave-rollout-rules.md | provisional | Phase C aun deployment の operational contract — wave 1-3 entry/exit/rollback、`回帰なし` metric set、completion judgment (PR #254) | 2026-04-27 |
| design/script-driven-receive-runner.md | proposed | script-driven receive/process/completion runner — DB状態遷移をLLM tool choiceから分離 | 2026-05-15 |
| design/aun-agent-communication-control-plane-charter.md | normative | AUN送受信系をagent communication control planeとして再設計するためのmessage/delivery/baton/turn/handoff不変条件 | 2026-05-31 |
| design/aun-agent-communication-control-plane-wbs.md | working breakdown | runtime非依存control-plane、targeted receive runner、turn ledger、typed completion、doctor/preflightの実装WBS | 2026-06-01 |
| spec/aun-conversation-identity-baton-contract.md | pre-implementation contract | `1 open conversation = 1 active baton` を実装可能にするconversation key、observer visibility、fanout/escalation/baton close前提 | 2026-05-31 |
| design/aun-enterprise-control-plane-direction.md | directional | AUNをdurable agent control plane / agent operations meshとして進めるための市場・標準・設計制約 | 2026-05-26 |
| design/aun-normalization-roadmap.md | normative | AUN正常化のMVP/v1/v2フェーズゲート、PR分解、完了判定、2026-05-27 MVP実行境界 | 2026-05-27 |
| spec/aun-canonical-channel-id-control-plane-contract.md | proposed | scripted/control-plane送信でchannel_idを正本にし、channel name aliasを人間向け明示解決に限定する契約 | 2026-05-31 |
| spec/aun-send-notify-owner-observer-contract.md | proposed | send/notifyを1 active owner + cc/fyi observerに固定し、multi-active fanoutを禁止するSlice 2実装契約 | 2026-05-31 |
| spec/aun-runtime-runner-adapter-contract.md | CP-40B implementation contract | Codex/Claudeなどruntime差分をadapter境界へ閉じ込め、exact queue_id・queue/baton context・typed runner resultを共通化する契約 | 2026-06-01 |
| spec/aun-host-runtime-invocation-adapter-contract.md | proposed | `codex exec --json --output-schema` / `claude -p --output-format stream-json --json-schema` をhost CLI adapter profileとして固定するCP-40D契約 | 2026-06-01 |
| spec/aun-canonical-message-presentation-contract.md | proposed | transport chunkや長文分割を複数runtime taskにしないcanonical message presentation契約 | 2026-06-01 |
| spec/aun-agent-turn-ledger-contract.md | proposed | runtime起動前にqueue/baton/lease/heartbeat/deadlineをdurable turn evidenceとして記録するCP-50A契約 | 2026-06-01 |
| spec/aun-typed-completion-outcome-contract.md | proposed | runtime proseからlifecycleを推測せず、reply/no-reply/handoff/escalate/retry/quarantineをtyped outcomeで適用するCP-60契約 | 2026-06-01 |
| spec/aun-control-plane-doctor-preflight-contract.md | proposed | loop/drain/split/stale/duplicate/quarantine等を検出し、state_daemon/scheduler activationをfail-closedするCP-70契約 | 2026-06-01 |
| spec/aun-scheduler-activation-canary-contract.md | proposed | state_daemon/scheduler activationとDiscord canaryをexact scope・lease・preflight・rollback evidenceでgateするCP-80契約 | 2026-06-01 |
| spec/aun-runtime-supervisor-adapter-contract.md | proposed | #602 reboot recoveryでAUN coreとhost-specific supervisor adapterの境界、typed capabilities、endpoint evidenceを固定する契約 | 2026-06-02 |
| operations/aun-bounded-canary-approval-pack.md | runbook | #602復旧直前のbounded canary/live smoke承認packet、evidence capture、rollback trigger checklist | 2026-06-02 |
| operations/codex-runner-activation-runbook.md | runbook | #422 Codex runner activation のread-only evidence packet、approval request、recovery-proof、rollback trigger | 2026-06-08 |
| spec/aun-local-supervisor-adapter-implementation-plan.md | proposed | #602/#603 local launchd/tmux supervisor adapter、persistent path、atomic LaunchAgent update dry-run計画 | 2026-06-02 |
| operations/aun-full-recovery-runbook.md | runbook | #602 terminal reboot後のAUN full recovery GO/NO-GO、queue wake-up、Discord/state_daemon復旧policy | 2026-06-02 |
| operations/aun-recovery-final-approval-packet.md | runbook | #602復旧実行前の最終承認packet、kodama token rotation安全確認、live smoke request template | 2026-06-02 |
| spec/norm-022-runtime-endpoint-lease-supervisor-adapter-impl.md | pre-implementation audit next | tmuxではなくruntime endpoint leaseを正本にするMVP実装契約 | 2026-05-27 |
| plans/norm-022-runtime-endpoint-lease-impl-plan.md | pre-implementation audit packet | NORM-022 implementation order, audit questions, stop conditions, POST_MERGE evidence | 2026-05-27 |
| SPEC-INDEX.md | — | 本ファイル | 2026-06-01 |

---

## 各仕様書のスコープ

### message-queue-spec.md（コア仕様、v2.0.0、全20セクション）
- 設計原則（OSS primary / 1 daemon / DB-only / LLM-agnostic / deterministic routing / polling 統一 / cross-DB / Reply Chain Context）
- 全体アーキテクチャ（1 daemon プロセス構成 + データフロー）
- DBスキーマ（agent_messages, message_queue, outbound_queue, agents, channels）
- CLIコマンド仕様（next / send / notify / status / heartbeat / agents / history / inbox）
- LLM Integration（汎用パターン / MCP 設定例 / Daemon プロセスモデル）
- Receiver（inbound / outbound / heartbeat監視）
- routeInbound（純粋関数、deterministic routing）
- Bot状態管理（idle / busy / disconnected）+ フィードバック
- メンション制御（検証 / 提案 / 変換）
- メッセージパターン（通常返信 / 自発送信 / システム通知）
- エラーコード一覧
- セキュリティ
- PostgreSQL / SQLite両対応
- Phase C 完了条件（CEO 承認 2026-04-17、5 条件）
- CLI Setup（Quick Start / .env テンプレート）
- agent-memory連携
- 監視
- 精度向上対策（Reply Chain Context）
- 設定一覧
- 廃止要素一覧

### attachment-spec.md（添付ファイル仕様、全17セクション）
- Ephemeral（一時ファイル）設計
- Inbound / Outbound双方向フロー
- 複数ファイル・部分失敗
- Bot間転送（symlink）
- reply_to元メッセージの添付参照
- サイズ制限 / MIME制限 / ファイル名サニタイズ
- DB保存（メタデータのみ）
- temp領域管理 / cleanup
- Adapter実装要件
- セキュリティ考慮事項

### chat-ui-sync-spec.md（DB↔Discord同期仕様）
- 初回インポート（Discord → DB）
- 運用同期（DB → Discord）
- 6テーブル構成（agents, agent_adapters, channels, channel_adapters, threads, thread_adapters）
- access.json完全廃止

### design/aun-normalization-roadmap.md（AUN正常化ロードマップ）
- AUN正常化をMVP/v1/v2のフェーズゲートで管理する
- DB正本、runtime/workspace/connector、token一意性、queue安全性、channel assignment、state-daemon、smoke/auditのMVP完了条件を固定する
- 実装PRをNORM/REG/CONN/LEASE/AUTH/TRAN/EXT/OBS sliceに分解する
- 「見つかった不整合を都度直す」進め方を禁止し、phase/slice分類後に実装する
- 2026-05-27時点の現在phaseはMVP内部正常化とし、enterprise control plane基準のうち内部fleet正常化に必要な範囲だけを実装対象にする
- 各sliceは `spec -> impl contract/plan -> pre-implementation audit -> implementation -> implementation audit -> merge -> POST_MERGE verification` の順で進める

### design/aun-agent-communication-control-plane-charter.md（Agent Communication Control Plane Charter）
- AUNをjob queueやchat bridgeではなくagent communication control planeとして固定する
- `message -> delivery -> conversation -> baton -> agent turn -> reply | handoff | close | no-reply | retry | quarantine` を送受信系の正本モデルにする
- `1 open conversation = 1 active baton`、`1 active baton = 1 responsible agent` をproduct invariantにする
- LLMにqueue claim、baton ownership、close、retry、recovery状態を決めさせず、deterministic codeとDB audit eventで進める
- send/notifyはactive ownerとobserverを分離し、`mention`は1 active owner、`cc`/`fyi`はqueue/baton非投入にする
- core communication semanticsは `spec PR -> L1 -> L2 -> L3`、`implementation PR -> L1 -> L2 -> L3 -> merge` の監査ゲートを必須にする

### design/aun-agent-communication-control-plane-wbs.md（Control Plane WBS）
- charter/各slice specを実装順に落とし込み、PR/audit中に最終地点がぶれないようにする作業台帳
- Codex/Claude/OpenClawなどruntime差分をadapter境界へ閉じ込め、queue/baton/turn/completionの状態機械を共通化する
- CP-40Aとして exact `queue_id` claim を必須化し、監査や復旧のためにFIFOを引き続ける運用を禁止する
- CP-40Cとしてtransport chunkや長文分割が複数の独立runtime taskにならないcanonical message presentationを要求する
- CP-50/CP-70としてagent turn ledger、typed completion、loop/drain defect doctor、state-daemon activation gateを実装対象に固定する

### spec/aun-canonical-channel-id-control-plane-contract.md（Canonical Channel ID Control-Plane Contract）
- scripted/control-plane送信は `channel_id` を正本にし、channel nameを暗黙解決しない
- channel name aliasは人間向けCLIの明示解決に限定し、解決結果の `channel_id` とcandidate countを監査ログに残す
- `thread_id` / `message_id` / `queue_id` は同じchannel/thread scopeに属することをDBで検証してから書き込む
- provider channel idはconnector evidence経由でcanonical `channel_id` に解決し、文字列形状から推測しない
- `CHANNEL_ID_REQUIRED`、`CHANNEL_ALIAS_NOT_ALLOWED`、`THREAD_CHANNEL_MISMATCH` などの安定failure codeと必須テストを定義する

### spec/aun-conversation-identity-baton-contract.md（Conversation identity / baton contract）
- `conversation` をAUN-owned logical work threadとして定義し、Discord channel/threadやqueue rowをprimary identityにしない
- conversation keyの構成要素、root/reply/observer/fanout/escalationの決定規則を固定する
- observer visibilityはread-only projection/audit/non-claimable deliveryに限定し、`next`/receive-runner/baton countに入れない
- explicit fanoutはparent conversationからchild conversationを作り、各childに独立batonとparent audit linkを持たせる
- baton schema sliceがunique active baton guard、handoff transfer、`done`非terminal扱いを実装できる前提を固定する

### spec/aun-send-notify-owner-observer-contract.md（Send/Notify Owner-Observer Contract）
- AUN Control Plane Slice 2としてsend/notifyのactive ownerとobserverを分離する
- `mention`を唯一のactive owner入力にし、`mentions[]`はlegacy単一owner aliasに限定する
- `mentions[]`が複数active ownerに解決される場合は `MULTI_ACTIVE_RECIPIENT_UNSUPPORTED` でfail closedする
- `cc[]` / `fyi[]` はobserver visibilityのみで、`message_queue` rowやbatonを作らない
- observer visibilityはMVPではprojection/body suffix/metadataに限定し、将来のobserver receipt tableも非claimableでなければならない

### spec/aun-runtime-runner-adapter-contract.md（Runtime Runner Adapter Contract）
- CP-40BとしてCodex/Claude/OpenClawなどruntime差分をadapter境界に限定する
- adapter inputはexact `queue_id`、queue context、conversation/baton contextを持つ同一shapeにする
- adapter outputはtyped runner resultで、free-form runtime proseをlifecycle outcomeにしない
- Codex adapterは `aun codex-runner --queue-id <id>` を必ず使い、FIFO drainで対象rowに到達しない
- Claude/future runtimeも同じqueue/baton state machineを使い、launch/IO/timeout/parserだけを差し替える

### spec/aun-host-runtime-invocation-adapter-contract.md（Host Runtime Invocation Adapter Contract）
- CP-40DとしてCP-40Bの下にhost CLI invocation profileを定義する
- Codexは `codex exec --json --output-schema --output-last-message` をprimary pathにする
- Claude Codeは `claude -p --output-format stream-json --json-schema` をprimary pathにする
- untrusted contextをshell argvやprompt argへ補間せず、stdin/file/context refsで渡す
- unsupported flags、malformed stream、schema mismatch、timeout、non-zero exitをtyped evidenceにする
- TUI injectionはdegraded fallbackのみで、scheduler activationやrecovery successの証拠にしない

### spec/aun-canonical-message-presentation-contract.md（Canonical Message Presentation Contract）
- CP-40Cとしてtransport chunkやprovider/UIの長文分割をprojection concernに限定する
- 1 logical instructionが1 active ownerに対して高々1つのclaimable runtime taskを作る不変条件を固定する
- fragment rowは非claimable、または`message_queue`に入れず、canonical message / presentation groupへ戻す
- receive runnerは`queue_id` claim後にfragment groupを検証し、runtimeには1つのcanonical bodyだけを渡す
- incomplete/conflicting groupは`PRESENTATION_GROUP_INCOMPLETE`や`PRESENTATION_GROUP_CONFLICT`でfail closedする
- deliberate fanoutはtransport chunkから推論せず、parent/child linkを持つtyped child requestだけで扱う

### spec/aun-agent-turn-ledger-contract.md（Agent Turn Ledger Contract）
- CP-50Aとしてruntime invocation前にdurable turn rowを作成する不変条件を固定する
- turn rowは`queue_id`、`message_id`、`agent_id`、runtime kind、lease/fencing token、heartbeat/deadline、conversation/batonを記録する
- 1 queue row / 1 active baton に対して active turn は高々1つにする
- `received -> in_progress` は turn row 作成後、runtime adapter起動前に実行する
- stale turn recovery は既存turnを`stale_reclaimed`または`quarantined`へ閉じてから新turnを作る
- `worker_activity`はoperator visibilityであり、必須field/invariantを満たさない限りturn ledgerの代替にしない

### spec/aun-typed-completion-outcome-contract.md（Typed Completion Outcome Contract）
- CP-60としてruntime free-form proseからqueue/baton lifecycleを推測しない不変条件を固定する
- completion outcomeは`turn_id`、`queue_id`、`message_id`、`agent_id`、runtime kind、conversation/batonを持つdurable typed resultにする
- `reply`、`no_reply`、`handoff`、`escalate`、`retry`、`quarantine`を相互排他的なoutcomeとして定義する
- replyはoutbound send成功またはtyped send failure evidenceなしにterminal扱いしない
- no-reply/handoff/escalate/retry/quarantineはそれぞれreason、target、child request、bounded retry、repair actionを必須にする
- completion runnerはtyped outcomeを適用し、runtime proseにqueue close、baton transfer、retry、quarantineを直接決めさせない

### spec/aun-control-plane-doctor-preflight-contract.md（Control-Plane Doctor And Preflight Contract）
- CP-70としてruntime/scheduler activation前のdoctor/preflight不変条件を固定する
- doctor findingはstable code、severity、gate、subject id、evidence、repair hintを持つstructured resultにする
- loop prompt、drain-to-target、split request、stale turn、duplicate active turn/baton、missing outcome、quarantine、projection stallをblocker候補にする
- repair commandはdry-run first、exact durable id必須、active row修復は明示override必須、bulk active closure禁止にする
- repairはaudit evidenceを書き、`next`/`inbox`/runtime prompt/state_daemon restartを修復手段にしない
- clean preflight は CP-80 scheduler activation の必要条件であり、十分条件ではない

### spec/aun-scheduler-activation-canary-contract.md（Scheduler Activation And Discord Canary Contract）
- CP-80としてstate_daemon/scheduler activationをexact scope、lease、preflight、canary evidenceでgateする
- activation scope は agent ids、channel ids、runtime kinds、runner phases を明示し、fleet-wide first activationを禁止する
- canary は receive/process/completion/projection/audit の順にDB evidenceを確認してから拡張する
- Discord は projection surfaceであり、DB queue/conversation/baton/turn/completion evidenceが正本である
- rollback trigger は scheduler scopeをpause/disableし、行削除・bulk active close・prompt injection・restart repairを禁止する
- expansion は fresh preflight と prior canary evidence を必要条件にする

### spec/aun-discord-projection-diagnostic-contract.md（Discord Projection Diagnostic Contract）
- #604としてDiscord direct deliveryとAUN/router fallbackの判定をread-only診断JSONに固定する
- default gateはsender-direct deliveryを要求し、明示許可なしのrouter/AUN fallbackをNO-GOにする
- credential status、delivery connector、channel binding、provider write capability、fallback reason、decision sourceをmachine-readable evidenceとして出す
- runtime login credential statusとdelivery eligible credential statusの契約を同じreportに出し、driftをGO/NO-GO判断前に検出可能にする
- GOはDB/resolver evidenceがcleanであることだけを意味し、live Discord delivery proofではない

### spec/aun-runtime-supervisor-adapter-contract.md（Runtime Supervisor Adapter Contract）
- #602としてfull reboot recoveryをtmux、launchd、Claude Code、Codex CLI、特定session appへ依存させない境界を固定する
- AUN coreはdesired runtime state、identity、endpoint evidence、queue readiness、wake-up semantics、health/readiness definitionsを所有する
- runtime supervisor adapterはhost-specific process/session controlを所有し、coreはtyped evidenceを消費する
- wake/start/restart等はtyped capabilitiesで表現し、restartはcapabilityと明示approvalなしにNO-GOにする
- local tmux/launchdは最初のadapter例であり、systemd、Kubernetes、Nomad、Docker Compose、MDM desktop agent、managed runnerを将来adapterとして許容する

### operations/aun-bounded-canary-approval-pack.md（Bounded Canary Approval Pack）
- #602復旧直前のlive smoke承認requestを、実行ではなくread-only evidence packetとして準備する
- exact agent/channel/runtime scope、`max_canary_count: 1`、`fallback_allowed:false`、no FIFO drainを固定する
- CP-70 preflight、CP-80 readiness、CP-80 activation-plan、Discord projection diagnostic、state-daemon readiness、queue-processing readiness、state-daemon install-plan dry-runのGO evidenceを必須入力にする
- rollback triggerとしてFIFO drain、loop prompt、wrong listener、Discord fallback、projection evidence missing、stuck/duplicate active work、prompt-driven next/inboxを固定する
- Discord visibility alone is not success; DB/projection/connector/audit evidenceを成功条件にする

### operations/codex-runner-activation-runbook.md（Codex Runner Activation Runbook）
- #422 R5としてCodex runner activation前のoperator approval packetを固定する
- exact agent/channel/runtime/phases、`max_canary_count:1`、`fallback_allowed:false`、production mutation禁止をscope条件にする
- queue preflight、state-daemon queue readiness、runner preflightまたはreceive-actionable dry-run、projection diagnosticをread-only evidenceにする
- recovery-proof/v1 artifactでqueue/message/routing/claim/runner_result/terminal/projection evidenceを結合する
- rollback triggerとしてidentity mismatch、FIFO drain、prompt injection、missing runner result、missing projection、secret/payload leakを固定する

### operations/aun-recovery-final-approval-packet.md（Recovery Final Approval Packet）
- #602復旧実行前の最終approval materialを固定する
- kodamaのtoken rotation safety checkをDB-first / non-secret evidenceとして要求する
- `agent-com-api-keys:Kodama_token` が唯一のactive/registered credential refで、旧mcp-json `DISCORD_BOT_TOKEN` がrevoked/disabledであることをGO条件にする
- CP-70/CP-80/Discord projection/state-daemon readiness/queue-processing readiness/install-plan/gate summary artifactを必須入力にする
- live smoke requestはone channel / one agent / one message / max_canary_count:1 / fallback_allowed:false / no automatic retryに限定する

### spec/aun-local-supervisor-adapter-implementation-plan.md（Local Supervisor Adapter Implementation Plan）
- #602/#603として#669 runtime supervisor adapter contractの最初のlocal implementation sliceを定義する
- local launchd adapterはstate_daemonのProgramArguments、WorkingDirectory、persistent checkout/build artifact、LaunchAgent plist、listener identityをtyped evidenceに変換する
- optional tmux inspectorはsession presence/current path evidenceのみを返し、queue処理権限やrecovery機構にはしない
- atomic LaunchAgent updateはdry-run planとして表現し、write/rename/load/startは別approval付きexecution sliceに分離する
- active LaunchAgentが参照するcheckout/build pathはcleanupからprotectし、`/private/tmp`等のvolatile pathはNO-GOにする

### spec/aun-state-daemon-queue-processing-readiness-contract.md（State-Daemon Queue Processing Readiness Contract）
- #603としてDiscord transport healthとqueue-processing readinessを分離したread-only診断を固定する
- state-daemon/launchd/process/path/fatal stderrを`transport_readiness`に、pending/active/wake state/stuck agent evidenceを`queue_processing_readiness`に分ける
- `STATE_DAEMON_TRANSPORT_NOT_READY`と`QUEUE_WAKE_STUCK`を明示blockerとして出す
- DB SELECTとread-only runtime inspectionのみを許可し、smoke row insert、`next`/`inbox`、launchctl mutation、state_daemon restart、Discord writeを禁止する
- GOはread-only evidence cleanを意味するだけで、live queue wake smokeやrestart承認ではない

### operations/aun-full-recovery-runbook.md（Full AUN Recovery Runbook）
- #602としてterminal reboot後の復旧をdocs-only GO/NO-GO sequenceに固定する
- CP-70 doctor、CP-80 recovery readiness、CP-80 activation-plan dry-runの順に復旧可否を判定する
- #603 LaunchAgent/persistent path診断・queue-processing readiness診断と#604 Discord projection診断をread-only evidenceとして位置づける
- queue wake-upはTUI prompt injection、`next`、`inbox`、FIFO drainを禁止し、bounded runner / exact queue-id / canary-firstに限定する
- state_daemon restart、launchctl bootstrap/kickstart、Discord live writeはreadiness GOとactivation plan GO後の明示approvalまで禁止する

### design/aun-enterprise-control-plane-direction.md（AUN enterprise control plane方向）
- AUNの市場カテゴリをdurable agent control plane / agent operations meshとして固定する
- Discord、tmux、local path、provider tokenをcore identityにしない設計制約を定める
- MCP Streamable HTTP、OAuth/OIDC、A2A、OpenTelemetry、CloudEvents、Zero Trustへの将来整合を方向づける
- 内部Discord安定化を将来のenterprise control planeの第一local deploymentとして扱う

### spec/norm-022-runtime-endpoint-lease-supervisor-adapter-impl.md（Runtime endpoint lease）
- MVP内部正常化でruntime endpoint leaseを正本にする
- tmux、launchd、systemd、container、remote workerをsupervisor adapterとして扱う
- port/Unix socket/stdio/remote URLを同じendpoint modelに載せる
- cleanup/restartはstale heartbeat、endpoint lease、fencing evidenceなしにport killしない
- channel数とsession数を分離し、channelごとのsession必須化を禁止する
- 次のgateはpre-implementation auditで、実装merge後はPOST_MERGE evidenceを記録する

### plans/norm-022-runtime-endpoint-lease-impl-plan.md（NORM-022実装計画）
- NORM-022の実装順序、監査質問、stop condition、POST_MERGE evidenceを固定する
- pre-implementation auditの依頼packetとして使う

---

## 廃止済み仕様書（削除対象）

| ファイル | 廃止理由 | 代替 |
|----------|----------|------|
| agent-com-core-design.md | message-queue-specに統合 | §2, §8 |
| agent-com-webhook-architecture.md | message-queue-specに統合 | §2, §7 |
| channel-thread-control-spec.md | message-queue-specに統合 | §4, §8, §10-12 |
| agent-com-receiver-architecture.md | message-queue-specに統合 | §7 |
| agent-com-receiver-architecture (1).md | 上記の重複 | — |

---

## プロジェクトナレッジとの対応

Claude.aiプロジェクトナレッジにも以下を反映する：

| プロジェクトナレッジ | 対応する仕様書 | アクション |
|---------------------|---------------|-----------|
| agent-com-core-design.md | 廃止 | 削除 |
| agent-com-webhook-architecture.md | 廃止 | 削除 |
| channel-thread-control-spec.md | 廃止 | 削除 |
| agent-com-chat-ui-sync-spec.md | 維持 | そのまま |
| agent-com-attachment-spec.md | 維持 | そのまま |
| agent-com-receiver-architecture.md | 廃止 | message-queue-specで置換 |
| agent-com-message-queue-spec.md | 新規追加 | 追加 |

---

## 未作成の仕様書（将来）

| 仕様書 | 内容 | 優先度 | タイミング |
|--------|------|--------|-----------|
| adapter仕様 | Discord以外（Telegram, Slack）対応 | 低 | 他プラットフォーム対応時 |
| watchdog仕様 | Check 1-5, grace period, 再起動ロジック | 中 | 現行シェルスクリプトの正式化時 |
| seed/init仕様 | `npx agent-comms-mcp init` — token 入力 + SQLite 作成 | **高** | Phase C (v2.0.0) |
| OSS公開計画 | README, デモGIF, ライセンス | 高 | Phase C 完了後 |
