# State Machine Driven Dispatch Daemon — Design Spec

> **Status**: ARC 起草 (Draft v0.7 — supersedes v0.6)
> **Issue**: [watchout/agent-comms-mcp#323](https://github.com/watchout/agent-comms-mcp/issues/323)
> **Author**: ARC
> **Created**: 2026-05-07 (v0.1) / Revised 2026-05-08 (v0.2 → v0.3 → v0.4 → v0.5 → v0.6 → v0.7)
> **Trigger**: CEO directive 2026-05-05 〜 2026-05-08、CTO `1d402109` (v0.3 GO)、CTO `70050419` (v0.4)、lead-ama `1abdf00d` (v0.5)、CEO `cfb32b4a` α + CTO `1b7464ee` (v0.6)、lead-ama `b76bccff` (v0.7、PR #330 auditor Axis 5(b) schema drift 解消、ARC α 採択)
> **Honesty labels**: 全 claim に [検証済] / [文献確認] / [推測]
> **Dispatch context** (6-section format):
> - target_project: `agent-comms-mcp`
> - dispatch_origin: `arc`
> - dispatch_reason: GitHub issue #323、CEO `e4bfe41c` 「TUI 統一前提で prevention check 全削除、出てから制御」採択

---

## 0. v0.6 → v0.7 patch (PR #330 auditor Axis 5(b) schema drift 解消)

[文献確認 lead-ama `b76bccff` / agent-com-dev `\d message_queue` 検証済]:

| 旧表現 | v0.7 fix | 採択 |
|---|---|---|
| §4.3 row 5: `read AND attempts >= max_attempts AND age > 5min` | `status IN ('pending','read') AND age > stuckAfter` (age-based proxy 単一表現) | **α** (CEO `cfb32b4a` α 採択スタイル継承、impl 実態と整合) |

**理由**: production schema (実検証 [agent-com-dev psql `\d message_queue`] per) に `attempts` column 不在。v0.5 で row 5 / row 6 とも `STALE_DISPATCH` 単一固定済み (機能的に age-based proxy で structurally 同等、loop prevention 目的維持)。v0.7 は **spec literal を impl 実態に realign** する rephrase patch、抽象 leak (schema 実態未確認 で書いた v0.1 の残り) の最終解消。

T12 fixture (`max_attempts_failed_permanently`) は名前 semantic のみ、`attempts=max` precondition は age-based proxy (`age > stuckAfter`) に統一。

選択肢比較:
- (α) spec rephrase: 採択、最小 risk、impl との一致
- (β) schema migration `attempts` 列追加: route:ceo-approval、本 PR scope 超過、却下
- (γ) spec 注釈で「age proxy 代替」明記: residue 残存、却下

---

## 0a. v0.5 → v0.6 patch (auditor v3 BLOCK A2 残 3 箇所解消)

[文献確認 lead-ama `e8abbf0e` / auditor v3 `21beddd8` / CEO `cfb32b4a` α 採択]:

| 旧 line | 旧表現 | v0.6 fix |
|---|---|---|
| §3.1 (旧 line 107) | 「`registry runtime` 列で abstract」 | 「`agents.runtime` 既存 column で abstract、新規追加なし」 |
| §3.2 (旧 line 122) | 「Discord token + `registry` 拡張」 | 「Discord token + `agents` table 既存 column 利用」 |
| §12 Phase 6 (旧 line 540) | 「SIG runtime 全廃 (`registry` から削除)」 | 「SIG runtime 全廃 (`agents.runtime` 既存 column を TUI のみに収束)」 |

= spec 全 grep `registry` で **agents SoT 整合のみ残存** (新規 table 提案なし、legacy registry 表現完全削除)。
§4.3 row 5/6 は v0.5 で `STALE_DISPATCH` 単一固定済 (α 維持)、v0.6 で再確認のみ。

---

## 0b. v0.4 → v0.5 patch (auditor v2 BLOCK 残 3 件解消)

[文献確認 lead-ama `1abdf00d` / auditor v2 `b7398912`]:

| Issue | v0.4 状態 | v0.5 fix |
|---|---|---|
| Q3 (F12 file drift) | lead-ama dispatch text に「F12 追加」と書いたが翻訳元素 file 未反映 | `state-daemon-6section-elements.md` §3 Forbidden に F12 追加 (新規 `bot_registry` table 提案禁止 / `bot-registry.txt` 読込禁止) |
| A2 残 (§6.3 drift) | §7.1 修正済、§6.3 で `registry.get()` / `registry.runtime` / `bot-registry.txt` 列追加表現が残存 | §6.3 を `agents.findByAgentId()` / `agents.runtime` 経由 SoT 表記に修正、legacy registry 表現削除 |
| I1 残 (§4.3 row 5/6 drift) | T12 fixture / §11 で STALE_DISPATCH 単一固定済、§4.3 で row 5=`FAILED_PERMANENTLY` / row 6=`STALE_DISPATCH` 残存 | (α) row 5/6 とも `STALE_DISPATCH` 単一固定 (CEO 採択 `α`、最簡整合) |

---

## 0c. v0.3 → v0.4 patch (auditor BLOCK 解消)

[文献確認 CTO directive `70050419` / lead-ama `d0161ad6`]:

| Issue | v0.3 状態 | v0.4 fix |
|---|---|---|
| Q1 (lead-ama §1 改訂と同期) | public API pre/post 不足 | 6-section 元素 §1.2 で各 API (start/stop/handleQueueEvent/sweepStale/refreshClaims/checkBotLiveness) に pre/post/invariants 明記 |
| A2 (bot_registry 抽象 drift) | spec §7.1 で bot_registry に新規 column / §13.2 O6 で「当面 txt」と矛盾 | **DB primary 一本化**: 既存 `agents` table (21 列、`runtime`/`status`/`channel_port`/`metadata` 等) を SoT 採用、`bot-registry.txt` は tmux 起動補助 op tool only と明記、§13.2 O6 削除 |
| I1 T12 (二択許容) | `failed_reason='STALE_DISPATCH' or 'MAX_ATTEMPTS'` | **`STALE_DISPATCH` 単一固定** |
| I1 T13 (alert 閾値 drift) | spec §11「3 回目で alert」 / fixture「5 連続未満は alert なし」 | **5 連続で alert に一本化** (spec / fixture / 6-section 元素 §2 R10 揃える) |

[検証済 CTO `70050419` evidence]: `agents` table が既に DB primary、`bot-registry.txt` は tmux launcher 補助のみ。v0.3 が新規 `bot_registry` table を提案していたのは誤前提。

---

## 0d. v0.2 → v0.3 主要変更点

[文献確認 CTO directive `1d402109` / `907b7e9b`]:

| 項目 | v0.2 | v0.3 |
|---|---|---|
| §5 dispatch prevention check (a)-(e) | 中核 logic | **全削除** (TUI 統一で SIG 由来 incident 構造的解消) |
| §11 T2/T3/T4/T5/T6/T7/T18 | prevention 関連 fixture | **削除** |
| §13.2 O1 (ack detection) / O4 (TUI rate limit) | CEO 採択待ち | **削除** (prevention 全廃で不要) |
| 補強 #4 (chain interruption handling) | 議論中 | **削除** (prevention 不要なら chain 切替も不要) |
| 補強 #1 claim refresh (heartbeat 30s 毎) | — | **必須包含** (long task の TTL 維持) |
| 補強 #2 subprocess pool 動的拡張 | — | **必須包含** (load 応じた wake 並列度) |
| 補強 #3 launchd plist sample | — | **必須包含** (daemon auto-restart) |
| 補強 #5 dead bot auto-restart trigger | — | **必須包含** (bot 死活監視) |
| 制御 spirit | prevention で「出る前」 block | **「出てから制御」** (operator alert + metric 駆動 reactive control) |

---

## 1. 背景

### 1.1 v0.1 起源 (Issue #323)

[文献確認 Issue #323]:

> bot が LLM 処理中 (busy) の時、SIGUSR1 / check inbox どちらの方式でも wake 取りこぼし発生。30s 以上の LLM 処理で claim TTL 失効 → IMPLICIT_ABANDON → message lost (webb-dev 27008 で再現)

### 1.2 v0.2 で扱った incident と v0.3 での再整理

v0.2 起草時 (本日早朝) に挙げた追加 incident:

- **B8 type loop**: arc↔adf-lead pair が同 chain で「Idle 維持」reply 連投
- **reply_chain misread**: ARC bot が `<@CTO_ID>` mention を「自分宛」と誤読 (msg `c9c6655c`)
- **"Idle ack" 連射**: 「Idle 維持」を 5 分以内に 5+ 回連投

これらは **TUI 統一 (CEO `7670b33f` Q3=i) + B4 system prompt 改善 (別 task)** で構造的に解消可能、と CEO `e4bfe41c` で再判断:

- TUI 統一 → bot 自身の inbox 自然 polling、SIG-driven の forced wake が消滅 → ack 連射の主要発生 path 消滅
- 残存する LLM 自主規律失敗は B4 (LLM system prompt) の領分
- **dispatch 層 (state-daemon) は state machine + safety net に専念、loop prevention は持たない**

### 1.3 v0.3 で統合した CEO/CTO 判断

[文献確認]:

- CEO `2c8c0428` greenlight: B4 deferred、#323 即着手 (v0.1 起源)
- CEO `7670b33f` Q1=β / Q3=(i) TUI 統一 (v0.2 で組込)
- CEO `e4bfe41c` (本日 03:00 帯): **「TUI 統一前提で SIG 由来 incident 対策不要、出てから制御」** → CTO `1d402109` v0.3 簡素化 directive
- CTO `1d402109` / `907b7e9b`: 補強 4 件 (#1/#2/#3/#5) は v0.3 必須包含、#4 削除

## 2. 設計目標

1. **取りこぼし耐性**: bot busy 中の wake 取りこぼしから回復 (v0.1 継承)
2. **冪等**: 重複 wake / 重複 reset で副作用なし (v0.1 継承)
3. **single daemon 統合**: wake-daemon 完全置換、process / connection sprawl 回避 (v0.2 継承)
4. **「出てから制御」**: abnormal activity を metric + alert で検出、operator が manual で kill / skip (v0.3 新規)
5. **safety net**: heartbeat-claim refresh / dead bot auto-restart / subprocess pool 動的拡張 / launchd 自動再起動 (v0.3 新規)
6. **observable**: action 結果を log + metric で追跡 (v0.1 継承)

## 3. Scope

### 3.1 In scope

- `message_queue.status='pending'` を hook 起点とした **state machine driven dispatch** (= 単純 wake)
- pg_notify (即時 trigger) + cron 30s (sweep / fallback) の hybrid
- TUI bot の wake = tmux send-keys (`agents.runtime` 既存 column で abstract、新規追加なし)
- 既存 wake-daemon の機能を完全包含、置換
- claim refresh (heartbeat 30s 毎 UPDATE)、補強 #1
- subprocess pool 動的拡張、補強 #2
- launchd plist supervisor、補強 #3
- dead bot auto-restart trigger、補強 #5
- abnormal activity metric + operator alert (reactive control)

### 3.2 Out of scope (明示)

- **dispatch 段の loop prevention (chain analysis / pair detection / ack pattern / TUI rate limit)** — v0.3 で全削除、CEO `e4bfe41c` per
- bot の LLM 処理時間そのものを短縮する変更
- spec §13.5.1 delivery layer の根本書換 (本 daemon は補完層)
- inbound dedup の修正 (PR #318 別件)
- B4 (LLM system prompt rules) — CEO `2c8c0428` deferred
- adf-lead / dev-001 TUI 化 (別 task、Discord token + `agents` table 既存 column 利用)
- openclaw integration (別 architecture、参考のみ)
- chain interruption handling (補強 #4 削除)

## 4. State machine

### 4.1 message_queue 状態遷移

```
                                 ┌─────────────────────────────────┐
                                 ↓                                 │
INSERT → [pending] → [read] → [replied] (terminal: success)        │
              │         │                                          │
              │         └──→ [failed: IMPLICIT_ABANDON] ────────────┘ (claim_expires_at recent)
              │                  │
              │                  └──→ [failed: STALE_DISPATCH] (terminal: age > stuckAfter、v0.7 age-based proxy 統一)
              │
              └──→ [failed: STALE_DISPATCH] (terminal: 5min 以上 pickup されず)
```

v0.2 の `[skipped: LOOP_PREVENTED]` は v0.3 で削除 (prevention 全廃)。

### 4.2 state-daemon が判定する dispatch trigger

| trigger 元 | 詳細 | priority |
|---|---|---|
| **pg_notify('queue_event')** | INSERT / UPDATE で即時 | 高 (即時応答) |
| **cron sweep (30s)** | 漏れ救済 (notify 取りこぼし、stale row、claim refresh、dead bot check) | 低 (fallback + housekeeping) |

### 4.3 状態別 action

state-daemon は 5 transition の action を実行 (v0.2 から prevention semantics を除去):

| # | state 条件 | action | rationale |
|---|---|---|---|
| 1 | INSERT new pending | wake (tmux send-keys "check inbox") | 通常 path、無条件 wake (prevention 不在) |
| 2 | pending AND age > PENDING_STALE_AFTER (10s) | re-wake | 取りこぼし救済 (v0.1 継承) |
| 3 | read AND claim_expires_at < now() | self-reclaim → re-wake | proactive reclaim (v0.1 継承) |
| 4 | failed AND failed_reason='IMPLICIT_ABANDON' AND claim_expires_at > now() - 60s | reset to pending | recent abandon は recoverable (v0.1 継承) |
| 5 | status='read' AND age > stuckAfter (default 5min) | status='failed'、failed_reason='STALE_DISPATCH' + alert | infinite reclaim loop 防止 (v0.1 継承)。v0.7 で `attempts` column 言及削除、age-based proxy 単一表現 (production schema 実態整合、CEO α `cfb32b4a` style) |
| 6 | status='pending' AND age > stuckAfter (default 5min) | status='failed'、failed_reason='STALE_DISPATCH' | (v0.2 継承、v0.5 / v0.7 で row 5 と age-based 統一) |

各 action は idempotent。`last_wake_attempt_at` で 5s 以内重複 wake 抑制 (heartbeat と区別)。

## 5. 補強機能 (v0.3 新規、補強 #1/#2/#3/#5)

> v0.2 §5 (dispatch prevention check) は CTO directive `1d402109` per **全削除**。本 §5 は v0.3 で新規、補強 4 件を集約。

### 5.1 補強 #1: claim refresh (heartbeat 30s)

[文献確認 CTO `1d402109`]: long task の TTL 維持に必須。

```ts
// daemon 側 (v0.4: agents table 参照に修正)
setInterval(async () => {
  await db.query(`
    UPDATE message_queue
       SET claim_expires_at = now() + interval '${CLAIM_TTL_SEC} seconds',
           last_heartbeat_at = now()
     WHERE status = 'read'
       AND agent_id IN (SELECT agent_id FROM agents WHERE status = 'online')
       AND claim_expires_at > now()  -- 既 expired は対象外、self-reclaim 経路で処理
  `);
}, HEARTBEAT_INTERVAL_MS);  // default 30_000
```

- `last_heartbeat_at` 列を新設 (§7.1 参照)
- bot が `agents.status='online'` かつ claim 有効な間、daemon 側で TTL を 1 分ずつ延長 (claim_ttl=60s 想定)
- bot が die → `agents.status` が `online` 以外に遷移 → heartbeat 停止 → 自然に TTL 失効 → §4.3 row 4 / 5 の救済へ

### 5.2 補強 #2: subprocess pool 動的拡張

[文献確認 CTO `1d402109` / CEO 「処理乱立懸念」]:

```ts
class WakePool {
  private active = 0;
  private queue: WakeJob[] = [];
  private capacity = MIN_CAPACITY;  // default 5

  async run(job: WakeJob) {
    if (this.active < this.capacity) {
      this.active++;
      try { await job.exec(); } finally { this.active--; this.maybeShrink(); }
    } else {
      this.queue.push(job);
      if (this.queue.length > QUEUE_HIGH_WATERMARK) this.maybeGrow();
    }
  }

  private maybeGrow() {
    if (this.capacity < MAX_CAPACITY) {
      this.capacity = Math.min(this.capacity + GROW_STEP, MAX_CAPACITY);
      log.info({ new_capacity: this.capacity }, 'wake_pool_grown');
    } else {
      metric('state_daemon_wake_pool_saturated_total').inc();
      // operator alert (高 load 持続なら CEO 要対応)
    }
  }

  private maybeShrink() {
    if (this.queue.length === 0 && this.capacity > MIN_CAPACITY) {
      this.capacity = Math.max(this.capacity - SHRINK_STEP, MIN_CAPACITY);
    }
  }
}
```

- `MIN_CAPACITY=5 / MAX_CAPACITY=20 / GROW_STEP=2 / SHRINK_STEP=1` (env 上書き可)
- saturated metric が連続 N 分 → operator alert (Discord)、CEO 「出てから制御」 spirit

### 5.3 補強 #3: launchd plist supervisor

[文献確認 CTO `1d402109`]: daemon 自体の auto-restart 必須 (macOS dev fleet 前提)。

`config/launchd/com.agent-comms.state-daemon.plist` (新規 sample):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agent-comms.state-daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/agent-comms-mcp/bin/state-daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/var/log/state-daemon.out.log</string>
  <key>StandardErrorPath</key><string>/var/log/state-daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict>
</plist>
```

- `KeepAlive=true` で異常終了時 auto-restart
- `ThrottleInterval=10` で 10s 以内連続 crash を抑制
- Linux 移植時は systemd unit に置換 (out of scope)

### 5.4 補強 #5: dead bot auto-restart trigger

[文献確認 CTO `1d402109`]:

```ts
async function checkBotLiveness() {
  // v0.4: agents table を SoT として参照
  const bots = await db.query(`SELECT agent_id, last_seen_at, runtime, tmux_session FROM agents`);
  const now = Date.now();
  for (const bot of bots) {
    const stale = now - bot.last_seen_at.getTime();
    if (stale > BOT_DEAD_THRESHOLD_MS) {  // default 120_000 (2min)
      if (bot.runtime === 'TUI' && bot.tmux_session) {
        const exists = await tmuxSessionExists(bot.tmux_session);
        if (!exists) {
          await restartTmuxSession(bot);  // 既存 launcher script 呼び出し
          metric('state_daemon_bot_restarts_total', { agent_id: bot.agent_id }).inc();
          await operatorAlert(`bot ${bot.agent_id} restarted (tmux session missing)`);
        }
      } else {
        // SIG runtime: migration 中のため restart 不可、log + alert のみ
        await operatorAlert(`bot ${bot.agent_id} dead (SIG runtime, manual intervention)`);
      }
    }
  }
}
setInterval(checkBotLiveness, BOT_LIVENESS_CHECK_INTERVAL_MS);  // default 30_000
```

- `agents.last_seen_at` は bot の inbox polling 時 / send 時に UPDATE (既存 hook 経由、本 spec 範囲外)
- restartTmuxSession は **本 daemon の責務外**、既存 launcher (例: `bin/start-bot.sh`) を呼び出す薄い wrapper
- restart 上限 (例: 1 時間 3 回) を超えたら restart 停止 + operator escalate (CEO 介入)

## 6. Architecture

### 6.1 配置

新規 daemon `bin/state-daemon.ts` が **wake-daemon を完全置換**。
v0.1 の「co-locate / 別 process」議論は閉じ、**1 central daemon 統合**。

### 6.2 trigger 実装

```ts
// pg_notify subscriber (即時)
pgClient.on('notification', async (msg) => {
  if (msg.channel === 'queue_event') {
    const payload = JSON.parse(msg.payload);
    await stateDaemon.handle(payload);
  }
});
await pgClient.query("LISTEN queue_event");

// cron sweep (fallback + housekeeping)
setInterval(async () => {
  await stateDaemon.sweepStale();      // §4.3 row 2-6
}, POLL_SWEEP_INTERVAL_MS);            // default 30_000

setInterval(refreshClaims, HEARTBEAT_INTERVAL_MS);          // 補強 #1
setInterval(checkBotLiveness, BOT_LIVENESS_CHECK_INTERVAL_MS); // 補強 #5
```

### 6.3 wake 実装 (TUI 統一)

[文献確認 CEO `7670b33f` Q3=i]:

```ts
// v0.5: agents table SoT 経由に修正、legacy registry 削除
async function wakeBot(agentId: string): Promise<void> {
  const bot = await agents.findByAgentId(agentId);  // agents table が SoT (§7.1 / v0.4)
  if (bot.runtime !== 'TUI') {
    throw new Error(`SIG mode 廃止済、TUI のみ allowed (got ${bot.runtime})`);
  }
  await execTmuxSendKeys(bot.tmuxSession, 'check inbox\n');
  await db.update('message_queue', row.id, { last_wake_attempt_at: now() });
}
```

`agents.runtime` は既存 column (TUI / SIG)、SIG は migration 後削除予定。`bot-registry.txt` は tmux 起動補助の operational tool であり、本 daemon は読み込まない (v0.4 §7.1 と一貫)。

### 6.4 subprocess pool 制御

補強 #2 参照 (§5.2)。

### 6.5 既存機構との関係

| 既存 | v0.3 で吸収 |
|---|---|
| `bin/wake-daemon.ts` | **削除**、state-daemon に吸収 |
| `core/inbox-cursor.ts` (self-reclaim) | 受動側残存、state-daemon は能動側で重複呼び出し許容 (idempotent) |
| `core/claim-ttl.ts` (TTL sweeper) | state-daemon の cron sweep + 補強 #1 heartbeat に統合 |
| `adapters/inbound-receiver.ts` (bus.signal) | 既存 INSERT 後 pg_notify をトリガとして再利用、変更なし |

## 7. DB schema 変更

### 7.1 新規 column

| table | column | type | rationale |
|---|---|---|---|
| `message_queue` | `last_wake_attempt_at` | TIMESTAMPTZ | 重複 wake 抑制 (v0.1 継承) |
| `message_queue` | `last_heartbeat_at` | TIMESTAMPTZ | 補強 #1 claim refresh 観測用 |

[検証済 CTO `70050419`、v0.4 patch]: bot 情報は **既存 `agents` table (DB primary、21 列)** を SoT として再利用:

| 既存 agents.column | 役割 (v0.4 で再利用) |
|---|---|
| `runtime` (TUI/SIG) | wake mechanism abstract |
| `status` | 補強 #1 heartbeat 対象判定 (例: `online` のみ refresh、`offline` は対象外) |
| `last_seen_at` (既存 or 同等列) | 補強 #5 死活監視 |
| `tmux_session` (既存 or `metadata` JSONB key) | TUI bot の tmux target |

v0.3 が提案した「`bot_registry` 新 table」は v0.4 で **撤回** (誤前提)。`agents` table に新規 column 追加が必要なら別 migration として立てるが、現状 21 列で要件 cover 可能。

`bot-registry.txt` は **tmux 起動補助の operational tool** であり、bot info SoT ではない (CTO `70050419` per)。本 daemon は読み込まない。

v0.2 の `dispatch_decision` JSONB 列は v0.3 で削除 (prevention 廃止に伴い不要)。

### 7.2 新規 status 値

`message_queue.failed_reason` enum 拡張: `'STALE_DISPATCH'`
v0.2 の `'skipped'` status は v0.3 で削除 (prevention 廃止)。

### 7.3 pg_notify trigger

```sql
CREATE OR REPLACE FUNCTION notify_queue_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('queue_event', json_build_object(
    'op', TG_OP,
    'id', NEW.id,
    'agent_id', NEW.agent_id,
    'status', NEW.status,
    'claim_expires_at', NEW.claim_expires_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER message_queue_notify
  AFTER INSERT OR UPDATE OF status, claim_expires_at ON message_queue
  FOR EACH ROW EXECUTE FUNCTION notify_queue_event();
```

**DB schema migration = `route:ceo-approval`** (governance-flow.md per)。

## 8. Failure modes

[推測]:

| failure | detection | recovery |
|---|---|---|
| daemon process 落ち | launchd KeepAlive (補強 #3) | auto-restart、bot 側 self-reclaim も働く |
| pg_notify 取りこぼし | cron 30s sweep が pickup | sweep で stale pending re-wake |
| DB connection loss | LISTEN socket 切断 | reconnect with exponential backoff、5 回失敗で alert |
| infinite re-wake loop | last_wake_attempt_at で 5s 以内重複抑制 | (v0.1 継承) |
| heartbeat 失敗 (DB エラー連続) | last_heartbeat_at が古い + log error | claim 自然失効 → §4.3 row 4 救済 |
| TUI bot 不在 (tmux session なし) | 補強 #5 dead bot detect | auto-restart + operator alert |
| wake pool saturation | saturated metric | 補強 #2 動的拡張、上限到達で alert |
| dead bot restart loop | restart 上限 1h/3 回 | 上限超で停止 + CEO escalate |
| dedup 失敗 (同 row 多重 action) | action は全て idempotent 設計 | 副作用なし |

## 9. Configuration

```ts
interface StateDaemonConfig {
  // wake / sweep (v0.1/v0.2 継承)
  pollSweepIntervalMs: number;        // default 30_000
  pendingStaleAfter: string;          // default '10 seconds'
  readExpiredAfter: string;           // default '30 seconds'
  abandonRecent: string;              // default '60 seconds'
  stuckAfter: string;                 // default '5 minutes'
  wakeDuplicateSuppressSec: number;   // default 5
  batchLimit: number;                 // default 100
  budgetWarnMs: number;               // default 200

  // 補強 #1 claim refresh
  heartbeatIntervalMs: number;        // default 30_000
  claimTtlSec: number;                // default 60

  // 補強 #2 subprocess pool
  wakePoolMinCapacity: number;        // default 5
  wakePoolMaxCapacity: number;        // default 20
  wakePoolGrowStep: number;           // default 2
  wakePoolShrinkStep: number;         // default 1
  wakePoolQueueHighWatermark: number; // default 10

  // 補強 #5 dead bot auto-restart
  botLivenessCheckIntervalMs: number; // default 30_000
  botDeadThresholdMs: number;         // default 120_000
  botRestartMaxPerHour: number;       // default 3
}
```

v0.2 の prevention 関連 config (`maxChainDepth` / `maxPairBounce` / `ackPatternEnabled` / `tuiRateLimit*` / `dispatchLogicDryRun`) は v0.3 で全削除。

## 10. Observable

### 10.1 metrics

- `state_daemon_wake_actions_total{result}` counter
- `state_daemon_pg_notify_lag_ms` histogram
- `state_daemon_sweep_duration_ms` histogram
- `state_daemon_db_errors_total` counter
- `state_daemon_heartbeat_refresh_total{result}` counter (補強 #1)
- `state_daemon_wake_pool_active` gauge / `state_daemon_wake_pool_saturated_total` counter (補強 #2)
- `state_daemon_bot_restarts_total{agent_id}` counter (補強 #5)
- `state_daemon_bot_dead_total{agent_id}` counter (補強 #5)
- `state_daemon_abnormal_activity_total{agent_id, kind}` counter (reactive control 用、例: 5min 5+ msg 生成)

v0.2 の `state_daemon_dispatch_decisions_total` / `state_daemon_loop_prevented_total` は v0.3 で削除。

### 10.2 log

各 wake / sweep / heartbeat / liveness check で 1 行 (構造化 JSON):
```
{ ts, kind, row_id?, agent_id?, action, result, duration_ms }
```

### 10.3 「出てから制御」alert (CEO `e4bfe41c` spirit)

[文献確認 CTO `1d402109`]:

abnormal activity 検出ルール (operator alert を Discord に送出):

| ルール | threshold (default) | 対応 |
|---|---|---|
| 同 bot が 5min で 5+ msg 生成 | 5/5min | operator alert、operator が manual で kill / skip |
| wake pool saturation 連続 5min | — | operator alert、CEO 要対応 |
| bot restart loop 上限到達 | 3/hour | operator alert + CEO escalate |
| daemon DB error 連続 5 回 | 5 連続 | operator alert |

これにより prevention check 不在でも reactive control が成立。

## 11. Test fixtures (contract test、6-section §4 に展開)

[推測]:

| # | input | expected |
|---|---|---|
| T1 | new pending、TUI bot alive | dispatch (wake)、`last_wake_attempt_at` 更新 |
| T8 | pending row、age=15s | re-wake、duplicate suppress 範囲外 |
| T9 | pending row、age=15s、last_wake_attempt 3s 前 | skip wake (duplicate suppression、prevention とは別) |
| T10 | read row、claim_expires_at 5s 前、age=40s | self-reclaim + re-wake |
| T11 | failed row、IMPLICIT_ABANDON、claim_expires_at 30s 前 | reset to pending |
| T12 | read row、age > stuckAfter (`attempts` 列不在の production schema、age-based proxy v0.7 採択) | status='failed'、failed_reason='STALE_DISPATCH' (v0.4 単一固定)、metric inc |
| T13 | DB connection error | retry with backoff、5 連続失敗で alert (v0.4 一本化) |
| T14 | sweep 周期 budget 250ms 消費 | warn log、次周期 skip しない |
| T15 | 同 row が pending-stale + read-expired 両方該当 | 1 action のみ実行 (read-expired > pending-stale) |
| T16 | pg_notify INSERT 受信 | 即時 wake |
| T17 | pg_notify 取りこぼし → cron sweep | 30s 以内に pickup |
| T19 | SIG mode bot に wake 試行 | error throw "SIG mode 廃止済" |
| T20 | wake pool default capacity 5、6 件目 INSERT | 6 件目は queue、saturation で grow |
| T21 (v0.3 新規) | read 状態 30s 経過、bot alive、heartbeat tick | claim_expires_at 延長、`last_heartbeat_at` 更新 (補強 #1) |
| T22 (v0.3 新規) | bot last_seen_at が 3min 前、tmux session なし、TUI runtime | restart 実行、metric inc、operator alert (補強 #5) |
| T23 (v0.3 新規) | bot restart 1h 内 4 回目 | restart 抑止、CEO escalate alert (補強 #5) |
| T24 (v0.3 新規) | wake pool queue が high watermark 超過、capacity < MAX | capacity を grow_step 分拡張 (補強 #2) |
| T25 (v0.3 新規) | wake pool queue 0、capacity > MIN | shrink_step 分縮小 (補強 #2) |
| T26 (v0.3 新規) | 同 bot が 5min で 5+ pending wake | abnormal activity metric inc + operator alert (reactive control) |

v0.2 の T2-T7 (prevention) / T18 (dryRun) は v0.3 で削除。

## 12. Migration / rollout (canary)

[文献確認 CTO `cad7dbd6` 提案 + v0.3 簡素化反映]:

| Phase | 内容 | gate |
|---|---|---|
| 0 | spec freeze (本 doc v0.3)、CEO + CTO + lead-ama review | CEO accept |
| 1 | DB schema migration: `message_queue.last_wake_attempt_at`, `last_heartbeat_at` 追加、`failed_reason` enum 拡張 (`STALE_DISPATCH`)、pg_notify trigger。bot 情報は既存 `agents` table 利用 (新規 column 追加なし、v0.4 patch) | `route:ceo-approval` |
| 2 | state-daemon impl (6-section dispatch 経由 agent-com-dev)、unit + contract test (T1, T8-T17, T19-T26) | auditor pre-impl gate (7 項目) |
| 3 | dev fleet で **wake-daemon と並行稼働 1 時間** (state-daemon は wake 抑制 mode、log のみ) | log 比較で wake-daemon 同等動作確認 |
| 4 | wake 抑制 mode 解除、1 bot ずつ rollout (5 bot づつ wave)、補強 #1/#2/#5 を観測 | metric / log 確認 |
| 5 | wake-daemon 停止、state-daemon 単独運用、launchd 切替 (補強 #3) | abnormal activity / restart loop metric alert 連携 |
| 6 | SIG runtime 全廃 (`agents.runtime` 既存 column を TUI のみに収束、adf-lead / dev-001 TUI 化完了後) | CEO 別途承認 |

## 13. Open decisions (implementer 自由 + CEO 採択待ち)

### 13.1 implementer (agent-com-dev) 自由

- daemon 内部 module 構造 (class / function 分割、private helper 命名)
- pg_notify reconnect の具体 backoff 戦略 (exponential / linear)
- subprocess pool の実装 (in-process queue / worker thread)
- log 形式 (JSON / pino / winston)、CI 互換ならよし
- launchd plist の log path / env (本 spec sample は参考)

### 13.2 CEO 採択待ち (本 spec freeze 前に確定)

| # | 項目 | 提案 default | CEO 判断要請 |
|---|---|---|---|
| O2 | claim TTL default 60s? | 60 | 値変更要否 |
| O3 | heartbeat interval default 30s? | 30 | 値変更要否 |
| O5 | wake 抑制 mode rollout phase 3 で必須? | 必須 (canary) | 同意 / より長期間 / より短期間 |
| O7 (v0.3) | bot restart 上限 1h/3 回? | 3/hour | 値変更要否 |
| O8 (v0.3) | abnormal activity threshold 5msg/5min? | 5/5min | 値変更要否 |

v0.2 の O1 (ack pattern detection) / O4 (TUI rate limit) は v0.3 で削除 (prevention 廃止)。
v0.3 の O6 (bot_registry txt vs DB) は v0.4 で削除 (CTO `70050419` 検証済、`agents` table SoT が既存設計、議論余地なし)。

## 14. 後続 chain

1. ARC が本 spec v0.3 を CEO/CTO に submit、accept 待ち (本 dispatch)
2. CEO 採択 (§13.2 O2-O8) 後 freeze
3. lead-ama (agent-comms 担当) が 6-section 指示書 authoring (本 spec → impl 翻訳)
4. auditor Pre-impl gate (7 項目)
5. agent-com-dev impl (route:ceo-approval、DB migration 含む)
6. L1 (lead-ama) → L2 (auditor) → L3 (CTO) → CEO accept → merge
7. Phase 3-6 rollout (canary)

## 15. References

- Issue #323
- 本日 議論 chain: CEO `2c8c0428` / CEO `7670b33f` / CEO `481b8fa0` / CEO `e4bfe41c` (v0.3 簡素化 greenlight) / CTO `446d5c4d` / CTO `f0916e13` / CTO `cad7dbd6` / CTO `720cf233` / CTO `1d402109` (v0.3 directive) / CTO `907b7e9b`
- spec `docs/agent-com-message-queue-spec.md` §13.5.1 (delivery layer)
- 関連 component: `bin/wake-daemon.ts` (廃止予定), `core/inbox-cursor.ts`, `core/claim-ttl.ts`, `adapters/inbound-receiver.ts`
- 関連 incident: webb-dev 27008、本日 B8 arc↔adf-lead bounce、本日 ARC reply_chain misread (msg `c9c6655c`)
- 関連 PR: #318, #325, #326
- 関連 doc: `docs/B8-loop-detection-spec-amendment-v0.md`
- governance: `~/.claude/rules/governance-flow.md` (4-layer chain + Spec→Impl auditor 監査 7 項目)
- memory: `feedback_self_enforcement_via_hook` (機械強制原則、v0.3 では LLM 自主規律 + reactive control の組合せに変更)、`feedback_arc_no_direct_commit` (ARC は branch に直接 commit しない)
