# state-daemon Contract Test Fixtures (v0.3 削減版)

> **Issue**: #323
> **Source spec**: `docs/design/queue-state-polling-daemon.md` v0.3 §11
> **Author**: ARC
> **Created**: 2026-05-08
> **Audience**: agent-com-dev (impl 担当)
> **Note**: 本 fixture は executable contract test 化必須、`pnpm test:contract` で全 pass が merge gate。

---

## 共通前提

- DB: test 用 ephemeral postgres (testcontainers 推奨)
- clock: fake injected clock、`now=T0` 起点
- tmux: fake adapter、`sendKeys(session, payload)` 呼出を記録
- metrics: fake sink、counter inc / gauge set / histogram observe を記録
- alert: fake sink、`alert(content)` 呼出を記録
- daemon 起動 default config (spec §9 参照)、各 fixture で個別 override
- 各 fixture は **idempotent**: 同じ trigger を 2 回流しても DB / metric / tmux / alert は 1 回分のみの効果

---

## T1: new_pending_dispatched

**precondition**:
- bot_registry: `(agent_id='alpha', runtime='TUI', tmux_session='alpha-session', alive=true, last_seen_at=T0)`
- message_queue: 空

**trigger**:
- INSERT row `(id=R1, agent_id='alpha', status='pending', created_at=T0)` → pg_notify

**expected**:
- tmux.sendKeys('alpha-session', 'check inbox\n') 1 回
- DB: R1 の `last_wake_attempt_at = T0`
- metric: `state_daemon_wake_actions_total{result='ok'}` += 1

---

## T8: pending_stale_rewake

**precondition**:
- bot_registry: alpha alive
- message_queue: R1 = `(agent_id='alpha', status='pending', created_at=T0, last_wake_attempt_at=NULL)`

**trigger**:
- clock 進めて `now = T0 + 15s`
- cron sweep tick

**expected**:
- tmux.sendKeys('alpha-session', 'check inbox\n') 1 回
- DB: R1.last_wake_attempt_at = T0+15s

---

## T9: pending_stale_duplicate_suppress

**precondition**:
- R1 = `(status='pending', last_wake_attempt_at = T0+12s)` (3s 前 wake 済)

**trigger**:
- clock `now = T0+15s`、cron sweep

**expected**:
- tmux.sendKeys 呼出なし (duplicate suppression 5s 以内)
- DB 変更なし
- metric: `state_daemon_wake_actions_total{result='dedup_skipped'}` += 1

---

## T10: read_expired_reclaim

**precondition**:
- bot_registry: alpha alive
- R1 = `(status='read', claim_expires_at = T0-5s, agent_id='alpha', created_at = T0-40s)`

**trigger**:
- cron sweep at `now=T0`

**expected**:
- DB: R1.status='pending'、claim_expires_at リセット (新 TTL)
- tmux.sendKeys 1 回
- metric: `state_daemon_wake_actions_total{result='reclaimed'}` += 1

---

## T11: abandon_recent_reset

**precondition**:
- R1 = `(status='failed', failed_reason='IMPLICIT_ABANDON', claim_expires_at = T0-30s, agent_id='alpha')`

**trigger**:
- cron sweep at `now=T0` (claim_expires_at は now-60s 範囲内)

**expected**:
- DB: R1.status='pending'、failed_reason=NULL
- 後続 wake は次 sweep / pg_notify で発火 (本 fixture では問わない)

---

## T12: max_attempts_failed_permanently

**precondition**:
- R1 = `(status='read', attempts=10 (= max), age=6min)`

**trigger**:
- cron sweep

**expected**:
- DB: R1.status='failed'、failed_reason='STALE_DISPATCH' or 'MAX_ATTEMPTS' (impl 選択、Open §5)
- alert 1 回 (`max_attempts` 含む string)
- metric: `state_daemon_wake_actions_total{result='permanently_failed'}` += 1

---

## T13: db_connection_retry

**precondition**:
- daemon 稼働中、DB pool が `query` で connection error を 2 連続で返す mock 設定

**trigger**:
- 任意の sweep tick (3 度目に DB 復旧)

**expected**:
- 3 回目で正常完了
- metric: `state_daemon_db_errors_total` += 2
- alert 呼出なし (5 連続未満)

派生 T13b (alert 発火): 5 連続失敗で `state_daemon_db_errors_total` += 5、alert 1 回。

---

## T14: sweep_budget_warn

**precondition**:
- sweep が 250ms 消費する mock work を含む

**trigger**:
- cron sweep tick

**expected**:
- log entry に `budget_warn=true` 含む 1 行
- 次 sweep tick で skip しない (継続実行)

---

## T15: dual_state_priority_order

**precondition**:
- R1 = `(status='read', claim_expires_at=T0-5s, age=15s)` ← read-expired AND pending-stale 両当て

**trigger**:
- cron sweep at `now=T0`

**expected**:
- read-expired path のみ走る (priority 高)
- DB: R1.status='pending'、tmux.sendKeys 1 回
- pending-stale path は skip (1 row 1 action invariant)

---

## T16: pg_notify_immediate_dispatch

**precondition**:
- daemon 起動済、`LISTEN queue_event` 確立済

**trigger**:
- INSERT row R1 → trigger fires → pg_notify payload 即時受信

**expected**:
- tmux.sendKeys 1 回 (cron sweep を待たず)
- 受信 latency metric `state_daemon_pg_notify_lag_ms` が 1 回 observe

---

## T17: pg_notify_miss_cron_pickup

**precondition**:
- pg_notify subscriber を mock で「INSERT 通知を取りこぼし」状態に

**trigger**:
- INSERT R1 (notify は drop)、30s 待機 → cron sweep tick

**expected**:
- cron sweep が R1 を pickup、tmux.sendKeys 1 回
- pg_notify lag は記録なし、sweep duration metric 1 回

---

## T19: sig_runtime_wake_throws

**precondition**:
- bot_registry: `(agent_id='legacy', runtime='SIG')`

**trigger**:
- INSERT R1 (`agent_id='legacy'`)、wake 試行

**expected**:
- error throw `"SIG mode 廃止済、TUI のみ allowed (got SIG)"`
- DB: R1.status='failed'、failed_reason='WAKE_FAILED' (impl が catch)
- alert 1 回

---

## T20: wake_pool_concurrency_limit

**precondition**:
- wakePoolMinCapacity=5、各 wake mock で 100ms ブロック

**trigger**:
- 同時に 6 件の pg_notify 受信

**expected**:
- 5 件は active、6 件目は queue
- queue 深さが high watermark に達したら T24 (grow) 経路

---

## T21 (v0.3 新規): heartbeat_refresh_extends_claim

**precondition**:
- bot_registry: alpha alive
- R1 = `(status='read', agent_id='alpha', claim_expires_at = T0+30s)`
- claim_ttl_sec=60

**trigger**:
- heartbeat tick at `now=T0` (interval 30s)

**expected**:
- DB: R1.claim_expires_at = T0+60s (= now + claim_ttl)
- DB: R1.last_heartbeat_at = T0
- metric: `state_daemon_heartbeat_refresh_total{result='ok'}` += 1
- tmux.sendKeys 呼出なし (heartbeat は wake と独立)

派生 T21b (既 expired は対象外):
- precondition R1.claim_expires_at = T0-1s
- expected: R1 変更なし、heartbeat skip (self-reclaim 経路に委ねる)

---

## T22 (v0.3 新規): dead_bot_tmux_missing_restart

**precondition**:
- bot_registry: `(agent_id='zombie', runtime='TUI', tmux_session='zombie-sess', last_seen_at=T0-3min, alive=true)`
- tmux mock: `sessionExists('zombie-sess')` = false

**trigger**:
- liveness check tick at `now=T0`

**expected**:
- restart launcher 呼出 1 回 (target='zombie')
- metric: `state_daemon_bot_restarts_total{agent_id='zombie'}` += 1
- alert 1 回 (`zombie restarted` 含む)
- DB: bot_registry.zombie.alive = false (restart 完了通知で alive=true へ別 path で復帰)

---

## T23 (v0.3 新規): bot_restart_loop_limit_escalate

**precondition**:
- bot_registry: `(agent_id='flapping', runtime='TUI', last_seen_at=T0-3min)`
- restart 履歴: 直近 1h で 3 回 restart 済

**trigger**:
- liveness check tick

**expected**:
- restart launcher 呼出 **なし** (上限到達)
- metric: `state_daemon_bot_dead_total{agent_id='flapping'}` += 1
- alert 1 回 (`CEO escalate` / `restart loop limit` 含む)

---

## T24 (v0.3 新規): wake_pool_grow_on_high_watermark

**precondition**:
- wake_pool: capacity=5、queue 深さ = 11 (high watermark=10)
- wakePoolMaxCapacity=20、growStep=2

**trigger**:
- next wake job 投入

**expected**:
- capacity = 7 に拡張
- log: `wake_pool_grown` 1 行 (`new_capacity=7`)

派生 T24b (上限到達):
- precondition: capacity=20 (=MAX)、queue 深さ=11
- expected: capacity 維持、metric `state_daemon_wake_pool_saturated_total` += 1、alert 1 回

---

## T25 (v0.3 新規): wake_pool_shrink_on_idle

**precondition**:
- wake_pool: capacity=10 (>MIN=5)、queue 深さ=0、active=0

**trigger**:
- wake job 完了 (`maybeShrink` 評価)

**expected**:
- capacity = 9 (shrinkStep=1)
- 連続 trigger で MIN=5 まで縮小、それ以下にはならない

---

## T26 (v0.3 新規): abnormal_activity_alert

**precondition**:
- agent_messages 観測: `agent_id='chatty'` が直近 5min で send 5 件

**trigger**:
- 6 件目 INSERT → pg_notify → daemon の abnormal activity 集計

**expected**:
- metric: `state_daemon_abnormal_activity_total{agent_id='chatty', kind='msg_5_in_5min'}` += 1
- alert 1 回 (`chatty 5min 5+ msg` 含む)
- wake は通常通り実行 (= 「出てから制御」、prevention は持たない)

---

## v0.2 から削除した fixture (再導入禁止、F1)

- T2 chain_bot_already_replied
- T3 chain_depth_exceeded
- T4 pair_bounce_detected
- T5 ack_cascade_detected
- T6 ack_pattern_disabled_passthrough
- T7 tui_rate_limit
- T18 dispatch_logic_dry_run

これらは全て v0.2 prevention check に紐付く。CTO `1d402109` per 削除済、再導入は **block PR**。

---

## 集計

- v0.2: 20 fixture (T1-T20)
- v0.3 削除: 7 (T2-T7, T18)
- v0.3 新規: 6 (T21-T26)
- **v0.3 合計: 19 fixture** (T1, T8-T17, T19-T26)

CI 要件: 19 fixture 全 pass が merge gate (governance-flow.md per、Layer 0 自動 gate)。
