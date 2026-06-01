/**
 * Regression: state_daemon no longer has a tmux prompt-submission wake path.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..')

describe('state_daemon TUI prompt submission path is absent', () => {
  const entrySrc = readFileSync(join(REPO, 'bin/state-daemon.ts'), 'utf8')
  const typesSrc = readFileSync(join(REPO, 'core/state-daemon/types.ts'), 'utf8')

  test('production tmux adapter exposes restart/session checks only', () => {
    expect(entrySrc).toContain('class TmuxShellAdapter')
    expect(entrySrc).toContain('has-session')
    expect(entrySrc).toContain('restartSession')
    expect(entrySrc).not.toContain('async sendKeys')
    expect(entrySrc).not.toContain('send-keys')
  })

  test('StateDaemon tmux dependency interface cannot submit prompt text', () => {
    expect(typesSrc).toContain('export interface TmuxClient')
    expect(typesSrc).toContain('sessionExists')
    expect(typesSrc).toContain('restartSession')
    expect(typesSrc).not.toContain('sendKeys(session')
    expect(typesSrc).not.toContain('TmuxSendKeysError')
  })
})
