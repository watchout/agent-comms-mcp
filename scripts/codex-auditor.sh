#!/usr/bin/env bash
# codex-auditor.sh — Cron-based deep review of Dev Bot [報告] messages using Codex CLI
# Usage: DATABASE_URL=postgresql://localhost/agent_comms DISCORD_BOT_TOKEN=xxx ./scripts/codex-auditor.sh
# Cron:  * * * * * DATABASE_URL=postgresql://localhost/agent_comms DISCORD_BOT_TOKEN=xxx /path/to/scripts/codex-auditor.sh 2>> /tmp/codex-auditor.log

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
REVIEWED_FILE="${REVIEWED_FILE:-/tmp/codex-auditor-reviewed.txt}"
CODEX_TIMEOUT="${CODEX_TIMEOUT:-60}"
AUDIT_LOG_CHANNEL="1486097726784540813"
CTO_CHANNEL="1485598480553611357"
LOG_TAG="[codex-auditor]"

# Ensure reviewed file exists
touch "$REVIEWED_FILE"

# --- Discord REST API helper ---
post_to_discord() {
  local channel_id="$1"
  local content="$2"
  local reply_to="${3:-}"

  if [ -z "$DISCORD_BOT_TOKEN" ]; then
    echo "${LOG_TAG} Would post to ${channel_id}: ${content:0:80}..." >&2
    return 0
  fi

  local body
  if [ -n "$reply_to" ]; then
    body=$(jq -n \
      --arg content "$content" \
      --arg msg_id "$reply_to" \
      '{content: $content, allowed_mentions: {parse: ["users", "roles"]}, message_reference: {message_id: $msg_id}}')
  else
    body=$(jq -n \
      --arg content "$content" \
      '{content: $content, allowed_mentions: {parse: ["users", "roles"]}}')
  fi

  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://discord.com/api/v10/channels/${channel_id}/messages" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body" || echo "000"
}

# --- Step 1: Fetch recent [報告] messages from DB (last 5 minutes) ---
REPORTS=$(psql "$DATABASE_URL" -tA -F $'\t' -c "
  SELECT id, author_id, channel_id, content,
         coalesce(metadata->>'discord_channel_id', '') as discord_channel,
         coalesce(metadata->>'discord_message_id', '') as discord_message
  FROM agent_messages
  WHERE content ~ '\[報告[:：]?[^\]]*\]'
    AND created_at > now() - interval '5 minutes'
    AND author_id NOT IN ('codex-auditor', 'api-auditor', 'api-advisor')
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
    --dangerously-bypass-approvals-and-sandbox \
    "$(cat "$TEMP_FILE")" 2>/dev/null); then
    echo "${LOG_TAG} Review generated for ${MSG_ID}" >&2
  else
    echo "${LOG_TAG} Codex review failed or timed out for ${MSG_ID}" >&2
    rm -f "$TEMP_FILE"
    echo "$MSG_ID" >> "$REVIEWED_FILE"
    continue
  fi

  rm -f "$TEMP_FILE"

  if [ -z "$REVIEW_RESULT" ]; then
    echo "$MSG_ID" >> "$REVIEWED_FILE"
    continue
  fi

  REVIEW_CONTENT="[Codex Auditor] ${REVIEW_RESULT}"
  REVIEW_CONTENT="${REVIEW_CONTENT:0:2000}"

  # --- Step 4: Post review to source Discord channel (direct reply) ---
  if [ -n "$DISCORD_CHANNEL" ]; then
    STATUS=$(post_to_discord "$DISCORD_CHANNEL" "$REVIEW_CONTENT" "$DISCORD_MESSAGE")
    echo "${LOG_TAG} Posted to source channel ${DISCORD_CHANNEL}: HTTP ${STATUS}" >&2
  fi

  # --- Step 5: Post to #audit-log ---
  AUDIT_CONTENT="[Codex Auditor] ${AUTHOR_ID}の報告レビュー (${CHANNEL_ID}):"$'\n'"${REVIEW_RESULT}"
  AUDIT_CONTENT="${AUDIT_CONTENT:0:2000}"
  STATUS=$(post_to_discord "$AUDIT_LOG_CHANNEL" "$AUDIT_CONTENT")
  echo "${LOG_TAG} Posted to #audit-log: HTTP ${STATUS}" >&2

  # --- Step 6: Notify CTO if warning or problem detected ---
  if echo "$REVIEW_RESULT" | grep -qE '^[⚠️❌]|⚠️|❌'; then
    CTO_CONTENT="[Codex Auditor 警告] ${AUTHOR_ID}の報告に懸念事項:"$'\n'"${REVIEW_RESULT}"
    CTO_CONTENT="${CTO_CONTENT:0:2000}"
    STATUS=$(post_to_discord "$CTO_CHANNEL" "$CTO_CONTENT")
    echo "${LOG_TAG} CTO notified: HTTP ${STATUS}" >&2
  fi

  # --- Step 7: Also persist to DB ---
  psql "$DATABASE_URL" -c "
    INSERT INTO agent_messages (id, channel_id, author_id, content, message_type, metadata)
    VALUES (
      gen_random_uuid(),
      '${DISCORD_CHANNEL:-${CHANNEL_ID}}',
      'codex-auditor',
      \$review\$${REVIEW_CONTENT}\$review\$,
      'chat',
      jsonb_build_object(
        'source', 'codex-auditor',
        'reviewed_message_id', '${MSG_ID}',
        'to', '${AUTHOR_ID}'
      )
    )
  " 2>/dev/null && echo "${LOG_TAG} Review persisted to DB" >&2 \
    || echo "${LOG_TAG} Failed to persist review to DB" >&2

  # Record as reviewed
  echo "$MSG_ID" >> "$REVIEWED_FILE"

done <<< "$REPORTS"

# --- Cleanup: keep only last 1000 reviewed IDs ---
if [ "$(wc -l < "$REVIEWED_FILE")" -gt 1000 ]; then
  tail -500 "$REVIEWED_FILE" > "${REVIEWED_FILE}.tmp"
  mv "${REVIEWED_FILE}.tmp" "$REVIEWED_FILE"
fi
