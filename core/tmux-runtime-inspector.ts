export interface TmuxPaneSnapshot {
  session_name: string
  pane_pid: number
  current_path: string | null
}

export interface ProcessSnapshot {
  pid: number
  ppid: number
  command: string
}

export interface AgentTmuxExpectation {
  agent_id: string
  tmux_session: string | null
}

export interface TmuxRuntimeObservation {
  session_name: string
  pane_pid: number
  server_pid: number
  observed_agent_id: string | null
  expected_agent_id: string | null
  server_cwd: string | null
}

export interface TmuxRuntimeDoctorBlocker {
  agent_id?: string
  code: string
  tmux_session?: string
  pane_pid?: number
  observed_agent_id?: string | null
  expected_agent_id?: string | null
  observed_server_pid?: number
}

export function parseTmuxListPanes(output: string): TmuxPaneSnapshot[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [sessionName, panePidRaw, currentPathRaw = ''] = line.split('\t')
      const panePid = Number.parseInt(panePidRaw ?? '', 10)
      if (!sessionName || !Number.isFinite(panePid)) return null
      return {
        session_name: sessionName,
        pane_pid: panePid,
        current_path: currentPathRaw.trim() ? currentPathRaw.trim() : null,
      }
    })
    .filter((row): row is TmuxPaneSnapshot => row !== null)
}

export function parseProcessList(output: string): ProcessSnapshot[] {
  return output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/)
      if (!match) return null
      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3] ?? '',
      }
    })
    .filter((row): row is ProcessSnapshot => row !== null)
}

function parseCommandValue(command: string, key: string): string | null {
  const match = command.match(new RegExp(`(?:^|\\s)${key}=("[^"]*"|'[^']*'|\\S+)`))
  if (!match) return null
  const raw = match[1] ?? ''
  return raw.replace(/^['"]|['"]$/g, '')
}

function parseCodexConfigValue(command: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = command.match(new RegExp(`${escaped}=("[^"]*"|'[^']*'|\\S+)`))
  if (!match) return null
  const raw = match[1] ?? ''
  return raw.replace(/^['"]|['"]$/g, '')
}

function parseObservedAgentId(command: string): string | null {
  return parseCommandValue(command, 'AGENT_ID')
    ?? parseCodexConfigValue(command, 'mcp_servers.aun.env.AGENT_ID')
    ?? parseCodexConfigValue(command, 'mcp_servers.agent-comms.env.AGENT_ID')
}

function parseExpectedAgentId(command: string): string | null {
  return parseCommandValue(command, 'AGENT_COM_EXPECTED_AGENT_ID')
    ?? parseCodexConfigValue(command, 'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID')
    ?? parseCodexConfigValue(command, 'mcp_servers.agent-comms.env.AGENT_COM_EXPECTED_AGENT_ID')
}

function parseServerCwd(command: string): string | null {
  const cwd = command.match(/(?:^|\s)--cwd\s+(\S+)/)
  if (cwd?.[1]) return cwd[1]
  const direct = command.match(/(?:^|\s)run\s+(\S*server\.ts)(?:\s|$)/)
  if (!direct?.[1]) return null
  return direct[1].replace(/\/server\.ts$/, '')
}

function descendantPids(rootPid: number, processes: ProcessSnapshot[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const proc of processes) {
    const list = children.get(proc.ppid) ?? []
    list.push(proc.pid)
    children.set(proc.ppid, list)
  }
  const out = new Set<number>()
  const stack = [...(children.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (out.has(pid)) continue
    out.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return out
}

export function observeTmuxRuntime(
  pane: TmuxPaneSnapshot,
  processes: ProcessSnapshot[],
): TmuxRuntimeObservation[] {
  const inspectedPids = descendantPids(pane.pane_pid, processes)
  inspectedPids.add(pane.pane_pid)
  return processes
    .filter((proc) => inspectedPids.has(proc.pid))
    .map((proc) => ({ proc, observedAgentId: parseObservedAgentId(proc.command) }))
    .filter(({ observedAgentId }) => observedAgentId !== null)
    .map((proc) => ({
      session_name: pane.session_name,
      pane_pid: pane.pane_pid,
      server_pid: proc.proc.pid,
      observed_agent_id: proc.observedAgentId,
      expected_agent_id: parseExpectedAgentId(proc.proc.command),
      server_cwd: parseServerCwd(proc.proc.command),
    }))
}

export function buildLiveTmuxProfileDoctorBlockers(input: {
  tmuxOutput: string
  processOutput: string
  expectations: AgentTmuxExpectation[]
}): TmuxRuntimeDoctorBlocker[] {
  const panes = parseTmuxListPanes(input.tmuxOutput)
  const processes = parseProcessList(input.processOutput)
  const paneBySession = new Map(panes.map((pane) => [pane.session_name, pane]))
  const blockers: TmuxRuntimeDoctorBlocker[] = []

  for (const expectation of input.expectations) {
    if (!expectation.tmux_session) continue
    const pane = paneBySession.get(expectation.tmux_session)
    if (!pane) {
      blockers.push({
        agent_id: expectation.agent_id,
        code: 'tmux_session_not_found',
        tmux_session: expectation.tmux_session,
      })
      continue
    }
    const observations = observeTmuxRuntime(pane, processes)
    if (observations.length === 0) {
      blockers.push({
        agent_id: expectation.agent_id,
        code: 'tmux_session_missing_aun_mcp_server',
        tmux_session: expectation.tmux_session,
        pane_pid: pane.pane_pid,
      })
      continue
    }
    const observedAgentIds = new Set(observations.map((obs) => obs.observed_agent_id ?? 'unknown'))
    if (observedAgentIds.size > 1) {
      blockers.push({
        agent_id: expectation.agent_id,
        code: 'tmux_session_multiple_aun_mcp_servers',
        tmux_session: expectation.tmux_session,
        pane_pid: pane.pane_pid,
      })
    }
    const expectedMismatch = observations.find(
      (obs) => obs.expected_agent_id !== null && obs.expected_agent_id !== obs.observed_agent_id,
    )
    if (expectedMismatch) {
      blockers.push({
        agent_id: expectation.agent_id,
        code: 'tmux_session_expected_agent_id_mismatch',
        tmux_session: expectation.tmux_session,
        pane_pid: pane.pane_pid,
        observed_agent_id: expectedMismatch.observed_agent_id,
        expected_agent_id: expectedMismatch.expected_agent_id,
        observed_server_pid: expectedMismatch.server_pid,
      })
    }
    const matching = observations.find((obs) => obs.observed_agent_id === expectation.agent_id)
    if (!matching) {
      const first = observations[0]
      blockers.push({
        agent_id: expectation.agent_id,
        code: 'tmux_session_agent_id_mismatch',
        tmux_session: expectation.tmux_session,
        pane_pid: pane.pane_pid,
        observed_agent_id: first?.observed_agent_id ?? null,
        observed_server_pid: first?.server_pid,
      })
    }
  }

  return blockers
}
