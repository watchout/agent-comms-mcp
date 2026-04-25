import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'

// Spec v6 v1.2 §1.3.1 / §4 — `aun init` registers the aun MCP server
// in `~/.claude.json` via the official `claude mcp add --scope user`
// CLI. Cycle 3 frozen contract: command resolves to a bun binary,
// args is exactly `[<server.ts path>]` (no claude CLI flags inside),
// and bin/aun/init.ts must NOT also write to settings.json mcpServers.
//
// We don't have the real `claude` CLI on every CI machine, so this
// test stubs it with a tiny bash script that records its argv into
// `~/.claude.json` in the same shape the real CLI would produce.
// That keeps the contract assertion ("aun shells out to claude mcp
// add with the right argv") executable end-to-end without depending
// on the host's claude install — exactly the scope §3.4 calls out
// (`real CLI invocation`, not a mock of the helper).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_claude_json_register — claude mcp add CLI shell-out + ~/.claude.json shape', () => {
  let home: string
  let claudeHome: string
  let claudeJsonPath: string
  let mockClaudeBin: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-claudejson-'))
    claudeHome = join(home, '.claude')
    claudeJsonPath = join(home, '.claude.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{}\n')

    // Mock `claude` binary — supports `claude mcp add` and `claude mcp remove`
    // by writing directly to ~/.claude.json. That's the same end-state
    // the real CLI produces, but without any external dependency.
    mockClaudeBin = join(home, 'mock-claude')
    const claudeJsonForMock = claudeJsonPath
    writeFileSync(mockClaudeBin, `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; sub="$2"
HOME_JSON="${claudeJsonForMock}"
if [ ! -f "$HOME_JSON" ]; then echo "{}" > "$HOME_JSON"; fi
if [ "$cmd" = "mcp" ] && [ "$sub" = "add" ]; then
  shift 2
  # parse: --scope user --transport stdio aun -- <bun> <server.ts>
  scope=""; transport=""; name=""; rest=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --scope) scope="$2"; shift 2 ;;
      --transport) transport="$2"; shift 2 ;;
      --) shift; rest=("$@"); break ;;
      *) name="$1"; shift ;;
    esac
  done
  bun_cmd="\${rest[0]:-}"
  server_path="\${rest[1]:-}"
  python3 - <<PY
import json, sys
p = "$HOME_JSON"
data = json.load(open(p))
data.setdefault("mcpServers", {})
data["mcpServers"]["$name"] = {"command": "$bun_cmd", "args": ["$server_path"]}
json.dump(data, open(p, "w"), indent=2)
PY
  exit 0
elif [ "$cmd" = "mcp" ] && [ "$sub" = "remove" ]; then
  name="$3"
  python3 - <<PY
import json, sys, os
p = "$HOME_JSON"
if os.path.exists(p):
    data = json.load(open(p))
    if isinstance(data.get("mcpServers"), dict):
        data["mcpServers"].pop("$name", None)
    json.dump(data, open(p, "w"), indent=2)
PY
  exit 0
fi
exit 0
`)
    chmodSync(mockClaudeBin, 0o755)
  })

  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('init() runs claude mcp add and ~/.claude.json carries aun with NO CLI flags in args', () => {
    const res = init({
      home,
      claudeHome,
      repoRoot: REPO_ROOT,
      env: {
        HOME: home,
        DISCORD_BOT_TOKEN: 'cycle3-token',
        AUN_CLAUDE_BIN: mockClaudeBin,
      },
      skipVersionCheck: true,
      skipExecutableBitCheck: true,
    })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)

    // The mock claude wrote to ~/.claude.json. Read it and verify the shape.
    expect(existsSync(claudeJsonPath)).toBe(true)
    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    expect(claudeJson.mcpServers?.aun).toBeDefined()
    const aun = claudeJson.mcpServers.aun
    // command points at a bun binary (resolved or bare).
    expect(aun.command).toMatch(/bun/)
    // args is exactly `[<server.ts>]` — no claude CLI flags injected.
    expect(aun.args).toEqual([expect.stringMatching(/server\.ts$/)])
    // Defensive: every arg must be a non-flag, non-server-tag token.
    for (const a of aun.args) {
      expect(a.startsWith('--')).toBe(false)
      expect(a.startsWith('server:')).toBe(false)
    }
  })

  test('settings.json must NOT carry an mcpServers field after cycle 3 init', () => {
    const settings = JSON.parse(readFileSync(join(claudeHome, 'settings.json'), 'utf-8'))
    expect(settings.mcpServers).toBeUndefined()
  })
})
