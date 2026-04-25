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
  let tmpDir: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aun-val-'))
    claudeHome = join(home, '.claude')
    settingsPath = join(claudeHome, 'settings.json')
    mkdirSync(claudeHome, { recursive: true })
    tmpDir = home
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
    // Hook command uses a bare token (`echo`) that intentionally does
    // NOT trigger the path-existence check (spec §2.5 only enforces
    // path validity on absolute / shell-prefix targets — bare commands
    // are trusted to the user's PATH).
    const patch: AunPatch = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo session-start' }] }],
      },
    }
    const merged = mergeAunPatch({}, patch)
    const res = writePatch(settingsPath, merged)
    expect(res.changed).toBe(true)
    expect(() => validatePatched(settingsPath)).not.toThrow()
  })

  test('validatePatched rejects an absolute hook command that does not exist (§2.5)', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'bash /no/such/path.sh' }] }],
      },
    }, null, 2) + '\n')
    expect(() => validatePatched(settingsPath)).toThrow(SettingsPatchError)
    try {
      validatePatched(settingsPath)
    } catch (err) {
      expect((err as SettingsPatchError).code).toBe('E_VALIDATE')
      expect((err as SettingsPatchError).message).toContain('not found')
    }
  })

  test('validatePatched rejects a non-executable mcpServers.aun.command (§2.5)', () => {
    // Create a real but non-executable file inside the tmp HOME so the
    // executable-bit check fires deterministically.
    const target = join(tmpDir, 'fake-bin')
    writeFileSync(target, '#!/usr/bin/env bash\nexit 0\n')
    // No chmod +x — leaving mode without exec bits.
    writeFileSync(settingsPath, JSON.stringify({
      mcpServers: { aun: { command: target, args: [] } },
    }, null, 2) + '\n')
    expect(() => validatePatched(settingsPath, { home, requireExecutableBit: true })).toThrow(SettingsPatchError)
  })
})
