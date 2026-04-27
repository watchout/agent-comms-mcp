import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'

// Spec v6 §2.4 — dry-run outputs predicted JSON diff and does NOT
// touch settings.json (mtime unchanged, no backup written).
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_dry_run — --dry-run outputs diff, writes no files, keeps mtime', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string
  let mtimeBefore: number

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-dry-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(
      settingsPath,
      readFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'clean-settings.json'), 'utf-8'),
    )
    mtimeBefore = statSync(settingsPath).mtimeMs
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('dry-run reports changes but writes nothing', async () => {
    // A tiny wait to ensure mtime difference is measurable if the
    // dry-run erroneously writes (fs mtime resolution varies).
    await new Promise(r => setTimeout(r, 20))
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, dryRun: true, env: { HOME: home, DISCORD_BOT_TOKEN: 'test-token-cycle1' }, skipExecutableBitCheck: true, skipClaudeMcpAdd: true })
    expect(res.ok).toBe(true)
    expect(res.dryRun).toBe(true)
    expect(res.settingsChanged).toBe(false)
    expect(res.backupPath).toBeNull()
    expect(res.dryRunDiff).toBeDefined()
    expect((res.dryRunDiff ?? []).length).toBeGreaterThan(0)
  })

  test('settings.json mtime is unchanged after dry-run', () => {
    const mtimeAfter = statSync(settingsPath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  test('no .bak files created during dry-run', () => {
    const entries = readdirSync(claudeHome)
    const bak = entries.filter(n => n.includes('.bak.'))
    expect(bak).toEqual([])
  })
})
