import { describe, it, expect } from 'vitest'
import {
  classifyRuntimePref,
  detectRuntimeMismatch,
  classifyBot,
  buildFleetDiagnostics,
  type BotRuntimeRow,
} from '../core/fleet-diagnostics'

describe('classifyRuntimePref', () => {
  it('maps codex variants to codex', () => {
    expect(classifyRuntimePref('codex')).toBe('codex')
    expect(classifyRuntimePref('codex-runner')).toBe('codex')
    expect(classifyRuntimePref('CODEX')).toBe('codex')
  })

  it('maps claude variants to claude-code', () => {
    expect(classifyRuntimePref('claude-code')).toBe('claude-code')
    expect(classifyRuntimePref('claude')).toBe('claude-code')
  })

  it('returns unknown for null/empty/unrecognized', () => {
    expect(classifyRuntimePref(null)).toBe('unknown')
    expect(classifyRuntimePref('')).toBe('unknown')
    expect(classifyRuntimePref('custom')).toBe('unknown')
  })
})

describe('detectRuntimeMismatch', () => {
  it('no mismatch when pane command matches codex runtime', () => {
    expect(detectRuntimeMismatch('codex', 'node')).toBe(false)
    expect(detectRuntimeMismatch('codex', 'codex')).toBe(false)
  })

  it('mismatch when codex bot running non-codex pane command', () => {
    expect(detectRuntimeMismatch('codex', 'bun')).toBe(true)
    expect(detectRuntimeMismatch('codex', 'claude')).toBe(true)
    expect(detectRuntimeMismatch('codex', 'bash')).toBe(true)
  })

  it('no mismatch when pane command matches claude-code runtime', () => {
    expect(detectRuntimeMismatch('claude-code', 'node')).toBe(false)
    expect(detectRuntimeMismatch('claude-code', 'claude')).toBe(false)
    expect(detectRuntimeMismatch('claude-code', 'claude.exe')).toBe(false)
    expect(detectRuntimeMismatch('claude-code', 'bun')).toBe(false)
  })

  it('mismatch when claude-code bot running codex', () => {
    expect(detectRuntimeMismatch('claude-code', 'codex')).toBe(true)
  })

  it('no mismatch when pane command is unknown', () => {
    expect(detectRuntimeMismatch('codex', null)).toBe(false)
    expect(detectRuntimeMismatch('codex', 'unknown')).toBe(false)
  })
})

describe('classifyBot', () => {
  const baseRow: BotRuntimeRow = {
    agent_id: 'test-bot',
    runtime_pref: 'codex',
    status: 'online',
    tmux_session: 'discord-test',
    stuck_pending: 0,
    active_claims: 0,
  }

  it('healthy bot has no issues', () => {
    const diag = classifyBot(baseRow, 'node')
    expect(diag.issues).toHaveLength(0)
  })

  it('detects wake_stuck when pending > 0 and no active claims', () => {
    const diag = classifyBot({ ...baseRow, stuck_pending: 3 }, 'node')
    expect(diag.issues).toContain('wake_stuck')
    expect(diag.issues).toContain('codex_runner_gap')
  })

  it('no wake_stuck when active claims exist', () => {
    const diag = classifyBot({ ...baseRow, stuck_pending: 3, active_claims: 1 }, 'node')
    expect(diag.issues).not.toContain('wake_stuck')
    expect(diag.issues).not.toContain('codex_runner_gap')
  })

  it('detects runtime_mismatch', () => {
    const diag = classifyBot(baseRow, 'bun')
    expect(diag.issues).toContain('runtime_mismatch')
  })

  it('codex_runner_gap only for codex runtime bots with stuck pending', () => {
    const claudeBot: BotRuntimeRow = { ...baseRow, runtime_pref: 'claude-code', stuck_pending: 2 }
    const diag = classifyBot(claudeBot, 'node')
    expect(diag.issues).toContain('wake_stuck')
    expect(diag.issues).not.toContain('codex_runner_gap')
  })
})

describe('buildFleetDiagnostics', () => {
  const rows: BotRuntimeRow[] = [
    { agent_id: 'bot-a', runtime_pref: 'codex', status: 'online', tmux_session: 'discord-a', stuck_pending: 2, active_claims: 0 },
    { agent_id: 'bot-b', runtime_pref: 'claude-code', status: 'idle', tmux_session: 'discord-b', stuck_pending: 0, active_claims: 0 },
    { agent_id: 'bot-c', runtime_pref: 'codex', status: 'online', tmux_session: 'discord-c', stuck_pending: 0, active_claims: 0 },
  ]
  const paneCommands = { 'discord-a': 'node', 'discord-b': 'node', 'discord-c': 'node' }

  it('returns correct summary counts', () => {
    const result = buildFleetDiagnostics(rows, paneCommands, [])
    expect(result.summary.total).toBe(3)
    expect(result.summary.wake_stuck).toBe(1)
    expect(result.summary.codex_runner_gap).toBe(1)
    expect(result.summary.runtime_mismatch).toBe(0)
    expect(result.summary.missing_lease).toBe(0)
  })

  it('adds missing_lease issues from provided list', () => {
    const result = buildFleetDiagnostics(rows, paneCommands, ['bot-b', 'bot-c'])
    expect(result.summary.missing_lease).toBe(2)
    const botB = result.bots.find((b) => b.agent_id === 'bot-b')
    expect(botB?.issues).toContain('missing_lease')
  })

  it('handles empty fleet', () => {
    const result = buildFleetDiagnostics([], {}, [])
    expect(result.bots).toHaveLength(0)
    expect(result.issues).toHaveLength(0)
    expect(result.summary.total).toBe(0)
  })

  it('detects mismatch when pane command differs from runtime_pref', () => {
    const mismatchPanes = { 'discord-a': 'bun', 'discord-b': 'node', 'discord-c': 'node' }
    const result = buildFleetDiagnostics(rows, mismatchPanes, [])
    expect(result.summary.runtime_mismatch).toBe(1)
    const issue = result.issues.find((i) => i.kind === 'runtime_mismatch')
    expect(issue?.agent_id).toBe('bot-a')
  })
})
