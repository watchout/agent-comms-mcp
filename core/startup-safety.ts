import { resolve } from 'node:path'

export type CodexPostStartEnterPolicy = 'none' | 'update_prompt_only' | 'unconditional'

export type StartupSafetyBlockerCode =
  | 'forbidden_codex_agent_comms_disable'
  | 'missing_agent_id'
  | 'expected_agent_mismatch'
  | 'command_agent_id_mismatch'
  | 'command_expected_agent_id_mismatch'
  | 'managed_checkout_stale'
  | 'launcher_root_unapproved'
  | 'port_owned_by_different_agent'
  | 'port_owner_unknown'
  | 'tmux_session_bound_to_different_agent'
  | 'tmux_session_expected_agent_mismatch'
  | 'codex_normal_screen_enter'

export type StartupSafetyWarningCode =
  | 'port_owned_by_same_agent'
  | 'orphan_port_listener'

export interface StartupSafetyFinding {
  code: StartupSafetyBlockerCode | StartupSafetyWarningCode
  detail: string
  severity: 'blocker' | 'warning'
}

export interface StartupPortListenerEvidence {
  pid: number
  port: number
  ppid?: number | null
  command?: string | null
  observed_agent_id?: string | null
  orphan?: boolean | null
}

export interface StartupTmuxRuntimeEvidence {
  session_name: string
  observed_agent_id?: string | null
  expected_agent_id?: string | null
  server_pid?: number | null
}

export interface StartupSafetyInput {
  agentId: string | null
  expectedAgentId?: string | null
  sessionName?: string | null
  port?: number | string | null
  command: string
  launcherRoot?: string | null
  managedCheckoutRoot?: string | null
  currentCheckoutPath?: string | null
  approvedLauncherRoots?: string[]
  portListeners?: StartupPortListenerEvidence[]
  tmuxRuntimeEvidence?: StartupTmuxRuntimeEvidence[]
  codexPostStartEnterPolicy?: CodexPostStartEnterPolicy
}

export interface StartupSafetyReport {
  ok: boolean
  agent_id: string | null
  expected_agent_id: string | null
  session_name: string | null
  port: number | null
  blockers: StartupSafetyFinding[]
  warnings: StartupSafetyFinding[]
}

function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value ? value : null
}

function normalizePath(raw: string | null | undefined): string | null {
  const value = cleanText(raw)
  return value ? resolve(value.replace(/^~/, process.env.HOME ?? '~')) : null
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

function numberOrNull(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

function unquote(raw: string): string {
  return raw.replace(/^['"]|['"]$/g, '')
}

export function parseShellAssignment(command: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = command.match(new RegExp(`(?:^|\\s)${escaped}=("[^"]*"|'[^']*'|\\S+)`))
  return match?.[1] ? unquote(match[1]) : null
}

export function parseCodexConfigAssignment(command: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = command.match(new RegExp(`${escaped}=("[^"]*"|'[^']*'|\\S+)`))
  return match?.[1] ? unquote(match[1]) : null
}

export function extractStartupIdentity(command: string): { agentId: string | null; expectedAgentId: string | null } {
  return {
    agentId: parseShellAssignment(command, 'AGENT_ID')
      ?? parseCodexConfigAssignment(command, 'mcp_servers.aun.env.AGENT_ID')
      ?? parseCodexConfigAssignment(command, 'mcp_servers.agent-comms.env.AGENT_ID'),
    expectedAgentId: parseShellAssignment(command, 'AGENT_COM_EXPECTED_AGENT_ID')
      ?? parseCodexConfigAssignment(command, 'mcp_servers.aun.env.AGENT_COM_EXPECTED_AGENT_ID')
      ?? parseCodexConfigAssignment(command, 'mcp_servers.agent-comms.env.AGENT_COM_EXPECTED_AGENT_ID'),
  }
}

export function commandHasForbiddenAgentCommsDisable(command: string): boolean {
  return /mcp_servers\.agent-comms\.enabled\s*=\s*false/.test(command)
}

function isCodexCommand(command: string): boolean {
  return /(^|\s)codex(\s|$)/.test(command)
}

function finding(
  severity: 'blocker' | 'warning',
  code: StartupSafetyBlockerCode | StartupSafetyWarningCode,
  detail: string,
): StartupSafetyFinding {
  return { severity, code, detail }
}

export function evaluateStartupSafety(input: StartupSafetyInput): StartupSafetyReport {
  const commandIdentity = extractStartupIdentity(input.command)
  const agentId = cleanText(input.agentId)
  const expectedAgentId = cleanText(input.expectedAgentId) ?? agentId
  const sessionName = cleanText(input.sessionName)
  const port = numberOrNull(input.port)
  const launcherRoot = normalizePath(input.launcherRoot)
  const managedCheckoutRoot = normalizePath(input.managedCheckoutRoot)
  const currentCheckoutPath = normalizePath(input.currentCheckoutPath)
  const approvedLauncherRoots = (input.approvedLauncherRoots ?? [])
    .map((root) => normalizePath(root))
    .filter((root): root is string => root !== null)
  const blockers: StartupSafetyFinding[] = []
  const warnings: StartupSafetyFinding[] = []

  if (commandHasForbiddenAgentCommsDisable(input.command)) {
    blockers.push(finding('blocker', 'forbidden_codex_agent_comms_disable', 'Codex startup command disables incomplete mcp_servers.agent-comms'))
  }

  if (!agentId) {
    blockers.push(finding('blocker', 'missing_agent_id', 'startup profile has no agent id'))
  }
  if (agentId && expectedAgentId && agentId !== expectedAgentId) {
    blockers.push(finding('blocker', 'expected_agent_mismatch', `agent_id=${agentId} expected_agent_id=${expectedAgentId}`))
  }
  if (commandIdentity.agentId && agentId && commandIdentity.agentId !== agentId) {
    blockers.push(finding('blocker', 'command_agent_id_mismatch', `command AGENT_ID=${commandIdentity.agentId} profile agent_id=${agentId}`))
  }
  if (commandIdentity.expectedAgentId && expectedAgentId && commandIdentity.expectedAgentId !== expectedAgentId) {
    blockers.push(finding('blocker', 'command_expected_agent_id_mismatch', `command AGENT_COM_EXPECTED_AGENT_ID=${commandIdentity.expectedAgentId} profile expected_agent_id=${expectedAgentId}`))
  }
  if (commandIdentity.agentId && commandIdentity.expectedAgentId && commandIdentity.agentId !== commandIdentity.expectedAgentId) {
    blockers.push(finding('blocker', 'expected_agent_mismatch', `command AGENT_ID=${commandIdentity.agentId} command expected=${commandIdentity.expectedAgentId}`))
  }

  if (launcherRoot && approvedLauncherRoots.length > 0 && !approvedLauncherRoots.some((root) => isInside(root, launcherRoot))) {
    blockers.push(finding('blocker', 'launcher_root_unapproved', `launcher root ${launcherRoot} is outside approved roots`))
  }

  if (
    launcherRoot
    && managedCheckoutRoot
    && currentCheckoutPath
    && isInside(managedCheckoutRoot, launcherRoot)
    && resolve(launcherRoot) !== resolve(currentCheckoutPath)
  ) {
    blockers.push(finding('blocker', 'managed_checkout_stale', `launcher root ${launcherRoot} is not current checkout ${currentCheckoutPath}`))
  }

  if (port) {
    for (const listener of input.portListeners ?? []) {
      if (listener.port !== port) continue
      const observed = cleanText(listener.observed_agent_id)
      if (observed && agentId && observed !== agentId) {
        blockers.push(finding('blocker', 'port_owned_by_different_agent', `port ${port} pid ${listener.pid} belongs to ${observed}, not ${agentId}`))
      } else if (observed && agentId && observed === agentId) {
        warnings.push(finding('warning', 'port_owned_by_same_agent', `port ${port} already has expected agent ${agentId} pid ${listener.pid}`))
      } else if (listener.orphan === true) {
        warnings.push(finding('warning', 'orphan_port_listener', `port ${port} has orphan pid ${listener.pid}`))
      } else {
        blockers.push(finding('blocker', 'port_owner_unknown', `port ${port} pid ${listener.pid} has unknown live owner`))
      }
    }
  }

  if (sessionName) {
    for (const evidence of input.tmuxRuntimeEvidence ?? []) {
      if (evidence.session_name !== sessionName) continue
      const observed = cleanText(evidence.observed_agent_id)
      const expected = cleanText(evidence.expected_agent_id)
      if (observed && agentId && observed !== agentId) {
        blockers.push(finding('blocker', 'tmux_session_bound_to_different_agent', `tmux ${sessionName} has ${observed}, not ${agentId}`))
      }
      if (observed && expected && observed !== expected) {
        blockers.push(finding('blocker', 'tmux_session_expected_agent_mismatch', `tmux ${sessionName} observed=${observed} expected=${expected}`))
      }
    }
  }

  if (isCodexCommand(input.command) && input.codexPostStartEnterPolicy === 'unconditional') {
    blockers.push(finding('blocker', 'codex_normal_screen_enter', 'Codex launcher would send Enter to the normal start screen'))
  }

  return {
    ok: blockers.length === 0,
    agent_id: agentId,
    expected_agent_id: expectedAgentId,
    session_name: sessionName,
    port,
    blockers,
    warnings,
  }
}
