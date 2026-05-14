# state-daemon 6-section Instruction 元素

> **Purpose**: ARC v0.3 spec → lead-ama 6-section 翻訳のための元素 (raw material)
> **Issue**: #323
> **Source spec**: `docs/design/queue-state-polling-daemon.md` (v0.3)
> **Author**: ARC
> **Created**: 2026-05-08
> **Audience**: lead-ama (agent-comms 担当 lead-bot)
> **Note**: 本 doc は 6-section 指示書そのものではない。lead-ama が agent-com-dev 向け 6-section 指示書を起草する際の **元素 (input)**。

---

## 0. Dispatch context (元素)

| field | value |
|---|---|
| target_project | `agent-comms-mcp` |
| dispatch_origin | `lead-ama` (本 instruction の出し手) |
| upstream_authority | `arc` (spec drafting) / `cto` (greenlight `1d402109`) / `ceo` (greenlight `e4bfe41c`) |
| dispatch_reason | GitHub issue #323、ARC spec v0.3 (`docs/design/queue-state-polling-daemon.md`)、CTO directive `1d402109` 簡素化 |
| target_dev_bot | `agent-com-dev` |
| memory partition | `agent-comms-mcp` (explicit per-call、env default 不可) |

---

## 1. Interface contract (元素、凍結対象)

### 1.1 daemon entry point

```ts
// bin/state-daemon.ts
export async function main(opts?: { config?: Partial<StateDaemonConfig> }): Promise<void>;
```

- single instance only (launchd KeepAlive で supervise)
- shutdown signal (SIGTERM / SIGINT) で graceful shutdown (in-flight wake 完了待ち、最大 5s)

### 1.2 公開 module 境界

```ts
// core/state-daemon/index.ts
export class StateDaemon {
  constructor(deps: { db: DBClient; pgListen: PgListenClient; tmux: TmuxClient; clock: Clock; metrics: Metrics; alert: AlertSink });
  start(): Promise<void>;
  stop(): Promise<void>;
  handleQueueEvent(event: QueueEvent): Promise<void>;
  sweepStale(): Promise<SweepResult>;
  refreshClaims(): Promise<RefreshResult>;
  checkBotLiveness(): Promise<LivenessResult>;
}
```

#### 1.2.1 各 public method の pre/post/invariants (v0.4 Q1 patch)

| method | pre-condition | post-condition | invariants |
|---|---|---|---|
| `start()` | DB / pg LISTEN client に接続可能、tmux client 利用可能、daemon 未起動 | LISTEN 確立、cron / heartbeat / liveness インターバル全て稼働、`status='running'` | 重複起動禁止 (二重 call は throw `AlreadyStartedError`) |
| `stop()` | daemon 起動済 | 全インターバル停止、in-flight wake は最大 5s 待機、LISTEN 切断、`status='stopped'` | graceful shutdown 中の新規 wake は受け付けない、idempotent (二重 call OK) |
| `handleQueueEvent(event)` | `event.id` は `message_queue` row 存在、daemon 稼働中 | §4.3 表に従い 0 or 1 action 実行、wake 時は `agents.last_wake_attempt_at` と row audit stamp 更新、metric inc | idempotent (同 event 再投入で副作用なし)、duplicate suppression (agent-level last_wake_attempt 5s 以内) で skip 可、prevention check は持たない (F1) |
| `sweepStale()` | daemon 稼働中、cron tick または手動 call | §4.3 row 2-6 を **batch** で評価、各 row 独立に 0 or 1 action、SweepResult に処理件数 / 各 result 集計 | budget=200ms 超過で warn log、次 tick は skip しない、order 保証なし (idempotent 前提) |
| `refreshClaims()` | daemon 稼働中、heartbeat tick | `agents.status='online'` AND `claim_expires_at > now()` の row のみ TTL を `now() + claim_ttl_sec` に延長、`last_heartbeat_at = now()` | 既 expired (`claim_expires_at <= now()`) は対象外 (self-reclaim 経路に委ねる、F7)、bot offline 時は対象外 (= TTL 自然失効) |
| `checkBotLiveness()` | daemon 稼働中、liveness tick | `agents.last_seen_at` が threshold 超過 + `runtime='TUI'` + tmux session 不在 の bot を restart、上限到達は抑止 + escalate alert | restart 実行は 1h 内 N 回上限 (F8)、SIG runtime は restart 試行不可 (alert のみ)、idempotent |

- 全 public method idempotent
- DI で test 容易性確保 (clock / metrics / alert は fake 注入可)
- pre 違反は throw、post 違反は merge gate (contract test) で検出

### 1.3 DB schema 契約 (migration 必須)

| table.column | type | nullable | default |
|---|---|---|---|
| `agents.last_wake_attempt_at` | TIMESTAMPTZ | YES | NULL |
| `message_queue.last_wake_attempt_at` | TIMESTAMPTZ | YES | NULL |
| `message_queue.last_heartbeat_at` | TIMESTAMPTZ | YES | NULL |
| `message_queue.failed_reason` (enum 拡張) | enum | — | 既存値 + `'STALE_DISPATCH'` |

[v0.4 patch]: bot 情報は **既存 `agents` table を SoT として再利用** (CTO `70050419` 検証済)。wake suppression は bot runtime 状態なので `agents.last_wake_attempt_at` を SSOT とし、`message_queue.last_wake_attempt_at` は row-level audit として残す。

`bot-registry.txt` は tmux 起動補助の operational tool であり、本 daemon は読み込まない。F も参照。

trigger: `message_queue` の AFTER INSERT OR UPDATE OF (status, claim_expires_at) で `pg_notify('queue_event', ...)`。

### 1.4 invariants

- 同 row に対する action は idempotent (重複呼出で副作用なし)
- `agents.last_wake_attempt_at` の条件付き UPDATE による wake reservation 前に wake 実行する path は禁止 (重複 wake 抑制が壊れる)
- daemon が die しても data 不整合は発生しない (sweep が次起動で復旧)

### 1.5 error taxonomy

| error class | trigger | recovery |
|---|---|---|
| `DBConnectionError` | LISTEN socket / query 失敗 | exponential backoff、5 連続で alert |
| `TmuxSendKeysError` | wake 対象 tmux session 不在 | `agents.status` を online 以外に遷移、補強 #5 で restart 試行 |
| `WakePoolSaturatedError` | wake_pool が MAX_CAPACITY 到達 + queue 溢れ | metric inc、alert |
| `BotRestartLimitError` | 同 bot 1h 内 restart 4 回目 | 抑止 + CEO escalate alert |

---

## 2. Required behavior (元素、凍結対象)

spec 章を section 番号で参照させる:

- **R1**: §4.1 state machine 通りに transition (skipped 状態は v0.3 で不在、追加禁止)
- **R2**: §4.2 dispatch trigger は pg_notify (即時) + cron 30s sweep の 2 経路、いずれも全 row に対して同等の action を生成 (無条件 wake)
- **R3**: §4.3 6 transition の action を全て実装、各 idempotent
- **R4**: §5.1 補強 #1: heartbeat 30s 毎、`status='read' AND alive=true AND claim_expires_at > now()` の row のみ TTL 延長
- **R5**: §5.2 補強 #2: wake pool は MIN/MAX 範囲で動的拡張、queue high watermark で grow、queue 0 で shrink
- **R6**: §5.3 補強 #3: launchd plist sample (`config/launchd/com.agent-comms.state-daemon.plist`) を repo に commit
- **R7**: §5.4 補強 #5: bot last_seen_at が threshold 超 + tmux session 不在 で restart 実行、上限到達で抑止 + escalate
- **R8**: §6.3 wake は **TUI runtime のみ allowed**、SIG runtime に wake 試行は throw error
- **R9**: §10.3 abnormal activity 検出時 operator alert (Discord) 送出 (= 「出てから制御」spirit)
- **R10**: 全 action は §8 Failure modes の recovery 表に従う、log + metric を必ず emit
- **R11**: shutdown signal で graceful shutdown、in-flight wake 完了待ち最大 5s

---

## 3. Forbidden behavior (元素、凍結対象、anti-pattern)

- **F1**: dispatch 段の **loop prevention check (chain analysis / pair detection / ack pattern / rate limit)** を実装しないこと。CEO `e4bfe41c` per v0.3 で全削除済。再導入 PR は **block**。理由: TUI 統一 + B4 system prompt + reactive control の組合せで構造的解消する設計、prevention は責務外
- **F2**: `message_queue.dispatch_decision` JSONB 列を再追加しないこと (v0.2 から削除済)
- **F3**: `message_queue.status='skipped'` enum 値を追加しないこと (v0.2 から削除済)
- **F4**: ARC が PR branch に直接 commit / push しないこと (memory `feedback_arc_no_direct_commit`)、agent-com-dev が impl
- **F5** (v0.8 cycle 2 改訂): non-TUI runtime (SIG / 不明 runtime) に対する wake は **`metrics.inc('state_daemon_wake_actions_total', { result: 'non_tui_skipped' })` + return** で実装すること。error throw 禁止 + warn log 禁止 + abnormal-activity counter trip 禁止 (R9 ordering: runtime gate 後 = non-TUI 経路では recordDispatch 呼ばない)。理由: PR #333 commit `ddb1688` 実 impl が production 整合解 [文献確認: git show ddb1688:core/state-daemon/index.ts line 437-453]。cycle 1 の「warn log」記述は ARC 起草時の impl 未 verify による誤記述、cycle 2 で訂正。
- **F6**: legacy `bin/wake-daemon.ts` を残したまま state-daemon を起動しないこと。phase 5 で legacy wake-daemon を停止、それまでは並行稼働 (phase 3-4) でも **重複 wake は許容、prevention で抑制しない** (idempotent + duplicate suppression で吸収)
- **F7**: heartbeat の TTL 延長を `claim_expires_at <= now()` の row に適用しないこと (既 expired は self-reclaim 経路で処理)
- **F8**: bot restart loop 上限 (1h/3 回) を超えて restart を継続しないこと (operator/CEO 介入なしの auto recovery loop は禁止)
- **F9**: spec §13.2 CEO 採択待ち項目 (O2/O3/O5/O6/O7/O8) を CEO 確定前に default 値で hard-code しないこと、config 経由で上書き可能に
- **F10**: agent-memory MCP 呼出時 `project` 引数を省略しないこと、必ず `agent-comms-mcp` を explicit 渡し (memory partition 越境禁止)
- **F11**: log や metric label に PII / 全文 message body を含めないこと (`row_id`、`agent_id` のみ)
- **F12** (v0.5 patch): 新規 `bot_registry` table 提案を追加しないこと (`agents` table が SoT、CTO `70050419` 検証済)。`bot-registry.txt` を daemon 経路から読み込む path 追加禁止 (txt は tmux 起動補助 operational tool のみ)。再導入 PR は **block**

過去 incident 参照:
- B8 type loop / "Idle 維持" 連射 → v0.2 で prevention 検討、v0.3 で却下 (TUI 統一 + B4 で対応)
- webb-dev 27008 IMPLICIT_ABANDON → §4.3 row 4 で recovery (v0.1 から継承)

---

## 4. Test fixtures (元素、凍結対象、merge gate)

> spec §11 の test fixture 削減版 (T1, T8-T17, T19, T20 + v0.3 新規 T21-T26)。
> **executable contract test として実装、CI で全 pass が merge 条件**。

各 fixture は以下形式:

```
T#:
  name: 短い識別名
  precondition: DB seed / clock / mock 設定
  trigger: pg_notify event or sweep tick or heartbeat tick
  expected:
    - DB row 状態 (status / claim_expires_at / last_wake_attempt_at / last_heartbeat_at)
    - tmux send-keys 呼出 (target session / payload)
    - metric inc (counter name + label)
    - alert sink 呼出 (有無 + content の含む string)
```

### 4.1 fixture list (v0.3 削減版)

| # | name | spec 参照 |
|---|---|---|
| T1 | new_pending_dispatched | §4.3 row 1 |
| T8 | pending_stale_rewake | §4.3 row 2 |
| T9 | pending_stale_duplicate_suppress | §4.3 row 2 + duplicate suppression |
| T10 | read_expired_reclaim | §4.3 row 3 |
| T11 | abandon_recent_reset | §4.3 row 4 |
| T12 | stale_dispatch_age_based (v0.7 rename) | §4.3 row 5 (age-based proxy、`attempts` 列不在に対応) |
| T13 | db_connection_retry | §8 |
| T14 | sweep_budget_warn | §10.1 |
| T15 | dual_state_priority_order | §4.3 row 2 + 3 priority |
| T16 | pg_notify_immediate_dispatch | §6.2 |
| T17 | pg_notify_miss_cron_pickup | §6.2 |
| T19b (v0.8 cycle 2) | non_tui_silent_skip | §6.3 + F5 (`metric={result:'non_tui_skipped'}` inc / warn log なし / alert=0 / abnormal-activity 不参加、PR #333 `ddb1688` 実 impl 整合) |
| T20 | wake_pool_concurrency_limit | §5.2 + §6.4 |
| **T21** (v0.3 新規) | heartbeat_refresh_extends_claim | §5.1 / R4 |
| **T22** (v0.3 新規) | dead_bot_tmux_missing_restart | §5.4 / R7 |
| **T23** (v0.3 新規) | bot_restart_loop_limit_escalate | §5.4 / R7 / F8 |
| **T24** (v0.3 新規) | wake_pool_grow_on_high_watermark | §5.2 / R5 |
| **T25** (v0.3 新規) | wake_pool_shrink_on_idle | §5.2 / R5 |
| **T26** (v0.3 新規) | abnormal_activity_alert | §10.3 / R9 |

v0.2 の T2-T7 (prevention) / T18 (dryRun) は v0.3 削除。

### 4.2 CI 要件

- 全 fixture が `pnpm test:contract` で 1 度に走る
- 全 pass が merge 承認条件 (lead-ama LGTM 前提)
- DB は test 用 ephemeral postgres (testcontainers or docker-compose) を使い、本番 DB を汚さないこと

---

## 5. Open decisions (実装者自由、明示列挙)

> ここに列挙されていない判断は **暗黙凍結**。判断に迷ったら lead-ama 経由 ARC へ escalate、self-proceed 禁止。

- daemon 内部 module 構造 (class / function 分割、private helper 命名)
- pg_notify reconnect の backoff 戦略 (exponential / linear)
- subprocess pool 実装方式 (in-process queue / worker thread / async semaphore)
- log library 選定 (pino / winston / 構造化 JSON 直書き)、CI 互換ならよし
- (v0.4 削除: bot_registry txt→DB migration は誤前提、`agents` table 既存利用)
- launchd plist の log path / env 詳細 (sample は spec §5.3 のまま使ってよい、path 調整可)
- restart 実行のため呼び出す既存 launcher script の選定 (例: `bin/start-bot.sh`)
- alert sink (Discord channel) の具体接続実装 (既存 `mcp__agent-comms__send` 利用 or 別 path)
- test 用 DB の seed helper / fixture builder
- variable / private helper 命名

---

## 6. CEO 採択待ち (spec §13.2 を impl 開始前に確定要請)

| # | 項目 | 提案 default |
|---|---|---|
| O2 | claim TTL default 60s | 60 |
| O3 | heartbeat interval default 30s | 30 |
| O5 | wake 抑制 mode rollout phase 3 で必須 | 必須 |
| O7 | bot restart 上限 1h/3 回 | 3/hour |
| O8 | abnormal activity threshold 5msg/5min | 5/5min |

lead-ama は 6-section 起票前に CEO 採択を確認、確定値で freeze。

---

## 7. 6-section 翻訳の注意 (lead-ama 向け)

- Section 0: 本 doc §0 を流用、`dispatch_origin` を `lead-ama` に上書き、target_dev_bot=`agent-com-dev` 明記
- Section 1: 本 doc §1 を凍結転記
- Section 2: 本 doc §2 を凍結転記、spec 章番号参照を保つ
- Section 3: 本 doc §3 を凍結転記、F1 (prevention 再導入禁止) を強調
- Section 4: 本 doc §4 fixture list を凍結転記、CI 要件を merge gate と明記
- Section 5: 本 doc §5 を Open decisions として凍結転記
- 6 section + (採択済 §13.2 の値を Section 2 に統合) で完成
