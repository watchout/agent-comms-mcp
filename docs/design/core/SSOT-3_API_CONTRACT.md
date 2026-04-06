# SSOT-3: API Contract - agent-comms-mcp

> v0.1.0 コア層リファクタ対応版（2026-04-06）
> ADR-037: プラットフォーム非依存コア層設計に基づく

---

## MCP Tools（v0.1.0）

### send

統合メッセージ送信ツール。旧 `reply` + `send_message` を統合。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| to | string | ✅ | 宛先。`channel:dev-arc` / `agent:cto` / `thread:abc123` |
| content | string | ✅ | メッセージ本文 |
| reply_to | string | - | 返信先メッセージID（UUID） |
| thread | boolean | - | 新規スレッド作成フラグ |
| message_type | string | - | `instruction` / `report` / `approval` / `chat`（デフォルト: `chat`） |
| metadata | object | - | カスタムメタデータ（JSONB） |

**宛先プレフィックス:**
- `channel:<channel_id>` — チャンネル宛（メンバー全員に配信）
- `agent:<agent_id>` — エージェント宛（DMチャンネルを自動解決）
- `thread:<thread_id>` — スレッド宛

**処理フロー:**
1. `to` を解決（チャンネル → メンバー、エージェント → DMチャンネル）
2. アクセス制御チェック（channelsテーブルのmembers）
3. レート制限・ループ検出・重複排除
4. DBに保存（agent_messages）
5. pg_notify で通知
6. 各メンバーの接続アダプターに配信
7. アダプター未接続 → DB保存のみ（inbox経由で取得）

**レスポンス:**
```json
{ "content": [{ "type": "text", "text": "sent (id: <uuid>) to channel:dev-arc" }] }
```

### history

メッセージ履歴取得。旧 `fetch_messages` を改名・拡張。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| channel_id | string | ✅ | チャンネルID |
| limit | number | - | 取得件数（デフォルト: 20、最大: 100） |
| before | string | - | このメッセージIDより前を取得 |
| since | string | - | ISO8601タイムスタンプ以降を取得 |

**レスポンス:** フォーマット済みメッセージリスト（author, content, timestamp, message_id）

### inbox

未読メッセージ確認。旧 `check_inbox` を改名。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| limit | number | - | 取得件数（デフォルト: 20） |

**処理フロー:**
1. シグナルファイルのカウント＆クリア
2. DB から新着メッセージ取得
3. フォーマットして返却

### agents

エージェント一覧取得。旧 `list_agents` を改名。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| status | string | - | フィルタ: `online` / `offline` / `all`（デフォルト: `all`） |

**レスポンス:** エージェント一覧（agent_id, display_name, status, last_seen_at）

### fetch_discord_history（v0.1.0では残す、v0.2.0で廃止）

Discord API から直接履歴取得。DB移行完了前の補完用。

| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| channel_id | string | ✅ | DiscordチャンネルID |
| limit | number | - | 取得件数（デフォルト: 20） |

### 運用管理ツール（変更なし）

| ツール | 説明 |
|--------|------|
| bot_status | 登録Bot一覧と稼働状態 |
| restart_bot | Bot再起動 |
| watchdog_check | watchdog実行 |
| cleanup_ports | orphanポートクリーンアップ |

---

## S3-E: 入出力例

### send

**正常系:**

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E1 | `{ to: "channel:dev-arc", content: "報告です" }` | `sent (id: <uuid>) to channel:dev-arc` | チャンネル宛送信 |
| E2 | `{ to: "agent:cto", content: "確認お願いします", reply_to: "abc-123" }` | `sent (id: <uuid>) to agent:cto` | エージェント宛返信 |

**異常系:**

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E3 | `{ to: "channel:nonexistent", content: "test" }` | `Error: channel 'nonexistent' not found` | 存在しないチャンネル |
| E4 | `{ to: "invalid-prefix:foo", content: "test" }` | `Error: invalid destination format. Use channel:/agent:/thread:` | 不正なプレフィックス |
| E5 | `{ to: "channel:dev-arc", content: "" }` | `Error: content must not be empty` | 空のcontent |
| E6 | `{ to: "agent:cto", content: "x".repeat(50001) }` | `Error [CONTENT_TOO_LARGE]: content exceeds core limit (50000 chars)` | コア層文字数超過 |

### history

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E7 | `{ channel_id: "dev-arc", limit: 5 }` | メッセージ5件 | 正常取得 |
| E8 | `{ channel_id: "dev-arc", since: "2026-04-06T00:00:00Z" }` | 指定時刻以降のメッセージ | 日時フィルタ |
| E9 | `{ channel_id: "nonexistent" }` | 空リスト | 存在しないチャンネル（エラーではなく空） |

### inbox

| # | 入力 | 出力 | 説明 |
|---|------|------|------|
| E10 | `{ limit: 10 }` | 新着メッセージ最大10件 | 正常取得 |
| E11 | `{}` | 新着メッセージ最大20件（デフォルト） | パラメータなし |
| E12 | `{ limit: 0 }` | 空リスト | limit=0 |

---

## S3-F: 境界値

### send

| # | パラメータ | 境界値 | 期待動作 |
|---|-----------|--------|----------|
| F1 | content | 空文字 `""` | エラー: content must not be empty |
| F2 | content | 1文字 `"a"` | 正常送信 |
| F3 | content | 2000文字（Discord上限） | 正常送信 |
| F4 | content | 2001文字 | Discord: 分割送信 or エラー、他プラットフォーム: 正常 |
| F5 | content | 50000文字（コア層上限） | 正常送信 |
| F6 | content | 50001文字 | エラー [CONTENT_TOO_LARGE]: コア層上限超過 |
| F7 | to | プレフィックスなし `"cto"` | エラー: invalid destination format |
| F8 | to | `"channel:"` （IDなし） | エラー: channel ID required |
| F9 | reply_to | 存在しないUUID | 正常送信（reply_toは参照のみ、FK制約でエラーの可能性） |
| F10 | depth | 10（max_depth） | 正常送信 |
| F11 | depth | 11 | ブロック: loop detection triggered |

### history

| # | パラメータ | 境界値 | 期待動作 |
|---|-----------|--------|----------|
| F12 | limit | 0 | 空リスト |
| F13 | limit | 1 | 1件取得 |
| F14 | limit | 100 | 100件取得（最大値） |
| F15 | limit | 101 | 100件に切り詰め |
| F16 | since | 未来日時 | 空リスト |

---

## S3-G: 例外応答

| # | 例外 | レスポンス | HTTPステータス相当 |
|---|------|-----------|-------------------|
| G1 | 宛先チャンネル不存在 | `Error: channel '<id>' not found` | 404 |
| G2 | 宛先エージェント不存在 | `Error: agent '<id>' not found` | 404 |
| G3 | アクセス拒否（非メンバー） | `Error: access denied — not a member of channel '<id>'` | 403 |
| G4 | レート制限超過 | `Error: rate limit exceeded (30/min). Remaining: 0` | 429 |
| G5 | ループ検出 | `Error: loop detected between <from> and <to> (20 exchanges in 5min)` | 429 |
| G6 | 重複メッセージ | `Error: duplicate message detected (within 10s window)` | 409 |
| G7 | バースト制御 | `Error: burst control — minimum 500ms between sends` | 429 |
| G8 | 不正な宛先フォーマット | `Error: invalid destination format. Use channel:/agent:/thread:` | 400 |
| G9 | DB接続障害 | `Error: database connection failed` （send_messageはインメモリフォールバック可） | 503 |
| G10 | アダプター未接続 | 送信成功（DB保存のみ、配信はpending） | 202 |

---

## S3-H: Gherkin（MUST要件シナリオ）

### send

```gherkin
Feature: 統合メッセージ送信（send）

  Scenario: チャンネル宛メッセージ送信
    Given チャンネル "dev-arc" が存在し メンバーに "cto" が含まれる
    When "cto" が send(to="channel:dev-arc", content="報告です") を実行
    Then agent_messages に1件保存される
    And channel_id が "dev-arc" である
    And pg_notify が発行される
    And 接続中のアダプターに配信される

  Scenario: エージェント宛メッセージ送信（DM自動解決）
    Given エージェント "arc" が登録されている
    When "cto" が send(to="agent:arc", content="確認依頼") を実行
    Then "dm:arc-cto" DMチャンネルが自動作成される（未存在の場合）
    And agent_messages にchannel_id="dm:arc-cto" で保存される

  Scenario: 旧ツール名（エイリアス）の後方互換
    When "cto" が reply(chat_id="1485598480553611357", text="テスト") を実行
    Then send(to="channel:1485598480553611357", content="テスト") として処理される
    And stderrに非推奨警告が出力される

  Scenario: レート制限超過
    Given "cto" が直近1分間に30件送信済み
    When "cto" が send(to="channel:dev-arc", content="31件目") を実行
    Then エラー "rate limit exceeded" が返される
    And メッセージはDBに保存されない

  Scenario: 存在しないチャンネルへの送信
    Given チャンネル "nonexistent" が存在しない
    When send(to="channel:nonexistent", content="test") を実行
    Then エラー "channel 'nonexistent' not found" が返される
```

### history

```gherkin
Feature: メッセージ履歴取得（history）

  Scenario: チャンネル履歴の正常取得
    Given チャンネル "dev-arc" に10件のメッセージがある
    When history(channel_id="dev-arc", limit=5) を実行
    Then 最新5件がcreated_at降順で返される

  Scenario: 日時フィルタ
    Given チャンネル "dev-arc" に 04/05 と 04/06 のメッセージがある
    When history(channel_id="dev-arc", since="2026-04-06T00:00:00Z") を実行
    Then 04/06以降のメッセージのみ返される
```

### inbox

```gherkin
Feature: 未読メッセージ確認（inbox）

  Scenario: 新着メッセージの取得
    Given "cto" 宛に3件の未読メッセージがある
    When "cto" が inbox(limit=10) を実行
    Then 3件のメッセージが返される
    And シグナルファイルがクリアされる

  Scenario: 未読なし
    Given "cto" 宛の未読メッセージがない
    When "cto" が inbox() を実行
    Then "No new messages" が返される
```

---

## エイリアス（後方互換、v0.2.0で廃止）

| 旧名 | 新名 | 備考 |
|------|------|------|
| reply | send | chat_id → `channel:<chat_id>` に自動変換 |
| send_message | send | to → `agent:<to>` に自動変換 |
| fetch_messages | history | パラメータ互換 |
| check_inbox | inbox | パラメータ互換 |
| list_agents | agents | パラメータ互換 |

旧名で呼ばれた場合、非推奨警告をstderrに出力し、新名にリダイレクト。

---

## エラーコード体系

sendツールおよびコアRouter全体で使用する標準エラーコード。

| コード | HTTPステータス相当 | 説明 | 例 |
|--------|-------------------|------|-----|
| `CHANNEL_NOT_FOUND` | 404 | 指定チャンネルが存在しない | `send(to: "channel:nonexistent")` |
| `AGENT_NOT_FOUND` | 404 | 指定エージェントが存在しない | `send(to: "agent:unknown")` |
| `THREAD_NOT_FOUND` | 404 | 指定スレッドが存在しない | `send(to: "thread:unknown")` |
| `NOT_A_MEMBER` | 403 | 送信者がチャンネルのメンバーでない | membersに含まれないagentが送信 |
| `SELF_SEND` | 400 | 自分自身へのDM送信 | `send(to: "agent:self")` |
| `INVALID_DESTINATION` | 400 | 宛先フォーマットが不正 | プレフィックスなし、空ID等 |
| `CONTENT_EMPTY` | 400 | メッセージ本文が空 | `send(content: "")` |
| `CONTENT_TOO_LARGE` | 400 | コア層の文字数上限超過 | 50,000文字超 |
| `RATE_LIMITED` | 429 | レート制限超過 | 30件/分超 |
| `LOOP_DETECTED` | 429 | ループ検出 | ペア間20往復/5分超 or depth超過 |

**エラーレスポンスフォーマット:**
```json
{
  "content": [{ "type": "text", "text": "Error [NOT_A_MEMBER]: access denied — not a member of channel 'dev-arc'" }],
  "isError": true
}
```

---

## CLIコマンド仕様

`agent-com` CLIはチャンネル・エージェント管理のためのコマンドラインツール。

### channel コマンド

```bash
# チャンネル作成
agent-com channel create <id> --name "表示名" --members cto,dev-a,ceo
  → channels INSERT + audit_log記録

# メンバー追加
agent-com channel add-member <channel_id> <agent_id>
  → channels.members に追加 + audit_log記録

# メンバー削除
agent-com channel remove-member <channel_id> <agent_id>
  → channels.members から削除 + audit_log記録

# メンバー一覧
agent-com channel members <channel_id>
  → channels.members を表示
```

### agent コマンド

```bash
# エージェント登録
agent-com agent register <agent_id> --display-name "Dev A" --type dev --runtime claude-code
  → agents INSERT/UPDATE + audit_log記録
```

### status コマンド

```bash
# 全体状態表示
agent-com status
  → DB接続状態、登録チャンネル数、オンラインエージェント数、最近のメッセージ数を表示
```

---

## 安全機構

| 機構 | 説明 | デフォルト値 |
|------|------|------------|
| レート制限 | 1分あたりの送信数制限 | 30件/分 |
| ループ検出 | エージェントペア間の往復回数制限 | 20回/5分 |
| 重複排除 | 同一内容の連続送信防止 | 10秒ウィンドウ |
| バースト制御 | 連続送信の最小間隔 | 500ms |
| 深度制限 | 会話チェーンの最大深度 | 10 |

---

## 認証（v0.2.0で有効化）

- HMAC-SHA256署名（config.auth.mode: off/warn/enforce）
- v0.1.0: `mode: "off"`（認証なし）
- v0.2.0: api_key認証を追加（org単位）
