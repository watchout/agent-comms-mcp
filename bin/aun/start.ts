/**
 * `aun start` — thin wrapper that invokes `claude` with the aun-
 * approved flags (spec v6 §1.4 verbatim).
 *
 * This command assumes `aun init` has already run and settings.json
 * is patched; it only re-verifies CLI signatures against the stored
 * baseline and logs a warning on drift (informational, never blocks).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { captureSignatures, loadBaseline, compareToBaseline } from './lib/cli-signature-verify'

export interface StartOptions {
  home?: string
  env?: NodeJS.ProcessEnv
  /** When true the child is detached (for long-running sessions). */
  detach?: boolean
  /** Pass-through args appended to the claude invocation. */
  extraArgs?: string[]
  /** Run the pre-flight signature check (default true). */
  checkSignatures?: boolean
  /** Actually spawn claude (default true; tests set false for dry runs). */
  spawn?: boolean
}

export interface StartResult {
  ok: boolean
  commandLine: string[]
  driftWarnings: string[]
  spawned: boolean
  errors: string[]
}

export function start(opts: StartOptions = {}): StartResult {
  const errors: string[] = []
  const driftWarnings: string[] = []
  const home = opts.home ?? opts.env?.HOME ?? homedir()
  const aunHome = join(home, '.aun')
  const baselinePath = join(aunHome, 'cli-baselines.json')

  if (opts.checkSignatures !== false) {
    try {
      const baseline = loadBaseline(baselinePath)
      if (baseline) {
        const current = captureSignatures()
        const report = compareToBaseline(current, baseline)
        for (const d of report.drifted) {
          driftWarnings.push(`[cli-drift ${d.reason}] ${d.name}: ${d.diffSummary}`)
        }
      }
    } catch {
      // Signature check is best-effort; a failure here is purely
      // informational and never blocks start.
    }
  }

  // §1.4 flags verbatim.
  const commandLine = [
    'claude',
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'server:aun',
    ...(opts.extraArgs ?? []),
  ]

  if (opts.spawn === false) {
    return { ok: true, commandLine, driftWarnings, spawned: false, errors }
  }

  try {
    spawn(commandLine[0], commandLine.slice(1), {
      stdio: 'inherit',
      detached: !!opts.detach,
      env: opts.env ?? process.env,
    })
    return { ok: true, commandLine, driftWarnings, spawned: true, errors }
  } catch (err) {
    errors.push(`claude spawn failed: ${(err as Error).message}`)
    return { ok: false, commandLine, driftWarnings, spawned: false, errors }
  }
}
