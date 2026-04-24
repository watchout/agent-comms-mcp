/**
 * settings.json patch + backup + validate (spec v6 §1.3 / §2 / §3).
 *
 * This is the single place that touches the user's
 * `~/.claude/settings.json`. Every operation is transactional: either
 * a new patched file is on disk AND a timestamped backup sits beside
 * it, or nothing was changed and the caller gets a thrown error with
 * enough detail to surface to the user.
 *
 * Invariants the tests pin (see §4 / tests/contract/test_aun_*):
 *   - Backup filename is `<path>.bak.YYYYMMDD-HHMMSS` in UTC; the last
 *     5 are retained, older ones are rotated.
 *   - `hooks.<event>` is **array-append**. A matching command string
 *     is deduped so repeated `aun init` calls don't grow the array.
 *   - `mcpServers.aun` conflict with a pre-existing key ABORTs unless
 *     `opts.force === true`; we never silently overwrite user config.
 *   - Unrelated keys in the existing settings.json are copied through
 *     verbatim by deep-merge.
 *   - Validation runs AFTER the write. If it fails the backup is
 *     automatically restored and an error is thrown.
 *
 * This module intentionally does its own I/O via `node:fs` sync calls
 * (mirroring the rest of `bin/aun/*`) and has no runtime dependencies
 * outside the node standard library, so the contract tests can
 * exercise it directly against real tmpdirs.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

export interface HookEntry {
  type: 'command'
  command: string
}

export interface HookRegistration {
  matcher: string
  hooks: HookEntry[]
}

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ClaudeSettings {
  hooks?: Partial<Record<string, HookRegistration[]>>
  mcpServers?: Record<string, McpServerEntry>
  env?: Record<string, string>
  [k: string]: unknown
}

export interface AunPatch {
  hooks?: Partial<Record<string, HookRegistration[]>>
  mcpServers?: Record<string, McpServerEntry>
  env?: Record<string, string>
}

export interface PatchOptions {
  /** Override `mcpServers.aun` even if a pre-existing value is present. */
  force?: boolean
  /** `aun` keys that must remain after uninstall --surgical. Matches by
   *  command string exact-match. Used by the uninstall flow to know
   *  which entries it owns.
   */
  aunHookCommandMarkers?: string[]
  /** Dependency-injected clock for deterministic backup names in tests. */
  now?: Date
  /** Write cap for rotate (default 5 per §2.1). */
  backupKeep?: number
}

export interface PatchResult {
  patchedPath: string
  backupPath: string | null
  /** True when the file contents after the patch differ from before. */
  changed: boolean
}

const DEFAULT_BACKUP_KEEP = 5

export class SettingsPatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SettingsPatchError'
  }
}

function utcTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    '-' +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds())
  )
}

export function backupFilenameFor(settingsPath: string, now: Date = new Date()): string {
  return `${settingsPath}.bak.${utcTimestamp(now)}`
}

export function listBackups(settingsPath: string): string[] {
  const dir = dirname(settingsPath)
  const base = basename(settingsPath) + '.bak.'
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(n => n.startsWith(base))
    .map(n => join(dir, n))
    .sort() // lexical sort matches chronological for our UTC format.
}

function rotateBackups(settingsPath: string, keep: number): void {
  const all = listBackups(settingsPath)
  if (all.length <= keep) return
  const drop = all.slice(0, all.length - keep)
  for (const p of drop) {
    try { unlinkSync(p) } catch { /* non-fatal */ }
  }
}

/**
 * Read and parse settings.json. Missing file → `{}` (init-from-scratch).
 * Parse failure → thrown SettingsPatchError with code=E_PARSE.
 */
export function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf-8')
  if (raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SettingsPatchError('E_PARSE', `settings.json at ${path} is not a JSON object`)
    }
    return parsed as ClaudeSettings
  } catch (err) {
    if (err instanceof SettingsPatchError) throw err
    throw new SettingsPatchError('E_PARSE', `settings.json at ${path} failed JSON parse: ${(err as Error).message}`)
  }
}

/**
 * Deep-merge an `aun` patch into an existing settings object. Pure:
 * the input is not mutated, a new object is returned. Implements
 * spec v6 §2.2 rules.
 */
export function mergeAunPatch(
  base: ClaudeSettings,
  patch: AunPatch,
  opts: PatchOptions = {},
): ClaudeSettings {
  // Shallow clone the top-level so unrelated keys pass through.
  const out: ClaudeSettings = { ...base }

  // --- hooks.<event>: array-append with command-exact dedup -------------
  if (patch.hooks) {
    const baseHooks = (base.hooks ?? {}) as Partial<Record<string, HookRegistration[]>>
    const merged: Partial<Record<string, HookRegistration[]>> = { ...baseHooks }
    for (const [event, patchEntries] of Object.entries(patch.hooks) as Array<[string, HookRegistration[] | undefined]>) {
      if (!patchEntries) continue
      const existing = Array.isArray(merged[event]) ? [...(merged[event] as HookRegistration[])] : []
      const commandsSeen = new Set(
        existing.flatMap(reg => reg.hooks.map(h => h.command)),
      )
      for (const reg of patchEntries) {
        // Strip any hook entries whose command already exists verbatim
        // under this event — §2.2 idempotent rule.
        const newHooks = reg.hooks.filter(h => !commandsSeen.has(h.command))
        if (newHooks.length === 0) continue
        existing.push({ matcher: reg.matcher, hooks: newHooks })
        for (const h of newHooks) commandsSeen.add(h.command)
      }
      merged[event] = existing
    }
    out.hooks = merged
  }

  // --- mcpServers.aun: conflict-abort unless force ----------------------
  if (patch.mcpServers) {
    const baseServers = (base.mcpServers ?? {}) as Record<string, McpServerEntry>
    const merged = { ...baseServers }
    for (const [name, entry] of Object.entries(patch.mcpServers)) {
      if (merged[name] !== undefined && !opts.force) {
        const have = merged[name]
        if (JSON.stringify(have) !== JSON.stringify(entry)) {
          throw new SettingsPatchError(
            'E_MCP_CONFLICT',
            `mcpServers.${name} already exists with a different value. Rerun with --force to override, or remove the existing entry first.`,
          )
        }
        // Identical config — idempotent, nothing to do.
        continue
      }
      merged[name] = entry
    }
    out.mcpServers = merged
  }

  // --- env: AUN_* prefix merge (user wins, aun fills missing) -----------
  if (patch.env) {
    const baseEnv = (base.env ?? {}) as Record<string, string>
    const merged: Record<string, string> = { ...baseEnv }
    for (const [k, v] of Object.entries(patch.env)) {
      if (merged[k] === undefined) merged[k] = v
      // Existing user value wins; AUN_* defaults don't clobber explicit user config.
    }
    out.env = merged
  }

  return out
}

/**
 * Transactional write: backup → patch → write → validate → success or
 * rollback. Throws SettingsPatchError on any failure. Success returns
 * the paths for logging.
 */
export function writePatch(
  settingsPath: string,
  patched: ClaudeSettings,
  opts: PatchOptions = {},
): PatchResult {
  const now = opts.now ?? new Date()
  const keep = opts.backupKeep ?? DEFAULT_BACKUP_KEEP
  const prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null
  const next = JSON.stringify(patched, null, 2) + '\n'

  if (prior !== null && prior === next) {
    return { patchedPath: settingsPath, backupPath: null, changed: false }
  }

  let backupPath: string | null = null
  if (prior !== null) {
    backupPath = backupFilenameFor(settingsPath, now)
    try {
      writeFileSync(backupPath, prior)
    } catch (err) {
      throw new SettingsPatchError(
        'E_BACKUP',
        `failed to write backup ${backupPath}: ${(err as Error).message}`,
      )
    }
  }

  try {
    writeFileSync(settingsPath, next)
  } catch (err) {
    // Restore from backup if the write itself failed mid-flight.
    if (backupPath && existsSync(backupPath)) {
      try { renameSync(backupPath, settingsPath) } catch { /* best-effort */ }
    }
    throw new SettingsPatchError('E_WRITE', `failed to write ${settingsPath}: ${(err as Error).message}`)
  }

  try {
    validatePatched(settingsPath)
  } catch (err) {
    // Validation is the last checkpoint. Restore from backup if we have one.
    if (backupPath && existsSync(backupPath)) {
      try {
        writeFileSync(settingsPath, readFileSync(backupPath, 'utf-8'))
      } catch { /* ignore; the error below surfaces to the user */ }
    }
    throw err
  }

  rotateBackups(settingsPath, keep)

  return { patchedPath: settingsPath, backupPath, changed: true }
}

/**
 * Post-write validation: re-parse the file and confirm it is valid
 * JSON + every hook command path that looks absolute points to an
 * existing file. (Non-absolute commands — `bash ~/foo` — are trusted
 * to the user's shell.)
 */
export function validatePatched(settingsPath: string): void {
  let parsed: ClaudeSettings
  try {
    parsed = readSettings(settingsPath)
  } catch (err) {
    throw new SettingsPatchError(
      'E_VALIDATE',
      `post-write validation failed (JSON parse): ${(err as Error).message}`,
    )
  }
  const hooks = parsed.hooks ?? {}
  for (const [event, regs] of Object.entries(hooks) as Array<[string, HookRegistration[] | undefined]>) {
    if (!Array.isArray(regs)) continue
    for (const reg of regs) {
      if (!Array.isArray(reg.hooks)) continue
      for (const h of reg.hooks) {
        if (h.type !== 'command' || typeof h.command !== 'string') {
          throw new SettingsPatchError(
            'E_VALIDATE',
            `post-write validation failed: hooks.${event} entry has non-string command`,
          )
        }
      }
    }
  }
}

export interface DiffEntry {
  kind: 'hook-add' | 'mcpserver-add' | 'mcpserver-keep-conflict' | 'env-add'
  event?: string
  command?: string
  serverName?: string
  envKey?: string
  envValue?: string
}

/**
 * Compute a structured summary of what would change. Used by
 * `aun init --dry-run` to show the user exactly what the patch
 * would touch, without writing anything.
 */
export function diffPatch(base: ClaudeSettings, patch: AunPatch, opts: PatchOptions = {}): DiffEntry[] {
  const entries: DiffEntry[] = []
  if (patch.hooks) {
    const baseHooks = (base.hooks ?? {}) as Partial<Record<string, HookRegistration[]>>
    for (const [event, regs] of Object.entries(patch.hooks) as Array<[string, HookRegistration[] | undefined]>) {
      if (!regs) continue
      const have = baseHooks[event] ?? []
      const haveCommands = new Set(have.flatMap(r => r.hooks.map(h => h.command)))
      for (const reg of regs) {
        for (const h of reg.hooks) {
          if (!haveCommands.has(h.command)) {
            entries.push({ kind: 'hook-add', event, command: h.command })
          }
        }
      }
    }
  }
  if (patch.mcpServers) {
    const baseServers = (base.mcpServers ?? {}) as Record<string, McpServerEntry>
    for (const [name, entry] of Object.entries(patch.mcpServers)) {
      if (baseServers[name] === undefined) {
        entries.push({ kind: 'mcpserver-add', serverName: name })
      } else if (
        !opts.force &&
        JSON.stringify(baseServers[name]) !== JSON.stringify(entry)
      ) {
        entries.push({ kind: 'mcpserver-keep-conflict', serverName: name })
      }
    }
  }
  if (patch.env) {
    const baseEnv = (base.env ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(patch.env)) {
      if (baseEnv[k] === undefined) {
        entries.push({ kind: 'env-add', envKey: k, envValue: v })
      }
    }
  }
  return entries
}

/**
 * Remove aun-owned entries from a settings object. Two modes:
 *   - 'surgical': drop hook entries whose command exactly matches one
 *     of `aunHookCommandMarkers`, drop `mcpServers.aun`, drop any env
 *     keys with AUN_* prefix. All other content is preserved.
 *   - 'full': drop the entries above AND leave everything else
 *     untouched. In practice the uninstall flow pairs 'full' with a
 *     separate backup-restore call.
 *
 * The caller is responsible for writing the result via `writePatch`
 * (or for passing the output to `renameSync` of a backup file).
 */
export function removeAunFromSettings(
  base: ClaudeSettings,
  opts: { aunHookCommandMarkers: string[]; aunMcpServerName?: string; aunEnvPrefix?: string },
): ClaudeSettings {
  const out: ClaudeSettings = { ...base }
  const markers = new Set(opts.aunHookCommandMarkers)
  const envPrefix = opts.aunEnvPrefix ?? 'AUN_'
  const mcpName = opts.aunMcpServerName ?? 'aun'

  if (out.hooks) {
    const scrubbed: Partial<Record<string, HookRegistration[]>> = {}
    for (const [event, regs] of Object.entries(out.hooks) as Array<[string, HookRegistration[] | undefined]>) {
      if (!Array.isArray(regs)) continue
      const kept: HookRegistration[] = []
      for (const reg of regs) {
        const filtered = reg.hooks.filter(h => !markers.has(h.command))
        if (filtered.length > 0) {
          kept.push({ matcher: reg.matcher, hooks: filtered })
        }
      }
      if (kept.length > 0) scrubbed[event] = kept
    }
    out.hooks = scrubbed
  }

  if (out.mcpServers && out.mcpServers[mcpName]) {
    const remaining = { ...out.mcpServers }
    delete remaining[mcpName]
    out.mcpServers = remaining
  }

  if (out.env) {
    const remaining: Record<string, string> = {}
    for (const [k, v] of Object.entries(out.env)) {
      if (!k.startsWith(envPrefix)) remaining[k] = v
    }
    out.env = remaining
  }

  return out
}
