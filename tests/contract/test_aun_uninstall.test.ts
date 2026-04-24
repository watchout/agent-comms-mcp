import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { uninstall } from '../../bin/aun/uninstall'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 §1.5 — uninstall 3 modes.
//   (auto)     restore latest .bak
//   --backup   restore specific backup
//   --surgical drop aun-only entries; preserve everything else
//
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

function mkTmp(label: string): { home: string; claudeHome: string; settingsPath: string } {
  const home = mkdtempSync(join(tmpdir(), `aun-uninstall-${label}-`))
  const claudeHome = join(home, '.claude')
  const settingsPath = join(claudeHome, 'settings.json')
  mkdirSync(claudeHome, { recursive: true })
  return { home, claudeHome, settingsPath }
}

describe('test_aun_uninstall — auto / --backup / --surgical', () => {
  describe('auto (latest backup restore)', () => {
    const { home, claudeHome, settingsPath } = mkTmp('auto')
    const origContent = readFileSync(
      join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'existing-hooks.json'),
      'utf-8',
    )
    beforeAll(() => { writeFileSync(settingsPath, origContent) })
    afterAll(() => { rmSync(home, { recursive: true, force: true }) })

    test('init → uninstall (auto) → settings.json matches pre-init content', () => {
      const initRes = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home } })
      expect(initRes.ok).toBe(true)
      const res = uninstall({ home, claudeHome, env: { HOME: home } })
      expect(res.ok).toBe(true)
      expect(res.mode).toBe('auto')
      expect(res.restoredFrom).toBeDefined()
      expect(readFileSync(settingsPath, 'utf-8')).toBe(origContent)
    })
  })

  describe('--backup <path>', () => {
    const { home, claudeHome, settingsPath } = mkTmp('backup')
    const orig = '{ "env": { "from": "specific-backup" } }\n'
    beforeAll(() => { writeFileSync(settingsPath, orig) })
    afterAll(() => { rmSync(home, { recursive: true, force: true }) })

    test('init creates backup; --backup path restores that exact file', () => {
      const initRes = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home } })
      expect(initRes.ok).toBe(true)
      // The backup path that init created is stored on the result.
      expect(initRes.backupPath).toBeDefined()
      const res = uninstall({ home, claudeHome, backup: initRes.backupPath!, env: { HOME: home } })
      expect(res.ok).toBe(true)
      expect(res.mode).toBe('backup')
      expect(res.restoredFrom).toBe(initRes.backupPath!)
      expect(readFileSync(settingsPath, 'utf-8')).toBe(orig)
    })
  })

  describe('--surgical (preserve user config)', () => {
    const { home, claudeHome, settingsPath } = mkTmp('surgical')
    const origContent = readFileSync(
      join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'existing-hooks.json'),
      'utf-8',
    )
    beforeAll(() => { writeFileSync(settingsPath, origContent) })
    afterAll(() => { rmSync(home, { recursive: true, force: true }) })

    test('init + surgical uninstall: user hook + env preserved, aun entries gone', () => {
      const initRes = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home } })
      expect(initRes.ok).toBe(true)

      const res = uninstall({ home, claudeHome, surgical: true, env: { HOME: home } })
      expect(res.ok).toBe(true)
      expect(res.mode).toBe('surgical')

      const s = readSettings(settingsPath)

      // User hook preserved.
      const commands = (s.hooks?.SessionStart ?? []).flatMap(r => r.hooks.map(h => h.command))
      expect(commands).toContain('bash /home/user/my-own-session-start.sh')
      // No aun commands remain.
      expect(commands.some(c => c.includes('aun-loader.sh') || c.includes('aun-send-tool-enforcement.sh')))
        .toBe(false)

      // User env preserved.
      expect((s.env as Record<string, string> | undefined)?.USER_CUSTOM_FLAG).toBe('keep-me')
      // aun mcpServer gone.
      expect(s.mcpServers?.aun).toBeUndefined()
    })
  })
})
