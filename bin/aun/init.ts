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
  /** Skip the cycle 3 step 5a `claude mcp add` shell-out (tests that
   *  don't want the side effect on the host's `~/.claude.json`).
   */
  skipClaudeMcpAdd?: boolean
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
// requires existence + executable bit).
//
// Issue #278 cycle 4 (auditor BLOCK 3) — the inbox gate
// (`aun-pre-tool-use-inbox-gate.sh` + `pre-tool-use-inbox-gate.ts`)
// must also be installed and wired into PreToolUse via `aun init`.
// Cycle 3 shipped the hook files in repo `hooks/` but did not extend
// the installer, so PreToolUse enforcement never ran in production.
// We therefore: (a) copy both the bash wrapper and the bun runner
// into `~/.claude/hooks/`, and (b) register a PreToolUse matcher in
// the AUN patch alongside the existing Stop entry. SessionStart
// drain + Stop hook v8 (claim-close-enforcement) installer wiring
// is intentionally NOT touched in this commit (auditor's must-fix
// list calls out the inbox gate only); a follow-up Issue covers
// the same upgrade for those hooks.
const AUN_HOOK_MARKER_STOP = 'bash ~/.claude/hooks/aun-send-tool-enforcement.sh'
const AUN_HOOK_MARKER_PRE_TOOL_USE_INBOX_GATE = 'bash ~/.claude/hooks/aun-pre-tool-use-inbox-gate.sh'
const AUN_HOOK_FILES = [
  { repoPath: 'hooks/aun-send-tool-enforcement.sh', destName: 'aun-send-tool-enforcement.sh' },
  // Cycle 4 — wrapper + runner pair for the PreToolUse inbox gate.
  // The bun TS runner is sibling to the wrapper so the wrapper's
  // `bun hooks/pre-tool-use-inbox-gate.ts` invocation works after
  // copy.
  { repoPath: 'hooks/aun-pre-tool-use-inbox-gate.sh', destName: 'aun-pre-tool-use-inbox-gate.sh' },
  { repoPath: 'hooks/pre-tool-use-inbox-gate.ts', destName: 'pre-tool-use-inbox-gate.ts' },
] as const

export function aunHookCommandMarkers(): string[] {
  return [AUN_HOOK_MARKER_STOP, AUN_HOOK_MARKER_PRE_TOOL_USE_INBOX_GATE]
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
  // Cycle 3: aun owns only the Stop hook + AUN_* env in
  // ~/.claude/settings.json. mcpServers.aun is registered separately
  // in ~/.claude.json by `claude mcp add --scope user` (step 5a).
  // This mirrors spec v6 §1.3.1 verbatim.
  //
  // Issue #278 cycle 4 (auditor BLOCK 3) — also register the
  // PreToolUse inbox gate so the new hook actually runs after `aun
  // init`. Empty matcher = applies to every tool; the runner itself
  // owns the allow-list (next / send / notify / skip / fail /
  // reclaim) so we don't have to mirror it here in regex form.
  const stopHook: HookRegistration = {
    matcher: '',
    hooks: [{ type: 'command', command: AUN_HOOK_MARKER_STOP }],
  }
  const preToolUseInboxGate: HookRegistration = {
    matcher: '',
    hooks: [{ type: 'command', command: AUN_HOOK_MARKER_PRE_TOOL_USE_INBOX_GATE }],
  }
  return {
    hooks: {
      Stop: [stopHook],
      PreToolUse: [preToolUseInboxGate],
    },
    env: {
      AUN_HOME: aunHomeFor(opts),
      AUN_LOG_LEVEL: 'info',
    },
  }
}

// --- Cycle 3: claude mcp add CLI shell-out (spec §1.3.1 + step 5a) -----

export class ClaudeMcpAddError extends Error {
  constructor(public readonly stderr: string, message: string) {
    super(message)
    this.name = 'ClaudeMcpAddError'
  }
}

export class ClaudeNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeNotFoundError'
  }
}

export class BundleBuildError extends Error {
  constructor(public readonly stderr: string, message: string) {
    super(message)
    this.name = 'BundleBuildError'
  }
}

// Cycle 4 — `aun init` bundles the MCP server entry into a single
// JS file so `bun ~/.claude/plugins/aun/server.bundled.js` resolves
// every relative import (`./core/db`, `./adapters/discord`, ...) and
// every npm dep (`pg`, `@modelcontextprotocol/sdk`, `zod`, ...) at
// runtime without needing the source repo or a sibling node_modules
// at the install dest. cycle 3 placed `server.ts` standalone, which
// failed at runtime because sibling imports were missing — see PR
// #243 cycle 4 dispatch (lead-ama 04-27 14:32 JST) for the root
// cause and the (a) bundle vs (b) tree-copy decision.
function buildBundle(
  srcPath: string,
  destPath: string,
  repoRoot: string,
  env?: NodeJS.ProcessEnv,
): { sizeBytes: number } {
  // Merge so caller-supplied env (tests) overrides specific vars but
  // PATH / BUN_INSTALL / etc. stay so `bun build` can find bun.
  const spawnEnv = env ? { ...process.env, ...env } : process.env
  const result = spawnSync('bun', [
    'build',
    srcPath,
    '--target=bun',
    '--outfile', destPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 60_000,
    env: spawnEnv,
  })
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `exit ${result.status}`
    throw new BundleBuildError(stderr, `bun build failed for ${srcPath}: ${stderr}`)
  }
  if (!existsSync(destPath)) {
    throw new BundleBuildError('output file missing', `bun build returned 0 but output ${destPath} not present`)
  }
  const sizeBytes = statSync(destPath).size
  if (sizeBytes < 1024) {
    throw new BundleBuildError(`output ${sizeBytes} bytes`, `bun build output suspiciously small (${sizeBytes} bytes), expected MB-scale bundle`)
  }
  return { sizeBytes }
}

/**
 * Step 5a — register the aun server in `~/.claude.json` via the
 * official Claude Code CLI. Idempotent: pre-removing any existing
 * `aun` user-scope entry before re-adding makes repeat `aun init`
 * runs converge on a single, current entry without depending on the
 * CLI's own --force semantics (which differ across Claude Code
 * versions). Both pre-remove and add are gated on a 10s timeout
 * (spec §2.4); a non-zero add exit raises ClaudeMcpAddError so the
 * caller can surface stderr and abort init cleanly.
 */
export function registerAunViaClaude(opts: InitOptions): {
  command: string
  bunPath: string
  serverPath: string
  preRemoveStderr: string
} {
  const pluginDir = join(claudeHomeFor(opts), 'plugins', 'aun')
  // Cycle 4 — register the bundled JS, not source `server.ts`. The
  // bundle is self-contained (relative imports + npm deps inlined),
  // so `bun <bundle>` works without the source repo or an adjacent
  // node_modules.
  const aunEntry = join(pluginDir, 'server.bundled.js')
  const bunPath = resolveBunPath(opts)

  const claudeBin = (opts.env ?? process.env).AUN_CLAUDE_BIN || 'claude'
  const which = spawnSync('which', [claudeBin], { encoding: 'utf-8' })
  if ((which.stdout ?? '').trim() === '') {
    throw new ClaudeNotFoundError(
      `claude CLI not found on PATH (looked up "${claudeBin}"). Install Claude Code (≥ 2.1.80) or set AUN_CLAUDE_BIN to an absolute path before re-running aun init.`,
    )
  }

  // Pre-remove (best-effort): ignore non-zero exit because the entry
  // may legitimately not exist yet on a fresh install.
  const removeArgs = ['mcp', 'remove', 'aun', '--scope', 'user']
  const removeResult = spawnSync(claudeBin, removeArgs, {
    encoding: 'utf-8',
    timeout: 10_000,
    env: opts.env ?? process.env,
  })
  const preRemoveStderr = (removeResult.stderr ?? '').trim()

  // Add the user-scope entry. command + args mirror the spec §1.3.1
  // example: `claude mcp add --scope user --transport stdio aun -- <bun> <server.ts>`.
  // The `--` terminates flag parsing so the server.ts path can't be
  // mistaken for a CLI option.
  const addArgs = [
    'mcp', 'add',
    '--scope', 'user',
    '--transport', 'stdio',
    'aun',
    '--',
    bunPath,
    aunEntry,
  ]
  const addResult = spawnSync(claudeBin, addArgs, {
    encoding: 'utf-8',
    timeout: 10_000,
    env: opts.env ?? process.env,
  })
  if (addResult.status !== 0) {
    const stderr = (addResult.stderr ?? '').trim() || (addResult.stdout ?? '').trim() || `exit ${addResult.status}`
    throw new ClaudeMcpAddError(
      stderr,
      `claude mcp add (--scope user) failed with status ${addResult.status}: ${stderr}`,
    )
  }

  return {
    command: `${claudeBin} ${addArgs.join(' ')}`,
    bunPath,
    serverPath: aunEntry,
    preRemoveStderr,
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
  //   plugin: bundle of server.ts → ~/.claude/plugins/aun/server.bundled.js
  //   hooks : every entry in AUN_HOOK_FILES → ~/.claude/hooks/<destName>
  // Cycle 4 — bundle the entry with `bun build --target=bun` so the
  // placed file resolves `./core/db`, `./adapters/*`, and npm deps
  // (`pg`, `@modelcontextprotocol/sdk`, `zod`) at runtime without
  // needing the source repo or an adjacent node_modules at the
  // install dest. Cycle 3 placed source `server.ts` alone and the
  // MCP server failed at startup with MODULE_NOT_FOUND on sibling
  // imports — webb-dev pilot 04-27 14:20 JST root cause.
  // Hook scripts are chmod-executable so spec §2.5 validation (existence
  // + executable bit) passes after the settings.json patch lands.
  const pluginDir = join(claudeHome, 'plugins', 'aun')
  mkdirSync(pluginDir, { recursive: true })
  const repoRoot = opts.repoRoot ?? process.cwd()
  const srcServer = join(repoRoot, 'server.ts')
  const destBundle = join(pluginDir, 'server.bundled.js')
  if (existsSync(srcServer)) {
    try {
      const built = buildBundle(srcServer, destBundle, repoRoot, opts.env)
      summary.push(`bundled plugin entry at ${destBundle} (${built.sizeBytes} bytes)`)
    } catch (err) {
      if (err instanceof BundleBuildError) {
        errors.push(`plugin bundle failed: ${err.message} (stderr: ${err.stderr.slice(0, 200)})`)
      } else {
        errors.push(`plugin bundle failed: ${(err as Error).message}`)
      }
    }
  } else {
    errors.push(`plugin source missing in repo: ${srcServer}`)
  }
  // Cycle 5 axis 3 — abort before Step 5a if the bundle failed.
  // Otherwise `claude mcp add` would register a path that doesn't
  // exist (or a stale leftover from a previous install), and a
  // failed install would still mutate `~/.claude.json`. The user
  // would then need a manual cleanup of the broken entry, which
  // matches the webb-dev pilot pain we're explicitly trying to
  // avoid. Mirrors the Step 1 early-return pattern.
  if (errors.length > 0) {
    return { ok: false, dryRun: !!opts.dryRun, aunHome, claudeSettingsPath, backupPath: null, settingsChanged: false, errors, summary }
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

  // Step 5a: register the aun MCP server in ~/.claude.json via the
  // official `claude mcp add --scope user` CLI (spec v6 §1.3.1).
  // Skipped in dry-run + when explicitly opted out for tests.
  if (!opts.dryRun && !opts.skipClaudeMcpAdd) {
    try {
      const r = registerAunViaClaude(opts)
      summary.push(`claude mcp add (user scope) registered aun → ${r.serverPath}`)
    } catch (err) {
      if (err instanceof ClaudeNotFoundError) {
        errors.push(err.message)
      } else if (err instanceof ClaudeMcpAddError) {
        errors.push(err.message)
      } else {
        errors.push(`claude mcp add failed: ${(err as Error).message}`)
      }
      // Abort early — do not patch settings.json after a CLI-side
      // register failure, because step 5b would land us in a half-
      // configured state with hooks pointing at an unregistered server.
      return { ok: false, dryRun: false, aunHome, claudeSettingsPath, backupPath: null, settingsChanged: false, errors, summary }
    }
  }

  // Step 5b: settings.json hooks-only patch (destructive; guarded by backup).
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

  // Step 7: alias remediation message (spec §2.6 verbatim — never
  // auto-write the user's shell rc; just nudge them).
  summary.push('')
  summary.push('To make `claude` invoke the aun-aware launcher, add to your shell rc:')
  summary.push('    alias claude=\'aun start\'')
  summary.push('Or call `aun start` directly. See `aun start --help`.')

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
