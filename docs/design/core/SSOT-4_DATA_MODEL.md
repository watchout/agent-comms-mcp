# SSOT-4: Data Model - agent-comms-mcp

> v0.1.0 コア層リファクタ対応版（2026-04-06）
> ADR-037: プラットフォーム非依存コア層設計に基づく

---

## Tables

### agent_messages（既存、v0.1.0でカラム追加）

メッセージの永続化。全プラットフォームのメッセージを統一フォーマットで保存。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | UUID PK | メッセージID |
| channel_id | TEXT | チャンネルID（コア層のチャンネル概念） |
| author_id | TEXT NOT NULL | 送信者agent_id |
| author_bot | BOOLEAN | Bot判定（将来的にroleで代替） |
| content | TEXT NOT NULL | メッセージ本文 |
| message_type | TEXT | `chat` / `instruction` / `report` / `approval` |
| reply_to | UUID FK | 返信先メッセージID |
| attachments | JSONB | 添付ファイル |
| metadata | JSONB | カスタムメタデータ |
| depth | INTEGER | ループ検出用深度 |
| source | TEXT | `agent-comms` / `discord` / `slack` / `telegram` / `line` |
| thread_id | TEXT | スレッドID（v0.1.0: threads.id FK） |
| sequence | INTEGER | チャンネル内メッセージ順序番号（v0.1.0追加、単調増加） |
| direction | TEXT | `inbound` / `outbound` |
| role | TEXT | `agent` / `user` / `system` |
| session_id | TEXT | セッションID |
| project | TEXT | プロジェクト名 |
| created_at | TIMESTAMPTZ | 作成日時 |

**v0.1.0追加カラム:**
- `thread_id` — threadsテーブルへの参照（スレッド内メッセージの紐付け）
- `sequence` — channel_id単位で単調増加する順序番号。メッセージの順序保証に使用

**インデックス:**
- `idx_agent_messages_channel` (channel_id, created_at)
- `idx_agent_messages_author` (author_id, created_at)
- `idx_agent_messages_type` (message_type, created_at)
- `idx_agent_messages_source` (source, created_at DESC)
- `idx_agent_messages_session` (session_id, created_at DESC) WHERE session_id IS NOT NULL
- `idx_agent_messages_project` (project) WHERE project IS NOT NULL
- `idx_agent_messages_thread` (thread_id, sequence) WHERE thread_id IS NOT NULL
- `idx_agent_messages_sequence` (channel_id, sequence DESC)

### channels（v0.1.0 新規）

コア層のチャンネル定義。DMも特殊なチャンネルとして扱う（案A: Slackモデル）。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | TEXT PK | チャンネルID（`dev-arc`, `dm:ceo-cto` 等） |
| org_id | TEXT NOT NULL | 組織ID（v0.1.0は`default`固定） |
| type | TEXT NOT NULL | `channel` / `dm` / `group_dm` |
| name | TEXT | 表示名（DMはnull可） |
| members | TEXT[] | メンバーのagent_id配列 |
| created_by | TEXT | 作成者agent_id |
| created_at | TIMESTAMPTZ | 作成日時 |
| updated_at | TIMESTAMPTZ | 更新日時 |

**インデックス:**
- `idx_channels_org` (org_id)
- `idx_channels_type` (type)
- `idx_channels_members` USING GIN (members)

### channel_adapters（v0.1.0 新規）

コアチャンネルとプラットフォーム固有チャンネルのマッピング。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | UUID PK | レコードID |
| channel_id | TEXT FK → channels.id | コアチャンネルID |
| platform | TEXT NOT NULL | `discord` / `slack` / `telegram` / `line` |
| external_id | TEXT NOT NULL | プラットフォーム側のチャンネルID |
| metadata | JSONB | プラットフォーム固有設定 |
| created_at | TIMESTAMPTZ | 作成日時 |

**制約:**
- `UNIQUE(channel_id, platform)` — 1チャンネル1プラットフォームにつき1マッピング

**設計ポイント:**
- 1つのコアチャンネルに複数プラットフォームをマッピング可能（Discord + Slack同時配信）
- DMは `type="dm"`, members=2人で自動生成
- org_idはv0.1.0では`default`固定（マルチテナントはv0.2.0）

### threads（v0.1.0 新規）

スレッド管理。チャンネルに紐づくスレッド。スレッドは親チャンネルの権限を継承する。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | TEXT PK | スレッドID |
| channel_id | TEXT FK → channels.id NOT NULL | 親チャンネルID |
| title | TEXT | スレッドタイトル |
| status | TEXT NOT NULL DEFAULT 'open' | `open` / `closed` / `archived` |
| created_by | TEXT | 作成者agent_id |
| created_at | TIMESTAMPTZ DEFAULT NOW() | 作成日時 |
| updated_at | TIMESTAMPTZ DEFAULT NOW() | 更新日時 |

**インデックス:**
- `idx_threads_channel` (channel_id, status)
- `idx_threads_status` (status)

**設計ポイント:**
- スレッドのアクセス制御は親チャンネルのmembersを継承（スレッド独自のmembersは持たない）
- `send(to: "thread:<id>")` で送信時、threads.channel_id経由でmembersを検証

### thread_adapters（v0.1.0 新規）

コアスレッドとプラットフォーム固有スレッドのマッピング。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | UUID PK DEFAULT gen_random_uuid() | レコードID |
| thread_id | TEXT FK → threads.id NOT NULL | コアスレッドID |
| platform | TEXT NOT NULL | `discord` / `slack` / `telegram` / `line` |
| external_id | TEXT NOT NULL | プラットフォーム側のスレッドID |
| metadata | JSONB | プラットフォーム固有設定 |
| created_at | TIMESTAMPTZ DEFAULT NOW() | 作成日時 |

**制約:**
- `UNIQUE(thread_id, platform)` — 1スレッド1プラットフォームにつき1マッピング

### audit_log（v0.1.0 新規）

コア層の監査ログ。セキュリティ・コンプライアンス・デバッグ用の操作記録。

| カラム | 型 | 説明 |
|--------|-----|------|
| id | UUID PK DEFAULT gen_random_uuid() | レコードID |
| event_type | TEXT NOT NULL | イベント種別（下記参照） |
| agent_id | TEXT | 操作を行ったエージェントID |
| target | TEXT | 操作対象（チャンネルID、エージェントID等） |
| detail | JSONB | イベント詳細 |
| org_id | TEXT NOT NULL DEFAULT 'default' | 組織ID |
| created_at | TIMESTAMPTZ DEFAULT NOW() | 発生日時 |

**event_type 一覧（5カテゴリ）:**

| カテゴリ | event_type | 説明 |
|---------|------------|------|
| メッセージ | `message.send` | メッセージ送信 |
| メッセージ | `message.blocked` | 送信拒否（レート制限、ループ、アクセス拒否等） |
| チャンネル | `channel.create` | チャンネル作成 |
| チャンネル | `channel.member_add` | メンバー追加 |
| チャンネル | `channel.member_remove` | メンバー削除 |
| エージェント | `agent.register` | エージェント登録 |
| エージェント | `agent.online` | エージェントオンライン |
| エージェント | `agent.offline` | エージェントオフライン |
| セキュリティ | `access.denied` | アクセス拒否 |
| セキュリティ | `auth.failure` | 認証失敗（v0.2.0） |

**インデックス:**
- `idx_audit_log_event` (event_type, created_at DESC)
- `idx_audit_log_agent` (agent_id, created_at DESC)
- `idx_audit_log_org` (org_id, created_at DESC)

### agents（既存、v0.1.0でorg_id追加）

エージェント登録・ハートビート。

| カラム | 型 | 説明 |
|--------|-----|------|
| agent_id | TEXT PK | エージェントID |
| org_id | TEXT NOT NULL DEFAULT 'default' | 組織ID（v0.1.0は`default`固定） |
| display_name | TEXT NOT NULL | 表示名 |
| agent_type | TEXT NOT NULL | エージェント種別 |
| runtime | TEXT NOT NULL | ランタイム情報 |
| status | TEXT | `online` / `offline` |
| last_seen_at | TIMESTAMPTZ | 最終アクティブ日時 |
| registered_at | TIMESTAMPTZ | 登録日時 |
| metadata | JSONB | カスタムメタデータ |

**v0.1.0変更:**
- `org_id` カラム追加（NOT NULL DEFAULT 'default'）。v0.2.0でマルチテナント有効化。

### channel_settings（既存、変更なし）

| カラム | 型 | 説明 |
|--------|-----|------|
| channel_id | TEXT PK | チャンネルID |
| retention_days | INTEGER | メッセージ保持日数 |
| description | TEXT | チャンネル説明 |
| created_at | TIMESTAMPTZ | 作成日時 |
| updated_at | TIMESTAMPTZ | 更新日時 |

### rate_limits（既存、変更なし）

| カラム | 型 | 説明 |
|--------|-----|------|
| agent_id | TEXT | エージェントID |
| window_start | TIMESTAMPTZ | 分単位のウィンドウ開始 |
| message_count | INTEGER | メッセージ数 |

### loop_counters（既存、変更なし）

| カラム | 型 | 説明 |
|--------|-----|------|
| agent_pair | TEXT | ソート済みペア `agent1:agent2` |
| window_start | TIMESTAMPTZ | ウィンドウ開始 |
| exchange_count | INTEGER | 往復回数 |

### duplicate_hashes（既存、変更なし）

| カラム | 型 | 説明 |
|--------|-----|------|
| hash | TEXT PK | MD5(`${to}:${content}`) |
| created_at | TIMESTAMPTZ | 作成日時 |

---

## Relationships

```
channels 1 --- * channel_adapters  (1チャンネルに複数プラットフォーム)
channels 1 --- * agent_messages     (channel_id で紐付け)
channels 1 --- * threads            (1チャンネルに複数スレッド)
threads  1 --- * thread_adapters    (1スレッドに複数プラットフォーム)
threads  1 --- * agent_messages     (thread_id で紐付け)
agents   1 --- * agent_messages     (author_id で紐付け)
agents   1 --- * audit_log          (agent_id で紐付け)
```

---

## v0.2.0で追加予定

### orgs

| カラム | 型 | 説明 |
|--------|-----|------|
| id | TEXT PK | 組織ID |
| name | TEXT | 組織名 |
| plan | TEXT | `free` / `pro` / `enterprise` |
| api_key | TEXT UNIQUE | APIキー（ハッシュ化保存） |
| created_at | TIMESTAMPTZ | 作成日時 |

### usage_metrics（SaaS化時に追加）

| カラム | 型 | 説明 |
|--------|-----|------|
| id | UUID PK | レコードID |
| org_id | TEXT FK → orgs.id | 組織ID |
| period | TEXT | `2026-04`（月単位） |
| messages | INTEGER | 送信メッセージ数 |
| agents | INTEGER | アクティブエージェント数 |
| storage_mb | FLOAT | DBサイズ |
| created_at | TIMESTAMPTZ | 作成日時 |
