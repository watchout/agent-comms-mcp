#!/usr/bin/env bun
/**
 * aun CLI entry point (spec v6 §1.1).
 *
 * Subcommands:
 *   - aun                    → init if missing, else start
 *   - aun init [--dry-run] [--force]
 *   - aun start [-- <extra args passed to claude>]
 *   - aun uninstall [--backup <path>] [--surgical]
 *   - aun status
 *   - aun --help / -h
 */
import { init } from './aun/init'
import { uninstall } from './aun/uninstall'
import { status } from './aun/status'
import { start } from './aun/start'

function printHelp(): void {
  const lines = [
    'aun — agent-comms install/start helper (spec v6)',
    '',
    'Usage:',
    '  aun                       run init if missing, else start',
    '  aun init [--dry-run] [--force]',
    '  aun start [-- <args...>]',
    '  aun uninstall [--backup <path>] [--surgical]',
    '  aun status',
    '  aun --help | -h',
    '',
    'Environment:',
    '  HOME                      $HOME base for ~/.aun and ~/.claude',
    '  DISCORD_BOT_TOKEN         required for aun start',
    '  DATABASE_URL              optional; SQLite used when unset',
    '',
    'Notes:',
    '  - init writes ~/.claude/settings.json after creating a timestamped',
    '    backup; the last 5 backups are retained.',
    '  - uninstall default restores the most recent backup; --surgical',
    '    removes only aun-owned entries and leaves user config intact.',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

interface ParsedArgs {
  subcommand: string
  flags: Record<string, string | boolean>
  extras: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  if (args.length === 0) return { subcommand: 'default', flags: {}, extras: [] }
  if (args[0] === '--help' || args[0] === '-h') return { subcommand: 'help', flags: {}, extras: [] }

  const [subcommand, ...rest] = args
  const flags: Record<string, string | boolean> = {}
  const extras: string[] = []
  let i = 0
  while (i < rest.length) {
    const tok = rest[i]
    if (tok === '--') {
      for (let j = i + 1; j < rest.length; j++) extras.push(rest[j])
      break
    }
    if (tok.startsWith('--')) {
      const key = tok.slice(2)
      const next = rest[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i += 2
      } else {
        flags[key] = true
        i += 1
      }
    } else {
      extras.push(tok)
      i += 1
    }
  }
  return { subcommand, flags, extras }
}

function printSummary(label: string, lines: string[], errors: string[]): void {
  for (const s of lines) process.stdout.write(`[${label}] ${s}\n`)
  for (const e of errors) process.stderr.write(`[${label}] error: ${e}\n`)
}

export function run(argv: string[] = process.argv): number {
  const { subcommand, flags, extras } = parseArgs(argv)

  switch (subcommand) {
    case 'help':
      printHelp()
      return 0
    case 'init': {
      const res = init({ dryRun: !!flags['dry-run'], force: !!flags.force })
      printSummary('aun init', res.summary, res.errors)
      if (res.dryRun && res.dryRunDiff) {
        process.stdout.write('\n--- dry-run diff ---\n')
        process.stdout.write(JSON.stringify(res.dryRunDiff, null, 2) + '\n')
      }
      return res.ok ? 0 : 1
    }
    case 'start': {
      const res = start({ extraArgs: extras, spawn: !flags['dry-run'] })
      printSummary('aun start', ['command: ' + res.commandLine.join(' '), ...res.driftWarnings], res.errors)
      return res.ok ? 0 : 1
    }
    case 'uninstall': {
      const res = uninstall({
        backup: typeof flags.backup === 'string' ? (flags.backup as string) : undefined,
        surgical: !!flags.surgical,
      })
      printSummary('aun uninstall', res.summary, res.errors)
      return res.ok ? 0 : 1
    }
    case 'status': {
      const res = status()
      printSummary('aun status', res.summary, [])
      return 0
    }
    case 'default': {
      // Prefer start if aun home already exists, else init.
      const sres = status()
      if (!sres.aunHomeExists || !sres.aunHookRegistered) {
        const r = init({})
        printSummary('aun (auto)', r.summary, r.errors)
        return r.ok ? 0 : 1
      }
      const r = start({})
      printSummary('aun (auto)', ['command: ' + r.commandLine.join(' '), ...r.driftWarnings], r.errors)
      return r.ok ? 0 : 1
    }
    default:
      process.stderr.write(`aun: unknown subcommand "${subcommand}". See aun --help.\n`)
      return 2
  }
}

if (import.meta.main) {
  const code = run(process.argv)
  process.exit(code)
}
