/**
 * `aun uninstall` — spec v6 §1.5 rollback.
 *
 * Three modes:
 *   - auto (default)  : restore the most recent settings.json.bak.*
 *   - --backup <path> : restore from a specific backup file
 *   - --surgical      : keep the current settings.json but remove only
 *                       the aun-owned entries (hooks/mcpServers/env
 *                       scoped to AUN_* prefix and known command
 *                       markers). User-added hooks remain.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readSettings,
  removeAunFromSettings,
  listBackups,
  validatePatched,
} from './lib/settings-patch'
import { aunHookCommandMarkers } from './init'

export interface UninstallOptions {
  home?: string
  claudeHome?: string
  env?: NodeJS.ProcessEnv
  backup?: string              // explicit backup path
  surgical?: boolean
}

export interface UninstallResult {
  ok: boolean
  mode: 'auto' | 'backup' | 'surgical'
  restoredFrom: string | null
  claudeSettingsPath: string
  errors: string[]
  summary: string[]
}

function homeFor(opts: UninstallOptions): string {
  return opts.home ?? opts.env?.HOME ?? homedir()
}

export function uninstall(opts: UninstallOptions = {}): UninstallResult {
  const errors: string[] = []
  const summary: string[] = []
  const claudeHome = opts.claudeHome ?? join(homeFor(opts), '.claude')
  const claudeSettingsPath = join(claudeHome, 'settings.json')

  if (opts.surgical) {
    if (!existsSync(claudeSettingsPath)) {
      errors.push(`no settings.json at ${claudeSettingsPath}`)
      return { ok: false, mode: 'surgical', restoredFrom: null, claudeSettingsPath, errors, summary }
    }
    try {
      const current = readSettings(claudeSettingsPath)
      const scrubbed = removeAunFromSettings(current, {
        aunHookCommandMarkers: aunHookCommandMarkers(),
      })
      writeFileSync(claudeSettingsPath, JSON.stringify(scrubbed, null, 2) + '\n')
      validatePatched(claudeSettingsPath)
      summary.push(`surgical uninstall removed aun entries; user config preserved`)
      return { ok: true, mode: 'surgical', restoredFrom: null, claudeSettingsPath, errors, summary }
    } catch (err) {
      errors.push(`surgical uninstall failed: ${(err as Error).message}`)
      return { ok: false, mode: 'surgical', restoredFrom: null, claudeSettingsPath, errors, summary }
    }
  }

  if (opts.backup) {
    if (!existsSync(opts.backup)) {
      errors.push(`backup not found: ${opts.backup}`)
      return { ok: false, mode: 'backup', restoredFrom: null, claudeSettingsPath, errors, summary }
    }
    try {
      writeFileSync(claudeSettingsPath, readFileSync(opts.backup, 'utf-8'))
      validatePatched(claudeSettingsPath)
      summary.push(`restored from backup ${opts.backup}`)
      return { ok: true, mode: 'backup', restoredFrom: opts.backup, claudeSettingsPath, errors, summary }
    } catch (err) {
      errors.push(`backup restore failed: ${(err as Error).message}`)
      return { ok: false, mode: 'backup', restoredFrom: null, claudeSettingsPath, errors, summary }
    }
  }

  // Default: latest-backup auto-restore.
  const backups = listBackups(claudeSettingsPath)
  if (backups.length === 0) {
    errors.push(`no backups found for ${claudeSettingsPath}; pass --backup <path> or use --surgical`)
    return { ok: false, mode: 'auto', restoredFrom: null, claudeSettingsPath, errors, summary }
  }
  const latest = backups[backups.length - 1]
  try {
    writeFileSync(claudeSettingsPath, readFileSync(latest, 'utf-8'))
    validatePatched(claudeSettingsPath)
    summary.push(`restored from latest backup ${latest}`)
    return { ok: true, mode: 'auto', restoredFrom: latest, claudeSettingsPath, errors, summary }
  } catch (err) {
    errors.push(`latest-backup restore failed: ${(err as Error).message}`)
    return { ok: false, mode: 'auto', restoredFrom: null, claudeSettingsPath, errors, summary }
  }
}
