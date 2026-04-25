/**
 * `aun init` — idempotent first-time setup (spec v6 §1.2, transactional).
 *
 * 7 steps per §1.2:
 *   1. environment check (Bun / Node / Claude Code versions)
 *   2. ~/.aun/ created (config.json + .env template)
 *   3. DB init (SQLite default; PG migration if DATABASE_URL set)
 *   4. ~/.claude/plugins/aun/ plugin file placement
 *   5. ~/.claude/settings.json backup → patch → validate
 *   6. Discord token input (env / .env file / interactive prompt)
 *   7. completion summary
 *
 * Transactional intent: a failure at any step surfaces a clear error
 * and leaves the user's settings.json as it was (via backup-restore).
 * Step 1-4 are idempotent and safe to retry; step 5 is the only
 * destructive-to-filesystem step and is guarded by the settings-patch
 * library's backup + validate + auto-restore flow.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  readSettings,
  mergeAunPatch,
  writePatch,
  diffPatch,
  type AunPatch,
  type HookRegistration,
  type ClaudeSettings,
  SettingsPatchError,
} from './lib/settings-patch'
import { captureSignatures, saveBaseline } from './lib/cli-signature-verify'

export interface InitOptions {
  home?: string                       // override for tests ($HOME)
  claudeHome?: string                 // override ~/.claude for tests
  repoRoot?: string                   // override path to agent-comms-mcp source
  dryRun?: boolean
  force?: boolean                      // allow mcpServers.aun override + env conflict override
  interactive?: boolean                // prompt for Discord token
  env?: NodeJS.ProcessEnv              // injected env (tests)
  now?: Date
  /** Discord token from `--token` flag or test injection. Falls back to
   *  env DISCORD_BOT_TOKEN; if both are absent and no `~/.aun/.env`
   *  carries a token, init aborts (spec §1.2 step 6).
   */
  token?: string
  /** Skip version preflight — tests use this when running on an older
   *  Bun than the spec floor. Production users should never set this.
   */
  skipVersionCheck?: boolean
  /** Skip post-write validation — tests on hermetic tmp HOMEs use
   *  this when the placed plugin file is not chmod-executable on
   *  filesystems that ignore the mode bit.
   */
  skipExecutableBitCheck?: boolean
}

/** Spec v6 §1.2 step 1 — minimum versions of dependency CLIs. */
const VERSION_FLOOR = {
  bun: { major: 1, minor: 0, patch: 0 },
  node: { major: 20, minor: 0, patch: 0 },
  // Claude Code is the only one that can be missing entirely in CI;
  // missing → warn but don't block (the user might be running under
  // Codex / Gemini and only need the agent-comms server).
  claude: { major: 2, minor: 1, patch: 80 },
}

interface SemverComparison {
  ok: boolean
  detected: string | null
  required: string
  reason?: string
}

function parseSemver(s: string): { major: number; minor: number; patch: number } | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) }
}

function compareSemver(detected: { major: number; minor: number; patch: number }, floor: { major: number; minor: number; patch: number }): boolean {
  if (detected.major !== floor.major) return detected.major > floor.major
  if (detected.minor !== floor.minor) return detected.minor > floor.minor
  return detected.patch >= floor.patch
}

function checkBinVersion(bin: string, floor: { major: number; minor: number; patch: number }, required: string): SemverComparison {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
  if (r.status !== 0 && !r.stdout) {
    return { ok: false, detected: null, required, reason: `${bin} --version exited with status ${r.status}` }
  }
  const text = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  const semver = parseSemver(text)
  if (!semver) {
    return { ok: false, detected: text, required, reason: `${bin} --version output did not contain a parseable x.y.z` }
  }
  return {
    ok: compareSemver(semver, floor),
    detected: `${semver.major}.${semver.minor}.${semver.patch}`,
    required,
  }
}

function preflightVersions(): { ok: boolean; checks: Array<{ bin: string } & SemverComparison> } {
  const checks = [
    { bin: 'bun', ...checkBinVersion('bun', VERSION_FLOOR.bun, '1.0.0') },
    { bin: 'node', ...checkBinVersion('node', VERSION_FLOOR.node, '20.0.0') },
    { bin: 'claude', ...checkBinVersion('claude', VERSION_FLOOR.claude, '2.1.80') },
  ]
  // bun + node are hard requirements; claude missing is a warning only
  // (Codex / Gemini bots can still run agent-comms via stdio).
  const ok = checks
    .filter(c => c.bin === 'bun' || c.bin === 'node')
    .every(c => c.ok)
  return { ok, checks }
}

export interface InitResult {
  ok: boolean
  dryRun: boolean
  aunHome: string
  claudeSettingsPath: string
  backupPath: string | null
  settingsChanged: boolean
  dryRunDiff?: Array<Record<string, unknown>>
  errors: string[]
  summary: string[]
}

// PR-C #240 (merged) ships hooks/aun-send-tool-enforcement.sh in the repo.
// `aun init` copies it into ~/.claude/hooks/ so the Stop hook reference
// in settings.json resolves to a real, executable file (validation §2.5
// requires existence + executable bit). SessionStart is intentionally
// omitted from the spec v6 §1.3 optional list — claude/channel push
// (PR-A #241 merged) plus the Stop hook cover Phase C without an
// aun-owned SessionStart loader; tests for that flow live elsewhere.
const AUN_HOOK_MARKER_STOP = 'bash ~/.claude/hooks/aun-send-tool-enforcement.sh'
const AUN_HOOK_FILES = [
  { repoPath: 'hooks/aun-send-tool-enforcement.sh', destName: 'aun-send-tool-enforcement.sh' },
] as const

export function aunHookCommandMarkers(): string[] {
  return [AUN_HOOK_MARKER_STOP]
}

function homeFor(opts: InitOptions): string {
  return opts.home ?? opts.env?.HOME ?? homedir()
}
function claudeHomeFor(opts: InitOptions): string {
  return opts.claudeHome ?? join(homeFor(opts), '.claude')
}
function aunHomeFor(opts: InitOptions): string {
  return join(homeFor(opts), '.aun')
}

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return true
}

/** Lightweight DISCORD_BOT_TOKEN extractor — scans the file line-wise
 *  for `DISCORD_BOT_TOKEN=...`. Quotes are stripped. Comment lines
 *  (`# ...`) and empty `=` are ignored. Pulling a full dotenv parser
 *  for one key would over-couple this module to a runtime dependency.
 */
function extractTokenFromDotenv(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined
  try {
    const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/)
    for (const ln of lines) {
      const trimmed = ln.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const m = trimmed.match(/^DISCORD_BOT_TOKEN\s*=\s*(.*)$/)
      if (!m) continue
      let value = m[1].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (value !== '') return value
    }
  } catch {
    // Non-fatal — caller falls through to the "missing token" error.
  }
  return undefined
}

function resolveBunPath(opts: InitOptions): string {
  // Use the resolved bun binary when available so spec §2.5 validation
  // (mcpServers.aun.command must exist + be executable) succeeds. We
  // fall back to the bare command name `bun` when the resolution
  // somehow fails — production callers always have bun on PATH (we
  // verified that in step 1) and the bare name keeps the patch
  // portable across machines that may have bun in different prefixes.
  const which = spawnSync('which', ['bun'], { encoding: 'utf-8' })
  const path = (which.stdout ?? '').trim()
  if (path && path.startsWith('/') && existsSync(path)) return path
  return 'bun'
}

export function buildAunPatch(opts: InitOptions): AunPatch {
  const pluginDir = join(claudeHomeFor(opts), 'plugins', 'aun')
  const aunEntry = join(pluginDir, 'server.ts')
  const bunPath = resolveBunPath(opts)

  const stopHook: HookRegistration = {
    matcher: '',
    hooks: [{ type: 'command', command: AUN_HOOK_MARKER_STOP }],
  }

  return {
    hooks: {
      Stop: [stopHook],
    },
    mcpServers: {
      aun: {
        command: bunPath,
        // §1.4 frozen — startup flag verbatim.
        args: [
          aunEntry,
          '--dangerously-skip-permissions',
          '--dangerously-load-development-channels',
          'server:aun',
        ],
        env: {
          AUN_HOME: aunHomeFor(opts),
          AUN_LOG_LEVEL: 'info',
        },
      },
    },
    env: {
      AUN_HOME: aunHomeFor(opts),
      AUN_LOG_LEVEL: 'info',
    },
  }
}

export function init(opts: InitOptions = {}): InitResult {
  const errors: string[] = []
  const summary: string[] = []
  const aunHome = aunHomeFor(opts)
  const claudeHome = claudeHomeFor(opts)
  const claudeSettingsPath = join(claudeHome, 'settings.json')

  // Step 1: environment preflight — fail-fast if the dependency CLIs
  // are below the spec floor. `claude` missing degrades to a warning
  // because Codex / Gemini bots also use this MCP server.
  if (!opts.skipVersionCheck) {
    const pre = preflightVersions()
    for (const c of pre.checks) {
      if (c.bin === 'claude' && c.detected === null) {
        summary.push(`claude not detected — Claude Code optional, agent-comms also runs under Codex / Gemini`)
        continue
      }
      if (!c.ok) {
        const detail = c.detected ? `${c.bin} ${c.detected} < required ${c.required}` : `${c.bin} unavailable`
        errors.push(`spec v6 §1.2 step 1: ${detail} — aborting`)
      } else {
        summary.push(`${c.bin} ${c.detected} ≥ ${c.required} ✓`)
      }
    }
    if (errors.length > 0) {
      return { ok: false, dryRun: !!opts.dryRun, aunHome, claudeSettingsPath, backupPath: null, settingsChanged: false, errors, summary }
    }
  } else {
    summary.push('version preflight skipped (test mode)')
  }

  // Step 2: ~/.aun/ scaffolding (idempotent)
  mkdirSync(aunHome, { recursive: true })
  const configPath = join(aunHome, 'config.json')
  const envPath = join(aunHome, '.env')
  const createdConfig = writeIfMissing(configPath, JSON.stringify({
    version: 1,
    home: aunHome,
  }, null, 2) + '\n')
  const createdEnv = writeIfMissing(envPath, [
    '# aun environment — edit with your own values.',
    '# DISCORD_BOT_TOKEN=...',
    '# DATABASE_URL=postgres://localhost:5432/agent_comms',
    '',
  ].join('\n'))
  if (createdConfig) summary.push(`created ${configPath}`)
  if (createdEnv) summary.push(`created ${envPath}`)

  // Step 3: DB init — optional per §5 Open; we just record the
  //         intended path so `aun start` can initialise SQLite lazily
  //         on first DB touch. No destructive DB ops here.
  //         (Tests rely on DB init being lazy; see test_aun_init_fresh.)

  // Step 4: plugin + hook file placement (idempotent).
  //   plugin: server.ts → ~/.claude/plugins/aun/server.ts
  //   hooks : every entry in AUN_HOOK_FILES → ~/.claude/hooks/<destName>
  // Hook scripts are chmod-executable so spec §2.5 validation (existence
  // + executable bit) passes after the settings.json patch lands.
  const pluginDir = join(claudeHome, 'plugins', 'aun')
  mkdirSync(pluginDir, { recursive: true })
  const repoRoot = opts.repoRoot ?? process.cwd()
  const srcServer = join(repoRoot, 'server.ts')
  const destServer = join(pluginDir, 'server.ts')
  if (existsSync(srcServer) && !existsSync(destServer)) {
    try {
      cpSync(srcServer, destServer)
      summary.push(`placed plugin file at ${destServer}`)
    } catch (err) {
      errors.push(`plugin copy failed: ${(err as Error).message}`)
    }
  }
  const hookDir = join(claudeHome, 'hooks')
  mkdirSync(hookDir, { recursive: true })
  for (const spec of AUN_HOOK_FILES) {
    const src = join(repoRoot, spec.repoPath)
    const dest = join(hookDir, spec.destName)
    if (!existsSync(src)) {
      errors.push(`hook source missing in repo: ${spec.repoPath}`)
      continue
    }
    if (!existsSync(dest)) {
      try {
        cpSync(src, dest)
      } catch (err) {
        errors.push(`hook copy failed (${spec.destName}): ${(err as Error).message}`)
        continue
      }
    }
    // Force the executable bit on every init — re-running on a system
    // where the dest mode bits got dropped (network share, copy-from-
    // tarball) self-heals.
    try {
      const st = statSync(dest)
      const need = st.mode | 0o755
      if (st.mode !== need) {
        require('node:fs').chmodSync(dest, need)
      }
      summary.push(`placed hook ${dest}`)
    } catch (err) {
      errors.push(`hook chmod failed (${spec.destName}): ${(err as Error).message}`)
    }
  }

  // Step 5: settings.json patch (destructive; guarded by backup)
  const patch = buildAunPatch(opts)
  let base: ClaudeSettings = {}
  try {
    if (existsSync(claudeSettingsPath)) {
      base = readSettings(claudeSettingsPath)
    } else {
      mkdirSync(claudeHome, { recursive: true })
    }
  } catch (err) {
    errors.push(`settings.json read failed: ${(err as Error).message}`)
    return { ok: false, dryRun: !!opts.dryRun, aunHome, claudeSettingsPath, backupPath: null, settingsChanged: false, errors, summary }
  }

  if (opts.dryRun) {
    const d = diffPatch(base, patch, { force: opts.force })
    summary.push(`dry-run: ${d.length} change(s) would be applied`)
    return {
      ok: errors.length === 0,
      dryRun: true,
      aunHome,
      claudeSettingsPath,
      backupPath: null,
      settingsChanged: false,
      dryRunDiff: d as unknown as Array<Record<string, unknown>>,
      errors,
      summary,
    }
  }

  let backupPath: string | null = null
  let settingsChanged = false
  try {
    const merged = mergeAunPatch(base, patch, { force: opts.force })
    const res = writePatch(claudeSettingsPath, merged, {
      force: opts.force,
      now: opts.now,
      home: homeFor(opts),
      requireExecutableBit: !opts.skipExecutableBitCheck,
    })
    backupPath = res.backupPath
    settingsChanged = res.changed
    if (backupPath) summary.push(`backup at ${backupPath}`)
    if (settingsChanged) summary.push(`patched ${claudeSettingsPath}`)
    else summary.push(`${claudeSettingsPath} already up-to-date (idempotent)`)
  } catch (err) {
    if (err instanceof SettingsPatchError) {
      errors.push(`settings.json patch failed (${err.code}): ${err.message}`)
    } else {
      errors.push(`settings.json patch failed: ${(err as Error).message}`)
    }
  }

  // Step 6: Discord token resolution (spec §1.2 step 6 — abort if no
  // token surfaced through any of the three documented channels).
  // Order: (a) `--token` flag / opts.token, (b) DISCORD_BOT_TOKEN in
  // process env, (c) DISCORD_BOT_TOKEN in ~/.aun/.env (parsed line-
  // wise; we don't pull a full dotenv lib for one key).
  const tokenSources: Array<{ source: string; value: string | undefined }> = [
    { source: '--token flag', value: opts.token },
    { source: 'DISCORD_BOT_TOKEN env', value: (opts.env ?? process.env).DISCORD_BOT_TOKEN },
    { source: `${envPath} (DISCORD_BOT_TOKEN=)`, value: extractTokenFromDotenv(envPath) },
  ]
  const tokenHit = tokenSources.find(s => s.value && s.value.trim() !== '')
  if (tokenHit) {
    summary.push(`Discord token resolved from ${tokenHit.source}`)
  } else {
    errors.push(
      'spec v6 §1.2 step 6: no Discord token found. Pass --token <value>, set DISCORD_BOT_TOKEN, ' +
      `or add DISCORD_BOT_TOKEN= to ${envPath} before re-running aun init.`,
    )
  }

  // CLI signature baseline snapshot (first init only; later init calls
  // refresh the baseline so an intended upgrade is accepted silently).
  try {
    const sigs = captureSignatures()
    saveBaseline(sigs, join(aunHome, 'cli-baselines.json'))
    summary.push(`captured CLI signature baseline (${sigs.length} probes)`)
  } catch {
    summary.push('CLI signature baseline capture skipped (non-fatal)')
  }

  // Step 7: summary already accumulated; caller prints.
  return {
    ok: errors.length === 0,
    dryRun: false,
    aunHome,
    claudeSettingsPath,
    backupPath,
    settingsChanged,
    errors,
    summary,
  }
}
