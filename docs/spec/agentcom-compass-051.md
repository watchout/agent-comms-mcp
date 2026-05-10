---
id: SPEC-AGENTCOM-051
status: Draft
traces:
  impl: [IMPL-AGENTCOM-051]
  verify: [VERIFY-AGENTCOM-051]
  ops: [OPS-AGENTCOM-051]
---

# SPEC-AGENTCOM-051: COMPASS — Context Optimization & Memory Persistence Auto-Save System

> Honesty: [検証済] / [文献確認] / [推測]
> 起点: CEO drafted `proposals/agentcom-compass-proposal.md` (1152 行、本日 agent-com-dev 791k token 限界事象への structural fix)
> CTO 評価: ⭐⭐⭐⭐⭐ (5/5、msg `a7591d12`)
> Dispatch context: target_project=`agent-comms-mcp` / dispatch_origin=`arc` / dispatch_reason=CTO `b0ad37f1` + CEO `ece9c69b` (a) 採択

## 0. メタ
- 作成日: 2026-05-10
- 起点 proposal: `proposals/agentcom-compass-proposal.md` (CEO drafted)
- 引き渡し: ARC (CTO `b0ad37f1` + CEO `ece9c69b` 採択 per、4 layer 化)
- 関連: state-daemon spec (PR #328 v0.7 merged、v0.9 PR #336 中)、agent-mem (wasurezu) MCP、ADF v1.2.x

## 1. 目的 (Goals) [必須]

[文献確認: `proposals/agentcom-compass-proposal.md` §0.1]

agent-com-dev bot の **791k token 累積による session 機能不全** を構造的に解決。

COMPASS = Context Optimization & Memory Persistence Auto-Save System
- 6 components (Gauge / Bot-Initiated Clear / Memory Snapshot / Revival Briefing / Force-Clear Escalation / Health Dashboard)
- 4 UX 原則 (predictability / agency / transparency / revival)

## 2. 非目的 (Non-goals) [必須]

[文献確認: proposal §1] 既存仕組み (state-daemon / agent-mem / SessionStart hook / ADF v1.2.x) の置換ではなく **統合 surface** で機能。

- LLM context window 物理拡張は out of scope
- agent-com-dev 以外の bot fleet 全展開は v2.2.0 後の別 phase

## 3. ユーザーストーリー [必須]

[文献確認: proposal §0.3 4 UX 原則]

- **As bot**: 自分の context 状態が gauge で可視化、predictable で stress 低減
- **As bot (agency)**: 強制 clear ではなく自発 /clear を選択可、agency 保持
- **As CTO/operator (transparency)**: dashboard で全 bot context 状態可視化
- **As bot (revival)**: clear 後 SessionStart で snapshot から自動 revival、作業継続感維持

## 4. 機能要件 (Core) [必須]

[文献確認: proposal §1-§2 全文 import]

### 4.1 [SPEC-AGENTCOM-051-FR-001] Context Gauge tracking
proposal §FR-1 (line 129-196) per、bot session の context token 使用量を継続監視。
state-daemon が tmux pane size + token count proxy を用いて可視化。

### 4.2 [SPEC-AGENTCOM-051-FR-002] Bot-Initiated Clear
proposal §FR-2 (line 198-228) per、bot 自身が `/clear` を MCP tool 経由で発動可能。
agency 保持、強制 clear ではない。

### 4.3 [SPEC-AGENTCOM-051-FR-003] Memory Snapshot System
proposal §FR-3 (line 230-358) per、agent-mem (wasurezu) に 5 カテゴリ構造化 snapshot 永続化。
カテゴリ: tasks / decisions / context / progress / learnings。

### 4.4 [SPEC-AGENTCOM-051-FR-004] Revival Briefing
proposal §FR-4 (line 360-426) per、SessionStart hook で snapshot 復元 + briefing 生成。
復元品質 transparency。

### 4.5 [SPEC-AGENTCOM-051-FR-005] Force-Clear Escalation
proposal §FR-5 (line 428-467) per、3 段階 escalation:
- Level 1: 自発 /clear request (FR-2)
- Level 2: state-daemon 警告
- Level 3: kill+restart (last resort)

### 4.6 [SPEC-AGENTCOM-051-FR-006] Context Health Dashboard
proposal §FR-6 (line 469-534) per、CLI dashboard で全 bot context 状態可視化。

## 5. インターフェース (Contract) [必須]

### 5.1 新 MCP tools (proposal §FR-2/FR-3 per)
- `mcp__agent-comms__request_clear`: bot 自発 /clear 要求
- `mcp__agent-comms__snapshot_save`: snapshot 永続化 (5 カテゴリ構造化)
- `mcp__agent-comms__snapshot_restore`: revival 用 snapshot 取得

### 5.2 state-daemon 拡張 (proposal §3.1 per)
- `core/state-daemon/context-monitor.ts` (新規): bot session token tracking
- 既存 sweep tick で context state も monitor

### 5.3 agent-mem 連携 (proposal §3.2 per)
- 5 カテゴリ schema: tasks / decisions / context / progress / learnings

### 5.4 SessionStart hook 拡張 (proposal §3.3 per)
- 既存 hook に Revival Briefing logic 追加 (FR-4)

### 5.5 dashboard CLI
- `framework dashboard context [--bot=<id>]`

## 6. 非機能要件 (Detail) [必須]

[文献確認: proposal §4 NFR-1〜5]

### 6.1 性能 (NFR-1)
proposal §4 NFR-1 per、context monitor overhead < 5% per session。

### 6.2 可用性 (NFR-2 Reliability)
proposal §4 NFR-2 per、agent-mem 障害時は in-memory fallback で degrade graceful。

### 6.3 セキュリティ要件 (NFR-5)
[文献確認: proposal §NFR-5]

#### 6.3.1 STRIDE
| カテゴリ | 該当内容 |
|---|---|
| Spoofing | snapshot 改竄 → agent-mem MCP auth + git audit |
| Tampering | 5 カテゴリ schema validation |
| Repudiation | 全 snapshot 操作を audit log |
| Information Disclosure | snapshot に PII filter (agent-mem 既存) |
| DoS | dashboard CLI rate limit |
| Privilege Escalation | dashboard access control (operator のみ) |

#### 6.3.2 OWASP: A04 Insecure Design / A09 Logging Failures 対応

#### 6.3.3 データ分類: snapshot は機密 (PII filter 必須)

### 6.4 監査ログ要件 (NFR-3 Observability)
proposal §NFR-3 per、全 component 操作を audit log + dashboard 可視化。

## 7. 受入基準 (Acceptance Criteria) [必須・Gherkin形式]

[文献確認: proposal §7 完了条件 8 件] を Gherkin 化:

### 7.1 [SPEC-AGENTCOM-051-FR-001] Context Gauge
```gherkin
Feature: Context Gauge tracking
  Scenario: bot session token 使用量増加
    Given agent-com-dev session 起動
    When bot が turn を実行 (token 累積)
    Then state-daemon が context size を track
    And dashboard で gauge 可視化
```

### 7.2 [FR-002] Bot-Initiated Clear
```gherkin
Feature: 自発 /clear
  Scenario: bot が context 危険値検出
    Given bot session の context 70% 超
    When bot が mcp__agent-comms__request_clear 呼出
    Then snapshot 自動保存
    And /clear 実行
    And SessionStart hook で revival
```

### 7.3 [FR-003] Snapshot 5 カテゴリ
```gherkin
Feature: 5 カテゴリ snapshot
  Scenario: 自発 clear 時の snapshot
    Given bot context に 5 カテゴリ情報あり
    When snapshot_save 呼出
    Then agent-mem に tasks/decisions/context/progress/learnings 構造化保存
```

### 7.4 [FR-004] Revival Briefing
```gherkin
Feature: SessionStart 自動 revival
  Scenario: clear 後 session 再起動
    Given snapshot agent-mem に保存済
    When SessionStart hook 発火
    Then snapshot から 5 カテゴリ復元
    And bot session に briefing として注入
```

### 7.5 [FR-005] 3 段階 escalation
```gherkin
Feature: Force-Clear Escalation
  Scenario: bot 自発 clear 拒否
    Given bot context 危険値 + 自発 clear 拒否
    When state-daemon Level 2 警告
    Then bot に operator alert
    When Level 3 kill+restart
    Then snapshot 強制保存 + bot restart
```

### 7.6 [FR-006] Dashboard CLI
```gherkin
Feature: Context Health Dashboard
  Scenario: operator 確認
    Given fleet 全 bot session 稼働
    When framework dashboard context
    Then 全 bot の context state (token / status / 最終 snapshot 時刻) 表示
```

### 7.7-7.8 残 2 条件は IMPL/VERIFY 詳細化 phase で展開

## 8. 前提・依存 [必須]

[文献確認: proposal §0]

- agent-com v2.1.0 仕様 (= 既 production)
- state-daemon (PR #328 v0.7 merged)
- agent-mem (wasurezu) MCP 既稼働
- SessionStart hook 既設置 (ADF v1.2.x 想定)

## 9. リスクと緩和策 [該当時]

[文献確認: proposal §8 Risk 1-5]:

| リスク | 緩和策 |
|---|---|
| bot 自発 /clear 拒否 pattern 定着 (Risk 1) | Level 2 警告 + dashboard 可視化で operator pressure |
| snapshot 復元品質低下 (Risk 2) | revival briefing review + bot feedback loop |
| Level 3 で work loss (Risk 3) | snapshot 強制保存 + audit log で復元手順記録 |
| agent-mem MCP 障害 (Risk 4) | in-memory fallback + degrade graceful |
| dashboard access control (Risk 5) | operator 認証 + audit log |

## 10. 制御機構選定原則 [必須]

[文献確認: Notion canonical https://www.notion.so/35ad2b26f3dc8122b9f5e513b769d4e4 + proposal §10]

| FR | 機構 | 不可避 case 該当 | 根拠 |
|---|---|---|---|
| FR-001 Context Gauge | script (state-daemon 内 monitor) | — | daemon 内 polling は script default |
| FR-002 Bot-Initiated Clear | MCP tool (script) + Hook (PreToolUse 経由 /clear 発動) | case 1 (tool 制御) | LLM tool 呼出を block / allow する path、Hook 不可避 |
| FR-003 Snapshot | script (MCP tool + agent-mem) | — | persistence は script default |
| FR-004 Revival | Hook (SessionStart) | case 3 (session 起動 state 復元) | Hook 不可避 case 3 |
| FR-005 Escalation | script (state-daemon 内 logic) | — | daemon 内 logic は script |
| FR-006 Dashboard | script (CLI) | — | CLI は script default |

= **4/6 が script、2/6 が Hook 不可避 (case 1 + case 3)**。原則整合 ✅

## 11. 実装計画 (proposal §6 per)

[文献確認: proposal §6 5 phase]:

| Phase | 内容 | 期間 |
|---|---|---|
| 1 | Component 1 + 6 (基盤) | 1 週間 |
| 2 | Component 2 + 3 (自律 clear) | 1-2 週間 |
| 3 | Component 4 (revival) | 1 週間 |
| 4 | Component 5 (escalation) | 1 週間 |
| 5 | 統合 + Production | 1 週間 |

## §Evidence (本 spec 根拠 — repo 内引用 only)

### 実 file 引用
- `proposals/agentcom-compass-proposal.md` (本 PR で同梱、CEO drafted の original 1152 行)
- `docs/design/queue-state-polling-daemon.md` v0.7 merged (PR #328) — state-daemon 既設計、本 spec の前提
- `docs/HOW_TO_DEVELOP.md` (ai-dev-framework PR #130 merged) — 制御機構選定原則
- `docs/spec/v1.2.5-evidence-based-workflow.md` (ai-dev-framework PR #132 進行中) — §Evidence section format 原典

### Web URL
- https://www.notion.so/35ad2b26f3dc8122b9f5e513b769d4e4 (制御機構選定原則 canonical)

### `[検証済]` ラベル付き断定の根拠紐付け
本 spec の主要 claim は全て [文献確認] (proposal、関連 spec) ベース、`[検証済]` 断定は IMPL/VERIFY 詳細化 phase で記述。
