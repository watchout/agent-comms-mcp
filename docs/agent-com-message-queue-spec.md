# agent-com 統合メッセージキュー仕様 v2.1.0

> 旧仕様（receiver-architecture, channel-thread-control-spec, webhook-architecture）を統合・置き換え
> attachment-spec, chat-ui-sync-spec は独立文書として維持
> 全LLMツール対応（LLM-agnostic）

---

## 1. 設計原則

```
1. **OSS primary**: SQLite default + 1 コマンドで動く製品が primary shape。PostgreSQL / multi-bot は拡張。外部設定ファイル (access.json 等) への依存ゼロ
2. **1 daemon**: inbound receiver + outbound consumer + heartbeat monitor を 1 プロセスに集約。MCP server (per-bot) は stateless ラッパー
3. **DB が唯一の通信路**: daemon ↔ MCP server 間は DB のみ。IPC / HTTP / WebSocket なし
4. **LLM-agnostic**: spec に特定 LLM / MCP 実装の名前を書かない。CLI コマンドが interface
5. **routing は deterministic**: routeInbound() は純粋関数。LLM 判断ゼロ。配信先は channels.members で決定
6. **polling 統一**: 新着通知は polling (3s default)。PostgreSQL 接続時は pg_notify で加速 (opt-in)
7. **PostgreSQL でも SQLite でも同じ CLI コマンドが動く**
8. **Reply Chain Context**: next_message は reply_to chain を辿り、会話の文脈のみを返す。チャンネル履歴の一括付与はしない
```

---

## 2. 全体アーキテクチャ

プロセス構成:

```
npx agent-comms-mcp
  └─ 1 daemon プロセス:
     ├─ Discord Gateway (N bot token)
     ├─ inbound receiver
     │    ├─ adapter.onMessage() → discordToUnified()
     │    ├─ routeInbound(unified, channel, agents) → pushTargets[]
     │    ├─ agent_messages INSERT
     │    ├─ message_queue INSERT (pushTargets 分)
     │    └─ polling signal (pg_notify opt-in)
     ├─ outbound consumer
     │    ├─ outbound_queue atomic claim
     │    ├─ adapter.sendMessage() → Discord REST API
     │    └─ nonce dedup + backoff + orphan reclaim
     ├─ heartbeat monitor
     │    ├─ 全 agent の heartbeat_at を READ ONLY 監視 (30s)
     │    └─ timeout → agents.status = 'disconnected'
     └─ MCP tools (stdio)
          ├─ next (message_queue + reply chain context)
          ├─ send (outbound_queue INSERT)
          └─ agents / status / heartbeat / history / inbox
```

データフロー:

```
Discord → daemon (inbound) → agent_messages + message_queue
                                     │
                                     ▼
LLM CLI → MCP server (next) ← message_queue (polling)
LLM CLI → MCP server (send) → outbound_queue
                                     │
                                     ▼
Discord ← daemon (outbound) ← outbound_queue (claim)
```


---

## 3. DBスキーマ

> **DDL 記法**: 本節の DDL は PostgreSQL 記法で記述。SQLite への変換 (BIGSERIAL → INTEGER PRIMARY KEY AUTOINCREMENT, TIMESTAMPTZ → TEXT, NOW() → datetime('now'), FOR UPDATE SKIP LOCKED → IMMEDIATE transaction) は DbAdapter (§13.2) の責務。
> **Target state**: §3.1 metadata / §3.4 cli_type 等は target state。現行 db/migrate.ts との差分は Phase C 実装で migration として順次解消する。

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
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
    CHECK (status IN ('pending', 'read', 'replied', 'skipped', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0, -- 高い値 = 高優先
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  replied_with TEXT,                   -- 返信メッセージのID
  failed_reason TEXT                   -- v2.1.0: fail CLI で設定 (LOOP_DETECTED, LLM_FAILED 等)
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
  discord_message_id TEXT              -- Phase C Step 1 PR-A (PR #168): 送信成功時 Discord snowflake を観測性カラムとして永続化 (dedup layer ではない — 詳細は §6.4)
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

**Migration/test vocabulary note (#585, 2026-05-29)**:
`outbound_queue.status='claimed'` is the canonical claim state for both
PostgreSQL and SQLite. Postgres `db/migrate.ts` still contains a transitional
pre-CP-3 block that temporarily accepts legacy `'processing'` and
already-canonical `'claimed'` rows so old rows can be renamed in the
immediately following CP-3 transaction and reruns remain idempotent; that
temporary broader CHECK is not target state. `db/rollback-claim-vocabulary.sql`
is the only supported path that
reintroduces `'processing'`, and only for explicit down migration. Contract
tests must assert the final post-migration CHECK vocabulary
(`pending`, `claimed`, `sent`, `failed`) and must not require live DBs to carry
`processing` rows.

**カラム詳細** (drift 解消、実装と同期、本 §3.3 が SSOT):

| カラム | 導入 PR | 役割 |
|---|---|---|
| `status='claimed'` | PR #164 (S2-A) / PR #172 (FEAT-005 CP-3) | atomic claim で `UPDATE status='pending'→'claimed'` する瞬間的状態。`FOR UPDATE SKIP LOCKED` と組み合わせて別 consumer の二重取得を防ぐ。vocabulary was `'processing'` in PR #164; renamed to `'claimed'` in PR #172 to match work-queue convention and the claim SQL verb |
| `claimed_at` | PR #164 (S2-A) | consumer が claim した瞬間の wall-clock。orphan 再回収の閾値判定 (`OUTBOUND_ORPHAN_TIMEOUT_SEC`) |
| `next_retry_at` | PR #164 (S2-A) | transient failure 後の再試行最早時刻。`min(30s, 2^(attempt-1)) + jitter` の exponential backoff |
| `discord_message_id` | PR #168 (Phase C Step 1 PR-A) | 送信成功時 Discord snowflake を永続化する **観測性カラム**。dedup layer ではない — `status='sent'` と同じ UPDATE で atomic に書くため、通常 pending filter は discord_message_id 非 null の行を拾わない構造的保証があり、consumer 内の short-circuit 分岐は mark-sent 完了後に行が何らかの理由で再度 pending に戻る極稀なエッジケースに対する**限定的保険**として動作するに留まる。実効 dedup は §6.4 の 2 層 (platform nonce + 40062 idempotent 収束)|

### 3.4 agents（既存テーブル改修）

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('human', 'dev', 'org')),
  cli_type TEXT,  -- 例: claude_code, codex, gemini, cursor 等 (CHECK 制約なし、自由文字列)
  discord_token TEXT,                  -- 送信用（暗号化検討: §12）
  discord_user_id TEXT,                -- Discord上のuser ID
  status TEXT NOT NULL DEFAULT 'offline'
    CHECK (status IN ('idle', 'busy', 'disconnected', 'offline')),
  status_detail TEXT,                  -- "PRレビュー中" 等
  status_updated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  heartbeat_interval INTEGER DEFAULT 30, -- 秒
  observer_mode BOOLEAN NOT NULL DEFAULT FALSE,
  current_message_id TEXT,              -- next で pop した message_queue.id (send 時に参照)
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
  "reply_chain": [
    { "id": "msg-A", "from": "agent-com-dev", "parent_id": null, "depth": 2, "preview": "テスト開始します", "created_at": "2026-04-08T10:00:00Z" },
    { "id": "msg-B", "from": "ceo", "parent_id": "msg-A", "depth": 1, "preview": "テスト結果を報告して", "created_at": "2026-04-08T10:01:00Z" },
    { "id": "msg-C", "from": "ceo", "parent_id": "msg-B", "depth": 0, "preview": "テスト結果ど���", "created_at": "2026-04-08T10:02:00Z" }
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
1. 直前のcurrentMessageがあれば agent-com fail --reason IMPLICIT_ABANDON で明示 failed 遷移（status='failed'、v2.1.0 で暗黙 skip 廃止）
2. message_queueからpending最古の1件取得（priority/channel考慮）
3. status='received', read_at=NOW() に更新
4. agents.status='busy', status_detail='メッセージ処理中' に更新
5. currentMessageIdをプロセス内メモリに保持
6. ペイロードをJSON出力
```

### 4.2 agent-com send

受信メッセージへの返信。`next` → `send` パターンが唯一の経路。`agents.current_message_id` が `next` で pop 済の `message_queue.id` を指す。

- CLI: `--reply-to` は省略可。省略時は `current_message_id` が指す行の `message_id` を内部解決
- MCP: `reply_to` は tool schema で required（caller 指定）
- `message_queue` 遷移: `UPDATE ... SET status='replied' WHERE agent_id AND id = current_message_id`

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
1. 経路判定:
   - `current_message_id` set → primary path
   - `current_message_id = NULL` → `NO_CURRENT_MESSAGE` エラー
2. mentions検証:
   a. 空配列 → NOT_MENTIONEDエラー（元送信者を提案）
   b. 存在しないagent_id → INVALID_MENTION_FORMATエラー（有効一覧表示）
   c. DB不達 → MENTION_VALIDATION_UNAVAILABLEエラー
3. 権限チェック: channels.membersに送信者が含まれるか
4. reply_to 確定（`agent_messages.id` UUID 前提）:
   - `--reply-to` 省略時: `agents.current_message_id` が指す `message_queue` 行の `message_id` を内部解決して default に採用
   - `--reply-to` 明示時: caller 指定の `reply_to` をそのまま使用
5. 宛先解決（`resolveSendDestination(reply_to)`）:
   - `reply_to` の UUID から `agent_messages` を引き、`channel_id` / `thread_id` を導出
   - `reply_to` が `agent_messages` に存在しない → `MESSAGE_NOT_FOUND` エラー
6. agent_messages INSERT
7. push対象のmessage_queue INSERT（mentions対象分）
   → 対象botのstatusに応じて senderにフィードバック（§8）
8. outbound_queue INSERT（Discord送信用）
9. message_queue 状態遷移:
   - send 成功: `status='replied'`, `replied_with=message_id`
   - agent-com fail: `status='failed'`, `failed_reason=reason` (retry 上限 / loop 検出 / LLM 失敗時)
   - agent-com skip: `status='skipped'`, `failed_reason=reason` (手動運用のみ)
10. current_message_id = null (send / fail / skip いずれでもクリア)
11. agents.status='idle', status_detail=NULL に更新
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

生存報告。daemon 内の setInterval で自動実行（§5.3）。CLIコマンドとしても手動実行可能。

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

#### 4.8.1 inbox cursor semantics

`fetchNewMessages` (server.ts / `core/inbox-cursor.ts`) は per-process の **composite cursor `(created_at, id)`** を保持する。SQL predicate:

```sql
-- 次回呼出で既読分を除外する条件
AND (created_at > $cursor_created_at::timestamptz
     OR (created_at = $cursor_created_at::timestamptz AND id > $cursor_id::uuid))
ORDER BY created_at ASC, id ASC
```

**不変条件**:

1. `created_at` を主キー (µs 粒度) に、`id` を同 µs 内行の tiebreaker として用いる。UUID v4 は時系列順でないため単独 cursor としては使わない。cursor は `created_at_text` companion column 経由で µs 精度を保持する (JS `Date` は ms 粒度に丸めるため)
2. cursor 進める条件は rows.length > 0 のみ。empty 結果では cursor を保持 (再試行で取りこぼさない)
3. **cursor は DB persisted** (`agents.inbox_cursor_at TIMESTAMPTZ` + `agents.inbox_cursor_id UUID`、Issue #287 / PR-0 #291)。in-memory コピーは process cache 扱いで、`fetchNewMessages` 初回呼出で DB から復元、advance 毎に `UPDATE agents SET inbox_cursor_at=$1, inbox_cursor_id=$2 WHERE agent_id=$3` で write-back。restart 直後でも前 session の最終 cursor から再開し、stale pending を再配信しない (Stage B 4 cycle で再発した restart→stale-redelivery 問題の真因対処)
4. 行の `metadata->>'to' = $agent_id` filter は cursor と独立。route 判定は handleInboundMessage Step 7b で確定済

**SQL 形式の注意**: 行値比較 `(created_at, id) > ROW($3, $4)` は node-postgres で型推論エラーを誘発するため **expanded form** で書く (`created_at > $3 OR (created_at = $3 AND id > $4)`)。同値。

---

## 5. LLM Integration

### 5.1 汎用パターン

agent-com は CLI コマンドを提供。任意の LLM ツールが MCP / shell exec でラップ。

| LLM ツール | 接続方式 | 設定 |
|-----------|---------|------|
| Claude Code | MCP server (stdio) | .mcp.json |
| Codex CLI | MCP server (stdio) | codex --mcp |
| Gemini CLI | shell exec | gemini --tool |
| 任意 CLI | shell exec or MCP | CLI 直接呼出 |

### 5.2 MCP server 設定例

```json
{ "mcpServers": { "agent-comms": { "command": "npx", "args": ["agent-comms-mcp", "--agent-id", "my-bot"] } } }
```

MCP server は stateless。daemon 未起動なら自動 background start。

### 5.3 統一プロセスモデル (Phase C I5)

全プロセスが単一フローで起動する。`TRANSPORT_MODE` 環境変数は廃止。

- 1 プロセス = receiver + outbound + heartbeat + Discord Gateway + stdio MCP
- multi-bot SSE HTTP server は `EXPECTED_BOTS` or `AGENT_COMMS_PORT` 設定時のみ起動
- DB のみで通信、IPC なし

起動シーケンス:
1. DB 接続 → migration auto
2. multi-bot SSE HTTP server (条件付き: EXPECTED_BOTS or AGENT_COMMS_PORT)
3. polling + pg_notify listener 開始
4. per-bot Discord clients (EXPECTED_BOTS 分、outbound-only)
5. 共有 Discord adapter 接続 (inbound + outbound) → outbound consumer 開始
6. stdio MCP transport 接続 → agent 登録

heartbeat:
- run-bot.sh: background process で 30s ごとに agent-com heartbeat (§5.3 heartbeat 参照)
- MCP session (legacy): 自 agent_id の heartbeat_at を UPDATE (30s)
- daemon: heartbeat_at を READ ONLY 監視、timeout 時のみ status UPDATE

### bot 起動方式 (run-bot.sh, LLM-agnostic event-driven)

```bash
# scripts/run-bot.sh — LLM-agnostic event-driven bot runner
# Usage: LLM_CMD="claude --print" ./scripts/run-bot.sh <agent-id>
./scripts/run-bot.sh <agent-id>
```

- daemon (inbound / outbound) と bot runner (LLM 処理) は独立プロセス
- daemon が message_queue INSERT → state-daemon (`bin/state-daemon.ts`) が polling 検出 → tmux send-keys で対象 bot の LLM session に prompt 注入 → bot が `next` を能動呼出
- LLM は bot runner から呼ばれる (MCP session 常駐不要、§13.5.1 primary 経路)
- state-daemon (ADR-050、2026-05-05) は de jure primary。bot 側 LLM (Claude Code / Codex / Gemini) が tmux session で prompt を受領、`next` tool を呼ぶ
- state-daemon 不達 / bot 不通時は polling fallback (bot LLM が定期的に `next` を呼ぶ judgement) で最終的にメッセージ取得

#### end-to-end flow

```
1. run-bot.sh 起動
   → PID file 作成 → SIGUSR1 trap → EXIT trap (PID file 削除)

2. メッセージ待機
   → SIGUSR1 待ち (timeout default 30s、polling fallback)

3. メッセージ取得
   → agent-com next --agent-id $AGENT_ID
   → waiting = 0 → 2 に戻る
   → waiting > 0 → message JSON (content, reply_chain, from, message_id)

4. LLM 呼出 (交換可能)
   → echo "$content" | $LLM_CMD
   → 環境変数 LLM_CMD で指定 (default: claude --print)
   → claude --print / codex --quiet / gemini --prompt / 任意 CLI

5. 返信送信
   → agent-com send --reply-to $message_id --mentions $from --content "$response"
   → outbound_queue → outbound consumer → Chat UI (Discord / Telegram / Slack)

6. loop (2 に戻る)
```

#### エラーハンドリング

- next 失敗: `{"waiting":0}` として扱い、loop 継続
- LLM 失敗: `agent-com fail --message-id X --reason LLM_FAILED` で status='failed' に明示遷移。暗黙 skip は使わない
- send 失敗: retry (max 3, exponential backoff 2/4/8s)。上限到達 → `agent-com fail`。retry 時は前回エラーを LLM prompt に追加
- signal 不達: polling fallback (30s) で回復
- LLM 出力超過: CLI send 内で 1900 文字に truncate (JavaScript `String.slice`、multibyte safe)
- bot-to-bot loop: reply_chain 内に自 agent_id が 3 回以上 → `agent-com fail --reason LOOP_DETECTED`

#### CLI 追加 (v2.1.0)

- `agent-com fail --message-id X --reason Y` → status='failed', failed_reason 設定, current_message_id=NULL, status='idle'
- `agent-com skip --message-id X --reason Y` → status='skipped' (手動運用のみ)
- `agent-com register --agent-id X --token $TOKEN --channels ch1,ch2` → agents INSERT + channels.members 追加
- `agent-com reclaim --agent-id X` → 手動 orphan reclaim (received→pending + current_message_id=NULL)

#### DB schema 追加 (v2.1.0)

```sql
ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT;
-- status CHECK: ('pending', 'read', 'replied', 'skipped', 'failed')
```

#### signal coalescing (burst 対応)

1 signal で複数 message を処理。drain loop で `waiting=0` まで回す:

```
while true; do
  SHUTDOWN check (BEFORE consume)
  msg = next
  waiting = 0 → break
  process_message(msg)
done
sleep (signal で即中断)
```

#### graceful shutdown

SIGTERM/SIGINT で SHUTDOWN flag → drain loop の次 iteration で break。現在処理中の message は send 完了まで待つ。LLM は `timeout` コマンドで制限 (default 120s)。

#### orphan reclaim

**self-reclaim (Issue #287 / PR-0 #291)**: 各 bot の server.ts 起動時、**(a) `await reclaimSelfOrphanedClaims(...)` で同期 startup reclaim を完了させてから** (b) 60s 間隔の periodic sweeper、(c) claim-ttl sweeper の順で起動する (`AGENT_COMMS_SELF_RECLAIM_INTERVAL_MS` で上書き可、kill switch `AGENT_COMMS_TTL_SWEEP_DISABLED=1`)。(a)/(b) とも自分の `claimed_by = $self AND status='received'` 行のみ対象、(a) は `claim_expires_at IS NULL OR claim_expires_at < now()` (TTL 内の active claim は yank 禁止 — 二重起動 / 遅延起動が legitimate worker から msg を奪うのを防ぐ)、(b) は `claim_expires_at IS NOT NULL AND claim_expires_at < now()` (TTL 経過必須)。`status='received' → 'pending'` 遷移直後に `agents.status` を `CASE WHEN EXISTS(...) THEN 'busy' ELSE 'idle' END` で派生 update する (sender-feedback の busy/idle 分岐を狂わせない、Issue #287 cycle 7 axis 2/3 BLOCK fix)。cursor も DB persist (§4.8.1) で復元されるため再配信が正しく届く。`agents.current_message_id` は Issue #278 (A) segment 3d で削除済 (per-row claim model に移行)。

`core/claim-ttl.ts` の `sweepExpiredClaims` (5min 間隔、`status='received' AND claim_expires_at < now()` を pending に戻す) は **`selfAgentId` predicate で own 行を構造的に除外** する (Issue #287 cycle 7 axis 1)。startup 順序入替 + own 行除外の二重 guard により、sweeper の `setTimeout(fire, 0)` が self-reclaim より早く発火しても own claim が処理中 worker から奪われることはない。

**sweeper も fail-closed** (PR-0 cycle 14 axis 2/3/4/5/6 BLOCK fix): periodic self-reclaim sweeper + claim-TTL sweeper 双方の `fire()` ループで例外を non-fatal log だけして継続する pattern を廃止。production path は `process.exit(1)` で run-bot.sh / launchd / systemd 経由 restart に委譲、test path は `onError` callback inject で観測。silent skip による "stuck received" / "stale busy-idle" 回帰を構造排除。

#### heartbeat (run-bot.sh 責務)

background process で 30 秒ごとに `agent-com heartbeat` を送信。LLM 処理中も heartbeat 継続。daemon から disconnected と誤判定されない。

#### consumer 排他制御 (1 agent = 1 consumer)

PID file で排他チェック。既にプロセス生存 → exit 1 (block)。MCP session 側も同様に block。

#### process supervision

auto-restart (bash while loop)。crash 5 回 / 60 秒 → 停止。exit code 0 = normal shutdown, 1 = fatal (retry なし), other = transient (retry)。

#### LLM プロンプトテンプレート

```
CORE_RULES (強制): mention 必須, 1900 文字以下, AI disclaimer 禁止
USER_RULES (任意): AGENT_COM_SYSTEM_PROMPT 環境変数でカスタマイズ
```

core rules は常に先頭に付与。user がカスタマイズしても mention / 文字数ルールが消えない。

#### AGENT_ID validation

`[a-z0-9][a-z0-9_-]*` (1-64 文字)。run-bot.sh 起動時 + register CLI で検証。

#### subcommand 化

```bash
npx agent-comms-mcp run-bot --agent-id X --llm "claude --print"
npx agent-comms-mcp register --agent-id X --token $TOKEN
```

npm publish で scripts/ は含まれない。entrypoints/main.ts の subcommand として実装。

#### マルチチャット UI

bot runner は chat UI に依存しない:

```
Chat UI → adapter → daemon (inbound) → message_queue
                                              ↓
                                        state-daemon (polling → tmux send-keys)
                                              ↓
                                        bot LLM session (next → LLM → send)
                                              ↓
                                        outbound_queue → adapter → Chat UI
```

新しい chat UI (Telegram / Slack / Web) を追加しても bot runner は変更不要。adapter 層が吸収する。

#### migration 計画 (Claude Code session → run-bot.sh)

1. agent-com-dev のみ移行 (テスト済み)
2. 低稼働 bot 順次移行
3. 全 bot 移行
4. MCP session model deprecated

切替手順: tmux kill → 15 分待機 (orphan reclaim) → run-bot.sh 起動。即時切替は `agent-com reclaim` CLI 使用。

---

## 6. Receiver

### 6.1 責務

```
1. Discord Gateway接続（1 Client、専用receiver bot token）
2. messageCreate → discordToUnified() → routeInbound()
3. agent_messages INSERT（このプロセスだけが実行 → 競合なし）
4. message_queue INSERT（push対象分）
5. outbound_queue消費 → Discord REST API送信
6. heartbeat監視 → disconnected判定
7. 起動時: 全bot tokenからdiscord_id一括登録
```

### 6.2 起動時のdiscord_id一括登録

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

### 6.3 Inbound処理

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
    await db.insertQueue(agentId, unified.id, payload); // Reply Chain Context (§18.1) は next 取得時に付与
    // state-daemon (ADR-050、§13.5.1 primary) が message_queue INSERT を polling 検出し
    // tmux send-keys で対象 bot を wake する。inbound handler 自身は signal しない。
    // 送信者へのフィードバック（§8）
    await notifySenderOfDeliveryStatus(unified.author_id, agentId, unified.id);
  }
});
```

#### 6.3.1 Inbound handler transactional semantics

**Atomic commit boundary (7b + 7d):**

- Step **7b** — `UPDATE agent_messages SET metadata = metadata || jsonb_build_object('to', $receiverAgentId) WHERE id = $messageId`
- Step **7d** — `INSERT INTO message_queue (agent_id, message_id, payload) VALUES (...) ON CONFLICT (agent_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id`

Both queries run on a **transaction-private** `pg.Client` inside one `BEGIN`/`COMMIT`. Implementation: `core/inbound-delivery.ts` `persistInboundDelivery(databaseUrl, params)`. Invariants:

1. **Both-or-neither**: 7b UPDATE + 7d INSERT は同一トランザクション。どちらかが失敗すれば ROLLBACK。partial `metadata.to` / `message_queue` state は外部から観測不能。
2. **No silent swallow.** Failures return `{committed: false, error}` to the caller.
3. **Transaction-private connection.** 各呼び出しが専用 `pg.Client` を使用。concurrent inbound handlers の interleave を防止。
4. **Retry idempotency.** `uq_mq_agent_message` partial UNIQUE index + `ON CONFLICT DO NOTHING` で重複 INSERT を抑制。`metadata.to` UPDATE は冪等。
5. **pg_notify ordering (7c).** `pg_notify` は 7b+7d commit 後にのみ発火。rollback 時は skip。
6. **rollback 時 metadata.to 不可視.** `agent_messages` の raw row は 7b+7d トランザクション外で保存済み。7b+7d 失敗時は `metadata.to` なし + `message_queue` 行なし = inbox に表示されない (正しい "delivery failed" 状態)。

実装経緯: GitHub Issue #177 参照

### 6.4 Outbound処理

> **S2-A (PR #164) + Phase C Step 1 PR-A (PR #168) + FEAT-005 adapter rewrite (PR #172) で挙動更新済**。以下の例示コードは初版方式（batch SELECT）。実装は atomic claim (UPDATE...FOR UPDATE SKIP LOCKED) + exponential backoff + nonce idempotency へ進化した。PR #172 で claim state を `'processing'` → `'claimed'` に rename (work-queue 標準語彙) + consumer / PollingDriver / inbound receiver を `adapters/*.ts` に抽出し、daemon entrypoint (`entrypoints/daemon.ts`) を consumer の唯一の起動点とした。例示コードの後ろに現行の挙動仕様を明記する。
>

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

### 6.5 Heartbeat監視

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

### 6.6 キャッシュ

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

### 6.7 Receiver Token

```
- 1 bot (OSS): 自 bot token で inbound + outbound を兼用。専用 receiver bot 不要
- multi-bot: 専用 receiver bot token 推奨 (C5 対策: 自送信ループ防止)
AGENT_COM_RECEIVER_TOKEN は multi-bot 構成でのみ設定。未設定時は DISCORD_TOKEN を使用。

Guild内の全チャンネルにアクセス可能な権限を付与。
Privileged Intents: MESSAGE CONTENT INTENT を有効化。
```

---

## 7. routeInbound（純粋関数）

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

## 8. Bot状態管理とフィードバック

### 8.1 状態遷移

```
offline → idle:          heartbeat受信時
idle → busy:             next実行時
busy → idle:             send / fail / skip CLI 実行時
busy → idle:             orphan reclaim (self-reclaim 60s periodic / claim-ttl 5min sweep、Issue #287 PR-0 #291 で 15min daemon polling から差替え)
idle/busy → disconnected: heartbeat 90秒途絶
disconnected → idle:      heartbeat再開時
```

暗黙 skip は v2.1.0 で廃止。busy → idle は必ず send / fail / skip / reclaim のいずれかを経由する。

### 8.2 送信者フィードバック

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

### 8.3 busy解除時の対応開始通知

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

## 9. メンション制御

### 9.1 botはagent_id形式のみ使用

```
"cto", "arc", "hotel-dev" 等。
Discord形式（<@1234567890>）は使わない。
変換はCLI内部で自動実行。
```

### 9.2 sendコマンド内のmentions検証

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

### 9.3 メンション変換（CLI内部、自動）

```
Outbound: agent_id → Discord形式
  "cto" → "<@1487367645933211699>"
  agent_adaptersテーブルで変換

Inbound: Discord形式 → agent_id
  "<@1487367645933211699>" → "cto"
  agent_adaptersテーブルで逆引き
```

### 9.4 access.json 廃止後の permission model

```
Phase C 完了条件「access.json 依存ゼロ」の実体:
- Routing 層: routeInbound() が channels.members で配信先を決定 (既存 DB ベース)
- Filtering 層: bot 側の system prompt / configuration で自己責任判定 (LLM-agnostic)
- DB に access_control テーブルは作らない
```

---

## 10. メッセージパターン

### 10.1 パターン一覧

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

### 10.2 引用テキスト付与

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

## 11. エラーコード一覧

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

v2.1.0 failed_reason 標準値 (message_queue.failed_reason に設定):
IMPLICIT_ABANDON              next 実行時に前の message が未返信
LLM_FAILED                    LLM CLI が空応答 or exit non-zero
SEND_FAILED_AFTER_N_RETRIES   send が retry 上限到達 (N=MAX_RETRIES)
LOOP_DETECTED                 reply_chain 内に自 agent_id が MAX_SELF_IN_CHAIN 回以上
OBSOLETE                      管理者による手動 skip
```

---

## 12. セキュリティ

### 12.1 通信経路

```
全通信がDB経由。HTTPポートはreceiverのhealthcheck（127.0.0.1:9000）のみ。
HMAC署名不要（HTTP POST配信を廃止したため）。
```

### 12.2 Discord Token管理

```
現状: agents.discord_token にプレーンテキスト保存
v2.0.0: 環境変数 (DISCORD_TOKEN / DISCORD_TOKEN_{AGENT_ID}) が正。DB 保存は legacy、新規セットアップでは使用しない
  → DBにtokenを保存しない
  → receiverが起動時に環境変数から読み込み
  → SQLiteファイル流出時のtoken漏洩を防止
```

### 12.3 bash curl直叩き検出

```
agent_messagesに記録がないDiscord投稿を定期検出（receiver内蔵setInterval）:
  → receiver起動時 + 1時間ごと（receiver内のsetIntervalで自動実行）
  → Discord REST GET /channels/{id}/messages?after=...
  → agent_messages に対応するdiscord_message_idがない投稿 = bypass
  → audit_log記録 + CEO通知
  → cron不要。receiverプロセスが生きている限り自動実行
```

### 12.4 .env保護

```bash
chmod 600 .env
# Claude Code settings.json denyList
```

---

## 13. PostgreSQL / SQLite 対応

### 13.1 state-daemon (primary delivery mechanism)

ADR-050 (2026-05-05、CTO ratify + CEO acceptance) により、メッセージ配信の primary は **state-daemon** (`bin/state-daemon.ts`) に統一される。DB vendor 固有の signal 機構 (pg_notify / LISTEN、SQLite polling、in-process SIGUSR1 等) は使わない。

- state-daemon は外部プロセスとして常駐し、`message_queue` を polling
- 新規 row 検出時、対象 bot の tmux session に `tmux send-keys` で prompt を注入
- bot 側 (Claude Code / Codex / Gemini など LLM agent) は prompt を受領して `next` tool を能動呼出
- LLM agent 環境向け、PG / SQLite いずれの backend でも同一動作 (DB 機能に非依存)

```
[inbound handler]
       │
       ▼ INSERT INTO message_queue (...)
  ┌──────────────────┐
  │  message_queue   │
  └──────────────────┘
       ▲ polling (poll interval: §13.5)
       │
[state-daemon]
       │
       ▼ tmux send-keys "<wake prompt>"
  ┌──────────────────────────────┐
  │  bot LLM session (tmux)      │
  │  → next tool 呼出 → LLM → send│
  └──────────────────────────────┘
```

旧 in-process signal bus 抽象 (PID file + SIGUSR1 ベースの signaling API) は ADR-050 で削除。互換 API は提供しない (本仕様は OSS 公開前のため、外部互換は対象外)。

### 13.2 DbAdapter抽象化

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

### 13.3 設定

```env
AGENT_COM_DB=postgres    # pg_notify（リアルタイム）
AGENT_COM_DB=sqlite      # polling（1-2秒遅延）

DATABASE_URL=postgres://user:pass@localhost:5432/agent_com
AGENT_COM_SQLITE_PATH=./data/agent-com.db

AGENT_COM_POLL_INTERVAL_MS=3000  # polling間隔（§5.3参照）
```

### 13.4 比較

```
                    PostgreSQL           SQLite
──────────────────────────────────────────────────
セットアップ        docker-compose必要    不要（ファイル1つ）
配信遅延           ~0秒（pg_notify）     ~1秒（polling）
同時書き込み        高性能               WALモードで対応
bot数上限          無制限               ~10 bot
agent-memory連携   pgvector使用可        別途対応必要
推奨用途           multi-bot 大規模     1-10 bot (OSS default)
```

### 13.5 スケーラビリティ（polling driver）

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
  state-daemon (§13.1) の polling 間隔 + bot 側 polling fallback の interval を環境に合わせて調整
  PostgreSQL 環境では Phase D で state-daemon を pg_notify driven 化する選択肢あり (将来 ADR、本 spec scope 外)
  SQLite 環境では state-daemon + bot LLM 側 polling fallback で十分
```

OSS利用者の大半は1-10 bot構成のため、デフォルト3秒で十分。

### 13.5.1 メッセージ配信メカニズム

メッセージ配信は 3 層構造。**primary (state-daemon typed observation / approved runner) → secondary (MCP notification) → fallback (polling)** の順に作用する。ADR-050 (2026-05-05) の state-daemon primary 方針は維持するが、CP-70/CP-80 以降、state-daemon の TUI prompt injection wake は廃止する。

**Primary: state-daemon typed observation / approved runner (§13.1)**

- 外部プロセス `bin/state-daemon.ts` が `message_queue` を LISTEN / sweep で観測し、planner action と metrics に typed evidence を記録する
- 承認済み runner path が設定された runtime のみ、queue_id 指定の typed runner invocation を起動できる
- TUI runtime では `tmux send-keys` による自然言語 prompt 注入で `next` / `processing` / `done` tool 呼出を依頼しない
- 承認済み runner path がない場合は fail-closed/no-op とし、queue row は visibility/repair 用に open のまま保持する
- state-daemon 不通 / tmux session 不在時は non-fatal (次層にフォールバック)
- state-daemon の HA / supervisor は ADR-051 で別途扱う

**Typed completion authority**

- state-daemon と queue-work envelope は、未信頼の `content`（例: `No reply required`、`no_reply_required: true`、ACK 作文）を close / skip / reply 不要の根拠にしてはならない。
- substantive な内容は `message_type` が `instruction` / `request` / `question` 以外（`chat` / `report` / `notice` / `projection` を含む）でも、型名だけで non-action / ACK と断定してはならない。厳格な typed ACK envelope が無い行は runner 配送へ fail-open する。
- unknown / 未定義 / 判別不能な `message_type` は hold や自動 terminal にせず runner 配送へ fail-open する。ただし disabled agent / self-authored loop など既存の明示的な typed block と、`phase_handoff` の protected hold / exact fence は維持する。
- reply 不要の指定は typed `reply_contract.required=false` として queue-work envelope に渡す。この指定は substantive work の実行を省略する権限ではなく、実行後の typed result が `next_action=close` を返すための応答契約である。
- 自動 terminal が許される ACK は、recognized non-action transport type に加えて、queue payload に次の完全な structured envelope を持つ行だけである。欠落・余分な ACK 作文・不正な schema/kind/空の参照 ID は権限にならず配送する。

```json
{
  "typed_ack": {
    "schema_version": "aun-queue-ack/v1",
    "kind": "receipt",
    "acknowledged_message_id": "non-empty-message-id"
  }
}
```

- `content` と `message_type` だけでは ACK にならない。`typed_ack` は control-plane producer が構造化して付与する機械入力であり、state-daemon は本文から生成・補完しない。自動 terminal reason は `TYPED_ACK_RECEIPT` とする。
- substantive work の terminal 遷移は typed runner result または明示 lifecycle 操作だけが行う。state-daemon は入力本文から `complete-no-reply` / completion reason / terminal baton を生成しない。

**Secondary: MCP notification (MCP client 対応時の加速)**

- PollingDriver が pending 検出時に MCP 標準 notification を送信
- method: `notifications/message/pending` / params: `{ waiting: number }`
- PollingDriver の setInterval (`AGENT_COM_POLL_INTERVAL_MS`, default 3s) で pending 検出時に毎回送信
- MCP client がコンテキスト注入をサポートする場合、LLM が `next` tool を呼ぶトリガーとして機能 (Claude Code / Codex / Gemini / Cursor 全対応の MCP protocol 標準機能)
- 現時点では Claude Code 未対応 (§13.5 既知制約)。対応クライアントで state-daemon を補助する位置づけ
- pending 0 のときは送信しない。送信失敗時 (transport 断、client 未対応等) も polling は継続 (non-fatal)

**Fallback: Polling (bot/client schedule)**

- bot 側 client / operator が設定した polling cadence で `next` tool を呼び出す
- state-daemon / notification が全て失敗しても最終的にメッセージ取得
- `AGENT_COM_POLL_INTERVAL_MS` は polling driver 側の pre-fetch 間隔 (§13.5 参照)

§13.5 の「将来 Claude Code が MCP notification のコンテキスト注入をサポートした時点で push 方式に完全移行可能」のうち、**件数シグナル** 部分は secondary として実装済み (message 本体は依然 `next` pull 一択、spec §4.1)。**primary は state-daemon** だが、LLM TUI への自然言語 prompt 注入ではなく typed observation / approved runner に限定する。

#### 13.5.1.1 Memory-ready evidence supply and gate retry

`memory_ready` は approved runner の必須 gate であり、その evidence 供給も
state-daemon 配送面の一部として扱う。供給 job、gate、運用設定の正本はこの repository
に置き、home directory 配下だけに存在する script を本番 entrypoint にしてはならない。
refresher の launchd plist は repository 内 template から生成し、生成元 commit と設定
digest を readback できなければならない。

**対象席と batch 契約**

- inventory は `agents.status IN ('idle','busy')`、`profile_enabled = true`、
  `disabled_at IS NULL` の全行である。既存の `STATE_DAEMON_AGENT_DENYLIST` に含まれる席だけを
  typed `DENYLISTED` として除外できる。本機能が denylist の値を変更してはならない。
- denylist 外の inventory `N` 行には必ず `N` 個の terminal per-seat result を返す。
  session、port、runtime、workspace 又は project が欠ける席も silent に落とさず、typed
  failure reason と repair signal を記録する。
- 1 席の resolver / bootstrap / readback failure はその席の result だけを失敗にし、残りの
  席を継続する。batch summary は inventory、eligible、ready、failed、skipped の各件数と
  policy schema version / digest を持つ。全席処理後に failed が残る場合、process は非 zero
  で終了してよいが、途中 abort はしない。

**Current-runtime resolver (single implementation)**

refresher と gate は同じ exported resolver を使用する。profile tuple の schema mapping は
次で固定する。`agents.runtime` は legacy 名だが登録 runtime kind を保持し、その instance
側の表現である `agent_runtime_instances.runtime_engine` と exact 比較する。

```text
profile tuple = {
  runtime_kind: agents.runtime          <=> instance.runtime_engine,
  session:      agents.metadata.tmux_session <=> instance.session_name,
  home:         agents.home_directory   <=> instance.checkout_path
}
```

**Runtime registration metadata authority**

ordinary `local_process` heartbeat が `agent_runtime_instances` を登録・更新するとき、
`checkout_path` と `session_name` の authority は起動 process の `PWD` / `TMUX` ではなく、
対象 `agent_id` の enabled な登録 profile とする。`agents.home_directory` が非空なら
`checkout_path` はその値を使い、`agents.metadata.tmux_session` が非空なら `session_name` は
その値を使う。登録値が空の場合に限り、heartbeat input の ambient 値へ field 単位で fallback
できる。登録値と ambient 値が異なる場合も登録値を優先し、ambient 値は observation としてだけ残す。

heartbeat row の `metadata.registration_metadata_provenance` は schema version と、各 field の
`source` (`registered` / `ambient` / `missing`)、effective value、registered value、ambient value、
および mismatch boolean を持たなければならない。これにより PWD/TMUX が無い MCP server でも
席の登録 profile と一致する row を作れ、どの authority を使ったかを後から query できる。
profile lookup failure や両方の値の欠落を silent に ambient/default へ偽装してはならない。

profile tuple の各登録値が非空であることは ordinary resolver の完全な判定に必要である。
resolver の呼出側は `requested_runtime_kind` を必ず指定する。candidate、current selection、
freshness ranking、stale reap はその kind の行だけを対象にし、異なる kind を同じ ranking に
参加させてはならない。ordinary runtime kind では上記 profile tuple と A1 の freshness / ranking
規則をそのまま適用する。

`bootstrap_bound_provider` は ordinary freshest-profile candidate から常に除外する。この kind は
sealed selected bootstrap receipt が指定する exact `runtime_instance_id` だけを候補とし、その行の
`runtime_kind`、`runtime_engine`、`session_name`、`checkout_path` が receipt の束縛と完全一致する場合に
のみ current として解決する。`agents.runtime` と `runtime_engine_preference` は bootstrap profile key
ではない。receipt が指定する有効な exact row が 0 件なら typed `NO_BOOTSTRAP_BOUND_ROW` で
fail-closed にする。bootstrap と ordinary の間に cross-kind current ranking 又は cross-kind reap を
定義してはならない。

resolver はまず `status IN ('running','active')` かつ valid heartbeat (`last_seen_at`) が
`LIVENESS_TTL` 内の row を live pool にする。live exact tuple match が 1 行以上あれば、その集合だけを
current ranking に参加させ、複数なら `last_seen_at DESC, started_at DESC,
runtime_instance_id ASC` で決定的に 1 行を選ぶ。同時に存在する live profile-mismatch row は typed
`PROFILE_MISMATCH_DEPRIORITIZED` とし、exact row より下位へ置く。この順位付け以外の理由で
profile-mismatch row を一律除外してはならない。

live exact tuple match が 0 行で、requested kind の live row が 1 行以上ある場合は、freshness 順の
先頭を current として維持し、typed `REGISTRATION_PROFILE_MISMATCH` observation を返す。この fallback は
登録 authority drift を可視化しながら「唯一の生きた自席 instance を候補ゼロにして恒久 block する」
ことを防ぐためのもので、mismatch を ready と偽装するものではない。heartbeat writer は同じ transaction
path で登録 profile による metadata correction を先に行い、monitor は correction 前又は古い writer が
残した mismatch を fleet 全体で数えられなければならない。不一致だけを理由とする quarantine、status
mutation、reap、物理削除は行わない。profile match でも heartbeat が stale なら current ではない。

current が 0 件の場合も原因を潰してはならない。requested kind の active row 自体が 0 件なら
`NO_RUNTIME_ROWS`、active row はあるが全て heartbeat stale なら `ONLY_STALE_RUNTIME_ROWS` を
`NO_CURRENT_RUNTIME_FOR_PROFILE` の typed subreason として返す。`REGISTRATION_PROFILE_MISMATCH` は
live current を伴う observation であり candidate absence reason にしてはならない。refresher report、
gate detail、daemon log/metric、read-only identity monitor は同じ resolver の observation / subreason を
使い、独自の profile 判定を再実装してはならない。

`LIVENESS_TTL` は `(runtime_kind, source)` group の登録 `heartbeat_interval * 6` とする。
`source` は instance `metadata.source`、それが空なら `runtime_engine`。group 登録がない場合は
30 分を使用する。heartbeat interval、既定値、backoff 値は schema version を持つ repository
config から読み、resolver/refresher report と daemon startup readback に schema version と
content digest を出す。config が absent / malformed / unsupported version なら fail-closed とする。

**Runtime rotation と memory-ready evidence rebinding**

ordinary runtime heartbeat の upsert 後、heartbeat writer は同じ exported current-runtime resolver
で当該席を再解決する。heartbeat row が新しい current candidate で、当該席/project の最新
`runtime_memory_ready_evidence.runtime_instance_id` が current instance と異なる場合、それを typed
`SUPERSEDED_EVIDENCE_BINDING` として検出し、同じ single-seat refresher/readback 経路で evidence を
current instance に再束縛する。再取得後は gate readback が `ready` にならなければ成功として扱わない。
exact current が存在する間に `PROFILE_MISMATCH_DEPRIORITIZED` となった heartbeat は evidence を
再束縛できず typed warning のみを残す。`REGISTRATION_PROFILE_MISMATCH` current は silent に捨てず、
登録 provenance と mismatch を audit/monitor に残す。heartbeat writer が profile authority で row を
correct した後は、同じ heartbeat event 内で通常の evidence 再束縛へ進む。

rotation refresh は heartbeat event が主契機であり、固定周期 refresher の次回実行待ちにしては
ならない。daemon 起動時にも 1 回 reconciliation を行い、daemon 配備前に生じた rotation を回収する。
heartbeat event と起動時 reconciliation は冪等で、latest evidence が current instance に既に束縛
されている場合は新しい evidence を作らない。refresh failure は typed terminal result/log として残し、
heartbeat row、旧 evidence、又は queue row を手動修復しない。

read-only identity monitor は少なくとも `REGISTRATION_PROFILE_MISMATCH`、
`PROFILE_MISMATCH_DEPRIORITIZED`、`SUPERSEDED_EVIDENCE_BINDING` を席別に列挙・集計できなければ
ならない。registration finding は effective 登録 metadata の provenance も返し、同型の全席を一つの
query/report で列挙する。最後の finding は latest evidence と common resolver が選ぶ current instance の
不一致で判定し、stopped row に束縛された evidence も同じ typed finding とする。

**Stale runtime reap**

reap の equivalence group は
`(agent_id, agent_runtime_instances.runtime_kind, metadata.source || runtime_engine)` とする。
cross-group reap、および単に current に選ばれなかったことを理由とする reap は禁止する。
running/active row を `stopped` に訂正できるのは次のどちらかだけである。

1. absolute: heartbeat age が `REAP_TTL = max(24h, heartbeat_interval * 12)` を超える。
   未登録 group の `REAP_TTL` は 24 時間。
2. supersession: 同一 equivalence group に `LIVENESS_TTL` 内の row があり、対象 row 自身は
   `LIVENESS_TTL` を超える。

mutation は observed `runtime_instance_id`、status、`last_seen_at` を compare-and-set 条件にし、
`status='stopped'` と `stopped_at` のみを冪等更新する。process kill、tmux kill、cross-group
変更は行わない。生きている process は次回 register / heartbeat で `running` に自然回復する。

**Gate backoff and alert dedup**

同一 queue row の同一 blocked fingerprint (`reason`、current runtime/evidence identity、typed
details の stable digest) は 30 秒から指数 backoff し、30 分で cap する。backoff 中は gate
query、blocked metric、alert を再発火しない。alert は unblocked→blocked、blocked fingerprint
change、blocked→ready の状態遷移時だけ許可する。同一 fingerprint の再評価 failure は retry
schedule だけを更新する。state は daemon process 内で queue id ごとに bounded に保持し、
ready/terminal row で破棄するため、この契約は新しい DB schema を要求しない。daemon restart
後の最初の観測は新しい transition として 1 回だけ alert してよい。

#### 13.5.1.2 Queue-work runtime selection, adapter fallback, and retry

state-daemon の queue-work scheduler は、全席を process-wide の単一 provider に送っては
ならない。各 invocation の engine は enabled な対象席の
`agents.runtime_engine_preference` から次の exact mapping で解決する。

| `runtime_engine_preference` | queue-work runtime |
|---|---|
| `codex`, `codex-runner` | `codex-exec` |
| `claude`, `claude-code` | `claude-code` |

空値は `RUNTIME_ENGINE_PREFERENCE_REQUIRED`、未知値は
`RUNTIME_ENGINE_PREFERENCE_UNSUPPORTED` として fail-closed にする。scheduler はこの場合に
process-wide `STATE_DAEMON_QUEUE_WORK_RUNTIME` 又は `agents.runtime` へ fallback してはならない。
manual runner の明示 `--runtime` はこの per-seat scheduler 契約の外であり、従来どおり使用できる。

**Engine configuration contract**

queue-work runtime を追加又は変更する実装は、process 起動前に engine ごとの設定契約を
解決しなければならない。契約は少なくとも runtime id、result schema の形式、MCP 設定 mode を
宣言する。現行の exact contract は次のとおりである。

| queue-work runtime | result schema | MCP 設定 mode |
|---|---|---|
| `codex-exec` | readable JSON schema file | `none` |
| `claude-code` | readable JSON schema file converted to inline JSON | `strict` |

`strict` mode の Claude MCP 設定は、明示された inline JSON 又は runtime cwd 相対の file ref を
使用する。明示値がない場合は least-privilege な canonical no-server 設定
`{"mcpServers":{}}` を生成する。いずれの場合も top-level object の必須 field
`mcpServers` が object であることを起動前に検証し、空文字、`{}`、missing/unreadable file、
malformed JSON、又は malformed result schema を runtime process に渡してはならない。

設定契約を満たさない場合は欠落又は不正な項目名を detail に含む typed
`ADAPTER_CONFIGURATION_INVALID`、`retryable=false` とし、process を起動せず同じ sweep で
`failed` にする。Claude CLI が起動後に `Invalid MCP configuration` と判定した場合も、外部状態で
変化する provider failure ではなく同じ決定的分類にする。設定値そのものや secret は error
detail に含めない。engine 追加時に個別 builder だけを足すことは禁止し、上記共通設定契約へ
runtime id と schema/MCP mode を登録しなければならない。

**Codex output fallback**

Codex primary success は `exit_status = 0`、`--output-last-message` file が存在し、その内容が
有効な `queue_work_result_v1` であることを要求する。`exit_status = 0` でも file が無い場合、
adapter は同じ `codex exec --json` invocation の stdout JSONL にある最後の
`item.completed.item.type = agent_message` の `text` だけを代替取得経路として使用できる。
これは engine fallback ではなく、同一 invocation の secondary result transport である。

JSONL fallback が有効な `queue_work_result_v1` を返した場合、runner result の evidence に
`runtime_adapter_fallback=codex_jsonl_agent_message` と
`runtime_adapter_primary_failure=CODEX_OUTPUT_LAST_MESSAGE_MISSING` を追加する。JSONL に exact
agent message がない、stream が malformed、又は取得した message が result contract を満たさない
場合は `CODEX_OUTPUT_LAST_MESSAGE_MISSING` を `retryable=false` で記録する。汎用
`ADAPTER_ERROR` への丸め込み、別 provider への暗黙退避、空 result の成功扱いは禁止する。

**Claude Code adapter**

`claude-code` 席は `claude -p --output-format stream-json --json-schema` の headless adapter を
使用し、Codex と同じ queue-work envelope / result / claim fence / finalizer を共有する。
untrusted queue body は argv に入れず stdin で渡す。final `result` event の
`structured_output`（又は exact result text）だけを `queue_work_result_v1` として受理する。
MCP 設定は上記 `strict` contract で解決した値だけを `--mcp-config` に渡す。
Codex への暗黙 provider fallback は行わない。

**Failure classification and retry**

新規 runner error は `runner_error.code`、`runner_error.retryable`、`runtime_id`、
`invocation_source`、claim fence を durable に記録する。少なくとも次を状態不変 failure とし、
reclaim/re-invoke せず同じ sweep で typed `failed` へ遷移させる。

- `CODEX_OUTPUT_LAST_MESSAGE_MISSING`
- `ADAPTER_RESULT_INVALID`
- `ADAPTER_CONFIGURATION_INVALID`
- `RUNTIME_ENGINE_PREFERENCE_REQUIRED`
- `RUNTIME_ENGINE_PREFERENCE_UNSUPPORTED`

この即時 terminal は失敗を成功へ変換しない。`status='failed'`、
`failed_reason=<runner_error.code>`、`queue_work_runner_error_recovery.last_action =
failed_non_retryable` を残し、`done` / `replied` にはしない。設定契約違反を除く non-zero exit、timeout、provider
availability のように外部状態が変化しうる failure だけを `retryable=true` とし、既存の bounded
reclaim cap を適用する。model の `ok=false` result は `next_action='retry'` のときだけ retryable
であり、それ以外は `ADAPTER_RESULT_NOT_OK` の typed failed とする。旧 row に
`runner_error.retryable` が無い場合だけ backward-compatible bounded retry を維持する。

失敗分類は schema 変更なしで次の canonical query により数えられなければならない。

```sql
SELECT payload::jsonb #>> '{runner_error,code}' AS failure_code,
       count(*)
  FROM message_queue
 WHERE payload::jsonb ? 'runner_error'
 GROUP BY 1
 ORDER BY 1;
```

### 13.6 Presence Client

Presence Client は将来拡張、現行は opt-in。

```typescript
// intents空 → イベント一切受信しない
// Gateway接続だけでDiscord上にオンライン表示
const client = new Client({ intents: [] });
client.login(process.env.DISCORD_TOKEN);
```

各botのtmuxセッションでバックグラウンド実行。
メッセージの送受信に影響なし。起動しなくても機能に問題なし。

### 13.7 Fleet Runtime V1 provider resume

本節は `docs/SSOT.md` §10.3 に従属する。Fleet Runtime V1 の request は immutable
であり、`request_digest` と `idempotency_key` を再計算・検証した後、次の順序で
provider admission を行う。

| durable state | live admission | 結果 |
|---|---|---|
| なし | `SEALED_START`: sealed observation と fresh observation の鮮度・完全一致、zero queue | preflight PASS 後に初回 reservation |
| `reserved` + exact digest | `DURABLE_RESUME`: owner / predecessor / remote image / queue / root-goal をすべて fresh readback。`VERIFY_EXTERNAL_MERGE` 前は remote image と sealed preimage の完全一致を維持する。同 phase の started/completed 後だけ、下記の merge-derived postimage basis と照合する。canonical `resume_admission_binding` ref が指定された場合は、queue について下記の exact tuple と admitted fresh observation ID を代替 binding として検証する。どの場合も fresh schema / identity / zero queue は必須 | 同じ durable invocation の残存 phase のみ reconciliation / resume |
| `completed` + exact digest | live preflight なし | durable receipt を完全検証して original receipt を返す |
| same key + different digest、または malformed state | live preflight なし | fail-closed |

`DURABLE_RESUME` でも immutable owner / predecessor body digest、semantic binding、target
image、root-goal readback、および preflight zero-write / zero-effect counters の検証を
省略しない。fresh queue readback が nonzero、stale、または不正なら protected effect 前に
停止する。

### Merge-derived postimage basis

provider は durable reservation を load した後、live preflight より先に operation journal を
read-only validation し、次のどちらか一方の resume image basis を決定する。

1. `SEALED_PREIMAGE`: journal に `VERIFY_EXTERNAL_MERGE` phase が存在しない。live
   `target_preimages` は immutable `request.preimages` と field/order を含め完全一致する。
   branch/head/tree/surface digest の drift は従来どおり `PREFLIGHT_RECEIPT_MISMATCH` で停止する。
2. `MERGE_DERIVED_POSTIMAGE`: journal の `VERIFY_EXTERNAL_MERGE` phase が `started` または
   `completed`。basis は request digest、phase status、journal intent/evidence digest、target
   repository、base、PR URL、pushed head、external-merge receipt self digest、merge commit、
   merge tree を exact に拘束する。canonical external-merge receipt は immutable journal
   intent の PR URL / pushed head と一致し、GitHub readback は同 PR が non-draft の MERGED、
   exact base/head/merge commit であること、commit API は exact merge tree を返すこと、live
   default branch は exact merge commit/tree であることを証明しなければならない。surface
   count/digest はその exact live tree から再計算する。phase が `completed` の場合は receipt
   fields と journal evidence も完全一致させる。

この basis は adapter と provider の同一 invocation 内でだけ渡す read-only context であり、
sealed request、reservation、operation journal、または
`fleet-runtime-v1/preflight-receipt/v3` に保存しない。basis の欠落・malformed、journal digest
不一致、external receipt 不一致、PR/commit/live postimage drift は preflight で fail-closed とし、
filesystem/database/queue/protected-effect counter はすべて 0 のままにする。`completed`
invocation の same-key same-request replay は basis load と live preflight より前に original
receipt を返し、受領済み subeffect を再実行しない。

回帰 fixture は次を個別に証明する。

- merge receipt が journal の started/completed `VERIFY_EXTERNAL_MERGE` に exact に束縛され、
  live postimage が一致する resume は `CANARY_COLD_START` を含む残余 phase に進む。
- 同 phase が未開始の resume で sealed preimage 外 drift がある場合は effect 前に拒否する。
- post-merge resume 完了後の same-key same-request は original receipt を返し、preflight と
  protected subeffect の回数を増やさない。

binding 付き resume の入力は sealed request とは別の immutable ref とし、次の 2 値を両方
指定する。片方だけ、不正 URL、digest 不一致、編集済み comment は fail-closed とする。

- `FLEET_RUNTIME_V1_RESUME_ADMISSION_HANDOFF_URL`: `watchout/ai-dev-framework` issue #576 の immutable comment URL
- `FLEET_RUNTIME_V1_RESUME_ADMISSION_HANDOFF_SHA256`: GitHub API が返した raw comment body の `sha256:<64hex>`

provider は comment author `watchout`、`created_at == updated_at`、raw body digest、
`shirube-v3/control_handoff/v1` identity、from/to function、および canonical
`subject_invocation` / `resume_admission_binding` を検証する。binding の次の tuple は exact
でなければならない。

1. `durable_request_id`, `request_digest`, `idempotency_key`, `stage_id`, `operation`,
   `repository`, `operational_subject_digest` が immutable request と一致する。
2. `remote_head` が operation journal を read-only validation して得た
   `PUSH_NORMAL_BRANCH.intent.head` と一致する。
3. `sealed_queue_revision` が request の sealed revision と一致する。
4. `admitted_fresh_queue_revision` と `admitted_fresh_queue_observation_id` が実行時に再観測した
   fresh observation と一致し、pending / received / in_progress がすべて 0 である。

preflight receipt は `fleet-runtime-v1/preflight-receipt/v3` とし、検証した raw handoff body、
URL、raw digest、actor、timestamp、binding tuple を `resume_admission_binding` に格納する。
binding なしの resume はこの field を `null` とし、従来の sealed equality を維持する。
実測 observation が admitted ID からさらに drift した場合は `QUEUE_OBSERVATION_DRIFT` を
typed fail-closed とし、successor binding が publish されるまで停止する。

provider の durable reservation、operation journal、sealed request は resume 判定のために
書き換えない。既に completed または readback で受領済みと確定した `PUSH_NORMAL_BRANCH`、
`CREATE_DRAFT_PR`、`COLD_START_DISCORD_KODAMA` を通常 resume から再実行してはならない。

phase loop は journal status を effect より先に評価する。`completed` phase は intent 構築と
`performPhase` の両方を skip し、`started` phase は `performPhase` を再実行せず
`reconcilePhase` だけで readback する。初回 `performPhase` と resume `reconcilePhase` には、
adapter が当該 invocation 用に検証した同一の `fleet-runtime-v1/preflight-receipt/v3` を渡す。
通常 mode では、とくに `COLD_START_DISCORD_KODAMA=completed` かつ
`VERIFY_LIVE_IDENTITY=started` の durable invocation は、COLD_START の protected effect を
増やさず、preflight の queue observation と live runtime/checkout/default-branch postimage の
照合だけを再開する。照合に成功したときは `VERIFY_LIVE_IDENTITY` を completed にして
canonical `CANARY_COLD_START` receipt を生成し、照合不能なら completed COLD_START を replay
せず typed fail-closed とする。

この crash point の回帰 fixture は、(1) concrete `performPhase` が preflight receipt を実参照
して `VERIFY_LIVE_IDENTITY` を完了できること、(2) completed COLD_START と started VERIFY を
持つ resume が COLD_START の call count を増やさず canonical receipt に到達すること、
(3) resume の protected effect 増分が 0 であることを個別に証明する。

### COLD_START boot configuration と `REALIZE_POSTIMAGE`

`COLD_START_DISCORD_KODAMA` の Codex command は、tmux client に渡した ambient env が tmux
server/session または MCP child に継承されることを仮定しない。`mcp_servers.aun.env` に次の
exact key/value を組み立てる。

| key | value source |
|---|---|
| `AGENT_ID` | literal `kodama` |
| `AGENT_COM_EXPECTED_AGENT_ID` | literal `kodama` |
| `AGENT_COM_DB` | literal `postgres` |
| `DATABASE_URL` | provider admission/queue readback に用いた同じ nonempty binding |
| `AGENT_COM_RUNTIME_HEARTBEAT_DISABLED` | literal `0` |
| `WEBHOOK_PORT` | decimal string `8803` |
| `DISCORD_STATE_DIR` | `/Users/yuji/.claude/channels/discord-kodama` |
| `AGENT_COM_RUNTIME_SESSION` | literal `discord-kodama` |

全値は Codex config scalar として escape し、DB URL 自体を journal evidence へ保存しない。
completed evidence には上表の exact key 集合だけを残す。`DATABASE_URL` がない場合は checkout、
tmux、DB、queue の effect 前に `READBACK_INVALID` で停止する。

server path は `${invocation_directory}/provider-runtime/provider-checkout/server.ts` に固定する。
provider は canonical origin `https://github.com/watchout/agent-comms-mcp.git` または同一 SSH origin
の remote `main` と実行 source HEAD が一致することを確認し、その head/tree を state root 配下の
real、detached、clean checkout と canonical runtime-image manifest に pin する。既存 manifest は
canonical JSON+LF、exact schema/key set、state-root containment、non-symlink、origin/head/tree/
clean/detached/server-file readback がすべて一致するときだけ再利用する。provider process の cwd、
session worktree path、ambient `AGENT_COMMS_SERVER_PATH` は runtime server path の source にしない。

COLD_START の postimage は次の AND 条件でのみ realized とする。

1. port 8803 に LISTEN pid が 1 件以上ある。
2. official PostgreSQL queue observation の latest runtime instance が fresh `running`、
   `session_name=discord-kodama`、`port=8803`、`checkout_path` が当該 invocation の Kodama checkout、
   `commit_sha` が phase の exact expected head、`stopped_at=null`、`git_dirty=false` である。

初回 COLD_START は `tmux new-session` 後、最大 30 回・1 秒間隔の bounded readback でこの AND
条件を待つ。LISTEN pid 集合、runtime instance ID、登録 checkout/head、provider pin と必須 env
key 集合を phase evidence に含め、その evidence が構成できたときだけ completed journal を
書く。timeout/error の場合は started journal を維持し、completed を先書きしない。

effect 後 crash からの `started` COLD_START reconciliation も同じ boot AND 条件と evidence key
集合を使う。`reconcilePhase` は wrapper を再起動せず、既存の durable provider image manifest
を exact readback し、bounded window 内に listener と fresh exact runtime registration の両方を
確認したときだけ completed を返す。session/port/checkout だけを照合する旧 evidence への
downgrade、provider manifest 欠落時の completion、または部分 postimage の success 扱いは禁止する。

CLI の明示 `--realize-postimage` は `--execute-protected-effects` と exact executor/resume admission
を同時に満たす場合だけ `REALIZE_POSTIMAGE` mode を選ぶ。この mode は次の状態機械を持つ。

| durable COLD_START / live postimage | result |
|---|---|
| 未 completed | `REALIZE_POSTIMAGE_NOT_ADMITTED`; wrapper effect 0 |
| modern completed / boot-proof evidence あり | `REALIZE_POSTIMAGE_NOT_ADMITTED`; wrapper effect 0 |
| legacy completed / listener+exact registration とも realized | `ALREADY_REALIZED`; wrapper effect 0、VERIFY だけ継続 |
| legacy completed / listener と exact-target runtime registration component がともに absent | durable provider image から wrapper を 1 回起動し bounded readback。成功後 VERIFY だけ継続 |
| legacy completed / exact-target component が片方だけ存在、または listener/registration conflict | bounded convergence readback 後も不一致なら typed fail-closed; wrapper effect 0 |

legacy eligibility は completed evidence の exact legacy schema、すなわち `boot_environment_keys`
以下の boot-proof key 集合が存在しないことから判定する。postimage classifier は target port の
LISTEN pid 集合と latest runtime row を typed input とし、次の規則を順に適用する。

1. latest row は `status=running`、`stopped_at=null`、fresh `last_seen_at`、および exact
   `session_name` / `port` / `checkout_path` / `commit_sha` をすべて満たす場合だけ
   exact-target runtime registration component である。`git_dirty` は target identity ではなく
   realization 条件なので、dirty な exact-target component は存在するが realized ではない。
2. listener と clean な exact-target component がともに存在するときだけ `REALIZED` とする。
3. `REALIZED` でなく、listener または exact-target component の少なくとも一方が存在すれば
   `PARTIAL` とし、bounded convergence readback 後も揃わなければ wrapper effect 0 で fail-closed
   とする。target port の listener は row identity にかかわらず collision component として扱う。
4. listener も exact-target component も存在しない場合だけ `ABSENT` とする。したがって
   stopped、stale、wrong session/port/checkout/commit の row は、それ単独では `PARTIAL` の根拠に
   せず、admitted な wrapper launch 経路を妨げない。

各 observation は listener pid、latest row の status/session/port/checkout/commit/stopped/fresh/dirty、
exact-target component 判定、realized 判定、最終 state を typed classification record に残す。
`REALIZE_POSTIMAGE` 経路はこの record を後続 `VERIFY_LIVE_IDENTITY` phase evidence の
`postimage_classification` に保存し、bounded timeout は最後の classification を error に含める。
これにより成功・失敗のどちらも、journal または typed error から判定根拠を再読できる。

この経路は COLD_START phase を再度 started/completed にせず、COLD_START の effect-specific
evidence と `protected_effect_count=1` を増減しない。durable resume に伴う既存 execution-owner
fencing と、成功後の VERIFY phase completion は通常契約どおりであり、COLD_START effect の
再記録には数えない。再実現した live runtime instance は同じ executor process 内の VERIFY readback にだけ束縛し、canonical receipt の
`duplicate_effect_count=0` / `unauthorized_effect_count=0` を維持する。completed invocation の
original-receipt replay と、通常 mode の completed-phase skip/no-replay は変えない。

回帰 fixture は少なくとも (1) command の必須 env exact key/value、(2) server path が provider
source cwd ではなく state-root provider checkout を指すこと、(3) completed+absent の 1 回だけの
再実現成功、(4) completed+realized の no-op、(5) uncompleted の effect-before reject、(6) 新規
COLD_START が listener+registration evidence なしでは completed にならないことを個別に証明する。

---

## 14. Phase C 完了条件 (CEO 承認 2026-04-17)

| # | 条件 | 検証方法 |
|---|------|----------|
| 1 | npx agent-comms-mcp で全機能起動 (run-bot subcommand 含む) | CI: fresh env → init → run-bot → message 送受信 |
| 2 | SQLite default (PostgreSQL 基本機能動作) | CI: SQLite で全テスト pass。PG 固有の wake mechanism (pg_notify driven state-daemon) は Phase D |
| 3 | 1 daemon で inbound + outbound + heartbeat 完結 | test: daemon → Discord 送受信 → run-bot.sh が LLM で返信 |
| 4 | routing 100% deterministic (LLM 判断ゼロ) | test: LLM 未接続で全 routing 動作 |
| 5 | 外部ファイル依存ゼロ | grep: access.json/plugin 参照なし |

v2.1.0 追加テストケース:
- 排他制御: 2 consumer 同時起動 → 2 番目が exit 1
- orphan reclaim: read → RECLAIM_TIMEOUT 経過 → pending に戻る
- loop 検出: reply_chain に self 3 回 → fail (LOOP_DETECTED)
- truncate: 2000 文字超 → 1900 で切られる (CLI send 内)
- heartbeat: run-bot.sh 起動中 → agents.last_seen_at が更新される

---

## 15. CLI Setup

Quick Start:

```bash
npx agent-comms-mcp          # auto-detect: .env 有 → start / 無 → init
npx agent-comms-mcp init     # 対話式セットアップ (token / DB / Agent ID → .env 生成)
npx agent-comms-mcp start    # .env 読込 → daemon + MCP 起動
npx agent-comms-mcp status   # health endpoint 問合せ
```

init で生成される .env:

```
AGENT_ID=my-bot
DISCORD_TOKEN=your-bot-token
AGENT_COM_DB=sqlite
AGENT_COM_SQLITE_PATH=./agent-com.db
# DATABASE_URL=postgresql://localhost/agent_comms
AGENT_COM_POLL_INTERVAL_MS=3000
AGENT_COM_REPLY_CHAIN_DEPTH=5
```

init フロー:
1. `.env` 存在チェック → 上書き確認
2. Discord bot token (必須)
3. Agent ID (デフォルト: cwd の basename)
4. DB 種別: sqlite (デフォルト) / postgres
5. postgres 選択時: DATABASE_URL 入力
6. `.env` 生成 → sqlite 選択時は `migrateSqlite()` も実行

---

## 16. agent-memoryとの連携

### 16.1 search_memory誘導

```
next_messageの結果にhintを含める:
  "hint": "統合記憶系 tool (例: search_memory) で過去の決定事項を確認してから返信してください"

sendツールのdescriptionにも記載:
  "返信前に統合記憶系 tool (例: search_memory) で過去の決定事項を確認してください。"
```

### 16.2 DB共有

```
PostgreSQL環境:
  agent-comとagent-memoryが同一DBを共有（既存方式維持）
  CREATE TABLE IF NOT EXISTS パターンで共存

SQLite環境:
  agent-com用とagent-memory㔨で別ファイル
  agent-memoryのpgvector依存はSQLiteでは使えない → テキスト検索fallback
```

---

## 17. 監視

### 17.1 Receiverヘルスチェック

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

### 17.2 Spec Auditor（日次）

```
全仕様書を一括読み込み → 矛盾検出レポート
spec-auditor botがpolling driver（§5.3）で常駐。
LLM CLI の instruction mechanism で 24 時間ごとに全spec監査を自発実行。
PRマージ後のトリガーはagent-com notify経由でbot宛にメッセージ送信。
結果をCEOのキューに投入。
cron不要。
```

### 17.3 bash curl直叩き検出（receiver内蔵、1時間ごと）

```
receiver内のsetIntervalで自動実行（§12.3と同一実装）。
Discord REST APIで最新メッセージ取得
→ agent_messages.discord_message_idと突合
→ 未記録のメッセージ = bypass → audit_log + CEO通知
cron不要。receiverプロセスに内蔵。
```

### 17.4 N1 通信 SLO 計測装置

N1 は provider や Discord の到達性を試す smoke ではなく、内部
`agent_messages` / `message_queue` の send → claim → close 往復を定期計測する
report-only harness である。正本実装は `scripts/n1-slo/`、contract test は
`tests/contract/test_n1_slo_harness.test.ts` とする。

#### active seat の正準列挙

列挙集合は、計測開始時点で次の両方を満たす `agent_id` のみである。

1. `agents.status IN ('idle', 'busy')`。`online`、`offline`、`disabled` および
   その他の status は対象外
2. 同一 agent/runtime を holder とする、有効期限内の runtime endpoint lease
   (`lease_scope_type='runtime_instance'`, `lease_purpose='worker'`,
   `status='active'`, `expires_at > observed_at`)

正準 query version は `agents-idle-busy-valid-runtime-endpoint-lease/v2`。lease の
`holder_runtime_instance_id`、`lease_scope_id`、`agent_runtime_instances.agent_id`
は同一 runtime/agent tuple に一致しなければならない。tmux、Discord presence、
`last_seen_at`、process scan はこの集合の代替 authority にしない。

```sql
SELECT DISTINCT ON (a.agent_id)
       a.agent_id, ri.runtime_instance_id, lease.lease_id, lease.expires_at
  FROM agents a
  JOIN control_plane_leases lease
    ON lease.holder_agent_id = a.agent_id
   AND lease.lease_scope_type = 'runtime_instance'
   AND lease.lease_purpose = 'worker'
   AND lease.status = 'active'
   AND lease.expires_at > $observed_at
  JOIN agent_runtime_instances ri
    ON ri.runtime_instance_id = lease.holder_runtime_instance_id
   AND ri.runtime_instance_id::text = lease.lease_scope_id
   AND ri.agent_id = a.agent_id
 WHERE a.status IN ('idle', 'busy');
```

この query が 0 席を返した場合、probe は 1 件も作成せず、report は typed
`verdict='NO_DATA'` を返して実行を block する。merge 前 live preflight では 1 席以上を
必須とし、0 席を成功として扱ってはならない。

#### probe lifecycle と observation window

- `message_type='probe'`、schema `aun-n1-slo-probe/v1`、content prefix
  `[AUN-N1-SLO-PROBE/v1]:<run_id>:<agent_id>` を必須とする。
- `agent_messages.channel_id` は名前 alias ではなく exact canonical internal
  channel id `pdca-daily` に固定する。INSERT は `channels.id='pdca-daily'` の
  存在と対象 `agent_id` の `channels.members` 所属を同一 transaction 内で
  検証する。row 欠落または non-member は
  `N1_PROBE_CHANNEL_BINDING_NOT_READY` として agent/message queue 両方をロールバックする。
  この channel 束縛は internal attribution のみで、router、adapter、
  `outbound_queue`、provider、Discord の起動根拠にしない。
- probe は対象 seat 自身を `author_id` と `message_queue.agent_id` に置く
  self-issued no-op である。priority は `-1000000` とし、generic `next` や
  inbox cursor、`agents.status` を使わない。
- claim/close は生成直後の exact `(queue_id, message_id, agent_id, prefix)`
  tuple のみを条件にする。claim は `pending → received`、close は
  `received → done`。claim fence は close 時に全て NULL に戻す。
- observation window は各 probe の送信開始から固定 5,000 ms。環境変数や
  CLI 引数で本番値を変更しない。contract test だけが短い窓を dependency
  injection できる。
- window 内に `received` が観測できなければ `failure_type=RETRY_EXHAUSTED`,
  `failure_stage=claim`、claim 後に `done` が観測できなければ同 type の
  `failure_stage=close` として `agent_messages.metadata.n1_slo` に保存する。

成功・失敗を問わず、harness は自分が作成した probe row だけを最後に
`status='done'` へ閉じ、`claimed_by/claimed_at/claim_expires_at` を解除する。
terminal `done` row は計測 evidence として保持し、「残骸ゼロ」は同一 run の
non-terminal probe row が 0 件であることを意味する。業務 message の更新・削除、
agent busy/idle の変更、cursor 前進は禁止する。

#### effect fence と machine report

probe path は `outbound_queue` INSERT、provider/fleet-runtime invocation、Discord
API を一切行わない。各 run は自分の probe message id に対応する
`outbound_queue` row が 0、Discord sent/snowflake が 0、non-terminal probe が
0 であることを readback し、違反時は report publish 前に fail closed する。

machine report schema は `aun-n1-slo-report/v1`。active seat 数、seat 別 RTT、
成功/失敗、typed silent-failure、p50/p95/max、effect fence count、source commit
を含み、`watchout/agent-comms-mcp#602` 以外へは publish しない。publisher は
run id で idempotency を照合し、GitHub の返却 body と raw-body SHA-256 を
readback する。

定期実行は既存 launchd pattern に合わせた
`com.watchout.agent-comms.n1-slo` (`StartInterval=900`) とする。plist は
`DATABASE_URL`、GitHub token、provider/Discord credential を埋め込まない。
DB は明示 `--database-config`、launchd の GitHub credential は明示
`--github-token-file` から runtime に解決する（対話実行は環境または `gh`
credential store も可）。harness 自身は ambient `DATABASE_URL` を読まない。

isolated PostgreSQL fixture は repository migration 適用後に production parity として
`agent_messages.channel_id NOT NULL` を強制する。regression は少なくとも
(1) canonical `pdca-daily` row/member で probe INSERT 成功、(2) raw `channel_id=NULL`
INSERT の拒否、(3) channel row/member 欠落時の typed fail-closed と queue residue 0
を production-equivalent schema 上で検証する。

---

## 18. 精度向上対策

### 18.1 Reply Chain Context

next_message が返すメッセージに reply_to chain を辿った会話文脈を付加。

問題: チャンネル内で複数話題が並行する場合、直近 N 件履歴では無関係メッセージが混入。
解決: reply_to を再帰的に辿り、当該会話の chain のみを返す。

```typescript
interface NextMessageResponse {
  message: AgentMessage;
  reply_chain: ReplyChainEntry[];  // seed-inclusive: seed (current message) と
                                   // reply_to を辿る ancestor を chronological (oldest-first) で並べる、
                                   // 最大 REPLY_CHAIN_DEPTH 件
}

// Issue #257 — light/full shape (default break, route:ceo-approval).
// `next` / `inbox` は default で `preview` のみを返す (default break,
// intentionally adopted; existing callers lose full body unless opt-in)。
// 復旧経路は transport 非対称:
//   MCP  → `next({full: true})` / `inbox({full: true})` (arg only)
//   CLI  → `AGENT_COM_REPLY_CHAIN_MODE=full` (env only)
// 個別 message の full content が必要な場合は `expand_msg(id)` で取得。
interface ReplyChainEntry {
  id: string;                // message UUID
  from: string;              // author_id (run-bot loop detection 互換)
  parent_id: string | null;  // reply_to of this entry; null at chain root (oldest ancestor)
  depth: number;             // distance from seed (current) message: seed = 0,
                             // each reply_to step toward older ancestors increments by 1
  preview: string;           // 先頭 80 char (REPLY_CHAIN_PREVIEW_CHARS)
  content?: string;          // full mode 時のみ存在
  created_at: string;
}

// expand_msg returns the full body of one message; metadata included.
// Error taxonomy: INVALID_ARG / MSG_NOT_FOUND / DB_UNAVAILABLE / EXPAND_MSG_FAILED.
interface ExpandMsgResponse {
  id: string;
  channel_id: string | null;
  from: string;
  content: string;
  reply_to: string | null;
  message_type: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
```

```sql
-- SQL (再帰 CTE、SQLite / PostgreSQL 共通)
WITH RECURSIVE chain(id, channel_id, author_id, content, reply_to, created_at, depth) AS (
  SELECT id, channel_id, author_id, content, reply_to, created_at, 0
  FROM agent_messages WHERE id = $current_message_id
  UNION ALL
  SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to, m.created_at, c.depth + 1
  FROM agent_messages m JOIN chain c ON m.id = c.reply_to
  WHERE c.depth + 1 < $REPLY_CHAIN_DEPTH
)
SELECT * FROM chain ORDER BY created_at ASC;
```

depth counter を CTE 内で管理。循環参照 (reply_to が自身を指す) は depth limit で自動停止。

設定: AGENT_COM_REPLY_CHAIN_DEPTH (default: 5)
reply_to = NULL (会話起点) に到達するか depth 到達で停止。

### 18.2 チャンネルtopic表示

channels.topicカラムを追加済み（§3.5）。
next_message結果 / send結果にtopicを含めることで、LLMがチャンネルの目的を常に把握。

---

## 19. 設定一覧

| 環境変数 | デフォルト | 説明 |
|----------|-----------|------|
| `AGENT_COM_DB` | `sqlite` | DB種別 |
| `DATABASE_URL` | — | PostgreSQL接続文字列 |
| `AGENT_COM_SQLITE_PATH` | `./data/agent-com.db` | SQLiteファイルパス |
| `AGENT_COM_RECEIVER_TOKEN` | — | 専用receiver bot token |
| `DISCORD_TOKEN_{AGENT_ID}` | — | 各botのDiscord token |
| `AGENT_COM_POLL_INTERVAL_MS` | `3000` | polling間隔（§5.3、§13.5参照） |
| `AGENT_COM_HEALTH_PORT` | `9000` | healthcheckポート |
| `AGENT_COM_PRESENCE` | `false` | presence client起動 |
| `AGENT_COM_PG_NOTIFY` | `true` | pg_notify 加速 on/off (false で polling only、SQLite mode 用) |
| `AGENT_COM_REPLY_CHAIN_DEPTH` | `5` | Reply Chain Context の最大遡り深度（§18.1） |
| `AGENT_COM_REPLY_CHAIN_MODE` | `light` | CLI `agent-com next` 用 reply_chain 形 — `full` で legacy 復旧（MCP は `next({full: true})` arg、非対称） |
| `AGENT_COM_BOT_ROUTING_PATH` | — | Explicit legacy seed/test routing file path. Production routing uses `channel_routing_policy`; setting this re-enables JSON compatibility fallback. |
| `AGENT_COM_ENABLE_BOT_ROUTING_FILE_FALLBACK` | `false` | Allows the default `<repo>/config/bot-routing.json` compatibility fallback when no DB policy row exists. |
| `AGENT_COM_ATTACHMENT_TTL_HOURS` | `24` | 添付ファイル保持時間 |
| `AGENT_COM_ATTACHMENT_MAX_SIZE` | `52428800` | 添付1ファイル上限(bytes) |
| `AGENT_COM_ATTACHMENT_DISK_LIMIT_MB` | `1024` | temp領域ディスク上限 |

---

## 20. 廃止される要素

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
❌ Dispatcher 層 — CEO 判断で廃止
❌ AGENT_COM_DAEMON_MODE — 1 mode に統一
❌ AGENT_COM_DISPATCH_ENABLED / DISPATCH_MODEL
❌ agents.dispatch_enabled カラム
❌ embedded mode — daemon 一択
❌ AGENT_COM_RUNTIME — dual mode 廃止に伴い不要
❌ access.json — DB routing で完結
❌ plugin:discord — adapter 統合済み
❌ Push Enrichment (チャンネル履歴) — Reply Chain Context に置換
❌ TRANSPORT_MODE — Phase C I5 で統一 (stdio/daemon/sse/receiver → 単一フロー)
❌ IS_RECEIVER_MODE — Phase C I5 で廃止
❌ Push polling (agent_messages 直接読取 + MCP notification push) — message_queue ベースの next pull モデルに統一
❌ notifications/claude/channel (Claude Code 固有 push) — LLM-agnostic 化
❌ PgMessageBus (pg_notify / LISTEN 依存) — state-daemon (§13.1) に統一 (ADR-050)
❌ SqliteMessageBus (テーブル変更 polling 依存) — state-daemon (§13.1) に統一 (ADR-050)
❌ in-process signal bus 抽象 (PID file + SIGUSR1) — state-daemon (§13.1) に統一 (ADR-050、2026-05-05)
❌ restart-bot.sh の LLM 初期指示 (tmux send-keys 起動 prompt) — state-daemon (§13.5.1 primary) で代替、初期指示送信は不要
```

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-08-21 | §13.7 に COLD_START の explicit MCP env、state-root pinned provider checkout/server path、listener+exact runtime 登録の completed boot proof、legacy completed phase だけに限定した bounded `REALIZE_POSTIMAGE` state machine を追加。 |
| 2026-08-21 | §13.7 に started `VERIFY_LIVE_IDENTITY` の exact preflight 参照と no-replay reconcile fixture を追加。completed COLD_START を effect 前に skip し、live identity のみを再開して canonical receipt に到達する境界を固定。 |
| 2026-08-20 | §17.4 N1 probe の exact canonical `channel_id=pdca-daily` 束縛、channel row/member の transactional validation、typed binding failure、隔離 fixture の production `NOT NULL` parity と3 regression を追加。 |
| 2026-08-20 | §17.4 N1 正準 seat query を実稼働 status 語彙に修正。idle/busy+valid endpoint lease の正準集合、0席時の typed `NO_DATA` block、self-issued no-op probe、5,000 ms 固定窓、typed RETRY_EXHAUSTED、terminal cleanup、zero provider/Discord effect、#602 machine publisher と 900 秒 launchd 契約を固定。 |
| 2026-08-19 | §13.7 に canonical `resume_admission_binding` 消費を追加。immutable URL+raw digest ref、durable request/journal head/admitted fresh observation ID の exact tuple、zero queue、preflight receipt v3、次の drift の fail-closed を規定。 |
| 2026-08-20 | §13.7 に merge-derived postimage basis を追加。`VERIFY_EXTERNAL_MERGE` 未開始時の sealed preimage equality を維持し、started/completed 後だけ immutable journal/external receipt/merged PR/commit tree/live surface を exact 照合して残余 phase を再開する。 |
| 2026-08-19 | §13.7 Fleet Runtime V1 provider resume を追加。durable state を先に read-only load し、reserved は fresh admission、completed は original receipt、collision は live preflight 前 fail-closed と規定。 |
| 2026-05-05 | ADR-050 (UnixSignalBus removal + spec §13.5.1 honesty audit) を反映。§13.1 を「state-daemon (primary delivery mechanism)」に改題、in-process signal bus 抽象 (PID file + SIGUSR1 機構) を削除し state-daemon (`bin/state-daemon.ts`、tmux send-keys) を de jure primary 化。§13.5.1 の primary 記述を state-daemon に整合、fallback を「bot LLM judgement による polling」に変更。§5.3 / §6 / §13.5 / §20 の関連箇所も同期更新。CEO directive (msg `1d03f8bd`「監査通過 governance gap」) 解消。 |
| 2026-04-19 | v2.1.0: §5.3-5.4 run-bot.sh 安定動作要件追加 (end-to-end flow / signal coalescing / graceful shutdown / orphan reclaim / retry+dead-letter / truncate / loop 防止 / consumer 排他 / heartbeat / LLM prompt / subcommand 化 / migration 計画)。§4.1 暗黙 skip 廃止 → fail CLI 明示遷移。§3.2 message_queue に failed_reason + status CHECK 拡張。§4.2 send step 9 を fail/skip 3 分岐に。§8.1 状態遷移表に fail/skip/reclaim 追加。§11 エラーコードに failed_reason 標準値追加。§13.5 polling driver 記述整理。§14 Phase C 完了条件に v2.1.0 テストケース追加。外部 AI 3 round review 反映。 |
| 2026-04-19 | §13.1 / §13.5.1 / §5.3 / §20 更新。in-process signal bus 抽象を統一実装に整理 (後に ADR-050 で削除、本行は当時の暫定状態の歴史記録)。§13.5.1 を「メッセージ配信メカニズム」に改題、primary=signal / secondary=MCP notification / fallback=polling の 3 層構造化。§5.3 に `run-bot.sh` event-driven bot runner 記述追加、§20 に PgMessageBus / SqliteMessageBus / restart-bot.sh LLM 初期指示 廃止追加。docs-only (実装は後続 PR)。 |
| 2026-04-19 | §13.5.1 Pending Message Notification (MCP 標準) 追加。PollingDriver が pending 検出時に `notifications/message/pending` を送信し、LLM client の `next` トリガーとして機能。件数シグナルのみ (本体は依然 `next` pull)、失敗は non-fatal で polling 継続。 |
| 2026-04-18 | Phase C 即時修正: §20 に Push polling / `notifications/claude/channel` 廃止追加。spec §4.1 pull モデル (`next`) 一択に統一、legacy `pollNewMessages` / `startPolling` / `stopPolling` + MCP push dependency を inbound-receiver.ts から除去。 |
| 2026-04-19 | Phase C I6: §15 CLI Setup 書き換え — `init` 対話式セットアップ / `start` / `status` サブコマンド実装。entrypoints/main.ts に auto-detect + subcommand routing 追加。 |
| 2026-04-18 | Phase C I5: §5.3 統一プロセスモデル化、§20 `TRANSPORT_MODE` / `IS_RECEIVER_MODE` 廃止追加。stdio/daemon/sse/receiver の 4 モード → 単一フローに統一。 |
| 2026-04-17 | v2.0.0: OSS primary に組織原理を転換。Dispatcher 廃止 / dual mode 廃止 / SQLite default / 1 daemon 集約 / Reply Chain Context 導入 / LLM-agnostic 化。Phase C 条件を product 視点で再定義 (CEO 承認)。 |
| 2026-04-17 | Task A2.5: §6.5 にプロセス境界図・起動シーケンス・heartbeat writer 責務を追記、§10.4 access.json 廃止後 permission model 追加。外部 AI レビュー指摘（what は書いたが how が未記述）への対応 |
| 2026-04-16 | Task A1 repo sync: gdrive canonical を repo 反映、§20 `AGENT_COM_DAEMON_MODE` default を `embedded` に訂正（gdrive 表記 standalone は daemon 未実装段階で bug、CTO 技術判断）、source-awareness §11.8 との矛盾を解消、SPEC-INDEX 更新同梱 |
| 2026-04-14 | v1.0.3: §6.5 PollingDriver embedded/standalone デュアルモード化（standalone 推奨）、§6.6 確定済み技術制約追加（MCP notification NG + idle wake NG + lazy spawn）、§16 Phase C に daemon 分離・完了条件追加、§21 Phase 8 拡張、§20 `AGENT_COM_DAEMON_MODE` 追加 |
| 2026-04-12 | v1.0.3: §3.2 に `uq_mq_agent_message` 部分 UNIQUE index 追加 + INSERT の正式形式を `ON CONFLICT DO NOTHING` と規定（ADR-048 Phase 0 D4、PR#142 / 対応実装 PR#140） |
| 2026-04-12 | v1.0.2: §6.1-6.5 全CLIをMCP内蔵polling driverに統一、§14.5 スケーラビリティ追加、§4.3/4.5/13.3/18.2/18.3 cron依存を全廃止（全てMCP server/receiver内蔵に統一） |
| 2026-04-10 | v1.0.0: 統合メッセージキュー仕様（旧receiver-architecture + channel-thread-control統合、全22セクション） |
