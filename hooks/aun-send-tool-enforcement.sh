#!/usr/bin/env bash
# Stop hook — enforce `mcp__aun__send` / `mcp__aun__notify`
# while accepting legacy `mcp__agent_comms__*` / `mcp__agent-comms__*`.
# invocation when the bot was woken by an agent-comms channel message.
# Spec: specs/draft/2026-04-25-send-tool-enforcement-hook-spec-v7.md (PR-C).
#
# Input:  stdin JSON `{ transcript_path, session_id }` (Claude Code Stop hook).
# Output:
#   exit 0                         — pass (send/notify called, or exempt)
#   exit 2 + stdout additionalContext — block + re-prompt
#   any unhandled error            — exit 0 (fail-safe, bot is never stopped)
#
# The script never performs network I/O or DB calls (§3.3): only tail + jq
# + file state. Retry state lives under $AUN_STATE_DIR; audit + error logs
# under $AUN_LOG_DIR. Both are overridable for tests.

set -u

# --------------------------------------------------------------------------
# Fail-safe: any unhandled error → exit 0. `trap` after `set -u` catches
# even unbound variable mishaps. We still exit 2 explicitly when blocking.
# --------------------------------------------------------------------------
trap 'exit 0' ERR

# --------------------------------------------------------------------------
# Config (env-overridable for tests and operator tuning).
# --------------------------------------------------------------------------
LOG_DIR="${AUN_LOG_DIR:-$HOME/.aun/logs}"
STATE_DIR="${AUN_STATE_DIR:-$HOME/.aun/state/send-enforcement}"
RETRY_LIMIT="${AUN_SEND_ENFORCEMENT_RETRY_LIMIT:-3}"
TAIL_BYTES="${AUN_SEND_ENFORCEMENT_TAIL_BYTES:-65536}"
CHANNEL_TAG_PATTERN='<channel source="agent-comms"'

ERROR_LOG="$LOG_DIR/send-enforcement-errors.log"
BYPASS_LOG="$LOG_DIR/send-enforcement-bypass.log"

# --------------------------------------------------------------------------
# Helpers.
# --------------------------------------------------------------------------
mk()        { mkdir -p "$1" 2>/dev/null || true; }
now_utc()   { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_error() { mk "$LOG_DIR"; printf '%s | %s\n' "$(now_utc)" "$*" >> "$ERROR_LOG" 2>/dev/null || true; }
log_bypass(){ mk "$LOG_DIR"; printf '%s | %s\n' "$(now_utc)" "$*" >> "$BYPASS_LOG" 2>/dev/null || true; }

emit_block() {
  # Spec §1.5 additionalContext — string verbatim (exact match is a test gate).
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"ERROR: Your previous assistant turn did not invoke mcp__aun__send or mcp__aun__notify. You received a message via <channel source=\"agent-comms\">, you MUST reply through the tool — NOT via stdout, NOT via built-in SendMessage. Invoke mcp__aun__send (pass channel_id from the inbound tag) now. Legacy aliases mcp__agent_comms__send / mcp__agent_comms__notify and mcp__agent-comms__send / mcp__agent-comms__notify are accepted during migration."}}
JSON
}

# --------------------------------------------------------------------------
# Retry state (per-session counter). Reset on pass, increment on block.
# After RETRY_LIMIT consecutive blocks, the (N+1)th invocation records a
# bypass audit entry and passes (§1.6 infinite-loop prevention).
# --------------------------------------------------------------------------
state_file_for() {
  local sid="$1"
  # Sanitize session_id for filename safety (alphanumeric + dash/underscore).
  printf '%s/%s.count' "$STATE_DIR" "$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9._-')"
}

read_count() {
  local f="$1"
  if [ -r "$f" ]; then
    local v; v=$(cat "$f" 2>/dev/null || echo 0); printf '%d' "${v:-0}" 2>/dev/null || printf 0
  else
    printf 0
  fi
}

write_count() {
  local f="$1" n="$2"
  mk "$(dirname "$f")"
  printf '%d' "$n" > "$f" 2>/dev/null || true
}

# --------------------------------------------------------------------------
# Guard: jq is required for JSONL parsing. Missing jq → fail-safe pass.
# --------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  log_error "jq not on PATH"
  exit 0
fi

# --------------------------------------------------------------------------
# Read stdin payload (transcript_path, session_id).
# --------------------------------------------------------------------------
PAYLOAD=$(cat 2>/dev/null || true)
if [ -z "$PAYLOAD" ]; then
  log_error "empty stdin payload"
  exit 0
fi

TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty' 2>/dev/null) || {
  log_error "payload jq parse failed"
  exit 0
}
SESSION_ID=$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""

if [ -z "$TRANSCRIPT_PATH" ]; then
  log_error "missing transcript_path (session_id=$SESSION_ID)"
  exit 0
fi
if [ ! -f "$TRANSCRIPT_PATH" ]; then
  log_error "transcript_path not a file: $TRANSCRIPT_PATH (session_id=$SESSION_ID)"
  exit 0
fi
if [ -z "$SESSION_ID" ]; then
  # Non-fatal: retry dedup degrades to path-scoped instead of session-scoped.
  SESSION_ID="no-session-id"
fi

# --------------------------------------------------------------------------
# Read tail chunk. If the file is larger than TAIL_BYTES the first line is
# potentially mid-JSON and unsafe to parse — drop it. Smaller files are
# read in full.
# --------------------------------------------------------------------------
RAW=$(tail -c "$TAIL_BYTES" "$TRANSCRIPT_PATH" 2>/dev/null) || {
  log_error "tail failed: $TRANSCRIPT_PATH"
  exit 0
}

FILE_SIZE=$(wc -c < "$TRANSCRIPT_PATH" 2>/dev/null | tr -d ' ')
if [ -n "${FILE_SIZE:-}" ] && [ "$FILE_SIZE" -gt "$TAIL_BYTES" ]; then
  TAIL_CLEAN=$(printf '%s\n' "$RAW" | awk 'NR > 1')
else
  TAIL_CLEAN="$RAW"
fi

if [ -z "$TAIL_CLEAN" ]; then
  log_error "tail returned empty (session_id=$SESSION_ID)"
  exit 0
fi

# --------------------------------------------------------------------------
# Parse turns with a single jq pass. Each JSONL entry is normalized to
# { role, text, tools } where:
#   role  = .type (top-level) OR .message.role (nested) — whichever is
#           "user" or "assistant"
#   text  = concatenated .text from content entries of type "text"
#   tools = names from content entries of type "tool_use"
#
# Emits a summary with three pieces the exempt rules need:
#   any_send_since_last_user  — covers §1.3 main check + §1.4 exempt 3
#   last_user_text            — for §1.4 exempt 1 (channel tag check)
#   assistant_count           — for §1.4 exempt 2 (initial turn)
# --------------------------------------------------------------------------
SUMMARY=$(printf '%s' "$TAIL_CLEAN" | jq -cs '
  def normalize:
    (.type // .message.role // "") as $role
    | ((.message.content // .content) // []) as $c
    | {
        role: $role,
        text: ([ $c[]? | select((.type // "") == "text") | (.text // "") ] | join("\n")),
        tools: [ $c[]? | select((.type // "") == "tool_use") | (.name // "") ]
      };

  # A tool_result entry is role="user" with empty text and no tool_use names.
  # It is structurally a user turn, but not a *real* user message — excluding
  # it keeps "last user turn" pointing at the channel-tag message even when a
  # send/notify tool call produced tool_result entries after it.
  def is_real_user_turn: .role == "user" and ((.text | length) > 0);

  map(normalize) | map(select(.role == "user" or .role == "assistant"))
  | . as $turns
  | ([ $turns | to_entries[] | select(.value | is_real_user_turn) | .key ] | last) as $lu
  | (if ($lu // -1) >= 0 then $turns[($lu + 1):] else $turns end) as $after
  | {
      assistant_count:   ([ $turns[] | select(.role == "assistant") ] | length),
      user_text_count:   ([ $turns[] | select(. | is_real_user_turn) ] | length),
      last_user_text:    (if ($lu // -1) >= 0 then $turns[$lu].text else "" end),
      any_send_since_last_user:
        ([ $after[] | select(.role == "assistant") | .tools[]? ]
         | any(
             . == "mcp__aun__send" or . == "mcp__aun__notify" or
             . == "mcp__agent_comms__send" or . == "mcp__agent_comms__notify" or
             . == "mcp__agent-comms__send" or . == "mcp__agent-comms__notify"
           ))
    }
' 2>/dev/null) || {
  log_error "jq summary failed (session_id=$SESSION_ID)"
  exit 0
}

if [ -z "$SUMMARY" ] || [ "$SUMMARY" = "null" ]; then
  log_error "empty summary (session_id=$SESSION_ID)"
  exit 0
fi

ANY_SEND=$(printf '%s' "$SUMMARY" | jq -r '.any_send_since_last_user // false' 2>/dev/null || printf 'false')
ASSISTANT_COUNT=$(printf '%s' "$SUMMARY" | jq -r '.assistant_count // 0' 2>/dev/null || printf 0)
USER_TEXT_COUNT=$(printf '%s' "$SUMMARY" | jq -r '.user_text_count // 0' 2>/dev/null || printf 0)
LAST_USER_TEXT=$(printf '%s' "$SUMMARY" | jq -r '.last_user_text // ""' 2>/dev/null || printf '')

STATE_FILE=$(state_file_for "$SESSION_ID")

# --------------------------------------------------------------------------
# Main check (§1.3) + exempt rule 3 (§1.4) — any send/notify since last
# user turn → pass. Reset retry counter.
# --------------------------------------------------------------------------
if [ "$ANY_SEND" = "true" ]; then
  write_count "$STATE_FILE" 0
  exit 0
fi

# --------------------------------------------------------------------------
# Exempt rule 2 (§1.4) — no prior assistant turn = session just starting,
# nothing to enforce. Also defensive against zero-turn transcripts.
# --------------------------------------------------------------------------
if [ "${ASSISTANT_COUNT:-0}" -le 0 ] || [ "${USER_TEXT_COUNT:-0}" -le 0 ]; then
  write_count "$STATE_FILE" 0
  exit 0
fi

# --------------------------------------------------------------------------
# Exempt rule 1 (§1.4) — last user turn does not contain the agent-comms
# channel tag = not a wake from agent-comms, no reply obligation.
# --------------------------------------------------------------------------
case "$LAST_USER_TEXT" in
  *"$CHANNEL_TAG_PATTERN"*) : ;;           # tag present — fall through to block
  *) write_count "$STATE_FILE" 0; exit 0 ;;  # tag absent — exempt
esac

# --------------------------------------------------------------------------
# All exempts missed — enforce. Honour §1.6 retry cap to prevent an
# infinite block loop when the LLM cannot recover on its own.
# --------------------------------------------------------------------------
COUNT=$(read_count "$STATE_FILE")
NEW_COUNT=$((COUNT + 1))

if [ "$NEW_COUNT" -gt "$RETRY_LIMIT" ]; then
  # Excerpt first 200 chars of the last user turn for auditability.
  EXCERPT=$(printf '%s' "$LAST_USER_TEXT" | tr '\n' ' ' | cut -c1-200)
  log_bypass "session_id=$SESSION_ID turn_count=$NEW_COUNT limit=$RETRY_LIMIT excerpt=$EXCERPT"
  # §1.6: (N+1)th invocation passes so the session isn't permanently stuck.
  # Keep the counter so a later successful turn still resets it to 0 cleanly.
  write_count "$STATE_FILE" "$NEW_COUNT"
  exit 0
fi

write_count "$STATE_FILE" "$NEW_COUNT"
emit_block
exit 2
