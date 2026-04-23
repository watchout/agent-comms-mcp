#!/usr/bin/env bash
# PR #0 — auto-next hook distributor for 18 bots.
#
# Reads scripts/bot-registry.txt and for each entry copies hooks/auto-next.sh
# into <PROJECT_DIR>/.claude/hooks/ and registers it in .claude/settings.json
# under SessionStart + UserPromptSubmit events.
#
# Idempotent: existing hook entry is refreshed; existing file is overwritten.
# Continues on per-bot failure (1 fail does NOT abort the batch, §2.6).
# Prints a success/fail table to stdout; operator pastes it into the PR body.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="${REPO_ROOT}/scripts/bot-registry.txt"
HOOK_SRC="${REPO_ROOT}/hooks/auto-next.sh"

if [[ ! -f "$REGISTRY" ]]; then
  echo "error: bot-registry not found at $REGISTRY" >&2
  exit 1
fi
if [[ ! -f "$HOOK_SRC" ]]; then
  echo "error: hook source not found at $HOOK_SRC" >&2
  exit 1
fi

expand_tilde() {
  # Expand leading ~ to $HOME without invoking eval.
  local path="$1"
  if [[ "$path" == "~"* ]]; then
    printf '%s' "${HOME}${path:1}"
  else
    printf '%s' "$path"
  fi
}

status=0
printf '%-20s %-50s %s\n' "AGENT_ID" "PROJECT_DIR" "RESULT"
printf '%-20s %-50s %s\n' "--------" "-----------" "------"

while IFS='|' read -r session project_dir agent_id port command; do
  # Skip comments and blanks
  [[ -z "${session:-}" || "${session}" =~ ^[[:space:]]*# ]] && continue
  expanded_dir="$(expand_tilde "$project_dir")"
  hook_dir="${expanded_dir}/.claude/hooks"
  settings_path="${expanded_dir}/.claude/settings.json"
  hook_dest="${hook_dir}/auto-next.sh"

  if [[ ! -d "$expanded_dir" ]]; then
    printf '%-20s %-50s %s\n' "$agent_id" "$expanded_dir" "SKIP (dir missing)"
    status=1
    continue
  fi

  mkdir -p "$hook_dir"
  if ! cp "$HOOK_SRC" "$hook_dest"; then
    printf '%-20s %-50s %s\n' "$agent_id" "$expanded_dir" "FAIL (copy)"
    status=1
    continue
  fi
  chmod +x "$hook_dest"

  # Register hook in settings.json. Use jq for a safe merge if available;
  # otherwise fall back to a minimal bootstrap file (bot settings.json is
  # expected to exist on established bots; the fallback handles fresh bots).
  if command -v jq >/dev/null 2>&1; then
    if [[ -f "$settings_path" ]]; then
      tmp_file="$(mktemp)"
      if jq --arg cmd "${hook_dest}" '
        .hooks //= {}
        | .hooks.SessionStart //= []
        | .hooks.UserPromptSubmit //= []
        | .hooks.SessionStart |= (
            map(select(.matcher != "auto-next-hook"))
            + [{"matcher": "auto-next-hook", "hooks": [{"type": "command", "command": $cmd}]}]
          )
        | .hooks.UserPromptSubmit |= (
            map(select(.matcher != "auto-next-hook"))
            + [{"matcher": "auto-next-hook", "hooks": [{"type": "command", "command": $cmd}]}]
          )
      ' "$settings_path" > "$tmp_file" 2>/dev/null; then
        mv "$tmp_file" "$settings_path"
      else
        rm -f "$tmp_file"
        printf '%-20s %-50s %s\n' "$agent_id" "$expanded_dir" "FAIL (jq merge)"
        status=1
        continue
      fi
    else
      cat > "$settings_path" <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "auto-next-hook",
        "hooks": [{"type": "command", "command": "${hook_dest}"}]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "auto-next-hook",
        "hooks": [{"type": "command", "command": "${hook_dest}"}]
      }
    ]
  }
}
EOF
    fi
  else
    printf '%-20s %-50s %s\n' "$agent_id" "$expanded_dir" "FAIL (jq missing)"
    status=1
    continue
  fi

  printf '%-20s %-50s %s\n' "$agent_id" "$expanded_dir" "OK"
done < "$REGISTRY"

exit $status
