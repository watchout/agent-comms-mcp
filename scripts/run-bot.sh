#!/bin/bash
# run-bot.sh — LLM-agnostic event-driven bot runner (spec §5.3 / §5.4 / §13.5.1).
#
# End-to-end loop (spec §5.3, PR #218/#221):
#   1. AGENT_ID validation + consumer 排他 (PID kill -0) + PID file 書込
#   2. SIGUSR1 (flag-tracked) / SIGTERM+SIGINT (SHUTDOWN flag) / EXIT trap
#   3. heartbeat background fork (30s 間隔、EXIT で kill)
#   4. signal coalescing drain loop: waiting=0 まで内側 while で連続 next
#      - drain 内 consume 前 SHUTDOWN check → graceful shutdown
#      - reply_chain self-count >= MAX_SELF_IN_CHAIN → fail LOOP_DETECTED
#      - LLM は timeout wrap + CORE_RULES + USER_RULES を prompt 先頭に
#      - LLM 空 / non-zero exit → fail LLM_FAILED (spec §5.3、v2.1.0 では暗黙 skip 廃止)
#      - send retry backoff 2/4/8s、max 3 回、上限到達 → fail SEND_FAILED_AFTER_N_RETRIES
#   5. drain 後 SIGUSR1 interrupt 可能な background sleep + wait (PR #217 cycle 2 fix 継承)
#
# Environment:
#   LLM_CMD                    — LLM CLI command (default: claude --print)
#   AGENT_COM_BUS_WAIT_SECONDS — polling fallback interval (default 30)
#   LLM_TIMEOUT_SECONDS        — per-call LLM timeout (default 120)
#   MAX_SELF_IN_CHAIN          — bot-to-bot loop threshold (default 3)
#   AGENT_COM_SYSTEM_PROMPT    — USER_RULES, appended after CORE_RULES
#
# Signals:
#   SIGUSR1         — wake up and drain the queue (flag-tracked, no lost wake-up)
#   SIGTERM/SIGINT  — graceful shutdown: finish current LLM/send, then exit 0
#   EXIT            — remove PID file + kill heartbeat background
#
# Usage:
#   LLM_CMD="claude --print" ./scripts/run-bot.sh <agent-id>
#   LLM_CMD="codex --quiet"  ./scripts/run-bot.sh <agent-id>
#   LLM_CMD="echo test"      ./scripts/run-bot.sh <agent-id>   # smoke-test
set -euo pipefail

AGENT_ID="${1:?Usage: run-bot.sh <agent-id>}"

# ── (9) AGENT_ID validation (spec §5.4) ─────────────────────────────────────
# Pinned regex: ^[a-z0-9][a-z0-9_-]{0,63}$ — first char alnum, then alnum/_/-,
# total 1..64 chars. Matches the CLI `agent-com register` validator so a bot
# spawned via run-bot.sh cannot land on a name that `register` rejects.
if ! [[ "$AGENT_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
  echo "[run-bot] ERROR: invalid AGENT_ID '$AGENT_ID' (must match ^[a-z0-9][a-z0-9_-]{0,63}$)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="/tmp/agent-com-${AGENT_ID}.pid"
WAIT_SECONDS="${AGENT_COM_BUS_WAIT_SECONDS:-30}"
LLM_CMD="${LLM_CMD:-claude --print}"
LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-120}"
MAX_SELF_IN_CHAIN="${MAX_SELF_IN_CHAIN:-3}"
MAX_SEND_RETRIES=3

# ── (8) consumer 排他 (PID kill -0 alive check) ─────────────────────────────
# Stale PID files after a crash are overwritten silently; a PID that is still
# alive rejects the new runner so two bots never share the same queue slot.
if [ -f "$PID_FILE" ]; then
  existing_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "[run-bot] ERROR: another run-bot.sh is running for ${AGENT_ID} (PID ${existing_pid}). Exit." >&2
    exit 1
  fi
  echo "[run-bot] stale PID file (${existing_pid:-unknown}) — overwriting"
fi

echo $$ > "$PID_FILE"

# ── (10) LLM prompt template: CORE_RULES + USER_RULES ───────────────────────
# CORE_RULES are always prepended; USER_RULES come from AGENT_COM_SYSTEM_PROMPT
# and can customise without removing the mandatory invariants (mention /
# 1900-char cap / no AI-disclaimer).
CORE_RULES=$'CORE_RULES (MUST FOLLOW):\n- 返信時は必ず元送信者 agent_id を @mention として含めること\n- 1 メッセージ 1900 文字以下 (Discord 上限に合わせた safety cap)\n- AI disclaimer 禁止 (例: "I am an AI", "as an AI language model")'
USER_RULES="${AGENT_COM_SYSTEM_PROMPT:-}"

# ── Flag-tracked signals ────────────────────────────────────────────────────
# SIGNAL_RECEIVED / SHUTDOWN are both shell integer flags so the trap handlers
# stay signal-safe (no re-entrant cli calls inside a handler).
SIGNAL_RECEIVED=0
SHUTDOWN=0
trap 'SIGNAL_RECEIVED=1' USR1
trap 'SHUTDOWN=1' TERM INT

# ── (7) heartbeat background fork (spec §5.3) ───────────────────────────────
# Fire `agent-com heartbeat` every 30s so the daemon heartbeat monitor does
# not mark this bot `disconnected` while the LLM is blocking on a long call.
# EXIT trap kills the background process so a crashed run-bot.sh does not
# leave heartbeat orphans.
(
  while true; do
    AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" heartbeat >/dev/null 2>&1 || true
    sleep 30
  done
) &
HEARTBEAT_PID=$!

cleanup() {
  rm -f "$PID_FILE"
  if [ -n "${HEARTBEAT_PID:-}" ]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[run-bot] ${AGENT_ID} started (PID $$, heartbeat=${HEARTBEAT_PID}, LLM=${LLM_CMD}, timeout=${LLM_TIMEOUT_SECONDS}s, wait=${WAIT_SECONDS}s)"

# ── main loop ───────────────────────────────────────────────────────────────
while true; do
  # (2) SHUTDOWN check BEFORE consuming a new message so in-flight work is
  # preserved and a fresh `next` is not popped when we are already terminating.
  if [ "$SHUTDOWN" = "1" ]; then
    echo "[run-bot] shutdown signal received, exiting"
    exit 0
  fi

  # (1) signal coalescing drain loop: one SIGUSR1 may cover several pending
  # rows (inbound burst) — drain until waiting=0 before going back to sleep.
  while true; do
    if [ "$SHUTDOWN" = "1" ]; then
      echo "[run-bot] shutdown during drain, exiting"
      exit 0
    fi

    msg=$(AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" next 2>/dev/null || echo '{"waiting":0}')
    waiting=$(echo "$msg" | (command -v jq >/dev/null && jq -r '.waiting // 0') 2>/dev/null || echo 0)

    if [ "${waiting:-0}" = "0" ]; then
      break  # drain complete
    fi

    content=$(echo "$msg" | jq -r '.content // ""')
    reply_chain=$(echo "$msg" | jq -r '.reply_chain // "[]"')
    message_id=$(echo "$msg" | jq -r '.message_id // ""')
    from=$(echo "$msg" | jq -r '.from // ""')

    echo "[run-bot] message from ${from} (waiting=${waiting}, message_id=${message_id})"

    # (5) bot-to-bot loop detection (spec §5.3、§11 LOOP_DETECTED)
    # The reply_chain emitted by `next` is a JSON array of {from,content,...}
    # objects. If this bot's own agent_id appears MAX_SELF_IN_CHAIN times or
    # more we assume an infinite reply loop and fail fast instead of calling
    # the LLM.
    self_count=$(echo "$msg" | jq --arg a "$AGENT_ID" '[.reply_chain[]? | select(.from == $a)] | length' 2>/dev/null || echo 0)
    if [ "${self_count:-0}" -ge "$MAX_SELF_IN_CHAIN" ]; then
      echo "[run-bot] LOOP_DETECTED (self=${self_count} >= ${MAX_SELF_IN_CHAIN}), failing"
      AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" fail \
        --message-id "$message_id" --reason LOOP_DETECTED >/dev/null 2>&1 || true
      continue
    fi

    # (10) build prompt: CORE_RULES + USER_RULES + inbound context
    full_context="${CORE_RULES}"
    if [ -n "$USER_RULES" ]; then
      full_context="${full_context}

USER_RULES:
${USER_RULES}"
    fi
    full_context="${full_context}

From: ${from}
Reply chain: ${reply_chain}

Message: ${content}"

    # (6) LLM invocation with timeout. `$LLM_CMD` is unquoted so multi-token
    # commands expand into argv (e.g. `claude --print` → argv 2 個).
    # `timeout` exits 124 on timeout; both that and any non-zero exit are
    # treated as LLM_FAILED per spec §5.3.
    llm_exit=0
    response=$(echo -e "$full_context" | timeout "$LLM_TIMEOUT_SECONDS" $LLM_CMD 2>/dev/null) || llm_exit=$?

    # (3) LLM 失敗 → 明示 fail LLM_FAILED (暗黙 skip は v2.1.0 で廃止、
    # 実装は next handler 側の IMPLICIT_ABANDON へ移管済み)
    if [ "$llm_exit" -ne 0 ] || [ -z "$response" ]; then
      echo "[run-bot] LLM failed (exit=${llm_exit}, empty=$([ -z "$response" ] && echo y || echo n)), fail LLM_FAILED"
      AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" fail \
        --message-id "$message_id" --reason LLM_FAILED >/dev/null 2>&1 || true
      continue
    fi

    # (4) send with exponential backoff retry (2/4/8s) + failure → fail CLI.
    # The CLI's send command is transactional — it will either commit the
    # reply and clear current_message_id, or leave both untouched. We retry
    # up to MAX_SEND_RETRIES times before declaring permanent failure.
    send_ok=0
    for attempt in 1 2 3; do
      if AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" send \
            --content "$response" \
            --reply-to "$message_id" \
            --mentions "$from" >/dev/null 2>&1; then
        send_ok=1
        echo "[run-bot] replied to ${from} (attempt ${attempt})"
        break
      fi
      case $attempt in
        1) sleep 2 ;;
        2) sleep 4 ;;
        3) sleep 8 ;;
      esac
    done

    if [ "$send_ok" != "1" ]; then
      echo "[run-bot] send failed after ${MAX_SEND_RETRIES} retries, fail SEND_FAILED_AFTER_N_RETRIES"
      AGENT_ID="$AGENT_ID" bun "$PROJECT_DIR/cli/index.ts" fail \
        --message-id "$message_id" --reason SEND_FAILED_AFTER_N_RETRIES >/dev/null 2>&1 || true
    fi
  done
  # ── end drain loop ────────────────────────────────────────────────────────

  # If SIGUSR1 fired during the drain, skip the sleep and restart immediately.
  # This closes the lost-wake-up window the auditor flagged in PR #217 cycle 1.
  if [ "$SIGNAL_RECEIVED" = "1" ]; then
    SIGNAL_RECEIVED=0
    continue
  fi

  # Post-drain SHUTDOWN check so a TERM during the last LLM call exits before
  # we block on sleep.
  if [ "$SHUTDOWN" = "1" ]; then
    echo "[run-bot] shutdown after drain, exiting"
    exit 0
  fi

  # Background sleep so SIGUSR1 / SIGTERM can interrupt `wait` (a foreground
  # `sleep` is not interrupted by trapped signals in bash). On timeout `wait`
  # returns 0; on signal the trap sets the flag and `wait` returns non-zero.
  sleep "$WAIT_SECONDS" &
  SLEEP_PID=$!
  wait "$SLEEP_PID" 2>/dev/null || true

  if [ "$SIGNAL_RECEIVED" = "1" ] || [ "$SHUTDOWN" = "1" ]; then
    # Wait was interrupted. Kill the pending sleep to avoid a leaked process
    # per interrupted iteration and reset the wake flag (SHUTDOWN is evaluated
    # at the top of the next iteration).
    kill "$SLEEP_PID" 2>/dev/null || true
    wait "$SLEEP_PID" 2>/dev/null || true
    SIGNAL_RECEIVED=0
  fi
done
