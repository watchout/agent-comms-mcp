# agent-com Attachment Specification v0.1.0

## 1. Overview

agent-comにおけるファイル添付の送受信仕様。チャットUIの挙動をトレースし、一時ファイルとして扱う。

### 設計原則

- **Ephemeral by default**: 添付は一時ファイル。明示的に保存しない限り自動削除
- **Bidirectional**: inbound（チャット→LLM）とoutbound（LLM→チャット）の双方向対応
- **Platform-agnostic**: core層はプラットフォーム固有仕様を知らない。adapter層が正規化する
- **LLM autonomy**: LLMが添付を参照するかどうかはLLM自身が判断する

---

## 2. Attachment Schema

```typescript
interface Attachment {
  id: string;                     // UUID v4
  filename: string;               // サニタイズ済み（セクション10参照）
  mime_type: string;              // "image/png", "application/pdf" 等
  size_bytes: number;
  temp_path: string;              // /tmp/agent-com/attachments/{message_id}/{filename}
  expires_at: string;             // ISO8601
  direction: "inbound" | "outbound";
}
```

### Message Schema 拡張

```typescript
interface Message {
  // 既存フィールド（省略）
  content: string;
  // 追加
  attachments: Attachment[];      // 空配列 = 添付なし
}
```

`attachments` は常に配列。添付なしの場合は `[]`。

---

## 3. Inbound Flow（チャット → LLM）

```
Discord/Telegram/Slack
  ↓ メッセージ + 添付ファイル
adapter層
  ├─ 添付メタデータ抽出（URL, filename, size, mime_type）
  ├─ バリデーション（セクション8, 9, 10）
  ├─ ファイルダウンロード → /tmp/agent-com/attachments/{message_id}/
  └─ Attachment[] を生成
  ↓
daemon（routeInbound）
  ├─ メッセージ + attachments をルーティング
  └─ HTTP POST → channel-server
  ↓
channel-server
  ├─ Claude Codeにメッセージ + 添付情報を渡す
  └─ 表示例:
      from: arc
      content: "このERD図をレビューして"
      attachments:
        [1] erd.png (image/png, 245KB) → /tmp/agent-com/attachments/msg_abc/erd.png
        [2] schema.sql (text/sql, 12KB) → /tmp/agent-com/attachments/msg_abc/schema.sql
      expires: 2026-04-09T15:00:00Z
```

### LLM側の利用

Claude Codeはローカルファイルを直接読める。添付を参照するかはLLMが判断する。

- 画像: パスを参照して視覚的に確認
- テキスト/CSV/JSON: `cat` や言語固有のパーサーで読み込み
- バイナリ: ファイルの存在とメタデータのみ認識

### 保存

LLMまたはユーザーが明示的に `cp` でローカルコピーする。保存先はLLMの作業ディレクトリまたはユーザー指定パス。agent-comは保存を管理しない。

---

## 4. Outbound Flow（LLM → チャット）

```
Claude Code
  ├─ ファイル生成（コード、画像、ドキュメント等）
  └─ sendツールで送信
  ↓
channel-server
  ├─ ローカルファイルの存在確認
  ├─ バリデーション（セクション8, 9, 10）
  ├─ temp領域にコピー（元ファイルに影響しない）
  └─ メッセージ + attachments を daemon へ
  ↓
daemon
  └─ routeOutbound() → 宛先adapter特定
  ↓
adapter層
  ├─ temp_path からファイル読み込み
  ├─ プラットフォーム固有のアップロードAPI呼び出し
  ├─ プラットフォーム固有のサイズ制限チェック（セクション8）
  └─ 送信完了 or エラーフィードバック
  ↓
Discord/Telegram/Slack（添付付きメッセージとして表示）
```

### sendツール拡張

```typescript
// 現行
send(content: string, mentions: string[], reply_to?: string)

// 拡張
send(
  content: string,
  mentions: string[],
  reply_to?: string,
  attachments?: string[]  // ローカルファイルパスの配列
)
```

使用例:
```
send(
  content: "レビュー結果をまとめました",
  mentions: ["arc"],
  attachments: ["/home/claude/review-report.md", "/home/claude/diagram.png"]
)
```

---

## 5. 複数ファイル

### 仕様

- 1メッセージに複数添付可能（inbound/outbound共通）
- `attachments` 配列の順序は保持される
- 各ファイルは独立してバリデーション・ダウンロード・アップロードされる

### 部分失敗

複数添付のうち一部が失敗した場合:

- **Inbound**: 成功したファイルのみ `attachments` に含める。失敗分はメッセージ本文に注記を追加
  ```
  ⚠ 1/3 attachments failed to download: large-video.mp4 (ATTACHMENT_TOO_LARGE)
  ```
- **Outbound**: 成功したファイルのみ送信。失敗分は送信者にエラーフィードバック
  ```
  message_type: "system_error"
  error_code: ATTACHMENT_UPLOAD_FAILED
  detail: "video.mp4 exceeds Discord's 25MB limit (actual: 42MB)"
  ```

### プラットフォーム別の添付数上限

| Platform | 上限 |
|----------|------|
| Discord  | 10   |
| Telegram | 10（media group） |
| Slack    | 制限なし（実質的） |

上限超過時: adapter層が分割送信する。core層は関知しない。

---

## 6. Bot間転送

botAが受信した添付をbotBに転送するケース。

```
human → botA: "この画像をbotBにレビュー依頼して"
         attachments: [image.png]

botA → botB: "この画像のレビューお願い"
         attachments: ["/tmp/agent-com/attachments/msg_orig/image.png"]
```

### 仕様

- botAはsendツールの `attachments` に受信時のtemp_pathをそのまま指定可能
- channel-serverが送信時にtemp_pathの存在とTTL有効性を確認
- TTL切れの場合: `ATTACHMENT_EXPIRED` エラー

### temp_path参照の一貫性

- 転送時、channel-serverは元ファイルをコピーせず参照する（同一Mac mini上のため）
- 転送先botBのメッセージには新しいmessage_idで新しいtemp_pathが割り当てられる（シンボリックリンク）
- これにより元メッセージのTTLと転送メッセージのTTLが独立する

```
/tmp/agent-com/attachments/msg_orig/image.png    ← 元（24h TTL）
/tmp/agent-com/attachments/msg_fwd/image.png     ← symlink（新規24h TTL）
```

---

## 7. reply_to 元メッセージの添付参照

reply_toでメッセージに返信する場合、元メッセージの添付にアクセスしたいケース。

### 仕様

- 元メッセージの添付メタデータはDBに保存される（セクション11）
- temp_pathが有効な間は直接参照可能
- TTL切れの場合: DBのメタデータのみ残る（ファイル実体は消失）

### 再取得

TTL切れの添付が必要な場合:
- adapter層がsource情報（元プラットフォームURL等）を保持していれば再ダウンロード可能
- 元プラットフォームURL自体が期限切れの場合: `ATTACHMENT_SOURCE_EXPIRED` エラー
- 再取得はベストエフォート。保証しない

---

## 8. サイズ制限

### Inbound（受信）

| 設定 | デフォルト | 環境変数 |
|------|-----------|----------|
| 1ファイル上限 | 50MB | `AGENT_COM_ATTACHMENT_MAX_SIZE` |
| 1メッセージ合計上限 | 100MB | `AGENT_COM_ATTACHMENT_MAX_TOTAL` |

上限超過時: ファイルをダウンロードしない。メッセージ本文にメタデータのみ注記:
```
⚠ Attachment skipped: presentation.pptx (72MB, exceeds 50MB limit)
```

LLMはファイルの存在を知ることができるが、中身にはアクセスできない。

### Outbound（送信）

プラットフォーム固有の制限はadapter層が管理:

| Platform | ファイル上限 | 備考 |
|----------|-------------|------|
| Discord  | 25MB（Nitro: 500MB） | adapter設定で切り替え |
| Telegram | 50MB（Bot API） | 2GBはUser API（Telethon）のみ |
| Slack    | ワークスペース設定依存 | |

上限超過時: アップロードしない。送信者に `ATTACHMENT_TOO_LARGE` エラー。

---

## 9. MIME Type 制限

### ブロックリスト（デフォルト）

```typescript
const BLOCKED_MIME_TYPES = [
  "application/x-executable",
  "application/x-msdos-program",
  "application/x-msdownload",      // .exe
  "application/x-bat",             // .bat
  "application/x-sh",              // .sh（設定で許可可能）
];

const BLOCKED_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".com", ".scr",
  ".msi", ".dll", ".sys",
];
```

### 設定

```env
# ブロックリストを無効化（全MIME許可）
AGENT_COM_ATTACHMENT_ALLOW_ALL=false

# 追加ブロック
AGENT_COM_ATTACHMENT_BLOCK_EXTENSIONS=".jar,.war"

# .sh を許可（開発環境向け）
AGENT_COM_ATTACHMENT_ALLOW_SHELL=true
```

### バリデーション方式

1. 拡張子チェック（BLOCKED_EXTENSIONS）
2. MIME typeチェック（BLOCKED_MIME_TYPES）
3. Magic bytes検証（拡張子偽装防止、オプション）

Magic bytes検証はデフォルト無効。`AGENT_COM_ATTACHMENT_VERIFY_MAGIC=true` で有効化。

---

## 10. ファイル名サニタイズ

### ルール

```typescript
function sanitizeFilename(raw: string): string {
  let name = raw;
  // パストラバーサル防止
  name = path.basename(name);            // ディレクトリ除去
  // 危険文字除去
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  // 先頭ドット除去（隠しファイル防止）
  name = name.replace(/^\.+/, '');
  // 空文字列フォールバック
  if (!name) name = 'unnamed';
  // 長さ制限（255 bytes、UTF-8考慮）
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

同一message_id内でファイル名が衝突した場合:
```
report.pdf → report.pdf
report.pdf → report_2.pdf
report.pdf → report_3.pdf
```

---

## 11. DB保存（メタデータのみ）

ファイル実体はtemp領域。DBには参照情報のみ保存。

```sql
CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  temp_path TEXT,                    -- TTL切れ後はNULL
  source_url TEXT,                   -- 元プラットフォームURL（再取得用）
  uploaded_url TEXT,                 -- outbound時のアップロード先URL
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_msg_attachments_message_id ON message_attachments(message_id);
CREATE INDEX idx_msg_attachments_expires ON message_attachments(expires_at);
```

### TTL切れ時の処理

cleanup処理がファイル削除後、`temp_path` を `NULL` に更新:
```sql
UPDATE message_attachments
SET temp_path = NULL
WHERE expires_at < NOW() AND temp_path IS NOT NULL;
```

メタデータ（ファイル名、サイズ、MIME type）は永続。「このメッセージには添付があった」という事実は記録として残る。

---

## 12. Temp領域管理

### ディレクトリ構造

```
/tmp/agent-com/attachments/
  {message_id}/
    {sanitized_filename}
    {sanitized_filename_2}
```

### TTL設定

```env
# デフォルト24時間
AGENT_COM_ATTACHMENT_TTL_HOURS=24

# temp領域のディスク使用量上限（デフォルト1GB）
AGENT_COM_ATTACHMENT_DISK_LIMIT_MB=1024
```

### Cleanup処理

```typescript
// daemon起動時 + 1時間ごとに実行
async function cleanupAttachments(): Promise<void> {
  // 1. TTL切れファイル削除
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

  // 3. 孤立ディレクトリ削除（DBに対応するレコードがないもの）
  await removeOrphanedDirs();
}
```

---

## 13. エラーコード

既存のエラーフィードバック仕様（channel-thread-control-spec.md）に追加:

| Code | 発生箇所 | 説明 |
|------|----------|------|
| `ATTACHMENT_TOO_LARGE` | inbound/outbound | 1ファイルサイズ上限超過 |
| `ATTACHMENT_TOTAL_TOO_LARGE` | inbound/outbound | 1メッセージ合計サイズ上限超過 |
| `ATTACHMENT_BLOCKED_TYPE` | inbound/outbound | ブロックされたMIME type/拡張子 |
| `ATTACHMENT_DOWNLOAD_FAILED` | inbound | 元プラットフォームからのダウンロード失敗 |
| `ATTACHMENT_UPLOAD_FAILED` | outbound | 宛先プラットフォームへのアップロード失敗 |
| `ATTACHMENT_NOT_FOUND` | outbound | 指定されたローカルファイルが存在しない |
| `ATTACHMENT_EXPIRED` | 転送/参照 | TTL切れのtemp_pathを参照した |
| `ATTACHMENT_SOURCE_EXPIRED` | 再取得 | 元プラットフォームURLも期限切れ |
| `ATTACHMENT_DISK_FULL` | inbound | temp領域のディスク上限到達 |

全エラーでサイレントdrop禁止。送信者にフィードバック（既存方針を踏襲）。

---

## 14. Adapter実装要件

各adapter（Discord, Telegram, Slack等）が実装すべきインターフェース:

```typescript
interface AttachmentAdapter {
  // Inbound: プラットフォーム固有の添付情報を正規化
  extractAttachments(rawMessage: PlatformMessage): AttachmentMeta[];

  // Inbound: ファイルダウンロード
  downloadAttachment(meta: AttachmentMeta, destPath: string): Promise<void>;

  // Outbound: ファイルアップロード
  uploadAttachment(filePath: string, channel: PlatformChannel): Promise<string>; // uploaded URL

  // プラットフォーム固有の制限
  getUploadLimit(): number; // bytes
  getMaxAttachments(): number;
}

interface AttachmentMeta {
  source_url: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
}
```

---

## 15. セキュリティ考慮事項

### パストラバーサル

- `sanitizeFilename()` で防止（セクション10）
- temp_path生成時に必ず `path.join(TEMP_BASE, messageId, sanitizedName)` を使用
- 生成後に `realpath` で `TEMP_BASE` 配下であることを検証

### シンボリックリンク攻撃

- ダウンロード先にシンボリックリンクが既に存在する場合は上書きしない
- `fs.writeFile` に `O_EXCL` フラグを使用

### リソース枯渇

- ディスク上限（`AGENT_COM_ATTACHMENT_DISK_LIMIT_MB`）で防止
- 同時ダウンロード数制限: デフォルト5並列（`AGENT_COM_ATTACHMENT_CONCURRENCY`）
- 1メッセージあたりの添付数制限: デフォルト10（`AGENT_COM_ATTACHMENT_MAX_COUNT`）

### 元プラットフォームURLの扱い

- `source_url` はDB保存するが、外部に公開しない
- 再取得時のみadapter内部で使用

---

## 16. 設定一覧

| 環境変数 | デフォルト | 説明 |
|----------|-----------|------|
| `AGENT_COM_ATTACHMENT_TTL_HOURS` | `24` | 一時ファイルの保持時間 |
| `AGENT_COM_ATTACHMENT_MAX_SIZE` | `52428800`（50MB） | 1ファイル上限（bytes） |
| `AGENT_COM_ATTACHMENT_MAX_TOTAL` | `104857600`（100MB） | 1メッセージ合計上限 |
| `AGENT_COM_ATTACHMENT_MAX_COUNT` | `10` | 1メッセージ添付数上限 |
| `AGENT_COM_ATTACHMENT_DISK_LIMIT_MB` | `1024` | temp領域ディスク上限 |
| `AGENT_COM_ATTACHMENT_CONCURRENCY` | `5` | 同時ダウンロード数 |
| `AGENT_COM_ATTACHMENT_ALLOW_ALL` | `false` | 全MIME type許可 |
| `AGENT_COM_ATTACHMENT_ALLOW_SHELL` | `false` | .sh ファイル許可 |
| `AGENT_COM_ATTACHMENT_BLOCK_EXTENSIONS` | `""` | 追加ブロック拡張子 |
| `AGENT_COM_ATTACHMENT_VERIFY_MAGIC` | `false` | Magic bytes検証 |
| `AGENT_COM_ATTACHMENT_CLEANUP_INTERVAL_MIN` | `60` | Cleanup実行間隔（分） |

全設定はオプション。デフォルト値で安全に動作する。

---

## 17. 実装優先順

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | Attachment schema + Message拡張 | なし |
| 2 | Inbound（Discord adapter） | Phase 1 |
| 3 | Outbound（sendツール拡張 + Discord adapter） | Phase 1 |
| 4 | Cleanup daemon | Phase 2 |
| 5 | 複数ファイル・部分失敗ハンドリング | Phase 2, 3 |
| 6 | Bot間転送（symlink） | Phase 2, 3 |
| 7 | 追加adapter（Telegram, Slack） | Phase 2, 3 |

Phase 1-4がv0.1.0必須。Phase 5-7はv0.2.0以降で可。
