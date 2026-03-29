#!/usr/bin/env bun
/**
 * Tests for agent ID normalization in listener.ts
 */
import { describe, test, expect } from 'bun:test'
import { normalizeAgentId } from '../scripts/listener'

const PORTS: Record<string, number> = {
  cto: 8789,
  hotel: 8790,
  haishin: 8791,
  wbs: 8792,
  nyusatsu: 8793,
  adf: 8794,
  'agent-com': 8795,
  vice: 8796,
  auditor: 8797,
}

describe('normalizeAgentId', () => {
  test('exact match returns as-is', () => {
    expect(normalizeAgentId('cto', PORTS)).toBe('cto')
    expect(normalizeAgentId('agent-com', PORTS)).toBe('agent-com')
    expect(normalizeAgentId('hotel', PORTS)).toBe('hotel')
  })

  test('prefix match normalizes suffixed IDs', () => {
    expect(normalizeAgentId('agent-com-dev', PORTS)).toBe('agent-com')
    expect(normalizeAgentId('cto-test', PORTS)).toBe('cto')
    expect(normalizeAgentId('hotel-staging', PORTS)).toBe('hotel')
  })

  test('unknown ID returns as-is', () => {
    expect(normalizeAgentId('unknown-bot', PORTS)).toBe('unknown-bot')
    expect(normalizeAgentId('', PORTS)).toBe('')
  })

  test('empty port map returns ID as-is', () => {
    expect(normalizeAgentId('cto', {})).toBe('cto')
  })

  test('does not match partial key overlap', () => {
    // "a" should not match "adf" since "a" doesn't startWith "adf"
    // but "adf-extra" should match "adf"
    expect(normalizeAgentId('adf-extra', PORTS)).toBe('adf')
  })

  test('prefers exact match over prefix match', () => {
    // "cto" is an exact match, should not be prefix-matched to something else
    expect(normalizeAgentId('cto', PORTS)).toBe('cto')
  })
})
