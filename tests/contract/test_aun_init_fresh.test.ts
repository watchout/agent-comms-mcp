import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 v1.2 §4.1 merge gate core — fresh-env init (cycle 3).
// Clean tmp HOME (~/.aun/ absent, settings.json minimal) → `init()` →
//   (a) ~/.aun/ created with config.json + .env template
//   (b) ~/.claude/plugins/aun/server.bundled.js placed (cycle 4 bundle)
//   (c) ~/.claude/settings.json carries the Stop hook and NO mcpServers
//       field. mcpServers.aun is registered separately in
//       `~/.claude.json` via `claude mcp add` — see
//       test_aun_claude_json_register for that path.
//   (d) ~/.claude/settings.json.bak.<ts> created (pre-patch content)
//   (e) CLI signature baseline captured (best-effort)
//
// Instruction: lead-ama PR-aun-install cycle 3 dispatch (msg ids
// 759014fb / 2acf9f8c / 600eb5d0).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_init_fresh — fresh-env init produces aun home + plugin + patched settings.json', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-init-fresh-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    // Minimal clean settings.json (empty object).
    writeFileSync(
      settingsPath,
      readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'clean-settings.json'), 'utf-8'),
    )
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('init() returns ok=true on clean tmp home + settings.json minimal', () => {
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true, skipClaudeMcpAdd: true })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })

  test('(a) ~/.aun/ created with config.json + .env template', () => {
    expect(existsSync(join(home, '.aun', 'config.json'))).toBe(true)
    expect(existsSync(join(home, '.aun', '.env'))).toBe(true)
  })

  test('(b) ~/.claude/plugins/aun/server.bundled.js placed via bun build of REPO_ROOT/server.ts', () => {
    // Cycle 4 — placement is now a bundled JS file, not source TS.
    // Cycle 3 placed `server.ts` standalone, which failed at runtime
    // because sibling `./core/db`, `./adapters/*` and npm deps were
    // missing. The bundle inlines all of those.
    const dest = join(claudeHome, 'plugins', 'aun', 'server.bundled.js')
    expect(existsSync(dest)).toBe(true)
    const placed = readFileSync(dest, 'utf-8')
    // Bundle is MB-scale (server.ts pulls in 800+ modules).
    expect(placed.length).toBeGreaterThan(100_000)
    // The original `server.ts` is no longer placed (cycle 4 retires
    // the source-only placement).
    const oldDest = join(claudeHome, 'plugins', 'aun', 'server.ts')
    expect(existsSync(oldDest)).toBe(false)
  })

  test('(c) ~/.claude/settings.json has hooks.Stop and NO mcpServers field (cycle 3)', () => {
    const s = readSettings(settingsPath)
    const stop = s.hooks?.Stop ?? []
    // Cycle 3 forbids any aun-side write to settings.json mcpServers.
    // The file must NOT carry an mcpServers field as a result of init.
    expect(s.mcpServers).toBeUndefined()
    expect(stop.length).toBeGreaterThanOrEqual(1)
    // Stop hook references the PR-C #240 enforcement script.
    const stopCommands = stop.flatMap(reg => reg.hooks.map(h => h.command))
    expect(stopCommands.some(c => c.includes('aun-send-tool-enforcement.sh'))).toBe(true)
  })

  test('(d) ~/.claude/settings.json.bak.<ts> created (only when file pre-existed and changed)', () => {
    // Backup exists with the `.bak.` marker in the filename.
    const dir = claudeHome
    const entries = require('node:fs').readdirSync(dir) as string[]
    const bak = entries.filter(n => n.startsWith('settings.json.bak.'))
    expect(bak.length).toBe(1)
    // Backup content matches original clean-settings.json.
    const backup = readFileSync(join(dir, bak[0]), 'utf-8')
    const orig = readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'clean-settings.json'), 'utf-8')
    expect(backup).toBe(orig)
  })

  test('(e) CLI baseline captured at ~/.aun/cli-baselines.json (best-effort)', () => {
    // The baseline write is wrapped in try/catch; on this sandbox it
    // should succeed for at least `bun --version`. We assert the file
    // exists but don't require a specific probe count.
    const baselinePath = join(home, '.aun', 'cli-baselines.json')
    expect(existsSync(baselinePath)).toBe(true)
  })

  test('(f) Issue #278 cycle 4 — aun-pre-tool-use-inbox-gate.{sh,ts} copied + PreToolUse wired in settings.json', () => {
    // Cycle 4 must-fix #1 (auditor verbatim): the inbox gate file pair
    // ships in `hooks/` but cycle 3 left it off the installer. This
    // test pins both the file copy and the settings.json wiring so a
    // future regression that drops either side fails loudly.
    //
    // (i) bash wrapper + bun TS runner are both placed in
    //     ~/.claude/hooks/ as a sibling pair (the wrapper invokes the
    //     runner via `bun hooks/pre-tool-use-inbox-gate.ts`).
    const hookDir = join(claudeHome, 'hooks')
    expect(existsSync(join(hookDir, 'aun-pre-tool-use-inbox-gate.sh'))).toBe(true)
    expect(existsSync(join(hookDir, 'pre-tool-use-inbox-gate.ts'))).toBe(true)

    // (ii) settings.json carries a PreToolUse matcher pointing at the
    //      wrapper. The runner owns the allow-list (next/send/notify/
    //      skip/fail/reclaim) so the matcher itself is empty (every
    //      tool runs the gate; the runner short-circuits the
    //      allow-list ones with exit 0).
    const s = readSettings(settingsPath)
    const preToolUse = s.hooks?.PreToolUse ?? []
    expect(preToolUse.length).toBeGreaterThanOrEqual(1)
    const commands = preToolUse.flatMap(reg => reg.hooks.map(h => h.command))
    expect(commands.some(c => c.includes('aun-pre-tool-use-inbox-gate.sh'))).toBe(true)
  })
})
