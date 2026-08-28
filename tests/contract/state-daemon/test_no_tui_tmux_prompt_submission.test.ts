/**
 * Guard: state_daemon tmux prompt-submission is constrained to the
 * sendPrompt(session, prompt) interface only — used exclusively as a
 * codex-runner-disabled fallback (#718-PB). Freeform sendKeys injection
 * remains forbidden.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

describe('state_daemon TUI prompt submission is constrained to sendPrompt interface', () => {
  const entrySrc = readFileSync(join(REPO, 'bin/state-daemon.ts'), 'utf8')
  const typesSrc = readFileSync(join(REPO, 'core/state-daemon/types.ts'), 'utf8')

  test('production tmux adapter uses sendPrompt (not freeform sendKeys)', () => {
    expect(entrySrc).toContain('class TmuxShellAdapter')
    expect(entrySrc).toContain('has-session')
    expect(entrySrc).toContain('restartSession')
    // sendPrompt is the only permitted tmux injection path (codex-runner fallback)
    expect(entrySrc).toContain('async sendPrompt')
    // freeform sendKeys method is forbidden — use sendPrompt only
    expect(entrySrc).not.toContain('async sendKeys')
  })

  test('StateDaemon tmux interface exposes sendPrompt, not freeform sendKeys', () => {
    expect(typesSrc).toContain('export interface TmuxClient')
    expect(typesSrc).toContain('sessionExists')
    expect(typesSrc).toContain('restartSession')
    expect(typesSrc).toContain('sendPrompt(session')
    expect(typesSrc).not.toContain('sendKeys(session')
    expect(typesSrc).not.toContain('TmuxSendKeysError')
  })
})
