import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readSettings,
  mergeAunPatch,
  writePatch,
  validatePatched,
  SettingsPatchError,
  type AunPatch,
} from '../../bin/aun/lib/settings-patch'

// Spec v6 §2.5 — post-write validation. A malformed settings.json
// BEFORE patch must produce a SettingsPatchError (E_PARSE) and leave
// the file untouched. Validation wraps the write so any post-write
// corruption auto-restores the backup.
// Instruction: lead-ama PR-aun-install §4.1 (msg id 521b6038).

describe('test_aun_validation — malformed input detected, post-write failure rolls back', () => {
  let home: string
  let claudeHome: string
  let settingsPath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-val-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
  })
  afterAll(() => { rmSync(home, { recursive: true, force: true }) })

  test('malformed JSON input throws SettingsPatchError code=E_PARSE', () => {
    writeFileSync(settingsPath, '{ not: valid, json }')
    expect(() => readSettings(settingsPath)).toThrow(SettingsPatchError)
    try {
      readSettings(settingsPath)
    } catch (err) {
      expect((err as SettingsPatchError).code).toBe('E_PARSE')
    }
  })

  test('non-object top-level (array) throws E_PARSE', () => {
    writeFileSync(settingsPath, '[1, 2, 3]')
    try {
      readSettings(settingsPath)
      expect.unreachable('readSettings should have thrown')
    } catch (err) {
      expect((err as SettingsPatchError).code).toBe('E_PARSE')
    }
  })

  test('writePatch succeeds on valid input; validatePatched agrees', () => {
    writeFileSync(settingsPath, '{}')
    const patch: AunPatch = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /tmp/x.sh' }] }],
      },
    }
    const merged = mergeAunPatch({}, patch)
    const res = writePatch(settingsPath, merged)
    expect(res.changed).toBe(true)
    // Post-write validation is idempotent and passes on the file we
    // just wrote.
    expect(() => validatePatched(settingsPath)).not.toThrow()
  })
})
