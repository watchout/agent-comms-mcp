import { describe, expect, test } from 'bun:test'
import { planQueueAction } from '../../../core/state-daemon/action-planner'

const now = new Date('2026-05-17T00:00:00.000Z')
const tui = { runtime: 'TUI', tmux_session: 'agent-session' }

describe('state_daemon state/action matrix planner', () => {
  test('pending + idle TUI agent plans wake_pending', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: tui,
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: false,
    })).toEqual({ kind: 'wake_pending', terminal: false })
  })

  test('pending + active claim plans observe_busy without terminal close', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: tui,
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: true,
    })).toEqual({ kind: 'observe_busy', terminal: false })
  })

  test('pending + non-TUI runtime plans runtime_skip', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: { runtime: 'discord', tmux_session: null },
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: false,
    })).toEqual({ kind: 'runtime_skip', terminal: false })
  })

  test('pending + idle Codex runtime plans invoke_codex_runner', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: { runtime: 'codex', tmux_session: null },
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: false,
    })).toEqual({ kind: 'invoke_codex_runner', terminal: false })
  })

  test('pending + busy Codex runtime plans observe_busy without duplicate runner', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: { runtime: 'codex-runner', tmux_session: null },
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: true,
    })).toEqual({ kind: 'observe_busy', terminal: false })
  })

  test('pending + missing tmux plans tmux_missing', () => {
    expect(planQueueAction({
      row: { status: 'pending', claim_expires_at: null },
      agent: { runtime: 'TUI', tmux_session: null },
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: false,
    })).toEqual({ kind: 'tmux_missing', terminal: false })
  })

  test('live received work is observed and remains non-terminal', () => {
    expect(planQueueAction({
      row: { status: 'received', claim_expires_at: new Date(now.getTime() + 60_000) },
      agent: tui,
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: true,
    })).toEqual({ kind: 'observe_received', terminal: false })
  })

  test('expired received work plans reclaim_expired without terminal close', () => {
    expect(planQueueAction({
      row: { status: 'received', claim_expires_at: new Date(now.getTime() - 1_000) },
      agent: tui,
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: true,
    })).toEqual({ kind: 'reclaim_expired', terminal: false })
  })

  test('in_progress work is observed and remains non-terminal', () => {
    expect(planQueueAction({
      row: { status: 'in_progress', claim_expires_at: null },
      agent: tui,
      now,
      defaultRuntime: 'TUI',
      hasActiveClaim: true,
    })).toEqual({ kind: 'observe_in_progress', terminal: false })
  })

  test('terminal statuses are terminal_noop', () => {
    for (const status of ['replied', 'skipped', 'failed', 'done', 'cancelled', 'completed']) {
      expect(planQueueAction({
        row: { status, claim_expires_at: null },
        agent: tui,
        now,
        defaultRuntime: 'TUI',
        hasActiveClaim: false,
      })).toEqual({ kind: 'terminal_noop', terminal: true })
    }
  })
})
