/**
 * `aun status` — surface whether init ran, where the aun home is, and
 * a quick CLI signature summary. No side effects.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  latestBootstrapRuns: Array<{
    agentId: string
    runId: string
    status: string
    stage: string | null
    updatedAt: string | null
  }>
  summary: string[]
}

function latestBootstrapRuns(aunHome: string): StatusReport['latestBootstrapRuns'] {
  const root = join(aunHome, 'bootstrap')
  if (!existsSync(root)) return []
  const runs: Array<StatusReport['latestBootstrapRuns'][number] & { mtime: number }> = []
  for (const agentId of readdirSync(root)) {
    const agentDir = join(root, agentId)
    try {
      if (!statSync(agentDir).isDirectory()) continue
      for (const name of readdirSync(agentDir).filter((candidate) => candidate.endsWith('.json'))) {
        const path = join(agentDir, name)
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        const latestStage = Array.isArray(parsed.stages)
          ? [...parsed.stages].reverse().find((stage: any) => stage.status === 'passed' || stage.status === 'failed')?.stage ?? null
          : null
        runs.push({
          agentId,
          runId: String(parsed.run_id ?? name.slice(0, -5)),
          status: String(parsed.terminal_status ?? 'incomplete'),
          stage: latestStage,
          updatedAt: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
          mtime: statSync(path).mtimeMs,
        })
      }
    } catch {
      // A malformed or unreadable journal is reported by bootstrap itself;
      // status remains best-effort and never prints file contents.
    }
  }
  const latestByAgent = new Map<string, typeof runs[number]>()
  for (const run of runs.sort((a, b) => b.mtime - a.mtime)) {
    if (!latestByAgent.has(run.agentId)) latestByAgent.set(run.agentId, run)
  }
  return [...latestByAgent.values()].map(({ mtime: _, ...run }) => run)
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
  const bootstrapRuns = latestBootstrapRuns(aunHome)
  summary.push(`bootstrap runs: ${bootstrapRuns.length === 0 ? 'none' : bootstrapRuns.map((run) => `${run.agentId}=${run.status}`).join(', ')}`)

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
    latestBootstrapRuns: bootstrapRuns,
    summary,
  }
}
