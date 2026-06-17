#!/usr/bin/env bun
import {
  buildProtectedGateAdvancePlan,
  type ProtectedGateAdvancePlan,
} from '../core/pr-protected-gate-advance'

type Args = {
  pr?: number
  repo?: string
  expectedHead?: string
  route?: string
  evidenceUrl?: string
  execute: boolean
  help: boolean
}

type GhPrView = {
  number: number
  url: string
  state: string
  isDraft: boolean
  headRefOid: string
  mergeStateStatus: string
  labels: Array<{ name: string }>
  statusCheckRollup: Array<{
    name: string
    status: string
    conclusion: string
  }>
}

function usage(): string {
  return `Protected PR gate auto-advance

Usage:
  bun scripts/pr-protected-gate-advance.ts --pr <number> --head <sha> --route <ceo-approval|protected> [--repo owner/repo] [--evidence-url <url>] [--execute]

Defaults are dry-run. The script fails closed unless the PR is open, exact-head,
CLEAN, protected route, and has green Layer 0 + Audit signal checks. When
eligible, it applies the existing PR conveyor impl-to-l2 transition so the
GitHub work puller can dispatch L2 review from labels rather than a human relay.
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
    } else if (arg === '--route') {
      args.route = next()
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

function requireArg<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

function repoArgs(repo: string | undefined): string[] {
  return repo ? ['--repo', repo] : []
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

function fetchPr(pr: number, repo?: string): GhPrView {
  return runGhJson<GhPrView>([
    'pr',
    'view',
    String(pr),
    ...repoArgs(repo),
    '--json',
    'number,url,state,isDraft,headRefOid,mergeStateStatus,labels,statusCheckRollup',
  ])
}

function fetchLabels(repo?: string): string[] {
  return runGhJson<Array<{ name: string }>>([
    'label',
    'list',
    ...repoArgs(repo),
    '--limit',
    '500',
    '--json',
    'name',
  ]).map((label) => label.name)
}

function printPlan(plan: ProtectedGateAdvancePlan): void {
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
}

export function main(argv = Bun.argv.slice(2)): number {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }
  const prNumber = requireArg(args.pr, '--pr')
  const expectedHead = requireArg(args.expectedHead, '--head')
  const route = requireArg(args.route, '--route')
  const pr = fetchPr(prNumber, args.repo)
  const labels = fetchLabels(args.repo)
  const plan = buildProtectedGateAdvancePlan({
    prNumber,
    prUrl: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    expectedHead,
    currentHead: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus,
    route,
    labels: pr.labels.map((label) => label.name),
    availableLabels: labels,
    checks: pr.statusCheckRollup.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    evidenceUrl: args.evidenceUrl ?? pr.url,
    dryRun: !args.execute,
    repo: args.repo,
  })
  printPlan(plan)
  if (!plan.ok) return 2
  if (!args.execute || plan.gh_command.length === 0) return 0
  runGh(plan.gh_command.slice(1))
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
