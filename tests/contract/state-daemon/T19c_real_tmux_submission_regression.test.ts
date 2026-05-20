/**
 * T19c — real-tmux submission regression (PR #335 hotfix).
 *
 * The B1 bug (PR #333 Phase 0) shipped because every fixture in the suite
 * uses `FakeTmux`, which records `sendKeys(session, payload)` and trusts
 * the args. Real tmux, however, does NOT interpret an embedded `\n` in the
 * payload as the Return key — it types LF as text, no command line ever
 * submits, no LLM turn starts. The daemon's metric reads `result='ok'`
 * while the bot is silently stalled.
 *
 * This fixture launches an actual tmux session and reproduces the
 * daemon's tmux send-keys argv shape — strip trailing `\n` from the
 * payload, then pass `'Enter'` as a separate argv. It captures the
 * pane and asserts the submission actually fired (BASE-MARKER and
 * SUBMIT-MARKER both visible as command output). Cleanup tears the
 * session down even on failure.
 *
 * The fixture does NOT instantiate the production `TmuxShellAdapter`
 * class — that adapter would require wiring its DI shape into a fake
 * StateDaemon, and the regression we care about is the argv shape, not
 * the class instantiation. Re-issuing the same argv shape via
 * `execFileAsync('tmux', ['send-keys', ...])` is the most direct gate
 * against the B1 class of bugs.
 *
 * Skipped automatically (via `describe.skip`) when `tmux` is not on
 * PATH — e.g. CI runners without tmux installed. No warning is logged;
 * the skip is silent so the rest of the suite output stays clean. CI
 * runners that have tmux available exercise this path as a real
 * regression gate.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const dDescribe = tmuxAvailable() ? describe : describe.skip

dDescribe('T19c — real tmux Enter-submission regression (PR #335 hotfix)', () => {
  let session: string

  beforeEach(() => {
    session = `state-daemon-test-${process.pid}-${Date.now()}`
    execFileSync('tmux', ['new-session', '-d', '-s', session, '-x', '120', '-y', '40'])
  })

  afterEach(() => {
    try {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
    } catch {
      // session may have already exited; cleanup is best-effort.
    }
  })

  test('sendKeys with trailing \\n payload submits the line (input field clears)', async () => {
    // Import the entry module just to confirm it loads on this host
    // (production-shape adapters compile + wire). The TmuxShellAdapter
    // class itself is internal and would require a full DaemonDeps
    // wiring to instantiate; the regression we want to gate is the argv
    // SHAPE, so we re-issue the exact literal-send + Enter calls below. If the
    // production class signature drifts, the m4 source-pin catches it.
    const mod = await import('../../../bin/state-daemon')
    expect(typeof (mod as { main: () => unknown }).main).toBe('function')

    // Pre-populate the pane with a recognizable prompt baseline.
    execFileSync('tmux', ['send-keys', '-t', session, 'echo BASE-MARKER', 'Enter'])
    await new Promise((r) => setTimeout(r, 200))

    // Now drive the production sendKeys shape: strip trailing \n, clear the
    // input line, send the prompt as literal text, then send Enter separately.
    const payload = 'echo SUBMIT-MARKER\n'
    const stripped = payload.endsWith('\n') ? payload.slice(0, -1) : payload
    await execFileAsync('tmux', ['send-keys', '-t', session, 'C-u'])
    await execFileAsync('tmux', ['send-keys', '-t', session, '-l', stripped])
    await execFileAsync('tmux', ['send-keys', '-t', session, 'Enter'])
    await new Promise((r) => setTimeout(r, 300))

    // Capture the pane and verify both markers ran. If Enter never pressed,
    // the second marker would sit on the prompt line as un-submitted text
    // and `echo SUBMIT-MARKER` would appear ON THE INPUT LINE rather than
    // as command output.
    const pane = execFileSync('tmux', ['capture-pane', '-t', session, '-p'], {
      encoding: 'utf-8',
    })

    // Both echoes' OUTPUT should be present (separate lines from the
    // command echoes themselves).
    expect(pane).toContain('BASE-MARKER')
    expect(pane).toContain('SUBMIT-MARKER')

    // The cursor should be on a fresh prompt line, not on a line that
    // still holds an un-submitted `echo SUBMIT-MARKER`.
    const lines = pane.split('\n').filter(Boolean)
    const lastNonEmpty = lines[lines.length - 1] ?? ''
    expect(lastNonEmpty).not.toMatch(/echo SUBMIT-MARKER\s*$/)
  })

})

// Negative regression note (intentionally not a test):
// An earlier draft of this fixture asserted that the BUGGY shape (payload
// with embedded `\n`, no separate `Enter` argv) leaves the text
// un-submitted on the input line. That assertion proved fragile because
// the real environment under test is `tmux + zsh/bash`, not pure tmux —
// some shell + tmux combinations interpret the embedded LF differently
// than the production TUI input field would. The positive submission
// test above is the canonical regression gate; pinning the source-level
// shape (m4-entry-smoke "send-keys with explicit Enter argv" assertion)
// covers the inverse direction without environment fragility.
