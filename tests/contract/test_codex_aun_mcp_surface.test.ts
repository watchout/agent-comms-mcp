import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  claudeAunAdapter,
  codexAunAdapter,
  codexAunMcpProfile,
  describeCodexAunRunnerPlan,
} from '../../runtime'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const serverSource = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')

describe('codex-aun MCP runtime surface', () => {
  test('Codex and Claude adapters use peer runtime names over the shared AUN MCP service', () => {
    expect(codexAunAdapter.name).toBe('codex-aun')
    expect(claudeAunAdapter.name).toBe('claude-aun')
    expect(codexAunAdapter.mcpServerName).toBe('aun')
    expect(claudeAunAdapter.mcpServerName).toBe('aun')
  })

  test('codex-aun profile requires the runtime-neutral lifecycle tools', () => {
    expect(codexAunMcpProfile.agentId).toBe('codex-aun')
    expect(codexAunMcpProfile.toolPrefix).toBe('aun')
    expect(codexAunMcpProfile.requiredTools).toEqual([
      'notify',
      'send',
      'inbox',
      'processing',
      'done',
      'status',
    ])
  })

  test('server still exposes the shared lifecycle tool names used by runtime adapters', () => {
    for (const name of ['notify', 'send', 'inbox', 'processing', 'done']) {
      expect(serverSource).toContain(`name: '${name}'`)
    }
  })

  test('codex-aun runner plan stays outside state_daemon ownership', () => {
    const plan = describeCodexAunRunnerPlan()
    expect(plan.adapter.name).toBe('codex-aun')
    expect(plan.stateDaemonOwned).toBe(false)
    expect(plan.lifecycle).toEqual(['inbox', 'processing', 'send-or-done'])
  })
})
