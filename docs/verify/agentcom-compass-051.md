---
id: VERIFY-AGENTCOM-051
status: Draft
traces:
  spec: [SPEC-AGENTCOM-051]
  impl: [IMPL-AGENTCOM-051]
---

# VERIFY: SPEC-AGENTCOM-051 COMPASS (skeleton)

> [文献確認: SPEC §7 Acceptance Criteria, proposal §7 完了条件 8 件]

## 0. 対応する SPEC / IMPL
- SPEC-AGENTCOM-051
- IMPL-AGENTCOM-051

## 1. 機能テスト (Gherkin)

SPEC §7.1〜7.6 の Gherkin Scenario を import + 詳細化。

### 1.1 [VERIFY-AGENTCOM-051-001] Context Gauge tracking
SPEC §7.1 (FR-001) per

### 1.2 [VERIFY-AGENTCOM-051-002] Bot-Initiated Clear
SPEC §7.2 (FR-002) per

### 1.3 [VERIFY-AGENTCOM-051-003] 5 カテゴリ Snapshot
SPEC §7.3 (FR-003) per

### 1.4 [VERIFY-AGENTCOM-051-004] Revival Briefing
SPEC §7.4 (FR-004) per

### 1.5 [VERIFY-AGENTCOM-051-005] 3 段階 Escalation
SPEC §7.5 (FR-005) per

### 1.6 [VERIFY-AGENTCOM-051-006] Dashboard CLI
SPEC §7.6 (FR-006) per

### 1.7 [VERIFY-AGENTCOM-051-007] phase rollout (proposal §6 phase 1-5)

## 2. 境界値テスト

| 項目 | 境界 | 期待 |
|---|---|---|
| context threshold warning | 70% 直前 | warn なし |
| context threshold critical | 90% 直前 | warn のみ |
| 90% 超 | escalation Level 1 開始 |
| snapshot 5 カテゴリ サイズ | proposal §FR-3 上限 | OK |
| dashboard query 全 bot | 50 bot | < 5 秒 |

## 3. 異常系テスト

| 入力 | 期待 |
|---|---|
| agent-mem 障害 | in-memory fallback、warn |
| bot 自発 clear 拒否 | Level 2 警告 → operator alert |
| snapshot 5 カテゴリ schema 違反 | exit 2、validation error |
| Revival 復元失敗 | bot に operator alert |

## 4. 認証/認可テスト
- dashboard CLI は operator 認証必須
- snapshot save/restore は bot 自身のみ access (other bot snapshot は read only)

## 5. パフォーマンステスト

| 項目 | 基準 |
|---|---|
| context monitor overhead | < 5% per session |
| snapshot save | < 2 秒 |
| Revival briefing 生成 | < 5 秒 |
| dashboard query | < 5 秒 |

## 6. セキュリティテスト

| 攻撃ベクタ | 想定結果 |
|---|---|
| snapshot に PII (例: 顧客 email) | filter 検出 + warn |
| dashboard 非認証 access | 拒否 + audit log |
| snapshot 改竄 | git audit (snapshot は agent-mem に永続化、改竄検出) |

## 7. Definition of Done

[文献確認: proposal §7 完了条件 8 件]:

- [ ] Component 1-6 全 impl + L1+L2+L3 LGTM
- [ ] 5 phase 全完了 (proposal §6)
- [ ] agent-com-dev で 1 週間 dogfood、791k token 限界事象 0 件再発
- [ ] dashboard で全 bot context 状態可視化
- [ ] snapshot 5 カテゴリ復元 quality > 80% (revival briefing review)
- [ ] Level 3 force-clear 発動 0 件 (Level 1/2 で解消想定)
- [ ] CI green (typecheck / lint / test)
- [ ] CTO L3 sanity (cross-cutting、state-daemon / agent-mem / SessionStart hook 全統合)

## 8. トレース

| VERIFY ID | SPEC FR |
|---|---|
| 001-006 | FR-001-006 |
| 007 | proposal §6 phase rollout |

## §Evidence (skeleton 根拠)

### 実 file 引用
- `docs/spec/agentcom-compass-051.md` §7 受入基準
- `proposals/agentcom-compass-proposal.md` §7 完了条件
