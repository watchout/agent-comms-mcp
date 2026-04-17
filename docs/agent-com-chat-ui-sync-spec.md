# agent-com チャットUI同期仕様

> **前提:** message-queue-spec v2.0.0 (OSS primary / SQLite default / 1 daemon)
> CEO承認待ち: 2026-04-08
> 原則: 初回はチャットUI → DB（インポート）、以降はDB → チャットUI（エクスポート）
> 対応プラットフォーム: Discord / Telegram / Slack / LINE

---

## 1. 設計原則

```
1. コアDB が正（Single Source of Truth）
2. 初回セットアップはチャットUIから自動インポート（ユーザー体験優先）
3. 運用中の変更はDB → チャットUIに同期（整合性優先）
4. プラットフォーム非依存のデータモデル（agent_id / channel_id）
5. botはagent_idだけ使う。プラットフォーム固有形式を知る必要がない
```

---

## 2. インストール順序パターン

```
パターンA: チャットUI先 → agent-com後（最も多い）
  ユーザーは既にDiscord/Slack等を使っている
  → agent-com init --from discord で自動インポート
  → 30秒で完了

パターンB: agent-com先 → チャットUI後
  agent-comを先にセットアップ、後からDiscord等を接続
  → agent-com init --standalone（DBだけ構築）
  → 後から agent-com connect discord で同期

パターンC: agent-comのみ（チャットUIなし）
  DBとMCPツールだけで運用（Discord/Slack不要）
  → agent-com init --standalone
  → 可視化はダッシュボード or ログのみ
```

```
インストールフロー:

  agent-com install
    ↓
  「チャットプラットフォームは接続済みですか？」
    ↓
    Yes → 「どのプラットフォーム？」
      → discord → agent-com init --from discord
      → slack   → agent-com init --from slack
      → telegram → agent-com init --from telegram
      → 複数 → agent-com init --from discord,slack
    ↓
    No → 「後から接続できます」
      → agent-com init --standalone
      → 後で agent-com connect discord
    ↓
  DB構築 → 完了
```

---

## 3. コアDBスキーマ

### 3.1 エージェント（bot/人間）

```sql
CREATE TABLE agents (
  -- core columns: mq-spec v2.0.0 §3.4 と共通
  agent_id              TEXT PRIMARY KEY,              -- "cto"（コア識別子、変更なし）
  display_name          TEXT NOT NULL,                 -- "IYASAKA CTO"
  agent_type            TEXT NOT NULL,                 -- "cto"|"dev"|"org"|"human"|"auditor"
  cli_type              TEXT,                          -- "claude_code"|"codex"|"gemini" 等 (自由文字列)
  status                TEXT NOT NULL DEFAULT 'disconnected',
                        -- "idle"|"busy"|"disconnected"|"offline"
  observer_mode         BOOLEAN NOT NULL DEFAULT false,-- Auditor用
  heartbeat_at          TIMESTAMPTZ,                   -- 最終ハートビート
  current_message_id    TEXT,                          -- next で pop した message_queue.id
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- extension columns: chat-ui-sync-spec 固有 (phase 2 で去就判断)
  org_id                TEXT NOT NULL DEFAULT 'default',
  runtime               TEXT,                          -- "bun"|"node"|"deno"
  default_channel       TEXT,                          -- デフォルトチャンネル
  last_received_channel TEXT,                          -- 直前受信チャンネル
  last_received_thread  TEXT,                          -- 直前受信スレッド
  status_detail         TEXT,                          -- "PRレビュー中" 等
  current_model         TEXT,                          -- "opus-4"|"sonnet-4" 等
  session_start_at      TIMESTAMPTZ,                   -- 現セッション開始時刻
  last_error            TEXT,                          -- 直近エラーメッセージ
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 エージェントのプラットフォーム紐付け

```sql
CREATE TABLE agent_adapters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT REFERENCES agents(agent_id),
  platform          TEXT NOT NULL,              -- "discord"|"telegram"|"slack"|"line"
  external_id       TEXT NOT NULL,              -- プラットフォーム側のユーザーID
  external_name     TEXT,                       -- プラットフォーム側の表示名
  mention_format    TEXT,                       -- プラットフォーム固有メンション形式
  synced_at         TIMESTAMPTZ,
  UNIQUE(agent_id, platform),
  UNIQUE(platform, external_id)                 -- 重複登録防止
);

-- 注: bot_token は保存しない（.envで管理）
```

### 3.3 チャンネル

```sql
CREATE TABLE channels (
  -- core columns: mq-spec v2.0.0 §3.5 と共通
  id                TEXT PRIMARY KEY,                  -- "hotel-kanri"（コア識別子）
  type              TEXT NOT NULL,                     -- "channel"|"dm"
  name              TEXT,                              -- 表示名
  topic             TEXT,                              -- チャンネルトピック
  members           TEXT NOT NULL DEFAULT '[]',        -- agent_id JSON配列 (TEXT)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- extension columns: chat-ui-sync-spec 固有 (phase 2 で去就判断)
  org_id            TEXT NOT NULL DEFAULT 'default',
  created_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.4 チャンネルのプラットフォーム紐付け

```sql
CREATE TABLE channel_adapters (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        TEXT REFERENCES channels(id),
  platform          TEXT NOT NULL,
  external_id       TEXT NOT NULL,              -- プラットフォーム側のチャンネルID
  external_name     TEXT,                       -- プラットフォーム側のチャンネル名
  metadata          JSONB,                      -- プラットフォーム固有設定
  synced_at         TIMESTAMPTZ,
  UNIQUE(channel_id, platform)
);
```

### 3.5 スレッド

```sql
CREATE TABLE threads (
  id                TEXT PRIMARY KEY,           -- "thread-auth-impl"
  channel_id        TEXT REFERENCES channels(id),
  title             TEXT,
  created_by        TEXT,
  status            TEXT DEFAULT 'active',      -- "active"|"archived"
  created_at        TIMESTAMPTZ DEFAULT now()
);
```

### 3.6 スレッドのプラットフォーム紐付け

```sql
CREATE TABLE thread_adapters (
  thread_id         TEXT REFERENCES threads(id),
  platform          TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  synced_at         TIMESTAMPTZ,
  PRIMARY KEY(thread_id, platform)
);
```

---

## 4. プラットフォーム別の取得可能データ

```
                    Discord          Telegram         Slack            LINE
─────────────────────────────────────────────────────────────────────────────
Bot情報
  Bot ID            ✅ User ID       ✅ Bot ID        ✅ Bot ID        ✅ Bot ID
  表示名            ✅ username      ✅ first_name    ✅ bot name      ✅ display name
  アイコン          ✅ avatar        ✅ photo         ✅ icon          ✅ icon

チャンネル/グループ
  チャンネル一覧    ✅ guilds/ch     ✅ getChat       ✅ conversations ✅ rooms
  チャンネル名      ✅ name          ✅ title         ✅ name          ✅ name
  メンバー一覧      ✅ members       ⚠️ 制限あり     ✅ members       ⚠️ 制限あり
  権限設定          ✅ permissions   ❌              ✅ permissions    ❌

スレッド
  スレッド一覧      ✅ threads       ❌ 概念なし     ✅ threads       ❌ 概念なし
  親チャンネル      ✅ parentId      ❌              ✅ parent        ❌

メンション形式
  ユーザー          <@userId>        なし（テキスト） <@userId>        なし（テキスト）
  チャンネル        <#channelId>     なし            <#channelId>     なし

メッセージ履歴
  過去取得          ✅ messages API  ⚠️ 制限あり     ✅ history API   ❌
```

---

## 5. 同期の3タイミング

### 5.1 初回インポート（agent-com init --from {platform}）

```
取得するデータ:
  - Guild/Workspace内の全Bot → agents + agent_adapters
  - 人間ユーザー（特定ロール） → agents (agent_type="human")
  - 全チャンネル → channels + channel_adapters
  - 各チャンネルのメンバー → channels.members
  - アクティブスレッド → threads + thread_adapters
  - 各Bot/ユーザーの表示名 → display_name, external_name
  - メンション形式 → mention_format

処理:
  agent-com init --from discord
    → Discord API接続（BOT Token使用）
    → Guild情報取得
    → 全データ一括取得
    → agent_id を外部名から自動生成（sanitize）:
        "IYASAKA CTO" → "cto"
        "Hotel Dev" → "hotel-dev"
        衝突時はサフィックス付与（"cto-2"）
    → 確認プロンプト表示:
        「以下のBot/チャンネルが見つかりました:
         Bots: cto (IYASAKA CTO), arc (IYASAKA ARC), ...
         Channels: hotel-kanri (members: cto, arc, hotel-dev), ...
         DBに登録しますか？ (Y/n)」
    → Y → DB INSERT（全テーブル）
    → 「✅ 完了。9 agents, 12 channels を登録しました」
```

### 5.2 運用中の同期（agent-com sync）

```
検知するデータ:
  - チャンネル追加/削除/名前変更
  - メンバー追加/削除
  - スレッド追加/アーカイブ
  - Bot表示名変更

処理:
  agent-com sync
    → プラットフォームAPIから最新情報取得
    → DBと比較
    → 差分表示:
        「以下の変更を検出しました:
         + 新チャンネル #marketing (Discord)
         - 削除されたチャンネル #old-project
         ~ メンバー変更 #hotel-kanri: +wbs-dev
         ~ 表示名変更 Hotel Dev → Hotel Dev Bot」
    → 「DBに反映しますか？ (Y/n)」
    → 反映

自動同期（オプション）:
  cron: 0 * * * * agent-com sync --auto-approve
  → 差分を自動反映（確認プロンプトなし）
  → audit_logに変更記録
```

### 5.3 DB → プラットフォーム反映（agent-com push）

```
反映するデータ:
  - チャンネルメンバー変更 → Discord権限変更
  - 新チャンネル作成 → Discordチャンネル作成
  - Bot表示名変更 → Discord Bot名変更（API制限あり）

処理:
  agent-com channel add-member hotel-kanri wbs-dev
    → DB更新
    → agent-com push（Discord権限に反映）

注意: プラットフォーム側への書き込みは権限が必要
  Discord: Manage Channels権限
  Slack: admin権限
  → 権限がなければ警告（DBだけ更新、プラットフォーム反映は手動）
```

---

## 6. メンション形式の変換

### 6.1 変換フロー（全自動、botは関与しない）

```
送信時（bot → Discord）:
  bot: send(mentions: ["cto"], content: "@cto レビューして")
    → コアRouter:
      1. "cto" → agent_adapters で mention_format 取得
         → "<@1485599598259994635>"
      2. content内の "@cto" を "<@1485599598259994635>" に変換
      3. Discord APIに送信
    → botはagent_idだけ知っていればいい

受信時（Discord → bot）:
  Discord: "<@1485599598259994635>" を含むメッセージ
    → adapter:
      1. agent_adapters で external_id 検索
      2. → agent_id = "cto" に変換
      3. UnifiedMessage.mentions = ["cto"]
    → botにはagent_id形式でしか届かない
```

### 6.2 Fuzzy解決（古い形式・誤った形式の自動修正）

```typescript
async function fuzzyResolveAgent(input: string): Promise<Agent | null> {
  const cleaned = input.replace(/^[&@]/, "").toLowerCase();
  
  // agent_idの完全一致
  let agent = await db.query(
    "SELECT * FROM agents WHERE agent_id = $1", [cleaned]
  );
  if (agent) return agent;

  // agent_idの部分一致
  agent = await db.query(
    "SELECT * FROM agents WHERE agent_id ILIKE $1", [`%${cleaned}%`]
  );
  if (agent) return agent;
  
  // display_nameの部分一致
  agent = await db.query(
    "SELECT * FROM agents WHERE display_name ILIKE $1", [`%${cleaned}%`]
  );
  if (agent) return agent;
  
  // external_name（プラットフォーム表示名）の部分一致
  agent = await db.query(
    `SELECT a.* FROM agents a 
     JOIN agent_adapters aa ON a.agent_id = aa.agent_id 
     WHERE aa.external_name ILIKE $1`, [`%${cleaned}%`]
  );
  return agent;
}

// 使用例:
//   "&arc"           → fuzzy → agent_id "arc" ✅
//   "IYASAKA ARC"    → fuzzy → agent_id "arc" ✅
//   "@IYASAKA CTO"   → fuzzy → agent_id "cto" ✅
//   "xxxxx"          → fuzzy → null → AGENT_NOT_FOUND エラー
//                      → 利用可能なagent_id一覧を返す
```

### 6.3 メンションバリデーション（sendツール内）

```typescript
async function validateMentions(mentions: string[]): Promise<string[] | Error> {
  const resolved: string[] = [];
  
  for (const mention of mentions) {
    // まずagent_idとして存在するか
    let agent = await db.getAgent(mention);
    
    if (!agent) {
      // 非標準形式をfuzzy解決
      agent = await fuzzyResolveAgent(mention);
    }
    
    if (!agent) {
      const agentList = await db.query("SELECT agent_id, display_name FROM agents");
      return error("AGENT_NOT_FOUND", 
        `'${mention}' は登録されていません。\n` +
        `利用可能なagent_id:\n` +
        agentList.map(a => `  ${a.agent_id} (${a.display_name})`).join("\n")
      );
    }
    
    resolved.push(agent.agent_id);
  }
  
  return resolved; // 全て正規化されたagent_id配列
}
```

---

## 7. コンフリクト解決

```
ケース1: DBにあるがプラットフォームにない
  例: DBに #old-project があるが Discord から削除された
  → sync時: 「#old-project がDiscordから削除されています。DBからも削除しますか？」
  → ユーザー判断

ケース2: プラットフォームにあるがDBにない
  例: Discordに #new-project が作られた
  → sync時: 「新しいチャンネル #new-project を検出。DBに追加しますか？」
  → ユーザー判断

ケース3: メンバーが食い違う
  例: DBではctoが#hotel-kanriのメンバー、Discordでは権限が外れている
  → sync時: 「#hotel-kanri のメンバーに差異があります」
  → どちらを正とするかユーザーが選択

同期オプション:
  --auto-approve: プラットフォーム側を正として自動反映
  --db-priority: DB側を正としてプラットフォームに反映
  デフォルト: 確認プロンプト（ユーザー判断）
```

---

## 8. OSS利用者の設定フロー

### 8.1 最短パス（Discord既にある場合、30秒）

```bash
npm install -g agent-com
cp .env.example .env              # BOT Tokenを設定
agent-com init --from discord     # 全データ自動インポート
npx agent-comms-mcp               # daemon起動（channel-server不要）
```

### 8.2 後からプラットフォーム追加

```bash
agent-com connect slack           # Slack追加
agent-com sync                    # 同期
```

### 8.3 プラットフォームなし（開発/テスト用）

```bash
agent-com init --standalone       # DBのみ構築
agent-com agent register cto      # 手動登録
agent-com channel create test --members cto
npx agent-comms-mcp               # daemon起動
```

### 8.4 手順比較

```
自動インポート（推奨）:
  .env設定 + agent-com init --from discord
  → 2コマンドで完了

手動設定（非推奨、後方互換用）:
  agent register × 9 + adapter add × 9 + channel create × 12 + メンバー設定 × 40
  → 70回のコマンド実行
```

---

## 9. 実装チェックリスト

### DB
- [ ] agent_adapters テーブル作成
- [ ] channel_adapters テーブル作成（既存を拡張）
- [ ] thread_adapters テーブル作成（既存を拡張）

### CLIコマンド
- [ ] agent-com init --from {platform}（自動インポート）
- [ ] agent-com init --standalone（DBのみ）
- [ ] agent-com connect {platform}（後から接続）
- [ ] agent-com sync（差分同期）
- [ ] agent-com sync --auto-approve（自動同期）
- [ ] agent-com push（DB → プラットフォーム反映）

### プラットフォーム同期
- [ ] Discord: importAll()（全データ取得）
- [ ] Discord: detectChanges()（差分検知）
- [ ] Discord: pushChanges()（DB → Discord反映）
- [ ] Telegram: importAll()（制限考慮）
- [ ] Slack: importAll()
- [ ] LINE: importAll()（制限考慮）

### メンション変換
- [ ] 送信時: agent_id → プラットフォーム形式変換
- [ ] 受信時: プラットフォーム形式 → agent_id変換
- [ ] fuzzyResolveAgent()（古い形式の自動修正）
- [ ] validateMentions()（存在確認 + 正規化）
- [ ] AGENT_NOT_FOUND時に利用可能agent_id一覧を返す

### 自動登録
- [ ] 未知スレッドの自動登録（daemon受信時）
- [ ] agent_id自動生成（表示名からsanitize）

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-04-17 | v0.2.0 phase 1: message-queue-spec v2.0.0 追随 — Header v2.0.0 前提追記、agents DDL 整合 (dispatch_enabled 除外 / heartbeat_at 等追加)、channels DDL 整合 (members JSON string / type enum / topic)、channel-server 残骸除去、改訂履歴追加 |
| 2026-04-08 | v0.1.0 初版 (CEO 承認待ち) |
