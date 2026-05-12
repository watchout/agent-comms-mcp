# 6-Section Instruction: state-daemon v0.9 統合 impl

> **Issue**: #323 (sequel)
> **Source spec**: `docs/design/queue-state-polling-daemon.md` v0.9 (PR #336 merged at commit `72b9c92`)
> **Author**: ARC (drafting per CTO directive `a21fe385`)
> **Audience**: agent-com-dev (impl 担当、lead-ama 経由 dispatch 後)
> **Created**: 2026-05-11
> **Honesty labels**: 全 claim に [検証済] / [文献確認] / [推測]

---

## 0. Dispatch context (凍結)

[文献確認: governance-flow.md §0 6-section format 2026-05-07 改訂]

- **`target_project`**: `agent-comms-mcp`
- **`target_dev_bot`**: `agent-com-dev` (本 PR impl 担当、auditor pre-impl gate D1 per dispatch key として固定、汎用 dev-bot scope 正規化)
- **`dispatch_origin`**: `arc` (drafting) → `lead-ama` (formal IMPL doc authoring + dispatch)
- **`dispatch_reason`**: CTO directive `a21fe385` (本日 2026-05-10、CEO `0dc05f05` GO per)。state-daemon v0.9 spec (PR #336 merged commit `72b9c92`) の impl 統合 1 PR 化要請。
- **`memory_partition`**: `agent-comms-mcp` (agent-memory MCP tool 呼出時 explicit per-call 必須、env default 不可、汎用 dev-bot scope 越境禁止)
- **`scope_label`**: `route:ceo-approval` (status enum migration + DB schema 変更 + 公開 tool 追加)

agent-com-dev は本指示書の「凍結」section (1-4) を violation したら差戻し、「Open decisions」(5) 以外で判断に迷ったら lead-ama にエスカレーション、self-proceed 禁止。

agent-memory MCP tool 呼出時は `project='agent-comms-mcp'` を必ず渡す (env default 不可)。

---

## 1. Interface contract (凍結)

### 1.1 status enum 再定義 (DB schema)

```sql
ALTER TABLE message_queue
  DROP CONSTRAINT message_queue_status_check;

ALTER TABLE message_queue
  ADD CONSTRAINT message_queue_status_check
  CHECK (status IN ('pending', 'received', 'in_progress', 'done', 'replied'));

ALTER TABLE message_queue
  DROP COLUMN IF EXISTS failed_reason;

ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS done_at timestamptz;
```

| status | 意味 | 遷移元 | 遷移先 |
|---|---|---|---|
| `pending` | 未到達 (DB INSERT 直後、bot 未認知) | INSERT | `received` (bot next claim) |
| `received` | bot が next で claim 取得済、処理開始前 | `pending` | `in_progress` (processing tool) / `pending` (reset on stale) |
| `in_progress` | bot LLM turn 実行中 | `received` | `done` (done tool) / `replied` (send tool) |
| `done` | bot 内部完了、reply 未送信 | `in_progress` | `replied` (send tool) |
| `replied` | reply 完了 (terminal) | `in_progress` / `done` | (terminal) |

### 1.1b 旧 status → 新 status migration mapping (sub-PR 1 dispatch gap fill)

[文献確認: lead-ama dispatch `7c600cc6` sub-PR 1 spec verify per、agent-com-dev escalation `33ac66ae` 「現 schema: `pending|read|replied|failed` のみ」literal、ARC branch `spec/pr338-sub-pr1-enum-migration-gap-fill` (commit `3a8619d` 初版)]

destructive migration 実行前提:
- **AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1 env flag** (PR #340 deploy 済) 必須、unset 時 fail-closed。production deploy は launchd plist 経由のみ set (= S2 PR #342 per、dev session で set 禁止)
- 全 production bot が **fleet PID drift check** PASS (= 全 bot 新 code 起動済)
- sub-PR 2-6 fleet 慣熟完了 (rollout plan per、sub-PR 1 = 最終 push)

旧 → 新 status value migration mapping (full enumeration):

| 旧 status | 新 status | 変換 logic |
|---|---|---|
| `pending` | `pending` | **no change** (= value 同一、CHECK 制約のみ拡張) |
| `read` | `received` | **rename** (= UPDATE 文で `SET status='received' WHERE status='read'`) |
| `replied` | `replied` | **no change** (= terminal、value 同一) |
| `failed` | (§1.1a per) | **3-way 分岐** (= IMPLICIT_ABANDON → pending、STALE_DISPATCH → bot verify、PERMANENT → replied + audit) |
| `skipped` (= v0.8 残存可能) | (drop) | **drop** (CC 削除 PR で skipped 発生源 0 化、migration 時点で残 row 0 件期待、残あれば audit_log + replied 化) |

migration 順序 (zero-downtime per spec §12 Phase 1-3):
1. **Phase 1 (schema 拡張)**: CHECK 制約を新 5 値 (`pending|received|in_progress|done|replied`) に **DROP + ADD**、`failed_reason` column DROP、`done_at` column ADD。**旧書込 (`read`/`failed`) は CHECK 違反で reject** = 旧 bot は新 code に rolling deploy 前提
2. **Phase 2 (data migration)**: 既存 row UPDATE: `read → received` rename、`failed` 3-way 分岐 (§1.1a)、`skipped` drop。**state-daemon は本 phase で stop**、migration script 完了後 restart (= migration window 数十秒想定)
3. **Phase 3 (verify + cleanup)**: 旧値 0 件 verify (`SELECT count(*) WHERE status NOT IN ('pending','received','in_progress','done','replied')`)、production bot 起動 commit hash 確認

production deploy procedure (= operator action):
```bash
# 1. AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED env を全 production bot launchd plist に set
# 2. state-daemon stop + 全 production bot pause
# 3. migration script 実行 (= Phase 1 + 2)
# 4. snapshot diff verify + rollback ready
# 5. state-daemon + 全 production bot restart (= 新 code load)
# 6. Phase 3 verify、failure 時 rollback (旧 enum 戻し migration script、ARC 別 draft)
```

rollback contract:
- Phase 1 + 2 のみ実行で stop 可能 (= Phase 3 verify 失敗時、旧 row 復元 migration script で rollback)
- rollback migration script は本 sub-PR 1 で同時 ship 必須 (= dev impl の acceptance criteria)

### 1.1a enum migration `failed` 既存 row 分岐 contract (auditor A2 解消)

[文献確認: spec v0.9 §12.3 既存 row 変換 plan + auditor A2 BLOCK]

migration script は既存 `failed` row を以下の **3 way 分岐** で transform、結果が新 enum + audit 完備:

```ts
// pseudo-code (impl 側で SQL or TS migration script に翻訳)
for (row of message_queue WHERE status='failed') {
  if (row.failed_reason === 'IMPLICIT_ABANDON' && row.claim_expires_at > now() - interval '60 seconds') {
    UPDATE row SET status='pending', failed_reason=NULL;  // recoverable, retry loop に投入
  } else if (row.failed_reason === 'STALE_DISPATCH') {
    // bot が応答した可能性ありで bot 側 reply 検証必須
    if (verify_bot_replied(row)) {
      UPDATE row SET status='replied', failed_reason=NULL;
    } else {
      UPDATE row SET status='pending', failed_reason=NULL;  // operator 判断、再投入
    }
  } else {
    // PERMANENT (= retry loop で扱えない) → terminal close + audit log
    INSERT INTO audit_log (queue_id, original_status, original_reason, archived_at)
      VALUES (row.id, 'failed', row.failed_reason, now());
    UPDATE row SET status='replied', failed_reason=NULL;
  }
}
```

### 1.2 新規 tool 2 個 (MCP server.ts)

```ts
// mcp__agent-comms__processing — received → in_progress
{
  name: "processing",
  description: "Mark message as in_progress (LLM turn started)",
  parameters: {
    queue_id: string  // required
  },
  // post-condition: status='in_progress', return { ok: true } or error
}

// mcp__agent-comms__done — in_progress → done
{
  name: "done",
  description: "Mark message as done (internal complete, no reply needed yet)",
  parameters: {
    queue_id: string  // required
  },
  // post-condition: status='done', done_at=now(), return { ok: true } or error
}
```

invariants:
- `processing` は `received` のみ受領。他 status は `INVALID_STATE` error。
- `done` は `in_progress` のみ受領。他 status は `INVALID_STATE` error。
- 両 tool は idempotent (同 queue_id 2 回呼出は 2 回目 `ALREADY_TRANSITIONED` warning + return ok)。

### 1.3 既存 tool 修正 (signature / pre / post / invariants 明文化)

#### `next` tool
```ts
{
  name: "next",
  parameters: {},  // no params (claim from caller's agent_id)
  // pre: caller agent_id has 1+ pending message
  // post: returns oldest pending row, status='received', claim_expires_at = now() + CLAIM_TTL_SEC
  // invariants:
  //   - 同 row 複数 caller 同時 claim 時は 1 caller のみ成功 (atomic UPDATE WHERE status='pending')
  //   - 旧 `status='read'` 書込は v0.9 で廃止、`'received'` のみ
  return: { queue_id: string, message_id: string, content: string, ... } | null
}
```

#### `fail` tool (deprecate)
```ts
{
  name: "fail",
  parameters: { queue_id: string, reason?: string },
  // pre: queue_id exists、status='received' or 'in_progress'
  // post: **no-op return + warning log** ('fail tool is deprecated, retry loop handles failure transparently')
  // invariants:
  //   - status='failed' 書込は **CHECK 制約違反 → impl error** (新 enum で `failed` 不在)
  //   - retry transparent loop が RETRYABLE_REASONS なら内部で `pending` reset、PERMANENT なら `replied` + audit_log
  return: { ok: true, deprecated: true } | error
}
```

#### `skip` tool (削除)
```ts
// 削除完了。code path 残存 0 verify 必須 (= grep 0 hit)。
// 呼び元: なし (CC fanout 廃止で発生源 0)
```

#### `send` tool 修正
```ts
{
  name: "send",
  parameters: { content: string, mention: string, reply_to: string, message_type?, metadata? },  // cc parameter 削除
  // pre: reply_to の queue_id が status='received' or 'in_progress' or 'done'
  // post:
  //   - target queue row の status='replied' (terminal)
  //   - new queue row insert (recipient agent 宛) with status='pending'
  // invariants:
  //   - `cc` parameter 受領は **schema validation error** (廃止)
  //   - body 末尾 `[CC: <@id>]` 注入 logic 削除
  //   - CC recipient 用 queue insert なし (1 mention = 1 row)
  return: { ok: true, sent_id: string, ... }
}
```

#### GC job (新規、cron or daemon side)
```ts
function gcRepliedRows(): Promise<{ deleted: number }> {
  // pre: なし (定時実行、daemon-side)
  // post: status='replied' AND replied_at < now() - 7 days の row を DELETE
  // invariants:
  //   - status='failed' は v0.9 で不在のため対象外 (= 設計上 retry loop で消化済)
  //   - DELETE は batch (default 1000 rows/tick)、deadlock 回避
}
```

#### `stall-detector` module (新規、`core/stall-detector.ts`)
```ts
type StallVerdict =
  | { kind: 'idle'; layer: 1 }                                                      // L1 queue row predicate
  | { kind: 'claim_ttl_expired'; layer: 1; queue_id: string }
  | { kind: 'received_stuck'; layer: 1; queue_id: string; age_sec: number }
  | { kind: 'dead_bot'; layer: 2; agent_id: string; last_seen_sec_ago: number }     // L2 process state
  | { kind: 'tmux_missing'; layer: 2; agent_id: string }
  | { kind: 'in_progress_stall'; layer: 3; queue_id: string; age_sec: number }      // L3 output state
  | { kind: 'context_pressure'; layer: 3; agent_id: string }
  | { kind: 'input_residue'; layer: 3; agent_id: string }
  | { kind: 'smooshing_hang'; layer: 3; agent_id: string };

function detectStall(
  rows: MessageQueueRow[],
  agents: AgentRow[],
  tmuxState: TmuxState,
  config: { stuckAfter: number; stallAfter: number; deadAfter: number }
): StallVerdict[];

// pre: 全引数 immutable snapshot
// post: 検出 verdict 配列 (重複 detection 0、1 row につき max 1 verdict)
// invariants:
//   - 同 sweep 周期内で 2 回呼出 → 同 verdict 配列 (idempotent)
//   - layer 1 / 2 / 3 直交、同 row が複数 layer 同時 detection 可
```

### 1.3a stall detection 3 layer abstraction (A2 統一)

[文献確認: auditor A2 BLOCK 解消、9 pattern 同一抽象 layer 統一]

| Layer | 抽象 | 共通 detection 軸 | 適用 pattern (#) |
|---|---|---|---|
| **L1: queue row predicate** | DB row state + age + claim metadata | `WHERE` 句単発 + age 計算 | 1 (idle: 全 row 不在) / 2 (claim TTL) / 3 (received stuck) |
| **L2: process state** | bot OS process / agent metadata | `agents.status` + `last_seen_at` + tmux session 存在 | 4 (dead bot) / 5 (tmux missing) |
| **L3: output state** | bot 出力ストリーム + LLM turn semantics | `in_progress` age + reply 出力 / context 状態観測 | 6 (in_progress stall) / 7 (context pressure) / 8 (input residue) / 9 (smooshing hang) |

各 Layer は同 abstraction 境界内で実装、cross-layer signal は `StallVerdict` 配列を介して合成のみ (混在禁止)。impl module 1 ファイル `core/stall-detector.ts` 内で 3 sub-layer 関数分離 default、internal split は §5.1 implementer 自由。

### 1.4 CC 機構削除 (全 path)

### 1.4 CC 機構削除 (全 path)

| path | 削除箇所 |
|---|---|
| `send` tool | `cc` parameter 削除、body 末尾 `[CC: <@id>]` 注入 logic 削除、CC recipient 用 queue insert 削除 |
| inbound receiver | Discord webhook で複数 mention 検出時の CC fanout 廃止、primary mention 1 件のみ enqueue |
| queue insert | `INSERT INTO message_queue` で 1 mention = 1 row 厳守 |

skipped status 発生源 0 化検証:
- migration 直前 `SELECT count(*) FROM message_queue WHERE status='skipped'` で snapshot
- migration 後 `INSERT WHERE status='skipped'` 7 日継続 0 件確認 (Phase 1 開始 gate)

### 1.5 wake duplicate suppression: per-bot 化 + 5s → 30s (cycle 5 patch、CEO `fc0b043e` 設計 refine)

[文献確認: CEO `fc0b043e` 「1 メッセージごとに何秒でなくて、1 以上の pending があったら 1 回弾く。30 秒後にリトライでないといけないのでは？」、lead-ama dispatch `25cc5aa7`+`ab227d14`]

**設計 (= per-bot suppression、旧 per-msg ではない)**:

state-daemon sweep loop は **bot 単位** で suppression evaluate (msg 件数依存削除):

```
for each bot with pending msg:
  SELECT MAX(last_wake_attempt_at) AS bot_last_wake
    FROM message_queue
    WHERE agent_id = bot AND status = 'pending'
    GROUP BY agent_id;

  IF bot_last_wake > now() - interval '30 seconds' THEN
    skip bot 全体 (= bot 内全 pending msg を本 sweep cycle で wake しない)
  ELSE
    wake bot 1 回
    UPDATE message_queue
      SET last_wake_attempt_at = now()
      WHERE agent_id = bot AND status = 'pending';
  END IF;
```

**Key invariants**:
- **per-bot 単位 evaluation**: 1 bot に N pending msg あっても本 cycle で wake は 1 回のみ (= msg 件数依存排除)
- **bot 内全 pending msg `last_wake_attempt_at` 同時更新**: 次 sweep で bot 全体が 30s skip 対象になる
- **30 秒 retry 周期**: 旧 5s から 30s 化、CEO 設計 「30 秒後にリトライ」 literal 実装
- **bot online status と独立**: pending 存在 & online bot のみ candidate、suppression は wake 時刻だけで判定

**config**:
```ts
const WAKE_DEDUP_INTERVAL_SEC = 30;  // 旧 5
// per-bot suppression、per-msg ではない (= cycle 5 refine、msg 件数依存削除)
```

**rationale (旧 per-msg → 新 per-bot の意義)**:
- 旧 per-msg: 1 bot に 5 pending あれば 5 wake (= ARC check inbox 連発再発の根因)
- 新 per-bot: 1 bot に 5 pending あっても 1 wake/30s (= CEO 設計、wake_storm 構造解消)

### 1.6 9 stall pattern detection (3 layer 統一、§1.3a abstraction 整合)

[文献確認: spec v0.9 §4-§7 + auditor A2 BLOCK 解消、3 layer 分類]

| Layer | # | pattern | detection (kind) | wake / 動作 |
|---|---|---|---|---|
| **L1 queue row predicate** | 1 | 真 idle (queue 空 + bot online) | `kind='idle'` (`count(pending)=0` + `agents.status='online'`) | nothing (信頼) |
| L1 | 2 | claim TTL expired | `kind='claim_ttl_expired'` (`received` AND `claim_expires_at < now()`) | self-reclaim → reset to `pending` + re-wake |
| L1 | 3 | received stuck 5min | `kind='received_stuck'` (`received` AND `age > stuckAfter`) | reset to `pending` (transparent retry) |
| **L2 process state** | 4 | dead bot | `kind='dead_bot'` (`agents.last_seen_at < now() - deadAfter` AND `status='online'`) | restart 実行 + alert |
| L2 | 5 | tmux missing | `kind='tmux_missing'` (`tmux session 不在` AND `runtime='TUI'`) | restart 実行 + alert |
| **L3 output state** | 6 | in_progress stall (判断 prompt 待ち含む) | `kind='in_progress_stall'` (`in_progress` AND `age > stallAfter`) | operator alert (auto reset しない) |
| L3 | 7 | context pressure | `kind='context_pressure'` (bot last reply に token 警告 pattern) | operator alert |
| L3 | 8 | input residue | `kind='input_residue'` (tmux pane 未送信 input 検出) | pane clear + re-wake |
| L3 | 9 | Smooshing hang | `kind='smooshing_hang'` (bot output 無 + claim 維持) | operator alert + restart 候補 |

各 pattern detection function は `core/stall-detector.ts` (新規) に **3 sub-layer 関数分離 default** で集約、return `StallVerdict[]` (§1.3 type 参照)。internal split は §5.1 implementer 自由。

各 detection は **同一抽象軸** (= L1: row predicate / L2: process state / L3: output state) で実装、cross-layer signal 混在禁止 (= verdict 配列で合成のみ)。

---

## 2. Required behavior (凍結)

[文献確認: spec v0.9 §4.3 state machine / §11 fixture / §12 migration phase + governance-flow.md production semantic]

### 2.1 production semantic (spec direct anchor 必須)

- **Zero-downtime migration** (spec §12 phase 1-3): state-daemon が稼働中、Phase 1 schema migration は zero-downtime 設計 (= 旧 enum と新 enum を一時並存できる migration スクリプト or rolling deploy)
- **Idempotent tool** (spec §4.3 transition idempotence): `processing` / `done` 2 回呼出は 2 回目 no-op + warning (= retry safe)
- **Atomic transition** (spec §4.3): status 遷移は単一 UPDATE 文 + WHERE 旧 status (= optimistic concurrency、race 時は warn + retry)
- **9 pattern coverage** (spec §4-§7 + §11.1 T27-T41 fixture): stall detection は 9 pattern 全て network/CPU spike なく一定 sweep 周期 (30s) で評価可能、同一 abstraction 3 layer 分類 (Layer 1 queue row predicate / Layer 2 process state / Layer 3 output state)
- **CC 削除完全性** (spec §1.4 削除 + §12 phase 1 gate): queue insert 後の `WHERE status='skipped'` 7 日 0 件 (= Phase 1 gate)
- **bot 19 体影響** (spec §12 phase 2 rollout): migration 後、全 bot の `next` 呼出が `'received'` claim を期待、旧 `'read'` claim は migration script で `'received'` rename 済 (data 損失 0)
- **production semantic 観測** (spec §11 + governance-flow Layer 0): 全 transition + stall detection を log + metric inc、CI で grep 可能

### 2.2 §5.2 確定判断の §2 promote (lead-ama dispatch msg `5e5c5410` per、open decision から required へ移動)

[文献確認: lead-ama dispatch msg `5e5c5410` 6 項目確定 + auditor cycle 1 Q2/A1 指摘「O1-O6 を §5.2 から §2 Required に移動」]

| ID | 確定値 | rationale |
|---|---|---|
| **R-O1 (migration 単発)** | 単発トランザクション (row < 50k 想定) | impl 着手前 agent-com-dev が `SELECT count(*) FROM message_queue` で row 数 verify、>10k なら lead-ama に再判断 escalate |
| **R-O2 (audit_log 新規 table)** | `audit_log` 新規 table を本 PR scope 内で migration 同梱 | scope 拡大 risk 回避、agent-memory MCP 等別 repo 影響回避 |
| **R-O3 (新 tool MCP schema impl PR 同梱)** | `processing` / `done` MCP schema は本 PR (impl) と同梱 push | 別 PR は cycle 増 + version drift |
| **R-O4 (env 化必須 `WAKE_DEDUP_SEC`)** | env override `WAKE_DEDUP_SEC` (default 30) を impl 必須、hardcode 不可 | operator emergency tuning 担保、`feedback_no_hardcode` per |
| **R-O5 (env 化必須 stall threshold)** | env override `STUCK_AFTER_SEC` (default 300=5min) / `STALL_AFTER_SEC` (default 600=10min) を impl 必須、hardcode 不可 | operator tuning + threshold 既決定値の動的調整 |
| **R-O6 (1 module `stall-detector.ts`)** | 9 stall pattern detection 単一 module `core/state-daemon/stall-detector.ts`、internal split (class / function 構造) は §5.1 自由 | 統合観点を維持、internal は implementer detail |

## 3. Forbidden behavior (凍結、anti-patterns)

[文献確認: 過去 incident 整理]

- **再導入禁止 (PR #330 revert per、CTO `1d402109`)**: prevention check / chain depth limit / pair bounce detection / ack pattern detection / TUI rate limit — 全て v0.3 以降廃止、復活させない
- **B8 type loop / runaway 検出 logic 再導入禁止**: arc↔adf-lead bounce 等の異 agent A↔B loop 検出は **B8 v0.3 spec scope** で別 PR 進行、本 PR では impl しない (= scope 混入禁止)。spec/v0.9 は state machine + 9 stall pattern のみで sufficient (incident 参照: 2026-05-07 17:55 JST `813db0eb`)
- **`IMPLICIT_ABANDON` reason 再導入禁止**: v0.8 旧 `failed_reason='IMPLICIT_ABANDON'` semantics は v0.9 で **廃止** (transparent retry loop で透明化)、`failed_reason` column 自体 drop 済。書込み試行は CHECK 制約違反 → impl error
- **CC fanout 復活禁止**: `cc` parameter 受領 / body `[CC: ...]` 注入 / CC recipient queue insert は **block PR**
- **paired migration files 復活禁止**: `migrations/` ディレクトリ別ファイル形式は廃止 (= inline canonical、`db/migrate.ts` 内 single source)
- **5s suppression 復活禁止**: `WAKE_DEDUP_INTERVAL_SEC = 5` への戻りは ARC checkinbox 連発再発、block PR
- **per-msg suppression 復活禁止 (cycle 5 patch)**: §1.5 per-bot 設計を per-msg (= 各 row 毎の `last_wake_attempt_at` 個別判定) に戻すことは CEO `fc0b043e` 設計違反、wake_storm 再発、block PR
- **同期 wake 禁止**: state-daemon は async pool で wake、main loop block する同期 wake は禁止
- **`skip` tool 残存禁止**: 削除と仕様。tool deprecation だけでなく code path 削除完全 verify
- **fail tool で status='failed' 残存禁止**: status='failed' は新 enum で存在しない、書込試行は CHECK 制約違反 → impl error
- **silent fallback 禁止** (`feedback_no_silent_fallback`): 通信障害時は alert + log のみ、通常通信代替禁止
- **scope 拡大禁止**: 本 PR は v0.9 spec 範囲限定、新規 feature 追加は **別 PR**
- **rollback 不在禁止 (sub-PR 1 §1.1b per、cycle 2 patch)**: destructive migration impl PR は rollback migration script を同時 ship 必須、rollback script 不在の destructive PR は **block PR**、CEO L4 GO 前提条件
- **dev DB verify 不在禁止 (sub-PR 1 §1.1b per、cycle 2 patch)**: destructive migration の production deploy 前に **dev DB で migration script + rollback script を実行 verify** 必須、dev verify skip は CEO 「端折らない」 directive (`b26651f0`) 違反、block PR

scope exclusion (本 PR で触らない):
- agent-memory MCP の DB schema (= 別 repo/scope)
- bot prompt template / CLAUDE.md (= 各 bot scope)
- adf-lead / org-build 等 ADF 系 (= 別 chain)

## 4. Test fixtures (凍結、merge gate)

### 4.1 contract test (executable、`pnpm test:contract` で全 pass が merge gate)

[文献確認: spec v0.9 §11.1 + §11.2]

- **§11.1 v0.9 new state regression gate**: T27-T41 (15 fixture) を `core/state-daemon/__tests__/v0.9-state-machine.test.ts` に impl
- **§11.2 legacy gate**: T1/T8-T17/T19-T26 (旧) を `core/state-daemon/__tests__/legacy-gate.test.ts` に保持 (Phase 5 で削除)
- **新 tool fixture** (3 件、新規 T42-T44):
  - T42 `processing_received_to_in_progress`: `received` row → `processing` 呼出 → status=`in_progress`、tool return ok
  - T43 `processing_invalid_state`: `pending` row → `processing` 呼出 → `INVALID_STATE` error、status 不変
  - T44 `done_in_progress_to_done`: `in_progress` row → `done` 呼出 → status=`done`、`done_at` set
- **migration fixture** (Phase 1 既存 row 変換、4 件):
  - M1 `read → received`: 既存 `read` row 全て `received` rename 後、count 一致
  - M2 `failed (IMPLICIT_ABANDON recent) → pending`: 旧 `failed` AND `failed_reason='IMPLICIT_ABANDON'` AND `claim_expires_at > now() - 60s` → `pending`、retry loop に投入
  - M3 `failed (other) → replied + audit log`: 上記以外の `failed` row → `replied` + 旧 `failed_reason` を `audit_log` table に退避
  - M4 `skipped → DELETE`: 全 `skipped` row 削除、count=0 確認
- **destructive migration safety fixture** (sub-PR 1 §1.1b per、cycle 2 patch、3 件):
  - **M5 `snapshot-before/after`**: migration 実行前 + 後 で `message_queue` table の全 row count + status 分布を snapshot、diff verify (= 全 row が新 enum 5 値に migration 済、count 不一致 0)
  - **M6 `Phase1/2/3 verify`**: Phase 1 (CHECK 制約拡張) 完了後 旧書込 CHECK 違反 / Phase 2 (data migration) 完了後 旧値 0 件 / Phase 3 (verify) `SELECT count(*) WHERE status NOT IN (new enum)` = 0 確認、各 phase で fixture 個別 pass
  - **M7 `rollback dry-run`**: rollback migration script を dev DB で実行 → 旧 enum 5 値復元 + 元 row count 一致 verify、production 適用前 mandatory

### 4.2 behavioral smoke (`scripts/test/smoke-v0.9.sh` 等)

各 fixture は **個別 executable artifact** (= shell script 1 ファイル) として impl、`scripts/test/` 配下に配置。merge gate は E1/E2/E3a-E3i (9 件)/E4 = **計 12 件** (E1 + E2 + E3a-E3i 9 件 + E4) を個別 pass で count。

- **E1**: bot が send → `replied` で terminal、queue から 7 日後 GC 実行で削除確認
  - artifact: `scripts/test/E1-replied-7day-gc.sh`
- **E2**: 30s 以内同 row 連続 INSERT (重複) → wake 1 回のみ、metric `dedup_skipped` += 1
  - artifact: `scripts/test/E2-wake-dedup-30s.sh`
- **E3a (L1 #1 idle)**: queue 全 row 不在 + bot online → `StallVerdict.kind='idle'` 1 件、metric `stall_detected_total{kind='idle'}` += 1、wake 不発火
  - artifact: `scripts/test/E3a-stall-idle.sh`
- **E3b (L1 #2 claim TTL expired)**: `received` row、`claim_expires_at = now() - 5s` → `kind='claim_ttl_expired'` 1 件、self-reclaim → `pending` reset、wake 1 回
  - artifact: `scripts/test/E3b-stall-claim-ttl.sh`
- **E3c (L1 #3 received stuck 5min)**: `received` row、`age=6min` → `kind='received_stuck'` 1 件、reset to `pending` (transparent retry)、metric `wake_actions_total{result='retry_reset'}` += 1
  - artifact: `scripts/test/E3c-stall-received-stuck.sh`
- **E3d (L2 #4 dead bot)**: `agents.last_seen_at = now() - 4min` AND `status='online'` → `kind='dead_bot'` 1 件、restart launcher 呼出、operator alert 1 回
  - artifact: `scripts/test/E3d-stall-dead-bot.sh`
- **E3e (L2 #5 tmux missing)**: `runtime='TUI'` AND `tmux session 不在` → `kind='tmux_missing'` 1 件、restart 実行、alert 1 回
  - artifact: `scripts/test/E3e-stall-tmux-missing.sh`
- **E3f (L3 #6 in_progress stall)**: `in_progress` row、`age=11min` (default stallAfter=10min 超過) → `kind='in_progress_stall'` 1 件、operator alert (auto reset しない)
  - artifact: `scripts/test/E3f-stall-in-progress.sh`
- **E3g (L3 #7 context pressure)**: bot last reply に token 警告 pattern (例: "context limit") → `kind='context_pressure'` 1 件、operator alert
  - artifact: `scripts/test/E3g-stall-context-pressure.sh`
- **E3h (L3 #8 input residue)**: tmux pane に未送信 input 検出 → `kind='input_residue'` 1 件、pane clear + re-wake
  - artifact: `scripts/test/E3h-stall-input-residue.sh`
- **E3i (L3 #9 smooshing hang)**: bot output 無 + claim 維持 + `age > stallAfter` → `kind='smooshing_hang'` 1 件、operator alert + restart 候補
  - artifact: `scripts/test/E3i-stall-smooshing.sh`
- **E4**: bot 19 体に対して migration 実施、`next` 呼出が `'received'` claim 取得確認、data 損失 0
  - artifact: `scripts/test/E4-migration-19-bots.sh`

### 4.3 CI 要件
- 全 fixture (T1-T44 + M1-M7 + E1/E2/E3a-E3i 9 件/E4 = 15 件、M5-M7 は sub-PR 1 destructive migration safety per §1.1b cycle 2 patch) pass で merge gate (Layer 0 自動 gate per governance)
- breaking change detection (`scripts/detect-breaking-changes.sh`) で `route:ceo-approval` label 必須

## 5. Open decisions (implementer 自由、§2.2 で確定済外の internal detail のみ)

[lead-ama cycle 2 縮小: 旧 §5.2 lead-ama 確認待ち 6 項目 (O1-O6) は §2.2 R-O1〜R-O6 で確定済 (env 化必須 / 単発 migration / audit_log 新規 / impl PR 同梱 / 1 module)、本 §5 は internal detail のみ残す]

implementer (agent-com-dev) が自由に選択してよい項目 (lead-ama escalate 不要):

### 5.1 internal 構造 (自由)
- daemon 内部 module 分割 (class / function / private helper 命名、§2.2 R-O6 で 1 module 確定後の internal split は自由)
- `processing` / `done` tool の internal helper 共有 (transition.ts 共通化等)
- migration script の実装言語 (TypeScript / SQL pure / pg-migrate 等)
- audit_log table schema 詳細 (column 構成 / index、§2.2 R-O2 で新規 table 確定後の column design 自由)
- `stall-detector.ts` 内部の関数分割 (1 module 内で 9 pattern を 9 function 化 / 3 layer 化等、§2.2 R-O6 統合観点維持)
- env name の prefix convention (`AGENTCOM_*` / `STATE_DAEMON_*` 等、§2.2 R-O4/R-O5 既定 env 名は維持)

implementer が §5.1 列挙以外の判断に遭遇 → lead-ama に escalate、self-proceed 禁止 (engineer-scope-discipline)。

---

## §Evidence (repo-only references、Discord/private memory refs 禁止)

- spec source: `docs/design/queue-state-polling-daemon.md` v0.9 (commit `72b9c92`)
- 旧 enum DB CHECK: `db/migrate.ts:246` (PR #336 merge 前 verify、本 PR で更新)
- 旧 `read` claim: `server.ts:next` (PR #336 merge 前 verify、本 PR で `received` 化)
- 旧 `fail` / `skip` tool: `server.ts:1709 / 1842` (PR #336 merge 前 verify、本 PR で deprecate / 削除)
- governance: `~/.claude/rules/governance-flow.md` (6-section format 2026-05-07 改訂)
- precedent: PR #333 `core/state-daemon/index.ts` line 437-453 (non-TUI silent skip 整合、本 PR でも runtime gate 維持)
- post-mortem: PR #330 revert (commit `21e74f7`) — prevention check 復活禁止 reference
- breaking change detection: `scripts/detect-breaking-changes.sh` (Layer 0 自動 gate)

---

## 後続 chain

1. ARC が本 6-section 指示書 draft commit + push (= 本 file)
2. ARC が lead-ama に dispatch (本 file path + scope 概要)
3. lead-ama が IMPL doc 正式 authoring (governance Step 3.4) + auditor pre-impl gate (7 項目) 経由
4. agent-com-dev impl + PR 起票 (route:ceo-approval、DB migration 含む)
5. L1 (lead-ama) → L2 (auditor、Pre-impl + Post-impl) → L3 (CTO) → L4 (CEO 明示 GO) → CTO merge
6. post-merge 全方位検証 (Phase 1 → Phase 6 rollout、spec §12 per)
