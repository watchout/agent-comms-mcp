# agent-com 仕様書インデックス

> 最終更新: 2026-05-24
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
| design/aun-normalization-roadmap.md | normative | AUN正常化のMVP/v1/v2フェーズゲート、PR分解、完了判定 | 2026-05-24 |
| SPEC-INDEX.md | — | 本ファイル | 2026-04-27 |

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
