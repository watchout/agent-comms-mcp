# Outbound Forwarder Unification (S2-A / S3 相当)

Status: **Implemented** (PR #172 FEAT-005 adapter rewrite, merged 2026-04-14)
Route: `route:ceo-approval` (architectural shift / 全 bot 挙動変更)
Feature: **FEAT-005** (SSOT-1, status = Implemented)
CEO 承認: **2026-04-12 23:07 UTC = 2026-04-13 08:07 JST** (Open Q1-5 全件 CTO 推奨採用、CTO 追加指摘 §5.2 mutex 反映) + **2026-04-14** (retroactive dev-DB migration apply + 1-PR-2-concern waiver)
Related merged: PR#139 / #140 / #142 / #156 / #157 / #160 / #161 / #168 / #172
Related in-flight: —

Implementation summary (PR #172):
  - `adapters/discord-client.ts` — Discord.js client wrapper, shared-
    fallback removed (getDiscordClient returns null + error log on
    unknown botId).
  - `adapters/outbound-consumer.ts` — consumer + PollingDriver + orphan
    reclaim + force-release watchdog. Claim state renamed
    `'processing'` → `'claimed'` (work-queue standard vocabulary).
  - `adapters/inbound-receiver.ts` — handleInboundMessage +
    startListener + sendHumanWarning. ON CONFLICT (agent_id,
    message_id) DO NOTHING preserved.
  - `entrypoints/daemon.ts` — sole caller of startOutboundConsumer.
  - `scripts/{bot-registry.txt,restart-bot.sh,watchdog.sh}` +
    `server.ts::DEFAULT_CLAUDE_CMD` — `--dangerously-load-development-
    channels` flag removed from the 4 locations.
  - CI retrofit: pr-checks.yml + detect-breaking-changes.sh + migrate
    idempotency test + `import.meta.main` guard on db/migrate.ts.

---

## 0. Summary (TL;DR)

`outbound_queue` consumer (`server.ts` L887-925) が **全 19 bot プロセスで並走** している。

- SSOT `docs/agent-com-message-queue-spec.md` **§1 line 39** は
  > **「daemon は PollingDriver と outbound_queue 消費を担当する」**

  と明記している。SSOT-1 **FEAT-005** "Outbound forwarder unification (daemon-owns-outbound, S2-A/S3)" は
  この invariant を実装側に pin する作業。
- 現行実装は `registerAgent()` 経由で **stdio / daemon 双方**の runtime で consumer を起動しており
  SSOT に drift。claim SQL が `status='pending'` を不変とするため race が発生し、
  `getDiscordClient` の shared fallback で identity 誤帰属 (row.agent_id ≠ 実際に post した bot) が発生。

**推奨案 = Option A (daemon-owns-outbound)**。選定理由の主軸は **SSOT §1 line 39 準拠**。
v1 で推奨した Option B (stdio-owns-outbound) は SSOT と真っ向矛盾するため採用不可 (v1 差し戻し理由)。

---

## 1. Context & Problem Statement

### 1.1 SSOT 既定 (Ground Truth)

`docs/agent-com-message-queue-spec.md` §1 "原則 #2 の実装対応（ADR-041 S2-B / PR#157）":

| 対象 runtime | inbound receiver | outbound consumer |
|---|---|---|
| stdio モード | ✅ 唯一の `handleInboundMessage` callsite | ❌ 関与しない |
| daemon モード | ❌ (Pattern A 警告のみ許容) | ✅ **PollingDriver と outbound_queue 消費を担当** (§1 line 39) |

SSOT-1 `FEAT-005` は本不変条件を `tests/spec-enforcement/s2a-daemon-owns-outbound.test.ts` で
source レベルに pin することを status=Refactoring として要求している
(S2-B が `s2b-receiver-unify.test.ts` で実装しているのと鏡像)。

### 1.2 現行実装の drift

```ts
// server.ts L720-739 (registerAgent)
async function registerAgent(...) {
  // ...
  startOutboundConsumer()          // ← stdio / daemon 問わず必ず起動
  pollingDriver.start(AGENT_ID)    // ← stdio / daemon 問わず必ず起動
}
```

```ts
// server.ts L887-917 (consumeOneOutboundRow, claim SQL)
UPDATE outbound_queue SET attempts = attempts + 1
 WHERE id = (SELECT id FROM outbound_queue
              WHERE status='pending' ORDER BY created_at ASC LIMIT 1
              FOR UPDATE SKIP LOCKED)
 RETURNING ...
-- ↑ status は 'pending' のまま。単一ステートメントの row lock 解放直後に
--   次 tick・別プロセスが同じ row を再 claim 可能。
```

```ts
// server.ts L270 (getDiscordClient)
return discordClients.get(botId) ?? discord   // fallback で自 bot の shared client
```

3 要素の組合せで以下の drift chain が発生する:

1. SSOT 違反: 19 bot プロセス (stdio 実行体含む) が並走して consumer を走らせる
2. race: claim SQL が status を変えないため `FOR UPDATE SKIP LOCKED` が tick 間で効かない
3. identity 誤帰属: `row.agent_id` と実送信者 bot が不一致でも fallback が許してしまう

### 1.3 Downstream impact (v1 から補強)

**(a) 受信 session への 3〜N 重 push**

同一コンテンツが異なる `discord_message_id` で 3〜6 件 Discord に post される
(観測例: 2026-04-12 22:26:02-04 UTC の handoff 2 は CTO/ARC/Dev Auditor × 2 parts =
 6 件の重複 discord_message_id)。stdio receiver は各 post を
別 row として `handleInboundMessage` → `agent_messages` / `message_queue` に INSERT するため、
各受信 bot の `next` queue に N 件の実質同一メッセージが届く (受信側 UX 劣化)。

**(b) PR#142 `uq_mq_agent_message` UNIQUE すり抜け**

PR#142 は `(agent_id, message_id)` での partial UNIQUE を message_queue に追加したが、
**`message_id` は inbound INSERT 時に discord_message_id から生成される**。
Outbound 重複は Discord REST API が別 `discord_message_id` を返すため、
inbound 側では「別メッセージ」として扱われ、UNIQUE 制約はすり抜ける。
つまり S2-B の構造保証は inbound 側で閉じており、outbound 側の
「1 論理メッセージ = 1 discord post」を保証する別機序が別途必要。

**(c) audit log の汚染**

`audit_log` に N 件の `outbound.send.success` が記録され、送信成功率・レイテンシ等の
運用メトリクスが水増しされる。PR#142 までの観測で `attempts=15-17` の row が散見される。

### 1.4 なぜ 1 行 SQL patch で足りないか (再掲)

`status='pending' → 'processing'` の atomic flip だけを入れても **identity 誤帰属は残る**
(fallback の撤廃が必要)。逆に fallback を消すだけでも **race は残る**
(claim SQL の status 遷移が必要)。さらに現状のような 19 並走 consumer は **SSOT 違反**で、
「daemon のみ」に絞る runtime gate が必要。

構造修正は 3 要素同時 fix であり、CEO 承認 scope "構造修正・forwarder 統一パターン" に該当する。

---

## 2. Design Alternatives

### Option A — daemon-owns-outbound (SSOT 準拠) ★推奨

- consumer 起動を **daemon runtime に限定**する runtime gate を `startOutboundConsumer()` に追加
- claim SQL を atomic flip に修正: `SET status='processing', attempts=attempts+1, claimed_at=now()`
- filter に `agent_id=$1` を追加 (自 bot の row のみ claim)
- `getDiscordClient` の outbound path で fallback 禁止 (agent_id に一致する client 必須)
- transient 失敗時の **exponential backoff** (§3.4)
- **`processing` → `pending` orphan reclaim** (死 consumer からの救出、§3.5)
- spec-enforcement test `s2a-daemon-owns-outbound.test.ts` で source レベル pin

| 軸 | 評価 |
|---|---|
| race | ✅ agent_id フィルタ + status flip で 1 row = 1 bot = 1 post |
| identity 誤帰属 | ✅ 自 row しか触らないので定義上発生しない |
| SSOT §1 line 39 準拠 | ✅ daemon 専任 |
| 新規 deploy unit | ✅ なし (既存 daemon 内) |
| token 集中 | ✅ 各 bot が自 token のみ保持 (現状維持) |
| S2-B 対称性 | ◎ inbound stdio / outbound daemon の役割分離が完成 |
| 実装量 | 小〜中 |

### Option B — stdio-owns-own-outbound (v1 推奨、**本 v2 で却下**)

- consumer を stdio runtime に限定
- SSOT §1 line 39 (daemon 所有) と **真っ向矛盾**

**却下理由**: SSOT 違反。drift を作る設計を推奨することは review theater の直接原因。
v1 でこの案を推奨したのは lead-ama の SSOT 照合ミス (2026-04-12 CEO 指摘)。
以後 memory `feedback_check_ssot_before_drafting.md` として運用規律に取り込み済み。

### Option C — 集中型 Forwarder Daemon (token 集約)

- 新規プロセス `agent-comms-mcp outbound-forwarder` が全 bot token を保有
- 全 bot は `OUTBOUND_QUEUE_CONSUMER=0`
- SSOT §1 line 39 の「daemon」が複数 bot の daemon プロセスを指すか単一集中プロセスを指すかは
  曖昧解釈可能。素直な読みは **各 bot の daemon** (= Option A)

| 軸 | 評価 |
|---|---|
| race | ✅ 単一 consumer |
| identity 誤帰属 | ✅ row.agent_id で client 選択 |
| SSOT §1 line 39 準拠 | △ 解釈依存 |
| 新規 deploy unit | ❌ +1 process |
| token 集中 | ❌ 19 bot 分の token を 1 プロセスで保持 (blast radius ↑) |
| 実装量 | 中〜大 |

将来的に bot 数が増えた段階で再検討。**再評価 trigger は `docs/agent-com-message-queue-spec.md §14.5` (polling driver スケーラビリティ段階) 到達時** (CEO 2026-04-12 23:07 UTC 指示、§9 Q5)。Phase 1 規模 (19 bot) では採用しない。

---

## 3. Recommended Design — Option A (daemon-owns-outbound)

### 3.1 選定理由 (SSOT 準拠を主軸)

1. **SSOT §1 line 39 明文既定**: 「daemon は PollingDriver と outbound_queue 消費を担当する」
2. **SSOT-1 FEAT-005** が status=Refactoring で本不変条件の実装 pin を要求
3. **S2-B との対称性**: inbound を stdio 1 点に集約した S2-B (PR#157) と、outbound を daemon 1 点に集約する本 PR で、runtime 責務分離が完成
4. **blast radius 最小**: 新規プロセス・新規 token 集約・重い migration なし
5. **Option B/C との比較**: B は SSOT 矛盾で不可、C は現規模で過剰

### 3.2 runtime gate

```ts
// server.ts registerAgent()
startOutboundConsumer()  // ← 内部で runtime 判定
```

```ts
function startOutboundConsumer() {
  if (process.env.OUTBOUND_QUEUE_CONSUMER === '0') return
  if (!isDaemonRuntime()) {
    process.stderr.write('agent-comms: outbound consumer skipped (stdio runtime)\n')
    return
  }
  // ... existing setInterval ...
}
```

daemon runtime の識別方法 (**v5 で認識反転、codex-auditor 2026-04-13 01:52 UTC PR #164 B3 指摘反映**):

Production 運用の実態は「各 bot は Claude Code TUI + MCP server (stdio) を tmux session で起動」(= `scripts/bot-registry.txt` の COMMAND 列が SSOT)。CLI `agent-com daemon` は使用されていない。したがって SSOT §1 line 39 の「daemon」は、production reality においては **bot 起動経路で立ち上がる MCP server process 自身** を指す:

- **起動経路 SSOT**: `scripts/bot-registry.txt` の各行 COMMAND、および `scripts/restart-bot.sh` の `DEFAULT_CMD`
- **runtime 識別方法**: bot-registry / restart-bot.sh の COMMAND 先頭に `AGENT_COM_RUNTIME=daemon` を prefix。tmux session から MCP server に env 継承される
- **stdio と daemon の二分を撤回**: 本 plan の当初前提 (stdio=inbound 専任 / daemon=outbound 専任) は production 実装では実現されておらず、今後も (ADF の大規模化まで) MCP server process が両責務を持つ。inbound routing は `handleInboundMessage` が 1 callsite 限定 (PR#157 S2-B) で構造保証済、outbound は `AGENT_COM_RUNTIME=daemon` 設定 + `isDaemonRuntime()` gate で起動制御
- **CLI `agent-com daemon` 経由起動**: production で未使用だが、PR #164 の `cli/index.ts` が `process.env.AGENT_COM_RUNTIME='daemon'` を設定しているため、仮に CLI 経由起動しても同挙動となる (two-path support、backwards compatible)
- **spec-enforcement**: `tests/spec-enforcement/s2a-daemon-owns-outbound.test.ts` に bot-registry.txt / restart-bot.sh への env prefix が存在することを assert 追加 (PR #164 cycle 3 で実装)

### 3.3 atomic claim + agent_id filter

```sql
UPDATE outbound_queue
   SET status = 'processing',
       attempts = attempts + 1,
       claimed_at = now()
 WHERE id = (SELECT id FROM outbound_queue
              WHERE status = 'pending'
                AND agent_id = $1
                AND (next_retry_at IS NULL OR next_retry_at <= now())
              ORDER BY created_at ASC
              LIMIT 1
              FOR UPDATE SKIP LOCKED)
 RETURNING id, message_id, channel_external_id, content, mentions_display,
           attachments, reply_to_discord_id, attempts, max_attempts
```

`status='processing'` の atomic flip により、lock 解放後に同 row が再 claim 不能。
`agent_id=$1` で自 bot の row 以外は触らない。

### 3.4 Transient 失敗時の exponential backoff

```
delay(attempt) = min(30s, 1s * 2^(attempt - 1)) + jitter(0..500ms)
next_retry_at = now() + delay(attempts)
```

- status を 'pending' に戻し、claim SQL の `next_retry_at <= now()` で再 claim 可
- max_attempts=5 に対し: 1s, 2s, 4s, 8s, 16s (caps at 30s) + jitter
- jitter は thundering herd 回避 (agent_id filter で単一 bot に限定されているため影響小だが、Option C への移行余地を残す)
- transient 判定は **本 consumer 内に inline で保持** (`core/send-errors.ts` は送信 tool 側の入力 validation helper であり Discord transport retry classifier の住所ではない)。判定分類: network error / Discord rate-limit (429) / Discord 5xx を transient、他を permanent。実装時に共通ヘルパ `isTransientDeliveryError()` を server.ts 内に新設
- (v3→v4 修正、codex-auditor 2026-04-12 6 axes review (A) 指摘反映)

### 3.5 Orphan reclaim (`processing` stuck recovery)

daemon プロセスが crash した場合、row が `status='processing'` のまま残る。別 tick で reclaim:

```sql
UPDATE outbound_queue
   SET status = 'pending', last_error = 'orphan_reclaim', claimed_at = NULL
 WHERE status = 'processing'
   AND agent_id = $1
   AND claimed_at < now() - interval '5 minutes'
```

- 実行頻度: 60s tick (outbound consumer tick とは別)
- 5 分閾値は `OUTBOUND_ORPHAN_TIMEOUT_SEC` env で調整可能
- reclaim された row は exponential backoff の対象 (`next_retry_at` を `now() + delay(attempts)` に再計算)

### 3.6 Fallback 撤廃

```ts
const clientForAgent = discordClients.get(row.agent_id)
if (!clientForAgent) {
  await markOutboundFailed(row.id, 'no_discord_client_for_agent')
  return
}
await clientForAgent.sendAdapterMessage({ ... })
```

`getDiscordClient()` helper 自体は保持 (他の caller への影響回避)、本 PR では outbound send path だけ直接 `discordClients.get()` を使い、`?? discord` を書かない。spec-enforcement test でソース上に `?? discord` が outbound send 周辺に無いことを pin する。

---

## 4. Test Strategy

### 4.1 Spec-enforcement (新規 + 拡張)

**`tests/spec-enforcement/s2a-daemon-owns-outbound.test.ts`** (新規):
- `startOutboundConsumer` 関数本体に `isDaemonRuntime()` ガード相当の分岐があること
- `consumeOneOutboundRow` の claim SQL (regex) に `SET status = 'processing'` と `WHERE ... agent_id = $` が同時出現
- claim SQL に `next_retry_at <= now()` 条件が存在
- outbound send path 付近 (L900-940 相当) に `\?\? discord` が出現しないこと
- orphan reclaim 関数が存在し、閾値 env `OUTBOUND_ORPHAN_TIMEOUT_SEC` を参照
- SSOT `docs/agent-com-message-queue-spec.md` §1 line 39 への参照コメントが `server.ts` に存在

**既存拡張**:
- `tests/outbound-consumer.test.ts`: `processing` 遷移の 3 分岐 (success/fail/transient) + backoff 計算
- `tests/spec-enforcement/s2b-receiver-unify.test.ts`: (変更なし、inbound 責務は不変)

### 4.2 Regression fixtures (2026-04-12 重複事例)

以下を `scripts/verify-no-outbound-dup.sql` に固定データとして残し、post-merge 検証で毎回チェック:

| 時刻 (UTC) | 事例 | 重複度 | 代表 discord_message_id / agent_messages UUID |
|---|---|---|---|
| 21:43:54 | CTO→lead-ama handoff 1 | 2-fold | `1493003755694854355`, `1493003757884149910` (UUIDs `6ce95e6d-…`, `ea269b87-…`) |
| 21:50:25 | 追加指示メッセージ | 3-fold | `1493005398880423966`, `1493005399471816835`, `1493005403527581938` (UUIDs `ff393651-…`, `189e2396-…`, `76af6860-…`) |
| 21:53 頃 | lead-ama→CTO 計画書 v1 報告 | 2-fold | agent_messages UUIDs `dbd6f9ef-…`, `e940355c-…` |
| 22:26:02-04 | CTO→lead-ama handoff 2 (2-part) | 6-fold (3 bot × 2 part) | `1493014358945693802`〜`1493014367413862460` |

検証 SQL (conceptual):
```sql
-- 同一 content hash で複数 discord_message_id が agent_messages に残っていないこと
SELECT md5(content) AS h, count(DISTINCT discord_message_id) AS n
  FROM agent_messages
 WHERE created_at > now() - interval '1 hour'
 GROUP BY 1
HAVING count(DISTINCT discord_message_id) > 1;
-- → 0 rows を期待
```

### 4.3 20-bot スケール integration

- local docker-compose (or k8s kind) に bot プロセス 20 並走 + bulk insert 100 outbound row
- mock Discord adapter で `sendAdapterMessage` call 数を count
- 全 row が **1 回のみ** 送信されたか
- 平均 latency ≤ 1.5s / P99 ≤ 3s / `attempts` 中央値 = 1 / P99 ≤ 2

### 4.4 Concurrent race unit test

- 同一 row を 2 つの async claim goroutine で同時 trigger
- 結果: 片方のみ成功 / もう片方は `rows.length === 0`
- backoff 検証: transient 失敗を 3 回シミュレート後の `next_retry_at` を assert

### 4.5 Orphan reclaim

- `status='processing'` + `claimed_at=now() - 6 min` の row を人為生成
- reclaim tick 後に `status='pending'` に戻ること
- `last_error='orphan_reclaim'` が記録されていること

### 4.6 Regression range

- PR#139 PollingDriver / #140 mq dedup / #142 UNIQUE / #156 D3 fallback / #157 inbound 統一 の test suite を full green 維持
- `framework gate check` 全 gate 通過 (Gate A は docker-compose follow-up 待ち、B/C は PASS 必須)

---

## 5. Rollout Plan

### 5.1 Feature flag

- env `OUTBOUND_FORWARDER_MODE` ∈ {`legacy`, `daemon-only`, `off`}
- 既定 `legacy` (= 現挙動) でマージ
- `daemon-only` で本設計有効化
- `off` は全 consumer 停止 (緊急 brake、§6.3)

### 5.2 Canary

1. **canary 1 bot**: 低トラフィックな `secretary` (CEO 承認済)
2. 24h 観測: 重複 post 0 / `attempts` 中央値=1 / P99 ≤ 2 / orphan reclaim 発火率
3. `lead-ama` / `agent-com-dev` / `auditor` / `arc` を順次切替
4. 4 bot で 48h 安定後、残り 14 bot を rolling 切替 (1 min 間隔)

#### 5.2.1 canary 期間中の旧/新経路の mutual exclusion (CTO 追加指摘、CEO 承認済)

canary 中、`outbound_queue` は `agent_id` filter で排他制御される:

- secretary の row は **新経路**で secretary daemon のみが claim (`WHERE agent_id='secretary' AND status='pending'` + runtime gate が daemon のみ claim)
- 他 18 bot の row は **legacy 経路**で各 stdio consumer が claim (`OUTBOUND_FORWARDER_MODE=legacy` の挙動 = agent_id filter なし + status 不変の旧 claim SQL)
- 同一 row が新旧両経路から claim されることはない: canary bot の agent_id は新経路でのみ filter 合致し、他 bot の row は legacy 経路の全 consumer から見えるが **secretary daemon は agent_id filter で参加しない** ため競合しない

この mutual exclusion が canary を安全にする構造的根拠。feature flag の切替えが atomic でなくても (process 間で `OUTBOUND_FORWARDER_MODE` 伝播に数秒の skew があっても) duplicate post は発生しない。

### 5.3 bot 再起動順序

- daemon プロセスが outbound consumer を起動するように env 更新 + `restart_bot` 順次発火
- stdio 側は runtime gate が効くが二重安全で `OUTBOUND_QUEUE_CONSUMER=0` 相当を env 配布
- `scripts/rollout-daemon-owns-outbound.sh` に順序を記述

### 5.4 Default flip

- 全 19 bot が `daemon-only` で **3 日間**安定 (v1 の 7 日から短縮、§9 Q2)
- 既定を `daemon-only` に変更 (別 PR、fast-merge)
- その次の cleanup PR で `legacy` 経路コードを削除 (別 PR、fast-merge)

---

## 6. Rollback Plan

### 6.1 即時 (minutes)

- `OUTBOUND_FORWARDER_MODE=legacy` を全 bot env に配布 → bot restart で旧挙動復帰
- flag 切替だけでコードは同一 binary、revert PR 不要

### 6.2 コード revert (hours)

- 本機能 PR を `git revert <merge-sha>` → fast-merge revert PR
- claim SQL 旧形 + fallback 復活で完全旧状態

### 6.3 緊急 brake (seconds)

- `OUTBOUND_FORWARDER_MODE=off` 一斉配布 → outbound 送信完全停止
- bridge / webhook / direct `discord.sendAdapterMessage` は継続 (別 path)

---

## 7. Migration Impact

### 7.1 Schema

- CHECK constraint は既に `'processing'` を許容 → **status migration 不要**
- **追加**: `claimed_at TIMESTAMPTZ NULL` (orphan reclaim 用)
- **追加**: `next_retry_at TIMESTAMPTZ NULL` (exponential backoff 用)
- 追加 INDEX:
  - `(status, claimed_at) WHERE status='processing'` (orphan reclaim 高速化)
  - `(agent_id, status, next_retry_at) WHERE status='pending'` (claim SQL 高速化)
- 既存行への影響: 全列 NULL 可、backfill 不要

### 7.2 Backfill

- 既存 row に変更なし (`claimed_at=NULL`, `next_retry_at=NULL`)
- daemon 起動時に 1 回だけ:
  `UPDATE outbound_queue SET status='pending' WHERE status='processing' AND agent_id=$1 AND claimed_at IS NULL AND created_at < now() - interval '5 min'`
  (旧 `processing` 残骸を reclaim、新設計前の行を無害化)

### 7.3 Route label

- ADD COLUMN NULL + ADD INDEX のみで blast radius 極小だが、architectural shift につき **`route:ceo-approval` 維持**

---

## 8. Effort Estimate

| Phase | 作業 | 工数 |
|---|---|---|
| Design sync | 本 v2 計画書 gate-design review + CTO/CEO 承認 | 2h |
| Implementation | runtime gate / claim SQL / backoff / orphan reclaim / fallback 撤廃 | 8-10h (agent-com-dev) |
| Tests | spec-enforcement + integration + race + orphan + regression fixture | 6h (agent-com-dev) |
| Migration | ADD COLUMN (2) + ADD INDEX (2) + cleanup query | 1h (agent-com-dev) |
| Canary rollout | secretary 24h → 4 bot 48h → 残 14 bot (1min rolling) | 実時間 3 日 |
| Post-merge 検証 | 全方位 (governance-flow.md Gate D 準拠) | 3h (4-layer chain) |

**合計**: 設計承認まで 2h / 実装 merge まで **2 日** / 全体 rollout 完了まで **約 3-4 日**

---

## 9. Resolved decisions (CEO 承認済 2026-04-12 23:07 UTC / 08:07 JST)

全 5 件、CTO 推奨案で CEO 確定。以下は記録目的で保持 (後から「何がどう決まったか」を辿れるように):

1. **canary bot** → ✅ `secretary` に確定 (低トラフィック優先)
2. **default flip timing** → ✅ 3 日 (canary 24h + 4bot 48h = 3 日で全 19 bot covered)
3. **legacy 削除 PR の分離** → ✅ default flip と別 PR (blast radius 分離)
4. **migration column 数** → ✅ `claimed_at` + `next_retry_at` の 2 列追加 (明示性重視、`attempts * interval` 推定は不採用)
5. **Option C (集中型) 再評価 trigger** → ✅ 現規模 (Phase 1, 19 bot) では planning 外。**再評価 trigger は `docs/agent-com-message-queue-spec.md §14.5` (polling driver スケーラビリティ段階)** に到達した時点 (CEO 指示、本計画書でも §3.1 Option C 評価の前提として参照)

---

## 10. References

### Code
- `server.ts` L270 (`getDiscordClient` fallback)
- `server.ts` L720-739 (`registerAgent` → `startOutboundConsumer`)
- `server.ts` L887-962 (`consumeOneOutboundRow` claim + send + update)
- (~~`core/send-errors.ts`~~ は **参照しない**、v4 で修正。理由: 送信 tool validation helper であり transport retry classifier の住所ではない)

### SSOT / Spec
- `docs/SSOT.md` §1.4 (7 invariants)
- **`docs/agent-com-message-queue-spec.md` §1 line 39** (daemon-owns-outbound、本 PR 最重要既定)
- `docs/agent-com-message-queue-spec.md` §7 (outbound_queue schema)
- `docs/agent-com-message-queue-spec.md` §3.3 (失敗ハンドリング)

### Feature Catalog
- **SSOT-1 FEAT-005** "Outbound forwarder unification (daemon-owns-outbound, S2-A/S3)" status=Refactoring
- SSOT-1 FEAT-049 "Orphan reclaim" status=Refactoring (本 PR で実装)
- SSOT-1 FEAT-050 "Spec-enforcement tests (s2b-receiver-unify, s2a-daemon-owns-outbound)"

### Related PRs
- PR#139 PollingDriver / PR#140 mq dedup / PR#142 UNIQUE / PR#156 D3 fallback
- PR#157 S2-B inbound unify (対称先行実装)
- PR#160 ADF retrofit / PR#161 SSOT-1 populated
- PR#162 ADF enforcement hooks (in-flight、v2 gate-design review の前提)

### Startup SSOT (v5 追加)
- **`scripts/bot-registry.txt`** — 全 bot の起動 COMMAND 列 (SESSION|PROJECT_DIR|AGENT_ID|PORT|COMMAND)。watchdog / restart-bot.sh が verbatim 参照する production 起動経路。`AGENT_COM_RUNTIME=daemon` prefix はここに設定 (PR #164 cycle 3 で全 19 bot 反映)
- **`scripts/restart-bot.sh`** — `DEFAULT_CMD` 変数が registry fallback 時の COMMAND。ここにも同 env prefix を反映
- **`cli/index.ts` `daemon()`** — CLI 経由起動時の `process.env.AGENT_COM_RUNTIME='daemon'` 設定 (現 production 未使用、backwards compatible)

### Governance
- `~/.claude/rules/governance-flow.md` — 4-layer review chain、Gate D post-merge 検証
- ADR-041 (Receiver-MessageBus) / ADR-045 (Dev-Lead Pool)

### 2026-04-12 duplicate 事例 (regression fixture 根拠)
- 21:43:54 UTC: 2-fold (handoff 1) — UUIDs `6ce95e6d-…`, `ea269b87-…`
- 21:50:25 UTC: 3-fold (追加指示) — UUIDs `ff393651-…`, `189e2396-…`, `76af6860-…`
- 21:53 UTC 頃: 2-fold (lead-ama v1 報告) — UUIDs `dbd6f9ef-…`, `e940355c-…`
- 22:26:02-04 UTC: 6-fold (handoff 2、3 bot × 2 part) — discord_message_ids `1493014358945693802`〜`1493014367413862460`

---

## Change log

| 日付 | 変更 | 理由 |
|---|---|---|
| 2026-04-13 JST | v1 | 初版 |
| 2026-04-13 JST | v2 | v1 差し戻し反映: SSOT §1 line 39 引用追加 / 推奨を Option A に変更 / exponential backoff + orphan reclaim 追記 / spec-enforcement test 定義 / regression fixture 拡張 (4 事例) / FEAT-005 参照 |
| 2026-04-13 JST | v3 | CEO 全件承認 (2026-04-12 23:07 UTC) を反映: §5.2.1 に canary 期間の新/旧経路 mutual exclusion を CTO 追加指摘に従い明文化 / §9 を "Resolved decisions" に転換し 5 件の確定結果を記録 / §9 Q5 + §2 Option C に「§14.5 スケール段階を再評価 trigger」を CEO 指示として明示 / ヘッダに CEO 承認日時記載 |
| 2026-04-13 JST | v4 | codex-auditor 2026-04-12 23:26 UTC 6 axes review (A) 指摘反映: §3.4 transient 判定を `core/send-errors.ts` 継承から **本 consumer 内 inline 保持** (`isTransientDeliveryError()` 新設) に修正。§10 References から send-errors.ts を削除 (参照しない旨注記)。実装側 PR #164 との整合回復 |
| 2026-04-13 JST | **v5** (本版) | codex-auditor 2026-04-13 01:52 UTC PR #164 B3 指摘反映: §3.2 "daemon runtime の識別方法" を production 実態に合わせ認識反転。§10 References に **Startup SSOT 節** (bot-registry.txt / restart-bot.sh / cli daemon) 新設。stdio/daemon 二分の当初前提を明示撤回 |
