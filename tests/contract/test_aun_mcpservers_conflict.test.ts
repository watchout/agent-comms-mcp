import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { init } from '../../bin/aun/init'
import { readSettings } from '../../bin/aun/lib/settings-patch'

// Spec v6 §3.1 #2 — mcpServers.aun conflict (pre-existing, different
// shape) must ABORT unless --force is passed. With --force, the
// override proceeds and a backup is retained.
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

describe('test_aun_mcpservers_conflict — abort without --force, override with --force', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string
  const conflictFixture = readFileSync(
    join(REPO_ROOT, 'tests', 'fixtures', 'aun-init', 'existing-aun-mcpserver.json'),
    'utf-8',
  )

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-conflict-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    writeFileSync(settingsPath, conflictFixture)
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('without --force: abort with error and settings.json unchanged', () => {
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, env: { HOME: home } })
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThan(0)
    const joined = res.errors.join('\n')
    expect(joined).toMatch(/E_MCP_CONFLICT|already exists/)
    // settings.json content must still match the fixture (not overwritten).
    expect(readFileSync(settingsPath, 'utf-8')).toBe(conflictFixture)
  })

  test('with --force: override succeeds, aun entry reflects new config', () => {
    const res = init({ home, claudeHome, repoRoot: REPO_ROOT, force: true, env: { HOME: home } })
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
    const s = readSettings(settingsPath)
    const args = (s.mcpServers?.aun?.args ?? []).join(' ')
    expect(args).toContain('--dangerously-load-development-channels')
    expect(args).not.toMatch(/--legacy/) // old fixture value gone
  })
})
