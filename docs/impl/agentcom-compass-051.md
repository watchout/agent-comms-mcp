---
id: IMPL-AGENTCOM-051
status: Draft
traces:
  spec: [SPEC-AGENTCOM-051]
  verify: [VERIFY-AGENTCOM-051]
  ops: [OPS-AGENTCOM-051]
---

# IMPL: SPEC-AGENTCOM-051 COMPASS (skeleton)

> [文献確認: `docs/spec/agentcom-compass-051.md`、`proposals/agentcom-compass-proposal.md`]
> 本 IMPL は **skeleton**、phase per dev-bot が詳細追記。

## 0. 対応する SPEC
SPEC-AGENTCOM-051 FR-001〜006 の impl 詳細。

## 1. 配置図

### 1.1 新規ファイル
- `core/state-daemon/context-monitor.ts` (FR-001 Gauge)
- `core/compass/snapshot.ts` (FR-003 Memory Snapshot)
- `core/compass/revival.ts` (FR-004 Revival Briefing)
- `core/compass/escalation.ts` (FR-005 Force-Clear)
- `src/cli/commands/dashboard/context.ts` (FR-006 Dashboard)
- `src/mcp/tools/request-clear.ts` (FR-002 MCP)
- `src/mcp/tools/snapshot-save.ts` / `snapshot-restore.ts` (FR-003 MCP)
- `templates/project/.claude/scripts/inject-spec-context.sh` 拡張 (Revival、ADF v1.2.1 連携)

### 1.2 変更ファイル
- `core/state-daemon/index.ts` (context-monitor 統合)
- `core/agent-mem-client.ts` (5 カテゴリ schema)
- `bin/state-daemon.ts` (escalation logic)

## 2. 型定義

```ts
// core/compass/types.ts
export type SnapshotCategory = 'tasks' | 'decisions' | 'context' | 'progress' | 'learnings';

export interface ContextSnapshot {
  bot_id: string;
  taken_at: string;
  trigger: 'self_clear' | 'force_level_2' | 'force_level_3';
  categories: Record<SnapshotCategory, string>;
}

export interface ContextGauge {
  bot_id: string;
  token_estimate: number;
  threshold_warning: number;
  threshold_critical: number;
  last_updated: string;
}

export interface RevivalBriefing {
  bot_id: string;
  snapshot_ref: string;
  briefing_text: string;
  restored_at: string;
}
```

## 3. シーケンス
- gauge: state-daemon sweep tick (30s) + tmux pane size + token proxy → metrics + dashboard
- snapshot: bot 自発 clear → snapshot_save MCP → agent-mem 5 カテゴリ → /clear 実行
- revival: SessionStart hook → snapshot_restore → briefing 生成 → bot context 注入

## 4. エラー処理
- agent-mem 障害 → in-memory fallback (NFR-2)
- snapshot 永続化失敗 → bot に warn + retry
- escalation Level 3 失敗 → operator alert + manual intervention

## 5. 既存コードとの取り合い
- 既存 state-daemon 拡張 (PR #328 v0.7 merged base)
- agent-mem (wasurezu) MCP 既稼働、5 カテゴリ schema 拡張のみ
- ADF v1.2.1 SessionStart hook と integrate (Revival)

## 6. ログ出力
- 全 component 操作を `.framework/audit/compass-{date}.jsonl` に記録
- dashboard が audit log を集計表示

## 7. 設定値

| env var | default | 用途 |
|---|---|---|
| `COMPASS_THRESHOLD_WARNING` | 70% | Gauge warning 閾値 |
| `COMPASS_THRESHOLD_CRITICAL` | 90% | escalation 開始 |
| `COMPASS_SNAPSHOT_RETENTION_DAYS` | 30 | snapshot 保持 |

## 8. セキュリティ
- snapshot に PII filter (agent-mem 既存 logic 継承)
- dashboard CLI は operator 認証必須

## 9. トレース

| FR | impl files |
|---|---|
| FR-001 | `context-monitor.ts` + `state-daemon/index.ts` 拡張 |
| FR-002 | `request-clear.ts` (MCP) + Hook 連携 |
| FR-003 | `snapshot.ts` + agent-mem 5 カテゴリ |
| FR-004 | `revival.ts` + SessionStart hook 拡張 |
| FR-005 | `escalation.ts` + state-daemon |
| FR-006 | `cli/commands/dashboard/context.ts` |

## §Evidence (skeleton 根拠)

### 実 file 引用
- `docs/spec/agentcom-compass-051.md` SPEC-AGENTCOM-051
- `proposals/agentcom-compass-proposal.md` (CEO drafted)
- `docs/design/queue-state-polling-daemon.md` (state-daemon spec、context-monitor 統合先)
