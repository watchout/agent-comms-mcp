import { describe, expect, test } from 'bun:test'
import {
  commandHasForbiddenAgentCommsDisable,
  evaluateStartupSafety,
  extractStartupIdentity,
} from '../core/startup-safety'

const SAFE_CODEX_COMMAND = [
  'codex --dangerously-bypass-approvals-and-sandbox',
  '-c \'mcp_servers.aun.enabled=true\'',
  '-c \'mcp_servers.aun.env.AGENT_ID="aun"\'',
  '-c \'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="aun"\'',
  '-c \'mcp_servers.aun.env.WEBHOOK_PORT="8811"\'',
].join(' ')

describe('startup safety contract', () => {
  test('blocks the Codex 0.139 invalid-transport override', () => {
    const command = `${SAFE_CODEX_COMMAND} -c 'mcp_servers.agent-comms.enabled=false'`
    expect(commandHasForbiddenAgentCommsDisable(command)).toBe(true)
    const report = evaluateStartupSafety({
      agentId: 'aun',
      expectedAgentId: 'aun',
      command,
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('forbidden_codex_agent_comms_disable')
  })

  test('extracts command-level Codex startup identity', () => {
    expect(extractStartupIdentity(SAFE_CODEX_COMMAND)).toEqual({
      agentId: 'aun',
      expectedAgentId: 'aun',
    })
  })

  test('blocks AGENT_ID / AGENT_COM_EXPECTED_AGENT_ID mismatch', () => {
    const report = evaluateStartupSafety({
      agentId: 'aun',
      expectedAgentId: 'codex-aun',
      command: SAFE_CODEX_COMMAND,
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('expected_agent_mismatch')
  })

  test('blocks command identity drift from DB profile identity', () => {
    const report = evaluateStartupSafety({
      agentId: 'codex-cto',
      expectedAgentId: 'codex-cto',
      command: SAFE_CODEX_COMMAND,
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('command_agent_id_mismatch')
  })

  test('blocks stale managed checkout launchers while allowing current checkout', () => {
    const base = {
      agentId: 'aun',
      expectedAgentId: 'aun',
      command: SAFE_CODEX_COMMAND,
      managedCheckoutRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      currentCheckoutPath: '/Users/yuji/.agent-comms/state-daemon/checkouts/current-sha',
    }
    const stale = evaluateStartupSafety({
      ...base,
      launcherRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts/old-sha',
    })
    expect(stale.ok).toBe(false)
    expect(stale.blockers.map((b) => b.code)).toContain('managed_checkout_stale')

    const current = evaluateStartupSafety({
      ...base,
      launcherRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts/current-sha',
    })
    expect(current.ok).toBe(true)
  })

  test('blocks unapproved launcher root when explicit approved roots are supplied', () => {
    const report = evaluateStartupSafety({
      agentId: 'aun',
      expectedAgentId: 'aun',
      command: SAFE_CODEX_COMMAND,
      launcherRoot: '/tmp/unapproved',
      approvedLauncherRoots: ['/Users/yuji/Developer/agent-comms-mcp'],
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('launcher_root_unapproved')
  })

  test('port checks distinguish same-agent, different-agent, orphan, and unknown owner', () => {
    const base = {
      agentId: 'aun',
      expectedAgentId: 'aun',
      command: SAFE_CODEX_COMMAND,
      port: 8811,
    }
    const same = evaluateStartupSafety({
      ...base,
      portListeners: [{ pid: 10, port: 8811, observed_agent_id: 'aun', orphan: false }],
    })
    expect(same.ok).toBe(true)
    expect(same.warnings.map((w) => w.code)).toContain('port_owned_by_same_agent')

    const different = evaluateStartupSafety({
      ...base,
      portListeners: [{ pid: 11, port: 8811, observed_agent_id: 'codex-cto', orphan: false }],
    })
    expect(different.ok).toBe(false)
    expect(different.blockers.map((b) => b.code)).toContain('port_owned_by_different_agent')

    const orphan = evaluateStartupSafety({
      ...base,
      portListeners: [{ pid: 12, port: 8811, observed_agent_id: null, orphan: true }],
    })
    expect(orphan.ok).toBe(true)
    expect(orphan.warnings.map((w) => w.code)).toContain('orphan_port_listener')

    const unknown = evaluateStartupSafety({
      ...base,
      portListeners: [{ pid: 13, port: 8811, observed_agent_id: null, orphan: false }],
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.blockers.map((b) => b.code)).toContain('port_owner_unknown')
  })

  test('blocks tmux session already bound to another agent', () => {
    const report = evaluateStartupSafety({
      agentId: 'aun',
      expectedAgentId: 'aun',
      command: SAFE_CODEX_COMMAND,
      sessionName: 'discord-aun',
      tmuxRuntimeEvidence: [{
        session_name: 'discord-aun',
        observed_agent_id: 'codex-cto',
        expected_agent_id: 'codex-cto',
        server_pid: 123,
      }],
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('tmux_session_bound_to_different_agent')
  })

  test('blocks unconditional Enter on normal Codex start screen', () => {
    const report = evaluateStartupSafety({
      agentId: 'aun',
      expectedAgentId: 'aun',
      command: SAFE_CODEX_COMMAND,
      codexPostStartEnterPolicy: 'unconditional',
    })
    expect(report.ok).toBe(false)
    expect(report.blockers.map((b) => b.code)).toContain('codex_normal_screen_enter')
  })
})
