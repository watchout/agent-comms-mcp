import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 §2.2 — deep merge appends aun hook entries to existing
// SessionStart / Stop arrays without touching user-added hooks or
// unrelated keys (env.USER_CUSTOM_FLAG in the fixture).
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_existing_hooks_preserve — user hook + custom env survive init', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-hooks-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(
      settingsPath,
      readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'existing-hooks.json'), 'utf-8'),
    )
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('init succeeds on a settings.json with pre-existing user hooks', () => {
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home } })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.settingsChanged).toBe(true)
  })

  test('existing user SessionStart hook is preserved verbatim (not clobbered)', () => {
    const s = readSettings(settingsPath)
    const ss = s.hooks?.SessionStart ?? []
    // The fixture's user command must still be present.
    const found = ss.flatMap(reg => reg.hooks.map(h => h.command))
    expect(found).toContain('bash /home/user/my-own-session-start.sh')
  })

  test('aun hook is appended in addition to the user hook (array length grows)', () => {
    const s = readSettings(settingsPath)
    const ss = s.hooks?.SessionStart ?? []
    // Fixture had 1 registration (containing 1 command); init adds at
    // least one registration with the aun-loader command.
    expect(ss.length).toBeGreaterThanOrEqual(2)
    const allCommands = ss.flatMap(reg => reg.hooks.map(h => h.command))
    // At least the aun-loader command is now present.
    expect(allCommands.some(c => c.includes('aun-loader.sh') || c.includes('aun-send-tool-enforcement.sh')))
      .toBe(true)
  })

  test('unrelated user keys (env.USER_CUSTOM_FLAG) pass through untouched', () => {
    const s = readSettings(settingsPath)
    expect((s.env as Record<string, string> | undefined)?.USER_CUSTOM_FLAG).toBe('keep-me')
  })

  test('aun mcpServer added alongside user hooks (no collision)', () => {
    const s = readSettings(settingsPath)
    expect(s.mcpServers?.aun).toBeDefined()
  })
})
