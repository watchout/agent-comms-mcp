import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { routeMessage, type AgentInfo, type ChannelInfo } from '../core/route-message'

const REPO_ROOT = join(import.meta.dir, '..')
const INBOUND_RECEIVER_SOURCE = readFileSync(join(REPO_ROOT, 'adapters', 'inbound-receiver.ts'), 'utf-8')

describe('NORM-050 registered inbound fanout regression', () => {
  test('registered multi-mention channel routes every resolved bot target', () => {
    const channel: ChannelInfo = {
      channelId: '1509299147109306508',
      members: ['agent-com-dev', 'arc', 'codex-cto'],
      type: 'channel',
      primary: 'agent-com-dev',
    }
    const agents: AgentInfo[] = [
      { agentId: 'agent-com-dev', agentType: 'dev', observerMode: false, discordId: '900000000000000001' },
      { agentId: 'arc', agentType: 'dev', observerMode: false, discordId: '900000000000000002' },
      { agentId: 'codex-cto', agentType: 'dev', observerMode: false, discordId: '900000000000000003' },
    ]

    const result = routeMessage(
      {
        authorAgentId: null,
        authorIsBot: false,
        content: '<@900000000000000002> <@900000000000000003> please inspect',
        mentions: ['arc', 'codex-cto'],
        messageType: 'chat',
      },
      channel,
      agents,
      'inbound',
    )

    expect(result.pushTargets.sort()).toEqual(['arc', 'codex-cto'])
    expect(result.dropTargets['agent-com-dev']).toBe('NOT_MENTIONED')
  })

  test('receiver persists one message_queue delivery per pushTarget', () => {
    const loopIdx = INBOUND_RECEIVER_SOURCE.indexOf('for (const targetAgentId of result.pushTargets)')
    expect(loopIdx).toBeGreaterThan(-1)
    const body = INBOUND_RECEIVER_SOURCE.slice(loopIdx, loopIdx + 2400)
    expect(body).toContain('persistInboundDelivery(d.databaseUrl')
    expect(body).toContain('receiverAgentId: targetAgentId')
    expect(body).not.toContain('receiverAgentId: receiverAgentId')
  })
})
