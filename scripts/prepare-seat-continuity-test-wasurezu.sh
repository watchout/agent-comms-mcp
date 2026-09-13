#!/usr/bin/env bash
set -euo pipefail

# Actual public companion build for the native pipe/MCP boundary tests.
# This only prepares a private CI fixture; it publishes or activates nothing.
: "${RUNNER_TEMP:?RUNNER_TEMP must identify the private fixture parent}"
: "${AUN_TEST_WASUREZU_OUTPUT:?AUN_TEST_WASUREZU_OUTPUT must identify a private fixture output file}"
[[ "$RUNNER_TEMP" = /* && -d "$RUNNER_TEMP" ]] || exit 2

# The helper supplies a fresh output path inside its private CI fixture directory.
[[ "${CI:-}" = true ]] || exit 2
node -e 'const fs=require("fs"),p=require("path"),out=process.env.AUN_TEST_WASUREZU_OUTPUT;const root=fs.realpathSync(process.env.RUNNER_TEMP),parent=fs.realpathSync(p.dirname(out));if(!p.isAbsolute(out)||fs.existsSync(out)||!parent.startsWith(root+p.sep))process.exit(2)'

was_commit=e919c6112185a2fe6637ac5d585fb2e65f567f8e
was_tree=9d5dc2d9cbbef19d0e2a24281c78d768942f129c
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
printf '%s\n' "$was_fixture" > "$AUN_TEST_WASUREZU_OUTPUT"
printf 'Native fixture built from Was %s tree %s\n' "$was_commit" "$was_tree"
