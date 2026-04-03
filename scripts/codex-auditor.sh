#!/usr/bin/env bash
# codex-auditor.sh — Cron-based deep review of Dev Bot [報告] messages using Codex CLI
# Usage: ./scripts/codex-auditor.sh
# Cron:  * * * * * /path/to/scripts/codex-auditor.sh >> /tmp/codex-auditor.log 2>&1

set -euo pipefail

# Ensure PATH includes homebrew (cron environment is minimal)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Load environment variables from .env (keeps secrets out of crontab)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
REVIEWED_FILE="${REVIEWED_FILE:-/tmp/codex-auditor-reviewed.txt}"
CODEX_TIMEOUT="${CODEX_TIMEOUT:-60}"
LOG_TAG="[codex-auditor]"

# Ensure reviewed file exists
touch "$REVIEWED_FILE"

# --- Step 1: Fetch recent [報告] messages from DB (last 5 minutes) ---
REPORTS=$(psql "$DATABASE_URL" -tA -F $'\t' -c "
  SELECT id, author_id, channel_id, content,
         coalesce(metadata->>'discord_channel_id', channel_id) as discord_channel,
         coalesce(metadata->>'discord_message_id', '') as discord_message
  FROM agent_messages
  WHERE content ~ '\[報告[:：]?[^\]]*\]'
    AND created_at > now() - interval '5 minutes'
  ORDER BY created_at ASC
" 2>/dev/null || echo "")

if [ -z "$REPORTS" ]; then
  exit 0
fi

# --- Step 2: Process each report ---
while IFS=$'\t' read -r MSG_ID AUTHOR_ID CHANNEL_ID CONTENT DISCORD_CHANNEL DISCORD_MESSAGE; do
  # Skip if already reviewed
  if grep -qF "$MSG_ID" "$REVIEWED_FILE" 2>/dev/null; then
    continue
  fi

  echo "${LOG_TAG} Reviewing report from ${AUTHOR_ID}: ${CONTENT:0:80}..." >&2

  # Write content to temp file for codex
  TEMP_FILE=$(mktemp /tmp/codex-review-XXXXXX.txt)
  cat > "$TEMP_FILE" <<REVIEW_EOF
以下のDev Botからの[報告]メッセージを精密レビューしてください。

送信者: ${AUTHOR_ID}
チャンネル: ${CHANNEL_ID}
内容:
${CONTENT}

レビュー観点:
1. 報告の完全性（何をしたか、何が変わったか、次のステップ）
2. SSOT準拠（プロジェクト仕様に沿っているか）
3. 品質シグナル（劣化の兆候がないか）
4. セキュリティ（機密情報の漏洩、危険な操作がないか）

レビュー結果を日本語で200文字以内で返してください。先頭に絵文字: ✅(良好) ⚠️(懸念) ❌(問題)
REVIEW_EOF

  # --- Step 3: Run Codex CLI for deep review ---
  REVIEW_RESULT=""
  if REVIEW_RESULT=$(timeout "${CODEX_TIMEOUT}" codex exec \
    --full-auto \
    "$(cat "$TEMP_FILE")" 2>/dev/null); then
    echo "${LOG_TAG} Review generated for ${MSG_ID}" >&2
  else
    echo "${LOG_TAG} Codex review failed or timed out for ${MSG_ID}" >&2
    rm -f "$TEMP_FILE"
    # Record as reviewed to avoid retry loop
    echo "$MSG_ID" >> "$REVIEWED_FILE"
    continue
  fi

  rm -f "$TEMP_FILE"

  # --- Step 4: Post review via DB + Discord REST API ---
  if [ -n "$REVIEW_RESULT" ] && [ -n "$DISCORD_CHANNEL" ]; then
    REVIEW_CONTENT="[Codex Auditor] ${REVIEW_RESULT}"
    REVIEW_CONTENT="${REVIEW_CONTENT:0:2000}"

    # Insert to DB
    MSG_UUID=$(psql "$DATABASE_URL" -tA -c "
      INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata)
      VALUES (
        gen_random_uuid(),
        '${DISCORD_CHANNEL}',
        'codex-auditor',
        \$review\$${REVIEW_CONTENT}\$review\$,
        'chat',
        jsonb_build_object(
          'source', 'codex-auditor',
          'reviewed_message_id', '${MSG_ID}',
          'to', '${AUTHOR_ID}'
        )
      ) RETURNING id
    " 2>/dev/null)

    if [ -n "$MSG_UUID" ]; then
      echo "${LOG_TAG} Review saved to DB (${MSG_UUID})" >&2
      # Post to Discord via REST API using Dev Auditor bot token
      DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
      if [ -n "$DISCORD_BOT_TOKEN" ]; then
        curl -s -X POST "https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages" \
          -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
          -H "Content-Type: application/json" \
          -d "{\"content\": $(echo "$REVIEW_CONTENT" | jq -Rs .)}" \
          > /dev/null 2>&1 \
          && echo "${LOG_TAG} Review posted to Discord ${DISCORD_CHANNEL}" >&2 \
          || echo "${LOG_TAG} Discord post failed (non-fatal)" >&2
      else
        echo "${LOG_TAG} No DISCORD_BOT_TOKEN, skipping Discord post" >&2
      fi
    else
      echo "${LOG_TAG} Failed to save review to DB" >&2
    fi
  fi

  # Record as reviewed
  echo "$MSG_ID" >> "$REVIEWED_FILE"

done <<< "$REPORTS"

# --- Cleanup: keep only last 1000 reviewed IDs ---
if [ "$(wc -l < "$REVIEWED_FILE")" -gt 1000 ]; then
  tail -500 "$REVIEWED_FILE" > "${REVIEWED_FILE}.tmp"
  mv "${REVIEWED_FILE}.tmp" "$REVIEWED_FILE"
fi
