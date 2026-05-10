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
- **`dispatch_origin`**: `arc` (drafting) → `lead-ama` (formal IMPL doc authoring + dispatch)
- **`dispatch_reason`**: CTO directive `a21fe385` (本日 2026-05-10、CEO `0dc05f05` GO per)。state-daemon v0.9 spec (PR #336 merged commit `72b9c92`) の impl 統合 1 PR 化要請。
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

### 1.3 既存 tool 修正

| tool | 修正 |
|---|---|
| `next` | claim 部 `UPDATE message_queue SET status='received', claim_expires_at=...` (旧 `'read'`) |
| `fail` | **deprecate**: tool 自体は残すが no-op return + warning。retry transparent loop で内部処理。 |
| `skip` | **削除**: tool 削除、CC fanout 廃止で発生源 0、呼び元なし verify 必須 |
| `send` | reply 送信時 `UPDATE ... SET status='replied'` (旧: replied 設定経路維持) |

### 1.4 CC 機構削除 (全 path)

| path | 削除箇所 |
|---|---|
| `send` tool | `cc` parameter 削除、body 末尾 `[CC: <@id>]` 注入 logic 削除、CC recipient 用 queue insert 削除 |
| inbound receiver | Discord webhook で複数 mention 検出時の CC fanout 廃止、primary mention 1 件のみ enqueue |
| queue insert | `INSERT INTO message_queue` で 1 mention = 1 row 厳守 |

skipped status 発生源 0 化検証:
- migration 直前 `SELECT count(*) FROM message_queue WHERE status='skipped'` で snapshot
- migration 後 `INSERT WHERE status='skipped'` 7 日継続 0 件確認 (Phase 1 開始 gate)

### 1.5 wake duplicate suppression: 5s → 30s

state-daemon の `last_wake_attempt_at` チェック:
- 旧: `last_wake_attempt_at > now() - interval '5 seconds'` → skip
- 新: `last_wake_attempt_at > now() - interval '30 seconds'` → skip

config:
```ts
const WAKE_DEDUP_INTERVAL_SEC = 30;  // 旧 5
```

### 1.6 9 stall pattern detection

[文献確認: spec v0.9 §4-§7]

| Layer | # | pattern | detection | wake 動作 |
|---|---|---|---|---|
| 1 (queue) | 1 | 真 idle (queue 空 + bot online) | `count(pending)=0` + `agents.status='online'` | nothing (信頼) |
| 1 | 2 | claim TTL expired | `received` AND `claim_expires_at < now()` | self-reclaim → reset to `pending` + re-wake |
| 1 | 3 | stuck 5min | `received` AND `age > 5min` | reset to `pending` (transparent retry) |
| 1 | 4 | dead bot | `agents.last_seen_at < now() - 3min` AND `status='online'` | restart 実行 + alert |
| 1 | 5 | tmux missing | `tmux session 不在` AND `runtime='TUI'` | restart 実行 + alert |
| 2 (bot internal) | 6 | 判断 prompt 待ち | `in_progress` AND `age > stallAfter (10min default)` | operator alert (auto reset しない) |
| 2 | 7 | context 圧迫 | bot last reply 内 token 警告 | operator alert |
| 2 | 8 | input residue | tmux pane に未送信 input 検出 | clear + re-wake |
| 2 | 9 | Smooshing hang | bot output 全停止 + claim 維持 | operator alert + restart 候補 |

各 pattern detection function は `core/stall-detector.ts` (新規) に集約、return `StallVerdict` 構造化。

---

## 2. Required behavior (凍結)

[文献確認: spec v0.9 §2 設計目標 + governance-flow.md production semantic]

- **Zero-downtime migration**: state-daemon が稼働中、Phase 1 schema migration は zero-downtime 設計 (= 旧 enum と新 enum を一時並存できる migration スクリプト or rolling deploy)
- **Idempotent tool**: `processing` / `done` 2 回呼出は 2 回目 no-op + warning (= retry safe)
- **Atomic transition**: status 遷移は単一 UPDATE 文 + WHERE 旧 status (= optimistic concurrency、race 時は warn + retry)
- **30s suppression**: same `queue_id` への wake 試行は 30s 以内重複抑制、metric `wake_actions_total{result='dedup_skipped'}` inc
- **9 pattern coverage**: stall detection は 9 pattern 全て network/CPU spike なく一定 sweep 周期 (30s) で評価可能
- **CC 削除完全性**: queue insert 後の `WHERE status='skipped'` 7 日 0 件 (= Phase 1 gate)
- **bot 19 体影響**: migration 後、全 bot の `next` 呼出が `'received'` claim を期待、旧 `'read'` claim は migration script で `'received'` rename 済 (data 損失 0)
- **production semantic 観測**: 全 transition + stall detection を log + metric inc、CI で grep 可能

## 3. Forbidden behavior (凍結、anti-patterns)

[文献確認: 過去 incident 整理]

- **再導入禁止 (PR #330 revert per、CTO `1d402109`)**: prevention check / chain depth limit / pair bounce detection / ack pattern detection / TUI rate limit — 全て v0.3 以降廃止、復活させない
- **CC fanout 復活禁止**: `cc` parameter 受領 / body `[CC: ...]` 注入 / CC recipient queue insert は **block PR**
- **paired migration files 復活禁止**: `migrations/` ディレクトリ別ファイル形式は廃止 (= inline canonical、`db/migrate.ts` 内 single source)
- **5s suppression 復活禁止**: `WAKE_DEDUP_INTERVAL_SEC = 5` への戻りは ARC checkinbox 連発再発、block PR
- **同期 wake 禁止**: state-daemon は async pool で wake、main loop block する同期 wake は禁止
- **`skip` tool 残存禁止**: 削除と仕様。tool deprecation だけでなく code path 削除完全 verify
- **fail tool で status='failed' 残存禁止**: status='failed' は新 enum で存在しない、書込試行は CHECK 制約違反 → impl error
- **silent fallback 禁止** (`feedback_no_silent_fallback`): 通信障害時は alert + log のみ、通常通信代替禁止
- **scope 拡大禁止**: 本 PR は v0.9 spec 範囲限定、新規 feature 追加は **別 PR**

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

### 4.2 behavioral smoke (`scripts/test/smoke-v0.9.sh` 等)

- E1: bot が send → `replied` で terminal、queue から 7 日後 GC 実行で削除確認
- E2: 30s 以内同 row 連続 INSERT (重複) → wake 1 回のみ、metric `dedup_skipped` += 1
- E3: 9 stall pattern を仮想 setup → 各 pattern detection が trigger、metric inc 確認
- E4: bot 19 体に対して migration 実施、`next` 呼出が `'received'` claim 取得確認、data 損失 0

### 4.3 CI 要件
- 全 fixture (T1-T44 + M1-M4 + E1-E4) pass で merge gate (Layer 0 自動 gate per governance)
- breaking change detection (`scripts/detect-breaking-changes.sh`) で `route:ceo-approval` label 必須

## 5. Open decisions (implementer 自由 + lead-ama 確認待ち)

implementer (agent-com-dev) が自由に選択してよい項目:

### 5.1 internal 構造 (自由)
- daemon 内部 module 分割 (class / function / private helper 命名)
- `processing` / `done` tool の internal helper 共有 (transition.ts 共通化等)
- migration script の実装言語 (TypeScript / SQL pure / pg-migrate 等)
- audit_log table schema (PERMANENT failed 退避先、新規 table or 既存 table 拡張)

### 5.2 lead-ama 確認待ち (impl PR 着手前に決定)

| # | 項目 | 提案 default | lead-ama 判断要請 |
|---|---|---|---|
| O1 | migration 単発トランザクション or batch? | 単発 (現状 row < 50k) | row 数 verify 後再判断 |
| O2 | `failed (PERMANENT)` 退避先 | `audit_log` 新規 table | 既存 table 流用要否 |
| O3 | `processing` / `done` tool の MCP schema 公開タイミング | impl PR 同梱 | 別 PR 分離要否 |
| O4 | wake_dedup_interval_sec を env 化? | hardcoded 30s | env 化 (`WAKE_DEDUP_SEC`) 要否 |
| O5 | stall pattern threshold (例: stuckAfter 5min / stallAfter 10min) を config 化? | inline default | env / config table 化要否 |
| O6 | 9 stall pattern detection を 1 module / 9 module? | 1 module (`stall-detector.ts`) | 分割要否 |

implementer が (1)-(4) に含まれない判断に遭遇 → lead-ama に escalate、self-proceed 禁止。

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
