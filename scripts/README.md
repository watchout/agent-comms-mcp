# On-Demand Bot Launcher

Dev Botをオンデマンドで起動・停止するスクリプト。cronで1分間隔ポーリング。

## セットアップ

### 1. スクリプトに実行権限を付与
```bash
chmod +x scripts/on-demand-launcher.sh scripts/on-demand-shutdown.sh
```

### 2. cron設定
```bash
crontab -e
```

```cron
# WBS Dev — 未読チェック+起動（毎分）
* * * * * BOT_NAME=discord-wbs BOT_DIR=~/Developer/wbs AGENT_ID=wbs-dev DATABASE_URL=postgresql://localhost/agent_comms /path/to/agent-comms-mcp/scripts/on-demand-launcher.sh 2>> /tmp/on-demand-launcher.log

# WBS Dev — 完了検知+停止（毎分）
* * * * * BOT_NAME=discord-wbs /path/to/agent-comms-mcp/scripts/on-demand-shutdown.sh 2>> /tmp/on-demand-shutdown.log
```

### 複数botの例
```cron
# Hotel Dev
* * * * * BOT_NAME=discord-hotel BOT_DIR=~/Developer/hotel AGENT_ID=hotel-dev DATABASE_URL=postgresql://localhost/agent_comms /path/to/scripts/on-demand-launcher.sh 2>> /tmp/on-demand-launcher.log
* * * * * BOT_NAME=discord-hotel /path/to/scripts/on-demand-shutdown.sh 2>> /tmp/on-demand-shutdown.log

# Haishin Dev
* * * * * BOT_NAME=discord-haishin BOT_DIR=~/Developer/haishin AGENT_ID=haishin-dev DATABASE_URL=postgresql://localhost/agent_comms /path/to/scripts/on-demand-launcher.sh 2>> /tmp/on-demand-launcher.log
* * * * * BOT_NAME=discord-haishin /path/to/scripts/on-demand-shutdown.sh 2>> /tmp/on-demand-shutdown.log
```

## 動作フロー

### Launcher
```
cron (毎分)
  → tmuxセッション存在確認
  → 存在する → 何もしない
  → 存在しない → DBで未読メッセージ確認（直近10分）
    → 未読あり → tmuxセッション作成 + Claude Code起動
    → 未読なし → 何もしない
```

### Shutdown
```
cron (毎分)
  → tmuxセッション存在確認
  → 存在しない → 何もしない
  → 存在する → 最新出力を確認
    → [報告:完了] or [報告:失敗] 検出
      → 初回検出 → タイムスタンプ記録、次回まで待機
      → IDLE_TIMEOUT(5分)経過 → tmux kill-session
    → 完了シグナルなし → 何もしない
```

## 環境変数

### Launcher
| 変数 | 必須 | 説明 | デフォルト |
|------|------|------|-----------|
| BOT_NAME | Yes | tmuxセッション名 | — |
| BOT_DIR | Yes | プロジェクトディレクトリ | — |
| AGENT_ID | Yes | agent-commsのエージェントID | — |
| DATABASE_URL | No | PostgreSQL接続文字列 | postgresql://localhost/agent_comms |
| CLAUDE_CMD | No | Claude Code起動コマンド | claude --dangerously-load-... |

### Shutdown
| 変数 | 必須 | 説明 | デフォルト |
|------|------|------|-----------|
| BOT_NAME | Yes | tmuxセッション名 | — |
| IDLE_TIMEOUT | No | 完了後の待機時間（秒） | 300 (5分) |
| STATE_DIR | No | 状態ファイル保存先 | /tmp/on-demand-state |
