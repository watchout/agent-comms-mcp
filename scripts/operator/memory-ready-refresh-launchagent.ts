#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'

const LABEL = 'com.agent-comms.operator.memory-ready-refresh'

type RenderOptions = {
  repoRoot: string
  bunPath: string
  databaseUrl: string
  denylist: string
  logRoot: string
  templatePath?: string
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function renderMemoryReadyRefreshLaunchAgent(options: RenderOptions): {
  content: string
  sha256: string
  template_path: string
} {
  const templatePath = options.templatePath ?? join(
    import.meta.dir,
    '..',
    '..',
    'config',
    'launchd',
    `${LABEL}.plist.template`,
  )
  const replacements: Record<string, string> = {
    __REPO_ROOT__: xml(resolve(options.repoRoot)),
    __BUN_PATH__: xml(resolve(options.bunPath)),
    __DATABASE_URL__: xml(options.databaseUrl),
    __STATE_DAEMON_AGENT_DENYLIST__: xml(options.denylist),
    __LOG_ROOT__: xml(resolve(options.logRoot)),
  }
  let content = readFileSync(templatePath, 'utf8')
  for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(key, value)
  const unresolved = content.match(/__[A-Z0-9_]+__/g)
  if (unresolved) throw new Error(`LAUNCHAGENT_TEMPLATE_UNRESOLVED:${unresolved.join(',')}`)
  return {
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    template_path: resolve(templatePath),
  }
}

function usage(): string {
  return `memory-ready refresher LaunchAgent renderer

Usage:
  bun scripts/operator/memory-ready-refresh-launchagent.ts render|install
    --repo-root <merged-checkout> --database-url <postgres-url>
    --denylist <exact-current-state-daemon-value>
    [--bun <path>] [--log-root <path>] [--output <path>] [--execute]

install is dry-run unless --execute is present. The caller must read the
current state-daemon denylist and pass it byte-for-byte; this helper never
adds or removes denylist entries.
`
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const command = argv.shift()
    if (command === '--help' || command === '-h') {
      process.stdout.write(usage())
      return 0
    }
    if (command !== 'render' && command !== 'install') throw new Error('command must be render or install')
    let repoRoot = ''
    let databaseUrl = ''
    let denylist = ''
    let bunPath = '/Users/yuji/.bun/bin/bun'
    let logRoot = '/Users/yuji/.agent-comms/operator/logs'
    let output = `/Users/yuji/Library/LaunchAgents/${LABEL}.plist`
    let execute = false
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index]
      const next = () => {
        const value = argv[++index]
        if (!value) throw new Error(`${arg} requires a value`)
        return value
      }
      if (arg === '--repo-root') repoRoot = next()
      else if (arg === '--database-url') databaseUrl = next()
      else if (arg === '--denylist') denylist = next()
      else if (arg === '--bun') bunPath = next()
      else if (arg === '--log-root') logRoot = next()
      else if (arg === '--output') output = next()
      else if (arg === '--execute') execute = true
      else throw new Error(`unknown argument: ${arg}`)
    }
    if (!repoRoot || !databaseUrl || !denylist) throw new Error('--repo-root, --database-url, and --denylist are required')
    const rendered = renderMemoryReadyRefreshLaunchAgent({ repoRoot, bunPath, databaseUrl, denylist, logRoot })
    let rollbackPath: string | null = null
    let priorPlistSha256: string | null = null
    if (command === 'install' && execute) {
      mkdirSync(dirname(output), { recursive: true })
      mkdirSync(logRoot, { recursive: true })
      const staged = `${output}.new`
      writeFileSync(staged, rendered.content, { mode: 0o600 })
      execFileSync('/usr/bin/plutil', ['-lint', staged], { stdio: 'ignore' })
      if (existsSync(output)) {
        const prior = readFileSync(output)
        priorPlistSha256 = createHash('sha256').update(prior).digest('hex')
        rollbackPath = `${output}.rollback-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`
        copyFileSync(output, rollbackPath)
      }
      renameSync(staged, output)
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command,
      execute,
      output: resolve(output),
      plist_sha256: rendered.sha256,
      template_path: rendered.template_path,
      denylist_changed: false,
      prior_plist_sha256: priorPlistSha256,
      rollback_path: rollbackPath,
    })}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`memory-ready-refresh-launchagent: ${(error as Error).message}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(await main())
