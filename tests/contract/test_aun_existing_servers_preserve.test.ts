import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'

// Spec v6 v1.2 §1.3.1 / §3.1 / §4 — pre-existing entries in
// `~/.claude.json` mcpServers must survive `aun init`. The real
// `claude mcp add` CLI guarantees this; our mock claude reproduces
// the same merge-into-existing semantics so we can assert the
// non-destructive contract end-to-end without the real binary.

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_existing_servers_preserve — ~/.claude.json existing mcpServers untouched', () => {
  let home: string
  let claudeHome: string
  let claudeJsonPath: string
  let mockClaudeBin: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-preserve-'))
    claudeHome = join(home, '.claude')
    claudeJsonPath = join(home, '.claude.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(join(claudeHome, 'settings.json'), '{}\n')

    // Pre-seed ~/.claude.json with a pre-existing user-scope server
    // we expect aun init to leave alone.
    writeFileSync(claudeJsonPath, JSON.stringify({
      mcpServers: {
        foo: { command: '/usr/local/bin/foo', args: ['--port', '9999'] },
      },
    }, null, 2) + '\n')

    mockClaudeBin = join(home, 'mock-claude')
    writeFileSync(mockClaudeBin, `#!/usr/bin/env bash
set -euo pipefail
cmd="$1"; sub="$2"
HOME_JSON="${claudeJsonPath}"
if [ ! -f "$HOME_JSON" ]; then echo "{}" > "$HOME_JSON"; fi
if [ "$cmd" = "mcp" ] && [ "$sub" = "add" ]; then
  shift 2
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
import json
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
import json, os
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

  test('aun init adds aun and preserves the unrelated foo server entry', () => {
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

    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    // Pre-existing entry must be intact byte-for-byte.
    expect(claudeJson.mcpServers.foo).toEqual({ command: '/usr/local/bin/foo', args: ['--port', '9999'] })
    // aun added alongside, not in place of.
    expect(claudeJson.mcpServers.aun).toBeDefined()
    expect(claudeJson.mcpServers.aun.command).toMatch(/bun/)
  })
})
