# agent-com 仕様書（SSOT）

> この文書がagent-comの唯一の正（Single Source of Truth）。
> 実装はこの仕様に従うこと。仕様変更はこの文書を先に更新すること。

## 1. プロダクト概要

### 1.1 名前
**agent-com**（旧称: agent-comms-mcp）

### 1.2 目的
Claude Codeセッション間のエージェント通信を実現する統合プラグイン。
人間-bot、bot-bot問わず、同一の通信経路で全メッセージを処理する。

### 1.3 ポジショニング
- OSS（MIT License）として公開
- 「Claude Codeに1つ入れるだけでAIエージェント組織が作れる」
- Discord/Slack/Teams/Telegram等のUIプラットフォームに対応

### 1.4 設計原則
1. **1プラグインで完結** — 追加のMCPやプラグインは不要
2. **push型通信** — LLMの「チェックしよう」判断に依存しない
3. **人間もbotも同じ経路** — 発信元の種別で通信経路を分けない
4. **DB推奨、なくても動く** — 最小構成はファイルベースで動作
5. **行動規範は守れない前提で設計** — 決定論的な仕組みで制御

---

## 2. アーキテクチャ

### 2.1 全体構造

```
統合プラグイン（agent-com）
├── UIアダプター層（交換可能）
│   ├── Discord アダプター
│   ├── Slack アダプター（将来）
│   ├── Teams アダプター（将来）
│   └── Telegram アダプター（将来）
│
├── 通信バス層（共通）
│   ├── メッセージルーティング
│   ├── access制御
│   ├── 未読管理
│   ├── push通知
│   └── 安全機構
│
└── MCP管理ツール（オプション）
    ├── 通信ログ検索
    └── 統計・分析
```

### 2.2 通信モデル

```
外部（Discord等） → UIアダプター → 通信バス → Claude Codeセッション（push注入）
                                       ↑
エージェント（bot） → 通信バス ─────────┘
                                       ↓
Claude Codeセッション → 通信バス → UIアダプター → 外部（Discord等）表示
```

- 受信: channel pluginとしてセッションに`<channel>`タグを自動注入（push型）
- 送信: reply/send_messageツールでプラットフォームに投稿
- bot間: 通信バスが直接相手セッションにpush注入。プラットフォームには可視性のためにも投稿

### 2.3 技術スタック

| レイヤー | 技術 |
|---------|------|
| ランタイム | Bun v1.0+ |
| 言語 | TypeScript 5.x |
| DB（オプション） | PostgreSQL 14+ |
| プラグイン形式 | Claude Code channel plugin + MCP tools |
| プラットフォーム連携 | Discord.js / Slack Bolt / Telegram Bot API |

---

## 3. UIアダプター層

### 3.1 インターフェース

各プラットフォームアダプターは以下を実装する：

```typescript
interface UIAdapter {
  /** プラットフォーム識別子 */
  platform: string  // "discord" | "slack" | "telegram" | "teams"

  /** プラットフォーム接続・認証 */
  connect(config: AdapterConfig): Promise<void>

  /** メッセージ受信コールバック登録 */
  onMessage(callback: (msg: UnifiedMessage) => void): void

  /** メッセージ送信 */
  sendMessage(channel: string, text: string, options?: SendOptions): Promise<void>

  /** プラットフォーム固有機能 */
  capabilities: PlatformCapabilities

  /** 切断 */
  disconnect(): Promise<void>
}

interface UnifiedMessage {
  id: string                    // プラットフォーム固有のメッセージID
  channel: string               // チャンネル識別子
  author: {
    id: string                  // 送信者ID
    name: string                // 表示名
    isBot: boolean              // bot判定
  }
  content: string               // メッセージ本文
  replyTo?: string              // 返信先メッセージID
  attachments?: Attachment[]    // 添付ファイル
  timestamp: Date               // 送信日時
  platform: string              // 発信プラットフォーム
  raw: unknown                  // プラットフォーム固有の生データ
}

interface PlatformCapabilities {
  maxMessageLength: number      // 文字数上限
  supportsThreads: boolean      // スレッド対応
  supportsReactions: boolean    // リアクション対応
  supportsAttachments: boolean  // ファイル添付対応
  supportsEdit: boolean         // メッセージ編集対応
}
```

### 3.2 Discordアダプター（初期実装）

| 項目 | 仕様 |
|------|------|
| 接続方式 | Discord.js WebSocket Gateway |
| 認証 | Bot Token（環境変数 `DISCORD_BOT_TOKEN`） |
| メッセージ上限 | 2,000文字 |
| botフィルタ | **自分自身のみ除外**（`msg.author.id === client.user?.id`） |
| メンション | プラットフォームネイティブ（`<@user_id>`） |
| スレッド | 対応 |
| リアクション | 対応 |
| 添付ファイル | 対応（25MB/件、10件まで） |

### 3.3 プラットフォーム別メッセージ制限

| プラットフォーム | 文字上限 | 超過時の処理 |
|-----------------|---------|-------------|
| Discord | 2,000 | 末尾truncate + `…(truncated)` |
| Telegram | 4,096 | 末尾truncate + `…(truncated)` |
| Slack | 40,000 | 末尾truncate + `…(truncated)` |
| LINE | 5,000 | 末尾truncate + `…(truncated)` |

---

## 4. 通信バス層

### 4.1 access制御

```typescript
interface AccessConfig {
  /** DM（1:1）ポリシー */
  dmPolicy: "open" | "pairing"

  /** グローバル許可リスト */
  allowFrom: string[]

  /** チャンネル別設定 */
  channels: Record<string, {
    requireMention: boolean       // メンション必須か
    allowFrom: string[]           // 受信許可ID
  }>

  /** メンションパターン（自分を指すパターン） */
  mentionPatterns: string[]

  /** ペアリング待ち */
  pending: Record<string, PendingPairing>
}
```

- 設定ファイル: `access.json`（DISCORD_STATE_DIR配下）
- プラットフォーム非依存（Discord/Slack/Telegram共通のaccess制御）
- エージェント別に独立した設定

### 4.2 メッセージルーティング

1. UIアダプターまたはbot送信からUnifiedMessageを受信
2. access制御チェック（allowFrom, requireMention）
3. メンションパターンマッチ
4. 該当するClaude Codeセッションにpush注入
5. 通信ログ記録（DB or ファイル）
6. 他のUIアダプターへ可視性投稿（設定による）

### 4.3 未読管理

| モード | 仕組み | 用途 |
|--------|--------|------|
| DBあり | `last_read_at`テーブルで管理 | 本番運用 |
| DBなし | `.agent-com/last-read/{channel}`ファイル | 最小構成 |

### 4.4 push通知（Webhookチャネル方式）

Webhookチャネル（Claude Code Channels Reference記載の公式方式）を使用。
`--dangerously-load-development-channels` でallowlistをバイパスし、
ローカルHTTPエンドポイントでセッションに直接注入する。

**アーキテクチャ:**
```
send_message → DB INSERT → pg_notify('agent_inbox', target_agent_id)
  → リスナー（常駐）がNOTIFY受信
  → DBから未読メッセージ取得
  → curl POST http://localhost:{port} -d "メッセージ"
  → Webhook MCP server（claude/channel capability）
  → notifications/claude/channel → セッションに自動注入
```

**Webhook MCP server（agent-com-bridge）:**
- 各botに1つ配置
- claude/channel capabilityを宣言
- ローカルHTTPポートでPOST受信
- 受信内容をMCP通知としてセッションに注入

**ポート割当:**

| bot | ポート |
|-----|-------|
| CTO | 8789 |
| Hotel | 8790 |
| Haishin | 8791 |
| WBS | 8792 |
| Nyusatsu | 8793 |
| ADF | 8794 |
| agent-com | 8795 |
| Vice | 8796 |
| Auditor | 8797 |

**pg_notify:**
- send_message実行時、DB INSERT後に `pg_notify('agent_inbox', target_agent_id)` を発行

**リスナー:**
- 1プロセスで全bot分のNOTIFYを監視
- 対象botのポートにcurl POSTで配送

---

## 5. 安全機構

### 5.1 レート制限（DB永続化）

| 項目 | デフォルト | 設定キー |
|------|-----------|---------|
| 最大送信数/分/エージェント | 30 | `rate_limit.max_per_minute` |
| リセット間隔 | 60秒 | 固定 |
| 保存先 | PostgreSQL `rate_limits`テーブル | — |

**DB永続化仕様:**

```sql
CREATE TABLE rate_limits (
  agent_id TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  message_count INTEGER DEFAULT 1,
  PRIMARY KEY (agent_id, window_start)
);
```

- 送信時に現在のウィンドウ（1分単位に切り捨て）でUPSERT
- `message_count >= max_per_minute` なら送信拒否
- 複数ランタイム（OpenClaw + Claude Code）間で共有される
- DBなしモードではインメモリMap（従来動作、再起動でリセット）にフォールバック
- 古いレコードは日次クリーンアップで削除（1日以上前）

### 5.2 ループ検出（多層・DB永続化）

| レイヤー | チェック内容 | デフォルト |
|---------|------------|-----------|
| 深度制限 | メッセージチェーンの深さ | max_depth: 10 |
| 交換カウンター | 2エージェント間の往復回数/時間窓 | max_count: 20 / window: 300秒 |

```sql
CREATE TABLE loop_counters (
  agent_pair TEXT NOT NULL,          -- "agent_a:agent_b"（ソート済みペア）
  window_start TIMESTAMPTZ NOT NULL,
  exchange_count INTEGER DEFAULT 1,
  PRIMARY KEY (agent_pair, window_start)
);
```

- 交換カウンターもDB永続化。ランタイム再起動でリセットされない
- agent_pairはアルファベット順ソートで正規化（A→BもB→Aも同じペア）

### 5.3 重複検出

- MD5ハッシュ（送信先 + 内容）で10秒以内の同一メッセージを排除

### 5.4 バースト制御

- 送信間隔: 最低500ms
- プラットフォームごとの送信キュー

### 5.5 コンテンツサニタイゼーション

- `@everyone`, `@here`, `@channel` → `[mention removed]`に置換
- DB保存・プラットフォーム投稿前に適用

### 5.6 フォワーディング障害対応

- 指数バックオフ: 1s → 2s → 4s → ... → 5回失敗で停止
- プラットフォーム別の障害追跡

---

## 6. データモデル

### 6.1 agent_messages テーブル

```sql
CREATE TABLE agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_bot BOOLEAN DEFAULT true,
  content TEXT NOT NULL,
  message_type TEXT,              -- instruction | report | approval | chat
  reply_to UUID REFERENCES agent_messages(id),
  attachments JSONB,              -- 将来用
  metadata JSONB,                 -- {to: "agent_id", ...custom}
  depth INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**インデックス:**
- `(channel_id, created_at)` — チャンネル履歴
- `(author_id, created_at)` — エージェント別履歴
- `(message_type, created_at)` — タイプ別フィルタ

### 6.2 channel_settings テーブル

```sql
CREATE TABLE channel_settings (
  channel_id TEXT PRIMARY KEY,
  retention_days INTEGER,         -- NULL = 永久保存
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### 6.3 DBなしモード

DBが設定されていない場合：
- メッセージはプラットフォーム履歴（Discord fetch_messages等）に依存
- 未読管理はファイルベース
- 通信ログ検索は利用不可
- ループ検出・レート制限はインメモリで動作（再起動でリセット）

---

## 7. エージェント設定

### 7.1 config.json

```json
{
  "agent_id": "cto",
  "database_url": "postgresql://localhost/agent_comms",
  "channels": {
    "ceo-cto": {
      "retention_days": null,
      "description": "CEO-CTO戦略チャンネル"
    },
    "hotel-kanri": {
      "retention_days": 30,
      "description": "Hotel Dev通信"
    }
  },
  "rate_limit": { "max_per_minute": 30 },
  "loop_detection": {
    "max_depth": 10,
    "max_count": 20,
    "window_seconds": 300
  },
  "auth": { "token": null },
  "forwarding": {
    "discord": { "webhook_url": null },
    "telegram": { "bot_token": null, "chat_id": null },
    "slack": { "webhook_url": null },
    "line": { "channel_token": null, "user_id": null }
  }
}
```

### 7.2 環境変数（config.jsonを上書き）

| 変数 | 用途 |
|------|------|
| `AGENT_ID` | エージェント識別子 |
| `DATABASE_URL` | PostgreSQL接続文字列 |
| `DISCORD_BOT_TOKEN` | Discord Bot認証 |
| `DISCORD_STATE_DIR` | access.json等の状態ディレクトリ |
| `AUTH_TOKEN` | エージェント間認証トークン |

---

## 8. 利用方法

### 8.1 起動コマンド（目標形）

```bash
# Discord組織
claude --channels agent-com:discord --env DISCORD_BOT_TOKEN=xxx

# Slack組織（将来）
claude --channels agent-com:slack --env SLACK_BOT_TOKEN=xxx

# 複数プラットフォーム（将来）
claude --channels agent-com:discord agent-com:slack
```

### 8.2 現在の起動コマンド（Phase 4: Webhookチャネル方式）

```bash
# Phase 4起動コマンド（Webhookチャネル方式）
claude --dangerously-load-development-channels server:agent-com-bridge \
       --channels plugin:discord@claude-plugins-official \
       --dangerously-skip-permissions
```

---

## 9. MCP管理ツール（オプション）

統合プラグインに同梱するMCPツール。通信ではなく管理用途。

### 9.1 send_message

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| to | string | Yes | 宛先エージェントID |
| channel | string | Yes | チャンネル名 |
| content | string | Yes | メッセージ本文 |
| message_type | enum | No | instruction / report / approval / chat |
| reply_to | string | No | 返信先メッセージID |
| depth | number | No | メッセージチェーン深度 |

### 9.2 fetch_messages

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| channel | string | Yes | チャンネル名 |
| limit | number | No | 取得件数（default: 20, max: 100） |
| since | string | No | この日時以降のメッセージ（ISO 8601） |

### 9.3 check_inbox

Messages are automatically pushed to your session. Use this only to re-check history or filter by channel.

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| limit | number | No | 取得件数（default: 20） |

---

## 10. 運用

### 10.1 DBメンテナンス

```bash
# 日次クリーンアップ（retention_daysに基づく自動削除）
0 4 * * * bun ~/Developer/agent-comms-mcp/db/cleanup.ts

# 日次バックアップ
0 3 * * * bash ~/Developer/agent-comms-mcp/scripts/backup-to-conoha.sh
```

### 10.2 同一マシン上の複数bot

各botはDISCORD_STATE_DIRで分離：
```
/Users/yuji/.claude/channels/
├── discord-cto/access.json
├── discord-vice/access.json
├── discord-hotel/access.json
└── ...
```

---

## 11. 開発ロードマップ

### Phase 1: SSOT整備（現在）
- [x] 既存実装の仕様書化
- [ ] ADR-022の方針をSSOTに反映

### Phase 2: Discordアダプターの品質向上
- [ ] botフィルタを0.0.4方式に統一（`msg.author.id === client.user?.id`）
- [ ] access.json管理の通信バス層への移植
- [ ] テスト追加

### Phase 3: push型通知（channel plugin化の基盤）
- [x] DBポーリング機構の実装（3秒間隔、setInterval）
- [x] notifications/claude/channel MCP通知送信
- [x] 重複注入防止（processedIds Set）
- [x] ポーリングのライフサイクル管理（起動時start、shutdown時clear）
- [x] check_inboxツール説明文の更新（補助ツールへ格下げ）
- [ ] 実地テスト（CTO↔Dev Bot間push通知確認）
- **注記:** MCP通知方式はchannel plugin allowlist制約により単独では機能しない。Phase 4でhook方式に移行

### Phase 4: Webhookチャネルによるpush型通知
- [ ] Webhook MCPサーバー（agent-com-bridge.ts）作成
- [ ] send_messageにpg_notify追加
- [ ] リスナースクリプト（listener.ts）作成
- [ ] 起動コマンド変更（--dangerously-load-development-channels追加）
- [ ] 実地テスト（CTO↔Dev Bot間push通知確認）
- [ ] 全botの起動コマンド更新

### Phase 5: マルチプラットフォーム
- [ ] Slackアダプター
- [ ] Telegramアダプター
- [ ] OSSパッケージとして公開

---

## 12. エージェントID管理

### 12.1 agentsテーブル

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,            -- "cto" | "dev-lead" | "c-suite" | "auditor"
  runtime TEXT NOT NULL,               -- "claude-code" | "openclaw"
  status TEXT DEFAULT 'offline',       -- "online" | "offline" | "busy"
  last_seen_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ DEFAULT now(),
  metadata JSONB                       -- 自由拡張（プロジェクトDir、担当等）
);
```

### 12.2 自動登録フロー

1. 起動時にconfig.jsonまたは`AGENT_ID`環境変数からIDを取得
2. `agents`テーブルにUPSERT（status='online', last_seen_at=now()）
3. 同一agent_idが既にonlineの場合、警告ログを出力（重複起動検出）
4. セッション終了時（graceful）にstatus='offline'に更新
5. ハートビート: 5分ごとにlast_seen_atを更新。15分以上更新がなければoffline扱い

### 12.3 ディスカバリAPI（MCP tool）

```
list_agents — 登録済みエージェント一覧を返す
```

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| status | string | No | "online" / "offline" / "all"（default: "all"） |
| agent_type | string | No | フィルタ |

### 12.4 DBなしモード

- agent_idはconfig.json/環境変数から取得（従来通り）
- ディスカバリ不可（単体動作を前提）

---

## 13. bot間認証

### 13.1 方式: HMAC共有シークレット

JWTは小規模エージェント組織にはオーバースペック。HMAC-SHA256の共有シークレット方式を採用。

### 13.2 シークレット管理

```bash
# シークレット生成（CLIツール）
bun agent-com auth init
# → ~/.agent-com/secret を生成（32バイトランダム）
# → 全botが同じシークレットファイルを参照

# 環境変数でも指定可能
AGENT_COMMS_SECRET=<hex-encoded-32-bytes>
```

シークレットは組織（同一マシンまたは同一クラスタ）で共有。エージェント個別の認証ではなく、組織メンバーシップの証明。

### 13.3 認証フロー

**送信時:**
1. ペイロード: `{agent_id}:{timestamp}:{channel}:{content_hash}`
2. HMAC-SHA256(secret, payload)でsignatureを生成
3. metadataに`auth: {signature, timestamp}`を付与してDB保存

**受信時:**
1. metadataからsignature, timestampを取得
2. timestampが5分以内か検証（リプレイ攻撃防止）
3. 同じペイロードでHMAC検証
4. 不一致なら`[UNVERIFIED]`タグを付けてセッションに注入（遮断はしない）

### 13.4 認証モード

| モード | 動作 | 設定値 |
|--------|------|--------|
| off | 認証なし（従来動作） | `auth.mode: "off"` |
| warn | 未認証メッセージに`[UNVERIFIED]`タグ | `auth.mode: "warn"` |
| enforce | 未認証メッセージを拒否 | `auth.mode: "enforce"` |

デフォルト: `off`（後方互換性）。OSS公開時のREADMEでは`warn`を推奨。

### 13.5 config.json拡張

```json
{
  "auth": {
    "mode": "warn",
    "secret_file": "~/.agent-com/secret",
    "replay_window_seconds": 300
  }
}
```

---

## 14. 退行テスト

### 14.1 テストスクリプト

`tests/plugin-regression.ts` — プラグイン更新時に自動実行するテストスイート。

### 14.2 テスト項目

| # | テスト | 検証内容 | 方法 |
|---|--------|---------|------|
| 1 | botフィルタ | `msg.author.bot`でなく`msg.author.id === client.user?.id`であること | server.tsのAST/正規表現チェック |
| 2 | access制御 | allowFrom/requireMentionが正しく機能すること | モックメッセージで検証 |
| 3 | メッセージ送受信 | send_message→DB保存→fetch_messagesの往復 | DB接続テスト |
| 4 | レート制限 | DB永続化が機能し、制限超過時に拒否されること | 連続送信テスト |
| 5 | ループ検出 | 深度制限・交換カウンターが機能すること | チェーンメッセージテスト |
| 6 | 認証 | HMAC署名の生成・検証が正しいこと | 署名往復テスト |
| 7 | エージェント登録 | 起動時の自動登録・重複検出が機能すること | agents テーブル検証 |
| 8 | コンテンツサニタイゼーション | @everyone等が置換されること | パターンマッチテスト |

### 14.3 実行方法

```bash
# 手動実行
bun test tests/plugin-regression.ts

# プラグイン更新時の自動チェック（SessionStart hookに組み込み可能）
bun agent-com check-plugin
```

### 14.4 CI統合（将来）

- GitHub Actions でPR時に自動実行
- プラグイン更新のPRにテスト結果をコメント

---

## 15. 残存する設計課題（Phase 2以降）

1. **マルチプラットフォーム同時運用**: 1 botが複数UIに接続する場合の統合ルール
2. **マルチマシン運用**: シークレットの安全な配布方法
3. **エージェント間の権限レベル**: CTO→Dev Leadへの指示権限 vs 逆方向の制限

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-03-28 | 初版：既存実装の仕様書化 + ADR-022統合プラグイン方針の反映 |
| 2026-03-28 | 追記：§5レート制限/ループ検出のDB永続化、§12エージェントID管理、§13 bot間認証、§14退行テスト |
| 2026-03-28 | 追記：§4.4 push通知詳細化（DBポーリング方式）、§11 Phase 3ロードマップ詳細化、§9.3 check_inbox説明更新 |
| 2026-03-29 | 更新：§11 Phase 4詳細化（channel plugin化）、§8.2 起動コマンドをPhase 4形式に更新 |
| 2026-03-29 | 変更：Phase 4をWebhookチャネル方式に変更。§4.4 push通知仕様を全面改訂（LISTEN/NOTIFY + Webhook MCP server）。§8.2 起動コマンド更新 |
