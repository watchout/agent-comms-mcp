# agent-com 統合メッセージキュー仕様 v1.0.3

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
- **daemon モード**:
  - per-bot Discord client は `onMessage` を bind せず、connect のみ保持
    （outbound REST 専用）。
  - shared Discord client は connect を保持し、**`onMessage` は §2.2
    Pattern A 人間警告専用の shortcut のみ** bind する。この listener は
    `sendHumanWarning` のみを呼び、`handleInboundMessage` /
    `message_queue` INSERT は行わない。
  - つまり daemon は inbound routing（`handleInboundMessage`）を呼ばないが、
    mention されない人間投稿への warning 機能だけは保持する。
  - daemon は PollingDriver と outbound_queue 消費を担当する (PR #172 FEAT-005: 具体的には `entrypoints/daemon.ts` が `startOutboundConsumer()` の唯一の呼出点、server.ts `registerAgent()` からは除去済)。
  - **2026-04-14 phasing 注記 (CEO directive Task 1, auditor cycle 2 startup-order fix)**: 現行 production 起動経路は `claude server:agent-comms` → server.ts (stdio MCP) で、`AGENT_COM_RUNTIME=daemon` を shell 環境で立てるパターン。`entrypoints/daemon.ts` に supervise wrapper が無い間は、**server.ts も `isDaemonRuntime()` の条件下で `startOutboundConsumer()` を呼ぶ**ことを許容する（両経路から起動可）。呼出位置は `discordClients.set(AGENT_ID, discord)` の直後（postConnect 内）に限定する — `registerAgent()` 末尾に置くと 1 秒 tick が `discord.connect()` resolve 前に発火し、`no_discord_client_for_agent` で全行 failed になる (cycle 1 で観測)。current production topology (claude CLI 1 agent = 1 process) では 19-bot race は想定しない。supervise 基盤完成時に server.ts 側を再剥離して daemon-only invariant を復元する。
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

-- v1.0.3: DDL invariant — duplicate-INSERT safety net (ADR-048 Phase 0 D4)
-- Rationale: handleInboundMessage の onMessage path が複数 (stdio + daemon
-- per-bot + daemon shared) 存在した時期に、同一 (agent_id, message_id) が
-- 複数行 enqueue される drift が発生した。受信経路の一元化 (ADR-041 PR-B)
-- が完了しても、DB 側の保険として部分 UNIQUE を保持する。
CREATE UNIQUE INDEX uq_mq_agent_message
  ON message_queue(agent_id, message_id)
  WHERE message_id IS NOT NULL;
```

**DML rule (上記 DDL invariant `uq_mq_agent_message` と対応)**:
`message_queue` への INSERT は **必ず** 以下の形式で行うこと。ON CONFLICT の target を明示し (部分 UNIQUE の述語も同一)、並行 enqueue が UNIQUE 違反で throw しない・どの制約が発火したかも明示される:

```sql
INSERT INTO message_queue (agent_id, message_id, payload)
VALUES ($1, $2, $3)
ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING;
```

`message_id` が NULL のシステムメッセージ経路は部分 UNIQUE の対象外なので ON CONFLICT は発火しない (legacy 互換)。

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
    CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),  -- FEAT-005 CP-3: renamed 'processing' → 'claimed'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,              -- S2-A (PR #164): consumer が atomic claim した時刻、orphan 検出用
  next_retry_at TIMESTAMPTZ,           -- S2-A (PR #164): transient 失敗時の exponential backoff 再試行時刻
  discord_message_id TEXT              -- Phase C Step 1 PR-A (PR #168): 送信成功時 Discord snowflake を観測性カラムとして永続化 (dedup layer ではない — 詳細は §7.4)
);

CREATE INDEX idx_oq_pending
  ON outbound_queue(status, created_at ASC)
  WHERE status = 'pending';

-- FEAT-005 CP-3: 'claimed' claim の orphan 検出用 + agent 毎の next_retry_at 早期取り出し用
CREATE INDEX idx_outbound_queue_claimed_claimed_at
  ON outbound_queue(status, claimed_at)
  WHERE status = 'claimed';
CREATE INDEX idx_outbound_queue_agent_pending_next_retry
  ON outbound_queue(agent_id, status, next_retry_at)
  WHERE status = 'pending';
```

**カラム詳細** (drift 解消、実装と同期、本 §3.3 が SSOT):

| カラム | 導入 PR | 役割 |
|---|---|---|
| `status='claimed'` | PR #164 (S2-A) / PR #172 (FEAT-005 CP-3) | atomic claim で `UPDATE status='pending'→'claimed'` する瞬間的状態。`FOR UPDATE SKIP LOCKED` と組み合わせて別 consumer の二重取得を防ぐ。vocabulary was `'processing'` in PR #164; renamed to `'claimed'` in PR #172 to match work-queue convention and the claim SQL verb |
| `claimed_at` | PR #164 (S2-A) | consumer が claim した瞬間の wall-clock。orphan 再回収の閾値判定 (`OUTBOUND_ORPHAN_TIMEOUT_SEC`) |
| `next_retry_at` | PR #164 (S2-A) | transient failure 後の再試行最早時刻。`min(30s, 2^(attempt-1)) + jitter` の exponential backoff |
| `discord_message_id` | PR #168 (Phase C Step 1 PR-A) | 送信成功時 Discord snowflake を永続化する **観測性カラム**。dedup layer ではない — `status='sent'` と同じ UPDATE で atomic に書くため、通常 pending filter は discord_message_id 非 null の行を拾わない構造的保証があり、consumer 内の short-circuit 分岐は mark-sent 完了後に行が何らかの理由で再度 pending に戻る極稀なエッジケースに対する**限定的保険**として動作するに留まる。実効 dedup は §7.4 の 2 層 (platform nonce + 40062 idempotent 収束)|

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

受信メッセージへの返信。分岐は `agents.current_message_id` の state で決まる（caller 非依存）。caller (CLI / MCP) は到達可能な分岐の組み合わせが異なる（ADR-048 Phase 0 D3）:

**分岐 A — primary path (`agents.current_message_id` set)**
- `next` で pop 済の行への返信。`current_message_id` が当該 `message_queue.id` を指す
- CLI: 常にこの分岐（`next` → `send` パターン必須）。`--reply-to` は省略可で、省略時は `current_message_id` が指す行の `message_id` を内部解決
- MCP: LLM が MCP `next` tool を呼んだ後の send。`reply_to` は tool schema で required（caller 指定）
- `message_queue` 遷移は **primary UPDATE**: `WHERE agent_id AND id = current_message_id`

**分岐 B — fallback path (`current_message_id = NULL`, `reply_to` 指定あり)**
- MCP の channel-plugin session-injection 経路専用（LLM session に直接注入され、`next` tool を呼ばない）
- CLI はこの分岐に**到達不能**: `current_message_id` が未 set なら `NO_CURRENT_MESSAGE` エラーで pre-send 中断
- MCP は `reply_to` 必須（`agent_messages.id` UUID 前提）
- `message_queue` 遷移は **fallback UPDATE**: `WHERE agent_id AND message_id = reply_to AND status IN ('pending','read')`
- PR#142 (v1.0.3 §3.2) の partial UNIQUE `uq_mq_agent_message` により 0-or-1 行

**到達可能 matrix**:

| Caller | 分岐 A (primary) | 分岐 B (fallback) |
|---|---|---|
| **CLI** | ✅ default（`next` → `send`） | ❌ `NO_CURRENT_MESSAGE` で到達不能 |
| **MCP** | ✅ MCP `next` tool 経由 | ✅ channel-plugin session-injection 経由（本 PR 対応） |

本 PR (#156) で追加したのは **分岐 B の fallback UPDATE** と関連 observability（step 9 参照）。分岐 A の primary UPDATE は従前から存在し、CLI / MCP 共通で動作する。

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
1. 経路判定（`agents.current_message_id` の state で決まる、caller 非依存）:
   - `current_message_id` set → **分岐 A (primary path)**
   - `current_message_id = NULL` かつ `reply_to` 指定あり → **分岐 B (fallback path)**
   - どちらも不成立:
     - CLI: `NO_CURRENT_MESSAGE` エラー（CLI は分岐 B に到達不能）
     - MCP: `NO_REPLY_TO` エラー（`reply_to` 引数が tool schema で required）
2. mentions検証:
   a. 空配列 → NOT_MENTIONEDエラー（元送信者を提案）
   b. 存在しないagent_id → INVALID_MENTION_FORMATエラー（有効一覧表示）
   c. DB不達 → MENTION_VALIDATION_UNAVAILABLEエラー
3. 権限チェック: channels.membersに送信者が含まれるか
4. reply_to 確定（`agent_messages.id` UUID 前提）:
   - **CLI 分岐 A (`--reply-to` 省略時)**: `agents.current_message_id` が指す `message_queue` 行の `message_id` を内部解決して default に採用
   - **それ以外（CLI 分岐 A `--reply-to` 明示時 / MCP 分岐 A / MCP 分岐 B）**: caller 指定の `reply_to` をそのまま使用
5. 宛先解決（`resolveSendDestination(reply_to)`）:
   - 両分岐共通: `reply_to` の UUID から `agent_messages` を引き、`channel_id` / `thread_id` を導出
   - `reply_to` が `agent_messages` に存在しない（e.g., Discord snowflake 直渡し） → `MESSAGE_NOT_FOUND` エラー（fallback UPDATE 未到達）
6. agent_messages INSERT
7. push対象のmessage_queue INSERT​（mentions対象分）
   → 対象botのstatusに応じて senderにフィードバック（§9）
8. outbound_queue INSERT​（Discord送信用）
9. message_queue を 'replied' へ遷移（ADR-048 Phase 0 D3）:
   - **分岐 A (primary UPDATE, CLI / MCP 共通)**:
     `UPDATE message_queue SET status='replied', replied_with=message_id WHERE id = current_message_id`
   - **分岐 B (fallback UPDATE, MCP session-injection 専用)**:
     `UPDATE message_queue SET status='replied', replied_with=message_id
      WHERE agent_id=$self AND message_id=reply_to AND status IN ('pending','read')`
     - v1.0.3 §3.2 の partial UNIQUE `uq_mq_agent_message` により 0 or 1 行
     - 0 行の場合は `d3.fallback.miss` を audit_log に記録（このbotが queue に持っていない UUID への reply = cross-agent 応答等）
     - 例外時は `d3.fallback.error` を audit_log + stderr JSON log、send 本体は成功（non-fatal）
   - **scope**: reply_to は `agent_messages.id` UUID 前提。Discord snowflake 経路は step 5 の `resolveSendDestination` で `MESSAGE_NOT_FOUND` として pre-send 段階で落ちる → 別 issue #158 (D3b)
10. current_message_id = null（分岐 A のみ）
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

#### 4.8.1 inbox cursor semantics (Issue #179 — 2026-04-15)

`fetchNewMessages` (server.ts / `core/inbox-cursor.ts`) は per-process の **composite cursor `(created_at, id)`** を保持する。SQL predicate:

```sql
-- 次回呼出で既読分を除外する条件
AND (created_at > $cursor_created_at::timestamptz
     OR (created_at = $cursor_created_at::timestamptz AND id > $cursor_id::uuid))
ORDER BY created_at ASC, id ASC
```

- **不変条件**:
  1. `created_at` を主キー (µs 粒度、PG timestamptz の最小保持精度) に、`id` を **同 µs 内**行の tiebreaker として用いる。UUID v4 は時系列順でないため単独 cursor としては使わない (bare `id > $cursor` は lex 比較で新着を取りこぼす、Issue #179 の原因)。JS `Date` は ms 粒度に丸めるため、cursor は `created_at_text` companion column 経由で µs を保持する (precision 段参照)
  2. cursor 進める条件は rows.length > 0 のみ。empty 結果では cursor を保持 (再試行で取りこぼさない)
  3. cursor は process 単位の in-memory state、restart で null に戻る (restart 直後は全 unread を返すためカーソル overrun リスクなし)
  4. 行の `metadata->>'to' = $agent_id` filter は cursor と独立。route 判定は handleInboundMessage Step 7b で確定済 (Issue #177 で同期問題を追跡)

- **SQL 形式の注意**: 行値比較 `(created_at, id) > ROW($3, $4)` は node-postgres で PG 42P18 ("could not determine data type of parameter") を誘発するため **expanded form** で書く (`created_at > $3 OR (created_at = $3 AND id > $4)`)。同値。

- **precision は µs 相当** (PR #182 cycle 3 auditor BLOCK 対応): PG timestamptz は µs 保持、node-postgres の default OID 1184 parser は JS `Date` (ms 粒度) に落とす。cursor を parsed `Date` から生成すると cursor ms / DB µs の非対称で `created_at > cursor` に**同一行が再マッチし duplicate delivery** が起きる (cycle 2 で見落とした論理バグ)。対応として SELECT に companion column `created_at::text AS created_at_text` を追加し、cursor 値はそちらから取る。PG の text cast は cursor round-trip に必要な精度を保持する (default DateStyle 下では `'2026-04-15 07:15:00.123456+00'` 形式)。global `pg.types.setTypeParser` 上書きは**しない** (他 timestamptz 消費箇所への副作用を避ける)。predicate/index path は実質不変の見込み (WHERE 述語は `created_at > $3::timestamptz` のままで SELECT 列追加のみ)。`id` UUID tiebreaker は µs-tied 行の case を guard。

- **`created_at_text` 観測差分**: `InboxRow.created_at_text` は optional 公開フィールドとして callers (inbox tool, 将来の consumer) に観測可能。raw row を JSON.stringify / snapshot test する consumer は出力に差分が出る。列名 tidy (非公開化 / 別 object 化) は **本 Issue #179 の scope 外、future cleanup**。

- **behavioral test** (`tests/inbox-cursor.test.ts`):
  - UUID lex 順 ≠ 時系列の具体例 pair で Issue #179 回帰を pin
  - `created_at::text AS created_at_text` が SELECT に含まれることを pin
  - cursor が companion text (µs) を Date (ms) より優先することを unit test で pin
  - **µs round-trip DB integration** (auditor cycle 2 必須指摘対応): `'.123456+00'` 行を INSERT → fetch1 は行を返しつつ cursor が `/\.\d{6}\+\d{2}$/` にマッチ → fetch2 で同 cursor を使い empty を確認 (duplicate delivery regression guard)

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

### 6.5 Polling Driver（embeddedモード / standaloneモード）

全CLIで共通のメッセージ受信基盤。2つの起動モードを持つ。

```
AGENT_COM_DAEMON_MODE=embedded    MCP server内蔵（デフォルト）
AGENT_COM_DAEMON_MODE=standalone  agent-com daemon別プロセス（推奨）
```

**standaloneモード（推奨）:** MCP serverのlazy spawnに依存しない。restart-bot.shで先にdaemonを起動するため、 MCP serverが起動する前からheartbeat + pollingが動作する。全CLI・全botで同一の起動スクリプトが使える。

```bash
# restart-bot.sh（全bot共通、standaloneモード）
agent-com daemon --agent-id $AGENT_ID &   # 即起動、CLI不問
claude server:agent-comms ...             # or codex / gemini / 任意CLI
```

**embeddedモード（レガシー）:** MCP serverプロセス内でPollingDriverを実行。MCP serverがlazy spawnされるまで heartbeat/pollingが開始しない。agent-comms toolを 1 回も呼ばないbotではMCP serverが起動せず `initializing` 固定になる問題がある (Issue #183、§16.6 技術制約 #3 参照)。

```typescript
// PollingDriver実装（embedded/standalone共通）
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

    // 2. polling（AGENT_COM_POLL_INTERVAL_MS ごと）
    this.interval = setInterval(() => this.poll(), this.intervalMs);
  }

  private async poll(): Promise<void> {
    const pending = await this.db.getNextPending(this.agentId);
    if (pending) {
      this.buffer.push(pending);
      console.error(`[agent-com] new message from ${pending.author_id}`);
    }
  }

  async getNext(): Promise<QueueRow | null> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }
    return this.db.getNextPending(this.agentId);
  }

  private async heartbeat(): Promise<void> {
    await this.db.query(
      `UPDATE agents SET heartbeat_at = NOW(), status = 
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

standaloneモードの動作フロー:

```
  restart-bot.sh実行
    → agent-com daemon起動（即座にPollingDriver開始）
    → heartbeat + polling即開始（MCP serverの起動を待たない）
    → LLM CLIセッション起動
    → LLMがnext_messageツールを呼ぶ
    → MCP server経由でdaemonのバッファから即返却

  MCP serverのlazy spawnに依存しない。
  agent-comms toolを 1 回も呼ばないbotでもheartbeatが動作する。
```

embeddedモードの動作フロー（レガシー）:

```
  MCP server起動（lazy spawn: 最初のtool呼び出し時）
    → PollingDriver開始
    → LLMがnextを呼ぶ → バッファから返却

  注意: MCP serverがspawnされるまでheartbeat/pollingは動作しない。
```

```
環境変数:
  AGENT_COM_DAEMON_MODE=standalone  # デフォルト: standalone（推奨）
  AGENT_COM_POLL_INTERVAL_MS=3000   # デフォルト 3 秒
```

スケーラビリティについては§14.5を参照。

### 6.6 確定済み技術制約

以下は Claude Code CLI の仕様制約であり、agent-com では回避不能。

```
1. MCP notification による Claude Code コンテキスト注入: NG
   （2026-04-11 stdio/SSE 両方で実機検証済み）

2. MCP notification による idle session wake: NG
   （2026-04-14 notification 到達は確認、session を wake しない。Issue #178）

3. MCP server lazy spawn: tool が呼ばれるまで起動しない
   （Claude Code 省メモリ設計。standalone モードで回避。Issue #183）
```

結論: bot への即時 push は現時点で不可能。

```
全 bot は next polling + タスク完了後の自発的 next 呼び出しで受信。
standalone モードの daemon が heartbeat + polling の起動を保証する。
```

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

#### 7.3.1 Inbound handler transactional semantics (Issue #177 — 2026-04-15)

`handleInboundMessage` (in `adapters/inbound-receiver.ts`) executes four
post-routing persistence steps for every delivered message. Until Issue
\#177 they ran as independent queries with 7b's error silently swallowed;
2026-04-15 07:09-07:21 JST observed "inbox-ghost" where 7d succeeded,
7b did not, and `fetchNewMessages` hid the row because its `WHERE
metadata->>'to' = $agent` filter saw NULL.

**Atomic commit boundary (7b + 7d):**

- Step **7b** — `UPDATE agent_messages SET metadata = metadata ||
  jsonb_build_object('to', $receiverAgentId) WHERE id = $messageId`
- Step **7d** — `INSERT INTO message_queue (agent_id, message_id,
  payload) VALUES (...) ON CONFLICT (agent_id, message_id) WHERE
  message_id IS NOT NULL DO NOTHING RETURNING id`

Both queries run on a **transaction-private** `pg.Client` inside one
`BEGIN`/`COMMIT`. Implementation: `core/inbound-delivery.ts`
`persistInboundDelivery(databaseUrl, params)`. Invariants:

1. **Both-or-neither *and* UPDATE row matched** (Cycle 2 — auditor
   BLOCKER 2). A successful return means (a) Step 7b's UPDATE matched
   exactly one row (stale `messageId` is caught and forces a
   `ROLLBACK` with `error: 'update_no_match'`) AND (b) Step 7d's
   INSERT was either accepted or dedup-suppressed by `ON CONFLICT DO
   NOTHING`. Any thrown error (connection loss, constraint violation,
   unexpected server state) or UPDATE mismatch triggers `ROLLBACK`; no
   partial `metadata.to` / `message_queue` state is observable to
   readers that open a new transaction after the failure.
2. **No silent swallow.** Failures return `{committed: false, error}` to
   the caller, which logs one `stderr` line with `receiverAgentId`,
   `messageId`, and the error. Pre-fix `.catch(() => {})` is gone.
3. **Transaction-private connection** (Cycle 2 — auditor BLOCKER 1).
   `persistInboundDelivery()` instantiates a dedicated `pg.Client` from
   the given `databaseUrl`, connects, runs the transaction, and
   `end()`s in `finally`. The process-global singleton returned by
   `server.ts::getDb()` is NOT acceptable here: `pg.Client` transaction
   state is per-**connection**, not per-call, so two concurrent inbound
   handlers sharing one connection would interleave their
   `BEGIN`/`COMMIT` and violate atomicity. Each call owns its
   connection for its lifetime; concurrent inbound calls cannot
   interleave. The lower-level export
   `persistInboundDeliveryOnClient(client, params)` exists for tests
   only — production code must not pass the singleton to it.
4. **Retry idempotency.** The existing partial unique index
   `uq_mq_agent_message` (`agent_id`, `message_id`) WHERE `message_id
   IS NOT NULL` means `ON CONFLICT DO NOTHING` suppresses the second
   `message_queue` INSERT. `persistInboundDelivery()` surfaces this as
   `duplicateDedup: true`, which `handleInboundMessage` logs at the
   inbound level (unchanged stderr wording: `message_queue dedup —
   duplicate …`). The `metadata.to` `UPDATE` is already idempotent
   because `||` is monoidal for the same key/value.
5. **pg_notify ordering (7c).** The receiver-pipeline `pg_notify
   ('agent_inbox', …)` fanout runs **after** the 7b+7d commit and is
   **skipped** when the transaction rolled back. Subscribers therefore
   never wake up on a delivery that was never persisted, and never read
   `metadata.to = NULL` during the race window between `INSERT` and
   `UPDATE`.
6. **agent_messages row unaffected on rollback.** Step 2's save of the
   raw `agent_messages` row runs before routing and is not in the 7b+7d
   transaction. A failed 7b+7d therefore leaves `agent_messages` with
   the message but no `metadata.to` and no `message_queue` row — i.e.
   the receiver sees nothing in its inbox, which is the correct
   "delivery failed" observation.

`mqPayloadJson` is stored into `message_queue.payload`, a `text`
column (`db/migrate.ts` — NOT `jsonb`). The JSON encoding is the
caller's responsibility (`handleInboundMessage` builds it via
`JSON.stringify`).

**Scope boundary.** Steps 1–6 (channel resolve, `agent_messages` save,
routing decision) and Step 7c (post-commit `pg_notify`) are deliberately
outside the transaction. `persistInboundDelivery()` covers only 7b+7d
because they share the inbox-visibility invariant; widening the
transaction would couple routing to DB transaction lifetime for no
semantic win.

### 7.4 Outbound処理

> **S2-A (PR #164) + Phase C Step 1 PR-A (PR #168) + FEAT-005 adapter rewrite (PR #172) で挙動更新済**。以下の例示コードは初版方式（batch SELECT）。実装は atomic claim (UPDATE...FOR UPDATE SKIP LOCKED) + exponential backoff + nonce idempotency へ進化した。PR #172 で claim state を `'processing'` → `'claimed'` に rename (work-queue 標準語彙) + consumer / PollingDriver / inbound receiver を `adapters/*.ts` に抽出し、daemon entrypoint (`entrypoints/daemon.ts`) を consumer の唯一の起動点とした。例示コードの後ろに現行の挙動仕様を明記する。
>
> **2026-04-14 phasing 注記 (CEO directive Task 1, PR #172 post-merge hotfix, auditor cycle 2 startup-order fix)**: production 起動経路 (`claude server:agent-comms`) が `entrypoints/daemon.ts` を経由しないため、PR #172 直後に outbound_queue が drain されない不具合が発生 (pending 8 行滞留)。応急処置として server.ts の `postConnect()` 内で `discordClients.set(AGENT_ID, discord)` の直後に `isDaemonRuntime()` 条件下で `startOutboundConsumer()` を呼ぶ。`registerAgent()` 末尾に置く実装 (cycle 1) は `discord.connect()` resolve 前に tick が発火し `no_discord_client_for_agent` で全行 failed になったため却下。current production topology (1 agent = 1 process) では 19-bot race は想定しない。entrypoints/daemon.ts に supervise wrapper が完成した時点で server.ts 側を再剥離する（daemon-only invariant 復元）。

#### 現行の挙動仕様 (実装との SSOT)

##### 実効 dedup = 2 層 (nonce + 40062 idempotent 収束)

Cycle 3 honesty: `discord_message_id` は観測性カラムであり dedup layer ではない (§3.3 表 参照)。consumer が重複 post を避ける保証は以下の 2 層で成立する:

- **Layer 1 — Platform-level nonce**: `sendAdapterMessage` に `nonce = "out-<row.id>"` を渡し、Discord `enforceNonce: true` で ~5 分 window の重複送信を Discord API 側で拒否
- **Layer 2 — 40062 idempotent 収束**: Discord が error code `40062` ("Cannot send a message using that nonce") を返した場合、consumer は **idempotent success として `status='sent'` に flip する** (discord_message_id は Discord 未返却のため NULL)。「HTTP 応答喪失 + nonce window 内 retry」シーケンスの確定収束路

##### その他の処理ステップ

1. **Atomic claim (§3.3)**: 1 tick (1 秒) につき 1 行、`agent_id = AGENT_ID` 条件で `status='pending' → 'claimed'`、`attempts += 1`、`claimed_at = now()` を `FOR UPDATE SKIP LOCKED` で取得。別 consumer の二重取得は構造的に不可 (PR #172 FEAT-005 CP-3 で vocabulary `'processing'` → `'claimed'` に rename)
2. **Row-level short-circuit (限定保険)**: claim した行の `discord_message_id` が既に非 null なら `sendAdapterMessage` を呼ばず直接 `status='sent'` へ flip。通常 path では `status='sent'` と同時 UPDATE で永続化するため pending filter がこの行を拾わず到達不能だが、mark-sent 完了後に行が何らかの理由 (手動 UPDATE / ツール直叩き等) で再度 pending に戻された場合の safeguard として残す
3. **Success path**: 送信成功時は `status='sent'` + `sent_at=now()` + `discord_message_id=<返却された snowflake>` を 1 つの UPDATE で atomic に永続化。この atomicity が上記 Layer 1/2 dedup の前提
4. **Transient failure → exponential backoff (§3.4)**: network/timeout/5xx/429 等は `status='pending'` に戻し、`next_retry_at = now() + min(30s, 2^(attempt-1) s) + jitter`
5. **Permanent failure**: 非 transient or `attempts >= max_attempts` なら `status='failed' + last_error=<err>`
6. **Orphan reclaim (§3.5)**: `OUTBOUND_ORPHAN_TIMEOUT_SEC` (default 600 秒 = Discord nonce dedup 5 分 + buffer 5 分) を超えた `claimed` 行は `pending` へ戻し、claim した consumer がクラッシュした場合のロック滞留を防ぐ

#### 例示コード（初版方式、historical reference）

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

Phase C: 全bot切替完了 + daemon 分離
  → 旧 daemon / channel-server コード削除
  → --dangerously-load-development-channels 除去（全 bot）
  → per-bot Discord client を presence client に置換
  → restart-bot.sh に agent-com daemon standalone モード追加
  → 完了条件:
    ・全 bot で plugin:discord が /mcp に表示されない
    ・全 bot で agent-com daemon が heartbeat 送信中
    ・受信が next_message 一本（channel plugin 経由ゼロ）
    ・access.json 依存ゼロ
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
| `AGENT_COM_DAEMON_MODE` | `standalone` | `embedded`: MCP 内蔵 / `standalone`: daemon 別プロセス（§6.5 参照） |
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
| 8 | 移行: Phase C（旧コード削除 + channel plugin 除去 + daemon standalone モード + presence client） | Phase 7 |
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
| 2026-04-16 | v1.0.3 (gdrive sync, Task A): §6.5 PollingDriver embedded/standalone デュアルモード化（standalone 推奨）、§6.6 確定済み技術制約追加（MCP notification NG + idle wake NG + lazy spawn、Issue #178/#183 reference）、§16 Phase C に daemon 分離・4 完了条件追加、§21 Phase 8 拡張、§20 `AGENT_COM_DAEMON_MODE` 追加 |
| 2026-04-12 | v1.0.3: §3.2 に `uq_mq_agent_message` 部分 UNIQUE index 追加 + INSERT の正式形式を `ON CONFLICT DO NOTHING` と規定（ADR-048 Phase 0 D4、PR#142 / 対応実装 PR#140） |
| 2026-04-12 | v1.0.2: §6.1-6.5 全CLIをMCP内蔵polling driverに統一、§14.5 スケーラビリティ追加、§4.3/4.5/13.3/18.2/18.3 cron依存を全廃止（全てMCP server/receiver内蔵に統一） |
| 2026-04-10 | v1.0.0: 統合メッセージキュー仕様（旧receiver-architecture + channel-thread-control統合、全22セクション） |
