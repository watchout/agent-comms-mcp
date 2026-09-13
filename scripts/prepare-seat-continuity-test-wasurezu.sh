#!/usr/bin/env bash
set -euo pipefail

# Actual public companion build for the native pipe/MCP boundary tests.
# This only prepares a private CI fixture; it publishes or activates nothing.
: "${RUNNER_TEMP:?RUNNER_TEMP must identify the private fixture parent}"
: "${GITHUB_ENV:?GITHUB_ENV must identify the CI environment output file}"
[[ "$RUNNER_TEMP" = /* && -d "$RUNNER_TEMP" ]] || exit 2

# Only the existing explicitly isolated CI service can supply the second alias.
node -e 'const u=new URL(process.env.DATABASE_URL||""); if(u.pathname!=="/agent_comms_test" || !["postgres:","postgresql:"].includes(u.protocol) || /[\r\n]/.test(process.env.DATABASE_URL)) process.exit(2)'
printf 'AGENT_COM_TEST_DATABASE_URL=%s\n' "$DATABASE_URL" >> "$GITHUB_ENV"

was_commit=4cf952c7da186952180f81812c903a3f8434561d
was_tree=0a088ec9a950a99f4d0c22dfc20ff756c1f67a14
was_fixture=$(mktemp -d "$RUNNER_TEMP/aun-wasurezu-XXXXXX")
git init -q "$was_fixture"
GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c http.extraHeader= -C "$was_fixture" fetch --depth=1 https://github.com/watchout/agent-memory.git "$was_commit"
git -C "$was_fixture" checkout -q --detach FETCH_HEAD
[[ "$(git -C "$was_fixture" rev-parse HEAD)" = "$was_commit" ]]
[[ "$(git -C "$was_fixture" rev-parse 'HEAD^{tree}')" = "$was_tree" ]]

(
  cd "$was_fixture"
  npm_config_cache="$was_fixture/.npm-cache" npm ci --ignore-scripts
  npm run build
  test -f dist/native-context-delivery.js
  test -f dist/codex-session-start.js
  test -z "$(git status --porcelain --untracked-files=no)"
)
printf 'AUN_TEST_WASUREZU_ROOT=%s\n' "$was_fixture" >> "$GITHUB_ENV"
printf 'Native fixture built from Was %s tree %s\n' "$was_commit" "$was_tree"
