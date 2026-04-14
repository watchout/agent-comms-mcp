/**
 * Behavioral coverage for core/bot-health.ts checkBotHealth() —
 * added in cycle 2 of PR #180 per lead-ama Layer 1 CRITICAL request.
 *
 * All six branches covered with injected deps (no tmux / lsof / ps
 * side effects):
 *   1. dead                (tmux session missing)
 *   2. crashed             (panic/fatal/SIGKILL pattern)
 *   3. exited              (last pane line is bare shell prompt)
 *   4. initializing        (port free, bun not yet listening)
 *   5. misconfigured       (port in use but PID is not bun server.ts)
 *   6. healthy             (port in use and PID is bun server.ts)
 */
import { describe, test, expect } from 'bun:test'
import { checkBotHealth, type BotHealthDeps } from '../core/bot-health'

const ENTRY = { session: 'discord-example', port: 8789 }

function makeDeps(overrides: Partial<BotHealthDeps> = {}): BotHealthDeps {
  return {
    hasSession: () => true,
    capture: () => 'Claude Code v2.x idle\n❯ \n',
    getPids: () => ['12345'],
    psCommand: () => '/Users/yuji/.bun/bin/bun run /Users/yuji/Developer/agent-comms-mcp/server.ts',
    ...overrides,
  }
}

describe('checkBotHealth — six branches', () => {
  test('1. dead — tmux session not found', () => {
    const r = checkBotHealth(ENTRY, makeDeps({ hasSession: () => false }))
    expect(r.status).toBe('dead')
    expect(r.details).toBe('tmux session not found')
  })

  test('2. crashed — panic pattern in pane output', () => {
    const r = checkBotHealth(ENTRY, makeDeps({ capture: () => 'worker panic: out of memory\n' }))
    expect(r.status).toBe('crashed')
    expect(r.details).toBe('crash pattern detected')
  })

  test('2. crashed — SIGKILL pattern (case-insensitive)', () => {
    const r = checkBotHealth(ENTRY, makeDeps({ capture: () => 'process killed by SIGKILL\n' }))
    expect(r.status).toBe('crashed')
  })

  test('3. exited — zsh prompt as last line', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({ capture: () => 'agent-comms done\nyuji@Mac agent-comms-mcp % \n' }),
    )
    expect(r.status).toBe('exited')
    expect(r.details).toBe('Claude Code exited to shell prompt')
  })

  test('3. exited — bare $ prompt', () => {
    const r = checkBotHealth(ENTRY, makeDeps({ capture: () => 'exit\n$ \n' }))
    expect(r.status).toBe('exited')
  })

  test('4. initializing — port free', () => {
    const r = checkBotHealth(ENTRY, makeDeps({ getPids: () => [] }))
    expect(r.status).toBe('initializing')
    expect(r.details).toContain(`port ${ENTRY.port} free`)
    expect(r.details).toContain('bun not yet listening')
  })

  test('5. misconfigured — port in use but PID is not bun server.ts', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({
        getPids: () => ['99999'],
        psCommand: () => '/usr/bin/python3 -m http.server 8789',
      }),
    )
    expect(r.status).toBe('misconfigured')
    expect(r.details).toContain('port 8789 in use')
    expect(r.details).toContain('PID: 99999')
    expect(r.details).toContain('port squatted by unrelated process')
  })

  test('5. misconfigured — ps throws (e.g. pid vanished) and no other pid matches', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({
        getPids: () => ['88888'],
        psCommand: () => { throw new Error('pid vanished') },
      }),
    )
    expect(r.status).toBe('misconfigured')
  })

  test('6. healthy — port in use, PID runs bun server.ts', () => {
    const r = checkBotHealth(ENTRY, makeDeps())
    expect(r.status).toBe('healthy')
    expect(r.details).toContain('bun server.ts listening')
    expect(r.details).toContain(`port ${ENTRY.port} in use (PID: 12345)`)
  })

  test('6. healthy — multiple pids, at least one is bun server.ts', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({
        getPids: () => ['11111', '22222'],
        psCommand: (pid: string) =>
          pid === '22222'
            ? 'bun run /Users/yuji/Developer/agent-comms-mcp/server.ts'
            : '/usr/bin/python3',
      }),
    )
    expect(r.status).toBe('healthy')
    expect(r.details).toContain('PID: 11111,22222')
  })

  test('ordering — session dead takes precedence over everything', () => {
    // Even if the other deps look fine, missing tmux session wins.
    const r = checkBotHealth(
      ENTRY,
      makeDeps({
        hasSession: () => false,
        capture: () => 'healthy output',
        getPids: () => ['12345'],
      }),
    )
    expect(r.status).toBe('dead')
  })

  test('ordering — crashed before exited (crash pattern overrides shell prompt)', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({ capture: () => 'fatal error\nyuji@Mac foo % \n' }),
    )
    expect(r.status).toBe('crashed')
  })

  test('ordering — exited before initializing (shell prompt overrides port check)', () => {
    const r = checkBotHealth(
      ENTRY,
      makeDeps({
        capture: () => 'bye\nyuji@Mac foo % \n',
        getPids: () => [], // would otherwise be initializing
      }),
    )
    expect(r.status).toBe('exited')
  })
})
