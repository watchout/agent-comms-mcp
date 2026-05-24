# agent-com 仕様書（SSOT）

> この文書がagent-comの唯一の正（Single Source of Truth）。
> 実装はこの仕様に従うこと。仕様変更はこの文書を先に更新すること。
>
> **本 SSOT.md に従属する詳細仕様** として `docs/agent-com-message-queue-spec.md` を参照。message-queue-spec は本 SSOT.md の権威下に置かれる詳細実装仕様であり、本文書と矛盾する場合は本 SSOT.md が優先する。

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

（`docs/agent-com-message-queue-spec.md` §1 と整合 (本 SSOT.md の権威下)）

1. **CLIコマンドが正のインターフェース** — MCP toolsはラッパー
2. **受信は1プロセス（receiver）だけが行う** — INSERT競合が構造的に不可能
3. **配信はDBキューで行う** — HTTP POST / SSE / pg_notify直接配信を排除
4. **LLMにUUID・チャンネルID・宛先選択を触らせない**
5. **全メッセージがDBに記録される** — 例外経路ゼロ
6. **bashが実行できれば、どのLLM CLIでも接続可能**
7. **PostgreSQLでもSQLiteでも同じCLIコマンドが動く**

### 1.5 AUN正常化フェーズゲート

AUNの正常化は `docs/design/aun-normalization-roadmap.md` を従属する詳細仕様として扱う。
identity / runtime / workspace / connector / channel routing / queue /
state-daemon / audit に関わる変更は、MVP / v1 / v2 のいずれのフェーズゲートを
進めるのかを明示してから実装する。

正常化MVPは、人間がDiscordやtmuxを見て判断する状態では完了としない。DB正本、
deterministic CLI output、CI、provider delivery evidence、audit evidenceにより
`aun doctor --strict` 相当で機械判定できる状態を完了条件とする。

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
│   ├── message_queue                  per-agent 配信キュー（Phase 2）
│   ├── outbound_queue + consumer      Discord 送信キュー + 1秒 polling（Phase 3）
│   ├── DBポーリング                    フォールバック（3秒間隔）
│   └── 安全機構                       レート制限 / ループ検出 / 重複排除
│
├── MCP tools（agent-com CLIのラッパー）
│   ├── next                           未処理メッセージ1件取得
│   ├── send                           返信・自発送信
│   ├── notify                         自発送信（watchdog/定期レポート用）
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

（`docs/agent-com-message-queue-spec.md` §2 と整合 (本 SSOT.md の権威下)）

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

> 詳細仕様: docs/agent-com-message-queue-spec.md §4 / §8 / §10-12 (旧 channel-thread-control-spec から統合、SPEC-INDEX.md:70 参照)
> Phase 5 (Issues #305 / #306 / #308 / #250、PR-Phase5): mention/cc 分離 + primary fallback + outbound ACL = `config/bot-routing.json` を共通 source とする 4 port 抽象 (`InboundResolver` / `PrimaryFallback` / `OutboundPolicyValidator` / `MessageBodyDecorator`、`core/routing/ports/`)。reload は restart-only。

#### Phase 5 routing contract (Issues #305/#306/#308/#250; ADR-041 amendment 2026-05-05)
- **mention** (1 主 recipient、queue 投入、**required**): 空文字 → `INVALID_MENTION` reject、unknown agent → `UNKNOWN_AGENT` reject
- **cc[]** (queue 投入なし、body 末尾に `[CC: <@id>]` 注入): unknown agent は strip + warning (degradation safe)
- ~~**mentions[]** (deprecated)~~: **REMOVED 2026-05-05** (CEO directive `5e2d9235`). Callers still passing `mentions[]` get `INVALID_MENTION` with migration hint. See `docs/adr/041-routing-phase5.md`.
- **primary fallback** (channel.primary): mention 不在時の inbound default 宛先、両方不在は skip + warning
- **outbound ACL** (channel.outboundAllowlist): server-side 違反は `OUTBOUND_ACL_VIOLATION` reject 一本化 (cc[] strip 削除); allowlist 不在 channel は legacy compat (全 sender 許可)

#### 設計原則
1. botが宛先を選択する手段を物理的に持たない
2. 受信した場所に返信する（Discordのデフォルト動作）
3. 自発的発言（cron等）はCLIでchannel/thread必須指定
4. 全制御はコード側で強制。CLAUDE.mdルールに依存しない
5. **routing contract は `core/channel-policy.ts` の `getChannelPolicy(channel_id)` 1 expression に集約**、server / client / test が同 source を参照 (Phase 5 §1.8)

#### Outbound（bot → 外部）
1. botがsend(mention, cc?, content, reply_to)で送信 — **toパラメータなし**、mention は required (ADR-041 amendment 2026-05-05)
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
6. push対象botにのみmessage_queue経由で配信（Phase 4 以降、旧 pushToChannelServer は廃止）

#### 廃止された機能
- ~~active_thread~~ → last_received_contextに置き換え
- ~~focus/unfocusツール~~ → 不要（宛先自動決定）
- ~~sendのtoパラメータ~~ → 不要（宛先自動決定）

### 4.3 未読管理

| モード | 仕組み | 用途 |
|--------|--------|------|
| DBあり | `last_read_at`テーブルで管理 | 本番運用 |
| DBなし | `.agent-com/last-read/{channel}`ファイル | 最小構成 |

### 4.4 配信アーキテクチャ（Phase 4: message_queue + outbound_queue）

Phase 4 (Issue #130) で旧 Webhook Channel 方式（pushToChannelServer / channel-server.ts / SSE fallback / filesystem signal）を全廃。全配信がキューベースに移行。

**inbound (Discord → bot):**
```
Discord Gateway → adapter変換 → routeInbound() → DB INSERT (agent_messages)
  → message_queue INSERT (per-pushTarget)
  → bot は MCP next tool または agent-com next CLI でキューから取得
  → 3秒ポーリング (pollNewMessages) が後方互換 push を提供
```

**outbound (bot → Discord):**
```
send tool / CLI send → agent_messages INSERT + outbound_queue INSERT
  → outbound consumer (1秒 polling) → Discord REST API 送信
  → 成功: status='sent' / 失敗: retry (max 5回) → status='failed'
```

**pg_notify:**
- send / inbound 時に `pg_notify('agent_inbox', { to: <agent_id>, ... })` を発行
- LISTEN ハンドラが受信して追加ルーティング (Phase 5 receiver pipeline canary)

**廃止済み (Phase 4で削除):**
- pushToChannelServer / channel-server.ts （PR #193 で削除済） / agents.channel_port (soft-deprecated、未 DROP)
- sendInboxSignal / filesystem .signal files
- SSE fallback (botContexts.get → server.notification) in send tool

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
| 深度制限 | メッセージチェーンの深さ | max_depth: 5 |
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

### 6.5 Non-push CLI Polling Driver（message-queue-spec v1.0.2 §6.5）

MCP server 内蔵の PollingDriver クラスが message_queue を自動監視する。
cron・外部スクリプトは不要。

**MCP 対応 CLI (Claude Code / Codex / Gemini):**
- MCP server 起動時に PollingDriver が自動開始
- heartbeat: 30 秒間隔で agents.last_seen_at を更新
- polling: AGENT_COM_POLL_INTERVAL_MS (default 3000ms) 間隔で message_queue を確認
- 受信メッセージはバッファに保持、next 呼び出し時に即返却
- Claude Code は push シグナルがあるため polling は補助的

**MCP 未対応環境:**
- `agent-com daemon` CLI コマンドで同等の機能を提供
- tmux セッション内で起動し、stdin 経由で LLM に指示を投入

**負荷:**
- 1 bot あたり ~0.37 qps (1/30 heartbeat + 1/3 poll = 0.033 + 0.333)
- ~50 bot: ~18 qps (PostgreSQL で問題なし)
- ~100+ bot: polling 間隔延長 or pg_notify ハイブリッドに切替推奨 (§14.5)

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
    "max_depth": 5,
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

### 8.1 起動コマンド（OSS Quick Start — Phase C I6）

```bash
npx agent-comms-mcp          # auto-detect: .env 有 → start / 無 → init
npx agent-comms-mcp init     # 対話式セットアップ (token / DB / Agent ID → .env 生成)
npx agent-comms-mcp start    # .env 読込 → daemon + MCP 起動
npx agent-comms-mcp status   # health endpoint 問合せ
```

### 8.2 現在の起動コマンド（社内運用 — Phase 5 統合方式）

```bash
# 社内 multi-bot 運用（bot-registry.txt 準拠）
# WEBHOOK_PORT は bot ごとに registry の値を渡す。Issue #248 cycle 1 以降、
# 暗黙 default の 8789 は撤廃 (CTO bot 衝突源)。env を渡さない場合は
# server.ts が AUN_WEBHOOK_PORT > WEBHOOK_PORT > free-port detection
# (8801-8900) の順で解決する。下記は CTO の社内運用例 (port 8889)。
AGENT_ID='bot-name' DATABASE_URL='postgresql://localhost/agent_comms' \
WEBHOOK_PORT=8889 DISCORD_BOT_TOKEN='xxx' DISCORD_STATE_DIR='/path/to/state' \
claude server:agent-comms \
       --mcp-config .mcp.json \
       --dangerously-skip-permissions
```

> **MCPサーバー名について:** `server:agent-comms` の `agent-comms` は `.mcp.json` で定義された MCP サーバー名。
> `server.ts` がそのエントリポイント。社内運用は MCP ホスト経由の起動、OSS 利用は `npx agent-comms-mcp` 経由の起動。

---

## 9. MCPツール

### 9.1 send（旧send_message）

> botが宛先を選択する手段を持たない。宛先はコアRouterが自動決定。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| mention | string | Yes | 1 primary recipient agent_id（required、ADR-041 amendment 2026-05-05）|
| cc | string[] | No | reference recipients（queue 投入なし、body 末尾に `[CC: <@id>]` 注入）|
| content | string | Yes | メッセージ本文（50,000文字上限） |
| reply_to | string | Yes | 返信先メッセージID（UUID、destination 自動決定）|

> ~~mentions: string[]~~ は **REMOVED 2026-05-05**（CEO directive `5e2d9235`、`docs/adr/041-routing-phase5.md` amendment）

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

### 9.4 next / inbox / expand_msg (Issue #257 light/full 契約)

`next` / `inbox` の default response は **light shape** (preview のみ)、full body は opt-in。
`expand_msg(id)` で個別 message の full body + metadata を取得。

| tool | パラメータ | default | full opt-in |
|------|-----------|---------|-------------|
| `next` | `full?: boolean` | reply_chain[] entries に preview のみ (80 char) | `next({full: true})` で legacy shape (content + preview) |
| `inbox` | `limit?: number, full?: boolean` | row body 80-char preview + `… [truncated, call expand_msg with id={id}]` suffix | `inbox({full: true})` で legacy verbatim row body |
| `expand_msg` | `id?: string \| message_id?: string` | full body + metadata 1 件 | n/a (default で full) |

**Recovery path 非対称** (transport 慣例ごとの opt-in):
- MCP: arg 専用 (`next({full: true})` / `inbox({full: true})`)
- CLI: env 専用 (`AGENT_COM_REPLY_CHAIN_MODE=full`)

**Error taxonomy (`expand_msg`)**: `INVALID_ARG` / `MSG_NOT_FOUND` / `DB_UNAVAILABLE` / `EXPAND_MSG_FAILED`

**ReplyChainEntry shape**: `{ id, from, parent_id, depth, preview, content?, created_at }` (depth は seed = 0、ancestors increment、seed-inclusive oldest-first chronological)

**既読管理（カーソルベース）**: `inbox_cursor_id` / `inbox_cursor_at` を `agents` テーブルに永続化 (PR-0 / Issue #287)。プロセス再起動でも次回 `next` 呼び出しで重複配信なし。

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
- [x] next ツール light/full 契約 (Issue #257、§9.4 参照)
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
# MCPサーバー名 "agent-comms" は .mcp.json で定義 (実態は bot-registry.txt と一致)
# Issue #248 cycle 1 以降、WEBHOOK_PORT 暗黙 default 8789 は撤廃。
# 下記は社内運用 CTO bot 例 (port 8889、bot-registry.txt の値を渡す)。
# env 未指定時は AUN_WEBHOOK_PORT > WEBHOOK_PORT > free-port (8801-8900) で解決。
AGENT_ID='bot-name' DATABASE_URL='postgresql://localhost/agent_comms' \
WEBHOOK_PORT=8889 DISCORD_BOT_TOKEN='xxx' DISCORD_STATE_DIR='/path/to/state' \
AGENT_COM_RUNTIME=daemon claude server:agent-comms \
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
discord-cto|~/Developer/tech-lead|cto|8789|AGENT_COM_RUNTIME=daemon claude server:agent-comms --mcp-config .mcp.json --dangerously-skip-permissions
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
2. 該当ポートの孤立プロセスをkill（**PPID==1 contract** 適用、下記）
3. tmuxセッションをkill
4. 新規tmuxセッション作成 → claude起動コマンド送信
5. 3秒待機 → Enter送信（TUIプロンプト自動確認）
6. 起動確認（`bun server.ts` が期待ポートで listen 開始を検出。正典: `core/bot-health.ts::checkBotHealth` Check 4）

##### Orphan-port cleanup contract (PPID==1)

Issue #248 cycle 3 — PPID==1 canonical contract is applied via either script invocation (4 lifecycle scripts: `restart-bot.sh`, `watchdog.sh`, `migrate-bot.sh`, `rollback-bot.sh`) or equivalent inline implementation (`server.ts` startup orphan-kill block + `killPidsOnPort` helper). The 4 shell scripts delegate to the canonical `scripts/cleanup-orphan-ports.sh`; `server.ts` runs the same `lsof -> ps -o ppid= -p` filter inline (it cannot reasonably exec the script at module init or inside MCP-tool handlers). Both routes enforce the same contract; topology is `script × 4 + inline × 2 = 6 sites`.

- **canonical script**: `scripts/cleanup-orphan-ports.sh <port>`
- **PPID==1 filter rule**: `lsof -ti :<port>` で得た PID のうち `ps -o ppid= -p <pid>` が `1` (= init / launchd 引取済 = 真の orphan) のもののみ `kill -9` 対象。PPID!=1 (= 親 process 健在 = 生きた MCP server / 別 bot) は skip。`ps` 失敗時は false-positive 回避で skip。
- **rationale**: pre-cycle-3 は port 占有 PID を全 kill していたため、並行起動した別 bot の生きた MCP server まで kill して cascade-disconnect を引き起こしていた (本日の outage 真因)。
- **invocation pattern**:
  - shell scripts: `bash "$(dirname "$0")/cleanup-orphan-ports.sh" "$PORT"`
  - server.ts startup orphan-kill: 同等の inline filter (`lsof -ti :PORT` → `ps -o ppid= -p <pid>` で `1` 判定 → SIGKILL)
  - server.ts `killPidsOnPort` helper: `isPidOrphan(pid)` で同等の判定 → SIGTERM
- **hook migration gate**: `~/.claude/settings.json:54` の SessionStart hook が呼ぶ path は merge 後 CTO 反映で本 repo の `scripts/cleanup-orphan-ports.sh` の絶対 path に切替予定。tech-lead repo 側の hotfix copy は反映完了後に削除。
- **portability follow-up**: PPID==1 ⇔ orphan の同一視は macOS/launchd 前提。Linux subreaper / containers / systemd-user 環境への一般化は Issue #261 で track。

#### bot_status

全登録botの稼働状態を一覧表示する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| （なし） | — | — | — |

**返却情報（bot毎）:**
- セッション名、プロジェクトDir、ポート
- tmuxセッション有無
- 稼働状態: `healthy` / `initializing` / `misconfigured` / `dead` / `crashed` / `exited` のいずれか。判定ロジックの正典は `core/bot-health.ts::checkBotHealth`
- ポート使用状態

#### watchdog_check

全botのヘルスチェックを実行し、異常なセッションを自動再起動する。

| パラメータ | 型 | 必須 | 説明 |
|-----------|------|------|------|
| dry_run | boolean | No | trueの場合、再起動せずレポートのみ（default: false） |

**チェック項目:**
1. tmuxセッション存在チェック
2. クラッシュパターン検出（panic, fatal, SIGKILL等）
3. 稼働状態検証（`bun server.ts` の期待ポート listen、PID squatter の検出など。判定の正典は `core/bot-health.ts::checkBotHealth`）
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

**OSS（新規セットアップ）:**
```bash
npx agent-comms-mcp init     # 対話式セットアップ → .env 生成
npx agent-comms-mcp start    # daemon + MCP 起動
```

**社内 multi-bot 運用（bot-registry.txt と一致）:**
```bash
# Issue #248 cycle 1 以降 WEBHOOK_PORT 暗黙 default 8789 撤廃。
# 各 bot 固有 port を bot-registry.txt から渡す (CTO 例: 8889)。
AGENT_ID='bot-name' DATABASE_URL='postgresql://localhost/agent_comms' \
WEBHOOK_PORT=8889 DISCORD_BOT_TOKEN='xxx' \
claude server:agent-comms \
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
| 2026-04-19 | Phase C I6: §8.1 を OSS Quick Start に書き換え（`npx agent-comms-mcp init/start/status`）。§8.2 を社内運用に限定。§16.5 起動コマンドに OSS 版を追加。 |
| 2026-03-28 | 初版：既存実装の仕様書化 + ADR-022統合プラグイン方針の反映 |
| 2026-03-28 | 追記：§5レート制限/ループ検出のDB永続化、§12エージェントID管理、§13 bot間認証、§14退行テスト |
| 2026-03-28 | 追記：§4.4 push通知詳細化（DBポーリング方式）、§11 Phase 3ロードマップ詳細化、§9.3 next 説明更新 |
| 2026-03-29 | 更新：§11 Phase 4詳細化（channel plugin化）、§8.2 起動コマンドをPhase 4形式に更新 |
| 2026-03-29 | 変更：Phase 4をWebhookチャネル方式に変更。§4.4 push通知仕様を全面改訂（LISTEN/NOTIFY + Webhook MCP server）。§8.2 起動コマンド更新 |
| 2026-03-29 | 追記：§3.2 Discordアダプター詳細仕様（受信/送信フロー、access制御）。§11 Phase 4.5追加 |
| 2026-03-29 | 更新：§11 Phase 5を統合アーキテクチャ（1プロセス・1接続）に書き換え |
| 2026-03-29 | 更新：§8.2 起動コマンドをPhase 5統合方式に更新。§11 webhook bridge内蔵化チェック |
| 2026-03-30 | 更新：§11 Phase 4残項目完了、Phase 4.5全項目完了、Phase 5全9bot統合展開完了 |
| 2026-03-30 | 追記：§9.3 fetch_discord_history ツール仕様追加（Discord API経由の履歴取得） |
| 2026-03-30 | 大幅更新：§2.1 全体構造をPhase 5統合版に改訂。§11 Phase 5を5.1〜5.6に詳細化（アダプターIF、Discord統合、listener統合、channel mapping、起動方式、削除対象）。§15 移行手順追加 |
| 2026-03-30 | 追記：§9.4 next にカーソルベース既読管理（last_read_id）の仕様追加。重複配信バグ修正 |
| 2026-04-02 | 追記：§16 Botライフサイクル管理。MCPツール4種（restart_bot, bot_status, watchdog_check, cleanup_ports）追加。ポート割当をbot-registry.txt準拠に更新 |
