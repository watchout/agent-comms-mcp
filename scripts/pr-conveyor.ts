#!/usr/bin/env bun
import {
  buildGhPrEditCommand,
  buildPrConveyorPlan,
  type PrConveyorPlan,
} from '../core/pr-conveyor'

type Args = {
  pr?: number
  repo?: string
  expectedHead?: string
  transition?: string
  evidenceUrl?: string
  execute: boolean
  help: boolean
}

type GhPrView = {
  number: number
  url: string
  headRefOid: string
  labels: Array<{ name: string }>
}

function usage(): string {
  return `PR conveyor exact-head label controller

Usage:
  bun scripts/pr-conveyor.ts --pr <number> --head <sha> --transition <name> [--evidence-url <url>] [--repo owner/repo] [--execute]

Transitions:
  impl-to-l2     Implementation handoff requests L2 audit
  l2-pass        L2 audit passed at exact head
  needs-rework   Review failed and implementation rework is required
  check-pass     Check completed; merge authority review may proceed
  cto-go         Exact-head merge authority GO
  blocked        Protected/blocking condition

Defaults are dry-run. The script verifies the current PR head before planning
or applying labels. It never treats ACKs, queue IDs, Discord/TUI visibility, or
green CI alone as completion evidence.
`
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }
    if (arg === '--pr') {
      const value = Number.parseInt(next(), 10)
      if (!Number.isInteger(value)) throw new Error('--pr requires an integer')
      args.pr = value
    } else if (arg === '--repo') {
      args.repo = next()
    } else if (arg === '--head' || arg === '--expected-head') {
      args.expectedHead = next()
    } else if (arg === '--transition') {
      args.transition = next()
    } else if (arg === '--evidence-url') {
      args.evidenceUrl = next()
    } else if (arg === '--execute') {
      args.execute = true
    } else if (arg === '--dry-run') {
      args.execute = false
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function runGhJson<T>(args: string[]): T {
  const proc = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${proc.exitCode})\n${proc.stderr.toString()}`)
  }
  return JSON.parse(proc.stdout.toString()) as T
}

function runGh(args: string[]): void {
  const proc = Bun.spawnSync(['gh', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${proc.exitCode})\n${proc.stderr.toString()}`)
  }
}

function repoArgs(repo: string | undefined): string[] {
  return repo ? ['--repo', repo] : []
}

function fetchPr(pr: number, repo?: string): GhPrView {
  return runGhJson<GhPrView>([
    'pr',
    'view',
    String(pr),
    ...repoArgs(repo),
    '--json',
    'number,url,headRefOid,labels',
  ])
}

function fetchLabels(repo?: string): string[] {
  const labels = runGhJson<Array<{ name: string }>>([
    'label',
    'list',
    ...repoArgs(repo),
    '--limit',
    '500',
    '--json',
    'name',
  ])
  return labels.map((label) => label.name)
}

function printPlan(plan: PrConveyorPlan): void {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}

function requireArg<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

export function main(argv = Bun.argv.slice(2)): number {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }

  const prNumber = requireArg(args.pr, '--pr')
  const expectedHead = requireArg(args.expectedHead, '--head')
  const transition = requireArg(args.transition, '--transition')
  const pr = fetchPr(prNumber, args.repo)
  const availableLabels = fetchLabels(args.repo)

  const plan = buildPrConveyorPlan({
    prNumber,
    prUrl: pr.url,
    expectedHead,
    currentHead: pr.headRefOid,
    transition,
    currentLabels: pr.labels.map((label) => label.name),
    availableLabels,
    evidenceUrl: args.evidenceUrl,
    dryRun: !args.execute,
  })
  const executablePlan = {
    ...plan,
    gh_command: plan.ok ? buildGhPrEditCommand(prNumber, plan.add_labels, plan.remove_labels, args.repo) : [],
  }
  printPlan(executablePlan)

  if (!plan.ok) return 2
  if (!args.execute || (plan.add_labels.length === 0 && plan.remove_labels.length === 0)) return 0
  runGh(executablePlan.gh_command.slice(1))
  return 0
}

if (import.meta.main) {
  try {
    process.exit(main())
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
