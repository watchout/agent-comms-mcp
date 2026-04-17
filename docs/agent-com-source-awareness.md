# agent-com Source Awareness 設計書 v1.1.0

> **ステータス:** PROPOSED（Phase C 完了後に着手）
> **前提:** `agent-com-message-queue-spec.md` v1.0.3 Phase C 完了済みであること
> **関連:** `agent-com-message-queue-spec.md` v1.0.3 を拡張するが、v1.0.3 自体は変更しない

---

## 1. 課題

v1.0.3 の設計では全メッセージの入出力が Discord 経由を前提としている。
実際には bot への入力は複数経路から発生し、返信先が入力元と一致しない問題が起きる。

```
現状の問題パターン:

  CEO が tmux で CTO bot に直接入力
    → bot が MCP send で返信
    → Discord に投稿される（CEO のターミナルには返らない）

  CEO が claude.ai で指示
    → bot が Discord 経由で他 bot に指示
    → 結果が Discord に投稿される（claude.ai には返らない）

  Codex CLI から bot 間通信
    → 返信が Discord に投稿される（Codex のターミナルには返らない）
```

根本原因: `send` コマンドの出力先が常に `outbound_queue` → Discord REST API に固定されている。
入力元（source）を追跡する仕組みがないため、返信先を動的に切り替えられない。

---

## 2. 設計原則

```
1. 返信は入力元と同じ経路に返す（source-aware routing）
2. 全メッセージが経路に関わらず DB に記録される（v2.0.0 §1 原則 3「DB が唯一の通信路」を維持）
3. 既存の CLI コマンド（next / send）のインターフェースは変更しない
4. source awareness は MCP server / CLI 内部で透過的に処理される
5. OSS 利用者が source awareness を意識する必要がない
```

---

## 3. Source 種別

```
source        入力経路                       返信先
─────────────────────────────────────────────────────────────────
discord       Discord → receiver → queue      outbound_queue → Discord REST API
terminal      tmux 直接入力                    標準出力（Claude Code セッション内表示）
mcp_direct    MCP tool 呼び出し（bot 間直接）  MCP tool result（呼び出し元に返却）
web           将来: Web UI 経由                将来: Web UI 応答
slack         将来: Slack → receiver → queue   outbound_queue → Slack API
telegram      将来: Telegram → receiver        outbound_queue → Telegram API
```

---

## 4. メッセージフロー（source 別）

### 4.1 source: discord（既存、変更なし）

```
Discord → receiver → discordToUnified(source: "discord")
  → routeInbound → message_queue INSERT
  → bot next → 処理 → send
  → outbound_queue INSERT → Discord REST API 送信
```

### 4.2 source: terminal（新規）

```
CEO / 開発者が tmux で直接入力
  → Claude Code セッションが受信
  → MCP server 内で source: "terminal" をタグ付け
  → agent_messages INSERT（DB 記録、source="terminal"）
  → bot が処理 → 返信
  → source="terminal" → outbound_queue に入れない
  → Claude Code セッション内に直接出力（標準出力）
  → agent_messages INSERT（返信も DB 記録）
```

### 4.3 source: mcp_direct（新規）

```
bot A が bot B に MCP tool 経由で直接呼び出し
  → bot B の MCP server が受信（source: "mcp_direct"）
  → agent_messages INSERT（DB 記録）
  → bot B が処理 → 返信
  → source="mcp_direct" → MCP tool result として返却
  → bot A のコンテキストに返信が入る
  → agent_messages INSERT（返信も DB 記録）
  → Discord には投稿しない
```

### 4.4 source: slack / telegram / web（将来）

```
各プラットフォーム → receiver → platformToUnified(source: "slack")
  → routeInbound → message_queue INSERT
  → bot next → 処理 → send
  → source="slack" → outbound_queue INSERT（platform="slack"）
  → Slack API 送信
```

---

## 5. DB スキーマ変更

### 5.1 `agent_messages`（`source` カラム追加）

```sql
ALTER TABLE agent_messages
  ADD COLUMN source TEXT NOT NULL DEFAULT 'discord'
    CHECK (source IN ('discord', 'terminal', 'mcp_direct', 'slack', 'telegram', 'web'));
```

### 5.2 `outbound_queue`（`platform` カラム追加）

```sql
ALTER TABLE outbound_queue
  ADD COLUMN platform TEXT NOT NULL DEFAULT 'discord'
    CHECK (platform IN ('discord', 'slack', 'telegram', 'web'));
```

### 5.3 `message_queue`（`source` フィールドを payload に含める）

```
既存の payload JSON に source フィールドを追加。
テーブル変更不要。next_message の返却値に source が含まれる。
```

---

## 6. CLI 変更

### 6.1 `next_message` 返却値に `source` 追加

```json
{
  "from": "ceo",
  "from_type": "human",
  "source": "discord",
  "channel": "#agent-com",
  "content": "テスト結果どう？",
  "waiting": 12
}
```

### 6.2 `send` コマンド内部の source-aware routing

```
send コマンドのインターフェースは変更しない。
内部で currentMessage の source を参照し、返信先を自動決定。

if (currentMessage.source === "discord") {
  // 既存: outbound_queue INSERT → Discord REST API
} else if (currentMessage.source === "terminal") {
  // 新規: 標準出力に返す、outbound_queue 不使用
  console.log(formattedReply);
} else if (currentMessage.source === "mcp_direct") {
  // 新規: MCP tool result として返却
  return { content: formattedReply };
}

// 全 source で共通: agent_messages INSERT（DB 記録）
await db.insertMessage(replyMessage);
```

### 6.3 `notify` コマンド（`source` 指定オプション追加）

```bash
agent-com notify --agent-id daily-reporter \
  --channel hotel-kanri \
  --mentions cto \
  --content "日次レポート" \
  --platform discord     # デフォルト: discord
```

自発送信は source の概念がないため、明示的に `platform` を指定。
デフォルトは discord（後方互換性維持）。

---

## 7. MCP server 変更

### 7.1 terminal 入力の検出

```typescript
// MCP server 内でメッセージの source を判定
function detectSource(context: MessageContext): Source {
  if (context.fromDiscordPush) return "discord";
  if (context.fromMcpToolCall) return "mcp_direct";
  // Claude Code セッションから直接入力された場合
  return "terminal";
}
```

### 7.2 PollingDriver の source 伝播

```
PollingDriver.getNext() が返す QueueRow に source が含まれる。
next_message ツールの返却値に source が表示される。
send ツール実行時に currentMessage.source を参照して routing。
```

---

## 8. receiver 変更

### 8.1 マルチプラットフォーム adapter

```typescript
// 各プラットフォームの adapter が source を付与
interface PlatformAdapter {
  toUnified(rawMessage: any): UnifiedMessage; // source フィールド含む
  send(message: OutboundMessage): Promise<string>; // platform 固有の ID 返却
}

class DiscordAdapter implements PlatformAdapter { ... }
class SlackAdapter implements PlatformAdapter { ... }    // 将来
class TelegramAdapter implements PlatformAdapter { ... } // 将来
```

### 8.2 outbound consumer の platform-aware 送信

```typescript
// outbound_queue 消費時に platform を見て送信先を分岐
setInterval(async () => {
  const batch = await db.query(`
    SELECT * FROM outbound_queue
    WHERE status = 'pending' AND attempts < max_attempts
    ORDER BY created_at ASC LIMIT 10
  `);

  for (const row of batch) {
    const adapter = getAdapter(row.platform); // "discord" | "slack" | ...
    const externalId = await adapter.send(row);
    // ...
  }
}, 1000);
```

---

## 9. terminal source の制約と注意点

```
terminal 入力は receiver / message_queue を経由しない。
Claude Code セッション内で直接処理される。

制約:
  - routeInbound() を通らない → push 対象の自動判定が効かない
  - 他 bot への転送は send で明示的に行う必要がある
  - Discord に表示されない（意図的: terminal での作業は Discord に流さない）

DB 記録:
  - agent_messages には source="terminal" で記録される
  - 監査証跡として全 terminal 操作が DB 検索可能
  - history / inbox コマンドで source フィルタ可能
```

---

## 10. Single-Recipient Messaging（1 メッセージ 1 宛先）

### 10.1 課題

v1.0.3 では `send` コマンドの mentions に複数の agent_id を指定可能。
複数 mention された bot が全員同時に対応を開始し、指示が分裂して無限並行開発に陥る。

```
現状の問題パターン:

  CEO: "@cto @arc レビューして"
    → cto が対応開始
    → arc も対応開始
    → 2 つの異なるレビュー結果が返る
    → CEO が 2 つ読んで判断する手間
    → さらに cto と arc が互いの結果を見て修正し始める → 制御不能

  CEO: "@all 状況報告して"
    → 15 bot が全員返信
    → 15 件の返信が CEO に殺到
    → どれに対応すべきか判断できない
```

根本原因: 「通知が来たら必ず対応する」設計なのに、通知を複数 bot に同時送信できる。
LLM に「自分がやるべきか、やらないべきか」を判断させる余地が生まれてしまう。

### 10.2 設計原則

```
1. send コマンドの mentions は 1 名のみ許可
2. 受信者は必ず対応する（判断の余地なし）
3. 他 bot への委任が必要なら、受信者が明示的に 1 名に send する
4. 指揮系統は常に 1 対 1 のチェーン
```

### 10.3 `send` コマンドの変更

```
v1.0.3:
  agent-com send --mentions cto,arc --content "レビューして"
  → cto と arc の両方に push → 並行対応 → 分裂

v1.1.0:
  agent-com send --mentions cto --content "レビューして"
  → cto のみに push → cto が対応
  → cto が判断「arc にも見てほしい」
  → cto: agent-com send --mentions arc --content "○○をチェックして"
  → 指揮系統が明確、並行暴走しない
```

```typescript
// mentions 検証の変更
function validateMentions(mentions: string[]): ErrorResult | null {
  if (!mentions || mentions.length === 0) {
    return error("NOT_MENTIONED", "mentions必須");
  }

  // v1.1.0: 複数 mentions 禁止
  if (mentions.length > 1) {
    return error("MULTIPLE_MENTIONS_NOT_ALLOWED",
      `宛先は 1 名のみ指定可能。指定された: ${mentions.join(", ")}\n` +
      `複数 bot に指示が必要な場合は、1 名に送信し、その受信者から次の 1 名に委任してください。`);
  }

  // グループ mention 禁止
  const groupIds = ["all", "dev", "org"];
  if (groupIds.includes(mentions[0])) {
    return error("GROUP_MENTION_NOT_ALLOWED",
      `グループ mention (@${mentions[0]}) は使用できません。\n` +
      `個別の agent_id を 1 名指定してください。`);
  }

  // 以下、既存の存在チェック...
}
```

### 10.4 `routeInbound` の変更

```
v1.0.3:
  メッセージ内の全 mention に対して pushTargets に追加
    → @cto @arc → pushTargets = ["cto", "arc"]

v1.1.0:
  メッセージ内の最初の mention のみ pushTargets に追加
    → @cto @arc → pushTargets = ["cto"] のみ
    → arc には push されない
    → cto の返信内で @arc が mention された場合に arc に push
```

```typescript
function routeInbound(
  msg: UnifiedMessage,
  channel: Channel,
  agents: Agent[]
): RouteResult {
  const pushTargets: string[] = [];
  const dropTargets: Record<string, string> = {};

  // DM → 相手 1 名（変更なし）
  if (channel.type === "dm") {
    // 既存ロジック維持
  }

  // チャンネル → 最初の mention 1 名のみ
  const firstMention = msg.mentions[0]; // 最初の 1 名
  for (const memberId of JSON.parse(channel.members)) {
    if (memberId === msg.author_id) continue;
    if (memberId === firstMention) {
      pushTargets.push(memberId);
    } else {
      dropTargets[memberId] = "NOT_PRIMARY_MENTION";
    }
  }

  return { pushTargets, dropTargets };
}
```

### 10.5 `notify` コマンドの例外

```
notify は「通知」であり「対応要求」ではない。
複数 mentions を許可するが、message_type="broadcast" として扱い、
受信者は返信不要。

agent-com notify --agent-id daily-reporter \
  --channel hotel-kanri \
  --mentions cto,arc \
  --content "日次レポート: テスト全件パス"

→ cto と arc の両方に push（message_type="broadcast"）
→ 受信者は inbox で確認するが、返信義務なし
→ next_message の hint に「broadcast: 返信不要」と表示
```

### 10.6 委任チェーンの例

```
CEO → @cto "PR #168 をレビューして"
  cto 受信、レビュー実施
  cto → @arc "セキュリティ観点でチェックして"（委任）
    arc 受信、チェック実施
    arc → @cto "問題なし、LGTM"（報告）
  cto → @ceo "レビュー完了、arc 確認済み、merge 可"（報告）

全ての通信が 1 対 1。
各 bot は「自分宛に来たメッセージに対応する」だけ。
判断の余地なし、並行暴走なし。
```

---

## 11. Daemon 分離（PollingDriver 独立プロセス化）

### 11.1 課題

v2.0.0 の §5.3 で daemon プロセスモデルを 1 daemon に統一。MCP host の lazy spawn 問題は daemon が先行起動することで構造的に解消された（§5.3 起動シーケンス参照）。

```
問題の構造:

  restart-bot.sh（全 bot 共通）
    → claude server:agent-comms --mcp-config .mcp.json
    → Claude Code セッション開始
    → CLAUDE.md 読み込み
    → bot の最初のアクション実行
       ↓
  agent-comms tool を呼ぶ bot → MCP server spawn → PollingDriver 起動 → ✅
  agent-comms tool を呼ばない bot → MCP server 未 spawn → PollingDriver 未起動 → ❌

  lazy spawn は Claude Code / Codex 側の仕様であり、agent-com から制御不能。
  CLAUDE.md に「起動時に agents を呼べ」と書いても LLM の行動に依存する。
  スクリプト制御で解決すべき。
```

### 11.2 設計原則

```
1. PollingDriver（heartbeat + polling + outbound consumer）は MCP server から分離する
2. agent-com daemon は独立プロセスとして即時起動する
3. MCP tools は daemon プロセス経由で DB 操作する
4. 全 CLI、全 bot、同一の restart-bot.sh で起動する
5. LLM の行動に一切依存しない
```

### 11.3 アーキテクチャ

```
restart-bot.sh（全 bot 共通）:

  ┌─────────────────────────────┐
  │  agent-com daemon           │  ← 即時起動、CLI 不問
  │                             │
  │  - heartbeat (30 秒ごと)    │
  │  - polling (3 秒ごと)       │
  │  - outbound consumer (1 秒) │
  │  - message buffer           │
  │  - DB 接続管理              │
  └──────────┬──────────────────┘
             │ IPC (Unix socket or TCP localhost)
  ┌──────────┴──────────────────┐
  │  MCP server (stdio)         │  ← lazy spawn でも即 spawn でも動作
  │                             │
  │  - next_message → daemon 経由 │
  │  - send → daemon 経由       │
  │  - agents → daemon 経由     │
  │  - tool 定義のみ、ロジックなし │
  └─────────────────────────────┘
             │
  ┌──────────┴──────────────────┐
  │  Claude Code / Codex / etc  │  ← LLM セッション
  └─────────────────────────────┘
```

### 11.4 起動スクリプト

```bash
#!/bin/bash
# restart-bot.sh（全 bot 共通、daemon 分離版）

AGENT_ID=$1
DISCORD_TOKEN=$2

# 1. 既存プロセス停止
pkill -f "agent-com daemon --agent-id $AGENT_ID" 2>/dev/null
tmux kill-session -t "discord-$AGENT_ID" 2>/dev/null
sleep 1

# 2. agent-com daemon 起動（即時、バックグラウンド）
agent-com daemon --agent-id $AGENT_ID &
DAEMON_PID=$!
echo "daemon started: pid=$DAEMON_PID"

# 3. daemon 起動確認
sleep 2
if ! kill -0 $DAEMON_PID 2>/dev/null; then
  echo "ERROR: daemon failed to start"
  exit 1
fi

# 4. Claude Code セッション起動
tmux new-session -d -s "discord-$AGENT_ID" \
  "AGENT_ID=$AGENT_ID claude server:agent-comms --mcp-config .mcp.json"

# daemon が heartbeat + polling + outbound consumer を実行
# MCP server は lazy spawn でも問題なし
# Claude Code セッションが何をしても通信基盤は動く
```

### 11.5 `agent-com daemon` コマンド

```bash
agent-com daemon --agent-id <id> [--poll-interval 3000] [--health-port 9001]
```

```typescript
// entrypoints/daemon.ts

import { PollingDriver } from '../core/polling-driver';
import { OutboundConsumer } from '../core/outbound-consumer';
import { createDbAdapter } from '../core/db-adapter';
import { createIpcServer } from '../core/ipc-server';

const agentId = process.env.AGENT_ID;
const db = createDbAdapter();

// 1. PollingDriver 起動（heartbeat + polling）
const poller = new PollingDriver(agentId, db, {
  pollIntervalMs: parseInt(process.env.AGENT_COM_POLL_INTERVAL_MS || '3000'),
});

// 2. OutboundConsumer 起動
const consumer = new OutboundConsumer(agentId, db, {
  intervalMs: 1000,
});

// 3. IPC サーバー起動（MCP server との通信用）
const ipc = createIpcServer(agentId, {
  getNext: () => poller.getNext(),
  send: (params) => handleSend(params, db),
  agents: () => db.getAgents(),
  status: () => getStatus(agentId, db),
  heartbeat: () => poller.heartbeat(),
});

// 4. graceful shutdown
process.on('SIGTERM', async () => {
  poller.stop();
  consumer.stop();
  ipc.close();
  await db.close();
  process.exit(0);
});

console.error(`[agent-com daemon] started for ${agentId}`);
```

### 11.6 MCP server の変更

```typescript
// MCP server（daemon 分離版）
// tool 定義のみ、PollingDriver / OutboundConsumer は持たない
// 全操作を daemon プロセスに委譲

import { connectToDaemon } from '../core/ipc-client';

const daemon = connectToDaemon(process.env.AGENT_ID);

server.tool("next_message", { ... }, async (params) => {
  return daemon.call('getNext', params);
});

server.tool("send", { ... }, async (params) => {
  return daemon.call('send', params);
});

server.tool("agents", { ... }, async () => {
  return daemon.call('agents');
});

// heartbeat は daemon が自動実行、MCP server 側では不要
// polling も daemon が自動実行、MCP server 側では不要
// outbound consumer も daemon が自動実行
```

### 11.7 IPC 通信

```
daemon ↔ MCP server 間の通信方式:

  推奨: Unix domain socket
    パス: /tmp/agent-com-{agent_id}.sock
    理由: localhost 限定、ファイルシステムで権限制御可能、
          TCP port の枯渇 / 衝突なし

  代替: TCP localhost
    ポート: 9100 + agent_id hash
    理由: Windows 対応が必要な場合

  プロトコル: JSON-RPC 2.0（MCP 自体と同じプロトコル）
    → MCP server の実装者にとって馴染みがある
```

### 11.8 daemon プロセスモデル (v2.0.0)

v2.0.0 で embedded / standalone の dual mode は廃止。1 daemon プロセスに統一。

```
daemon (host に 1): receiver + outbound + heartbeat + Discord Gateway
per-bot MCP server (lazy spawn): stateless DB ラッパー
```

旧 `AGENT_COM_DAEMON_MODE` 環境変数は廃止（message-queue-spec §20 廃止要素）。

### 11.9 watchdog 統合

```
daemon 分離後の watchdog:

  現行: Claude Code セッションの生存のみ監視
  daemon 分離後: daemon プロセスの生存も監視

  watchdog.sh チェック項目:
    Check 1: tmux session "discord-{agent_id}" 存在確認
    Check 2: agent-com daemon プロセス存在確認（pidfile or pgrep）
    Check 3: heartbeat_at が 90 秒以内か（DB 確認）

  復旧:
    Check 1 失敗 → Claude Code セッション再起動（daemon はそのまま）
    Check 2 失敗 → daemon 再起動 + grace period 60 秒
    Check 3 失敗 → daemon 再起動

  Claude Code セッションが落ちても daemon は生きている
    → heartbeat は継続 → disconnected 判定されない
    → outbound consumer も継続 → 送信キューは消費される
    → Claude Code が復帰したら next で受信再開
```

---

## 12. 後方互換性

```
v1.0.3 からの移行:
  - source カラムのデフォルトが "discord" → 既存データは全て discord 扱い
  - CLI コマンドのインターフェース変更なし（mentions の要素数制限のみ追加）
  - next / send の動作は source=discord の場合 v1.0.3 と完全に同一
  - outbound_queue の platform カラムも "discord" デフォルト
  - 複数 mentions を使用していた既存ワークフローは 1 名ずつに分割が必要
  - daemon 1 プロセス（v2.0.0 統一モデル）

OSS 利用者への影響:
  - Discord 単体で使う場合: mentions 制限以外変更なし
  - terminal 入力を使う場合: 自動的に source-aware routing が効く
  - マルチプラットフォーム: adapter 追加で対応
  - 複数 bot 同時指示のユースケース: notify コマンド（broadcast）を使用
  - daemon プロセスモデル: v2.0.0 §5.3 参照
```

---

## 13. 実装優先順

```
Phase 1: DB schema 変更（source カラム、platform カラム追加）
Phase 2: next_message 返却値に source 追加
Phase 3: send 内部の source-aware routing（discord / terminal 分岐）
Phase 4: terminal 入力の DB 記録
Phase 5: send mentions 制限（1 名のみ） + routeInbound 変更（最初の mention 1 名のみ push）
Phase 6: notify broadcast mode（message_type="broadcast"、返信不要表示）
Phase 7: daemon 分離（IPC server / client + entrypoints/daemon.ts + restart-bot.sh 変更）
Phase 8: watchdog 統合（daemon 監視 + Check 2 追加）
Phase 9: マルチプラットフォーム adapter 基盤（Slack / Telegram / Web）
```

Phase 1-8 が v1.1.0 のスコープ。Phase 9 は需要に応じて。

---

## 14. 完了条件

```
v1.1.0 完了 = 以下全てが動作:
  - Discord 経由の入力 → Discord に返信 + DB 記録
  - terminal 直接入力 → terminal に返信 + DB 記録
  - 全メッセージが source 付きで agent_messages に記録
  - next_message の返却値に source が含まれる
  - send の返信先が source に応じて自動切替
  - send の mentions が 1 名のみ許可（複数指定でエラー）
  - @all / @dev / @org グループ mention が send で拒否される
  - notify の broadcast mode が動作（複数 mentions 許可、返信不要表示）
  - routeInbound が最初の mention 1 名のみに push
  - agent-com daemon が独立プロセスとして全 bot で稼働
  - MCP server が daemon 経由で DB 操作（IPC 通信）
  - daemon プロセスが落ちても watchdog が自動復旧
  - Claude Code セッションが落ちても daemon の heartbeat / outbound は継続
  - daemon 1 プロセスモデルが動作
  - v1.0.3 の全機能が後方互換で動作（mentions 制限除く）
```

---

## 改訂履歴

| 日付 | 内容 |
|------|------|
| 2026-04-16 | §11.8 default embedded に訂正 (message-queue-spec §20 + §12 整合、auditor cycle 3 指摘反映)。gdrive canonical の "standalone default" 表記は daemon 未実装段階で bug であり、CTO 技術判断で message-queue-spec §20 と同じく `embedded` を default に統一 |
| 2026-04-16 | v1.1.0 gdrive → repo sync (Task A1): PROPOSED status で repo 反映、Phase C 完了後に着手 |
| 2026-04-14 | v1.1.0 改訂 4: §11.8 standalone をデフォルトに変更（v1.0.3 で基本 daemon 導入済み、v1.1.0 は IPC 拡張）※ 2026-04-16 の repo sync で embedded default に訂正済 (上記 entry 参照) |
| 2026-04-14 | v1.1.0 改訂 3: §11 Daemon 分離追加（PollingDriver 独立プロセス化、IPC 通信、embedded / standalone 切替、watchdog 統合、restart-bot.sh 統一）、§12-14 を再番号付け、Phase 7-8 追加 |
| 2026-04-14 | v1.1.0 改訂 2: §10 Single-Recipient Messaging 追加（1 メッセージ 1 宛先制約、send mentions 制限、routeInbound 変更、notify broadcast 例外）、§11-13 を再番号付け |
| 2026-04-13 | v1.1.0 初版: source awareness 設計（§1-9、Phase C 完了後着手） |
