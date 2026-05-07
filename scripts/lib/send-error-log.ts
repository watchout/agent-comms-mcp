/**
 * B8 send-error logging — symmetric helper to `loop-detector.ts`.
 *
 * Spec: docs/B8-loop-detection-spec-amendment-v0.md §5 (B6 観測性)
 *       + §2.5 Module boundary (auditor A2 symmetric abstraction)
 *
 * Pre-fix `run-bot.sh:200` swallowed every send attempt's stderr via
 * `>/dev/null 2>&1`, so a permanent `SEND_FAILED_AFTER_N_RETRIES`
 * arrived without a single byte of root-cause evidence (RC3 in spec
 * §2). Replacing the shell-level redirection with this helper keeps
 * one append per attempt and a fixed structured format the operator
 * can `grep` for an exit code or an excerpt.
 *
 * Why a module instead of a `2>>${LOG_FILE}` shell line: spec §2.5
 * insists detector and logger ride at the same abstraction. The shell
 * is a thin caller for both; one side as helper and the other inline
 * is forbidden (auditor A2). Concretely it also lets the unit test
 * exercise the writer without spawning a shell.
 *
 *   format: `[ISO8601] [send-attempt N] [exit C] STDERR_EXCERPT\n`
 *           e.g. `[2026-05-07T08:00:00.123Z] [send-attempt 2] [exit 1] EAI_AGAIN\n`
 */
import { mkdir, appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Default cap for the `stderr` excerpt persisted to the log line. The
 * cap exists so a runaway send target that streams MB of output does
 * not blow up the run-bot log between rotations (rotation itself is
 * out of scope here — see B6-followup). 512 bytes is the §5 Open
 * default; callers that need more can read the file directly.
 */
const STDERR_EXCERPT_MAX_BYTES = 512

function truncateStderr(stderr: string): string {
  if (typeof stderr !== 'string') return ''
  // Strip trailing newlines so we always emit one terminating `\n`.
  const trimmed = stderr.replace(/\s+$/, '')
  if (Buffer.byteLength(trimmed, 'utf8') <= STDERR_EXCERPT_MAX_BYTES) {
    return trimmed
  }
  // Truncate by bytes and tag the result so the operator knows it was
  // clipped. We slice on the byte buffer to avoid mid-codepoint cuts
  // and append a `…(truncated)` marker.
  const buf = Buffer.from(trimmed, 'utf8').subarray(0, STDERR_EXCERPT_MAX_BYTES)
  return buf.toString('utf8') + '…(truncated)'
}

/**
 * Append one structured line for a send attempt.
 *
 * @param logPath  Absolute or relative log file path. If the parent
 *                 directory does not yet exist, `mkdir -p` is run
 *                 before the append (per spec §2 (a)-(d) test L2).
 * @param attempt  1-based attempt number (1 / 2 / 3 in run-bot.sh).
 * @param exitCode CLI process exit code captured by the caller.
 * @param stderr   Raw stderr bytes from the failed attempt. Truncated
 *                 to {@link STDERR_EXCERPT_MAX_BYTES} on write.
 *
 * Resolves on successful append. Rejects when the log path is
 * unwritable so the caller can decide whether to retry or surface the
 * error (run-bot.sh wraps the call in `|| true` to keep the loop
 * non-fatal — fail-closed shell semantics live in the caller).
 */
export async function appendSendError(
  logPath: string,
  attempt: number,
  exitCode: number,
  stderr: string,
): Promise<void> {
  const parent = dirname(logPath)
  // `recursive: true` is idempotent — silent no-op when the dir is
  // already there. Keeps the helper safe for hot paths.
  await mkdir(parent, { recursive: true })
  const timestamp = new Date().toISOString()
  const excerpt = truncateStderr(stderr)
  const line = `[${timestamp}] [send-attempt ${attempt}] [exit ${exitCode}] ${excerpt}\n`
  await appendFile(logPath, line, 'utf8')
}
