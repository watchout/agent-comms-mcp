# SSOT-3: API Contract - agent-comms-mcp

> v0.2.0 — Issue #257 PR-α light/full reply_chain 契約反映、Phase 5 統合版
> ADR-037: プラットフォーム非依存コア層設計に基づく

---

## MCP Tools

### send

統合メッセージ送信ツール。宛先は `reply_to` (元メッセージの location) で自動決定、Phase 5 では `mention` (1 主 recipient) + `cc[]` (queue 投入なし、body 末尾 `[CC: <@id>]` 注入) で push 対象を指定。legacy `mentions[]` は auto-convert + deprecation warning。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| content | string | ✅ | メッセージ本文（最大 50,000 chars） |
| mention | string | (1) | Phase 5: 1 主 recipient (agent_id)。空文字 → `INVALID_MENTION` reject、unknown → `UNKNOWN_AGENT` reject |
| cc | string[] | - | Phase 5: 参照 recipients (queue 投入なし、body 末尾に `[CC: <@id>]` 注入)。unknown は strip + warning |
| mentions | string[] | (1) | DEPRECATED — Phase 5 auto-convert (`mentions[0]` → mention, rest → cc) + warning。1-2 sprint で removal |
| reply_to | string | ✅ | 元メッセージ UUID（destination 自動決定） |
| message_type | string | - | `instruction` / `report` / `approval` / `chat` / `emergency`（デフォルト: `chat`） |
| metadata | object | - | カスタムメタデータ（JSONB） |

(1) mention / mentions のいずれか必須 (Phase 5 推奨は mention)。

**Phase 5 outbound ACL (Issue #250、§2.4 reject 一本化):**
- `config/bot-routing.json` の `channel.outboundAllowlist` で sender / recipients を gate
- 違反は `OUTBOUND_ACL_VIOLATION` reject (cc[] strip は削除)
- allowlist 不在 channel は legacy compat (全 sender 許可)

**処理フロー:**
1. `reply_to` から元メッセージの channel_id / thread_id / source 取得（in-flight claim 検証）
2. 同一スレッド／チャンネルへの post 経路を確定
3. `mentions[]` で対象 agent に push 通知
4. レート制限・ループ検出・重複排除
5. DBに保存（agent_messages）+ pg_notify 発行
6. 接続中アダプターに配信、未接続なら DB 保存のみ（次回 `next` で取得）

**レスポンス:**
```json
{ "content": [{ "type": "text", "text": "sent (id: <uuid>) to N recipient(s)" }] }
```

### notify

self-originated post（reply_to なし、watchdog / startup / 定期報告用）。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| channel | string | ✅ | チャンネル id (or name) |
| thread_id | string | - | thread に post する場合 |
| content | string | ✅ | 本文 |
| mentions | string[] | ✅ | push 対象 agent_id |
| message_type | string | - | デフォルト `chat` |
| metadata | object | - | JSONB |

### next

未処理メッセージを 1 件 pop し、`message_queue.status` を `pending -> received` に遷移させる唯一の受信 tool。Issue #257 — `reply_chain[]` は default で light shape (preview のみ)、`{full: true}` で legacy 復旧（MCP 専用 arg、非対称）。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| full | boolean | - | `true` で reply_chain[] entries に `content` 含む legacy shape (default: `false` = light preview のみ) |

**Response shape:**
```typescript
{
  waiting: number,
  queue_id: number,
  message_id: string,
  channel_id: string,
  thread_id: string | null,
  from: string,
  content: string,             // current message content (envelope-level、light/full 影響なし)
  message_type: string,
  source: string | null,
  created_at: string,
  reply_chain: ReplyChainEntry[]  // light: preview のみ / full: content + preview
}
```

**ReplyChainEntry:**
```typescript
{
  id: string,
  from: string,                  // run-bot LOOP_DETECTED jq path 互換
  parent_id: string | null,      // null at chain root (oldest ancestor)
  depth: number,                 // seed (current) = 0、ancestors increment
  preview: string,               // 80-char preview
  content?: string,              // full mode 時のみ存在
  created_at: string
}
```

### inbox

履歴/診断用。新規 queue 受信には使わない。`pending` が残っている場合は本文を返さず `NEXT_REQUIRED` を返し、`next` で claim させる。Issue #257 — default で row body 80-char preview + truncation suffix、`{full: true}` で legacy verbatim（MCP 専用 arg）。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| limit | number | - | 取得件数（default: 20） |
| full | boolean | - | `true` で row body 全文 (default: `false` = 80-char preview + `… [truncated, call expand_msg with id={id}]` suffix) |

**Pending guard:**
```json
{
  "error": "NEXT_REQUIRED",
  "pending": 1,
  "message": "Pending queue items are hidden from inbox. Call next to claim one message."
}
```

**Response shape (default light):**
```json
{
  "count": <n>,
  "messages": [
    { "id": "<uuid>", "from": "...", "channel_id": "...", "created_at": "...", "preview": "..." }
  ]
}
```

**Response shape (`full: true`):**
```json
{
  "count": <n>,
  "messages": [
    { "id": "<uuid>", "from": "...", "channel_id": "...", "created_at": "...", "content": "..." }
  ]
}
```

### expand_msg (Issue #257、NEW)

`next` / `inbox` の light shape に対応する opt-in companion。1 件の full body + metadata を取得。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| id | string | - (1 必須) | message UUID（canonical input） |
| message_id | string | - (1 必須) | id の alias、両方平等扱い |

**Response shape:**
```typescript
{
  id: string,
  channel_id: string | null,
  from: string,
  content: string,
  reply_to: string | null,
  message_type: string | null,
  metadata: Record<string, unknown> | null,
  created_at: string
}
```

**Error taxonomy:**
- `INVALID_ARG` — id/message_id 不正（UUID 形式違反 / 空文字）
- `MSG_NOT_FOUND` — UUID 存在しない
- `DB_UNAVAILABLE` — DB 接続失敗
- `EXPAND_MSG_FAILED` — 内部 fetch 失敗

### history

メッセージ履歴取得。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| channel | string | ✅ | チャンネル名 |
| limit | number | - | 取得件数（default: 20、最大: 100） |
| since | string | - | ISO8601 タイムスタンプ以降 |

### agents

エージェント一覧取得。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| status | string | - | `online` / `offline` / `all`（default: `all`） |

### fetch_discord_history

Discord API から直接履歴取得（DB 補完用）。

### Recovery path 非対称（CLI 専用 env）

- **MCP 経路**: `next({full: true})` / `inbox({full: true})` — arg 専用
- **CLI 経路** (`agent-com next`): `AGENT_COM_REPLY_CHAIN_MODE=full` env 専用
- 両 transport は同じ legacy shape を異なる経路で提供（transport 慣例ごとの opt-in、deprecation 表記ではない）

### 運用管理ツール

| ツール | 説明 |
|--------|------|
| bot_status | 登録 Bot 一覧と稼働状態 |
| restart_bot | Bot 再起動 |
| watchdog_check | watchdog 実行 |
| cleanup_ports | orphan ポートクリーンアップ |

### 廃止 tool（v0.2.0、scope 外で参照のみ）

| 旧 tool | 状態 | 備考 |
|--------|------|------|
| reply / send_message | 廃止 → `send` | reply_to を必須化、destination は元 message から自動決定 |
| **legacy inbox tool (廃止)** | `inbox` (新契約) | パラメータ互換。signal-file count&clear は廃止（cursor 永続化 = `agents.inbox_cursor_id` で代替） |
| fetch_messages | 廃止 → `history` | |
| list_agents | 廃止 → `agents` | |
| focus / unfocus | 廃止 (v0.2.0) | active_thread 経由のフィルタは routing v3 (per-row claim) で機能廃止 |

---

## S3-E: 入出力例

### send

**正常系:**

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E1 | `{ content: "報告です", mentions: ["arc"], reply_to: "<uuid-A>" }` | `sent (id: <uuid>) to 1 recipient(s)` | 元メッセージの channel に reply、arc に push |
| E2 | `{ content: "確認お願いします", mentions: ["cto"], reply_to: "<uuid-B>", message_type: "instruction" }` | `sent (id: <uuid>) to 1 recipient(s)` | instruction 送信 |

**異常系:**

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E3 | `{ content: "test", mentions: [], reply_to: "<uuid>" }` | `Error: mentions must not be empty` | 空 mentions reject |
| E4 | `{ content: "test", mentions: ["x"], reply_to: "<unknown-uuid>" }` | `Error [INVALID_REPLY_TO]: no in-flight claim` | 未 claim な reply_to |
| E5 | `{ content: "", mentions: ["x"], reply_to: "<uuid>" }` | `Error: content must not be empty` | 空 content |
| E6 | `{ content: "x".repeat(50001), mentions: ["x"], reply_to: "<uuid>" }` | `Error [CONTENT_TOO_LARGE]: ...` | コア層上限超過 |

### history

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E7 | `{ channel: "dev-arc", limit: 5 }` | メッセージ 5 件 | 正常取得 |
| E8 | `{ channel: "dev-arc", since: "2026-04-06T00:00:00Z" }` | 指定時刻以降 | 日時フィルタ |
| E9 | `{ channel: "nonexistent" }` | 空リスト | 存在しないチャンネル |

### inbox / next / expand_msg

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E10 | `inbox({ limit: 10 })` | `{ count, messages: [{ ..., preview }] }` or `NEXT_REQUIRED` | pending がない場合のみ履歴を返す |
| E11 | `inbox({ full: true })` | `{ count, messages: [{ ..., content }] }` | legacy verbatim |
| E12 | `next({})` | reply_chain[] に preview のみ | default light |
| E13 | `next({ full: true })` | reply_chain[] に content + preview | legacy 復旧 |
| E14 | `expand_msg({ id: "<uuid>" })` | full body + metadata | Issue #257 companion |
| E15 | `expand_msg({ id: "not-uuid" })` | `Error [INVALID_ARG]: ...` | UUID 形式違反 |
| E16 | `expand_msg({ id: "<unknown-uuid>" })` | `Error [MSG_NOT_FOUND]: ...` | 存在しない UUID |

---

## S3-F: 境界値

### send

| # | パラメータ | 境界値 | 期待動作 |
|---|-----------|--------|----------|
| F1 | content | 空文字 `""` | エラー: content must not be empty |
| F2 | content | 1 文字 `"a"` | 正常送信 |
| F3 | content | 2000 文字（Discord 上限） | 正常送信 |
| F4 | content | 2001 文字 | Discord: 分割送信、他プラットフォーム: 正常 |
| F5 | content | 50000 文字（コア層上限） | 正常送信 |
| F6 | content | 50001 文字 | エラー [CONTENT_TOO_LARGE] |
| F7 | mentions | `[]` | エラー: mentions must not be empty |
| F8 | reply_to | 未 claim な UUID | エラー [INVALID_REPLY_TO] |
| F9 | reply_to | 存在しない UUID | エラー [INVALID_REPLY_TO] |
| F10 | depth | 5（max_depth、Issue #257） | 正常送信 |
| F11 | depth | 6 | ブロック: loop detection triggered |

### history

| # | パラメータ | 境界値 | 期待動作 |
|---|-----------|--------|----------|
| F12 | limit | 0 | 空リスト |
| F13 | limit | 1 | 1 件取得 |
| F14 | limit | 100 | 100 件取得（最大値） |
| F15 | limit | 101 | 100 件に切り詰め |
| F16 | since | 未来日時 | 空リスト |

---

## S3-G: 例外応答

| # | 例外 | レスポンス | HTTPステータス相当 |
|---|------|-----------|-------------------|
| G1 | 宛先チャンネル不存在 | `Error: channel '<id>' not found` | 404 |
| G2 | 宛先エージェント不存在 | `Error: agent '<id>' not found` | 404 |
| G3 | アクセス拒否（非メンバー） | `Error: access denied — not a member of channel '<id>'` | 403 |
| G4 | レート制限超過 | `Error: rate limit exceeded (30/min). Remaining: 0` | 429 |
| G5 | ループ検出 | `Error: loop detected between <from> and <to> (depth>5 or 20 exchanges in 5min)` | 429 |
| G6 | 重複メッセージ | `Error: duplicate message detected (within 10s window)` | 409 |
| G7 | バースト制御 | `Error: burst control — minimum 500ms between sends` | 429 |
| G8 | reply_to 未 claim | `Error [INVALID_REPLY_TO]: no in-flight claim for reply_to=<uuid>` | 400 |
| G9 | DB接続障害 | `Error: database connection failed` | 503 |
| G10 | アダプター未接続 | 送信成功（DB 保存のみ、配信は pending） | 202 |

---

## S3-H: Gherkin（MUST要件シナリオ）

### send

```gherkin
Feature: 統合メッセージ送信（send）

  Scenario: チャンネル宛メッセージ送信（reply_to 経由）
    Given チャンネル "dev-arc" にメッセージ "msg-A" がある
    When "cto" が send(content="報告です", mentions=["arc"], reply_to="msg-A") を実行
    Then agent_messages に1件保存される
    And channel_id が "dev-arc" である（reply_to の元メッセージから継承）
    And pg_notify が発行される
    And "arc" に push 通知される

  Scenario: 未 claim な reply_to は reject
    Given "cto" が "msg-X" を `next` で claim していない
    When "cto" が send(content="...", mentions=["x"], reply_to="msg-X") を実行
    Then エラー [INVALID_REPLY_TO] が返される

  Scenario: レート制限超過
    Given "cto" が直近1分間に30件送信済み
    When "cto" が send(content="31件目", mentions=["x"], reply_to="msg-Y") を実行
    Then エラー "rate limit exceeded" が返される
    And メッセージはDBに保存されない
```

### history

```gherkin
Feature: メッセージ履歴取得（history）

  Scenario: チャンネル履歴の正常取得
    Given チャンネル "dev-arc" に10件のメッセージがある
    When history(channel="dev-arc", limit=5) を実行
    Then 最新5件がcreated_at降順で返される

  Scenario: 日時フィルタ
    Given チャンネル "dev-arc" に 04/05 と 04/06 のメッセージがある
    When history(channel="dev-arc", since="2026-04-06T00:00:00Z") を実行
    Then 04/06以降のメッセージのみ返される
```

### inbox / next / expand_msg

```gherkin
Feature: 受信は next のみ、inbox は履歴/診断 — Issue #257 light/full

  Scenario: inbox default light
    Given "cto" 宛に pending queue がない
    And "cto" 宛に1件の row body 200-char メッセージがある
    When "cto" が inbox(limit=10) を実行
    Then 1件のメッセージが返される
    And `messages[0].preview` が 80-char + " … [truncated, call expand_msg with id=<id>]" suffix である
    And `messages[0].content` は undefined である

  Scenario: inbox full opt-in (legacy)
    Given "cto" 宛に pending queue がない
    And "cto" 宛に1件のメッセージがある
    When "cto" が inbox(full=true) を実行
    Then `messages[0].content` に full body が含まれる
    And preview field は undefined である

  Scenario: pending がある場合 inbox は本文を返さない
    Given "cto" 宛に pending queue が1件ある
    When "cto" が inbox(limit=10) を実行
    Then `NEXT_REQUIRED` が返る
    And pending row body は返されない

  Scenario: next reply_chain default light
    Given seed message "m3" の reply_to chain が m1 ← m2 ← m3
    When "cto" が next() を実行
    Then reply_chain[] に 3 entries (m1, m2, m3、oldest-first)
    And 各 entry に preview, parent_id, depth (seed=0, ancestors increment)
    And 各 entry の content は undefined である

  Scenario: expand_msg companion
    Given message "msg-X" が agent_messages に存在
    When `expand_msg(id="msg-X")` を実行
    Then full body + metadata が返される

  Scenario: expand_msg INVALID_ARG
    When `expand_msg(id="not-a-uuid")` を実行
    Then エラー [INVALID_ARG] が返される

  Scenario: expand_msg MSG_NOT_FOUND
    When `expand_msg(id="<unknown-uuid>")` を実行
    Then エラー [MSG_NOT_FOUND] が返される
```

---

## エラーコード体系

| コード | HTTPステータス相当 | 説明 |
|--------|-------------------|------|
| `CHANNEL_NOT_FOUND` | 404 | 指定チャンネルが存在しない |
| `AGENT_NOT_FOUND` | 404 | 指定エージェントが存在しない |
| `THREAD_NOT_FOUND` | 404 | 指定スレッドが存在しない |
| `NOT_A_MEMBER` | 403 | 送信者がチャンネルのメンバーでない |
| `INVALID_REPLY_TO` | 400 | reply_to が未 claim or 存在しない |
| `CONTENT_EMPTY` | 400 | content が空 |
| `CONTENT_TOO_LARGE` | 400 | コア層 50,000 文字超過 |
| `RATE_LIMITED` | 429 | レート制限超過 |
| `LOOP_DETECTED` | 429 | depth > 5 or ペア間 20 往復 / 5 分超 |
| `INVALID_ARG` | 400 | `expand_msg` 入力不正（UUID 形式違反 / 空文字） |
| `MSG_NOT_FOUND` | 404 | `expand_msg` で UUID 存在しない |
| `DB_UNAVAILABLE` | 503 | DB 接続失敗 |
| `EXPAND_MSG_FAILED` | 500 | `expand_msg` 内部 fetch 失敗 |

**エラーレスポンスフォーマット:**
```json
{
  "content": [{ "type": "text", "text": "Error [INVALID_REPLY_TO]: no in-flight claim for reply_to=<uuid>" }],
  "isError": true
}
```

---

## CLI コマンド仕様

`agent-com` CLI はチャンネル・エージェント管理のためのコマンドラインツール。

### channel コマンド

```bash
agent-com channel create <id> --name "表示名" --members cto,dev-a,ceo
agent-com channel add-member <channel_id> <agent_id>
agent-com channel remove-member <channel_id> <agent_id>
agent-com channel members <channel_id>
```

### agent コマンド

```bash
agent-com agent register <agent_id> --display-name "Dev A" --type dev --runtime claude-code
```

### status コマンド

```bash
agent-com status
```

### next コマンド

```bash
agent-com next                                    # default light reply_chain
AGENT_COM_REPLY_CHAIN_MODE=full agent-com next   # legacy full content (env opt-in)
```

---

## 安全機構

| 機構 | 説明 | デフォルト値 |
|------|------|------------|
| レート制限 | 1 分あたりの送信数制限 | 30 件 / 分 |
| ループ検出 | エージェントペア間の往復回数制限 | 20 回 / 5 分 |
| 重複排除 | 同一内容の連続送信防止 | 10 秒ウィンドウ |
| バースト制御 | 連続送信の最小間隔 | 500ms |
| 深度制限 | reply_chain の最大深度 | 5（Issue #257、`AGENT_COM_REPLY_CHAIN_DEPTH`） |

---

## 認証（v0.2.0 で有効化）

- HMAC-SHA256 署名（config.auth.mode: off/warn/enforce）
- v0.1.0: `mode: "off"`（認証なし）
- v0.2.0: api_key 認証を追加（org 単位）
