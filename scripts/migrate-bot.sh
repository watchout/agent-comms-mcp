#!/bin/bash
# migrate-bot.sh — Switch one bot from legacy Claude Code tmux session to
# hybrid runtime (standalone bun server.ts gateway + run-bot.sh consumer)
# per iyasaka-arc/agent-comms-mcp/specs/review/2026-04-22-hybrid-runtime-migration.md.
#
# Usage:
#   ./scripts/migrate-bot.sh <bot-id>
#   ./scripts/migrate-bot.sh <bot-id> --llm claude   (default)
#   ./scripts/migrate-bot.sh <bot-id> --llm codex    (timeout 180s)
#   ./scripts/migrate-bot.sh <bot-id> --llm gemini   (REJECTED — Phase 2)
#
# Produces two tmux sessions per bot:
#   discord-<bot>-gw      : nohup bun server.ts (Discord Gateway + DB + MCP)
#   discord-<bot>-runbot  : run-bot.sh with LLM_CMD = claude --print | codex
#
# Verification (per spec §3.3): operator runs the 8-item checklist after
# this script exits; on fail, runs rollback-bot.sh <bot-id>.
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────
# arg parsing
# ─────────────────────────────────────────────────────────────────────────
BOT_ID=""
LLM_CHOICE="claude"

while [ $# -gt 0 ]; do
  case "$1" in
    --llm)
      LLM_CHOICE="${2:?--llm requires claude|codex}"
      shift 2
      ;;
    --llm=*)
      LLM_CHOICE="${1#--llm=}"
      shift
      ;;
    *)
      if [ -z "$BOT_ID" ]; then
        BOT_ID="$1"
        shift
      else
        echo "ERROR: unexpected argument '$1'" >&2
        exit 2
      fi
      ;;
  esac
done

[ -n "$BOT_ID" ] || { echo "Usage: migrate-bot.sh <bot-id> [--llm claude|codex]" >&2; exit 2; }

# Phase 1: Gemini is not production-ready (ARC reply-gen smoke 2026-04-22:
# file-scan reply pollution / 50-130s latency / built-in tool conflicts).
# Phase 2 entry condition: Gemini policy-engine wrapper disables filesystem
# tools + Level 1 smoke re-passes.
case "$LLM_CHOICE" in
  claude|codex)
    ;;
  gemini)
    echo "ERROR: Gemini is Phase 2 scope (ARC 2026-04-22 finding: not production-ready)." >&2
    echo "       Phase 1 supports claude (default) and codex only." >&2
    exit 2
    ;;
  *)
    echo "ERROR: unknown --llm value '$LLM_CHOICE' (allowed: claude | codex)" >&2
    exit 2
    ;;
esac

# ─────────────────────────────────────────────────────────────────────────
# bot-registry.txt lookup (ARC Q1 answer: heuristic BOT_DIR is rejected)
# Schema: SESSION|PROJECT_DIR|AGENT_ID|PORT|COMMAND
# ─────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGISTRY="${BOT_REGISTRY:-${SCRIPT_DIR}/bot-registry.txt}"
[ -f "$REGISTRY" ] || { echo "ERROR: bot-registry.txt not found at $REGISTRY" >&2; exit 1; }

REGISTRY_LINE=$(awk -F'|' -v id="$BOT_ID" '!/^#/ && $3==id {print; exit}' "$REGISTRY")
[ -n "$REGISTRY_LINE" ] || { echo "ERROR: bot '$BOT_ID' not found in $REGISTRY (AGENT_ID column)" >&2; exit 1; }

IFS='|' read -r SESSION PROJECT_DIR AGENT_ID PORT _CMD <<< "$REGISTRY_LINE"
BOT_DIR="${PROJECT_DIR/#\~/$HOME}"
[ -d "$BOT_DIR" ] || { echo "ERROR: PROJECT_DIR '$BOT_DIR' does not exist for bot '$BOT_ID'" >&2; exit 1; }
[ -n "$PORT" ] || { echo "ERROR: PORT empty for bot '$BOT_ID'" >&2; exit 1; }

# .mcp.json provides the Discord bot token and state dir (single source of truth)
MCP_JSON="$BOT_DIR/.mcp.json"
[ -f "$MCP_JSON" ] || { echo "ERROR: $MCP_JSON not found" >&2; exit 1; }

DISCORD_BOT_TOKEN=$(jq -r '.mcpServers."agent-comms".env.DISCORD_BOT_TOKEN // empty' "$MCP_JSON")
DISCORD_STATE_DIR=$(jq -r '.mcpServers."agent-comms".env.DISCORD_STATE_DIR // empty' "$MCP_JSON")
[ -n "$DISCORD_BOT_TOKEN" ] || { echo "ERROR: DISCORD_BOT_TOKEN missing in $MCP_JSON" >&2; exit 1; }
[ -n "$DISCORD_STATE_DIR" ] || { echo "ERROR: DISCORD_STATE_DIR missing in $MCP_JSON" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────
# paths + LLM_CMD
# ─────────────────────────────────────────────────────────────────────────
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_TS="$REPO_DIR/server.ts"
RUN_BOT="$REPO_DIR/scripts/run-bot.sh"
SYSPROMPT="$HOME/.claude/skills/_shared/bot-tool-using.txt"
LOG_DIR="$HOME/var/log/agent-com"

[ -f "$SERVER_TS" ] || { echo "ERROR: $SERVER_TS not found" >&2; exit 1; }
[ -f "$RUN_BOT"  ] || { echo "ERROR: $RUN_BOT not found" >&2; exit 1; }
[ -f "$SYSPROMPT" ] || { echo "ERROR: $SYSPROMPT not found (expected per spec §2.3)" >&2; exit 1; }
mkdir -p "$LOG_DIR"

# LLM_CMD per spec §2.2 + Phase 1 update (codex timeout 180)
case "$LLM_CHOICE" in
  claude)
    LLM_CMD="claude --print --append-system-prompt-file $SYSPROMPT --permission-mode bypassPermissions"
    LLM_TIMEOUT_SECONDS=120
    ;;
  codex)
    # ARC spec §2.2 採択値 (Level 1 smoke e1/f1 PASS verbatim).
    # `--dangerously-bypass-approvals-and-sandbox` is required so MCP tool
    # calls do not block on approval prompts. `--ephemeral` prevents
    # session state leaking across bot replies. `--skip-git-repo-check`
    # is needed because bot project dirs are not always at a git root.
    LLM_CMD="codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral"
    LLM_TIMEOUT_SECONDS=180
    ;;
esac

# ─────────────────────────────────────────────────────────────────────────
# step 0: agent-com-dev pre-flight (spec §3.3 special case)
# Self-referential bot: spawning server.ts in agent-comms-mcp/ would run
# uncommitted code from a dirty tree. Refuse to migrate unless the
# workspace is clean and HEAD is on main.
# ─────────────────────────────────────────────────────────────────────────
if [ "$BOT_ID" = "agent-com-dev" ]; then
  cd "$BOT_DIR"
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "ERROR: agent-com-dev migration requires a clean workspace ($BOT_DIR)." >&2
    echo "       Stage / commit / stash before retrying. Run \`git status\` to inspect." >&2
    exit 1
  fi
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ "$branch" != "main" ]; then
    echo "ERROR: agent-com-dev migration requires HEAD on 'main' (currently '$branch')." >&2
    echo "       Switch with \`git checkout main\` and \`git pull\` before retrying." >&2
    exit 1
  fi
  cd - >/dev/null
fi

# ─────────────────────────────────────────────────────────────────────────
# step 1: stop legacy tmux session(s)
# ─────────────────────────────────────────────────────────────────────────
LEGACY_SESSION="${SESSION}"                      # e.g. discord-webb
GW_SESSION="discord-${BOT_ID}-gw"
RUNBOT_SESSION="discord-${BOT_ID}-runbot"

echo "[migrate-bot] $BOT_ID: stopping legacy '$LEGACY_SESSION' and any prior hybrid sessions"
tmux kill-session -t "$LEGACY_SESSION" 2>/dev/null || true
tmux kill-session -t "$GW_SESSION"     2>/dev/null || true
tmux kill-session -t "$RUNBOT_SESSION" 2>/dev/null || true

# also clear any orphan MCP server process still bound to the port
OLD_PID=$(lsof -i :"$PORT" -t 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "[migrate-bot] $BOT_ID: killing orphan on port $PORT (PID $OLD_PID)"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 1
fi

sleep 2  # settle

# ─────────────────────────────────────────────────────────────────────────
# step 2: launch gateway (server.ts)
# tmux new-session + nohup + < /dev/null redirect is required per ARC's
# 2026-04-22 verification: pane pty stdio EOF triggers StdioServerTransport
# silent exit. `& wait` keeps the tmux child alive for log tailing.
# ─────────────────────────────────────────────────────────────────────────
echo "[migrate-bot] $BOT_ID: launching gateway session '$GW_SESSION'"
tmux new-session -d -s "$GW_SESSION" -c "$BOT_DIR" \
  "nohup env \
     AGENT_ID='$AGENT_ID' \
     DATABASE_URL='postgresql://localhost/agent_comms' \
     WEBHOOK_PORT='$PORT' \
     DISCORD_BOT_TOKEN='$DISCORD_BOT_TOKEN' \
     DISCORD_STATE_DIR='$DISCORD_STATE_DIR' \
     bun run '$SERVER_TS' < /dev/null > '$LOG_DIR/$BOT_ID-gw.log' 2>&1 & wait"

# wait for Discord gateway handshake (Level 3 v2 measured 4-5s, 10s headroom)
sleep 10

# sanity: log file should exist and have non-zero size
[ -s "$LOG_DIR/$BOT_ID-gw.log" ] || echo "[migrate-bot] WARN: $LOG_DIR/$BOT_ID-gw.log is empty after 10s"

# ─────────────────────────────────────────────────────────────────────────
# step 3: launch run-bot.sh consumer
# ─────────────────────────────────────────────────────────────────────────
echo "[migrate-bot] $BOT_ID: launching runbot session '$RUNBOT_SESSION' (LLM=$LLM_CHOICE, timeout=${LLM_TIMEOUT_SECONDS}s)"
tmux new-session -d -s "$RUNBOT_SESSION" -c "$BOT_DIR" \
  "nohup env \
     DATABASE_URL='postgresql://localhost/agent_comms' \
     LLM_CMD='$LLM_CMD' \
     AGENT_COM_BUS_WAIT_SECONDS=5 \
     LLM_TIMEOUT_SECONDS='$LLM_TIMEOUT_SECONDS' \
     '$RUN_BOT' '$BOT_ID' < /dev/null > '$LOG_DIR/$BOT_ID-runbot.log' 2>&1 & wait"

sleep 5

# ─────────────────────────────────────────────────────────────────────────
# step 4: report + rate-limit wait
# ─────────────────────────────────────────────────────────────────────────
cat <<EOS
[migrate-bot] $BOT_ID migration dispatched.
  bot_dir:           $BOT_DIR
  port:              $PORT
  llm:               $LLM_CHOICE (timeout ${LLM_TIMEOUT_SECONDS}s)
  gw session:        $GW_SESSION
  runbot session:    $RUNBOT_SESSION
  gw log:            $LOG_DIR/$BOT_ID-gw.log
  runbot log:        $LOG_DIR/$BOT_ID-runbot.log

Run per-bot 8-item verification checklist (spec §3.3) before moving on:
  1. tmux ls | grep 'discord-$BOT_ID-'           (2 sessions alive)
  2. grep 'connected as'        $LOG_DIR/$BOT_ID-gw.log
  3. grep 'run-bot.*started'    $LOG_DIR/$BOT_ID-runbot.log
  4. psql -c "SELECT last_seen_at FROM agents WHERE agent_id='$BOT_ID'"   (<60s fresh)
  5. Send test message → reply within 2 min
  6. Discord UI shows bot online (10-20 min, rate-limit aware)
  7. MCP tool call smoke (e.g., 'agent-memory で検索して')
  8. On fail: ./scripts/rollback-bot.sh $BOT_ID

Discord presence rate limit: sleep 600 before migrating the next bot.
EOS
