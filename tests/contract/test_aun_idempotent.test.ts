import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 §2.7 — `aun init` is idempotent. Running 3 times in a row
// must yield a settings.json whose hook arrays contain NO duplicate
// command strings, and the 2nd + 3rd runs report "already up-to-date"
// (settingsChanged=false).
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_idempotent — 3 consecutive init runs leave no duplicates', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-idem-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(settingsPath, '{}\n')
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('1st run: settings patched, backup created', () => {
    const r = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true })
    expect(r.ok).toBe(true)
    expect(r.settingsChanged).toBe(true)
  })

  test('2nd run: settingsChanged=false (no-op)', () => {
    const r = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true })
    expect(r.ok).toBe(true)
    expect(r.settingsChanged).toBe(false)
  })

  test('3rd run: settingsChanged=false (no-op)', () => {
    const r = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true })
    expect(r.ok).toBe(true)
    expect(r.settingsChanged).toBe(false)
  })

  test('hook arrays contain zero duplicate commands after 3 runs', () => {
    const s = readSettings(settingsPath)
    for (const [event, regs] of Object.entries(s.hooks ?? {})) {
      if (!Array.isArray(regs)) continue
      const allCommands = regs.flatMap(r => r.hooks.map(h => h.command))
      const uniq = new Set(allCommands)
      expect(allCommands.length).toBe(uniq.size)
    }
  })

  test('backup count stays ≤ retention cap (5 default) after repeat runs', () => {
    // We only ran 3 inits, so we expect at most 1 backup (subsequent
    // runs are no-ops and don't backup). Upper bound is 5 either way.
    const entries = readdirSync(claudeHome)
    const backups = entries.filter(n => n.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    expect(backups.length).toBeLessThanOrEqual(5)
  })
})
