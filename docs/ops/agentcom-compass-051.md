---
id: OPS-AGENTCOM-051
status: Draft
traces:
  spec: [SPEC-AGENTCOM-051]
  impl: [IMPL-AGENTCOM-051]
---

# OPS: SPEC-AGENTCOM-051 COMPASS (skeleton)

> [文献確認: SPEC, IMPL, proposal §6]

## 0. 対応する SPEC / IMPL
- SPEC-AGENTCOM-051
- IMPL-AGENTCOM-051

## 1. デプロイ手順

### 1.1 前提条件
- agent-com v2.1.0 production
- state-daemon (PR #328 v0.7) merged
- agent-mem (wasurezu) MCP 稼働
- ADF v1.2.1 SessionStart hook 設置済

### 1.2 手順 (5 phase rollout、proposal §6 per)
1. **Phase 1**: Component 1 (Context Gauge) + 6 (Dashboard) deploy、observability 確立 (1 週間)
2. **Phase 2**: Component 2 (Bot-Initiated Clear) + 3 (Snapshot) deploy、自律 clear 開始 (1-2 週間)
3. **Phase 3**: Component 4 (Revival Briefing) deploy、復元品質 verify (1 週間)
4. **Phase 4**: Component 5 (Force-Clear Escalation) deploy、3 段階 escalation 機能 (1 週間)
5. **Phase 5**: 統合 + Production、agent-com-dev で 1 週間 dogfood (1 週間)

### 1.3 デプロイ後確認
- dashboard で全 bot context 可視化
- 自発 /clear 実行確認
- snapshot 5 カテゴリ保存確認
- Revival 復元品質 review

## 2. ロールバック手順

### 2.1 条件
- agent-mem 障害連発 → in-memory fallback で degrade
- 自発 /clear が誤発動 → snapshot 紛失 risk
- Revival 品質低下 → bot work loss
- Level 3 escalation kill+restart 連発

### 2.2 手順
1. component 単位で disable env var (`COMPASS_<COMP>_DISABLE=1`)
2. dashboard で disable component を可視化
3. operator 通知 + post-mortem 作成
4. 必要に応じ revert PR (CTO 判断)

## 3. 監視項目

| メトリクス | 正常範囲 | アラート | 通知先 |
|---|---|---|---|
| `compass_context_token_estimate{bot_id}` | < 70% | > 70% (Level 1) | dashboard |
| `compass_self_clear_total{bot_id}` | bot per 0-5/day | > 10/day (clear 過剰) | #dev-agent-com |
| `compass_force_level_3_total` | 0/week | > 0 (work loss risk) | CTO + CEO |
| `compass_snapshot_save_failure_total` | 0/day | > 3/day | #dev-agent-com |
| `compass_revival_quality_score` | > 0.8 | < 0.7 | lead-bot |
| `compass_dashboard_request_total` | normal | > 1000/min (DoS) | operator |

## 4. SLO

| SLI | 目標 |
|---|---|
| 791k token 限界事象再発率 | 0/month (本 spec の structural fix 達成) |
| 自発 /clear 成功率 | > 95% |
| Revival 復元品質 | > 80% |
| dashboard 可用性 | 99.9% |

## 5. 障害対応 Runbook (3 症状以上)

### 5.1 症状: bot 自発 /clear 拒否 pattern 定着
- 一次対応: dashboard で bot 別 clear 拒否率確認、Level 2 警告閾値調整
- エスカレーション: 1 週間 5+ 件で CTO mention
- 再発防止: bot CLAUDE.md に COMPASS 自発 clear 推奨指示追加 (advisory)

### 5.2 症状: snapshot 5 カテゴリ復元品質低下
- 一次対応: revival briefing log review、欠落カテゴリ特定
- エスカレーション: quality score < 0.7 連続で auditor mention
- 再発防止: 5 カテゴリ schema 改訂 PR

### 5.3 症状: Level 3 escalation kill+restart 連発
- 一次対応: bot specific issue 確認 (CLAUDE.md / context bloat / hook 障害)
- エスカレーション: 1 week 3+ Level 3 で CTO + CEO mention
- 再発防止: Level 1/2 閾値調整 + bot specific tuning

### 5.4 症状: agent-mem MCP 障害
- 一次対応: in-memory fallback 動作確認 (NFR-2)
- エスカレーション: 30 分以上 fallback で agent-mem-dev mention
- 再発防止: agent-mem 多重化 (別 spec)

## 6. 定期メンテナンス
- 月次: dashboard metric review、threshold tuning
- 四半期: snapshot 5 カテゴリ schema review、復元品質統計
- 半年: phase rollout retrospective

## 7. バックアップ・リストア
- snapshot は agent-mem 永続化 + 30 日 retention (env override)
- agent-mem 自体の backup は別 spec

## 8. 権限管理
- dashboard CLI: operator 認証必須
- snapshot save/restore: bot 自身のみ
- env var (COMPASS_*) 変更: PR review 必須

## 9. 制御機構の使い分け原則

[文献確認: SPEC §10、Notion canonical]

本 feature の運用機構:
- FR-001/003/005/006: script (state-daemon / CLI / persistence)
- FR-002: MCP tool (script) + Hook 連携 (case 1: tool 制御)
- FR-004: Hook (case 3: SessionStart 復元)

= 4/6 script、2/6 Hook 不可避 case (1+3)。原則整合 ✅

## 10. トレース

| OPS section | SPEC / IMPL |
|---|---|
| §1 デプロイ (5 phase) | proposal §6 |
| §3 監視 | SPEC §6.4 + IMPL §6 |
| §5 Runbook | proposal §8 Risk |
| §9 制御機構 | SPEC §10 |

## §Evidence (skeleton 根拠)

### 実 file 引用
- `docs/spec/agentcom-compass-051.md`
- `docs/impl/agentcom-compass-051.md`
- `proposals/agentcom-compass-proposal.md` §6 phase rollout / §8 Risk
