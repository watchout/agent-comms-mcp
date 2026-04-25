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
  /** Validation `home` override (tests use a tmp HOME). */
  home?: string
  /** Validation executable-bit toggle (default true). */
  requireExecutableBit?: boolean
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

  // --- env: AUN_* prefix merge with fail-fast on value conflict ---------
  // Spec v6 §2.2 — an existing env key that *differs* from the aun patch
  // must abort, not silently keep the stale user value. Silent keep
  // (the previous behaviour) leaves the bot running under a config that
  // mismatches the documented installer state, which is the exact
  // confusion class the spec calls out. Identical or missing values
  // stay idempotent; `--force` lets an operator who knows what they're
  // doing override after a conscious decision.
  if (patch.env) {
    const baseEnv = (base.env ?? {}) as Record<string, string>
    const merged: Record<string, string> = { ...baseEnv }
    for (const [k, v] of Object.entries(patch.env)) {
      const existing = merged[k]
      if (existing === undefined) {
        merged[k] = v
        continue
      }
      if (existing === v) continue // idempotent — same value, no change
      if (opts.force) {
        merged[k] = v
        continue
      }
      throw new SettingsPatchError(
        'E_ENV_CONFLICT',
        `env.${k} already set to "${existing}" but aun expects "${v}". ` +
        `Rerun with --force to override, or unset env.${k} in ~/.claude/settings.json before re-running aun init.`,
      )
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
    validatePatched(settingsPath, { home: opts.home, requireExecutableBit: opts.requireExecutableBit })
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

export interface ValidationOptions {
  /** Resolve `~` and `$HOME` for absolute-path checks. Defaults to
   *  `process.env.HOME`. Tests pass an isolated tmp HOME so the
   *  reachability check exercises the actual file we care about.
   */
  home?: string
  /** When true, bin/script paths must have at least one executable bit
   *  set. Defaults to true; tests can opt out for portability quirks
   *  (e.g. WSL DrvFs shows non-x bits even on bash scripts).
   */
  requireExecutableBit?: boolean
}

interface CommandReachability {
  command: string
  resolvedPath: string | null
  reason: 'ok' | 'absolute-missing' | 'absolute-not-executable' | 'shell-prefix-target-missing' | 'unresolvable'
}

/** Crude tokenizer for hook / mcpServers commands. The shapes we
 *  see in practice are: `/abs/path/script.sh`,
 *  `bash /abs/path/script.sh`, `bash ~/.claude/hooks/x.sh`, or
 *  `bin` alone (e.g. `bun`). Anything else falls through as
 *  unresolvable, which we treat as a non-fatal warning rather than
 *  a hard fail (a future shape we can't anticipate shouldn't break
 *  init).
 */
function inspectCommand(command: string, home: string): CommandReachability {
  const trimmed = command.trim()
  if (trimmed === '') return { command, resolvedPath: null, reason: 'unresolvable' }
  const tokens = trimmed.split(/\s+/)
  // Pattern: `bash <path>` or `sh <path>` or `node <path>` etc.
  const shellPrefixes = new Set(['bash', 'sh', 'zsh', 'node', 'bun', 'python', 'python3'])
  if (tokens.length >= 2 && shellPrefixes.has(tokens[0])) {
    const target = expandHome(tokens[1], home)
    if (target.startsWith('/') && !existsSync(target)) {
      return { command, resolvedPath: target, reason: 'shell-prefix-target-missing' }
    }
    return { command, resolvedPath: target, reason: 'ok' }
  }
  // Single token — could be a bin name on PATH (we don't try to
  // resolve PATH; that's the user's shell's job) or an absolute
  // command. Only absolute paths are checked.
  if (tokens[0].startsWith('/')) {
    if (!existsSync(tokens[0])) {
      return { command, resolvedPath: tokens[0], reason: 'absolute-missing' }
    }
    return { command, resolvedPath: tokens[0], reason: 'ok' }
  }
  if (tokens[0].startsWith('~/')) {
    const expanded = expandHome(tokens[0], home)
    if (!existsSync(expanded)) {
      return { command, resolvedPath: expanded, reason: 'absolute-missing' }
    }
    return { command, resolvedPath: expanded, reason: 'ok' }
  }
  return { command, resolvedPath: null, reason: 'unresolvable' }
}

function expandHome(p: string, home: string): string {
  if (p === '~' || p.startsWith('~/')) return p === '~' ? home : `${home}${p.slice(1)}`
  return p
}

function isExecutable(absPath: string): boolean {
  try {
    const st = statSync(absPath)
    return (st.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Post-write validation: re-parse the file and confirm it is valid
 * JSON, every hook entry has a string `command`, and aun-owned
 * absolute command targets actually exist + carry an executable bit.
 *
 * Spec v6 §2.5 lists three reachability checks:
 *   - existing hook command paths still resolve
 *   - mcpServers.aun.command resolves
 *   - mcpServers.aun.command has the executable bit set
 *
 * Failure throws `SettingsPatchError(code='E_VALIDATE')`. The caller
 * (`writePatch`) catches that and restores the backup, so a broken
 * patch never lingers on disk.
 *
 * Non-absolute commands (bare `bun`, `claude`, etc.) are trusted to
 * the user's shell PATH — verifying PATH membership is out of scope
 * because (a) PATH varies per process and (b) it's the operator's
 * responsibility, not the installer's.
 */
export function validatePatched(settingsPath: string, opts: ValidationOptions = {}): void {
  const home = opts.home ?? process.env.HOME ?? ''
  const requireExec = opts.requireExecutableBit ?? true
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
        const r = inspectCommand(h.command, home)
        if (r.reason === 'absolute-missing' || r.reason === 'shell-prefix-target-missing') {
          throw new SettingsPatchError(
            'E_VALIDATE',
            `post-write validation failed: hooks.${event} command target not found: ${r.resolvedPath ?? h.command}`,
          )
        }
      }
    }
  }
  // mcpServers.aun: command must resolve + carry executable bit.
  const aunServer = parsed.mcpServers?.aun
  if (aunServer) {
    const r = inspectCommand(aunServer.command, home)
    if (r.reason === 'absolute-missing' || r.reason === 'shell-prefix-target-missing') {
      throw new SettingsPatchError(
        'E_VALIDATE',
        `post-write validation failed: mcpServers.aun.command target not found: ${r.resolvedPath ?? aunServer.command}`,
      )
    }
    if (requireExec && r.resolvedPath && r.resolvedPath.startsWith('/') && !isExecutable(r.resolvedPath)) {
      throw new SettingsPatchError(
        'E_VALIDATE',
        `post-write validation failed: mcpServers.aun.command is not executable: ${r.resolvedPath} (chmod +x to fix)`,
      )
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
