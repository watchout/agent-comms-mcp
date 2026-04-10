# agent-com 仕様書（SSOT）

> この文書がagent-comの唯一の正（Single Source of Truth）。
> 実装はこの仕様に従うこと。仕様変更はこの文書を先に更新すること。
>
> **詳細仕様は `docs/agent-com-message-queue-spec.md` (SSOT) を参照。**

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

（`docs/agent-com-message-queue-spec.md` §1 準拠）

1. **CLIコマンドが正のインターフェース** — MCP toolsはラッパー
2. **受信は1プロセス（receiver）だけが行う** — INSERT競合が構造的に不可能
3. **配信はDBキューで行う** — HTTP POST / SSE / pg_notify直接配信を排除
4. **LLMにUUID・チャンネルID・宛先選択を触らせない**
5. **全メッセージがDBに記録される** — 例外経路ゼロ
6. **bashが実行できれば、どのLLM CLIでも接続可能**
7. **PostgreSQLでもSQLiteでも同じCLIコマンドが動く**

---

## 2. アーキテクチャ

### 2.1 全体構造（Phase 5 統合版）

```
server.ts（1プロセスで全機能）
│
├── adapters/                        ← UIアダプター層（交換可能）
│   ├── types.ts                       UIAdapter インターフェース
│   ├── discord.ts                     DiscordAdapter（discord.js Gateway）
│   ├── telegram.ts                    （将来）
│   ├── slack.ts                       （将来）
│   └── line.ts                        （将来）
│
├── 通信バス層（server.ts 内蔵）
│   ├── メッセージルーティング          DB INSERT + pg_notify
│   ├── access制御                     access.json（プラットフォーム共通）
│   ├── push通知                       webhook bridge + pg_notify LISTEN
│   ├── DBポーリング                    フォールバック（3秒間隔）
│   └── 安全機構                       レート制限 / ループ検出 / 重複排除
│
├── MCP tools（agent-com CLIのラッパー）
│   ├── next                           未処理メッセージ1件取得
│   ├── send                           返信・自発送信
│   ├── notify                         自発送信（cron/watchdog用）
│   ├── status                         自分の状態・キュー件数確認
│   ├── heartbeat                      ハートビート送信
│   ├── fetch_discord_history          Discord API履歴取得
│   └── list_agents / agents           エージェント一覧
```

**旧構成（Phase 4以前）との対比:**
```
旧: 4プロセス構成
  server.ts              ← MCP + bridge
  scripts/discord-adapter.ts  ← 別プロセス（Discord Gateway + HTTP API）
  scripts/listener.ts         ← 別プロセス（pg_notify LISTEN）
  agent-com-bridge.ts         ← 別プロセス（統合済みで不要に）

新: 1プロセス構成（Phase 5）
  server.ts              ← MCP + bridge + Discord + pg_notify LISTEN
  adapters/discord.ts    ← server.tsからimport（別プロセスではない）
  adapters/types.ts      ← インターフェース定義
```

### 2.2 通信モデル

（`docs/agent-com-message-queue-spec.md` §2 準拠）

```
外部（Discord等）
      ↓ inbound
  receiver（1プロセス）
      → routeInbound() → agent_messages INSERT
                       → message_queue INSERT（push対象bot分）
                       → pg_notify / ファイルシグナル（新着通知のみ）
  agent-com next       ← bot が message_queue から1件取得
  agent-com send/notify → outbound_queue INSERT
  outbound_queue消費   → Discord REST API送信（bot固有token）
      ↑ outbound
外部（Discord等）
```

- 受信: receiver が message_queue に積む → bot が `next` で取得
- 送信: `send` / `notify` コマンドで outbound_queue に積む → receiver が消費
- bot間: 同一経路（message_queue）。例外経路ゼロ

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

### 3.2 Discordアダプター

| 項目 | 仕様 |
|------|------|
| 依存 | discord.js v14 |
| 接続方式 | Discord Gateway（WebSocket） |
| 認証 | Bot Token（環境変数 `DISCORD_BOT_TOKEN`） |
| メッセージ上限 | 2,000文字 |
| botフィルタ | **自分自身のみ除外**（`msg.author.id === client.user?.id`） |
| メンション | プラットフォームネイティブ（`<@user_id>`） |
| スレッド | 対応 |
| リアクション | 対応 |
| 添付ファイル | 対応（25MB/件、10件まで） |

**メッセージ受信フロー:**
```
Discord Gateway → messageCreate イベント
  → botフィルタ（自分自身のみ除外）
  → access制御（allowFrom, requireMention チェック）
  → webhook bridge に HTTP POST
  → セッションに自動注入
```

**メッセージ送信フロー（既存）:**
```
send_message → forwarding.discord.webhook_url にPOST
```

**access制御:**
- `DISCORD_STATE_DIR` 環境変数でaccess.jsonのパスを指定
- 既存のDiscordプラグインと同じaccess.json形式を使用
- チャンネル別のallowFrom、requireMention設定に対応

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

> 詳細仕様: docs/channel-thread-control-spec.md

#### 設計原則
1. botが宛先を選択する手段を物理的に持たない
2. 受信した場所に返信する（Discordのデフォルト動作）
3. 自発的発言（cron等）はCLIでchannel/thread必須指定
4. 全制御はコード側で強制。CLAUDE.mdルールに依存しない

#### Outbound（bot → 外部）
1. botがsend(mentions, content, reply_to?)で送信 — **toパラメータなし**
2. 宛先自動決定:
   - reply_toあり → 元メッセージのchannel_id/thread_idに送信
   - reply_toなし → last_received_channel/threadに送信（警告付き）
   - コンテキストなし → NO_CONTEXTエラー
3. reply_toメンション検証（NOT_MENTIONED_IN_ORIGINAL）
4. mentions全員のmembersチェック（MENTION_NOT_MEMBER）
5. レート制限 / ループ検出
6. DB INSERT + pg_notify + Discord投稿 + push配信

#### Inbound（外部 → bot）
1. daemon Per-Bot Discord ClientがDiscord Gatewayで受信
2. Discord形式→UnifiedMessage変換（メンション解決含む）
3. routeInbound()（純粋関数）で配信判定:
   - DM → 無条件push
   - 緊急/CEO → 全員push
   - observer_mode → drop
   - グループメンション（@all, @dev, @org）→ 該当push
   - 個別メンション or reply_to元送信者 → push
   - それ以外 → drop（DB保存のみ）
4. DB INSERT（全メッセージ、フィルタ結果に関わらず）
5. push対象botのlast_received_channel/thread更新
6. push対象botにのみpushToChannelServer()で配信

#### 廃止された機能
- ~~active_thread~~ → last_received_contextに置き換え
- ~~focus/unfocusツール~~ → 不要（宛先自動決定）
- ~~sendのtoパラメータ~~ → 不要（宛先自動決定）

### 4.3 未読管理

| モード | 仕組み | 用途 |
|--------|--------|------|
| DBあり | `last_read_at`テーブルで管理 | 本番運用 |
| DBなし | `.agent-com/last-read/{channel}`ファイル | 最小構成 |

### 4.4 push通知（Webhook Channel方式）

agent-commsを2つに分離し、push受信とツール提供を独立させる。

**agent-comms-channel（push受信専用）:**
- claude/channel capabilityを宣言する軽量MCPサーバー（channel-server.ts）
- ローカルHTTPポートで `POST /push` を受信
- HMAC-SHA256署名検証
- 受信内容をMCP通知としてClaude Codeセッションに注入
- Discord Client無し（メモリ消費≈0）
- Discord直接監視なし（バイパス不可能）

**agent-comms（ツール提供）:**
- send, history, inbox, agents, focus, unfocus, quote等のMCPツール
- SSEまたはstdioでdaemonに接続

**アーキテクチャ:**
```
Discord Gateway → SSE daemon → adapter変換 → routeInbound()（5段階フィルタ）
  → DB INSERT（全メッセージ）
  → push対象botのみ HTTP POST http://localhost:{port}/push（HMAC署名付き）
  → channel-server.ts（Bot内軽量HTTPサーバー）
  → server.notification() → Claude Codeセッションに自動注入
```

**channel-server.ts:**
- 各botに1つ配置（`--dangerously-load-development-channels server:agent-comms-channel`で起動）
- claude/channel capabilityを宣言
- ローカルHTTPポートで`POST /push`受信
- HMAC署名検証後、notification()でセッションに注入

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
  "agent_id": "my-bot",
  "database_url": "postgresql://localhost/agent_comms",
  "channels": {
    "general": {
      "retention_days": null,
      "description": "General comms (permanent)"
    },
    "dev-chat": {
      "retention_days": 30,
      "description": "Dev team comms"
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

### 8.2 現在の起動コマンド（Phase 5: 統合方式）

```bash
# Phase 5起動コマンド（全機能統合 — server.ts 1プロセスで MCP tools + channel + Discord + pg_notify）
# channelサーバー名: "server" — server.tsがclaude/channel capabilityを宣言するMCPサーバー
AGENT_ID='bot-name' DATABASE_URL='postgresql://localhost/agent_comms' \
WEBHOOK_PORT=8789 DISCORD_BOT_TOKEN='xxx' DISCORD_STATE_DIR='/path/to/state' \
claude --dangerously-load-development-channels server:server.ts \
       --mcp-config .mcp.json \
       --dangerously-skip-permissions
```

> **channelサーバー名について:** `server:server.ts` の `server` はMCPサーバー名（.mcp.jsonで定義）。
> `server.ts` はそのサーバーのエントリポイント。`--dangerously-load-development-channels server:server.ts`
> はserver MCPサーバーのserver.tsファイルをchannelサーバーとして読み込むことを意味する。

**旧方式（Phase 4 — bridge別プロセス、フォールバック用）:**
```bash
claude --dangerously-load-development-channels server:agent-com-bridge \
       --mcp-config .mcp.json \
       --dangerously-skip-permissions
```

---

## 9. MCPツール

### 9.1 send（旧send_message）

> botが宛先を選択する手段を持たない。宛先はコアRouterが自動決定。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| mentions | string[] | Yes | push通知先agent_id配列（空配列は拒否） |
| content | string | Yes | メッセージ本文（50,000文字上限） |
| reply_to | string | No | 返信先メッセージID（UUID） |

**宛先決定ロジック（コアRouter内部）:**
1. reply_toあり → 元メッセージのchannel_id/thread_idに送信
2. reply_toなし → last_received_channel/threadに送信（警告記録）
3. コンテキストなし → NO_CONTEXTエラー

**~~toパラメータは廃止~~** — botは宛先を指定できない。受信した場所に返す。

### 9.2 fetch_messages

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| channel | string | Yes | チャンネル名 |
| limit | number | No | 取得件数（default: 20, max: 100） |
| since | string | No | この日時以降のメッセージ（ISO 8601） |

### 9.3 fetch_discord_history

Discord APIを直接呼び出し、チャンネルの過去メッセージを取得する。
agent_messagesテーブル（DB）ではなく、Discordプラットフォーム上のメッセージを返す。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| channel_id | string | Yes | DiscordチャンネルまたはスレッドID |
| limit | number | No | 取得件数（default: 50, max: 100） |
| before | string | No | このメッセージIDより前のメッセージを取得 |

**実装方式:** 統合版ではDiscordAdapterの `fetchHistory()` メソッドを直接呼び出し、Discord APIの `GET /channels/{id}/messages` で履歴を取得する。

### 9.4 check_inbox

Messages are automatically pushed to your session. Use this only to re-check history or filter by channel.

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| limit | number | No | 取得件数（default: 20） |

**既読管理（カーソルベース）:**
- エージェントごとに `last_read_id`（最後に読んだメッセージID）をメモリ内で保持
- `check_inbox` 呼び出し時、`last_read_id` より後のメッセージのみ返す
- 取得したメッセージの最大IDで `last_read_id` を更新
- プロセス再起動時はカーソルがリセットされるが、push通知が主経路のため問題なし

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
- [x] Webhook MCPサーバー（agent-com-bridge.ts）作成
- [x] send_messageにpg_notify追加
- [x] リスナースクリプト（listener.ts）作成
- [x] 起動コマンド変更（--dangerously-load-development-channels追加）
- [x] 実地テスト（CTO↔Dev Bot間push通知確認）
- [x] Agent ID正規化対応
- [x] 全botの起動コマンド更新（Phase 5統合版で全9bot展開完了）

### Phase 4.5: Discordアダプター（受信機能）
- [x] discord.js依存追加
- [x] Discord Gateway接続（messageCreateイベント）
- [x] access制御（access.json読み込み）
- [x] webhook bridgeへのHTTP POST配送
- [x] 既存Discordプラグインとの互換性テスト

### Phase 5: 統合アーキテクチャ（1プロセス・1接続）

全アダプターとpush機構をagent-comms MCPサーバー1プロセスに統合。
OSS公開はこのPhase完了時点。

**設計:**
```
agent-comms MCP（1プロセス = server.ts）
├── core: DB（メッセージストア + ルーティング）
├── adapters/
│   ├── types.ts     ← UIAdapter インターフェース定義
│   ├── discord.ts   ← discord.js（DiscordAdapter クラス）
│   ├── telegram.ts  ← Telegram Bot API（将来）
│   ├── slack.ts     ← Slack Web API（将来）
│   └── line.ts      ← LINE Messaging API（将来）
├── push: webhook bridge内蔵 + pg_notify LISTEN内蔵
└── MCP tools: send_message, reply, fetch_discord_history, etc.
```

**5.1 アダプター層インターフェース（adapters/types.ts）:**

```typescript
interface UIAdapter {
  platform: string
  capabilities: PlatformCapabilities
  connect(config: AdapterConfig): Promise<void>
  onMessage(callback: (msg: UnifiedMessage) => void): void
  sendMessage(channel: string, text: string, options?: SendOptions): Promise<{ messageId: string }>
  fetchHistory(channel: string, limit?: number, before?: string): Promise<UnifiedMessage[]>
  startTyping(channel: string): void
  stopTyping(channel: string): void
  disconnect(): Promise<void>
}

interface UnifiedMessage {
  id: string
  channel: string
  author: { id: string; name: string; isBot: boolean }
  content: string
  replyTo?: string
  attachments?: Attachment[]
  timestamp: Date
  platform: string
  raw: unknown
}
```

全プラットフォームアダプターがこのインターフェースを実装する。
server.tsはUIAdapterを通じてプラットフォーム固有処理を呼び出す。

**5.2 Discordアダプター統合（adapters/discord.ts）:**

既存のscripts/discord-adapter.tsをUIAdapter実装として再構築:
- DiscordAdapterクラスがUIAdapterを実装
- Gateway接続、access制御、typing indicator、権限リクエスト機能を内包
- server.tsから`new DiscordAdapter()`でインスタンス化し`connect()`で起動
- 別プロセス（scripts/discord-adapter.ts）の起動が不要に
- メッセージ受信はコールバック方式（`onMessage(callback)`）

**5.3 listener統合（pg_notify LISTEN）:**

既存のscripts/listener.tsの機能をserver.ts内に統合:
- DB接続確立後、専用のpg Clientで`LISTEN agent_inbox`を発行
- NOTIFYペイロード`{to, message_id}`を受信し、bridgeのmcp.notification()で直接配信
- 再接続ロジック（指数バックオフ）をserver.ts内に実装
- 別プロセス（scripts/listener.ts）の起動が不要に
- 既存のポーリング（pollNewMessages）も残す（pg_notify + ポーリングの二重保証）

**5.4 channel→agentマッピング:**

config.jsonに`discord.channel_map`を追加:

```json
{
  "discord": {
    "channel_map": {
      "1487368919613444156": "agent-com-dev"
    }
  }
}
```

- Discordチャンネル/スレッドID → agent_id のマッピング
- access.jsonの`groups`設定と併用（access制御はaccess.json、ルーティングはchannel_map）
- マッピングがない場合はconfig.jsonの`agent_id`にフォールバック（現在の動作と互換）

**5.5 起動方式:**

```bash
# Phase 5（統合版）— 1コマンドで全機能起動
npm start
# → bun server.ts が以下を全て起動:
#   1. MCP server（tools + channel capability）
#   2. Discord Gateway接続（DiscordAdapter）
#   3. pg_notify LISTEN（リアルタイム配信）
#   4. webhook bridge（HTTP POST受信）
#   5. DBポーリング（フォールバック）

# Claude Code起動コマンド
# channelサーバー名 "server" は .mcp.json で定義されたMCPサーバー名
AGENT_ID='bot-name' DATABASE_URL='postgresql://localhost/agent_comms' \
WEBHOOK_PORT=8789 DISCORD_BOT_TOKEN='xxx' DISCORD_STATE_DIR='/path/to/state' \
claude --dangerously-load-development-channels server:server.ts \
       --mcp-config .mcp.json \
       --dangerously-skip-permissions
```

**5.6 削除対象（統合完了後）:**

以下のファイルは統合完了後に不要:
- `scripts/discord-adapter.ts` → adapters/discord.ts に移行
- `scripts/listener.ts` → server.ts内に統合
- `agent-com-bridge.ts` → server.ts内に統合済み（Phase 4で完了）

**核心の変更:**
- Discord接続がserver.ts内で直接管理される（HTTP経由の間接通信が不要に）
- pg_notify受信がserver.ts内で直接処理される
- 別プロセス3つ（discord-adapter, listener, bridge）が全てserver.ts 1プロセスに統合
- npm start 1コマンドで起動

**タスク:**
- [ ] アダプター層のインターフェース定義（adapters/types.ts）
- [ ] Discordアダプター統合（adapters/discord.ts — UIAdapter実装）
- [x] webhook bridge内蔵化（PR #12: server.tsにbridge統合）
- [x] 全9bot統合版展開完了（2026-03-30: agent-com, Hotel, Haishin, WBS, Nyusatsu, ADF, Vice, Auditor, CTO）
- [ ] listener統合（pg_notify LISTEN をserver.ts内に実装）
- [ ] server.ts統合（Discord adapter + listener をimportし起動）
- [ ] channel→agentマッピング（config.json拡張）
- [ ] テスト更新（import先をadapters/に変更、統合テスト追加）
- [ ] npm start で全機能起動
- [ ] Telegramアダプター（将来）
- [ ] OSS公開（README + GIF + npm publish）

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

## 15. Phase 5 移行手順

### 15.1 現状（Phase 4.5）からPhase 5への移行

**前提:** 現在9bot全てが以下の分離プロセス構成で稼働中:
- server.ts（MCP + bridge）
- scripts/discord-adapter.ts（Discord Gateway + outbound HTTP API）
- scripts/listener.ts（pg_notify LISTEN + 配信）

**移行手順:**

1. **adapters/ 作成**
   - `adapters/types.ts`: UIAdapterインターフェース定義
   - `adapters/discord.ts`: DiscordAdapterクラス（scripts/discord-adapter.tsから移植）
   - gate(), loadAccess() 等の関数はadapters/discord.tsからもexportし、テスト互換性を維持

2. **server.ts統合**
   - DiscordAdapterをimportし、`DISCORD_BOT_TOKEN`がある場合に自動接続
   - pg_notify LISTENを専用Client経由で実装（DB接続確立後）
   - 受信メッセージをmcp.notification()で直接セッションに注入
   - `reply` / `fetch_discord_history` ツールをHTTP経由からDiscordAdapter直接呼び出しに変更
   - permission relay をDiscordAdapter.sendPermissionRequest()経由に変更

3. **config.json拡張**
   - `discord.channel_map`フィールドを追加（§11 Phase 5.4参照）
   - 既存のconfig.jsonとの後方互換性を維持（フィールド未指定時はフォールバック）

4. **テスト更新**
   - `tests/discord-adapter.test.ts`: importを`adapters/discord`に変更
   - `tests/listener-normalize.test.ts`: normalizeAgentId関数をserver.tsまたはutilに移動
   - `tests/plugin-regression.ts`: Test 10のbridge/listener参照を統合後の構造に更新
   - 全25テストがパスすることを確認

5. **npm start確認**
   - `npm start`で MCP + Discord + pg_notify LISTEN + bridge が全て起動することを確認
   - 環境変数: `DISCORD_BOT_TOKEN`未設定時はDiscord接続をスキップ（graceful degradation）

6. **旧ファイル整理**
   - `scripts/discord-adapter.ts`: 非推奨マーク or 削除
   - `scripts/listener.ts`: 非推奨マーク or 削除
   - `agent-com-bridge.ts`: 削除候補（Phase 4で既にserver.tsに統合済み）

### 15.2 ロールバック方針

統合に問題が発生した場合:
- scripts/discord-adapter.ts と scripts/listener.ts は削除せず残す
- config.jsonの`discord.channel_map`未設定時は旧動作（HTTP経由）にフォールバック
- `DISCORD_BOT_TOKEN`未設定でDiscord機能を無効化可能

---

## 16. Bot ライフサイクル管理

### 16.1 概要

同一マシン上で稼働する複数botセッション（tmux）のライフサイクルをMCPツールで管理する。
シェルスクリプト（restart-bot.sh, watchdog.sh）のロジックをMCPツールとして提供し、
任意のbotからリモート操作可能にする。

### 16.2 Botレジストリ

`scripts/bot-registry.txt` が全botの定義ファイル（SSOT）。

```
# SESSION|PROJECT_DIR|AGENT_ID|PORT|COMMAND
discord-cto|~/Developer/tech-lead|cto|8789|claude --dangerously-load-development-channels server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions
...
```

- 5列目（COMMAND）に各Botの正確な起動コマンドを記載
- COMMANDが省略された場合はデフォルトコマンドが使用される
- watchdog.sh / restart-bot.sh / MCP restart_bot ツールはregistryのコマンドをそのまま使用
- 環境変数 `BOT_REGISTRY` でパスを上書き可能（デフォルト: `scripts/bot-registry.txt`）

### 16.3 MCP管理ツール

#### restart_bot

指定botのtmuxセッションを正しいオプション付きで再起動する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| session | string | Yes | tmuxセッション名（例: discord-wbs） |

**処理フロー:**
1. bot-registry.txtからセッション情報を検索
2. 該当ポートの孤立プロセスをkill
3. tmuxセッションをkill
4. 新規tmuxセッション作成 → claude起動コマンド送信
5. 3秒待機 → Enter送信（TUIプロンプト自動確認）
6. 起動確認（Listening for channel messages の検出）

#### bot_status

全登録botの稼働状態を一覧表示する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| （なし） | — | — | — |

**返却情報（bot毎）:**
- セッション名、プロジェクトDir、ポート
- tmuxセッション有無
- チャンネルプラグインモード稼働有無
- ポート使用状態

#### watchdog_check

全botのヘルスチェックを実行し、異常なセッションを自動再起動する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| dry_run | boolean | No | trueの場合、再起動せずレポートのみ（default: false） |

**チェック項目:**
1. tmuxセッション存在チェック
2. クラッシュパターン検出（panic, fatal, SIGKILL等）
3. チャンネルプラグインモード検証
4. シェルプロンプト検出（Claude Code終了検知）

#### cleanup_ports

bot-registry.txtに登録されたポートのうち、対応するtmuxセッションが存在しないものの
孤立プロセスをkillする。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| （なし） | — | — | — |

### 16.4 ポート割当（bot-registry.txt準拠）

| bot | セッション | ポート |
|-----|-----------|-------|
| CTO | discord-cto | 8789 |
| Haishin | discord-haishin | 8792 |
| Nyusatsu | discord-nyusatsu | 8793 |
| ADF | discord-adf | 8794 |
| agent-com | discord-agent-com | 8795 |
| Vice | discord-vice | 8796 |
| Auditor | discord-auditor | 8797 |
| X-Marketing | discord-xmarketing | 8798 |
| Upwork | discord-upwork | 8799 |
| Org-Build | discord-orgbuild | 8800 |
| Research | discord-research | 8801 |
| ARC | discord-arc | 8803 |
| WBS | discord-wbs | 8804 |
| Secretary | discord-secretary | 8805 |
| Webb | discord-webb | 8806 |

### 16.5 起動コマンド

全botが統一コマンドで起動される：
```bash
claude --dangerously-load-development-channels server:agent-comms \
       --mcp-config .mcp.json \
       --dangerously-skip-permissions
```

TUIの確認プロンプト（option 1選択）はtmux send-keys Enterで自動通過する。

---

## 17. 残存する設計課題（Phase 2以降）

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
| 2026-03-29 | 追記：§3.2 Discordアダプター詳細仕様（受信/送信フロー、access制御）。§11 Phase 4.5追加 |
| 2026-03-29 | 更新：§11 Phase 5を統合アーキテクチャ（1プロセス・1接続）に書き換え |
| 2026-03-29 | 更新：§8.2 起動コマンドをPhase 5統合方式に更新。§11 webhook bridge内蔵化チェック |
| 2026-03-30 | 更新：§11 Phase 4残項目完了、Phase 4.5全項目完了、Phase 5全9bot統合展開完了 |
| 2026-03-30 | 追記：§9.3 fetch_discord_history ツール仕様追加（Discord API経由の履歴取得） |
| 2026-03-30 | 大幅更新：§2.1 全体構造をPhase 5統合版に改訂。§11 Phase 5を5.1〜5.6に詳細化（アダプターIF、Discord統合、listener統合、channel mapping、起動方式、削除対象）。§15 移行手順追加 |
| 2026-03-30 | 追記：§9.4 check_inbox にカーソルベース既読管理（last_read_id）の仕様追加。重複配信バグ修正 |
| 2026-04-02 | 追記：§16 Botライフサイクル管理。MCPツール4種（restart_bot, bot_status, watchdog_check, cleanup_ports）追加。ポート割当をbot-registry.txt準拠に更新 |
