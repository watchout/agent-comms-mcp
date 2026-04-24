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
  force?: boolean                      // allow mcpServers.aun override
  interactive?: boolean                // prompt for Discord token
  env?: NodeJS.ProcessEnv              // injected env (tests)
  now?: Date
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

const AUN_HOOK_MARKER_SESSION = 'bash ~/.claude/hooks/aun-loader.sh'
const AUN_HOOK_MARKER_STOP = 'bash ~/.claude/hooks/aun-send-tool-enforcement.sh'

export function aunHookCommandMarkers(): string[] {
  return [AUN_HOOK_MARKER_SESSION, AUN_HOOK_MARKER_STOP]
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

export function buildAunPatch(opts: InitOptions): AunPatch {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const pluginDir = join(claudeHomeFor(opts), 'plugins', 'aun')
  const aunEntry = join(pluginDir, 'server.ts')

  const sessionStart: HookRegistration = {
    matcher: '',
    hooks: [{ type: 'command', command: AUN_HOOK_MARKER_SESSION }],
  }
  const stopHook: HookRegistration = {
    matcher: '',
    hooks: [{ type: 'command', command: AUN_HOOK_MARKER_STOP }],
  }

  return {
    hooks: {
      SessionStart: [sessionStart],
      Stop: [stopHook],
    },
    mcpServers: {
      aun: {
        command: 'bun',
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

  // Step 1: environment check (informational; never block init — a
  // user might be on a slightly older claude and still have it work).
  const bunVersion = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).stdout?.trim()
  if (bunVersion) summary.push(`bun ${bunVersion} detected`)
  else summary.push('bun not detected (install before running aun start)')

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

  // Step 4: plugin directory (idempotent)
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

  // Step 6: Discord token hint (non-blocking; we just nudge the user).
  const tokenIn = (opts.env ?? process.env).DISCORD_BOT_TOKEN
  if (!tokenIn) {
    summary.push(`note: DISCORD_BOT_TOKEN not set; add it to ${envPath} or your shell env before aun start`)
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
