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
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true, skipClaudeMcpAdd: true })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.settingsChanged).toBe(true)
  })

  test('existing user SessionStart hook is preserved verbatim (not clobbered)', () => {
    const s = readSettings(settingsPath)
    const ss = s.hooks?.SessionStart ?? []
    // The fixture's user command must still be present.
    const found = ss.flatMap(reg => reg.hooks.map(h => h.command))
    expect(found).toContain('echo user-hook')
  })

  test('user SessionStart preserved 1:1 + aun Stop hook added in a separate event key', () => {
    const s = readSettings(settingsPath)
    const ss = s.hooks?.SessionStart ?? []
    const stop = s.hooks?.Stop ?? []
    // The user's SessionStart entry stays intact (1 registration with 1 command).
    expect(ss.length).toBe(1)
    expect(ss[0].hooks.length).toBe(1)
    // The aun Stop hook lands under the separate `Stop` event — proving
    // deep-merge by event key, not array clobber on the same event.
    expect(stop.length).toBeGreaterThanOrEqual(1)
    const stopCommands = stop.flatMap(reg => reg.hooks.map(h => h.command))
    expect(stopCommands.some(c => c.includes('aun-send-tool-enforcement.sh'))).toBe(true)
  })

  test('unrelated user keys (env.USER_CUSTOM_FLAG) pass through untouched', () => {
    const s = readSettings(settingsPath)
    expect((s.env as Record<string, string> | undefined)?.USER_CUSTOM_FLAG).toBe('keep-me')
  })

  test('cycle 3: aun does NOT touch settings.json mcpServers field', () => {
    const s = readSettings(settingsPath)
    // The fixture has no mcpServers; cycle 3 init also doesn't add any.
    // (claude mcp add --scope user writes ~/.claude.json instead — see
    // test_aun_claude_json_register.)
    expect(s.mcpServers).toBeUndefined()
  })
})
