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
