# agent-com 統合メッセージキュー仕様 v1.0.2

> 旧仕様（receiver-architecture, channel-thread-control-spec, webhook-architecture）を統合・置き換え
> attachment-spec, chat-ui-sync-spec は独立文書として維持
> 全CLI対応（Claude Code / Codex CLI / Gemini CLI / 将来の任意CLI）

---

## 1. 設計原則

```
1. CLIコマンドが正のインターフェース。MCP toolsはラッパー
2. 受信は1プロセス（receiver）だけが行う。INSERT競合が構造的に不可能
3. 配信はDBキューで行う。HTTP POST / SSE / pg_notify直接配信を排除
4. LLMにUUID・チャンネルID・宛先選択を触らせない
5. 全メッセージがDBに記録される。例外経路ゼロ
6. MCP設定だけで接続完了。cron・外部スクリプト不要
7. PostgreSQLでもSQLiteでも同じCLIコマンドが動く
```

### 原則 #2 の実装対応（ADR-041 S2-B / PR#157）

「受信は1プロセス」を構造的に保証するため、Discord inbound は **stdio モード
の `discord.onMessage` ハンドラ 1 箇所のみ**に集約される（retreat path (a)
pull-on-notify 採用、PollingDriver を polling 基盤とする）。

- **stdio モード**: `discord.onMessage` を唯一の inbound entry point として
  保持し、`handleInboundMessage` → `agent_messages` / `message_queue` INSERT
  を行う。
- **daemon モード**: per-bot / shared Discord client は **outbound と admin
  専用**。`onMessage` を bind してはならないが、**connect 自体は保持**する
  （shared-token 配備の outbound REST / admin が継続動作するため）。daemon
  は PollingDriver と outbound_queue 消費のみを inbound 的に担当しない。
- daemon と stdio を同時に起動しても `handleInboundMessage` は 1 回だけ発火
  するため、`message_queue` への重複 INSERT は構造的に発生しない。

この不変条件は `tests/spec-enforcement/s2b-receiver-unify.test.ts` で
ソースレベルに pin されている。

---

## 2. 全体アーキテクチャ

```
┌──────────────────────────────────────────────────────────────────────┐
│  Discord / Telegram / Slack                                          │
│       ↓ inbound                              ↑ outbound             │
├──────────────────────────────────────────────────────────────────────┤
│  receiver（1プロセス、専用bot token）                                  │
│                                                                      │
│  Discord Gateway受信 → discordToUnified()                            │
│    → routeInbound()（純粋関数、pushTargets決定）                       │
│    → dispatcher()（v0.2.0: direct/delegate/summarize仕分け）          │
│    → enrichPayload()（v0.2.0: チャンネル別コンテキスト付与）            │
│    → agent_messages INSERT（全メッセージ永続記録）                      │
│    → message_queue INSERT（push対象bot分）                            │
│    → pg_notify / ファイルシグナル（新着通知のみ）                       │
│                                                                      │
│  outbound_queue消費（1秒polling）                                     │
│    → Discord REST API送信（bot固有token）                             │
│    → discord_message_id保存                                          │
│    → 失敗時リトライ（最大5回）                                        │
│                                                                      │
│  heartbeat監視（30秒ごと）                                            │
│    → 90秒途絶 → disconnected判定                                     │
│                                                                      │
│  起動時: 全bot tokenからdiscord_id一括登録                             │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    message_queue (DB)                                 │
│                    outbound_queue (DB)                                │
│                    agent_messages (DB)                                │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│  agent-com CLI（正のインターフェース）                                  │
│                                                                      │
│  agent-com next     未処理メッセージ1件取得                            │
│  agent-com send     返信送信                                          │
│  agent-com notify   自発送信（watchdog / 起動通知 / 定期レポート用）    │
│  agent-com status   自分の状態・キュー件数確認                         │
│  agent-com heartbeat ハートビート送信                                  │
│  agent-com agents   エージェント一覧取得                               │
│  agent-com history  チャンネル履歴取得                                 │
│  agent-com inbox    未読メッセージ一覧取得                             │
├──────────────────────────────────────────────────────────────────────┤
│      │                 │               │               │               │
│   MCP tools        bash直接         bash直接       bash直接          │
│  (CLIラッパー)                                                        │
│      │                 │               │               │               │
│   Claude             Codex            Gemini         将来の             │
│   Code             CLI              CLI            任意CLI            │
└──────────────────────────────────────────────────────────────────────┘

オプション:
┌──────────────────────────────┐ × bot数
│  presence client              │
│  Discord.js Client(intents:[])│
│  オンライン表示のみ、処理なし  │
└──────────────────────────────┘
```

---

## 3. DBスキーマ

### 3.1 agent_messages（全メッセージ永続記録、既存テーブル改修）

```sql
CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,                 -- UUID（アプリ側生成）
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]', -- JSON配列
  reply_to TEXT,                       -- 元メッセージID
  attachments TEXT NOT NULL DEFAULT '[]', -- JSON配列
  discord_message_id TEXT,             -- Discord native ID（C1対策）
  message_type TEXT NOT NULL DEFAULT 'message'
    CHECK (message_type IN ('message', 'system_error', 'system_info', 'emergency', 'digest', 'delegated')),
  sequence INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_am_channel_created ON agent_messages(channel_id, created_at);
CREATE INDEX idx_am_discord_id ON agent_messages(discord_message_id) WHERE discord_message_id IS NOT NULL;
```

### 3.2 message_queue（配信キュー、新規）

```sql
CREATE TABLE message_queue (
  id BIGSERIAL PRIMARY KEY,            -- SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
  agent_id TEXT NOT NULL,              -- 宛先bot
  message_id TEXT,                     -- agent_messages.id（systemメッセージはNULL可）
  payload TEXT NOT NULL,               -- PushPayload JSON（enrichment済み）
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'read', 'replied')),
  priority INTEGER NOT NULL DEFAULT 0, -- 高い値 = 高優先
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  replied_with TEXT                    -- 返信メッセージのID
);

CREATE INDEX idx_mq_agent_pending
  ON message_queue(agent_id, status, priority DESC, created_at ASC)
  WHERE status = 'pending';
```

### 3.3 outbound_queue（Discord送信キュー、新規）

```sql
CREATE TABLE outbound_queue (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL,            -- agent_messages.id
  agent_id TEXT NOT NULL,              -- 送信者（どのtokenで投稿するか）
  channel_external_id TEXT NOT NULL,   -- Discord channel/thread ID
  content TEXT NOT NULL,
  mentions_display TEXT DEFAULT '[]',  -- Discord表示用メンション（変換済み）
  attachments TEXT DEFAULT '[]',       -- ファイルパス配列
  reply_to_discord_id TEXT,            -- Discord native reply参照
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX idx_oq_pending
  ON outbound_queue(status, created_at ASC)
  WHERE status = 'pending';
```

### 3.4 agents（既存テーブル改修）

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('human', 'dev', 'org')),
  cli_type TEXT CHECK (cli_type IN ('claude_code', 'codex', 'gemini', 'other')),
  discord_token TEXT,                  -- 送信用（暗号化検討: §13）
  discord_user_id TEXT,                -- Discord上のuser ID
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('idle', 'busy', 'disconnected', 'offline')),
  status_detail TEXT,                  -- "PRレビュー中" 等
  status_updated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  heartbeat_interval INTEGER DEFAULT 30, -- 秒
  observer_mode BOOLEAN NOT NULL DEFAULT FALSE,
  dispatch_enabled BOOLEAN NOT NULL DEFAULT FALSE, -- v0.2.0
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.5 channels（既存テーブル改修）

```sql
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('channel', 'dm')),
  topic TEXT,                          -- チャンネルのトピック説明
  members TEXT NOT NULL DEFAULT '[]',  -- JSON配列
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 3.6 既存テーブル（変更なし）

```
channel_adapters    -- channel_id ↔ platform external_id
thread_adapters     -- thread_id ↔ platform external_id
agent_adapters      -- agent_id ↔ platform external_id + mention_format
message_attachments -- attachment-spec準拠
```

### 3.7 廃止カラム

```sql
-- 削除
ALTER TABLE agents DROP COLUMN IF EXISTS last_received_channel;
ALTER TABLE agents DROP COLUMN IF EXISTS last_received_thread;
ALTER TABLE agents DROP COLUMN IF EXISTS active_thread;
ALTER TABLE agents DROP COLUMN IF EXISTS default_channel;
ALTER TABLE agents DROP COLUMN IF EXISTS channel_port;
```

---

## 4. CLI コマンド仕様

全コマンドがJSON出力。全コマンドが `--agent-id` 必須。

### 4.1 agent-com next

未処理メッセージを1件取得。取得時点で既読マーク。
直前のnext結果がsend/skipされていなければ暗黙的にskip。

```bash
agent-com next --agent-id cto [--priority ceo_first] [--channel agent-mem]
```

```json
{
  "from": "ceo",
  "from_type": "human",
  "channel": "#agent-mem",
  "thread": "v0.2.0-test",
  "topic": "agent-memoryの記憶管理開発",
  "content": "テスト結果�d���",
  "attachments": [],
  "reply_context": null,
  "my_recent": [
    { "content": "テスト開始します", "created_at": "2026-04-08T10:00:00Z" }
  ],
  "channel_recent": [
    { "from": "arc", "content": "ビルド成功", "created_at": "2026-04-08T09:58:00Z" }
  ],
  "waiting": 12,
  "hint": "search_memory()で過去の決定事項を確認してから返信してください"
}
```

キューが空の場合:

```json
{
  "waiting": 0,
  "message": "未処理メッセージはありません"
}
```

**内部処理**:

```
1. 直前のcurrentMessageがあれば暗黙skip（status='read'のまま）
2. message_queueからpending最古の1件取得（priority/channel考慮）
3. status='read', read_at=NOW() に更新
4. agents.status='busy', status_detail='メッセージ処理中' に更新
5. currentMessageIdをプロセス内メモリに保持
6. ペイロードをJSON出力
```

### 4.2 agent-com send

直前にnextで取得したメッセージへの返信。reply_toは内部自動設定。

```bash
agent-com send --agent-id cto \
  --mentions ceo \
  --content "全件パスです" \
  [--attachments /path/to/file1,/path/to/file2]
```

```json
{
  "success": true,
  "message_id": "uuid-xxx",
  "delivered_to": "#agent-mem",
  "topic": "agent-memoryの記憶管理開発",
  "reply_context": {
    "original_author": "ceo",
    "original_content": "テスト結果どう？"
  },
  "mentions_delivered": ["ceo"],
  "remaining": 11
}
```

**内部処理**:

```
1. currentMessageIdが無い → NO_CURRENT_MESSAGE エラー
2. mentions検証:
   a. 空配列 → NOT_MENTIONEDエラー（元送信者を提案）
   b. 存在しないagent_id → INVALID_MENTION_FORMATエラー（有効一覧表示）
   c. DB不達 → MENTION_VALIDATION_UNAVAILABLEエラー
3. 権限チェック: channels.membersに送信者が含まれるか
4. reply_to = currentMessageId（自動設定）
5. 宛先 = currentMessageのchannel_id/thread_id（自動設定）
6. agent_messages INSERT
7. push対象のmessage_queue INSERT​（mentions対象分）
   → 対象botのstatusに応じて senderにフィードバック（§9）
8. outbound_queue INSERT​（Discord送信用）
9. currentMessageのstatus='replied', replied_with=message_id
10. currentMessageId = null
11. agents.status='idle' に更新
12. 結果をJSON出力
```

### 4.3 agent-com notify

自発送信（watchdog / 起動通知 / 定期レポート）。reply_to不要。
polling driver内のスケジューラや、MCP server内のsetIntervalから呼び出す。

```bash
agent-com notify --agent-id daily-reporter \
  --channel hotel-kanri \
  [--thread daily-reports] \
  --mentions cto \
  --content "日次レポート: テスト全件パス"
```

**内部処理**:

```
1. --channel, --mentions 必須チェック
2. channel解決（名前 or ID）
3. mentions検証（sendと同じ）
4. 権限チェック（sendと同じ）
5. agent_messages INSERT
6. push対象のmessage_queue INSERT
7. outbound_queue INSERT
8. 結果をJSON出力
```

### 4.4 agent-com status

自分の状態・キュー件数確認。

```bash
agent-com status --agent-id cto
```

```json
{
  "agent_id": "cto",
  "status": "idle",
  "pending": 12,
  "oldest_pending": "2min ago",
  "read_unprocessed": 0,
  "cli_type": "claude_code"
}
```

### 4.5 agent-com heartbeat

生存報告。polling driver内のsetIntervalで自動実行（§6.5）。CLIコマンドとしても手動実行可能。

```bash
agent-com heartbeat --agent-id codex-auditor
```

```json
{
  "ok": true,
  "agent_id": "codex-auditor",
  "last_seen_at": "2026-04-08T15:00:00Z"
}
```

### 4.6 agent-com agents

エージェント一覧取得。

```bash
agent-com agents [--status online]
```

```json
{
  "agents": [
    { "agent_id": "cto", "display_name": "CTO", "status": "busy", "cli_type": "claude_code" },
    { "agent_id": "arc", "display_name": "ARC", "status": "idle", "cli_type": "claude_code" },
    { "agent_id": "codex-auditor", "display_name": "Codex Auditor", "status": "idle", "cli_type": "codex" }
  ]
}
```

### 4.7 agent-com history

チャンネル履歴取得。

```bash
agent-com history --channel agent-mem [--limit 20] [--before msg_id]
```

### 4.8 agent-com inbox

未読メッセージ一覧取得（next_messageの一覧版）。

```bash
agent-com inbox --agent-id cto [--limit 20]
```

---

## 5. MCP Tools（Claude Code用ラッパー）

全ツールはCLIコマンドのラッパー。ロジックはCLI側に集約。

```typescript
// src/mcp-tools.ts

import { execSync } from "child_process";

const agentId = process.env.AGENT_ID;

server.tool("next_message", {
  description: "未処理メッセージを1件取得します。取得時点で既読になります。",
  params: {
    priority: { type: "string", optional: true, description: "ceo_first: CEO優先" },
    channel: { type: "string", optional: true, description: "特定チャンネルのみ" },
  },
}, async (params) => {
  const args = [`--agent-id`, agentId, `--format`, `json`];
  if (params.priority) args.push(`--priority`, params.priority);
  if (params.channel) args.push(`--channel`, params.channel);
  const result = execSync(`agent-com next ${args.join(" ")}`);
  return JSON.parse(result.toString());
});

server.tool("send", {
  description: buildSendDescription(agentCache),
  params: {
    mentions: { type: "array", items: { type: "string" }, required: true },
    content: { type: "string", required: true },
    attachments: { type: "array", items: { type: "string" }, optional: true },
  },
}, async (params) => {
  const args = [
    `--agent-id`, agentId,
    `--mentions`, params.mentions.join(","),
    `--content`, JSON.stringify(params.content),
    `--format`, `json`,
  ];
  if (params.attachments) args.push(`--attachments`, params.attachments.join(","));
  const result = execSync(`agent-com send ${args.join(" ")}`);
  return JSON.parse(result.toString());
});

// agents, history, inbox, status も同様にCLIラッパー

// ===== ハートビート（バックグラウンド） =====
setInterval(() => {
  try { execSync(`agent-com heartbeat --agent-id ${agentId}`); } catch {}
}, 30_000);
```

### 5.1 sendツールのdescription動的生成

```typescript
function buildSendDescription(agents: Agent[]): string {
  const list = agents
    .filter(a => a.status !== 'disabled')
    .map(a => `${a.agent_id} (${a.display_name})`)
    .join(", ");
  return (
    `直前にnext_message()で取得したメッセージへ返信します。\n` +
    `宛先チャンネルは自動設定されます。\n\n` +
    `mentionsに指定可能なagent_id:\n${list}\n` +
    `グループ: all（全員）, dev（開発者全員）, org（組織層全員）\n\n` +
    `返信前にsearch_memory()で過去の決定事項を確認してください。`
  );
}
```

### 5.2 agent_idキャッシュ

```typescript
let agentCache: Agent[] = [];
let cacheExpiry = 0;

async function refreshAgentCache(): Promise<Agent[]> {
  if (Date.now() > cacheExpiry) {
    const result = execSync(`agent-com agents --format json`);
    agentCache = JSON.parse(result.toString()).agents;
    cacheExpiry = Date.now() + 60_000;
  }
  return agentCache;
}
```

---

## 6. 各CLIでの利用方法

### 6.1 Claude Code（MCP経由）

```json
// .mcp.json
{
  "mcpServers": {
    "agent-comms": {
      "command": "node",
      "args": ["src/mcp-server.js"],
      "env": {
        "AGENT_ID": "cto",
        "AGENT_COM_DB": "postgres",
        "DATABASE_URL": "postgres://..."
      }
    }
  }
}
```

LLMはMCPツール（next_message, send, agents等）を使用。
ハートビートとpolling driverはMCP server内のsetIntervalで自動実行（§6.5参照）。
cron・外部スクリプト不要。MCP設定のみで完結。

### 6.2 Codex CLI（MCP経由）

```json
// .codex/config.toml 相当
[mcp]
agent-comms = { command = "node", args = ["src/mcp-server.js"] }

[mcp.agent-comms.env]
AGENT_ID = "codex-auditor"
AGENT_COM_DB = "postgres"
DATABASE_URL = "postgres://..."
```

Claude Codeと同一のMCP serverを使用。polling driver（§6.5）がMCP server内で自動実行されるため、crontab設定は不要。

Codexはpush受信（channel plugin）が使えないため、LLMがタスク完了後に`next_message`を自発的に呼ぶことで受信する。CLAUDE.md相当の指示で以下を記載：

```
タスク完了後、次のタスクに着手する前に必ず
mcp__agent_comms__next を実行してメッセージを確認してください。
メッセージがあれば対応してから次のタスクに進んでください。
```

polling driverはnext呼び出し間のメッセージをバッファし、next実行時に即返却する。

### 6.3 Gemini CLI（MCP経由）

Gemini CLIもMCP serverに接続可能な場合は§6.1/6.2と同一構成。
MCP未対応の場合のみbash直接実行にフォールバック：

```bash
#!/bin/bash
# gemini-fallback.sh（MCP未対応時のみ使用）

# agent-com CLIを直接呼び出し
# heartbeatはバックグラウンドで自動実行
agent-com daemon --agent-id spec-auditor &
DAEMON_PID=$!
trap "kill $DAEMON_PID" EXIT

gemini -p "あなたはspec-auditor（仕様監査役）です。
メッセージ確認: agent-com next --agent-id spec-auditor --format json
返信: agent-com send --agent-id spec-auditor --mentions <宛先> --content <内容>
まずメッセージを確認してください。"
```

`agent-com daemon`はheartbeat + polling driverを内蔵した常駐プロセス（§6.5のCLI版）。

### 6.4 将来の任意CLI

MCP対応CLI → MCP設定のみで接続完了。cron不要。
MCP未対応CLI → `agent-com daemon` + bash呼び出しで接続。cron不要。

いずれの場合もcrontab・外部スクリプト・追加セットアップは不要。

### 6.5 Polling Driver（MCP server内蔵）

全CLIで共通のメッセージ受信基盤。MCP serverプロセス内で自動実行される。

```typescript
// MCP server起動時に自動開始
class PollingDriver {
  private buffer: QueueRow[] = [];
  private interval: NodeJS.Timeout;

  constructor(
    private agentId: string,
    private db: DbAdapter,
    private intervalMs: number  // AGENT_COM_POLL_INTERVAL_MS（デフォルト: 3000）
  ) {
    // 1. heartbeat（30秒ごと）
    setInterval(() => this.heartbeat(), 30_000);

    // 2. polling（AGENT_COM_POLL_INTERVAL_MS ごどと）
    this.interval = setInterval(() => this.poll(), this.intervalMs);
  }

  private async poll(): Promise<void> {
    const pending = await this.db.getNextPending(this.agentId);
    if (pending) {
      this.buffer.push(pending);
      // ログ出力（デバッグ用）
      console.error(`[agent-com] new message from ${pending.author_id}`);
    }
  }

  // next_message ツール呼び出し時にバッファから返却
  async getNext(): Promise<QueueRow | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    // バッファ空の場合、即時DBチェック
    return this.db.getNextPending(this.agentId);
  }

  private async heartbeat(): Promise<void> {
    await this.db.query(
      `UPDATE agents SET last_seen_at = NOW(), status = 
       CASE WHEN status = 'disconnected' THEN 'idle' ELSE status END
       WHERE agent_id = $1`,
      [this.agentId]
    );
  }

  stop(): void {
    clearInterval(this.interval);
  }
}
```

```
動作フロー:

  MCP server起動
    → PollingDriver開始（heartbeat + polling自動実行）
    → LLMがnext_messageツールを呶ぶ
    → PollingDriver.getNext()がバッファから即返却
    → バッファ空ならDB直接チェック

  cron不要。外部スクリプト不要。MCP設定だけで動く。
```

```
CLI版（MCP未対応環境用）:

  agent-com daemon --agent-id <id>
    → 同一のPollingDriverをCLIプロセスとして実行
    → heartbeat + polling自動実行
    → LLMはagent-com next CLIコマンドで受信
```

```
環境変数:
  AGENT_COM_POLL_INTERVAL_MS=3000  # デフォルト3秒
```

スケーラビリティについては§14.5を参照。

---

## 7. Receiver

### 7.1 責務

```
1. Discord Gateway接続（1 Client、専用receiver bot token）
2. messageCreate → discordToUnified() → routeInbound()
3. agent_messages INSERT（このプロセスだけが実行 → 競合なし）
4. message_queue INSERT（push対象分）
5. outbound_queue消費 → Discord REST API送信
6. heartbeat監視 → disconnected判定
7. 起動時: 全bot tokenからdiscord_id一括登録
```

### 7.2 起動時のdiscord_id一括登録

```typescript
async function registerAllDiscordIds(db: DbAdapter, tokens: Map<string, string>) {
  for (const [agentId, token] of tokens) {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    const { id } = await res.json();
    await db.query(
      `UPDATE agents SET discord_user_id = $1 WHERE agent_id = $2`,
      [id, agentId]
    );
    console.log(`Registered ${agentId} → ${id}`);
    await new Promise(r => setTimeout(r, 1000)); // rate limit回避
  }
}
```

### 7.3 Inbound処理

```typescript
receiverClient.on("messageCreate", async (msg) => {
  if (msg.author.id === receiverClient.user?.id) return;

  // 自社botのメッセージは無視（outbound経由でDB保存済み）
  const allBotIds = agentDiscordIdCache; // 起動時に取得済み
  if (allBotIds.includes(msg.author.id)) return;

  // 1. Discord形式 → UnifiedMessage
  const unified = await discordToUnified(msg, db);

  // 2. routeInbound()（純粋関数）
  const channel = channelCache.get(unified.channel_id);
  const agents = agentCache;
  const result = routeInbound(unified, channel, agents);

  // 3. agent_messages INSERT
  await db.insertMessage(unified);

  // 4. push対象のmessage_queue INSERT
  for (const agentId of result.pushTargets) {
    const enriched = await enrichPayload(unified, agentId, db); // v0.2.0
    await db.insertQueue(agentId, unified.id, enriched);
    await bus.signal(`bot_${agentId}`); // 新着シグナルのみ
    // 送信者へのフィードバック（§9）
    await notifySenderOfDeliveryStatus(unified.author_id, agentId, unified.id);
  }
});
```

### 7.4 Outbound処理

```typescript
// 1秒ごとにoutbound_queueを消費
setInterval(async () => {
  const batch = await db.query(`
    SELECT * FROM outbound_queue
    WHERE status = 'pending' AND attempts < max_attempts
    ORDER BY created_at ASC LIMIT 10
  `);

  for (const row of batch) {
    try {
      const token = await db.getAgentDiscordToken(row.agent_id);
      
      // reply参照をDiscord native IDに変換
      const replyRef = row.reply_to_discord_id
        ? { message_id: row.reply_to_discord_id }
        : undefined;

      const discordMsgId = await sendToDiscordREST(
        token, row.channel_external_id, row.content,
        JSON.parse(row.attachments), JSON.parse(row.mentions_display), replyRef
      );

      // Discord message IDを記録（C1対策）
      await db.query(
        `UPDATE agent_messages SET discord_message_id = $1 WHERE id = $2`,
        [discordMsgId, row.message_id]
      );
      await db.query(
        `UPDATE outbound_queue SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [row.id]
      );
    } catch (err) {
      await db.query(
        `UPDATE outbound_queue
         SET attempts = attempts + 1, last_error = $1,
             status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END
         WHERE id = $2`,
        [err.message, row.id]
      );
    }
  }
}, 1000);
```

### 7.5 Heartbeat監視

```typescript
// 30秒ごとに全agentのheartbeatを確認
setInterval(async () => {
  await db.query(`
    UPDATE agents
    SET status = 'disconnected', status_detail = 'heartbeat timeout'
    WHERE last_seen_at < NOW() - (heartbeat_interval * 3 || ' seconds')::INTERVAL
      AND status NOT IN ('disconnected', 'offline')
  `);
}, 30_000);
```

### 7.6 キャッシュ

```typescript
// channels / agents は変更頻度が低いのでキャッシュ（TTL 60秒）
let channelCache: Map<string, Channel> = new Map();
let agentCache: Agent[] = [];
let agentDiscordIdCache: string[] = [];
let cacheExpiry = 0;

async function refreshCaches() {
  if (Date.now() > cacheExpiry) {
    const channels = await db.query("SELECT * FROM channels");
    channelCache = new Map(channels.map(c => [c.id, c]));

    agentCache = await db.query("SELECT * FROM agents");
    agentDiscordIdCache = agentCache
      .filter(a => a.discord_user_id)
      .map(a => a.discord_user_id);

    cacheExpiry = Date.now() + 60_000;
  }
}
```

### 7.7 Receiver Token

```
専用receiver bot（Discord Developer Portalで新規作成）を使う。
既存botのtokenを流用しない（C5対策）。

AGENT_COM_RECEIVER_TOKEN=（専用bot token）

このbotは受信専用。送信はしない。
Guild内の全チャンネルにアクセス可能な権限を付与。
Privileged Intents: MESSAGE CONTENT INTENT を有効化。
```

---

## 8. routeInbound（純粋関数）

全push経路で必ずこの関数を通る。例外なし。

```typescript
interface RouteResult {
  pushTargets: string[];
  dropTargets: Record<string, string>;
}

function routeInbound(
  msg: UnifiedMessage,
  channel: Channel,
  agents: Agent[]
): RouteResult {
  const pushTargets: string[] = [];
  const dropTargets: Record<string, string> = {};

  for (const memberId of JSON.parse(channel.members)) {
    const agent = agents.find(a => a.agent_id === memberId);
    if (!agent) continue;
    if (memberId === msg.author_id) continue;

    // DM → 無条件push
    if (channel.type === "dm") {
      pushTargets.push(memberId);
      continue;
    }

    // observer_mode → pushしない
    if (agent.observer_mode) {
      dropTargets[memberId] = "OBSERVER_MODE";
      continue;
    }

    // グループメンション（@all, @dev, @org）
    if (hasGroupMention(msg.mentions, agent)) {
      pushTargets.push(memberId);
      continue;
    }

    // 個別メンション
    if (msg.mentions.includes(memberId)) {
      pushTargets.push(memberId);
      continue;
    }

    // メンションされていない → drop
    dropTargets[memberId] = "NOT_MENTIONED";
  }

  return { pushTargets, dropTargets };
}
```

**humanも同じルール。例外なし。メンションベースで統一。**

---

## 9. Bot状態管理とフィードバック

### 9.1 状態遷移

```
offline → idle:          heartbeat受信時
idle → busy:             next_message実行時
busy → idle:             send実行時 or 次のnext_message実行時（暗黙skip）
idle/busy → disconnected: heartbeat 90秒途絶
disconnected → idle:      heartbeat再開時
```

### 9.2 送信者フィードバック

```typescript
async function notifySenderOfDeliveryStatus(
  senderId: string, targetId: string, messageId: string
) {
  const target = await db.getAgent(targetId);

  // idle → フィードバック不要（即配信）
  if (target.status === "idle") return;

  // busy → ビジー通知
  if (target.status === "busy") {
    const pending = await db.countPending(targetId);
    const elapsed = target.status_updated_at
      ? Math.floor((Date.now() - new Date(target.status_updated_at).getTime()) / 1000)
      : null;

    await db.insertQueue(senderId, null, JSON.stringify({
      author_id: "system",
      content: `⏳ ${targetId} はタスク処理中` +
        (target.status_detail ? `（${target.status_detail}）` : "") +
        (elapsed ? `、${elapsed}秒経過` : "") +
        `。キューに入りました（待ち${pending}件）。処理完了後に配信されます。`,
      message_type: "system_info",
      channel_name: "system",
    }));
    return;
  }

  // disconnected → エラー通知 + watchdog通知
  if (target.status === "disconnected") {
    await db.insertQueue(senderId, null, JSON.stringify({
      author_id: "system",
      content: `⚠️ ${targetId} はオフラインです。` +
        `メッセージはキューに保存されました。セッション復旧後に配信されます。`,
      message_type: "system_error",
      channel_name: "system",
    }));
    await notifyWatchdog(targetId, "disconnected");
    return;
  }
}
```

### 9.3 busy解除時の対応開始通知

```typescript
// agent-com send コマンド内（送信成功後）
async function notifyQueueWaiters(agentId: string) {
  const pending = await db.countPending(agentId);
  if (pending === 0) return;

  // 待機中の送信者たちに通知
  const senders = await db.query(`
    SELECT DISTINCT payload::json->>'author_id' as sender
    FROM message_queue
    WHERE agent_id = $1 AND status = 'pending'
  `, [agentId]);

  for (const row of senders) {
    await db.insertQueue(row.sender, null, JSON.stringify({
      author_id: "system",
      content: `✅ ${agentId} が対応可能になりました。キュー${pending}件の処理を開始します。`,
      message_type: "system_info",
      channel_name: "system",
    }));
  }
}
```

---

## 10. メンション制御

### 10.1 botはagent_id形式のみ使用

```
"cto", "arc", "hotel-dev" 等。
Discord形式（<@1234567890>）は使わない。
変換はCLI内部で自動実行。
```

### 10.2 sendコマンド内のmentions検証

```typescript
function validateMentions(
  mentions: string[],
  knownAgents: Agent[]
): ErrorResult | null {
  // 空配列チェック
  if (!mentions || mentions.length === 0) {
    // currentMessageの送信者を提案
    const suggestion = currentMessage?.author_id || "不明";
    return error("NOT_MENTIONED",
      `mentions必須。元メッセージの送信者は "${suggestion}" です。\n` +
      `利用可能: ${knownAgents.map(a => a.agent_id).join(", ")}, all, dev, org`);
  }

  // DB不達チェック
  if (knownAgents.length === 0) {
    return error("MENTION_VALIDATION_UNAVAILABLE",
      "agent一覧を取得できません。しばらく待ってから再送してください");
  }

  // 存在チェック
  const validIds = knownAgents.map(a => a.agent_id);
  const groupIds = ["all", "dev", "org"];
  const invalid = mentions.filter(m => !validIds.includes(m) && !groupIds.includes(m));
  if (invalid.length > 0) {
    return error("INVALID_MENTION_FORMAT",
      `不明なagent_id: ${invalid.join(", ")}\n` +
      `利用可能: ${validIds.join(", ")}, all, dev, org`);
  }

  return null;
}
```

### 10.3 メンション変換（CLI内部、自動）

```
Outbound: agent_id → Discord形式
  "cto" → "<@1487367645933211699>"
  agent_adaptersテーブルで変換

Inbound: Discord形式 → agent_id
  "<@1487367645933211699>" → "cto"
  agent_adaptersテーブルで逆引き
```

---

## 11. メッセージパターン

### 11.1 パターン一覧

```
パターン       経路           reply_to    mentions    宛先決定
─────────────────────────────────────────────────────────────
A. 通常返信    send           自動(内部)  必須        元メッセージの場所
B. 自発送信    notify CLI     なし        必須        CLI引数で指定
C. ビジー通知  system自動     —           自動        送信者のキュー
D. エラー通知  system自動     —           自動        送信者のキュー

全パターン共逛:
  ✅ agent_messages に記録される
  ✅ message_queue 経由で配信される
  ✅ outbound_queue 経由でDiscordに投稿される
  ✅ LLMがUUID/チャンネルIDを扱うことがない
```

### 11.2 引用テキスト付与

```typescript
function formatPushContent(payload: PushPayload): string {
  let content = "";

  if (payload.reply_to_content) {
    const quote = payload.reply_to_content.length > 500
      ? payload.reply_to_content.substring(0, 497) + "..."
      : payload.reply_to_content;
    content += `> [引用 from:${payload.reply_to_author}]\n`;
    content += `> ${quote.split("\n").join("\n> ")}\n\n`;
  }

  content += payload.content;

  if (payload.attachments?.length > 0) {
    content += "\n\n📎 添付ファイル:\n";
    for (const att of payload.attachments) {
      content += `- ${att.filename} (${att.size_bytes} bytes): ${att.temp_path}\n`;
    }
  }

  return content;
}
```

---

## 12. エラーコード一覧

```
NOT_MENTIONED                 mentions配列が空
INVALID_MENTION_FORMAT        存在しないagent_id
MENTION_VALIDATION_UNAVAILABLE DB不達でagent一覧取得不可
NO_CURRENT_MESSAGE            send実行時にnext未実行
MESSAGE_NOT_FOUND             指定メッセージIDが存在しない
NOT_MENTIONED_IN_ORIGINAL     reply_to元メッセージでメンションされていない
NOT_A_MEMBER                  送信者がチャンネルメンバーでない
MENTION_NOT_MEMBER            メンション先がチャンネルメンバーでない
CHANNEL_NOT_FOUND             チャンネルが存在しない
THREAD_NOT_FOUND              スレッドが存在しない
THREAD_ARCHIVED               アーカイブ済みスレッド
RATE_LIMITED                  レート制限超過
LOOP_DETECTED                 ループ検出
MESSAGE_TOO_LONG              50,000文字超過
SELF_SEND                     自己送信
ATTACHMENT_TOO_LARGE          ファイルサイズ超過
ATTACHMENT_BLOCKED_TYPE       ブロックされたファイル種別
ATTACHMENT_NOT_FOUND          指定ファイルが存在しない

全エラーで送信者にフィードバック。サイレントdrop禁止。
```

---

## 13. セキュリティ

### 13.1 通信経路

```
全通信がDB経由。HTTPポートはreceiverのhealthcheck（127.0.0.1:9000）のみ。
HMAC署名不要（HTTP POST配信を廃止したため）。
```

### 13.2 Discord Token管理

```
現状: agents.discord_token にプレーンテキスト保存
v0.2.0: 環境変数（DISCORD_TOKEN_{AGENT_ID}）に移行
  → DBにtokenを保存しない
  → receiverが起動時に環境変数から読み込み
  → SQLiteファイル流出時のtoken漏洩を防止
```

### 13.3 bash curl直叩き検出

```
agent_messagesに記録がないDiscord投稿を定期検出（receiver内蔵setInterval）:
  → receiver起動時 + 1時間ごと（receiver内のsetIntervalで自動実行）
  → Discord REST GET /channels/{id}/messages?after=...
  → agent_messages に対応するdiscord_message_idがない投稿 = bypass
  → audit_log記録 + CEO通知
  → cron不要。receiverプロセスが生きている限り自動実行
```

### 13.4 .env保護

```bash
chmod 600 .env
# Claude Code settings.json denyList
```

---

## 14. PostgreSQL / SQLite 対応

### 14.1 MessageBus抽象化

```typescript
interface MessageBus {
  signal(channel: string): Promise<void>;  // 新着通知のみ
  waitForSignal(channel: string, timeout: number): Promise<boolean>;
  close(): Promise<void>;
}

// PostgreSQL: pg_notify / LISTEN
class PgMessageBus implements MessageBus { ... }

// SQLite: message_queue テーブルの変更検知（polling）
class SqliteMessageBus implements MessageBus { ... }
```

### 14.2 DbAdapter抽象化

```typescript
interface DbAdapter {
  insertMessage(msg: UnifiedMessage): Promise<string>;
  getMessage(id: string): Promise<Message | null>;
  insertQueue(agentId: string, messageId: string, payload: string): Promise<void>;
  getNextPending(agentId: string, priority?: string, channel?: string): Promise<QueueRow | null>;
  updateQueueStatus(id: number, status: string, extra?: object): Promise<void>;
  countPending(agentId: string): Promise<number>;
  insertOutbound(row: OutboundRow): Promise<void>;
  getAgents(): Promise<Agent[]>;
  getChannel(id: string): Promise<Channel>;
  // ...
}

class PgDbAdapter implements DbAdapter { ... }
class SqliteDbAdapter implements DbAdapter { ... }
```

### 14.3 設定

```env
AGENT_COM_DB=postgres    # pg_notify（リアルタイム）
AGENT_COM_DB=sqlite      # polling（1-2秒遅延）

DATABASE_URL=postgres://user:pass@localhost:5432/agent_com
AGENT_COM_SQLITE_PATH=./data/agent-com.db

AGENT_COM_POLL_INTERVAL_MS=3000  # polling間隔（§6.5参照）
```

### 14.4 比較

```
                    PostgreSQL           SQLite
──────────────────────────────────────────────────
セットアップ        docker-compose必要    不要（ファイル1つ）
配信遅延           ~0秒（pg_notify）     ~1秒（polling）
同時書き込み        高性能               WALモードで対応
bot数上限          無制限               ~10 bot
agent-memory連携   pgvector使用可        別途対応必要
推奨用途           本番・大規模         開発・小規模
```

### 14.5 スケーラビリティ（polling driver）

bot数に応じたpolling driverの推奨設定。

```
bot数         推奨間隔                     負荷
────────────────────────────────────────────────────────
~10 bot       3秒（デフォルト）              ~3 qps、問題なし
~50 bot       5-10秒に延長                  ~5-10 qps、問題なし
~100 bot      polling非効率                 pg_notifyハイブリッドに切替
```

```
~10 bot（デフォルト）:
  AGENT_COM_POLL_INTERVAL_MS=3000
  クエリ: SELECT ... WHERE delivered = false AND target = $1
  インデックス付き単納SELECT、1クエリ < 1ms
  PostgreSQL/SQLite共に問題なし

~50 bot:
  AGENT_COM_POLL_INTERVAL_MS=5000 〜 10000
  環境変数で調整するだけ。コード変更不要

~100 bot以上:
  PollingDriverをpg_notifyハイブリッドモードに切替:
    PostgreSQL: pg_notify受信 → 即座にgetNext()
    SQLite: 従来のpolling（間隔延長）
  将来Claude CodeがMCP notificationのコンテキスト注入を
  サポートした時点でpush方式に完全移行可能
```

OSS利用者の大半は1-10 bot構成のため、デフォルト3秒で十分。

---

```typescript
// intents空 → イベント一切受信しない
// Gateway接続だけでDiscord上にオンライン表示
const client = new Client({ intents: [] });
client.login(process.env.DISCORD_TOKEN);
```

各botのtmuxセッションでバックグラウンド実行。
メッセージの送受信に影響なし。起動しなくても機能に問題なし。

---

## 16. 移行戦略

### 16.1 Mixed Mode（旧新共存）

```
Phase A: receiverを追加起動（既存per-bot clientも維持）
  → 両方がメッセージを受信
  → discord_message_id UNIQUE制約 + ON CONFLICT DO NOTHING でdedup
  → 旧botは変わらず動く

Phase B: 1 botずつ新方式に切替
  → per-bot clientの受信を停止
  → CLI + message_queue経由に切替
  → 問題があればper-bot client再開（ロールバック可能）

Phase C: 全bot切替完了
  → 旧daemon/channel-server コード削除
  → per-bot Discord clientをpresence clientに置換
```

### 16.2 ロールバック

```
各Phase間でロールバック可能:
  Phase B失敗 → per-bot client再開（即時復旧）
  Phase A失敗 → receiver停止（既存動作に影響なし）
```

---

## 17. agent-memoryとの連携

### 17.1 search_memory誘導

```
next_messageの結果にhintを含める:
  "hint": "search_memory()で過去の決定事項を確認してから返信してください"

sendツールのdescriptionにも記載:
  "返信前にsearch_memory()で過去の決定事項を確認してください。"
```

### 17.2 DB共有

```
PostgreSQL環境:
  agent-comとagent-memoryが同一DBを共有（既存方式維持）
  CREATE TABLE IF NOT EXISTS パターンで共存

SQLite環境:
  agent-com用とagent-memory㔨で別ファイル
  agent-memoryのpgvector依存はSQLiteでは使えない → テキスト検索fallback
```

---

## 18. 監視

### 18.1 Receiverヘルスチェック

```json
// GET http://127.0.0.1:9000/health
{
  "status": "healthy",
  "db_type": "postgres",
  "discord": {
    "connected": true,
    "user": "agent-com-receiver#1234",
    "guilds": 1
  },
  "queues": {
    "message_queue_pending": 23,
    "outbound_queue_pending": 0,
    "outbound_queue_failed": 1
  },
  "agents": {
    "idle": 5,
    "busy": 2,
    "disconnected": 1
  },
  "uptime_seconds": 7200
}
```

### 18.2 Gemini CLI Spec Auditor（日次）

```
全仕様書を一括読み込み → 矛盾検出レポート
spec-auditor botがpolling driver（§6.5）で常駐。
CLAUDE.md相当の指示で24時間ごとに全spec監査を自発実行。
PRマージ後のトリガーはagent-com notify経由でbot宛にメッセージ送信。
結果をCEOのキューに投入。
cron不要。
```

### 18.3 bash curl直叩き検出（receiver内蔵、1時間ごと）

```
receiver内のsetIntervalで自動実行（§13.3と同一実装）。
Discord REST APIで最新メッセージ取得
→ agent_messages.discord_message_idと突合
→ 未記録のメッセージ = bypass → audit_log + CEO通知
cron不要。receiverプロセスに内蔵。
```

---

## 19. v0.2.0 精度向上対策

### 19.1 Push Enrichment

message_queue INSERT前に、受信者のチャンネル別直近発言・会話フローを付与。
詳細は §4.1 next_messageのmy_recent / channel_recentフィールドで実装済み。

### 19.2 Dispatcher層

routeInbound()とmessage_queue INSERT間に挟み、メッセージを仕分け。
direct / delegate / summarize の3択。ルールベース + Haikuフォールバック。
詳細は別文書（receiver-architecture §19.2）を参照。

### 19.3 チャンネルtopic表示

channels.topicカラムを追加済み（§3.5）。
next_message結果 / send結果にtopicを含めることで、LLMがチャンネルの目的を常に把握。

---

## 20. 設定一覧

| 環境変数 | デフォルト | 説明 |
|----------|-----------|------|
| `AGENT_COM_DB` | `sqlite` | DB種別 |
| `DATABASE_URL` | — | PostgreSQL接続文字列 |
| `AGENT_COM_SQLITE_PATH` | `./data/agent-com.db` | SQLiteファイルパス |
| `AGENT_COM_RECEIVER_TOKEN` | — | 専用receiver bot token |
| `DISCORD_TOKEN_{AGENT_ID}` | — | 各botのDiscord token |
| `AGENT_COM_POLL_INTERVAL_MS` | `3000` | polling間隔（§6.5、§14.5参照） |
| `AGENT_COM_HEALTH_PORT` | `9000` | healthcheckポート |
| `AGENT_COM_PRESENCE` | `false` | presence client起動 |
| `AGENT_COM_ENRICH_PUSH` | `false` | Push Enrichment(v0.2.0) |
| `AGENT_COM_DISPATCH_ENABLED` | `false` | Dispatcher(v0.2.0) |
| `AGENT_COM_DISPATCH_MODEL` | `claude-haiku-4-5-20251001` | 判定用LLM |
| `AGENT_COM_ATTACHMENT_TTL_HOURS` | `24` | 添付ファイル保持時間 |
| `AGENT_COM_ATTACHMENT_MAX_SIZE` | `52428800` | 添付1ファイル上限(bytes) |
| `AGENT_COM_ATTACHMENT_DISK_LIMIT_MB` | `1024` | temp領域ディスク上限 |

---

## 21. 実装優先順

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | agent-com CLI基盤（next / send / notify / status / heartbeat / agents） | なし |
| 2 | DbAdapter（Pg + SQLite） + MessageBus（Pg + SQLite） | なし |
| 3 | message_queue / outbound_queue テーブル + マイグレーション | Phase 2 |
| 4 | receiver実装（inbound + outbound消費 + heartbeat監視） | Phase 2, 3 |
| 5 | MCP tools（CLIラッパー） | Phase 1 |
| 6 | 移行: Mixed Mode（Phase A: receiver追加起動） | Phase 4 |
| 7 | 移行: Phase B（1 botずつ新方式切替） | Phase 6 |
| 8 | 移行: Phase C（旧コード削除 + presence client） | Phase 7 |
| 9 | v0.2.0: Push Enrichment + Dispatcher | Phase 7完了後 |
| 10 | v0.2.0: Gemini CLI spec auditor + bash curl検出 | Phase 7完了後 |

Phase 1-5: 実装。Phase 6-8: 移行。Phase 9-10: 精度向上。

---

## 22. 廃止される要素

```
❌ SSE daemon
❌ Per-Bot Discord Client（受信用）
❌ channel-server / agent-comms-channel
❌ HTTP POST配信 / HMAC署名
❌ SSE transport
❌ reply tool（send統一）
❌ last_received_channel / last_received_thread
❌ active_thread / focus / unfocus
❌ send toolのtoパラメータ
❌ send toolのreply_toパラメータ（LLMから隠蔽、内部自動設定）
❌ resolveDeliveryTargets()（routeInboundに統一）
❌ channel_portカラム / ポート管理
❌ 共有Client vs Per-Bot Clientの二重構造
❌ human → 全員push例外
```

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-04-12 | v1.0.2: §6.1-6.5 全CLIをMCP内蔵polling driverに統一、§14.5 スケーラビリティ追加、§4.3/4.5/13.3/18.2/18.3 cron依存を全廃止（全てMCP server/receiver内蔵に統一） |
| 2026-04-10 | v1.0.0: 統合メッセージキュー仕様（旧receiver-architecture + channel-thread-control統合、全22セクション） |
