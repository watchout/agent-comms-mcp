#!/bin/bash
# ADF Breaking-change detection
# Scans `git diff BASE...HEAD` for 7 patterns that historically caused
# production incidents (PR #164: silent fallback removal → 85%→1% success).
#
# Usage:
#   bash scripts/detect-breaking-changes.sh                 # vs main, text output
#   bash scripts/detect-breaking-changes.sh origin/main     # custom base
#   bash scripts/detect-breaking-changes.sh main json       # JSON output (MCP)
#
# Exits 0 if clean, 1 if any pattern is detected.
set -euo pipefail

BASE_BRANCH="${1:-main}"
OUTPUT_FORMAT="${2:-text}"

# ─────────────────────────────────────────────
# File-path test exclusion (prior implementation used content-based "grep -qv
# test" which matched non-test lines in non-test files and silently suppressed
# findings. Filtering by path is the correct semantics.)
# ─────────────────────────────────────────────
CHANGED_RAW=$(
  git diff --name-only "${BASE_BRANCH}...HEAD" 2>/dev/null \
    || git diff --name-only "${BASE_BRANCH}..HEAD"
)

NON_TEST_FILES=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *.test.* | *.spec.* | */__tests__/* | */__mocks__/* | tests/* | test/* )
      continue ;;
    * )
      NON_TEST_FILES+=("$f") ;;
  esac
done <<< "$CHANGED_RAW"

emit_json() {
  # $1 = status, remaining args = findings (one per arg)
  local status="$1"
  shift
  printf '{"status":"%s","findings":[' "$status"
  local i=0
  local msg
  for msg in "$@"; do
    [ "$i" -gt 0 ] && printf ','
    # Escape double quotes defensively.
    msg="${msg//\"/\\\"}"
    printf '"%s"' "$msg"
    i=$((i+1))
  done
  printf '],"count":%d}\n' "$#"
}

if [ ${#NON_TEST_FILES[@]} -eq 0 ]; then
  if [ "$OUTPUT_FORMAT" = "json" ]; then
    emit_json "clean"
  else
    echo "✅ No breaking change patterns detected (only test files changed or no changes)."
  fi
  exit 0
fi

DIFF=$(
  git diff "${BASE_BRANCH}...HEAD" -- "${NON_TEST_FILES[@]}" 2>/dev/null \
    || git diff "${BASE_BRANCH}..HEAD" -- "${NON_TEST_FILES[@]}"
)

# Only consider removed source lines (start with a single '-' but not '---'),
# skip pure comment removals so harmless doc deletions don't trip the scanner.
removed_lines() {
  echo "$DIFF" \
    | grep -E '^-' \
    | grep -vE '^-{3}' \
    | grep -vE '^-[[:space:]]*(//|#)'
}

FINDINGS=()

if removed_lines | grep -qE '\b(fallback|default|catch|else)\b'; then
  FINDINGS+=("fallback/default branch removed — verify all callers")
fi
if removed_lines | grep -qE 'function[[:space:]]+\w+[[:space:]]*\('; then
  FINDINGS+=("Function signature changed — verify all call sites")
fi
if removed_lines | grep -qE 'export[[:space:]]+(function|const|class|interface|type)[[:space:]]+'; then
  FINDINGS+=("Exported symbol removed — verify all importers")
fi
if removed_lines | grep -qE 'process\.env\.\w+'; then
  FINDINGS+=("Environment variable removed — verify all deployments")
fi
if removed_lines | grep -qE 'DROP[[:space:]]+(TABLE|COLUMN)|ALTER[[:space:]]+TABLE.*DROP'; then
  FINDINGS+=("DB schema DROP — verify migration safety + rollback plan")
fi
if removed_lines | grep -qE '\.(get|post|put|patch|delete)[[:space:]]*\('; then
  FINDINGS+=("API endpoint removed — verify all clients")
fi
if removed_lines | grep -qE '\b(shared|global|singleton)\b'; then
  FINDINGS+=("Shared/global resource removed — verify all consumers")
fi

if [ ${#FINDINGS[@]} -eq 0 ]; then
  if [ "$OUTPUT_FORMAT" = "json" ]; then
    emit_json "clean"
  else
    echo "✅ No breaking change patterns detected."
  fi
  exit 0
fi

if [ "$OUTPUT_FORMAT" = "json" ]; then
  emit_json "detected" "${FINDINGS[@]}"
  exit 1
fi

echo ""
echo "🔴 Breaking change patterns detected:"
echo ""
for f in "${FINDINGS[@]}"; do
  echo "  - $f"
done
echo ""
echo "Before merge:"
echo "  1. Identify all affected consumers"
echo "  2. Verify behavior in each consumer"
echo "  3. Record verification in PR comment"
echo "  4. Add 'breaking-change-verified' label before merge"
exit 1
