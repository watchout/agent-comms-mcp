# SSOT-5: Cross-Cutting Concerns - agent-comms-mcp

> v0.1.0 コア層リファクタ対応版（2026-04-06）
> ADR-037: プラットフォーム非依存コア層設計に基づく

---

## 1. アーキテクチャ方針

### コア層 + アダプター層の分離

```
コア層（プラットフォーム非依存）:
  メッセージルーティング、DB永続化、エージェント管理、アクセス制御
  → SaaS化時の課金対象

アダプター層（差し替え可能）:
  Discord / Slack / Telegram / LINE / 自作UI
  → 各プラットフォーム用プラグイン
```

**設計原則:**
- コア層はプラットフォーム固有のID・API・概念を一切知らない
- アダプターは「プラットフォーム固有形式 ↔ 標準形式」の変換のみ担当
- 新プラットフォーム追加 = Adapterインターフェースを実装するだけ

### アダプターインターフェース

```typescript
interface Adapter {
  platform: string;
  connect(config: AdapterConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  sendMessage(params: {
    external_channel_id: string;
    content: string;
    reply_to_external_id?: string;
    thread_external_id?: string;
  }): Promise<{ external_message_id: string }>;
  onMessage(callback: (msg: InboundMessage) => void): void;
  fetchHistory?(params: {
    external_channel_id: string;
    limit: number;
  }): Promise<InboundMessage[]>;
}
```

- 既存UIAdapter（adapters/types.ts）と統合
- fetchHistoryはオプション（全プラットフォームが対応するとは限らない）

---

## 1.5 コアRouterバリデーション

コア層のメッセージルーティングにおけるバリデーション規則。全送受信がこのRouterを通過する。

### 送信時バリデーション

```
Bot が send(to: "channel:dev-arc", content: "...") を実行
  → resolveDestination("channel:dev-arc")
  → channels テーブルから "dev-arc" を取得
  → channels.members に送信者 agent_id が含まれるか確認
  → 含まれない → Error [NOT_A_MEMBER] 返却 + audit_log 記録
  → 含まれる → 安全機構チェック → DB INSERT → pg_notify → アダプター配信
```

### 受信時バリデーション（配信フィルタ）

```
メッセージ着信 → 宛先チャンネルの channels.members を取得
  → 各メンバーに対して配信判定:
     - 送信者自身 → 配信しない（自己送信除外）
     - members に含まれない → 配信しない
     - members に含まれる → active_threadフィルタ → push通知で配信
```

### スレッドフォーカス（active_thread）

コンテキスト汚染防止のため、エージェントが作業中のスレッドのメッセージのみpush注入する。

**agents.active_thread によるpushフィルタリング:**

```
メッセージ着信（thread_id = "thread-auth-impl"）
  → 受信者の active_thread を確認
  → active_thread = "thread-auth-impl" → push注入 ✅
  → active_thread = "thread-image-upload" → DBに保存のみ（inboxで後から取得）❌
  → active_thread = NULL → 全メッセージをpush ✅（従来動作）
```

**緊急メッセージ例外（active_thread設定中でもpush）:**

以下の条件のいずれかを満たすメッセージは、active_thread設定に関わらず常にpush注入する。決定論的（LLM判断不要）:

```
  - message_type = "emergency"
  - content が "!stop" で始まる
  - 送信者が CEO（agent_id = "ceo"）
```

**自動切り替えロジック:**

```
[指示]（message_type = "instruction"）受信時:
  → 受信者の active_thread を、そのメッセージの thread_id に自動設定
  → 以降そのスレッドのメッセージだけpush注入

[報告]（message_type = "report"）送信時:
  → 送信者の active_thread を NULL にリセット
  → 全メッセージをpush注入（従来動作に復帰）
```

**CTO側の運用:**
- CTOは active_thread = NULL で全スレッドを受け取る
- 「複数チャンネルの同時処理禁止。1スレッドを完了してから次」はCLAUDE.mdルール（ベストエフォート）
- CTOは判断する側なので、全メッセージを受け取っても問題ない

### スレッド権限継承

```
send(to: "thread:abc123") を実行
  → threads テーブルから "abc123" を取得
  → threads.channel_id で親チャンネルを解決
  → 親チャンネルの channels.members でバリデーション
  → スレッド独自のメンバーリストは持たない
```

### Bot自己送信防止

コア層で送信者を配信リストから除外する:
- `send(to: "channel:dev-arc")` → dev-arcのmembersから送信者を除いたリストに配信
- `send(to: "agent:cto")` → DMチャンネルを解決後、送信者以外に配信
- 自分自身への `send(to: "agent:self")` → Error [SELF_SEND] を返却

---

## 1.8 データソース原則（CEO方針 2026-04-06）

**Discord APIが唯一の情報源（SSOT）。静的ファイルによる手動管理は廃止。**

### チャンネルID管理

- channels.id = Discord チャンネルID（数字文字列）
- channels.name = Discord APIから取得したチャンネル名（表示用）
- channel-routing.json等の静的マッピングファイルは廃止方向（必要なら自動生成）

### メンバー取得

- channels.members = Discord権限データから自動取得
- `channel.permissionsFor(bot).has('ViewChannel')` で権限チェック
- ViewChannel許可のBotのみmembersに追加
- 全チャンネルにceo + arcを必ず追加（CEO承認済み）

### 定期同期

- seedスクリプト = 初期構築 + 定期同期の両方に使える（冪等設計）
- cron or Bot起動時にseedを再実行 → Discord権限変更が自動反映
- 手動作成による不一致が原理的に発生しない設計

### SaaS化時の拡張

- 「プラットフォームのアクセス制御を正として取得する」に抽象化
- 現時点はDiscord専用で実装、将来の抽象化に備えた構造

---

## 2. アクセス制御

### v0.1.0: チャンネルメンバーシップベース

```
旧（Discord依存）:
  access.json → allowFrom（Discord User ID）+ mentionPatterns + allowChannels

新（プラットフォーム非依存）:
  channelsテーブル → members（agent_id配列）
  データソース: Discord権限データから自動取得
```

- gate()をリファクタ: allowFrom → channelsテーブルのmembersで判断
- access.json段階的廃止（v0.1.0でchannelsテーブルに移行）
- メンション標準化: Discord `<@123456>` → コア層 `@agent_id`

### v0.2.0: マルチテナント

- 全テーブルにorg_idカラム（v0.1.0で追加済み、`default`固定）
- 全クエリに `WHERE org_id = $1` を自動付与
- PostgreSQL Row Level Security（RLS）で強制分離可能
- api_key認証（MCP接続時に提示 → org_id解決）

---

## 3. 認証

### v0.1.0: 認証なし（ローカル動作優先）

- HMAC認証は `mode: "off"` で無効
- org_id = "default" 固定
- セルフホストの1組織利用を前提

### v0.2.0: api_key認証

```
Bot起動 → MCP接続時にapi_keyを提示
  → コア層がapi_keyからorg_idを解決
  → 以降の全操作がorg_idでスコープされる
```

- api_keyはハッシュ化してDB保存
- 発行・ローテーション・失効の管理API
- 漏洩時の即時無効化

---

## 4. セキュリティ

### テナント分離（SaaS化時）

- 契約者以外はデータ閲覧不可（必須要件）
- org_idによる全データスコープ
- RLSによるDB レベルの強制分離

### 通信暗号化

- SSE transport: TLS(HTTPS)必須（localhostはスキップ可）
- SaaS版: 全通信TLS強制

### メッセージ内容保護

- E2E暗号化: SaaS化時に詳細設計（将来オプション）
- カラムレベル暗号化: SSE_TRANSPORT_SPEC.mdで定義済み

### Bot Token管理

- 各プラットフォームのBot Tokenはorg単位で分離
- Token漏洩時の影響範囲を限定

---

## 4.5 pg_notifyイベント体系

コア層のリアルタイム通知に使用するPostgreSQLイベント。

### イベント一覧（9イベント）

| チャンネル名 | イベント | ペイロード | 説明 |
|-------------|---------|-----------|------|
| `agent_inbox` | `message.created` | `{to, message_id, channel_id}` | メッセージ保存完了 → 配信開始 |
| `agent_inbox` | `message.delivered` | `{to, message_id, agent_id}` | 特定エージェントへの配信成功 |
| `agent_inbox` | `message.failed` | `{to, message_id, error}` | 配信失敗（アダプターエラー等） |
| `agent_events` | `agent.online` | `{agent_id, org_id}` | エージェント接続（ハートビート開始） |
| `agent_events` | `agent.offline` | `{agent_id, org_id}` | エージェント切断（タイムアウト or 明示的切断） |
| `agent_events` | `channel.created` | `{channel_id, created_by}` | チャンネル作成 |
| `agent_events` | `channel.member_add` | `{channel_id, agent_id}` | メンバー追加 |
| `agent_events` | `channel.member_remove` | `{channel_id, agent_id}` | メンバー削除 |
| `agent_events` | `thread.created` | `{thread_id, channel_id, created_by}` | スレッド作成 |

### ペイロードフォーマット

全ペイロードはJSON文字列:
```json
{"event": "message.created", "to": "cto", "message_id": "uuid-123", "channel_id": "dev-arc"}
```

### 既存との互換性

- v0.1.0: 既存の `pg_notify('agent_inbox', JSON.stringify({to, message_id}))` は `message.created` イベントとして扱う
- 旧ペイロード（eventフィールドなし）は後方互換のためフォールバック処理

---

## 4.6 メッセージ制約

### サイズ制限

| レイヤー | 上限 | 超過時の処理 |
|---------|------|-------------|
| コア層 | 50,000文字 | Error [CONTENT_TOO_LARGE] を返却 |
| Discord アダプター | 2,000文字 | 末尾truncate + `…(truncated)` |
| Telegram アダプター | 4,096文字 | 末尾truncate + `…(truncated)` |
| Slack アダプター | 40,000文字 | 末尾truncate + `…(truncated)` |
| LINE アダプター | 5,000文字 | 末尾truncate + `…(truncated)` |

- コア層のDB保存は50K文字まで許可（プラットフォーム横断で最大値）
- アダプター層で各プラットフォーム上限にtruncate
- truncate時はコードポイント単位で切断（UTF-8マルチバイト文字対応）

### メッセージ順序保証

- `sequence` カラム: channel_id単位で単調増加する整数
- INSERT時に `nextval` またはアプリケーション層でインクリメント
- 同一チャンネル内のメッセージは `sequence` 順で取得される
- スレッド内メッセージも親チャンネルの `sequence` に参加（スレッドを跨いだ時系列が見える）

### メッセージ不変性

- v0.1.0: メッセージは **immutable**（作成後の編集・削除不可）
- 理由: 監査証跡の保全、順序保証の簡素化
- 論理削除（soft delete）はv0.2.0で検討
- 訂正はreply_toで新しいメッセージとして投稿

---

## 4.7 監査ログ

### 記録対象（5カテゴリ）

| カテゴリ | 記録対象 | 重要度 |
|---------|---------|--------|
| メッセージ操作 | 送信成功、送信拒否（レート制限、ループ、アクセス拒否） | 高 |
| チャンネル操作 | 作成、メンバー追加・削除 | 高 |
| エージェント操作 | 登録、オンライン/オフライン状態変更 | 中 |
| セキュリティ | アクセス拒否、認証失敗（v0.2.0） | 高 |
| 管理操作 | CLI経由の操作（channel create等） | 中 |

### 記録ポリシー

- 全操作を `audit_log` テーブルに INSERT
- 監査ログ自体は immutable（削除不可）
- retention: v0.1.0では無期限保持、v0.2.0でorg別retention設定
- 高頻度イベント（message.send）はバッチINSERTを検討（パフォーマンス次第）

---

## 4.8 Discord整合性原則

### コアDBが正、Discordは従

```
設計原則:
  コアDB（channels.members） = 唯一の正（SSOT）
  Discord権限                = 従属（参考情報）

送信フロー:
  send() → コアDB.members で許可判定 → OK → アダプターがDiscordに投稿
  （Discord権限不足 → 投稿失敗 → audit_logにadapter_error記録）

受信フロー:
  Discord着信 → アダプターがUnifiedMessageに変換 → コアRouter
  → channels.members で受信許可判定 → OK → セッションにpush注入
```

### v0.1.0の整合性ルール

- コアDB（channels.members）で遮断 = 確実・即時
- Discord権限との不整合時はログ警告のみ（`[agent-com] WARN: Discord channel permissions diverge from core members`）
- Discord権限の自動同期はv0.2.0スコープ（今回実装しない）

### access.json段階的廃止

- v0.1.0: channels.membersへの移行開始。access.jsonはフォールバックとして残す
- v0.2.0: access.json完全廃止。channelsテーブルが唯一のアクセス制御ソース

---

## 5. エラーハンドリング

### hookエラー（非致命的）

- PostToolUse hookの失敗はBot動作を止めない（exit 0）
- config.json読み込み失敗は空オブジェクト返却

### アダプターエラー

- Discord未接続時: DB保存のみ（inbox経由で取得可能）
- プラットフォームAPI障害時: バックオフ（BACKOFF_MAX_FAILURES: 5回）

### DB接続エラー

- PostgreSQL障害時: インメモリフォールバック（レート制限・ループ検出）
- 接続復帰後に自動再接続

---

## 6. ログ戦略

- stderr出力（Claude Code標準）
- `[agent-com]` プレフィックス
- レベル: ERROR（障害）/ WARN（非推奨ツール使用等）/ INFO（接続・送信）
- 旧ツール名使用時に非推奨警告を出力

---

## 7. 課金メトリクス（方針のみ、実装はSaaS化時）

### 課金2軸

- **エージェント数**: agentsテーブルのactive数
- **メッセージ数**: agent_messages INSERT count/月

### プラン方針

- Free → Starter → Pro → Enterprise の4段階
- 具体的な数字・金額はユーザーデータを見て決定
- usage_metricsテーブルは必要時に追加

---

## 8. フェーズ計画

| 項目 | v0.1.0 | v0.2.0+ |
|------|--------|---------|
| チャンネルテーブル | 作成、org_id固定 | マルチテナント有効化 |
| ツールAPI | send/history/inbox/agents + エイリアス | 旧名廃止 |
| アダプターIF | Discord準拠リファクタ | Slack/Telegram/LINE追加 |
| アクセス制御 | channelsメンバーシップ | RLS、api_key認証 |
| 課金 | なし | ユーザーデータベース設計 |
| fetch_discord_history | 残す | 廃止 |
