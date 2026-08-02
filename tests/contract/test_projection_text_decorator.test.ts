import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
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

  test('server and shared CLI outbound enqueue paths both apply the decorator', async () => {
    const repoRoot = resolve(import.meta.dir, '..', '..')
    const server = await Bun.file(resolve(repoRoot, 'server.ts')).text()
    const cli = await Bun.file(resolve(repoRoot, 'cli/index.ts')).text()
    expect((server.match(/decorateProjectedContent\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(cli).toContain('async function enqueueOutboundProjection')
    expect((cli.match(/decorateProjectedContent\(/g) ?? []).length).toBeGreaterThanOrEqual(1)
    // One definition plus the send and notify call sites.
    expect((cli.match(/enqueueOutboundProjection\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})
