import { describe, expect, test } from 'bun:test'
import {
  buildLiveTmuxProfileDoctorBlockers,
  observeTmuxRuntime,
  parseProcessList,
  parseTmuxListPanes,
} from '../core/tmux-runtime-inspector'

describe('tmux runtime inspector', () => {
  test('parses tmux panes and process descendants without exposing raw commands', () => {
    const panes = parseTmuxListPanes('codex-aun\t100\t/Users/yuji/Developer/codex-aun\n')
    const processes = parseProcessList([
      '  100     1 -zsh',
      '  101   100 node /opt/homebrew/bin/codex',
      '  102   101 /Users/yuji/.bun/bin/bun run --cwd /Users/yuji/Developer/agent-comms-mcp server.ts AGENT_COM_EXPECTED_AGENT_ID=codex-cto AGENT_ID=codex-cto DATABASE_URL=postgresql:///agent_comms?host=/tmp',
    ].join('\n'))

    expect(panes).toEqual([
      { session_name: 'codex-aun', pane_pid: 100, current_path: '/Users/yuji/Developer/codex-aun' },
    ])
    expect(observeTmuxRuntime(panes[0], processes)).toEqual([
      {
        session_name: 'codex-aun',
        pane_pid: 100,
        server_pid: 102,
        observed_agent_id: 'codex-cto',
        expected_agent_id: 'codex-cto',
        server_cwd: '/Users/yuji/Developer/agent-comms-mcp',
      },
    ])
  })

  test('reports tmux session agent-id mismatch', () => {
    const blockers = buildLiveTmuxProfileDoctorBlockers({
      tmuxOutput: 'codex-aun\t100\t/Users/yuji/Developer/codex-aun\n',
      processOutput: [
        '  100     1 -zsh',
        '  101   100 node /opt/homebrew/bin/codex',
        '  102   101 /Users/yuji/.bun/bin/bun run --cwd /Users/yuji/Developer/agent-comms-mcp server.ts AGENT_COM_EXPECTED_AGENT_ID=codex-cto AGENT_ID=codex-cto DATABASE_URL=postgresql:///agent_comms?host=/tmp',
      ].join('\n'),
      expectations: [{ agent_id: 'codex-aun', tmux_session: 'codex-aun' }],
    })

    expect(blockers).toEqual([
      {
        agent_id: 'codex-aun',
        code: 'tmux_session_agent_id_mismatch',
        tmux_session: 'codex-aun',
        pane_pid: 100,
        observed_agent_id: 'codex-cto',
        observed_server_pid: 102,
      },
    ])
  })

  test('passes when the observed MCP agent matches the DB profile', () => {
    const blockers = buildLiveTmuxProfileDoctorBlockers({
      tmuxOutput: 'discord-aun\t200\t/Users/yuji/Developer/codex-aun\n',
      processOutput: [
        '  200     1 -zsh',
        '  201   200 node /opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox -c mcp_servers.aun.env.AGENT_ID="codex-aun" -c mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID="codex-aun"',
        '  202   201 /Users/yuji/.bun/bin/bun run --cwd /Users/yuji/Developer/codex-aun/agent-comms-mcp-main server.ts',
      ].join('\n'),
      expectations: [{ agent_id: 'codex-aun', tmux_session: 'discord-aun' }],
    })

    expect(blockers).toEqual([])
  })

  test('does not flag wrapper and child commands when both show the same agent', () => {
    const blockers = buildLiveTmuxProfileDoctorBlockers({
      tmuxOutput: 'discord-aun\t200\t/Users/yuji/Developer/codex-aun\n',
      processOutput: [
        '  200     1 -zsh',
        '  201   200 node /opt/homebrew/bin/codex -c mcp_servers.aun.env.AGENT_ID="codex-aun"',
        '  202   201 /opt/homebrew/lib/node_modules/@openai/codex/bin/codex -c mcp_servers.aun.env.AGENT_ID="codex-aun"',
      ].join('\n'),
      expectations: [{ agent_id: 'codex-aun', tmux_session: 'discord-aun' }],
    })

    expect(blockers).toEqual([])
  })

  test('reports missing sessions and missing MCP server descendants', () => {
    const blockers = buildLiveTmuxProfileDoctorBlockers({
      tmuxOutput: 'discord-aun\t200\t/Users/yuji/Developer/codex-aun\n',
      processOutput: '  200     1 -zsh\n  201   200 node /opt/homebrew/bin/codex\n',
      expectations: [
        { agent_id: 'codex-aun', tmux_session: 'discord-aun' },
        { agent_id: 'codex-cto', tmux_session: 'discord-cto' },
      ],
    })

    expect(blockers).toEqual([
      {
        agent_id: 'codex-aun',
        code: 'tmux_session_missing_aun_mcp_server',
        tmux_session: 'discord-aun',
        pane_pid: 200,
      },
      {
        agent_id: 'codex-cto',
        code: 'tmux_session_not_found',
        tmux_session: 'discord-cto',
      },
    ])
  })
})
