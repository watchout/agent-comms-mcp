import { describe, expect, test } from 'bun:test'
import { validateShirubeD1LaunchAgentEnv } from '../core/state-daemon/launchagent'

const target = {
  repository: 'watchout/agent-comms-mcp',
  agent_id: 'dev-001',
  control_source: 'https://github.com/watchout/agent-comms-mcp/issues/887',
}

function enabledEnv(): Record<string, string> {
  return {
    SHIRUBE_D1_ENABLED: '1',
    SHIRUBE_D1_KILL_SWITCH: '0',
    SHIRUBE_D1_TARGET_ALLOWLIST: JSON.stringify([target]),
    SHIRUBE_D1_AUTHORIZATION_DIGEST: 'a'.repeat(64),
    SHIRUBE_D1_ADAPTER_HEAD_SHA: 'b'.repeat(40),
    SHIRUBE_D1_AUDIT_REF: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-audit',
    SHIRUBE_D1_QA_REF: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-qa',
    SHIRUBE_D1_CHECK_REF: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-check',
    SHIRUBE_D1_CTO_GO_REF: 'https://github.com/watchout/agent-comms-mcp/pull/1#issuecomment-cto',
  }
}

describe('Shirube D1 state-daemon activation projection', () => {
  test('accepts one exact target with all protected gate evidence', () => {
    expect(validateShirubeD1LaunchAgentEnv(enabledEnv())).toEqual([])
  })

  test('rejects activation when the kill switch, cardinality, SHA, or gate evidence is unsafe', () => {
    const env = enabledEnv()
    env.SHIRUBE_D1_KILL_SWITCH = '1'
    env.SHIRUBE_D1_TARGET_ALLOWLIST = JSON.stringify([target, { ...target, repository: 'watchout/agent-memory' }])
    env.SHIRUBE_D1_ADAPTER_HEAD_SHA = 'short'
    delete env.SHIRUBE_D1_CTO_GO_REF
    expect(validateShirubeD1LaunchAgentEnv(env).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'shirube_d1_kill_switch_active',
      'shirube_d1_target_allowlist_not_exact',
      'shirube_d1_adapter_head_invalid',
      'shirube_d1_cto_go_ref_invalid',
    ]))
  })
})
