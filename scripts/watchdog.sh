#!/usr/bin/env bash
# One bounded invocation of the canonical read-only runtime health observer.
# Missing/foreign/expired endpoint evidence is UNKNOWN and never restart authority.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export DATABASE_URL="${DATABASE_URL:-${AGENT_COMMS_DATABASE_URL:-postgresql:///agent_comms?host=/tmp}}"
exec "${AUN_WATCHDOG_BUN_BIN:-bun}" "${SCRIPT_DIR}/../bin/aun-watchdog.ts" --once
