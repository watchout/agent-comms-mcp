<!-- ARCHIVED: message-queue-spec v1.0.0 に統合 (2026-04-10) -->

# Receiver + MessageBus Architecture v0.2.0-rc2 改訂提案

> Base: `agent-com-receiver-architecture.md` (v0.1.0, 2026-04-08)
> 起草: Arc, 2026-04-08
> レビュー状況: CTO ✅ APPROVED (2026-04-08), agent-com Dev ✅ Approve with clarifications (2026-04-08)
> ステータス: RC2（CTO + agent-com Dev 両レビュー反映済み → Q1 PoC spike → ADR-041起草）

---

## 0. 改訂の目的

v0.1.0 のコアアーキテクチャ（1 receiver + DB MessageBus + bot MCP subscribe）は健全。Slack bot/Discord bot基盤で実績ある定番パターンであり、現在の「同一トークン Gateway 二重接続」問題を構造的に解決する。

ただし v0.1.0 の仕様書には **実装着手前に詰めるべきギャップが 9 件** ある。本提案はそれらを埋める。設計の根本変更ではなく **記述漏れ・詰め不足の補完** である。

---

## 1. 改訂サマリ

| ID | 重大度 | 項目 | v0.1.0 該当 |
|----|--------|------|-------------|
| C1 | Critical | アプリmessage_id（UUID）↔ Discord message_id 対応 | §6.3, §7.2 |
| C2 | Critical | sendツールでの routeInbound 権限チェック統一 | §8.2 |
| C3 | Critical | reply_to 必須緩和 + proactive 送信パス | §8.2 |
| C4 | Critical | pg_notify overflow 受信側ロジック | §5 |
| C5 | Critical | 専用 receiver bot 推奨に変更 | §7.3 |
| H1 | High | Receiver SPOF: Discord REST catch-up | §13.1 |
| H2 | High | 移行戦略（big-bang vs incremental） | §18 |
| H3 | High | Outbound Discord rate limit 対策 | §7.2 |
| H4 | High | Receiver 内 channel/agents キャッシュ | §7.2 |

---

## 2. Critical 修正

### C1. message_id 対応関係（UUID ↔ Discord ID）

**問題**

v0.1.0 §8.2 sendツールは `crypto.randomUUID()` で message_id を生成して DB INSERT する。一方 §7.2 outbound ハンドラは Discord REST API でそのまま投稿し、Discord native message ID（snowflake）を保存しない。

結果: bot間 reply chain が機能しない。

- bot A が「メンションされてます」に返信するとき、reply_to に DB UUID を指定
- 送信時点で Discord 上の native message ID は未取得
- Discord は native ID で reply 関係を表現するため、reply chain がフラットに見える
- Discord 上から CEO が「誰へのreply？」を視認できない

**修正方針**

1. `agent_messages` テーブルに `discord_message_id TEXT` カラムを追加
2. **既存 inbound 行の backfill**（agent-com-devレビュー反映）:
   - 現コードは既に `metadata->>'discord_message_id'` に Discord native ID を保存済み
   - ALTER TABLE 直後の migration で `metadata` から新カラムへ backfill する
   - backfill が無いと SQLite モードの「receiver は必ず埋める前提」が旧データで成立しなくなる
3. outbound ハンドラは REST 投稿後にレスポンスから native ID を取得し UPDATE
4. inbound ハンドラ（receiver）も Discord native ID を保存
5. reply_to の解決時に `discord_message_id` でも検索可能にする
6. 旧データの存在しないメッセージ（受信前のreply先）への対応として、reply_to が見つからない場合はwarning log + reply無しで送信継続

**修正後コード（マイグレーション）**

```sql
-- §6.3 SQLite schema および PostgreSQL schema 共通
-- Step 1: カラム追加
ALTER TABLE agent_messages ADD COLUMN discord_message_id TEXT;
CREATE INDEX idx_agent_messages_discord_id ON agent_messages(discord_message_id);

-- Step 2: 既存 inbound 行の backfill（agent-com-devレビュー反映）
-- 現コードは既に metadata->>'discord_message_id' に Discord native ID を保存済み
UPDATE agent_messages
   SET discord_message_id = metadata->>'discord_message_id'
 WHERE direction = 'inbound'
   AND metadata ? 'discord_message_id';

-- Step 3: Step 2 で埋まらなかった outbound 行の扱い
-- outbound 行は backfill 不可（REST POST 時の応答を当時保存していなかったため）
-- → NULL のまま運用。reply_to 解決時に NULL fallback で対応
```

```typescript
// §7.2 outbound handler 修正
await bus.subscribe("outbound", async (payload) => {
  try {
    const { app_message_id, agent_id, channel_id, thread_id, content,
            reply_to, attachments } = payload;

    const token = await db.getAgentDiscordToken(agent_id);
    const externalId = await db.resolveToDiscord(channel_id, thread_id);

    // reply_to → Discord native ID 解決
    let discordReplyId: string | null = null;
    if (reply_to) {
      const original = await db.getMessage(reply_to);
      discordReplyId = original?.discord_message_id ?? null;
      // 解決失敗時は警告ログのみ、reply無しで送信継続
      if (reply_to && !discordReplyId) {
        console.warn(`reply_to ${reply_to} has no discord_message_id, sending without reply reference`);
      }
    }

    // REST投稿
    const discordMsg = await sendToDiscordREST({
      token,
      channelId: externalId,
      content,
      attachments,
      replyToDiscordId: discordReplyId,
    });

    // Discord native ID を保存
    await db.updateMessageDiscordId(app_message_id, discordMsg.id);
  } catch (err) {
    // ... エラーハンドリング
  }
});
```

```typescript
// §7.2 receiver inbound 修正（discordToUnified内）
async function discordToUnified(msg: Message, db: DbAdapter): Promise<UnifiedMessage> {
  return {
    id: crypto.randomUUID(),               // アプリ側UUID
    discord_message_id: msg.id,            // Discord native ID（追加）
    channel_id: msg.channelId,
    // ...既存フィールド
  };
}
```

**影響範囲**

- DB スキーマ変更（マイグレーション必要、ALTER TABLE 1本）
- outbound payload に `app_message_id`, `reply_to` 追加（既存型定義拡張）
- inbound 処理で discord_message_id 保存
- bot側 reply_to 解決時のロジック

---

### C2. sendツールでの routeInbound 権限チェック統一

**問題（agent-com-devレビュー反映で訂正）**

v0.1.0 doc の「§8.2 sendツールは routeInbound を経由しない」という記述は **現コードと食い違っている**。現コード (`server.ts:2040, server.ts:2149`) は:
- `dest.members.includes(agentId)` で NOT_A_MEMBER を既にチェックしている
- `routeInbound(...)` を既に呼び出して delivery filter を適用している

**実際の問題は「2 経路で重複実装されている」こと**:
- receiver inbound と sendツール で channels.members チェックと routeInbound 呼び出しが別々に書かれている
- 両方のパスを同期的にメンテナンスする必要があり、片方だけ改修されると挙動不整合が起きる
- 実際 ADR-037 以降の変更で receiver 側だけ新仕様、sendツール側は旧仕様のまま残る事故が発生した（本日の事故の一因）

**修正方針**

`routeInbound()` を **両経路で共有可能な純粋関数** として統一する。現状 2 経路で重複しているロジックを 1 関数に集約する:

1. `routeInbound(message, channel, agents)` のシグネチャを `routeMessage(message, channel, agents, sourceType)` に変更
2. `sourceType: 'inbound' | 'send-tool' | 'cli'` を追加
3. sendツール内で `routeMessage()` を呼び出し、`pushTargets` と `dropTargets` を取得
4. `dropTargets` に対しては bot に `error` を返す（「channel メンバー外への送信は不可」等）
5. **メンテナンス観点の最大メリット**: 今後 routing ロジックを改修する際、1 関数を直せば両経路に反映される

**修正後コード**

```typescript
// core/route-message.ts
interface RouteResult {
  pushTargets: string[];        // 配信対象agent_id
  dropTargets: Record<string, string>;  // {agentId: 'NOT_A_MEMBER' | 'NOT_MENTIONED' | ...}
  senderViolation?: string;     // 送信者自身の権限違反
}

function routeMessage(
  message: UnifiedMessage,
  channel: Channel,
  agents: Agent[],
  sourceType: 'inbound' | 'send-tool' | 'cli'
): RouteResult {
  // 送信者がチャンネルに所属しているか
  if (sourceType !== 'inbound') {
    if (!channel.members.includes(message.author_id)) {
      return {
        pushTargets: [],
        dropTargets: {},
        senderViolation: 'SENDER_NOT_A_MEMBER',
      };
    }
  }

  // 既存のreceiver側ロジック（mentions判定 / observer / bot有効性）
  // ...
}
```

```typescript
// §8.2 sendツール 修正
server.tool("send", {...}, async (params) => {
  // ... reply_to/mentions バリデーション

  // 4.5 routeMessage で送信権限+配信対象決定
  const channel = await db.getChannel(original.channel_id);
  const agents = await db.getAgents();
  const route = routeMessage(
    {
      author_id: agentId,
      channel_id: original.channel_id,
      mentions: params.mentions,
      // ...
    },
    channel,
    agents,
    'send-tool'
  );

  if (route.senderViolation) {
    return error(route.senderViolation,
      `送信者 ${agentId} はチャンネル ${original.channel_id} のメンバーではありません`);
  }

  if (route.pushTargets.length === 0) {
    return error('NO_VALID_TARGETS',
      `mentions に指定された全エージェントが配信対象外: ${JSON.stringify(route.dropTargets)}`);
  }

  // 5. DB INSERT
  const messageId = await db.insertMessage({...});

  // 6. routeMessage が決定した pushTargets のみに配信
  for (const targetId of route.pushTargets) {
    await bus.publish(`bot_${targetId}`, {...});
  }

  // 7. outbound publish
  await bus.publish("outbound", {...});

  return { success: true, message_id: messageId, dropped: route.dropTargets };
});
```

**影響範囲**

- `core/route-inbound.ts` を `core/route-message.ts` に改名 + シグネチャ変更
- §7.2 receiver も新シグネチャに合わせて `routeMessage(unified, channel, agents, 'inbound')` 呼び出し
- §8.2 sendツール内で `routeMessage` を呼ぶ
- テストケース追加（送信時の channels.members 違反パターン）

---

### C3. reply_to 必須緩和 + proactive 送信パス

**問題**

v0.1.0 §8.2 step 1: `if (!params.reply_to) return error("NO_REPLY_TO")` で reply_to を必須にしている。

これにより以下のユースケースが **構造的に不可能** になる:

1. cron 起動の定時報告（heartbeat、daily summary、watchdog アラート）
2. agent-memory からの proactive 通知（タスク期限近い等）
3. 新規 Bot 起動時の "起動しました" 自己報告
4. 別チャンネルへの能動的なクロスポスト

**修正方針**

sendツールに **2 つの送信モード** を仕様上明確化する:

- **Mode A: reply モード** — `reply_to` 必須。返信先メッセージから channel/thread を解決
- **Mode B: proactive モード** — `channel_id`（必須）+ `thread_id`（任意）を直接指定

```
sendツールの引数バリデーション:
  reply_to が指定されている → Mode A
  channel_id が指定されている → Mode B
  どちらも無い → エラー
  両方ある → エラー（明示的にどちらか選ばせる）
```

Mode B では `channels.members` チェックは Mode A と同じく適用される（C2 の修正と整合）。

**Mode B セキュリティ拡張ポイント（CTOレビュー反映）**

将来 ADR-033 / SSOT-5 のチャンネル role ベース発信権限 check を Mode B に追加可能な形で設計する。現時点では `channels.members` チェックのみだが、将来的に `channels.roles[agent_id].can_send_proactive` のような role check を挿入できる拡張ポイントを残す。v0.2.0 では実装しないが spec に明記する。

**PR#89 との連続性（agent-com-devレビュー反映）**

PR#89 (commit `d61a86d`, 2026-04-08朝) で「reply_to 必須、last_received_context 廃止」を SSOT §4.2 に明記してマージ済み。Mode B はこれを覆す形に見えるが、実際は **拡張** として位置付ける:

| 観点 | last_received_context (廃止済み) | Mode B proactive (v0.2.0 で導入) |
|------|----------------------------------|---------------------------------|
| 状態 | 暗黙（bot 内部状態に依存） | 明示（引数で channel_id 指定） |
| 決定論性 | 非決定論的（内部状態で挙動変化） | 決定論的（引数のみで決まる） |
| ユースケース | 「なんとなく前回の場所へ」 | cron / proactive / crossposting |
| 権限チェック | 暗黙状態に依存 | channels.members で明示検証 |

**本質的な違い**: explicit > implicit。bot が明示的に渡すので非決定論性がない。cron / proactive のユースケースをカバーするため必要な拡張であり、PR#89 の「暗黙状態廃止」という方針とは矛盾しない。

**ADR での位置づけ**:
- PR#89: Mode A (reply) の実装と暗黙状態廃止
- ADR-041: Mode A + Mode B（proactive 拡張）
- PR#89 は Superseded ではなく、ADR-041 で機能拡張される形

**修正後コード**

```typescript
server.tool("send", {
  description: `メッセージを送信します。reply_to または channel_id のいずれか必須。`,
  params: {
    mentions: { type: "array", items: { type: "string" }, required: true },
    content: { type: "string", required: true },
    reply_to: { type: "string", optional: true },     // Mode A
    channel_id: { type: "string", optional: true },   // Mode B
    thread_id: { type: "string", optional: true },    // Mode B
    attachments: { type: "array", items: { type: "string" }, optional: true },
  },
}, async (params) => {
  // 1. モード判定
  const mode: 'reply' | 'proactive' =
    params.reply_to && !params.channel_id ? 'reply' :
    params.channel_id && !params.reply_to ? 'proactive' :
    null;

  if (!mode) {
    return error("INVALID_DESTINATION",
      "reply_to または channel_id のいずれか1つを指定してください");
  }

  // 2. 宛先解決
  let channelId: string;
  let threadId: string | undefined;
  let originalMsg: Message | undefined;

  if (mode === 'reply') {
    originalMsg = await db.getMessage(params.reply_to);
    if (!originalMsg) {
      return error("MESSAGE_NOT_FOUND",
        `reply_to '${params.reply_to}' が見つかりません`);
    }
    channelId = originalMsg.channel_id;
    threadId = originalMsg.thread_id;
  } else {
    channelId = params.channel_id;
    threadId = params.thread_id;
  }

  // 3. mentions バリデーション
  if (!params.mentions || params.mentions.length === 0) {
    return error("NOT_MENTIONED",
      "mentions配列にagent_idを1つ以上指定してください");
  }

  // 4. routeMessage で権限チェック（C2 で追加）
  // ... (C2 と同じ)

  // 5. DB INSERT
  // 6. bus.publish
  // 7. outbound publish
});
```

**proactive モードのユースケース例**

```typescript
// cron heartbeat
await send({
  channel_id: "channel_executive",
  mentions: ["ceo"],
  content: "[heartbeat] CTO 正常稼働中",
  message_type: "report",
});

// watchdog アラート
await send({
  channel_id: "channel_dev_arc",
  mentions: ["arc", "cto"],
  content: "[alert] hotel-dev offline 5分以上",
  message_type: "emergency",
});
```

**影響範囲**

- sendツールのスキーマ拡張（後方互換: reply_to のみの旧呼び出しは Mode A として動作）
- agent-comms-cli の `notify` コマンドは proactive モードのラッパーとして実装
- ドキュメント: 各Botの利用ガイドに2モードを記載

---

### C4. pg_notify は ID-only, subscriber は DB pull (α方式)

**問題（agent-com-dev + CTO レビュー反映で方針変更）**

v0.1.0 の原文は pg_notify の payload に content を入れる前提（payload-in-notify）で、8KB 超時に overflow テーブルへ fallback する設計だった（β方式）。しかし:

- Postgres NOTIFY payload 8000 byte はハード制約、境界条件で静かに壊れるバグが最悪
- overflow logic の試験面積が大きい（payload の 8KB 境界/overflow分岐/consumed管理）
- **現コード（`server.ts:2132`）は既に pg_notify payload を `{event, to, message_id, channel_id}` のみ（~100 byte）にしており、subscribe 側は ID で DB から SELECT する pull-on-notify モデル（α方式）で稼働中**
- 本日の事故でも pg_notify 経路は健全だった実績あり

**修正方針: α (pull-on-notify) を採用**

pg_notify は ID 通知のみ、実体は DB から SELECT する方式に統一する。overflow テーブル・overflow分岐・consumed管理は **不要**。

| 観点 | α (採用: pull-on-notify) | β (不採用: payload-in-notify + overflow) |
|------|---|---|
| pg_notify payload | `{event, message_id}` (~100 byte) | 実ペイロード全体 (8KB超時 overflow) |
| DBクエリ/msg | +1 (SELECT) | 0（overflow時+1） |
| 8KB制約 | 不要 | ハード制約、境界 bug リスク |
| 試験面積 | 小 | 大（overflow分岐、consumed管理） |
| 現実装との整合 | 整合（既に α） | 乖離 |
| v0.2.0 の本質 | 維持（構造改善） | 維持（但し最適化は本質ではない） |

**修正後コード (α方式)**

```typescript
// shared/pg-message-bus.ts

class PgMessageBus implements MessageBus {
  private listenClient: Client;
  private publishClient: Client;
  private handlers: Map<string, (payload: PushPayload) => void> = new Map();
  private db: DbAdapter;  // α方式: DB pull のため DB adapter を保持

  constructor(private databaseUrl: string, db: DbAdapter) {
    this.db = db;
  }

  async publish(channel: string, payload: PushPayload): Promise<void> {
    // α方式: ID のみを notify、実体は既に DB にある
    const notifyPayload = JSON.stringify({
      event: payload.event ?? 'message',
      message_id: payload.message_id,
      // 他のフィールドは DB から取得
    });
    // 100-200 byte なので NOTIFY 8KB 制約に触れない
    await this.publishClient.query(
      "SELECT pg_notify($1, $2)",
      [channel, notifyPayload]
    );
  }

  async init(): Promise<void> {
    // ... 既存

    this.listenClient.on("notification", async (msg) => {
      const handler = this.handlers.get(msg.channel);
      if (!handler) return;

      try {
        const notif = JSON.parse(msg.payload);
        // α方式: ID から実体を DB pull
        const fullMessage = await this.db.getMessage(notif.message_id);
        if (!fullMessage) {
          console.warn(`Message ${notif.message_id} not found in DB, skipping`);
          return;
        }
        handler(this.messageToPushPayload(fullMessage));
      } catch (e) {
        console.error(`Failed to handle notification on ${msg.channel}:`, e);
      }
    });
  }

  private messageToPushPayload(msg: Message): PushPayload {
    return {
      message_id: msg.id,
      channel_id: msg.channel_id,
      thread_id: msg.thread_id,
      author_id: msg.author_id,
      mentions: msg.mentions,
      content: msg.content,
      reply_to: msg.reply_to,
      attachments: msg.attachments,
      message_type: msg.message_type,
      timestamp: msg.created_at,
    };
  }
}
```

**影響範囲**

- PgMessageBus は DB adapter を注入する設計に変更（publish/subscribe 両方）
- `message_bus_overflow` テーブル・cleanup cron は **不要**（削除）
- payload 構造は `{event, message_id}` のみに統一

**不採用となった β方式（参考記録）**

payload-in-notify + overflow fallback 方式。採用しなかった理由:
- Postgres NOTIFY 8KB ハード制約は境界 bug の温床
- overflow logic の試験面積が大きい
- v0.2.0 の本質は構造改善であり payload 最適化は副次的
- 現実装が既に α方式で稼働実績あり

---

### C5. 専用 receiver bot 推奨に変更

**問題**

v0.1.0 §7.3 は「receiver token は既存 bot を流用」を推奨している。しかしこれは:

- receiver process が CTO token で Discord Gateway 接続（受信用、intents フル）
- §9 presence client を CTO で起動した場合、**CTO token が Gateway × 2** になる
- まさに今回の「同一トークン二重接続」問題が再発する

**修正方針**

§7.3 を **A 案（専用 receiver bot 新規作成）推奨** に書き換える。Discord Developer Portal で新規 Bot Application を作成するのは 5 分の作業であり、責務分離が圧倒的に明確になる。

**修正後の§7.3**

```
### 7.3 Receiver Token 選定

【推奨: A. 専用 receiver bot を新規作成】

  → Discord Developer Portal で新規 Bot Application を作成
  → Bot 名: "agent-com-receiver"
  → 必要 intents: Guilds, GuildMessages, MessageContent, DirectMessages
  → 必要 permissions: View Channels, Read Message History
  → guild に invite

メリット:
  - 責務が完全に分離（受信専用 / 送信専用）
  - 既存 bot の Gateway 接続に一切影響しない
  - presence client との二重接続問題が構造的に発生しない
  - Discord 上で「agent-com-receiver」が常時オンラインになり、システム全体の生死が一目で分かる

デメリット:
  - Bot Application 1 つ追加（Discord 側の bot 数制限は 1 ユーザー 10〜20 程度なので問題にならない）
  - .env に DISCORD_TOKEN_RECEIVER 追加

【非推奨: B. 既存 bot を流用】

  v0.1.0 では推奨していたが v0.2.0 で非推奨に変更。
  理由:
    - presence client との同一トークン二重接続が発生する
    - 受信専用 bot と送信兼用 bot で intents 設定が混乱する
    - 障害時の責務切り分けが困難

設定例:
  AGENT_COM_RECEIVER_TOKEN=（新規作成した receiver bot token）
```

**トークン分離方針（agent-com-devレビュー反映）**

receive と send のトークンを明示的に分離する:

```
receive: 1個の `agent-com-receiver` bot token
  → Gateway intents: Guilds + GuildMessages + MessageContent + DirectMessages フル
  → Discord Gateway 接続（1セッション）
  → 全チャンネルの messageCreate を受信
  → REST は使わない

send: N個の per-agent bot token
  → Gateway は使わない（presence client オプション時のみ intents 空で接続）
  → REST POST でのみ Discord に投稿
  → 各 bot が自分の名前で発言する視点を維持
```

**二重視点の実現**:
- Discord 上では各 bot が自分のアイコン・名前で発言（send は per-agent token）
- 受信は 1 体（receiver）に集約（Gateway 接続の乱立を防止）
- proposal §7.2 の `db.getAgentDiscordToken(agent_id)` は send 時の per-agent token 取得に該当

**影響範囲**

- §7.3 文章書き換え
- 設定一覧（§16）に `DISCORD_TOKEN_RECEIVER` 追加
- セットアップ手順（§15）に「Discord Developer Portal で receiver bot 作成」を追加
- 既存 .env から AGENT_COM_RECEIVER_TOKEN を読む
- per-agent token は既存の `DISCORD_TOKEN_{AGENT_ID}` パターンを維持

---

## 3. High 修正

### H1. Receiver SPOF: Discord REST catch-up

**問題**

v0.1.0 §13.1: 「receiver が長時間停止した場合 → 各 bot が inbox() で未読取得」と書かれているが、receiver が唯一の DB INSERT 元なので、receiver 停止中のメッセージは **どこにも存在しない**。inbox() は DB を見るだけなので復旧不可能。

Discord Gateway resume window は約 5 分。これを超えた瞬間 Discord 側の missed events も取得できなくなる（Gateway session 失効）。

**修正方針**

receiver 起動時に **Discord REST API で各 channel の最新メッセージから現在時刻まで取得して INSERT** する catch-up フェーズを追加する。

```
1. receiver 起動
2. Discord Gateway 接続（Ready イベント待ち）
3. Catch-up フェーズ:
   - DB から「最後に INSERT した Discord message ID」を channel ごとに取得
   - Discord REST API で `GET /channels/{id}/messages?after={last_id}&limit=100` をループ
   - 取得した全メッセージを通常の inbound 処理パイプラインに流す
   - 通常の messageCreate ハンドラと同じ routeMessage → DB INSERT → bus.publish
4. Catch-up 完了 → 通常の Gateway イベント処理開始
```

**修正後コード**

```typescript
// src/receiver.ts に追加

receiverClient.on("ready", async () => {
  console.log(`Receiver online as ${receiverClient.user?.tag}`);

  // Catch-up フェーズ
  await runCatchup(receiverClient, db);

  console.log("Catch-up complete, starting normal Gateway processing");
});

async function runCatchup(client: Client, db: DbAdapter): Promise<void> {
  const channels = await db.getAllChannelsWithDiscordMapping();

  for (const ch of channels) {
    try {
      const lastSeenDiscordId = await db.getLastSeenDiscordIdInChannel(ch.id);
      const discordChannel = await client.channels.fetch(ch.discord_external_id);

      if (!discordChannel?.isTextBased()) continue;

      // 最大 100 件 × 10 ページ = 1000 件まで catch-up
      let after = lastSeenDiscordId ?? undefined;
      for (let page = 0; page < 10; page++) {
        const messages = await discordChannel.messages.fetch({
          after,
          limit: 100,
        });
        if (messages.size === 0) break;

        // 古い順に処理
        const sorted = [...messages.values()].reverse();
        for (const msg of sorted) {
          await processInboundMessage(msg, db, bus);
          after = msg.id;
        }
      }
    } catch (err) {
      console.error(`Catch-up failed for channel ${ch.id}:`, err);
      // 1 channel の失敗は他に影響しない
    }
  }
}
```

**影響範囲**

- `processInboundMessage()` を Gateway イベントハンドラから関数として分離
- DB に `getLastSeenDiscordIdInChannel(channelId)` メソッド追加
- 起動時間が遅延（catch-up時間 = 未処理メッセージ数 × API 呼び出し）
- §13.1 の文章書き換え

**cold-start 初回起動時の扱い（agent-com-devレビュー反映）**

`lastSeenDiscordId` が NULL の場合（初回起動）、`messages.fetch({after: undefined, limit: 100})` は最新100件を返してしまい、**全channel × 100件の re-fetch noise** が発生する。ON CONFLICT DO NOTHING で重複は弾けるが catch-up 時間が無駄に長くなる。

```typescript
// 初回起動時: lastSeenDiscordId が NULL なら「現在時刻の snowflake」を生成して skip
async function runCatchup(client: Client, db: DbAdapter): Promise<void> {
  const channels = await db.getAllChannelsWithDiscordMapping();

  for (const ch of channels) {
    let lastSeenDiscordId = await db.getLastSeenDiscordIdInChannel(ch.id);

    if (!lastSeenDiscordId) {
      // cold-start: 現在時刻を snowflake 化して「過去メッセージは無視」状態にする
      // Discord snowflake = (unix_ms - 1420070400000) << 22
      const nowSnowflake = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
      await db.setLastSeenDiscordIdInChannel(ch.id, nowSnowflake);
      console.log(`[catch-up] cold-start for channel ${ch.id}, skipping history before ${nowSnowflake}`);
      continue;
    }
    // ... 通常 catch-up
  }
}
```

**並列度上限 & health check degraded（agent-com-devレビュー反映）**

16 channel × 最大1000件 = 16,000 REST req を順次実行すると 5-10 分。catch-up 中は以下を明示:

- health check endpoint は `{ status: "degraded", catchup_in_progress: true }` を返す
- receiver の outbound queue は catch-up 完了まで flush を遅延（outbound 自体は DB 保存済みなので失われない）
- @discordjs/rest の rate limit 自動制御に任せる（並列ではなく順次 fetch）

**operator alert の宛先 channel（agent-com-devレビュー反映）**

1000件cap到達 / catch-up失敗 / receiver crash 時の alert 送信先:

- デフォルト: **`#alerts` channel**（新規作成 or 既存 #dev-arc を流用）
- 実装: `channel_adapters` テーブルに `agent-comms-alerts` チャンネルを登録
- 環境変数: `AGENT_COM_ALERT_CHANNEL_ID`（Discord channel ID を指定）
- 未設定時: Telegram CEO 通知のみ

**1000件cap到達時の運用対応（CTOレビュー反映）**

catch-up が 1000 件 cap に達した場合は以下を必須とする:

1. **operator alert 発火**: Telegram CEO 通知 / Discord #alerts チャンネルへの自動投稿
2. **agent-memory への記録**: ADR-035 に従い、`knowledge` テーブルに `receiver_catchup_cap_reached` タグで記録
3. **ログに対象 channel 一覧を出力**: どの channel が cap に達したかを特定可能にする

```typescript
if (page === 9 && messages.size === 100) {
  // 1000件 cap に到達した可能性あり
  const alertMsg = `Receiver catch-up cap reached on channel ${ch.id} (${ch.name}). Potential message loss.`;
  console.error(alertMsg);
  await notifyOperator(alertMsg);  // Telegram + Discord
  await db.recordKnowledge({
    tag: 'receiver_catchup_cap_reached',
    content: alertMsg,
    channel_id: ch.id,
    timestamp: new Date().toISOString(),
  });
}
```

**catch-up中のoutbound滞り対策**

catch-up が走っている間、outbound ハンドラも同じ receiver プロセス内で動くため滞りのリスクあり。対策:

- catch-up は Ready イベント直後の **1 回のみ** 実行（通常運用中は発火しない）
- catch-up フェーズ中は outbound queue を持ち、完了後に flush する
- Discord rate limit は @discordjs/rest が自動管理するので、catch-up中の REST 呼び出しと outbound 送信が競合しても自動シリアライズされる

**残課題（v0.2.0 では未対応で記録のみ）**

- Discord Gateway sessionが切れている間に**チャンネルから削除された**メッセージは catch-up 不能
- > 1000 件の missed events は trim される（cap到達時は operator alert）

---

### H2. 移行戦略（big-bang vs incremental）

**問題**

v0.1.0 §18 は Phase 1-7 の実装順だけで、「移行中は旧 stdio Bot と新 receiver Bot が共存可能か？」が未定義。実質 big-bang 切り替え前提だが、ロールバック計画もない。

**修正方針**

§18 に **移行戦略セクション** を追加し、**incremental 移行** を推奨する。

```
### 18.1 移行モード

receiver は以下の起動モードを持つ:

  - mode=full        : 全 Bot を new 方式で運用（最終形）
  - mode=mixed       : new 方式 Bot + 旧方式 Bot の共存
  - mode=disabled    : receiver 自体を起動しない（旧方式のみ）

mixed モード時の動作:
  - receiver は Gateway で受信した全メッセージを DB INSERT
  - new 方式 Bot（subscribe あり）には pg_notify で配信
  - 旧方式 Bot（channel plugin 等）は従来通り Discord push を直接受ける
  - DB INSERT は両方式に共通（旧方式 Bot も DB の inbox から取得可能）

### 18.2 移行手順（incremental）

  Phase A: receiver デプロイ + mixed モード起動
    - 旧方式 Bot は何も変えない
    - DB INSERT が二重化する可能性あり（旧 stdio MCP も INSERT、receiver も INSERT）
    - → discord_message_id でユニーク制約を入れて二重 INSERT を弾く

  Phase B: Bot を 1 体ずつ new 方式に切り替え
    - .mcp.json を receiver+bus subscribe 構成に変更
    - 旧 stdio MCP プロセスを終了
    - 24-48h 検証
    - 問題なければ次の Bot

  Phase C: 全 Bot 切り替え完了 → mode=full に変更
    - receiver の DB INSERT 重複検知ロジックを撤去
    - 旧 stdio MCP コードを削除可能に
```

**追加: ユニーク制約**

```sql
-- PostgreSQL: partial unique index で NULL を許容
CREATE UNIQUE INDEX uq_agent_messages_discord_id
  ON agent_messages (discord_message_id)
  WHERE discord_message_id IS NOT NULL;

-- SQLite: partial unique index は未サポート。
-- 代わりに SQLite モードでは receiver が必ず discord_message_id を埋める前提とし、
-- full NOT NULL UNIQUE 制約を適用する。
-- → inbound (Discord 由来): Discord native ID を常に保存
-- → outbound (bot sendツール): REST POST 後の Discord native ID を常に UPDATE
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_messages_discord_id
  ON agent_messages (discord_message_id);
```

**no-op INSERT のハンドリング（agent-com-devレビュー反映、必須）**

mixed モード期間中、receiver と旧 daemon が同じ Discord メッセージで競合 INSERT する可能性がある。`ON CONFLICT DO NOTHING` で 1 行に確定するが、**敗者側の `handleInboundMessage` は INSERT を no-op として正しくハンドルする必要がある**。

現コード `handleInboundMessage` (`server.ts:1370`) は INSERT 結果の `messageId` を信頼して `metadata.to` UPDATE と push を実行する。`ON CONFLICT DO NOTHING` 時は `INSERT ... RETURNING id` が空を返すので `messageId` が undefined → **push が機能しない事故が Phase A デプロイ直後に発生する可能性が高い**。

**必須実装ロジック**:

```typescript
// handleInboundMessage 内の INSERT 処理
const insertResult = await db.insertMessageOnConflict(unified);
let messageId = insertResult?.id;

if (!messageId) {
  // ON CONFLICT DO NOTHING で敗者側になった（別プロセスが既にINSERT済み）
  // 既存行を SELECT して id を取得し、downstream を続行
  const existing = await db.getMessageByDiscordId(unified.discord_message_id);
  if (!existing) {
    // 通常起こらない: INSERT も SELECT も失敗 → エラーログのみ
    console.error(`INSERT no-op but SELECT also failed for ${unified.discord_message_id}`);
    return;
  }
  messageId = existing.id;
  console.debug(`[dedup] INSERT no-op, continuing with existing id=${messageId}`);
}

// downstream 続行（metadata.to UPDATE, push, routeMessage）
await db.updateMessageMetadata(messageId, { to: route.pushTargets });
for (const targetId of route.pushTargets) {
  await bus.publish(`bot_${targetId}`, { event: 'message', message_id: messageId });
}
```

**DB adapter メソッド追加**:

- `insertMessageOnConflict(msg)`: `INSERT ... ON CONFLICT (discord_message_id) DO NOTHING RETURNING id`
- `getMessageByDiscordId(discordId)`: fallback SELECT

**テストケース要件**:
1. receiver と旧 daemon が同時 INSERT → 1 行に確定、両方の push が成功
2. 既存行が存在する状態で再 INSERT → SELECT fallback で id 取得、push 成功
3. INSERT も SELECT も失敗（通常起こらない）→ エラーログ + downstream skip

**SQLite モードの制約事項（CTOレビュー反映 Q2）**

SQLite は partial unique index をサポートしないため、**SQLite モードでは receiver は必ず `discord_message_id` を埋める** 前提とする。

- inbound: receiver の `discordToUnified()` で Discord native ID を必須として UnifiedMessage に入れる
- outbound: bot sendツールが DB INSERT する時点では NULL だが、直後に receiver の outbound ハンドラが REST POST → UPDATE で埋める
- UPDATE まで完了する前の別プロセスから見えると NULL UNIQUE 違反の可能性 → 対策: sendツール経路の INSERT は transaction 内で INSERT + UPDATE を行う

**Phase B の Bot 切り替え順序（CTOレビュー反映）**

Phase B（bot 1 体ずつ new 方式切り替え）の具体的な順序は v0.2.0 spec では決め打ちせず、**PoC 後の別計画として詰める**。判断基準は以下を想定:

- 低リスク順: 開発専用 bot（テスト用）→ 監査系 → 二次的 dev bot → 主要 dev bot → 上位レイヤ（CTO/Arc/CEO関連）
- 各 bot の 24-48h 検証で観察すべき指標: notification 欠落率、reply chain 成功率、outbound 遅延、メモリ使用量
- ロールバック判断基準: 欠落率 > 1% / chain 成功率 < 99% / P95 遅延 > 5s

**影響範囲**

- §18 全面書き換え
- receiver に `mode` 環境変数追加
- DB ユニーク制約追加（PG: partial / SQLite: full、DBアダプタ層で分岐）
- Phase B 切替計画は別文書として PoC 後に作成

---

### H3. Outbound Discord rate limit 対策

**問題**

v0.1.0 §7.2 outbound ハンドラは `await sendToDiscordREST(...)` を直接呼ぶだけで、Discord rate limit 対応なし。

Discord REST limit:
- グローバル: 50 req/sec/bot token
- チャンネル別: 5 req/sec
- 429 応答時の Retry-After 必要

複数 bot から同時送信が殺到すると 429 連発で全Bot 沈黙の可能性。

**修正方針**

`@discordjs/rest` ライブラリを使用。これは built-in で rate limit 管理・retry・queue を持つ。

```typescript
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

// bot ごとに REST クライアントをキャッシュ（token ごとに別インスタンス）
const restClients = new Map<string, REST>();

function getRestClient(token: string): REST {
  let client = restClients.get(token);
  if (!client) {
    client = new REST({
      version: "10",
      retries: 3,
      timeout: 15_000,
      // @discordjs/rest が自動で rate limit を尊重
    }).setToken(token);
    restClients.set(token, client);
  }
  return client;
}

async function sendToDiscordREST({
  token, channelId, content, attachments, replyToDiscordId
}): Promise<{ id: string }> {
  const rest = getRestClient(token);

  const body: any = { content };
  if (replyToDiscordId) {
    body.message_reference = {
      message_id: replyToDiscordId,
      fail_if_not_exists: false,
    };
  }
  // attachments 処理は別途

  const result = await rest.post(Routes.channelMessages(channelId), {
    body,
  }) as { id: string };

  return result;
}
```

**影響範囲**

- `@discordjs/rest` 依存追加（既に discord.js が依存しているので実質追加なし）
- §7.2 outbound ハンドラ実装変更
- 同時送信負荷テスト追加

---

### H4. Receiver 内 channel/agents キャッシュ

**問題**

v0.1.0 §7.2 messageCreate ハンドラは毎メッセージで:
```typescript
const channel = await db.getChannel(unified.channel_id);
const agents = await db.getAgents();
```
を実行する。channels と agents の更新頻度は低い（数時間に 1 回程度）が、メッセージは秒単位で発生する。1 メッセージあたり 2 DB クエリは無駄。

**修正方針**

receiver プロセス内に **TTL 付き in-memory cache** を持つ。channels/agents の更新は CLI （channel add-member 等）か pg_notify イベント経由で検知して invalidate。

**修正後コード**

```typescript
// shared/cache.ts
class TTLCache<T> {
  private cache: { value: T; expiresAt: number } | null = null;
  constructor(
    private fetcher: () => Promise<T>,
    private ttlMs: number = 60_000,
  ) {}

  async get(): Promise<T> {
    if (this.cache && Date.now() < this.cache.expiresAt) {
      return this.cache.value;
    }
    const value = await this.fetcher();
    this.cache = { value, expiresAt: Date.now() + this.ttlMs };
    return value;
  }

  invalidate(): void {
    this.cache = null;
  }
}

// receiver.ts
const channelsCache = new Map<string, TTLCache<Channel>>();
const agentsCache = new TTLCache(
  () => db.getAgents(),
  60_000,
);

function getChannelCached(channelId: string): Promise<Channel> {
  let cache = channelsCache.get(channelId);
  if (!cache) {
    cache = new TTLCache(() => db.getChannel(channelId), 60_000);
    channelsCache.set(channelId, cache);
  }
  return cache.get();
}

// pg_notify で channel/agent 更新通知を受け取って invalidate
await bus.subscribe("channels_updated", () => {
  channelsCache.clear();
});
await bus.subscribe("agents_updated", () => {
  agentsCache.invalidate();
});
```

**Cache invalidation の発火元（agent-com-devレビュー反映）**

`channels` / `agents` の mutation は複数経路から発生する。**全ての mutation 元が pg_notify を発火する責務を負う**:

| mutation 元 | 発火すべき pg_notify |
|-------------|---------------------|
| CLI `channel add-member / remove-member` (`cli/index.ts`) | `channels_updated` |
| CLI `agent register` | `agents_updated` |
| bot sendツール内の DM auto-create | `channels_updated` |
| migration script（スキーマ変更直後）| `channels_updated`, `agents_updated` |
| Discord 権限ベースの同期 job | `channels_updated` |

**実装要件**:
- 現 CLI コード（`cli/index.ts`）は pg_notify 発火未対応 → 修正必須
- すべての mutation は db wrapper 層で `NOTIFY` を自動発火する設計を推奨（忘れ防止）

**影響範囲**

- `shared/cache.ts` 新規作成
- receiver の messageCreate ハンドラで cache 経由のアクセスに変更
- CLI（channel add-member 等）で `pg_notify('channels_updated', '')` を発火
- bot sendツール の DM auto-create でも同様
- db wrapper 層で mutation 時の NOTIFY を自動化推奨
- agent_messages の INSERT には cache を使わない（必ず最新を取得）

---

## 4. v0.1.0 から変わらないこと

以下は v0.1.0 のまま採用する:

- 全体アーキテクチャ図（§2）
- MessageBus インターフェース（§4）
- Pg/Sqlite MessageBus の基本実装（§5, §6）— C4 の追記のみ
- bot MCP server の subscribe/sendツール骨格（§8）— C2/C3 の追記のみ
- presence client（§9）
- プロセス構成と起動スクリプト（§10）
- メッセージキュー / Receiver ヘルスチェック（§11, §12）
- セキュリティ（§14）
- OSS セットアップ（§15）
- 設定一覧（§16）— `DISCORD_TOKEN_RECEIVER` 追加のみ
- 廃止される旧方式の要素（§17）

---

## 5. 影響範囲サマリ

### DB スキーマ変更

```sql
-- C1
ALTER TABLE agent_messages ADD COLUMN discord_message_id TEXT;
CREATE INDEX idx_agent_messages_discord_id ON agent_messages(discord_message_id);

-- H2（mixed モード時の二重 INSERT 防止）
ALTER TABLE agent_messages
  ADD CONSTRAINT uq_agent_messages_discord_id
  UNIQUE (discord_message_id)
  WHERE discord_message_id IS NOT NULL;
```

### 新規ファイル

- `core/route-message.ts`（routeInbound から改名）
- `shared/cache.ts`
- `migrations/0XX_add_discord_message_id.sql`

### 既存ファイル変更

- `src/receiver.ts`: catch-up フェーズ、cache 利用、route-message 呼び出し
- `src/server.ts` (bot MCP): sendツール 2 モード対応、route-message 呼び出し
- `shared/pg-message-bus.ts`: overflow 受信ロジック
- `docs/RECEIVER_ARCHITECTURE_v0.2.0_SPEC.md`: v0.1.0 を upgrade

### 設定変更

- `.env.example` に `DISCORD_TOKEN_RECEIVER` 追加
- Discord Developer Portal に新規 Bot 1 つ追加

---

## 6. 論点 Q1-Q4（CTOレビュー反映版）

### Q1. PoC スコープ — **最優先で検証** [CTO: 同意]

最重要検証は **MCP `notifications/message` が Claude Code モデルコンテキストに実際に届くか**。

これが No の場合、本設計は push 型として成立しない。

**CTOレビュー追加要件**:

1. **PoC 着手前に 30 分の spike テスト** を単独で実施:
   - 最小構成 MCP server を立てて `server.notification({ method: 'notifications/message', params: {...} })` を呼ぶ
   - Claude Code セッションに push が届くか確認
   - モデルコンテキストに content が注入されているか確認
2. **stdio transport と SSE transport の両方で確認**:
   - stdio は notification 配信が遅延/欠落しやすい可能性
   - SSE の方が notification セマンティクス的には安定のはず
   - 両方の結果を比較
3. **結果を ADR-041 起草前に共有**:
   - spike 結果を #agent-com に投稿
4. **PoC 本体はこの spike 通過後に着手**

**Retreat path: spike NG 時の fallback (a) pull-on-notify 継続（agent-com-dev + CTOレビュー反映、必須）**

spike が NG だった場合でも、v0.2.0 の全面採用見送りではなく **退避路 (a)** で構造改善を成立させる:

| 要素 | push 成功時 (spike OK) | push 失敗時 (spike NG) → retreat (a) |
|------|-------------------------|-----------------------------------|
| receiver | 1プロセスで Discord Gateway 集約 | 同じ |
| DB INSERT 一元化 | ✅ | ✅ |
| routeMessage 統一 | ✅ | ✅ |
| catch-up フェーズ | ✅ | ✅ |
| mixed モード dedup | ✅ | ✅ |
| 配信方式 | pg_notify → subscribe → MCP notification push | **pg_notify → subscribe → inbox pull (従来方式)** |
| 即時性 | 即時 push | ~1秒 polling or inbox check 周期 |

**重要**: Receiver + MessageBus の **構造的価値**（Discord 接続集約 / DB 一元化 / catch-up / dedup）は **push の成否に依存しない**。失うのは push の即時性だけで、これは pull-on-notify 方式で実績あり（本日の事故でも pg_notify 経路は健全）。

**retreat path 選択時の変更点**:
- bot MCP server の `bus.subscribe` ハンドラは MCP notification push を呼ばず、`check_inbox` 経由で bot が能動取得する
- bot は定期的に（例: 5秒ごと）`check_inbox` を呼ぶ
- MCP notification push の仕様は将来 Claude Code 側が対応した時点で再検討

**spike NG = v0.2.0 採用見送り ではなく、spike NG = retreat (a) で進行** を spec の default として明記する。

### Q2. mixed モードの DB INSERT 重複 — [CTO: 決定]

**PostgreSQL**: `ON CONFLICT (discord_message_id) DO NOTHING`
**SQLite**: `INSERT OR IGNORE`

実装時に DB アダプタ層で吸収する。

**SQLite 制約事項（§H2 に追記済み）**: partial unique index 未サポートのため、SQLite モードでは **receiver は必ず `discord_message_id` を埋める前提**。

### Q3. agent-memory との関係 — [CTO: A案で決定]

**A. SQLite モードでは agent-memory は別 DB（完全分離）を採用**

理由: 切り分けの単純さ。C 案（SQLite対応）は agent-memory 側の根本改修なので過剰スコープ。B 案（機能無効化）は履歴喪失なので避ける。

- PoC: A 採用
- 本実装: A 採用（C 案は将来課題として記録のみ）

### Q4. receiver/bot バージョニング — [CTO: 必須化同意]

payload に `schema_version` フィールドを必須化し、receiver/bot 双方で互換性チェック。

**互換性チェック失敗時の挙動（CTOレビュー反映）**:

- **方針: warning + drop**
- receiver は停止しない
- 互換性のない bot への配信だけを silently drop
- warning ログを出力 + agent-memory に `receiver_version_mismatch` タグで記録
- CEO への alert は 5分に 1回以上発生した場合のみ（flood 防止）

```typescript
// receiver の bus.publish 前にバージョンチェック
if (!isCompatible(targetBotVersion, payload.schema_version)) {
  console.warn(`Version mismatch: bot=${targetBotId} expects ${targetBotVersion}, payload=${payload.schema_version}. Dropping.`);
  // agent-memory 記録
  return;
}
```

---

## 7. CTO 追加観点（CTOレビュー反映）

### A1. Receiver crash 中の durability

receiver process が `messageCreate` ハンドラ中（DB INSERT 前）にクラッシュした場合、そのメッセージは一時的に失われる。Discord Gateway の at-least-once 配信を信頼することで、receiver 再起動時の catch-up phase（§H1）がカバーする。

**spec §13.x に明記**:

> receiver crash 時のリカバリは catch-up phase に依存する。INSERT 前にクラッシュしたメッセージは Gateway session 失効前であれば resume で、失効後であれば REST catch-up で復旧する。失効後に 1000 件 cap を超えた場合のみ permanent loss となり、operator alert が発火する。

### A2. Bot MCP subscribe channel の動的更新

各 bot MCP server が subscribe するチャンネル（MessageBus topic）は、`channels.members` に自 agent_id が含まれるチャンネル全て。

**Phase 1（v0.2.0 初期実装）**: bot 起動時に固定。メンバーシップ変更後は **bot 再起動で反映**。

**Phase 1 暫定 CLI（agent-com-devレビュー反映、必須）**:

現在 16 bot 構成でチャンネルメンバー追加のたびに全 bot 再起動はオペレーション負荷が大きい。**該当 bot 1 体だけ再起動できる CLI** を Phase 1 の必須機能とする:

```bash
# 該当 bot 1 体のみ再起動
agent-com restart-bot <agent_id>

# 例: hotel-dev をメンバー追加後、hotel-dev だけ再起動
agent-com restart-bot hotel-dev
```

**実装**: 既存の `mcp__agent-comms__restart_bot` ツール（tmux session 名指定で動作）を CLI ラッパ化する。転用可能なのでコード量は少ない。

**Phase 2（将来課題）**: メンバーシップ変更イベントを pg_notify で bot に通知し、動的に subscribe/unsubscribe する。

**spec §8.x に課題として記録**:

> メンバーシップ変更時の動的 re-subscribe は Phase 2 課題。v0.2.0 では `agent-com restart-bot <agent_id>` で該当 bot だけ再起動する運用で対応する。

### A3. C1 マイグレーション直後の NULL 処理

`ALTER TABLE ADD COLUMN discord_message_id TEXT` 実行直後、**既存行は全て NULL**。

- reply_to 解決時に NULL を引いた場合のフォールバック（警告 + reply無し送信継続）は §C1 で既に定義済み ✅
- **統合テスト追加**: マイグレーション直後の状態で以下を検証:
  1. 既存メッセージを reply_to に指定した send → warning + reply無し送信成功
  2. 新規 inbound メッセージは discord_message_id が埋まることを確認
  3. 新規 outbound メッセージは REST POST 後に UPDATE で埋まることを確認
  4. 混在状態（NULL 行 + 埋まった行）で reply chain が動作することを確認

### A4. ADR-041 起草時の超慎重ポイント

CTO が ADR-041 を起草する際、以下を明示:

1. **ADR-038 (SSE multi-client) は既に ADR-039 (server-discord-removal, 2026-04-07) で Superseded 済み**:
   - ADR-039 は「bot側 Discord コード削除」の WHY を決定 (CEO決定)
   - v0.2.0 (ADR-041) は ADR-039 の HOW（具体アーキテクチャ = Receiver + MessageBus パターン）
   - ADR-041 は ADR-039 の実装方針として位置付ける（Supersede ではなく Implementation of）
   - ADR-038 の設計判断は記録として残す（ADR-039 で既に Superseded なので ADR-041 からは参照のみ）
2. **ADR-035 (agent-memory 自動蓄積) との整合性確認**:
   - 新方式でも自動蓄積パス（post-tool-hook → agent-memory）が機能する前提を確認
   - receiver は agent-memory に直接書かない（bot MCP server 経由のまま）
3. **ADR-026 (agent_messages 統一スキーマ) との整合性**:
   - `discord_message_id` カラム追加は ADR-026 の延長として妥当
   - ADR-026 の改訂が必要なら ADR-041 と同時に実施

---

## 7.5. agent-com-dev Q-Dev-1〜4 への Arc 回答

### Q-Dev-1. receiver の物理位置

**回答: `server.ts` に `TRANSPORT_MODE='receiver'` を追加**（現 daemon コードと共存可能）

- v0.1.0 現コードが既に `TRANSPORT_MODE='stdio' | 'sse' | 'daemon'` の 3 モードを持っている
- `'receiver'` を 4 つ目のモードとして追加し、`server.ts` 内で `runReceiver()` エントリポイントを分岐する
- これにより PoC 期間中は既存の stdio/daemon と並列起動できる
- 将来 Phase C 完了後（全 bot 切替後）に `bin/agent-com-receiver` 独立バイナリへ抽出する

### Q-Dev-2. core/ 切り出し順序

**回答: 先に core/ 切り出し → 後で receiver 追加**（安全なリファクタ順）

- 現 `server.ts` は 3000 行超 monolithic
- いきなり receiver 実装を入れると core ロジックの変更とトランスポート変更が混在して差分が膨れる
- PoC スコープに含めるが、**PR を 2 つに分ける**:
  - PR-A: `core/route-message.ts` 抽出（現 routeInbound を core に移動、機能変更なし）
  - PR-B: receiver モード追加 + PoC bot 1 体の subscribe
- PR-A が先行マージできれば現 daemon でも恩恵あり（routing 統一の前倒し）

### Q-Dev-3. PoC 最小スコープ定義

**回答: 以下で確定**

1. receiver 1 プロセス（`TRANSPORT_MODE='receiver'` で起動）
2. bot MCP server 1 体（subscribe あり、例: test-bot 新規作成 or arc 使用）
3. channel 1 つ（既存 #agent-com or PoC 専用新規）
4. 1 inbound round-trip（Discord → receiver → pg_notify → bot MCP → Claude Code push）
5. 1 outbound round-trip（Claude Code → bot MCP → DB INSERT + pg_notify('outbound') → receiver → Discord REST）
6. Q1 spike 検証（MCP notifications/message 配信）
7. mixed モード dedup 検証（receiver INSERT と 旧 daemon INSERT の併存）

**スコープ外（PoC では見ない）**:
- Phase 1-7 の完全実装
- 残り 15 bot の切り替え
- SQLite モード対応
- presence client

### Q-Dev-4. PoC = mixed モード dedup 実証の兼用

**回答: はい、その理解で正しい**

PoC bot 1 体だけを新方式に切り替えた状態で残り 15 bot は旧方式。その間 receiver の DB INSERT と旧 daemon の DB INSERT が併存する = **まさに mixed モード**。

PoC の観察項目に dedup 検証を含める:
- `discord_message_id` ユニーク制約で重複 INSERT が正しく弾かれるか
- no-op INSERT handling（§H2）が正しく SELECT fallback で id を取得するか
- push が重複しないか
- 旧 daemon の per-bot INSERT 経路にエラー影響がないか

PoC 通過条件に「24h mixed モード運用で無事故」を含める。

---

## 8. Operator Runbook（agent-com-devレビュー反映）

Receiver + MessageBus 方式の運用手順書。spec 付録として記録し、実装後に個別 Runbook 文書へ切り出す。

### 8.1 Receiver が無反応の場合

**症状**: Discord のメッセージが bot に届かない / reply が返ってこない

**確認コマンド**:
```bash
# 1. health check
curl -s http://127.0.0.1:9000/health | jq

# 2. receiver プロセス確認
pgrep -lf 'TRANSPORT_MODE=receiver'

# 3. receiver のログ末尾
tail -n 100 /tmp/agent-com-receiver.log
```

**degraded 状態の意味**:
- `status: "degraded", catchup_in_progress: true` — catch-up 中。待機して OK
- `status: "degraded", discord_disconnected: true` — Gateway 切断。再接続中か要確認
- `status: "error"` — 致命的エラー、再起動が必要

**手動再起動**:
```bash
# launchd 経由（推奨）
launchctl kickstart -k gui/501/com.iyasaka.agent-com-receiver

# 直接（緊急時）
pkill -f 'TRANSPORT_MODE=receiver'
# launchd が自動再起動する
```

### 8.2 Discord REST 直叩き fallback（緊急送信）

receiver が復旧しない状況で、緊急メッセージを Discord に投稿したい場合:

```bash
TOKEN=$(grep DISCORD_TOKEN_ARC .env | cut -d= -f2)
CHANNEL_ID=1487368919613444156

curl -X POST "https://discord.com/api/v10/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bot $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "緊急メッセージ本文"}'
```

注意:
- 直叩きメッセージは DB INSERT されない（catch-up で後追い INSERT される）
- reply chain は復旧後の catch-up まで切れる
- 受信側 bot に push されない（pull のみ）

### 8.3 Migration rollback

v0.2.0 migration を rollback する必要が生じた場合:

```sql
-- 逆順で実行
DROP INDEX IF EXISTS uq_agent_messages_discord_id;
DROP INDEX IF EXISTS idx_agent_messages_discord_id;
ALTER TABLE agent_messages DROP COLUMN discord_message_id;
```

注意:
- backfill 済みデータは消失する（metadata には残るので再 migration で復元可能）
- receiver プロセスは rollback 前に必ず停止する

### 8.4 1000件 cap alert を受信した時

catch-up が 1000 件 cap に到達したチャンネルでは、それ以前のメッセージが欠落している可能性がある:

1. alert ログから対象 channel を特定
2. Discord UI で該当時間帯のメッセージを手動確認
3. 重要メッセージが欠落している場合は、CEO / operator が手動で bot に転送
4. `knowledge` テーブルの `receiver_catchup_cap_reached` エントリから影響範囲を記録

### 8.5 Receiver crash 時のリカバリ

- **launchd KeepAlive** により自動再起動（数秒）
- 再起動後 catch-up フェーズで Gateway resume 不可能分を REST で取得
- 1000件 cap 未満の inbound は全て復旧
- Gateway resume 可能期間（~5分）以内なら crash の影響はほぼゼロ

### 8.6 よくある問題

| 症状 | 原因 | 対処 |
|------|------|------|
| bot に push 来ない | pg_notify LISTEN 切断 | bot MCP server 再起動 |
| send が NOT_A_MEMBER | channels.members 未登録 | CLI `channel add-member <bot_id>` |
| reply_to 解決失敗 | discord_message_id NULL | warning ログ確認、fallback 動作する |
| catch-up が終わらない | Discord rate limit | 待機。@discordjs/rest が自動管理 |

---

## 9. 次のステップ

1. ✅ CTO レビュー完了（APPROVE、2026-04-08）
2. ✅ agent-com Dev レビュー完了（Approve with clarifications、2026-04-08、rc2 で反映済み）
3. ADR-041 draft 起草（CTO、並行作業、Status: Proposed pending Q1 spike）
4. **Q1 PoC spike（30分 spike テスト）** — agent-com Dev 担当予定
5. spike 結果が OK の場合:
   - v0.2.0 確定版へ rename（`RECEIVER_ARCHITECTURE_SPEC.md`）
   - ADR-041 を Accepted に確定
   - CEO 承認 → framework ingest で SSOT 反映
6. spike 結果が NG の場合:
   - **retreat path (a) pull-on-notify** で進行（§Q1 参照）
   - v0.2.0 の構造改善は保持、push の即時性のみ失う
   - ADR-041 に retreat 適用の旨を追記
7. PoC 本体実装（agent-com Dev、Q-Dev-1-4 の回答に沿う）
8. PoC 通過判定 → **Phase 1-7 本実装**（PR-A: core 抽出 → PR-B: receiver 追加）

---

## 改訂履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| v0.1.0 | 2026-04-08 | 初版（Google Drive） |
| v0.2.0-draft | 2026-04-08 | Critical 5 + High 4 修正提案（Arc 起草） |
| v0.2.0-rc1 | 2026-04-08 | CTOレビュー反映（C3 Mode B セキュリティ拡張、H1 cap alert、H2 SQLite制約 + Phase B計画、Q1 spike要件、Q2 決定、Q3 A案確定、Q4 warning+drop、A1-A4 追加観点）|
| v0.2.0-rc1.1 | 2026-04-08 | ADR番号訂正（ADR-039 → ADR-041）。既存 ADR-039 (server-discord-removal, 2026-04-07) との衝突回避。v0.2.0 は ADR-041 として ADR-039 の実装方針に位置付け。事故 postmortem は CTO が ADR-040 で起草 |
| v0.2.0-rc2 | 2026-04-08 | agent-com Dev レビュー反映（必須4: C1 backfill migration、C4 α方式採用（pull-on-notify、β非採用）、H2 no-op INSERT handling、Q1 retreat path default）+ 改善7: C2 現コード前提訂正、C3 PR#89 連続性、C5 token 分離方針、H1 cold-start + 並列上限 + alert 宛先、H4 cache invalidation 発火元、A2 Phase 1 restart-bot CLI、§8 Operator Runbook 付録、§7.5 Q-Dev-1〜4 Arc 回答 |
