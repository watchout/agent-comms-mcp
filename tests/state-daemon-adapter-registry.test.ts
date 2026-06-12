import { describe, test, expect } from 'bun:test'
import { selectAgentAdapter } from '../core/state-daemon/adapter-registry'

describe('selectAgentAdapter', () => {
  test('claude-code → kind=claude-code + claude profile', () => {
    const r = selectAgentAdapter('claude-code')
    expect(r.kind).toBe('claude-code')
    expect(r.profile).not.toBeNull()
    expect(r.profile!.runtime).toBe('claude')
    expect(r.profile!.profile_id).toBe('claude-code-agent')
    expect(r.profile!.prompt_delivery).toBe('prompt-arg')
    expect(r.profile!.degraded_tui_fallback_allowed).toBe(false)
  })

  test('claude → same as claude-code', () => {
    const r = selectAgentAdapter('claude')
    expect(r.kind).toBe('claude-code')
    expect(r.profile!.runtime).toBe('claude')
  })

  test('CLAUDE_CODE → same as claude-code', () => {
    const r = selectAgentAdapter('CLAUDE_CODE')
    expect(r.kind).toBe('claude-code')
  })

  test('codex → kind=codex + codex profile', () => {
    const r = selectAgentAdapter('codex')
    expect(r.kind).toBe('codex')
    expect(r.profile).not.toBeNull()
    expect(r.profile!.runtime).toBe('codex')
    expect(r.profile!.profile_id).toBe('codex-agent')
    expect(r.profile!.prompt_delivery).toBe('stdin-json')
  })

  test('codex-runner → same as codex', () => {
    const r = selectAgentAdapter('codex-runner')
    expect(r.kind).toBe('codex')
  })

  test('null → kind=none, no profile', () => {
    const r = selectAgentAdapter(null)
    expect(r.kind).toBe('none')
    expect(r.profile).toBeNull()
  })

  test('undefined → kind=none', () => {
    const r = selectAgentAdapter(undefined)
    expect(r.kind).toBe('none')
    expect(r.profile).toBeNull()
  })

  test('unknown value → kind=none', () => {
    const r = selectAgentAdapter('gemini')
    expect(r.kind).toBe('none')
    expect(r.profile).toBeNull()
  })

  test('whitespace-only → kind=none', () => {
    const r = selectAgentAdapter('  ')
    expect(r.kind).toBe('none')
  })

  test('claude-code profile has required env allowlist entries', () => {
    const r = selectAgentAdapter('claude-code')
    expect(r.profile!.env_allowlist).toContain('ANTHROPIC_API_KEY')
    expect(r.profile!.env_allowlist).toContain('DATABASE_URL')
  })
})
