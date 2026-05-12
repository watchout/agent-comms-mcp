# agent-comms state-daemon v0.9 — 6 sub-PR rollout plan

**Status**: draft (ARC, 2026-05-12)
**Origin**: CEO directive `bc380bd4` 「まず 338 から、過去ログベース」+ `3f915c2b` 「338 のやることが多ければサブ PR 化、ARC に進めてもらう？」 採択、CTO dispatch payload `f4194e91`+`0b7e32a8`、lead-ama dispatch `25cc5aa7`+`ab227d14` per
**Base spec**: PR #338 `docs/spec/agentcom-state-daemon-v0.9-impl.md` (cycle 5 patch 含む)
**Driver**: incident #339 series 再発予防 + wake_storm 構造解消

---

## §1 概要

PR #338 (6-section instruction for state-daemon v0.9 統合 impl) は内容過多のため、本 plan で **6 axis sub-PR に分割**、route 別 chain で順次 merge。

destructive change (= status enum migration) は **fleet 慣熟後最後に push**、additive change を先行させ run-time risk を最小化。

---

## §2 6 sub-PR breakdown table

| sub-PR | §scope (= PR #338 spec の section) | route | risk | dependency | order |
|---|---|---|---|---|---|
| **sub-PR 1** | §1.1 status enum migration (旧 5 → 新 5 再定義) + Phase 1-3 deploy | `route:ceo-approval` | 🔴 destructive (= incident #339 同型 risk) | sub-PR 2-6 fleet 慣熟後 (= 最終) | **6** |
| **sub-PR 2** | §1.6 (旧 §1.3a) 9 stall pattern detection + 3 layer abstraction (`core/stall-detector.ts` 新規) | `route:fast-merge` | 🟢 additive (= 既 production 影響なし、detection の新規実装) | sub-PR 4 (per-bot suppression) 後推奨 | **2** |
| **sub-PR 3** | §1.4 CC 機構完全削除 (queue 非投入化、`cc` parameter 廃止) | `route:ceo-approval` | 🟡 behavior change (= caller 互換性ある breaking change、CEO `a7bd49d8` 確認済) | sub-PR 4 + sub-PR 5 後推奨 (= 安定運用確認後) | **4** |
| **sub-PR 4** | §1.5 per-bot wake duplicate suppression (cycle 5 patch、CEO `fc0b043e` 設計 literal) | `route:fast-merge` | 🟢 additive (= state-daemon 内 logic refine、外部 contract 不変) | なし、最優先 (= wake_storm 解消の core) | **1** |
| **sub-PR 5** | §1.6 (新規 番号、旧 §1.6) 7 day GC (replied 7 日経過 delete、failed 除外) | `route:fast-merge` | 🟢 additive (= GC daemon の新規実装、production 影響限定) | sub-PR 4 後推奨 | **3** |
| **sub-PR 6** | §1.7 新 tool 2 個 (`mcp__agent-comms__processing` / `done`) | `route:fast-merge` | 🟢 additive (= 新 tool 追加、既 tool 不変) | sub-PR 1 (status enum) 前提 (= `in_progress` / `replied` 新 enum required)、sub-PR 1 完了後に着手 | sub-PR 1 完了後 (= 最終 PR group の 2 番目) | **6.5** |

---

## §3 Rollout order rationale

CEO directive 「sub-PR 1 destructive を最後に push」+ wake_storm 解消優先 + fleet 慣熟順序を考慮:

### Phase 1: wake_storm 解消 (priority 最優先)

**sub-PR 4** (per-bot suppression、§1.5 cycle 5) を最先行。理由:
- ARC check inbox 連発の構造的解消が CEO 設計 `fc0b043e` の core
- additive、production 影響限定 (state-daemon 内 logic refine)
- 既存 `WAKE_DEDUP_INTERVAL_SEC = 5` を 30s + per-bot に変更、Phase 1 単独で wake_storm 構造的解消

### Phase 2: detection capability 拡張

**sub-PR 2** (9 stall pattern detection)。理由:
- additive、既 production 影響なし
- L1/L2/L3 3 layer abstraction の confirmation を fleet で検証
- sub-PR 4 先行で wake_storm 影響なく detection 専用 PR が単独評価可能

### Phase 3: housekeeping

**sub-PR 5** (7 day GC)。理由:
- additive、replied 7 日経過 row の自動削除、production 影響限定
- sub-PR 4 + 2 後の安定運用確認後、housekeeping daemon 追加

### Phase 4: CC 機構廃止

**sub-PR 3** (§1.4 CC 削除)。理由:
- behavior change (= queue 非投入化)、caller (= send tool / notify tool) 影響あり
- sub-PR 2 detection で `kind='cc_skipped'` 観測 0 件 7 日後 (= Phase 2 gate per spec §12) で投入
- CEO `a7bd49d8` 「CC 排除も v0.9?」確認済の core 変更

### Phase 5: 新 tool addition

**sub-PR 6** (`processing` / `done` tool)。理由:
- additive (= 新 tool 追加)、ただし new status enum (`in_progress` / `replied`) **前提**
- sub-PR 1 (enum migration) **完了後** に着手 (= sub-PR 1 destructive 最終 push 制約と整合)
- 実装: sub-PR 1 merge 完了 + fleet PID drift verify 後、別 PR として sub-PR 6 起票

### Phase 6: destructive enum migration

**sub-PR 1** (§1.1 status enum migration)。理由:
- 🔴 destructive (旧 enum drop、incident #339 同型 risk)
- 他 5 sub-PR 完了 + fleet 慣熟後の **最終 PR**
- P1 / S2 / X1 既備済 safety 装置 (= destructive migration env flag、env unset → block) を必須前提
- Phase 1-3 zero-downtime migration script を spec §12 per 厳守
- L4 CEO 明示 GO + post-merge fleet PID drift verify mandatory

---

## §4 Dependency 図

```
sub-PR 4 (per-bot suppression, additive)
    ↓
sub-PR 2 (stall detection, additive)
    ↓
sub-PR 5 (7 day GC, additive)
    ↓
sub-PR 3 (CC 削除, behavior change, route:ceo-approval)
    ↓
sub-PR 1 (status enum migration, 🔴 destructive, route:ceo-approval)
    ↓ (merge + fleet PID drift verify)
sub-PR 6 (新 tool processing/done、sub-PR 1 完了後)
```

**並行可能性**:
- sub-PR 4 / 2 / 5 は accept criteria 独立、bandwidth 許せば parallel impl 可
- sub-PR 3 / 1 は behavior change / destructive のため sequential
- sub-PR 6 は sub-PR 1 完了後に着手 (= sub-PR 1 destructive 最終 push 制約と整合、新 enum 前提を満たす)

---

## §5 Acceptance criteria (per sub-PR)

### sub-PR 4 (per-bot suppression)

- [ ] `WAKE_DEDUP_INTERVAL_SEC = 30` config landed
- [ ] state-daemon sweep loop が per-bot evaluate (= `SELECT MAX(last_wake_attempt_at) ... GROUP BY agent_id`)
- [ ] 1 bot に N pending あっても 30s 内 1 wake のみ test fixture PASS
- [ ] bot 全 pending msg `last_wake_attempt_at` 同時更新 test PASS
- [ ] regression: 既 tests green
- [ ] post-merge fleet で ARC check inbox 連発 0 件 (= 30 min observe)

### sub-PR 2 (9 stall pattern detection)

- [ ] `core/stall-detector.ts` 新規、9 pattern detection function 実装
- [ ] L1/L2/L3 3 sub-layer 分離 (cross-layer signal 混在禁止)
- [ ] 9 pattern 全件 fixture (spec §11 T27-T41) PASS
- [ ] state-daemon sweep loop に統合、`StallVerdict[]` return
- [ ] regression: 既 tests green
- [ ] post-merge fleet で detection 動作 observable

### sub-PR 5 (7 day GC)

- [ ] GC daemon 新規 (or state-daemon 内統合)、`status='replied' AND age > 7 days` で delete
- [ ] `status='failed'` 除外 (= retention policy)
- [ ] fixture: 7 day GC 動作 verify
- [ ] regression: 既 queue API 不変
- [ ] post-merge: replied row 7 日経過 delete 観測

### sub-PR 3 (CC 削除)

- [ ] `send tool` の `cc` parameter 受領 → block (`INVALID_PARAMETER`)
- [ ] body `[CC: ...]` 注入 logic 削除
- [ ] CC recipient queue insert 廃止
- [ ] caller (各 bot) の cc 使用箇所 update (= migration plan 別 doc)
- [ ] fixture: `cc` 渡し → reject test
- [ ] post-merge: CC 含 msg insert 0 件 7 日継続 (= Phase 2 gate per spec §12)

### sub-PR 6 (新 tool)

- [ ] `mcp__agent-comms__processing` tool 新規 (= bot が msg を実行開始 mark)
- [ ] `mcp__agent-comms__done` tool 新規 (= bot が msg を完了 mark)
- [ ] 2 回呼出 idempotent (= 2 回目 no-op + warning)
- [ ] 単一 UPDATE + WHERE 旧 status (= atomic transition)
- [ ] fixture: tool happy path + retry idempotence
- [ ] new status enum (`in_progress` / `replied`) 前提 (= sub-PR 1 完了後着手)

### sub-PR 1 (status enum migration)

- [ ] **destructive migration env flag 必須**: `AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED=1` (production launchd plist のみ)
- [ ] zero-downtime migration script (Phase 1-3 per spec §12) 完備
- [ ] 旧 5 enum (`pending` / `read` / `replied` / `failed` / `skipped`) → 新 5 enum 再定義
- [ ] 旧 `read` claim → 新 `received` rename 完了
- [ ] migration 直前/後 snapshot 取得 + 比較 verify
- [ ] L4 CEO 明示 GO mandatory (route:ceo-approval)
- [ ] post-merge fleet PID drift check mandatory (= 全 bot が new code 起動済)
- [ ] rollback plan documented (= 旧 enum 戻し migration script)

---

## §6 Cross-cutting invariants

- **CC 削除 (sub-PR 3)** と **新 tool (sub-PR 6)** は別 chain、ただし 19 体 bot の caller migration が cc 経由から processing/done 経由に並行 shift する
- **sub-PR 1 (enum migration)** は最終、destructive、P1/S2/X1 safety 装置 (env flag fail-closed) を必須前提
- **post-merge verify**: 各 sub-PR で governance-flow.md Gate D 全方位検証 (= unit/integration/regression + fleet PID drift + bot startup verify) を実施
- **memory rule**: 「destructive migration は env flag mandatory、unset 時 fail-closed (= incident #339 再発予防)」を本 plan で literal 再確認

---

## §7 Known limitations / debt

### 7.1 spec §1.6 / §1.7 番号統合

PR #338 spec doc 内で §1.6 (旧 §1.3a) と §1.6 (7 day GC) が重複 (= cycle 5 patch 前提)。本 rollout plan では「sub-PR 2 = 9 stall pattern」「sub-PR 5 = 7 day GC」として明示分離、spec doc 側の section 番号は cycle 5+ 以降で renumber 推奨。

### 7.2 sub-PR 3 caller migration

CC 削除に伴う 19 体 bot caller の migration plan は本 rollout plan **scope 外**、別 doc (= `docs/migration/cc-to-processing-done.md` 新規候補) で扱う。

### 7.3 sub-PR 1 destructive migration safety

env flag 不足の incident #339 同型 risk を最小化するため:
- sub-PR 1 前段で全 production bot が env flag set 済 verify
- launchd plist 確認 + `launchctl print` で env exposed verify
- migration script は dry-run mode で先行確認

---

## Closing

- 本 rollout plan は CEO `bc380bd4` 「過去ログベース」 directive per、CTO 過去ログ 5 件 (`fc0b043e` / `a7bd49d8` / `2e4eed47` / `3f915c2b` / `bc380bd4`) + spec §1.4-§1.7 を統合
- 6 sub-PR で順次 merge、destructive (sub-PR 1) は最終
- 並行可能 sub-PR (4/2/5) は bandwidth 許せば parallel impl 可、destructive / behavior change (3/1) は sequential
- 各 sub-PR で governance-flow.md L1/L2/L3 chain + post-merge Gate D 検証 mandatory

---

[ARC sign-off: 2026-05-12、PR #338 6 sub-PR rollout plan 初版 drafting]
