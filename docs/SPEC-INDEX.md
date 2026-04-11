# agent-com 仕様書インデックス

> 最終更新: 2026-04-10
> agent-com 仕様書の索引です。

---

## 有効な仕様書

| ファイル | バージョン | 内容 | 最終更新 |
|----------|-----------|------|----------|
| agent-com-message-queue-spec.md | v1.0.2 | 統合メッセージキュー仕様（コア）— PollingDriver 内蔵化 / cron 廃止 | 2026-04-12 |
| agent-com-attachment-spec.md | v0.1.0 | ファイル添付の送受信仕様 | 2026-04-08 |
| agent-com-chat-ui-sync-spec.md | v0.1.0 | Discord↔DB同期仕様 | 2026-04-07 |
| SPEC-INDEX.md | — | 本ファイル | 2026-04-10 |

---

## 各仕様書のスコープ

### message-queue-spec.md（コア仕様、全22セクション）
- 全体アーキテクチャ（receiver + CLI + message_queue）
- DBスキーマ（agent_messages, message_queue, outbound_queue, agents, channels）
- CLIコマンド仕様（next / send / notify / status / heartbeat / agents / history / inbox）
- MCP Tools（CLIラッパー）
- 各CLI利用方法（Claude Code / Codex CLI / Gemini CLI）
- Receiver（inbound / outbound / heartbeat監視）
- routeInbound（純粋関数）
- Bot状態管理（idle / busy / disconnected）+ フィードバック
- メンション制御（検証 / 提案 / 変換）
- メッセージパターン（通常返信 / 自発送信 / システム通知）
- エラーコード一覧
- セキュリティ
- PostgreSQL / SQLite両対応
- Presence Client
- 移行戦略（Mixed Mode）
- agent-memory連携
- 監視
- v0.2.0精度向上（Push Enrichment / Dispatcher）
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
| seed/init仕様 | agent-com init, seed.ts, bot-registry.txt | 中 | OSS公開準備時 |
| OSS公開計画 | README, デモGIF, ライセンス | 高 | OSS公開前 |
