import { describe, expect, test } from 'bun:test'
import { decorateProjectedContent } from '../../core/projection-text-decorator'

describe('projection text decorator', () => {
  test('does not decorate native same-owner projection', () => {
    expect(decorateProjectedContent({
      content: 'hello',
      authorAgentId: 'codex-cto',
      consumerAgentId: 'codex-cto',
      recipients: ['codex-aun'],
    })).toBe('hello')
  })

  test('decorates delegated projection with logical author and recipient', () => {
    expect(decorateProjectedContent({
      content: 'hello',
      authorAgentId: 'codex-aun',
      consumerAgentId: 'agent-com-dev',
      recipients: ['codex-cto'],
    })).toBe('[codex-aun -> codex-cto]\nhello')
  })

  test('falls back to via consumer when recipients are unavailable', () => {
    expect(decorateProjectedContent({
      content: 'hello',
      authorAgentId: 'codex-aun',
      consumerAgentId: 'agent-com-dev',
    })).toBe('[codex-aun via agent-com-dev]\nhello')
  })

  test('is idempotent for the same prefix', () => {
    expect(decorateProjectedContent({
      content: '[codex-aun -> codex-cto]\nhello',
      authorAgentId: 'codex-aun',
      consumerAgentId: 'agent-com-dev',
      recipients: ['codex-cto'],
    })).toBe('[codex-aun -> codex-cto]\nhello')
  })
})
