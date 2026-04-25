/**
 * `aun status` — surface whether init ran, where the aun home is, and
 * a quick CLI signature summary. No side effects.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readSettings, listBackups } from './lib/settings-patch'
import { loadBaseline } from './lib/cli-signature-verify'

export interface StatusOptions {
  home?: string
  claudeHome?: string
  env?: NodeJS.ProcessEnv
}

export interface StatusReport {
  aunHomeExists: boolean
  aunHome: string
  claudeSettingsExists: boolean
  claudeSettingsPath: string
  aunHookRegistered: boolean
  aunMcpServerRegistered: boolean
  backupCount: number
  cliBaselineExists: boolean
  cliBaselineProbeCount: number
  summary: string[]
}

const AUN_HOOK_SUBSTRING = 'aun-'

function homeFor(opts: StatusOptions): string {
  return opts.home ?? opts.env?.HOME ?? homedir()
}

export function status(opts: StatusOptions = {}): StatusReport {
  const aunHome = join(homeFor(opts), '.aun')
  const claudeSettingsPath = join(opts.claudeHome ?? join(homeFor(opts), '.claude'), 'settings.json')
  const summary: string[] = []
  const aunHomeExists = existsSync(aunHome)
  const claudeSettingsExists = existsSync(claudeSettingsPath)

  summary.push(`aun home: ${aunHome}${aunHomeExists ? '' : ' (missing)'}`)
  summary.push(`claude settings: ${claudeSettingsPath}${claudeSettingsExists ? '' : ' (missing)'}`)

  let aunHookRegistered = false
  let aunMcpServerRegistered = false
  if (claudeSettingsExists) {
    try {
      const settings = readSettings(claudeSettingsPath)
      const hookEvents = settings.hooks ?? {}
      for (const regs of Object.values(hookEvents)) {
        if (!Array.isArray(regs)) continue
        for (const reg of regs) {
          for (const h of reg.hooks) {
            if (h.command.includes(AUN_HOOK_SUBSTRING)) aunHookRegistered = true
          }
        }
      }
      const mcpServers = settings.mcpServers ?? {}
      if (mcpServers.aun !== undefined) aunMcpServerRegistered = true
    } catch (err) {
      summary.push(`settings parse error: ${(err as Error).message}`)
    }
  }
  summary.push(`aun hooks registered: ${aunHookRegistered ? 'yes' : 'no'}`)
  summary.push(`aun mcpServer registered: ${aunMcpServerRegistered ? 'yes' : 'no'}`)

  const backups = listBackups(claudeSettingsPath)
  summary.push(`settings.json backups: ${backups.length}`)

  const baseline = loadBaseline(join(aunHome, 'cli-baselines.json'))
  const baselineProbes = baseline?.signatures.length ?? 0
  summary.push(`CLI baseline: ${baseline ? `${baselineProbes} probe(s)` : 'not captured'}`)

  return {
    aunHomeExists,
    aunHome,
    claudeSettingsExists,
    claudeSettingsPath,
    aunHookRegistered,
    aunMcpServerRegistered,
    backupCount: backups.length,
    cliBaselineExists: baseline !== null,
    cliBaselineProbeCount: baselineProbes,
    summary,
  }
}
