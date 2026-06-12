#!/bin/bash
# post-task.sh — タスク完了後に次タスクを提案
#
# GitHub Issues (SSOT) から次のタスクを取得し、autonomy判定結果を出力する。
# framework-runner.sh を再実行して次タスクを提案する形。
#
# Usage: post-task.sh [completed_task_id]
# Output: 次タスク提案（stdout → Claude Code コンテキスト）

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
COMPLETED_TASK="${1:-}"
RUNNER="$PROJECT_DIR/.claude/hooks/framework-runner.sh"

if [ -n "$COMPLETED_TASK" ]; then
  echo ""
  echo "[完了] タスク: $COMPLETED_TASK"
  echo ""
fi

# framework-runner.sh があればそれを実行（GitHub Issues SSOT）
if [ -x "$RUNNER" ]; then
  exec bash "$RUNNER"
fi

# フォールバック: goals.json から次タスクを取得
GOALS_FILE="$PROJECT_DIR/.framework/goals.json"
AUTONOMY_FILE="$PROJECT_DIR/.framework/autonomy.json"

if [ ! -f "$GOALS_FILE" ]; then
  echo "[post-task] goals.json not found, framework-runner.sh not found. No next task."
  exit 0
fi

NEXT_TASK=$(node -e "
  const fs = require('fs');
  try {
    const goals = JSON.parse(fs.readFileSync('$GOALS_FILE', 'utf8'));
    const backlog = goals.backlog || [];
    for (const status of ['ready', 'pending']) {
      const task = backlog.find(t => t.status === status);
      if (task) { console.log(JSON.stringify(task)); process.exit(0); }
    }
  } catch {}
  process.exit(1);
" 2>/dev/null) || true

if [ -z "$NEXT_TASK" ]; then
  echo "[post-task] バックログに残タスクなし。"
  exit 0
fi

TASK_ID=$(echo "$NEXT_TASK" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).id||'?'))")
TASK_NAME=$(echo "$NEXT_TASK" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).name||'?'))")
TASK_PRIORITY=$(echo "$NEXT_TASK" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).priority||'?'))")
TASK_DESC=$(echo "$NEXT_TASK" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).description||''))")

# autonomy level判定
LEVEL="notify_then_proceed"
if [ -f "$AUTONOMY_FILE" ]; then
  LEVEL=$(node -e "
    const fs = require('fs');
    try {
      const autonomy = JSON.parse(fs.readFileSync('$AUTONOMY_FILE', 'utf8'));
      const task = $NEXT_TASK;
      const name = (task.name || '').toLowerCase();
      const actionMap = {
        bug:'bug_fix', test:'test', refactor:'refactoring', lint:'lint_fix',
        crud:'feature_implementation', api:'api_endpoint', ui:'ui_component',
        db:'db_schema_change', migration:'db_schema_change', security:'security_related'
      };
      let action = 'feature_implementation';
      for (const [kw, act] of Object.entries(actionMap)) {
        if (name.includes(kw)) { action = act; break; }
      }
      for (const [levelName, def] of Object.entries(autonomy.levels || {})) {
        if ((def.actions || []).includes(action)) { console.log(levelName); process.exit(0); }
      }
      console.log('approval_required');
    } catch { console.log('notify_then_proceed'); }
  " 2>/dev/null) || LEVEL="notify_then_proceed"
fi

echo ""
echo "[提案] 次のタスク"
echo "  ID: $TASK_ID"
echo "  名前: $TASK_NAME"
echo "  優先度: $TASK_PRIORITY"
echo "  説明: $TASK_DESC"
echo "  自律レベル: $LEVEL"
echo ""

case "$LEVEL" in
  autonomous)
    echo "  → 自律実行可能。着手して完了後に報告します。"
    ;;
  notify_then_proceed)
    echo "  → 5分以内に[却下]がなければ着手します。"
    ;;
  approval_required)
    echo "  → CTO承認を待ちます。"
    ;;
esac
