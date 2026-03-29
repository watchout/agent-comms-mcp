#!/usr/bin/env bun
/**
 * Tests for agent ID normalization in listener.ts
 */
import { describe, test, expect } from 'bun:test'
import { normalizeAgentId } from '../scripts/listener'

const PORTS: Record<string, number> = {
  manager: 8789,
  'dev-a': 8790,
  'dev-b': 8791,
  'agent-com': 8795,
}

describe('normalizeAgentId', () => {
  test('exact match returns as-is', () => {
    expect(normalizeAgentId('manager', PORTS)).toBe('manager')
    expect(normalizeAgentId('agent-com', PORTS)).toBe('agent-com')
    expect(normalizeAgentId('dev-a', PORTS)).toBe('dev-a')
  })

  test('prefix match normalizes suffixed IDs', () => {
    expect(normalizeAgentId('agent-com-dev', PORTS)).toBe('agent-com')
    expect(normalizeAgentId('manager-test', PORTS)).toBe('manager')
    expect(normalizeAgentId('dev-a-staging', PORTS)).toBe('dev-a')
  })

  test('unknown ID returns as-is', () => {
    expect(normalizeAgentId('unknown-bot', PORTS)).toBe('unknown-bot')
    expect(normalizeAgentId('', PORTS)).toBe('')
  })

  test('empty port map returns ID as-is', () => {
    expect(normalizeAgentId('cto', {})).toBe('cto')
  })

  test('does not match partial key overlap', () => {
    // "dev-b-extra" should match "dev-b"
    expect(normalizeAgentId('dev-b-extra', PORTS)).toBe('dev-b')
  })

  test('prefers exact match over prefix match', () => {
    // "manager" is an exact match, should not be prefix-matched to something else
    expect(normalizeAgentId('manager', PORTS)).toBe('manager')
  })
})
