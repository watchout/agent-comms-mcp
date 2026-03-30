#!/usr/bin/env bash
# on-demand-shutdown.sh — Shut down idle bot sessions after task completion
# Usage: BOT_NAME=discord-wbs ./on-demand-shutdown.sh
# Cron: * * * * * BOT_NAME=discord-wbs /path/to/on-demand-shutdown.sh

set -euo pipefail

# --- Configuration ---
BOT_NAME="${BOT_NAME:?BOT_NAME is required (tmux session name)}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-300}"  # seconds to wait after completion signal (default: 5 min)
STATE_DIR="${STATE_DIR:-/tmp/on-demand-state}"

LOG_TAG="[on-demand-shutdown:${BOT_NAME}]"
COMPLETION_FILE="${STATE_DIR}/${BOT_NAME}.completed_at"

mkdir -p "${STATE_DIR}"

# --- Step 1: Check if tmux session exists ---
if ! tmux has-session -t "${BOT_NAME}" 2>/dev/null; then
  # Clean up stale state if session doesn't exist
  rm -f "${COMPLETION_FILE}"
  exit 0
fi

# --- Step 2: Capture recent tmux output ---
RECENT_OUTPUT=$(tmux capture-pane -t "${BOT_NAME}" -p -S -50 2>/dev/null || echo "")

# --- Step 3: Check for completion signals ---
if echo "${RECENT_OUTPUT}" | grep -qE '\[報告:完了\]|\[報告:失敗\]|\[task:completed\]|\[task:failed\]'; then
  if [ ! -f "${COMPLETION_FILE}" ]; then
    # First time seeing completion signal — record timestamp
    date +%s > "${COMPLETION_FILE}"
    echo "${LOG_TAG} Completion signal detected. Waiting ${IDLE_TIMEOUT}s before shutdown." >&2
    exit 0
  fi

  # Check if idle timeout has elapsed
  COMPLETED_AT=$(cat "${COMPLETION_FILE}")
  NOW=$(date +%s)
  ELAPSED=$((NOW - COMPLETED_AT))

  if [ "${ELAPSED}" -ge "${IDLE_TIMEOUT}" ]; then
    echo "${LOG_TAG} Idle timeout reached (${ELAPSED}s). Shutting down ${BOT_NAME}..." >&2

    # Kill the tmux session
    tmux kill-session -t "${BOT_NAME}" 2>/dev/null || true

    # Clean up state
    rm -f "${COMPLETION_FILE}"

    echo "${LOG_TAG} ${BOT_NAME} shut down successfully." >&2
  fi
else
  # No completion signal — reset state if it was previously set
  if [ -f "${COMPLETION_FILE}" ]; then
    echo "${LOG_TAG} New activity detected after completion. Resetting idle timer." >&2
    rm -f "${COMPLETION_FILE}"
  fi
fi
