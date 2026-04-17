# agent-com Attachment Specification v1.0.0

> **Status:** APPROVED (v1.0.0 で major revision、Phase 4 廃止追随)
> **前提:** message-queue-spec v1.0.3 / source-awareness v1.1.0 と整合
> **v0.1.0 からの主要変更:** channel-server architecture (廃止) → receiver + message_queue + outbound_queue ベースに刷新

## 1. Overview

agent-com におけるファイル添付の送受信仕様。チャット UI の挙動をトレースし、一時ファイルとして扱う。

### 設計原則

- **Ephemeral by default**: 添付は一時ファイル。明示的に保存しない限り自動削除
- **Bidirectional**: inbound（チャット→LLM）と outbound（LLM→チャット）の双方向対応
- **Platform-agnostic**: core 層はプラットフォーム固有仕様を知らない。adapter 層が正規化する
- **LLM autonomy**: LLM が添付を参照するかどうかは LLM 自身が判断する
- **DB 経由配信**: 全ての送受信経路は `agent_messages` + `outbound_queue` 経由（HTTP POST / channel-server 等の経路は v1.0.0 で廃止、message-queue-spec §20 廃止要素と整合）

---

## 2. Attachment Schema

```typescript
interface Attachment {
  id: string;            // UUID v4（DB 保存用）
  filename: string;      // サニタイズ済み（§10 参照）
  mime_type: string;     // "image/png", "application/pdf" 等
  size_bytes: number;
  temp_path: string;     // /tmp/agent-com/attachments/{message_id}/{filename}
  expires_at: string;    // ISO8601
  direction: "inbound" | "outbound";
}
```

### Message Schema 拡張

`agent_messages.attachments` カラム（JSON 配列、message-queue-spec §3.1）が添付メタデータを保持する。

```typescript
interface Message {
  // message-queue-spec §3.1 の既存フィールド
  id: string;                    // TEXT（UUID 文字列）
  channel_id: string;
  author_id: string;
  content: string;
  // ...
  attachments: string;           // JSON 配列（Attachment[] の serialized 形式）
}
```

`attachments` は常に JSON 配列文字列として DB 保存。添付なしの場合は `'[]'`。

---

## 3. Inbound Flow（チャット → LLM）

```
Discord / Telegram / Slack
  ↓ messageCreate（Gateway 受信）
receiver プロセス（1 個、message-queue-spec §6）
  ├─ adapter.extractAttachments(rawMessage) → AttachmentMeta[]
  ├─ バリデーション（§8 サイズ / §9 MIME / §10 ファイル名）
  ├─ adapter.downloadAttachment() → /tmp/agent-com/attachments/{message_id}/
  ├─ discordToUnified() → UnifiedMessage（attachments 含む）
  ├─ routeInbound(unified, channel, agents) → pushTargets[]
  ├─ agent_messages INSERT（attachments JSON 配列含む）
  ├─ message_attachments INSERT（メタデータ、§11）
  ├─ message_queue INSERT（pushTargets 分）
  └─ pg_notify / signal（新着シグナル）
  ↓
daemon プロセス（1 プロセス集約、message-queue-spec §5.3）
  ├─ PollingDriver が message_queue から取得
  ├─ attachments メタをバッファに保持
  └─ next_message MCP tool 呼出時に返却
  ↓
Claude Code / Codex CLI / Gemini CLI
  └─ ローカルファイル（temp_path）を直接参照
```

### next_message 返却値の拡張

message-queue-spec §4.1 の `next_message` 返却 JSON に `attachments` フィールド追加:

```json
{
  "from": "arc",
  "channel": "#agent-mem",
  "content": "このERD図をレビューして",
  "attachments": [
    {
      "filename": "erd.png",
      "mime_type": "image/png",
      "size_bytes": 245760,
      "temp_path": "/tmp/agent-com/attachments/msg_abc/erd.png",
      "expires_at": "2026-04-09T15:00:00Z"
    },
    {
      "filename": "schema.sql",
      "mime_type": "text/plain",
      "size_bytes": 12288,
      "temp_path": "/tmp/agent-com/attachments/msg_abc/schema.sql",
      "expires_at": "2026-04-09T15:00:00Z"
    }
  ],
  "waiting": 12
}
```

### LLM 側の利用

Claude Code 等はローカルファイルを直接読める。添付を参照するかは LLM が判断する。

- 画像: パスを参照して視覚的に確認
- テキスト/CSV/JSON: `cat` や言語固有のパーサーで読み込み
- バイナリ: ファイルの存在とメタデータのみ認識

### 保存

LLM またはユーザーが明示的に `cp` でローカルコピーする。保存先は LLM の作業ディレクトリまたはユーザー指定パス。agent-com は保存を管理しない。

---

## 4. Outbound Flow（LLM → チャット）

```
Claude Code / Codex CLI / Gemini CLI
  ├─ ファイル生成（コード、画像、ドキュメント等）
  └─ agent-com send（MCP tool or CLI）呼出
  ↓
MCP server tool handler → agent-com CLI（send サブコマンド）
  ├─ currentMessage ベースで reply_to / channel 自動決定（message-queue-spec §4.2）
  ├─ ローカルファイルの存在確認（attachments パラメータ）
  ├─ バリデーション（§8 サイズ / §9 MIME / §10 ファイル名）
  ├─ temp 領域にコピー（元ファイル非破壊）:
  │    /tmp/agent-com/attachments/{new_message_id}/{sanitized_filename}
  ├─ agent_messages INSERT（attachments JSON 配列含む）
  ├─ message_attachments INSERT（メタデータ、§11）
  ├─ message_queue INSERT（mentions 分）
  └─ outbound_queue INSERT（agent_id / channel_external_id / content / attachments 参照）
  ↓
outbound consumer（1 daemon プロセス内、message-queue-spec §6.4）
  ├─ 1秒 polling + atomic claim（FOR UPDATE SKIP LOCKED）
  ├─ adapter.uploadAttachment(temp_path, platform_channel) → uploaded_url
  ├─ プラットフォーム API 呼出（Discord REST / Telegram Bot API / Slack API）
  ├─ 成功時: discord_message_id 保存、outbound_queue.status='sent'
  └─ 失敗時: attempts++ / last_error 記録 / retry（最大 5 回）
  ↓
Discord / Telegram / Slack（添付付きメッセージとして表示）
```

### send ツール拡張

```typescript
// message-queue-spec §4.2 の send に attachments パラメータ追加
agent-com send \
  --agent-id cto \
  --mentions arc \
  --content "レビュー結果をまとめました" \
  --attachments "/home/claude/review-report.md,/home/claude/diagram.png"
```

MCP / CLI 経由（message-queue-spec §4/§5）:

```typescript
server.tool("send", {
  params: {
    mentions: { type: "array", required: true },
    content: { type: "string", required: true },
    attachments: { type: "array", items: { type: "string" }, optional: true },
  },
}, async (params) => {
  const args = [
    `--agent-id`, agentId,
    `--mentions`, params.mentions.join(","),
    `--content`, JSON.stringify(params.content),
  ];
  if (params.attachments) args.push(`--attachments`, params.attachments.join(","));
  const result = execSync(`agent-com send ${args.join(" ")}`);
  return JSON.parse(result.toString());
});
```

---

## 5. 複数ファイル

### 仕様

- 1 メッセージに複数添付可能（inbound/outbound 共通）
- `attachments` 配列の順序は保持される
- 各ファイルは独立してバリデーション・ダウンロード・アップロードされる

### 部分失敗

複数添付のうち一部が失敗した場合:

- **Inbound**: 成功したファイルのみ `attachments` に含める。失敗分はメッセージ本文に注記を追加

```
⚠ 1/3 attachments failed to download: large-video.mp4 (ATTACHMENT_TOO_LARGE)
```

- **Outbound**: 成功したファイルのみ送信。失敗分は送信者にエラーフィードバック（message-queue-spec §8 送信者フィードバック経由）

```
message_type: "system_error"
error_code: ATTACHMENT_UPLOAD_FAILED
detail: "video.mp4 exceeds Discord's 25MB limit (actual: 42MB)"
```

### プラットフォーム別の添付数上限

| Platform | 上限 |
|----------|------|
| Discord | 10 |
| Telegram | 10（media group） |
| Slack | 制限なし（実質的） |

上限超過時: adapter 層が分割送信する。core 層は関知しない。

---

## 6. Bot 間転送

bot A が受信した添付を bot B に転送するケース。

```
human → botA: "この画像をbotBにレビュー依頼して"
  attachments: [image.png]

botA → botB: "この画像のレビューお願い"
  attachments: ["/tmp/agent-com/attachments/msg_orig/image.png"]
```

### 仕様

- bot A は send コマンドの `attachments` に受信時の `temp_path` をそのまま指定可能
- **outbound consumer**（§4 flow）が送信時に temp_path の存在と TTL 有効性を確認
- TTL 切れの場合: `ATTACHMENT_EXPIRED` エラー（§13）→ 送信者の message_queue に system_error 投入（message-queue-spec §8.2 feedback）

### temp_path 参照の一貫性

- 転送時、outbound consumer は元ファイルをコピーせず参照する（同一 Mac mini 上のため）
- 転送先 bot B のメッセージには新しい `message_id` で新しい `temp_path` が割り当てられる（シンボリックリンク）
- これにより元メッセージの TTL と転送メッセージの TTL が独立する

```
/tmp/agent-com/attachments/msg_orig/image.png  ← 元（24h TTL）
/tmp/agent-com/attachments/msg_fwd/image.png   ← symlink（新規 24h TTL）
```

---

## 7. reply_to 元メッセージの添付参照

reply_to でメッセージに返信する場合、元メッセージの添付にアクセスしたいケース。

### 仕様

- 元メッセージの添付メタデータは DB に保存される（§11）
- `temp_path` が有効な間は直接参照可能
- TTL 切れの場合: DB のメタデータのみ残る（ファイル実体は消失）

### 再取得

TTL 切れの添付が必要な場合:

- adapter 層が `source_url`（元プラットフォーム URL）を保持していれば再ダウンロード可能
- 元プラットフォーム URL 自体が期限切れの場合: `ATTACHMENT_SOURCE_EXPIRED` エラー
- 再取得はベストエフォート。保証しない

---

## 8. サイズ制限

### Inbound（受信）

| 設定 | デフォルト | 環境変数 |
|------|-----------|----------|
| 1 ファイル上限 | 50MB | `AGENT_COM_ATTACHMENT_MAX_SIZE` |
| 1 メッセージ合計上限 | 100MB | `AGENT_COM_ATTACHMENT_MAX_TOTAL` |

上限超過時: ファイルをダウンロードしない。メッセージ本文にメタデータのみ注記:

```
⚠ Attachment skipped: presentation.pptx (72MB, exceeds 50MB limit)
```

LLM はファイルの存在を知ることができるが、中身にはアクセスできない。

### Outbound（送信）

プラットフォーム固有の制限は adapter 層が管理:

| Platform | ファイル上限 | 備考 |
|----------|-------------|------|
| Discord | 25MB（Nitro: 500MB） | adapter 設定で切替 |
| Telegram | 50MB（Bot API） | 2GB は User API（Telethon）のみ |
| Slack | ワークスペース設定依存 | |

上限超過時: アップロードしない。送信者に `ATTACHMENT_TOO_LARGE` エラー。

---

## 9. MIME Type 制限

### ブロックリスト（デフォルト）

```typescript
const BLOCKED_MIME_TYPES = [
  "application/x-executable",
  "application/x-msdos-program",
  "application/x-msdownload",  // .exe
  "application/x-bat",          // .bat
  "application/x-sh",           // .sh（設定で許可可能）
];

const BLOCKED_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".com", ".scr",
  ".msi", ".dll", ".sys",
];
```

### 設定

```env
# ブロックリストを無効化（全 MIME 許可）
AGENT_COM_ATTACHMENT_ALLOW_ALL=false

# 追加ブロック
AGENT_COM_ATTACHMENT_BLOCK_EXTENSIONS=".jar,.war"

# .sh を許可（開発環境向け）
AGENT_COM_ATTACHMENT_ALLOW_SHELL=true
```

### バリデーション方式

1. 拡張子チェック（`BLOCKED_EXTENSIONS`）
2. MIME type チェック（`BLOCKED_MIME_TYPES`）
3. Magic bytes 検証（拡張子偽装防止、オプション）

Magic bytes 検証はデフォルト無効。`AGENT_COM_ATTACHMENT_VERIFY_MAGIC=true` で有効化。

---

## 10. ファイル名サニタイズ

### ルール

```typescript
function sanitizeFilename(raw: string): string {
  let name = raw;
  // パストラバーサル防止
  name = path.basename(name);  // ディレクトリ除去
  // 危険文字除去
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // 先頭ドット除去（隠しファイル防止）
  name = name.replace(/^\.+/, '');
  // 空文字列フォールバック
  if (!name) name = 'unnamed';
  // 長さ制限（255 bytes、UTF-8 考慮）
  if (Buffer.byteLength(name, 'utf8') > 255) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    // 拡張子を維持しつつ切り詰め
    name = base.slice(0, 200) + ext;
  }
  return name;
}
```

### 衝突回避

同一 `message_id` 内でファイル名が衝突した場合:

```
report.pdf → report.pdf
report.pdf → report_2.pdf
report.pdf → report_3.pdf
```

---

## 11. DB 保存（メタデータのみ）

ファイル実体は temp 領域。DB には参照情報のみ保存。

```sql
CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,                                    -- UUID 文字列（アプリ側生成）
  message_id TEXT NOT NULL REFERENCES agent_messages(id)
    ON DELETE CASCADE,                                    -- message-queue-spec §3.1 と整合
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  temp_path TEXT,                                         -- TTL 切れ後は NULL
  source_url TEXT,                                        -- 元プラットフォーム URL（再取得用）
  uploaded_url TEXT,                                      -- outbound 時のアップロード先 URL
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_msg_attachments_message_id
  ON message_attachments(message_id);
CREATE INDEX idx_msg_attachments_expires
  ON message_attachments(expires_at);
```

### agent_messages への参照整合性

> **実装注記**: 現行 db/migrate.ts は UUID/JSONB (v0 schema)。本 spec は target state。migration は daemon 分離 Phase で実施予定。

- `message_attachments.message_id` は `agent_messages.id`（TEXT、UUID 文字列）を参照
- v1.0.3 §3.1 agent_messages の primary key は TEXT なので FK 型を一致させる
- `ON DELETE CASCADE` で agent_messages 削除時に attachments メタも消える

### TTL 切れ時の処理

cleanup 処理がファイル削除後、`temp_path` を `NULL` に更新:

```sql
UPDATE message_attachments
SET temp_path = NULL
WHERE expires_at < NOW() AND temp_path IS NOT NULL;
```

メタデータ（ファイル名、サイズ、MIME type）は永続。「このメッセージには添付があった」という事実は記録として残る。

---

## 12. Temp 領域管理

### ディレクトリ構造

```
/tmp/agent-com/attachments/
  {message_id}/
    {sanitized_filename}
    {sanitized_filename_2}
```

### TTL 設定

```env
# デフォルト 24 時間
AGENT_COM_ATTACHMENT_TTL_HOURS=24

# temp 領域のディスク使用量上限（デフォルト 1GB）
AGENT_COM_ATTACHMENT_DISK_LIMIT_MB=1024
```

### Cleanup 処理

cleanup は **receiver プロセス責務**（message-queue-spec §6 heartbeat 監視と同じく setInterval で自動実行）。外部 cron 不要。

```typescript
// receiver プロセス内 setInterval（60分ごと、AGENT_COM_ATTACHMENT_CLEANUP_INTERVAL_MIN）
setInterval(async () => {
  // 1. TTL 切れファイル削除
  const expired = await db.query(
    `SELECT id, temp_path FROM message_attachments
     WHERE expires_at < NOW() AND temp_path IS NOT NULL`
  );
  for (const row of expired) {
    await fs.rm(path.dirname(row.temp_path), { recursive: true, force: true });
    await db.query(
      `UPDATE message_attachments SET temp_path = NULL WHERE id = $1`,
      [row.id]
    );
  }

  // 2. ディスク上限チェック（超過時は古い順に削除）
  const totalSize = await calculateTempDirSize();
  if (totalSize > DISK_LIMIT) {
    await evictOldestUntilUnderLimit();
  }

  // 3. 孤立ディレクトリ削除（DB に対応するレコードがないもの）
  await removeOrphanedDirs();
}, CLEANUP_INTERVAL_MS);
```

daemon 1 プロセスに集約されたため、cleanup は receiver 内で実行。

---

## 13. エラーコード

message-queue-spec §11 エラーコード一覧に追加:

| Code | 発生箇所 | 説明 |
|------|----------|------|
| `ATTACHMENT_TOO_LARGE` | inbound/outbound | 1 ファイルサイズ上限超過 |
| `ATTACHMENT_TOTAL_TOO_LARGE` | inbound/outbound | 1 メッセージ合計サイズ上限超過 |
| `ATTACHMENT_BLOCKED_TYPE` | inbound/outbound | ブロックされた MIME type/拡張子 |
| `ATTACHMENT_DOWNLOAD_FAILED` | inbound | 元プラットフォームからのダウンロード失敗 |
| `ATTACHMENT_UPLOAD_FAILED` | outbound | 宛先プラットフォームへのアップロード失敗 |
| `ATTACHMENT_NOT_FOUND` | outbound | 指定されたローカルファイルが存在しない |
| `ATTACHMENT_EXPIRED` | 転送/参照 | TTL 切れの temp_path を参照した |
| `ATTACHMENT_SOURCE_EXPIRED` | 再取得 | 元プラットフォーム URL も期限切れ |
| `ATTACHMENT_DISK_FULL` | inbound | temp 領域のディスク上限到達 |

全エラーで送信者フィードバック（message-queue-spec §8.2 経由）。サイレント drop 禁止。

---

## 14. Adapter 実装要件

各 adapter（Discord, Telegram, Slack 等）が実装すべきインターフェース:

```typescript
interface AttachmentAdapter {
  // Inbound: プラットフォーム固有の添付情報を正規化
  extractAttachments(rawMessage: PlatformMessage): AttachmentMeta[];

  // Inbound: ファイルダウンロード
  downloadAttachment(meta: AttachmentMeta, destPath: string): Promise<void>;

  // Outbound: ファイルアップロード
  uploadAttachment(filePath: string, channel: PlatformChannel): Promise<string>;  // uploaded URL

  // プラットフォーム固有の制限
  getUploadLimit(): number;  // bytes
  getMaxAttachments(): number;
}

interface AttachmentMeta {
  source_url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}
```

`AttachmentAdapter` は message-queue-spec §7 `PlatformAdapter` の subset として実装される想定（同一 adapter オブジェクトが両 interface を実装）。

---

## 15. セキュリティ考慮事項

### パストラバーサル

- `sanitizeFilename()` で防止（§10）
- temp_path 生成時に必ず `path.join(TEMP_BASE, messageId, sanitizedName)` を使用
- 生成後に `realpath` で `TEMP_BASE` 配下であることを検証

### シンボリックリンク攻撃

- ダウンロード先にシンボリックリンクが既に存在する場合は上書きしない
- `fs.writeFile` に `O_EXCL` フラグを使用

### リソース枯渇

- ディスク上限（`AGENT_COM_ATTACHMENT_DISK_LIMIT_MB`）で防止
- 同時ダウンロード数制限: デフォルト 5 並列（`AGENT_COM_ATTACHMENT_CONCURRENCY`）
- 1 メッセージあたりの添付数制限: デフォルト 10（`AGENT_COM_ATTACHMENT_MAX_COUNT`）

### 元プラットフォーム URL の扱い

- `source_url` は DB 保存するが、外部に公開しない
- 再取得時のみ adapter 内部で使用

---

## 16. 設定一覧

| 環境変数 | デフォルト | 説明 |
|----------|-----------|------|
| `AGENT_COM_ATTACHMENT_TTL_HOURS` | `24` | 一時ファイルの保持時間 |
| `AGENT_COM_ATTACHMENT_MAX_SIZE` | `52428800`（50MB） | 1 ファイル上限（bytes） |
| `AGENT_COM_ATTACHMENT_MAX_TOTAL` | `104857600`（100MB） | 1 メッセージ合計上限 |
| `AGENT_COM_ATTACHMENT_MAX_COUNT` | `10` | 1 メッセージ添付数上限 |
| `AGENT_COM_ATTACHMENT_DISK_LIMIT_MB` | `1024` | temp 領域ディスク上限 |
| `AGENT_COM_ATTACHMENT_CONCURRENCY` | `5` | 同時ダウンロード数 |
| `AGENT_COM_ATTACHMENT_ALLOW_ALL` | `false` | 全 MIME type 許可 |
| `AGENT_COM_ATTACHMENT_ALLOW_SHELL` | `false` | `.sh` ファイル許可 |
| `AGENT_COM_ATTACHMENT_BLOCK_EXTENSIONS` | `""` | 追加ブロック拡張子 |
| `AGENT_COM_ATTACHMENT_VERIFY_MAGIC` | `false` | Magic bytes 検証 |
| `AGENT_COM_ATTACHMENT_CLEANUP_INTERVAL_MIN` | `60` | Cleanup 実行間隔（分） |

全設定はオプション。デフォルト値で安全に動作する。

---

## 17. 実装優先順

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | `message_attachments` テーブル + `agent_messages.attachments` カラム利用開始 | なし |
| 2 | Inbound（receiver 内 Discord adapter + downloadAttachment） | Phase 1 |
| 3 | Outbound（agent-com send `--attachments` + Discord adapter uploadAttachment） | Phase 1 |
| 4 | Cleanup（receiver 内 setInterval） | Phase 2 |
| 5 | 複数ファイル・部分失敗ハンドリング | Phase 2, 3 |
| 6 | Bot 間転送（symlink + TTL 独立） | Phase 2, 3 |
| 7 | 追加 adapter（Telegram, Slack） | Phase 2, 3 |

Phase 1-4 が v1.0.0 必須。Phase 5-7 は v1.1.0 以降で可。

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-04-16 | v1.0.0: architecture を receiver + message_queue + outbound_queue ベースに刷新（Phase 4 PR #130 で廃止された channel-server 前提の v0.1.0 から major update）。§3 Inbound / §4 Outbound / §6 Bot 間転送 / §11 DB schema / §12 Cleanup を書き直し、message-queue-spec v1.0.3 + source-awareness v1.1.0 との整合を pin。§11 FK 型を TEXT に修正（agent_messages.id 型と一致）。§13 エラーコード参照先を message-queue-spec §12 に変更。 |
| 2026-04-07 | v0.1.0: 初版（channel-server architecture 前提、Phase 4 前） |
