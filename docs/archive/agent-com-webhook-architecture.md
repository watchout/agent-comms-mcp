<!-- ARCHIVED: message-queue-spec v1.0.0 に統合 (2026-04-10) -->

# agent-com Webhook Channel アーキテクチャ仕様

> CEO承認待ち: 2026-04-07
> SSE daemon + Webhook Channel によるメモリ効率化・経路一本化・フィルタ統一

---

## 1. 現状の問題と解決

### 1.1 現状の3つの問題

```
問題1: メモリ圧迫
  9 bot × Discord.js Client（50-100MB/bot）= 450-900MB
  Mac miniのメモリを圧迫

問題2: 受信経路が2つ（バイパス問題）
  channel plugin → Discord直接監視 → フィルタなし → 全botにpush
  SSE daemon → routeInbound() → フィルタあり
  → channel pluginがフィルタをバイパス

問題3: 形式の不一致
  受信: Discord形式（<@1234567890>）のまま届く
  送信: agent_id形式（"cto"）を要求
  → botが混乱
```

### 1.2 解決: agent-commsを2つに分離

```
agent-comms-channel（Webhook Channel = push受信専用）
  → claude/channel capability を宣言
  → ローカルHTTPポートでlisten
  → ルーティング済みメッセージをpush注入
  → Discord Clientなし → メモリ消費ゼロ
  → Discord直接監視なし → バイパス不可能

agent-comms（通常のMCPサーバー = ツール提供）
  → send, history, inbox, agents, focus, unfocus, quote
  → .mcp.json で接続
```

---

## 2. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│ SSE daemon（1プロセス、全botのDiscord接続を管理）              │
│                                                                 │
│  Discord Client: CTO Token ──── Discord Gateway A               │
│  Discord Client: ARC Token ──── Discord Gateway B               │
│  Discord Client: Hotel Dev Token ── Discord Gateway C           │
│  ...（bot数分）                                                  │
│                                                                 │
│  受信: Gateway → adapter変換 → routeInbound() → DB INSERT      │
│        → HTTP POST localhost:{port}/push（対象botのみ）         │
│                                                                 │
│  送信: sendツール → コアRouter → bot固有TokenでDiscord投稿      │
│                                                                 │
│  共有リソース: DB pool, pg_notify, audit_log                    │
└─────────────────────────────────────────────────────────────────┘
         │ HTTP POST（HMAC署名付き）             ▲ sendツール
         ▼                                       │
┌─────────────────────────────┐   ┌──────────────────────────────┐
│ agent-comms-channel          │   │ agent-comms                  │
│ （各botのセッション内）       │   │ （MCP server / SSE or stdio）│
│                              │   │                              │
│ ローカルHTTP listen          │   │ send, history, inbox         │
│ POST /push → notification() │   │ agents, focus, unfocus       │
│ → Claude Codeセッションに    │   │ quote                        │
│   push注入                   │   │                              │
│                              │   │ コアRouter経由で             │
│ Discord Client なし          │   │ daemon にリクエスト          │
│ メモリ消費 ≈ 0               │   │                              │
└─────────────────────────────┘   └──────────────────────────────┘
         │                                       │
         └──────── Claude Code セッション ────────┘
```

### 2.1 メッセージフロー: inbound（Discord → bot）

```
1. Discord Gateway でメッセージ受信（bot固有のClient）
2. Discord adapter: Discord形式 → UnifiedMessage 変換
   - <@1234567890> → mentions: ["cto"] に変換（agentsテーブル参照）
   - Discord thread_id → thread_adapters で解決（未知なら自動登録）
   - attachment → ローカル保存 + attachments テーブルINSERT
3. routeInbound()（コアRouter、5段階フィルタ）:
   0. DM → 無条件push
   1. 緊急メッセージ → 全員push
   2. グループメンション → 該当グループpush
   3. reply_to → 元送信者を追加
   4. mentions配列に受信者が含まれるか → No → DBのみ
   5. active_thread一致 → push / DBのみ
4. DB INSERT（全メッセージ1行、フィルタ結果に関わらず）
5. push対象botに対してのみ HTTP POST localhost:{port}/push
   - PushPayload（HMAC署名付き）
   - reply_to元メッセージの引用テキスト付与済み
6. agent-comms-channel が受信 → notification() → セッションに注入
```

### 2.2 メッセージフロー: outbound（bot → Discord）

```
1. bot が send(to, mentions, content, reply_to) を呼ぶ
2. agent-comms（MCPツール）がコアRouter に渡す
3. コアRouter バリデーション:
   - mentions 必須チェック（空配列は拒否）
   - active_thread 強制上書き
   - reply_to 元メッセージのメンション検証
   - reply_to 元メッセージの thread_id 自動解決
   - channels.members チェック
   - サイズ制限（50,000文字）
4. バリデーション通過:
   → DB INSERT
   → pg_notify('agent_events', ...)
   → daemon が bot固有Token で Discord に投稿
   → typing indicator も bot固有Token で送信
5. バリデーション失敗:
   → audit_log 記録
   → pg_notify('agent_events', {type: "message.rejected"})
   → 送信者のセッションにエラーフィードバック push（message_type: "system_error"）
```

---

## 3. コンポーネント詳細

### 3.1 SSE daemon

```
役割: 全botのDiscord接続を1プロセスで管理

起動時:
  1. .env から DISCORD_TOKEN_{AGENT_ID} を全て読み込み
  2. bot_id ごとに Discord Client を生成
  3. 各 Client で Gateway に接続
  4. agentsテーブルから channel_port を取得
  5. /health エンドポイント起動（全botの接続状態表示）

Discord Client 設定（メモリ最適化）:
  intents: [Guilds, GuildMessages, MessageContent, DirectMessages]
  makeCache: () => new Collection()  // キャッシュ無効化
  → Client 1体あたり 15-30MB に削減

受信処理:
  client.on("messageCreate", async (msg) => {
    // 自分自身のメッセージは無視
    if (msg.author.id === client.user.id) return;
    
    // Discord形式 → UnifiedMessage 変換
    const unified = await discordToUnified(msg);
    
    // コアRouter（5段階フィルタ）
    const results = await routeInbound(unified);
    
    // DB INSERT（全メッセージ）
    await saveMessage(unified);
    
    // push対象botにHTTP POST
    for (const target of results.pushTargets) {
      await pushToChannel(target.agentId, unified);
    }
  });

送信処理:
  // sendツールから呼ばれる
  async function sendToDiscord(agentId, channelId, content) {
    const client = discordClients.get(agentId);
    const channel = await client.channels.fetch(channelId);
    await channel.send(content);
  }

プロセス管理:
  → systemd or pm2 で管理
  → 死んだら自動再起動
  → 再起動時に全Discord Gateway再接続
```

### 3.2 agent-comms-channel（Webhook Channel）

```
役割: daemonからのHTTP POSTを受け取り、Claude Codeセッションに注入

ファイル: agent-comms-channel.ts（50-80行程度の軽量MCP server）

実装:
  import { Server } from "@modelcontextprotocol/sdk/server/index.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

  const server = new Server({
    name: "agent-comms-channel",
    version: "0.1.0",
  }, {
    capabilities: {
      "claude/channel": {},  // channel capability 宣言
      tools: {},
    },
  });

  // ローカルHTTPサーバー（push受信用）
  const httpServer = Bun.serve({
    port: parseInt(process.env.CHANNEL_PORT || "9001"),
    hostname: "127.0.0.1",  // localhost のみ（外部公開しない）
    async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/push") {
        const body = await req.json();
        
        // HMAC署名検証
        if (!verifyHmac(body, req.headers.get("X-Signature"))) {
          return new Response("Unauthorized", { status: 401 });
        }
        
        // Claude Codeセッションに通知
        await server.notification({
          method: "notifications/message",
          params: {
            channel: "agent-comms",
            sender: body.author_id,
            content: formatPushContent(body),
          },
        });
        
        return new Response("OK", { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    },
  });

  // replyツール（Claude Codeが返信する時に使う）
  // → 内部的にagent-commsのsendツールを呼ぶ
  // → 直接Discordには投稿しない（コアRouter経由を強制）
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "reply") {
      // agent-comms の send ツールに委譲
      // → コアRouterのバリデーションを必ず通る
    }
  });

  // stdio transport で Claude Code と接続
  const transport = new StdioServerTransport();
  await server.connect(transport);

.mcp.json 設定:
  {
    "mcpServers": {
      "agent-comms-channel": {
        "command": "bun",
        "args": ["run", "/path/to/agent-comms-channel.ts"],
        "env": {
          "CHANNEL_PORT": "9001",
          "HMAC_SECRET": "${HMAC_SECRET}"
        }
      },
      "agent-comms": {
        "type": "sse",
        "url": "http://localhost:8080/sse?bot_id=cto"
      }
    }
  }

Claude Code 起動コマンド:
  claude --dangerously-load-development-channels server:agent-comms-channel \
         --mcp agent-comms
  
  → agent-comms-channel: push受信（channel capability）
  → agent-comms: ツール提供（send, history等）
  → Discord公式プラグインは不要（アンインストール）
```

### 3.3 agent-comms（MCP ツールサーバー）

```
役割: send, history, inbox 等のMCPツール提供

変更なし。既存のSSE daemon内のMCPツール。
bot → SSE接続 → ツール呼び出し → コアRouter → Discord投稿

ツール一覧:
  send(to, mentions, content, reply_to?)  -- 送信
  history(channel_id, limit?, before?)    -- 履歴取得
  inbox(limit?)                           -- 未読取得
  agents(status?)                         -- エージェント一覧
  focus(thread_id)                        -- active_thread設定
  unfocus()                               -- active_threadリセット
  quote(message_id, to, comment?)         -- 引用+メンション投稿
  
  旧名称エイリアス（非推奨警告付き）:
  send_message → send
  reply → send
  fetch_messages → history
  check_inbox → inbox
  list_agents → agents
```

---

## 4. セキュリティ

### 4.1 daemon ↔ channel 間の認証

```
HMAC-SHA256 署名:
  daemon送信時:
    payload = JSON.stringify(pushPayload)
    signature = HMAC-SHA256(payload, HMAC_SECRET)
    Header: X-Signature: sha256={signature}

  channel受信時:
    受信したpayloadとX-Signatureを検証
    不一致 → 401 Unauthorized → audit_log記録

  HMAC_SECRET:
    .envファイルに保存（daemon/channel共有）
    ランダム生成（openssl rand -hex 32）
    リポジトリには含めない
```

### 4.2 ネットワーク

```
全HTTPサーバー: 127.0.0.1 bind（localhost のみ）
→ 外部からアクセス不可能
→ ファイアウォール設定不要
→ 同一Mac mini内のプロセス間通信のみ
```

### 4.3 Discord APIとの関係

```
Discord → daemon: Discord Gateway（WebSocket、Discord公式API）
daemon → Discord: Discord REST API（bot固有Token）

daemon → channel: ローカルHTTP POST（Discordを一切通らない）
channel → bot: stdio（MCP、Discordを一切通らない）

→ Discordから見ると通常のbot動作と同じ
→ bot間通信には見えない
→ DiscordのBot利用規約に違反しない
```

---

## 5. PushPayload 型定義

```typescript
// shared/types.ts（daemon と channel が共有）
interface PushPayload {
  // メッセージ識別
  message_id: string;          // UUID
  sequence: number;            // チャンネル内の順序番号
  
  // 宛先
  channel_id: string;          // コア層のチャンネルID
  thread_id?: string;          // コア層のスレッドID（あれば）
  
  // 送信者
  author_id: string;           // agent_id形式（"cto", "hotel-dev"）
  
  // メンション
  mentions: string[];          // agent_id形式の配列（変換済み）
  
  // 本文
  content: string;             // メッセージ本文（@agent_id形式に変換済み）
  
  // リプライ
  reply_to?: string;           // 元メッセージID
  reply_to_content?: string;   // 引用テキスト（500文字まで）
  reply_to_author?: string;    // 元メッセージの送信者
  
  // 添付ファイル
  attachments?: {
    filename: string;
    path: string;              // ローカルファイルパス
    mime_type?: string;
    size_bytes?: number;
  }[];
  
  // メタデータ
  message_type: string;        // "message" | "system_error" | "emergency"
  timestamp: string;           // ISO 8601
}
```

---

## 6. ポート管理

```sql
-- agents テーブルに追加
ALTER TABLE agents ADD COLUMN channel_port INTEGER;

-- 自動採番（seed.ts）
-- base_port = 9001
-- cto: 9001, arc: 9002, hotel-dev: 9003, ...
```

```
daemon がpush先を決定する流れ:
  1. routeInbound() で push対象の agent_id リストを取得
  2. agents テーブルから各 agent_id の channel_port を取得
  3. HTTP POST localhost:{channel_port}/push
  4. 接続拒否 → message.failed イベント → audit_log → Telegram CEO通知
```

---

## 7. ヘルスチェック

```
daemon /health レスポンス:

{
  "status": "healthy",
  "discord_clients": {
    "cto": { "connected": true, "guilds": 1, "uptime_seconds": 3600 },
    "arc": { "connected": true, "guilds": 1, "uptime_seconds": 3600 },
    "hotel-dev": { "connected": true, "guilds": 1, "uptime_seconds": 3600 }
  },
  "channel_endpoints": {
    "cto": { "port": 9001, "reachable": true, "last_push": "2026-04-07T10:30:00Z" },
    "arc": { "port": 9002, "reachable": true, "last_push": "2026-04-07T10:28:00Z" },
    "hotel-dev": { "port": 9003, "reachable": false, "error": "connection refused" }
  },
  "db": { "connected": true, "pool_size": 10, "active": 2 },
  "uptime_seconds": 7200
}

agent-com status CLI:
  → /health を取得して人間が読みやすい形式で表示
  → channel_endpoint が reachable: false のbotを赤で表示
```

---

## 8. プロセス管理

### 8.1 起動

```bash
# npm start で全プロセス起動（concurrently）
{
  "scripts": {
    "start": "concurrently \"npm run daemon\" \"npm run channel:all\"",
    "daemon": "bun run src/daemon.ts",
    "channel:all": "bun run scripts/start-channels.ts"
  }
}

# start-channels.ts:
# agentsテーブルからアクティブなbot一覧を取得
# 各botのtmuxセッション内でClaude Code起動コマンドを実行
```

### 8.2 障害対策

```
daemon停止時:
  → 全botの受信が止まる（単一障害点）
  → 対策: systemd or pm2 で自動再起動
  → 再起動中のメッセージ: Discord側で保持 → 再接続後にcatchup
  → DB保存済みメッセージ: inbox で取得可能

channel停止時:
  → 該当botだけ受信不可（他botに影響なし）
  → daemon側でHTTP POST失敗を検知
  → audit_log記録 + Telegram CEO通知
  → メッセージはDB保存済み → bot復旧後にinboxで取得

MCP 5分タイムアウト:
  → agent-comms-channel: stdio接続（常時接続、タイムアウトなし）✅
  → agent-comms（ツール）: SSE接続 → ツール呼び出し時にon-demand再接続
```

### 8.3 Discord Gateway制限

```
確認事項:
  → 同一IPからのGateway同時接続数: Discordの制限は「1 botあたり1接続」
  → 9 bot = 9つの異なるBot Application = 9つの異なるToken
  → 同一IPだが異なるbotなので問題なし
  → ただし短時間に全bot同時接続するとrate limitの可能性
  → 対策: daemon起動時に1 botずつ1秒間隔で接続
```

---

## 9. OSS利用者の体験

### 9.1 2つの動作モード

```
小規模モード（1-3 bot）: channel plugin
  → 各botが自分のDiscord Token で接続
  → daemon不要
  → セットアップが簡単
  → メモリは許容範囲

大規模モード（4+ bot）: Webhook Channel
  → daemon が全Discord接続を管理
  → メモリ効率が高い
  → セットアップが少し複雑
  → README: 「4 bot以上ならdaemonモード推奨」

どちらもrouteInbound()は同じ関数を使う → フィルタ動作は同一
```

### 9.2 クイックスタート（大規模モード）

```bash
# 1. リポジトリクローン
git clone https://github.com/iyasaka/agent-com
cd agent-com

# 2. 環境設定
cp .env.example .env
# .env にDiscord Token、DB接続文字列、HMAC_SECRET を設定

# 3. DB セットアップ
docker-compose up -d postgres   # PostgreSQL + pgvector
npm run migrate                  # テーブル作成
npm run seed                     # チャンネル・エージェント登録

# 4. 起動
npm start                        # daemon + 全チャネル起動

# 5. Claude Code セッション起動（各botのtmuxセッション内）
claude --dangerously-load-development-channels server:agent-comms-channel \
       --mcp agent-comms
```

---

## 10. 盲点対策一覧

| 盲点 | 対策 | 実装場所 |
|------|------|---------|
| 公式Discordプラグインとの共存 | セットアップ手順で「Discordプラグインをアンインストール」明記 | README |
| replyツールのバイパス | reply は内部的にsendツール経由（コアRouter必ず通過） | agent-comms-channel |
| 自己push注入の偽造 | daemon→channel間HMAC-SHA256署名必須 | daemon + channel |
| HTTPペイロード形式の不一致 | shared/types.ts で PushPayload 型を共有 | shared/ |
| HTTP POST順序保証 | PushPayload に sequence 番号。channel側でsequence順処理 | daemon + channel |
| ポート重複 | agents テーブルの channel_port で管理。seed.tsで自動採番 | DB + seed.ts |
| daemonの単一障害点 | systemd/pm2で自動再起動 | インフラ |
| channel死亡の検知 | POST失敗検知 → audit_log → Telegram CEO通知 | daemon |
| MCP 5分タイムアウト | channel=stdio常時接続。ツール=on-demand再接続 | 設計で解決 |
| Discord Gateway rate limit | 起動時に1bot/秒で順次接続 | daemon |
| 未知スレッドの自動登録 | adapter受信時にthread_adaptersになければ自動INSERT | daemon |
| bot追加時の設定漏れ | agent-com agent add コマンドで自動化（v0.2.0） | CLI |
| Discord Token漏洩 | .gitignore + .env.example + pre-commitフック | リポジトリ設定 |
| localhost以外からのアクセス | 全HTTPサーバー 127.0.0.1 bind | daemon + channel |

---

## 11. 実装チェックリスト

### daemon
- [ ] .env からマルチToken読み込み
- [ ] bot_id ごとに Discord Client 生成（メモリ最適化設定）
- [ ] 起動時に1bot/秒で順次Gateway接続
- [ ] 受信: Discord形式 → UnifiedMessage変換
- [ ] 受信: routeInbound()（5段階フィルタ + DM判定）
- [ ] 受信: 全メッセージDB INSERT
- [ ] 受信: push対象botにHTTP POST（HMAC署名付き）
- [ ] 受信: 未知スレッドの自動登録
- [ ] 受信: attachment ローカル保存 + DB INSERT
- [ ] 送信: bot固有TokenでDiscord投稿
- [ ] 送信: typing indicatorもbot固有Token
- [ ] エラーフィードバック: system_error push
- [ ] /health エンドポイント
- [ ] POST失敗検知 → audit_log → Telegram通知
- [ ] systemd/pm2 設定ファイル

### agent-comms-channel
- [ ] claude/channel capability宣言
- [ ] ローカルHTTPサーバー（127.0.0.1 bind）
- [ ] POST /push 受信 → HMAC検証 → notification()
- [ ] PushPayload のフォーマット → セッション注入用テキスト変換
- [ ] sequence順序チェック
- [ ] replyツール → agent-commsのsendに委譲

### shared
- [ ] PushPayload 型定義（shared/types.ts）
- [ ] HMAC署名/検証ユーティリティ
- [ ] UnifiedMessage 型定義

### インフラ
- [ ] .env.example（全設定項目のplaceholder）
- [ ] .gitignore（.env, node_modules, attachments/）
- [ ] docker-compose.yml（PostgreSQL + pgvector）
- [ ] agents テーブルに channel_port カラム追加
- [ ] agents テーブルに discord_user_id カラム追加
- [ ] seed.ts: channel_port自動採番
- [ ] seed.ts: 既存スレッド一括登録
- [ ] npm start で daemon + channel 全起動

---

## 改訂履歴

| 日付・時刻 | 内容 |
|-----------|------|
| 2026-04-07 18:00 | 初版: Webhook Channelアーキテクチャ仕様（全11セクション） |
