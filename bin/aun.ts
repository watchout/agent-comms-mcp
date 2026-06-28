#!/usr/bin/env bun
/**
 * aun CLI entry point (spec v6 §1.1).
 *
 * Subcommands:
 *   - aun                    → init if missing, else start
 *   - aun init [--dry-run] [--force]
 *   - aun start [-- <extra args passed to claude>]
 *   - aun receive --agent-id <id> [--queue-id <id>] [--dry-run]
 *   - aun next --agent-id <id> [--queue-id <id>] [--dry-run]
 *   - aun receive-actionable|next-actionable --agent-id <id> [--queue-id <id>] [--max-inspect <n>] [--dry-run]
 *   - aun diagnose-receive --agent-id <id> [--max-inspect <n>] [--dry-run]
 *   - aun reconcile --dry-run --agent-id <id> --limit <n> [--cursor <cursor>]
 *   - aun drain --agent-id <id> [--limit <n>] [--dry-run]
 *   - aun codex-runner --agent-id <id> [--queue-id <id>] [--limit <n>] [--ack-mentions <ids>] [--ack-content <text>] [--complete-no-reply --completion-reason <text>|--auto-final-reply]
 *   - aun codex-runner-preflight --agent-id <id> [--queue-id <id>] [--max-inspect <n>]
 *   - aun processing|done|record-no-reply --agent-id <id> --queue-id <id> [--reason <text>]
 *   - aun renew-claim --agent-id <id> --queue-id <id> [--reason <text>] [--ttl-seconds <n>]
 *   - aun memory-ready-bootstrap --agent-id <id> --runtime-instance-id <id> --session-name <name> --port <n> [--project <project>] [--dry-run]
 *   - aun runtime-v2 plan --agent-id <id> [--queue-id <id>] [--message-id <id>] [--created-after <ts>] --json
 *   - aun runtime-v2 claim --agent-id <id> --queue-id <id> --message-id <id> --created-after <ts> --dry-run --json
 *   - aun runtime-v2 claim --agent-id kodama --queue-id <id> --message-id <id> --created-after <ts> --live-canary --json
 *   - aun runtime-v2 --agent-id kodama [--queue-id <id>] [--message-id <id>] [--created-after <ts>] [--runtime echo|codex-exec|command-json] [--finalize] [--dry-run]
 *   - aun reply --agent-id <id> --content <text> --mentions <owner> [--queue-id <id>] [--message-id <uuid>] [--no-close|--close]
 *   - aun notify --agent-id <id> --channel-id <id> --content <text> --mentions <owner>
 *   - aun uninstall [--backup <path>] [--surgical]
 *   - aun status
 *   - aun --help / -h
 */
import { init } from './aun/init'
import { uninstall } from './aun/uninstall'
import { status } from './aun/status'
import { start } from './aun/start'
import { diagnoseReceive, drain, receive, receiveActionable, receiveTargeted, reconcile } from './aun/receive'
import { notify, reply } from './aun/reply'
import { codexRunnerTick } from './aun/codex-runner'
import { codexRunnerLifecyclePreflight } from './aun/codex-runner-preflight'
import { lifecycleTransition, renewClaim } from './aun/lifecycle'
import { memoryReadyBootstrap } from './aun/memory-ready'
import { runtimeV2, runtimeV2ClaimDryRun, runtimeV2ClaimLiveCanary, runtimeV2Plan } from './aun/runtime-v2'

function printHelp(): void {
  const lines = [
    'aun — agent-comms install/start helper (spec v6)',
    '',
    'Usage:',
    '  aun                       run init if missing, else start',
    '  aun init [--dry-run] [--force]',
    '  aun start [-- <args...>]',
    '  aun receive --agent-id <id> [--queue-id <id>] [--dry-run]',
    '  aun next --agent-id <id> [--queue-id <id>] [--dry-run]',
    '  aun receive-actionable|next-actionable --agent-id <id> [--queue-id <id>] [--max-inspect <n>] [--dry-run]',
    '  aun diagnose-receive --agent-id <id> [--max-inspect <n>] [--dry-run]',
    '  aun reconcile --dry-run --agent-id <id> --limit <n> [--cursor <cursor>]',
    '  aun drain --agent-id <id> [--limit <n>] [--dry-run]',
    '  aun codex-runner --agent-id <id> [--queue-id <id>] [--limit <n>] [--ack-mentions <ids>] [--ack-content <text>] [--complete-no-reply --completion-reason <text>|--auto-final-reply]',
    '  aun codex-runner-preflight --agent-id <id> [--queue-id <id>] [--max-inspect <n>]',
    '  aun processing|done|record-no-reply --agent-id <id> --queue-id <id> [--reason <text>]',
    '  aun renew-claim --agent-id <id> --queue-id <id> [--reason <text>] [--ttl-seconds <n>]',
    '  aun memory-ready-bootstrap --agent-id <id> --runtime-instance-id <id> --session-name <name> --port <n> [--project <project>] [--dry-run]',
    '  aun runtime-v2 plan --agent-id <id> [--queue-id <id>] [--message-id <id>] [--created-after <ts>] --json',
    '  aun runtime-v2 claim --agent-id <id> --queue-id <id> --message-id <id> --created-after <ts> --dry-run --json',
    '  aun runtime-v2 claim --agent-id kodama --queue-id <id> --message-id <id> --created-after <ts> --live-canary --json',
    '  aun runtime-v2 --agent-id kodama [--queue-id <id>] [--message-id <id>] [--created-after <ts>] [--runtime echo|codex-exec|command-json] [--finalize] [--dry-run]',
    '  aun reply --agent-id <id> --content <text> --mentions <owner> [--queue-id <id>] [--message-id <uuid>] [--no-close|--close] [--dry-run]',
    '  aun notify --agent-id <id> --channel-id <id> --content <text> --mentions <owner> [--dry-run]',
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
      const res = init({
        dryRun: !!flags['dry-run'],
        force: !!flags.force,
        token: typeof flags.token === 'string' ? (flags.token as string) : undefined,
        skipVersionCheck: !!flags['skip-version-check'],
        skipExecutableBitCheck: !!flags['skip-executable-bit-check'],
        skipClaudeMcpAdd: !!flags['skip-claude-mcp-add'],
      })
      printSummary('aun init', res.summary, res.errors)
      if (res.dryRun && res.dryRunDiff) {
        process.stdout.write('\n--- dry-run diff ---\n')
        process.stdout.write(JSON.stringify(res.dryRunDiff, null, 2) + '\n')
      }
      return res.ok ? 0 : 1
    }
    case 'start': {
      const res = start({ extraArgs: extras, spawn: !flags['dry-run'] })
      printSummary('aun start', ['command: ' + res.argv.join(' '), ...res.driftWarnings], res.errors)
      if (res.spawned) {
        // The child's `exit` handler in start() owns the eventual
        // `process.exit(...)`. Returning a non-zero code here would
        // race that handler and kill the claude process mid-flight.
        // Hand control to the event loop until the child exits.
        // -1 is a sentinel the runner below maps to "do not exit yet".
        return -1
      }
      return res.ok ? 0 : 1
    }
    case 'receive':
    case 'next': {
      let res
      try {
        res = receive({
          agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
          dryRun: !!flags['dry-run'],
        })
      } catch (err) {
        process.stderr.write(`Error [AGENT_ID_MISMATCH]: ${(err as Error).message}\n`)
        return 2
      }
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      return res.code
    }
    case 'drain': {
      let res
      try {
        const limitFlag = flags.limit
        let limit: number | undefined
        if (limitFlag !== undefined) {
          if (typeof limitFlag !== 'string') throw new Error('--limit requires a value')
          limit = Number(limitFlag)
        }
        res = drain({
          agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
          dryRun: !!flags['dry-run'],
          limit,
        })
      } catch (err) {
        process.stderr.write(`Error [DRAIN_FAILED]: ${(err as Error).message}\n`)
        return 2
      }
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      return res.code
    }
    case 'codex-runner': {
      const limitFlag = flags.limit
      let limit: number | undefined
      if (limitFlag !== undefined) {
        if (typeof limitFlag !== 'string') {
          process.stderr.write('Error [CODEX_RUNNER_INVALID_LIMIT]: --limit requires a value\n')
          return 2
        }
        limit = Number(limitFlag)
      }
      const res = codexRunnerTick({
        agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
        limit,
        queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
        ackMentions: typeof flags['ack-mentions'] === 'string' ? (flags['ack-mentions'] as string) : undefined,
        ackContent: typeof flags['ack-content'] === 'string' ? (flags['ack-content'] as string) : undefined,
        completeNoReply: !!flags['complete-no-reply'],
        completionReason: typeof flags['completion-reason'] === 'string' ? (flags['completion-reason'] as string) : undefined,
        autoFinalReply: !!flags['auto-final-reply'],
        dryRun: !!flags['dry-run'],
      })
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      return res.code
    }
    case 'reply': {
      const res = reply({
        agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
        content: typeof flags.content === 'string' ? (flags.content as string) : undefined,
        mentions: typeof flags.mentions === 'string' ? (flags.mentions as string) : undefined,
        messageType: typeof flags['message-type'] === 'string' ? (flags['message-type'] as string) : undefined,
        queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
        messageId: typeof flags['message-id'] === 'string' ? (flags['message-id'] as string) : undefined,
        noClose: !!flags['no-close'],
        close: !!flags.close,
        dryRun: !!flags['dry-run'],
      })
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      return res.code
    }
    case 'notify': {
      const res = notify({
        agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
        channelId: typeof flags['channel-id'] === 'string' ? (flags['channel-id'] as string) : undefined,
        channelName: typeof flags['channel-name'] === 'string' ? (flags['channel-name'] as string) : undefined,
        resolveChannelName: !!flags['resolve-channel-name'],
        threadId: typeof flags['thread-id'] === 'string' ? (flags['thread-id'] as string) : undefined,
        content: typeof flags.content === 'string' ? (flags.content as string) : undefined,
        mentions: typeof flags.mentions === 'string' ? (flags.mentions as string) : undefined,
        messageType: typeof flags['message-type'] === 'string' ? (flags['message-type'] as string) : undefined,
        replyTo: typeof flags['reply-to'] === 'string' ? (flags['reply-to'] as string) : undefined,
        queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
        dryRun: !!flags['dry-run'],
      })
      if (res.stdout) process.stdout.write(res.stdout)
      if (res.stderr) process.stderr.write(res.stderr)
      return res.code
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
      printSummary('aun (auto)', ['command: ' + r.argv.join(' '), ...r.driftWarnings], r.errors)
      // Same -1 sentinel as the explicit `start` subcommand so the
      // child's exit handler owns process.exit.
      if (r.spawned) return -1
      return r.ok ? 0 : 1
    }
    default:
      process.stderr.write(`aun: unknown subcommand "${subcommand}". See aun --help.\n`)
      return 2
  }
}

export async function runAsync(argv: string[] = process.argv): Promise<number> {
  const { subcommand, flags, extras } = parseArgs(argv)
  if (
    !((subcommand === 'receive' || subcommand === 'next') && typeof flags['queue-id'] === 'string') &&
    subcommand !== 'diagnose-receive' &&
    subcommand !== 'reconcile' &&
    subcommand !== 'receive-actionable' &&
    subcommand !== 'next-actionable' &&
    subcommand !== 'codex-runner-preflight' &&
    subcommand !== 'processing' &&
    subcommand !== 'done' &&
    subcommand !== 'record-no-reply' &&
    subcommand !== 'renew-claim' &&
    subcommand !== 'memory-ready-bootstrap' &&
    subcommand !== 'runtime-v2'
  ) return run(argv)

  if ((subcommand === 'receive' || subcommand === 'next') && typeof flags['queue-id'] === 'string') {
    const res = await receiveTargeted({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      queueId: flags['queue-id'] as string,
      dryRun: !!flags['dry-run'],
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'processing' || subcommand === 'done' || subcommand === 'record-no-reply') {
    const res = await lifecycleTransition(subcommand, {
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
      reason: typeof flags.reason === 'string' ? (flags.reason as string) : undefined,
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'renew-claim') {
    let ttlSeconds: number | undefined
    if (flags['ttl-seconds'] !== undefined) {
      if (typeof flags['ttl-seconds'] !== 'string') {
        process.stderr.write('Error [AUN_RENEW_CLAIM_INVALID]: --ttl-seconds requires a value\n')
        return 2
      }
      ttlSeconds = Number(flags['ttl-seconds'])
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || !Number.isInteger(ttlSeconds)) {
        process.stderr.write('Error [AUN_RENEW_CLAIM_INVALID]: --ttl-seconds must be a positive integer\n')
        return 2
      }
    }
    const res = await renewClaim({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
      reason: typeof flags.reason === 'string' ? (flags.reason as string) : undefined,
      ttlSeconds,
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'memory-ready-bootstrap') {
    const res = await memoryReadyBootstrap({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      project: typeof flags.project === 'string' ? (flags.project as string) : undefined,
      runtimeInstanceId: typeof flags['runtime-instance-id'] === 'string' ? (flags['runtime-instance-id'] as string) : undefined,
      sessionName: typeof flags['session-name'] === 'string' ? (flags['session-name'] as string) : undefined,
      port: typeof flags.port === 'string' ? (flags.port as string) : undefined,
      profileRevision: typeof flags['profile-revision'] === 'string' ? (flags['profile-revision'] as string) : undefined,
      profileSource: typeof flags['profile-source'] === 'string' ? (flags['profile-source'] as string) : undefined,
      checkoutPath: typeof flags['checkout-path'] === 'string' ? (flags['checkout-path'] as string) : undefined,
      checkoutCommitSha: typeof flags['checkout-commit-sha'] === 'string' ? (flags['checkout-commit-sha'] as string) : undefined,
      evidencePath: typeof flags['evidence-path'] === 'string' ? (flags['evidence-path'] as string) : undefined,
      evidenceLogId: typeof flags['evidence-log-id'] === 'string' ? (flags['evidence-log-id'] as string) : undefined,
      recoveryCommand: typeof flags['recovery-command'] === 'string' ? (flags['recovery-command'] as string) : undefined,
      validForSeconds: typeof flags['valid-for-seconds'] === 'string' ? (flags['valid-for-seconds'] as string) : undefined,
      dryRun: !!flags['dry-run'],
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'runtime-v2') {
    if (extras[0] === 'plan') {
      const res = await runtimeV2Plan({
        mode: 'plan',
        format: flags.json ? 'json' : undefined,
        agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
        queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
        messageId: typeof flags['message-id'] === 'string' ? (flags['message-id'] as string) : undefined,
        createdAfter: typeof flags['created-after'] === 'string' ? (flags['created-after'] as string) : undefined,
      })
      process.stdout.write(JSON.stringify(res.result, null, 2) + '\n')
      return res.code
    }
    if (extras[0] === 'claim') {
      let claimTtlSeconds: number | undefined
      if (flags['claim-ttl-seconds'] !== undefined) {
        if (typeof flags['claim-ttl-seconds'] !== 'string') {
          process.stderr.write('Error [AUN_RUNTIME_V2_INVALID]: --claim-ttl-seconds requires a value\n')
          return 2
        }
        claimTtlSeconds = Number(flags['claim-ttl-seconds'])
      }
      const claimOpts = {
        mode: 'claim',
        format: flags.json ? 'json' : undefined,
        agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
        queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
        messageId: typeof flags['message-id'] === 'string' ? (flags['message-id'] as string) : undefined,
        createdAfter: typeof flags['created-after'] === 'string' ? (flags['created-after'] as string) : undefined,
        dryRun: !!flags['dry-run'],
        liveCanary: !!flags['live-canary'],
        claimTtlSeconds,
      } as const
      const res = claimOpts.liveCanary
        ? await runtimeV2ClaimLiveCanary(claimOpts)
        : await runtimeV2ClaimDryRun(claimOpts)
      process.stdout.write(JSON.stringify(res.result, null, 2) + '\n')
      return res.code
    }

    let claimTtlSeconds: number | undefined
    if (flags['claim-ttl-seconds'] !== undefined) {
      if (typeof flags['claim-ttl-seconds'] !== 'string') {
        process.stderr.write('Error [AUN_RUNTIME_V2_INVALID]: --claim-ttl-seconds requires a value\n')
        return 2
      }
      claimTtlSeconds = Number(flags['claim-ttl-seconds'])
    }
    const res = await runtimeV2({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
      messageId: typeof flags['message-id'] === 'string' ? (flags['message-id'] as string) : undefined,
      createdAfter: typeof flags['created-after'] === 'string' ? (flags['created-after'] as string) : undefined,
      runtime: typeof flags.runtime === 'string' ? (flags.runtime as string) : undefined,
      claimTtlSeconds,
      finalize: !!flags.finalize,
      dryRun: !!flags['dry-run'],
    })
    process.stdout.write(JSON.stringify(res, null, 2) + '\n')
    return res.ok ? 0 : 1
  }

  if (subcommand === 'reconcile') {
    if (!flags['dry-run']) {
      process.stderr.write('Error [RECONCILE_FAILED]: reconcile is read-only in this release; pass --dry-run\n')
      return 2
    }
    const limitFlag = flags.limit
    let limit: number | undefined
    if (limitFlag !== undefined) {
      if (typeof limitFlag !== 'string') {
        process.stderr.write('Error [RECONCILE_FAILED]: --limit requires a value\n')
        return 2
      }
      limit = Number(limitFlag)
    }
    const res = await reconcile({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      dryRun: !!flags['dry-run'],
      limit,
      cursor: typeof flags.cursor === 'string' ? (flags.cursor as string) : undefined,
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'receive-actionable' || subcommand === 'next-actionable') {
    const maxInspectFlag = flags['max-inspect']
    let maxInspect: number | undefined
    if (maxInspectFlag !== undefined) {
      if (typeof maxInspectFlag !== 'string') {
        process.stderr.write('Error [RECEIVE_ACTIONABLE_FAILED]: --max-inspect requires a value\n')
        return 2
      }
      maxInspect = Number(maxInspectFlag)
    }
    const res = await receiveActionable({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      dryRun: !!flags['dry-run'],
      maxInspect,
      queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  if (subcommand === 'codex-runner-preflight') {
    const maxInspectFlag = flags['max-inspect']
    let maxInspect: number | undefined
    if (maxInspectFlag !== undefined) {
      if (typeof maxInspectFlag !== 'string') {
        process.stderr.write('Error [CODEX_RUNNER_PREFLIGHT_FAILED]: --max-inspect requires a value\n')
        return 2
      }
      maxInspect = Number(maxInspectFlag)
    }
    const res = await codexRunnerLifecyclePreflight({
      agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
      queueId: typeof flags['queue-id'] === 'string' ? (flags['queue-id'] as string) : undefined,
      maxInspect,
    })
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    return res.code
  }

  const maxInspectFlag = flags['max-inspect']
  let maxInspect: number | undefined
  if (maxInspectFlag !== undefined) {
    if (typeof maxInspectFlag !== 'string') {
      process.stderr.write('Error [DIAGNOSE_RECEIVE_FAILED]: --max-inspect requires a value\n')
      return 2
    }
    maxInspect = Number(maxInspectFlag)
  }
  const res = await diagnoseReceive({
    agentId: typeof flags['agent-id'] === 'string' ? (flags['agent-id'] as string) : undefined,
    dryRun: !!flags['dry-run'],
    maxInspect,
  })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  return res.code
}

if (import.meta.main) {
  const code = await runAsync(process.argv)
  // -1 means a long-running subcommand (currently `aun start`) has
  // taken over and will call process.exit(...) itself when its child
  // claude process terminates.
  if (code !== -1) {
    process.exit(code)
  }
}
