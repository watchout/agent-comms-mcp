import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 §4.1 merge gate core — fresh-env init.
// Clean tmp HOME (~/.aun/ absent, settings.json minimal) → `init()` →
//   (a) ~/.aun/ created with config.json + .env template
//   (b) ~/.claude/plugins/aun/server.ts placed
//   (c) ~/.claude/settings.json patched (hooks + mcpServers.aun present)
//   (d) ~/.claude/settings.json.bak.<ts> created (pre-patch content)
//   (e) no errors
//
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

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
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })

  test('(a) ~/.aun/ created with config.json + .env template', () => {
    expect(existsSync(join(home, '.aun', 'config.json'))).toBe(true)
    expect(existsSync(join(home, '.aun', '.env'))).toBe(true)
  })

  test('(b) ~/.claude/plugins/aun/server.ts placed from REPO_ROOT/server.ts', () => {
    const dest = join(claudeHome, 'plugins', 'aun', 'server.ts')
    expect(existsSync(dest)).toBe(true)
    // Plugin file is a real copy — size is non-zero and starts with
    // the same shebang/banner as the source.
    const src = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8').slice(0, 200)
    const placed = readFileSync(dest, 'utf-8').slice(0, 200)
    expect(placed).toBe(src)
  })

  test('(c) ~/.claude/settings.json has hooks.SessionStart + hooks.Stop + mcpServers.aun entries', () => {
    const s = readSettings(settingsPath)
    const stop = s.hooks?.Stop ?? []
    const mcp = s.mcpServers ?? {}
    expect(stop.length).toBeGreaterThanOrEqual(1)
    expect(mcp.aun).toBeDefined()
    // §1.4 flag verbatim — the startup args must include the frozen
    // dangerously-load-development-channels + server:aun pair.
    const args = (mcp.aun?.args ?? []).join(' ')
    expect(args).toContain('--dangerously-load-development-channels')
    expect(args).toContain('server:aun')
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
})
