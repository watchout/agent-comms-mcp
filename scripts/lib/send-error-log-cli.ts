#!/usr/bin/env bun
/**
 * Thin CLI wrapper around `appendSendError` so `scripts/run-bot.sh`
 * can log a send-attempt failure without a `2>>${LOG_FILE}` shell
 * redirection. Spec §2.5 demands detector and logger ride at the same
 * abstraction level — both helpers, the shell a thin caller.
 *
 * Usage:
 *   bun scripts/lib/send-error-log-cli.ts <log_path> <attempt> <exit_code> <stderr>
 *
 * The stderr argument is the captured raw bytes from the failed
 * attempt (the caller redirects the CLI's `2>` to a tempfile then
 * passes the contents in). Truncation + format live in the helper.
 *
 * On any error the wrapper exits non-zero but the caller wraps the
 * invocation in `|| true`, so a logging failure never breaks the
 * runner loop (matches the legacy `>/dev/null 2>&1 || true` shape).
 */
import { appendSendError } from './send-error-log'

;(async () => {
  const [, , logPath, attemptArg, exitArg, ...rest] = process.argv
  if (!logPath || !attemptArg || !exitArg) {
    process.stderr.write('send-error-log-cli: missing args (<log_path> <attempt> <exit_code> [stderr...])\n')
    process.exit(2)
  }
  const attempt = Number(attemptArg)
  const exitCode = Number(exitArg)
  // run-bot.sh passes the stderr blob as a single positional arg, but
  // historically a long shell-quoted string can split across argv;
  // join the tail back so the entry preserves whatever the caller
  // sent (the helper truncates to a byte cap).
  const stderr = rest.join(' ')
  if (!Number.isFinite(attempt) || !Number.isFinite(exitCode)) {
    process.stderr.write('send-error-log-cli: attempt / exit_code must be integers\n')
    process.exit(2)
  }
  try {
    await appendSendError(logPath, attempt, exitCode, stderr)
  } catch (err) {
    process.stderr.write(`send-error-log-cli: append failed: ${err}\n`)
    process.exit(1)
  }
})()
