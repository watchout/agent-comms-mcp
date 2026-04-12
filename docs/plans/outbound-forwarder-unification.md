# Outbound Forwarder Unification (S2-A / S3 相当)

Status: **draft v1** (author: lead-ama, 2026-04-13 JST)
Route: `route:ceo-approval` (architectural shift / 全 bot 挙動変更)
Related: PR#140 / PR#142 / PR#156 / PR#157 (merged), issue #147 / epic #141

---

## 0. Summary (TL;DR)

`outbound_queue` consumer (`server.ts` L887-925) が **全 19 bot プロセスで並走** している一方、
claim SQL が `status='pending'` を変更しないため、同一 row が tick ごとに `FOR UPDATE SKIP LOCKED` を
すり抜けて再 claim されうる。加えて `getDiscordClient(row.agent_id)` は自 bot の shared client に
フォールバックするため、row の真の送信者とは別 bot の identity で Discord に post される。

PR#157 (S2-B inbound 統一) と対称な **outbound 統一** を行う。設計案は 3 つ (§2):

- **A** 専任 forwarder daemon (集中型、全 bot token 保有)
- **B** stdio-owns-own-outbound (各 bot の stdio 実行体が自 agent_id 分のみ claim) ★推奨
- **C** 局所 patch のみ (claim SQL atomic flip + fallback 撤廃、consumer は従来どおり N 並走)

推奨は **B**: PR#157 が選んだ「1 runtime が 1 責務を所有」の対称形。新規プロセスなし、トークン集中管理なし、
`constraint` も既に `'processing'` を許容 (migration 不要)。

---

## 1. Context & Problem Statement

### 1.1 観測事象 (2026-04-12 21:xx JST)

- CTO→CEO の 1 件のメッセージが Discord 上に **3-4 bot** (lead-ama / codex / arc 等) の identity で重複 post
- 本 handoff message 自身も CTO / auditor / agent-com-dev の 3 連 post として届いている (live 事例)
- outbound_queue row `270561d3` の `attempts=15` を DB 上で確認

### 1.2 根本原因

1. `server.ts` L901-912 claim SQL:
   ```sql
   UPDATE outbound_queue SET attempts = attempts + 1
   WHERE id = (SELECT id FROM outbound_queue WHERE status='pending'
               ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING ...
   ```
   `status` を `'pending'` のまま残すため、単一ステートメントの row lock 解放直後に
   **次 tick・別プロセスが同じ row を再 claim** できる。`attempts++` のみでは race を止められない。

2. `server.ts` L270 `getDiscordClient(botId)`:
   ```ts
   return discordClients.get(botId) ?? discord
   ```
   bot プロセス A が `agent_id='cto'` の row を claim しても、A は 'cto' client を持たないため
   shared `discord` (=A 自身の token) にフォールバック。結果として **誰の名前で post したか =
   どの bot が先に race に勝ったか**。

3. `startOutboundConsumer()` は `registerAgent()` 経由で **全 19 bot プロセスで起動** される
   (`server.ts` L739)。19 並走 × 1 秒 tick = row 1 件あたり期待再 claim 回数 ≫ 1。

### 1.3 なぜ 1 行 SQL patch で足りないか

`status='pending' → 'processing'` の atomic flip だけ入れても、**identity 誤帰属** は残る
(row.agent_id と実際に post した bot が不一致のまま)。逆に fallback を消すだけでも race は残る。
**2 点の同時修正 + 運用上の consumer 数削減** が必要で、これは「構造修正」に該当する。

---

## 2. Design Alternatives

### Option A — 集中型 Forwarder Daemon

- 新規プロセス `agent-comms-mcp outbound-forwarder` (systemd / tmux 単体)
- 全 bot token を保有し、`outbound_queue` の唯一の consumer
- 全 bot プロセスは `OUTBOUND_QUEUE_CONSUMER=0` (既存 env)
- `LISTEN outbound_enqueued` + fallback polling

| 軸 | 評価 |
|---|---|
| race | ✅ 単一 consumer で原理的に発生しない |
| identity 誤帰属 | ✅ row.agent_id で正しい client を選択 (fallback 不要) |
| 新規 deploy unit | ❌ +1 process (監視 / restart / token 配布) |
| token 集中 | ❌ 19 bot 分の token を 1 プロセスで保持 (blast radius ↑) |
| S2-B 対称性 | ◎ inbound が stdio 1 点に集約されたのと鏡像 |
| 実装量 | 中〜大 (bootstrap + token loader + 監視) |

### Option B — stdio-owns-own-outbound (推奨)

- 各 bot プロセスは **自 agent_id の row のみ** claim (`WHERE agent_id = $1`)
- claim SQL を atomic flip に修正: `SET status='processing', attempts=attempts+1`
- 成功 → `'sent'`、exhausted → `'failed'`、transient → `'pending'` へ戻す (リトライ許可)
- consumer は **stdio runtime のみ** で起動 (daemon runtime では常に無効化)
- `getDiscordClient()` の fallback 分岐は outbound path から除去 (shared `discord` は自 bot token = agent_id と一致するので実質無害だが明示撤廃)

| 軸 | 評価 |
|---|---|
| race | ✅ agent_id フィルタ + status flip で 1 row = 1 bot = 1 post |
| identity 誤帰属 | ✅ 自 row しか触らないので定義上発生しない |
| 新規 deploy unit | ✅ なし |
| token 集中 | ✅ 各 bot が自 token のみ保持 (現状維持) |
| S2-B 対称性 | ◎ 「1 runtime が 1 責務を所有」原則の鏡像 |
| 実装量 | 小〜中 (claim SQL + filter + start gate の差替え) |

### Option C — 局所 patch only

- claim SQL を atomic flip に修正
- `getDiscordClient` の fallback を outbound path で禁止 (無い場合は skip + `'failed'`)
- consumer 数・runtime 配置は現状維持 (19 並走)

| 軸 | 評価 |
|---|---|
| race | ○ status flip で解消、だが 19 並走は無駄な DB 負荷 |
| identity 誤帰属 | ✅ fallback 撤廃で解消 |
| 新規 deploy unit | ✅ なし |
| 「構造修正」該当性 | △ CEO 承認 scope ("構造修正・forwarder 統一パターン") との整合弱 |
| 実装量 | 極小 |

---

## 3. Recommended Design — Option B

### 3.1 選定理由

1. **PR#157 との対称性**: S2-B は inbound 受信を「stdio 実行体が唯一の callsite」に集約した。
   outbound も同じ原則を適用 → 各 bot の stdio が自 agent_id 分の送信を所有。
2. **blast radius 最小**: 新規プロセスなし、新規 token 集中なし、新規 migration なし (CHECK が既に 'processing' 許容)。
3. **「forwarder 統一」の解釈**: "統一" = "consumer pool の責務境界を明確化" と捉えれば、
   19 並走を 19 × 自 agent_id のみ = **実質的に 1-row / 1-owner** に揃えることが統一に該当。

### 3.2 変更概要 (spec)

```sql
-- new claim SQL
UPDATE outbound_queue
   SET status='processing', attempts=attempts+1, claimed_at=now()  -- claimed_at は新規カラム (§7 参照)
 WHERE id = (SELECT id FROM outbound_queue
              WHERE status='pending' AND agent_id=$1
              ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
 RETURNING id, message_id, channel_external_id, content, mentions_display,
           attachments, reply_to_discord_id, attempts, max_attempts
```

```ts
// start gate
function startOutboundConsumer() {
  if (process.env.OUTBOUND_QUEUE_CONSUMER === '0') return
  if (!isStdioRuntime()) return  // daemon 経路では走らせない
  // ... existing setInterval ...
}
```

```ts
// send path — fallback 禁止
const clientForAgent = discordClients.get(row.agent_id)
if (!clientForAgent) { /* mark failed, emit advisory */ return }
await clientForAgent.sendAdapterMessage({ ... })
```

### 3.3 `'processing'` からの遷移

- 成功 → `'sent'`
- attempts ≥ max_attempts で失敗 → `'failed'` + `last_error`
- transient 失敗 → `'pending'` に戻す + `last_error` 記録 (次 tick でリトライ)
- `'processing'` で一定時間 (例: 5 min) stuck → 死んだ consumer からの救出機構 (orphan reclaim):
  - 別 tick で `WHERE status='processing' AND claimed_at < now() - interval '5 min'` を
    `'pending'` に戻す。実装は §4 の test で担保。

### 3.4 Open point

Option A (集中型) は将来、token 集約を許す運用になれば選択肢として残しておく価値がある。
本 PR では採らない理由は blast radius と現行運用 (各 bot が自 token のみ) の継続性。CEO 判断で A にする場合、
本計画書は §2 の A セクションを正として展開する。

---

## 4. Test Strategy

### 4.1 Unit / Spec-enforcement

- `tests/spec-enforcement/outbound-claim-atomic.test.ts` 新規:
  - server.ts の claim SQL が `status='processing'` を SET していることを regex で assert
  - `WHERE agent_id=$1` filter が存在することを assert
  - outbound send path に `getDiscordClient` の fallback (`?? discord`) が無いことを assert
- `tests/outbound-consumer.test.ts` 拡張:
  - 同一 row を 2 つの goroutine (async) で同時 claim しても 1 つしか取れない
  - `'processing'` から成功 / 失敗 / transient の 3 分岐遷移

### 4.2 Regression fixture (2026-04-12 duplicate 事例)

- discord message_id `1493003755694854355` / `1493003757884149910` (本 handoff の重複 post)
- agent-comms DB UUIDs `6ce95e6d-...` / `ea269b87-...`
- 内容ハッシュベースで **同一内容・異なる agent_id で 2 件以上 agent_messages に INSERT されていないか**
  を post-merge 検証スクリプト (`scripts/verify-no-outbound-dup.sql`) として追加

### 4.3 20-bot スケール integration

- local docker-compose に bot プロセス 20 並走 + bulk insert 100 row
- 全 row が **1 回のみ Discord post** されたか (mock Discord adapter で count)
- 平均 latency ≤ 1.5s、P99 ≤ 3s

### 4.4 Orphan reclaim

- `status='processing'` のまま `claimed_at < now() - 5min` になった row を人為的に作り、
  reclaim tick で `'pending'` に戻ることを確認

### 4.5 Regression range

- PR#140 (message_queue dedup) / PR#142 (UNIQUE) / PR#156 (D3 fallback) / PR#157 (inbound 統一)
  の test suite を full green で維持

---

## 5. Rollout Plan

### 5.1 Feature flag

- env `OUTBOUND_FORWARDER_MODE` ∈ {`legacy`, `per-bot`, `off`}
- 既定 `legacy` (= 現挙動) でマージ
- `per-bot` で本設計有効化

### 5.2 Canary

1. **canary 1 bot**: `lead-ama` (本 thread のオーナー) を `per-bot` に
2. 24h 観測: 重複 post 0, `attempts_per_row` 中央値 = 1, P99 ≤ 2
3. `agent-com-dev` / `auditor` / `arc` を順次切替
4. 4 bot で 48h 安定後、残り 15 bot を rolling 切替 (1 min 間隔)

### 5.3 bot 再起動順序

- daemon 側に outbound consumer が無いことを confirm してから `restart_bot` を順次発火
- `scripts/rollout-per-bot-outbound.sh` に順序を記述 (lead → review → dev の順)

### 5.4 Default flip

- 全 19 bot が `per-bot` で 7 日間安定 → `OUTBOUND_FORWARDER_MODE` の既定を `per-bot` に変更 (別 PR、fast-merge)
- その次の cleanup PR で `legacy` 経路コードを削除

---

## 6. Rollback Plan

### 6.1 即時 (minutes)

- `OUTBOUND_FORWARDER_MODE=legacy` を全 bot env に配布 → bot restart で旧挙動復帰
- flag 切替だけでコードは同一 binary、revert PR 不要

### 6.2 コード revert (hours)

- 本機能 PR を `git revert <merge-sha>` → fast-merge revert PR
- claim SQL 旧形・fallback 復活で完全旧状態

### 6.3 緊急 brake (seconds)

- DB にて `ALTER TABLE outbound_queue DISABLE TRIGGER` 不要 (trigger 未使用)
- 全 bot の `OUTBOUND_QUEUE_CONSUMER=0` 一斉配布で consumer 全停止 (= outbound 送信完全停止、
  bridge / webhook / direct `discord.sendAdapterMessage` は継続)

---

## 7. Migration Impact

### 7.1 Schema

- CHECK constraint は既に `'processing'` を許容 (§ DB inspection 済) → **migration なし**
- **推奨追加**: `claimed_at TIMESTAMPTZ` カラム (orphan reclaim tick 用) →
  `ALTER TABLE outbound_queue ADD COLUMN claimed_at timestamptz` のみ、DEFAULT NULL、既存行に影響なし
- 追加 INDEX: `(status, claimed_at) WHERE status='processing'` (orphan reclaim 高速化)

### 7.2 Backfill

- 既存 row に変更なし (`claimed_at=NULL` のまま)
- consumer 起動直後に `status='processing' AND claimed_at IS NULL AND created_at < now()-5min` の row を
  `'pending'` に戻す 1 回きりの cleanup を entry 時に実行

### 7.3 route label

- schema change は軽微 (ADD COLUMN NULL only) だが、architectural shift なので
  **`route:ceo-approval` 維持**。CEO に明示の最終承認を求める。

---

## 8. Effort Estimate

| Phase | 作業 | 工数 |
|---|---|---|
| Design sync | 本計画書レビュー調整 | 2h (lead-ama + CTO + CEO) |
| Implementation | claim SQL / start gate / fallback 除去 / orphan reclaim | 6-8h (agent-com-dev) |
| Tests | spec-enforcement + integration + regression fixture | 4h (agent-com-dev) |
| Migration | ADD COLUMN + cleanup query | 1h (agent-com-dev) |
| Canary rollout | lead-ama 24h → 4 bot 48h → 残 15 bot | 実時間 7 日 (watch cost 少) |
| Post-merge 検証 | 全方位 (governance-flow.md Gate D 準拠) | 3h (4-layer chain) |

**合計**: 設計承認まで 2h / 実装 merge まで **1-1.5 日** / 全体 rollout 完了まで **約 1 週間**

---

## 9. Open Questions (CEO / CTO 判断論点)

1. **Option A vs B**: 推奨は B だが、CEO が将来的な token 集約運用に舵を切る意思があれば A に倒す。
2. **`claimed_at` カラム追加**: 軽微 migration だが、追加しない代替案 (`attempts * interval` で推定) もある。
3. **default flip timing**: 「7 日安定」は保守的。3 日に短縮可否。
4. **cleanup PR (legacy 削除)**: default flip と同一 PR にするか、別 PR にするか。後者推奨。
5. **canary bot 選定**: `lead-ama` でよいか、より低トラフィックな bot (例 `secretary`) を選ぶか。

---

## 10. References

- `server.ts` L270 (`getDiscordClient` fallback)
- `server.ts` L739 (`startOutboundConsumer` registration)
- `server.ts` L887-962 (`consumeOneOutboundRow` claim + send + update)
- PR#157 (S2-B inbound unify) — 対称パターンの先行実装
- `docs/agent-com-message-queue-spec.md` §2 / §7 / §3.3
- governance-flow.md — post-merge 全方位検証 (Gate D)
- 2026-04-12 duplicate 事例: discord message_id `1493003755694854355` / `1493003757884149910`,
  agent-comms UUIDs `6ce95e6d-d6b6-4b90-ad9b-3a57e8506b81` / `ea269b87-e6fd-4077-9559-d8feb7c21b41`,
  outbound_queue row `270561d3` (attempts=15 観測)
- ADR-041 (Receiver-MessageBus Architecture)
- ADR-045 (Dev-Lead Pool)
