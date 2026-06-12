#!/bin/bash
# framework-runner.sh — Dev Bot自律タスク取得エンジン
#
# SessionStart hookから呼ばれ、GitHub Issuesからタスクを取得し、
# autonomy.jsonのissueLabels定義に基づいてレベル判定結果を出力する。
# 出力はClaude Codeのコンテキストに注入される。
#
# Usage: framework-runner.sh
# Exit 0 = 正常（結果なしも含む）

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
AUTONOMY_FILE="$PROJECT_DIR/.framework/autonomy.json"

# ─── 前提チェック ───
if ! command -v gh &>/dev/null; then
  echo "[framework-runner] gh CLI not found. Skipping."
  exit 0
fi

if ! gh auth status &>/dev/null 2>&1; then
  echo "[framework-runner] gh not authenticated. Skipping."
  exit 0
fi

if [ ! -f "$AUTONOMY_FILE" ]; then
  echo "[framework-runner] autonomy.json not found. Skipping."
  exit 0
fi

# ─── GitHub Issues 取得 ───
ISSUES_JSON=$(gh issue list --assignee @me --state open --json number,title,labels,body,url --limit 20 2>/dev/null || echo "[]")

if [ "$ISSUES_JSON" = "[]" ] || [ -z "$ISSUES_JSON" ]; then
  echo "[framework-runner] No open issues assigned. Idle."
  exit 0
fi

# ─── autonomy.json でラベル判定 + 優先度ソート ───
node -e "
const fs = require('fs');

try {
  const autonomy = JSON.parse(fs.readFileSync('$AUTONOMY_FILE', 'utf8'));
  const issues = $ISSUES_JSON;

  // Build label → level map
  const labelMap = {};
  for (const [level, def] of Object.entries(autonomy.levels || {})) {
    for (const label of (def.issueLabels || [])) {
      labelMap[label.toLowerCase()] = level;
    }
  }

  const priorityLabels = autonomy.taskSelection?.priorityLabels || { P0: 0, P1: 1, P2: 2 };

  const classified = issues.map(issue => {
    const issueLabels = (issue.labels || []).map(l => (l.name || l).toLowerCase());

    let level = 'notify_then_proceed'; // default
    for (const label of issueLabels) {
      if (labelMap[label] === 'autonomous') { level = 'autonomous'; }
      if (labelMap[label] === 'approval_required') { level = 'approval_required'; break; }
    }

    let priority = 999;
    for (const label of issueLabels) {
      const upper = label.toUpperCase();
      if (priorityLabels[upper] !== undefined) {
        priority = Math.min(priority, priorityLabels[upper]);
      }
    }

    return { number: issue.number, title: issue.title, url: issue.url, labels: issueLabels, level, priority };
  });

  classified.sort((a, b) => a.priority - b.priority || a.number - b.number);

  // Output
  console.log('');
  console.log('============================================');
  console.log('  Framework Runner: ' + classified.length + ' open issue(s)');
  console.log('============================================');

  for (const t of classified.slice(0, 5)) {
    const icon = t.level === 'autonomous' ? '▶' : t.level === 'notify_then_proceed' ? '⏳' : '🔒';
    console.log('  ' + icon + ' #' + t.number + ' [' + t.level + '] ' + t.title);
  }
  if (classified.length > 5) {
    console.log('  ... and ' + (classified.length - 5) + ' more');
  }

  const next = classified[0];
  console.log('');
  console.log('  Next task: #' + next.number + ' ' + next.title);
  console.log('  Autonomy: ' + next.level);
  console.log('  Labels:   ' + next.labels.join(', '));
  console.log('  URL:      ' + next.url);
  console.log('============================================');
} catch (e) {
  console.error('[framework-runner] Error: ' + e.message);
}
" 2>/dev/null || echo "[framework-runner] Classification failed."
