import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  SHIRUBE_D1_FLEET_ACTIVATION_REF,
  isExactShirubeD1Fleet,
  type ShirubeD1RuntimeTarget,
} from '../shirube-d1-activation-policy'
import {
  classifyQueueWorkResidueRows,
  loadQueueWorkResiduePolicyFile,
  matchQueueWorkResiduePolicyEntry,
  type QueueWorkResiduePolicy,
  type QueueWorkResidueRow,
} from './queue-work-residue-policy'
import {
  parseAllAgentCommunicationManifest,
} from '../all-agent-communication-manifest'
import { validateProviderEffectsZeroActivationConfig } from '../provider-effects-activation-preflight'

export const STATE_DAEMON_LAUNCH_AGENT_LABEL = 'com.agent-comms.state-daemon'
export const STATE_DAEMON_PLIST_NAME = `${STATE_DAEMON_LAUNCH_AGENT_LABEL}.plist`
export const DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID = 'state_daemon'
export const DEFAULT_STATE_DAEMON_BUN_PATH = '/Users/yuji/.bun/bin/bun'
export const DEFAULT_STATE_DAEMON_DATABASE_URL = 'postgresql:///agent_comms?host=/tmp'
export const DEFAULT_STATE_DAEMON_DENYLIST = 'adf-dev,arc-test,auditor-test,ceo,codex-test,cto,cto-test,cto-test2,dev-001,hotfix-test,iyasaka-arc,test,test-probe,unknown'
export const STATE_DAEMON_DB_SSOT_CANARY_TARGETS = ['aun', 'codex-audit', 'adf-lead', 'devauditor'] as const
export const STATE_DAEMON_DB_SSOT_RETIRED_AGENT_ID = 'codex-aun'
export const STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST = 'sha256:3dda8cd2b471e907245b28b4a1c4f6e656d2d76c6eff9f5c5a44db698f2372bc'

const STATE_DAEMON_CANARY_OVERLAY_ENV_KEYS = [
  'STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF',
  'STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF',
  'STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT',
  'STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256',
  'STATE_DAEMON_CANARY_OVERLAY_ROLLBACK_COMMAND',
  'STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION',
  'STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST',
] as const

export type StateDaemonLaunchAgentConfig = {
  label: string | null
  programArguments: string[]
  workingDirectory: string | null
  standardOutPath: string | null
  standardErrorPath: string | null
  environmentVariables: Record<string, string>
}

export type StateDaemonRestorePlan = {
  commit: string
  restoreRoot: string
  checkoutPath: string
  entryPath: string
  logsDir: string
  buildOutfile: string
  plistPath: string
  tempPlistPath: string
  bunPath: string
  databaseUrl: string
  agentDenylist: string
  extraEnv: Record<string, string>
}

export type StateDaemonGithubWorkPullerActivationOptions = {
  enabled: boolean
  repos?: string[]
  labels?: string[]
  ownerAllowlist?: string[]
  intervalMs?: number
  writebackEnabled?: boolean
  tokenFile?: string | null
}

export type StateDaemonPreflightIssue = {
  code: string
  message: string
  path?: string
}

export type StateDaemonPreflightResult = {
  ok: boolean
  errors: StateDaemonPreflightIssue[]
  warnings: StateDaemonPreflightIssue[]
}

const ALL_AGENT_MANIFEST_ENV_KEYS = [
  'STATE_DAEMON_ALL_AGENT_MANIFEST_ID',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF',
  'STATE_DAEMON_ALL_AGENT_MANIFEST_PATH',
] as const

export function validateAllAgentCommunicationManifestLaunchAgentEnv(
  env: Record<string, string>,
): StateDaemonPreflightIssue[] {
  const issues: StateDaemonPreflightIssue[] = []
  const enabled = env.STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') {
    issues.push({
      code: 'all_agent_manifest_enforcement_invalid',
      message: 'STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED must be 0 or 1.',
    })
  }
  if (enabled !== '1') return issues
  for (const key of ALL_AGENT_MANIFEST_ENV_KEYS) {
    if (!env[key]?.trim()) {
      issues.push({ code: 'all_agent_manifest_identity_incomplete', message: `${key} is required when ordinary manifest enforcement is enabled.` })
    }
  }
  if (env.STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION
    && !/^[1-9]\d*$/.test(env.STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION)) {
    issues.push({ code: 'all_agent_manifest_revision_invalid', message: 'Manifest revision must be a positive integer.' })
  }
  for (const key of ['STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST', 'STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256']) {
    if (env[key] && !/^[0-9a-f]{64}$/.test(env[key])) {
      issues.push({ code: 'all_agent_manifest_digest_invalid', message: `${key} must be lowercase sha256.` })
    }
  }
  if (env.STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF
    && !/^https:\/\/github\.com\/[^\s]+$/.test(env.STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF)) {
    issues.push({ code: 'all_agent_manifest_owner_decision_ref_invalid', message: 'Manifest owner decision ref must be a GitHub URL.' })
  }
  if (env.STATE_DAEMON_ALL_AGENT_MANIFEST_PATH
    && !env.STATE_DAEMON_ALL_AGENT_MANIFEST_PATH.startsWith('/')) {
    issues.push({ code: 'all_agent_manifest_path_not_absolute', message: 'Manifest path must be absolute.' })
  }
  return issues
}

export function validateAllAgentCommunicationManifestArtifact(
  env: Record<string, string>,
  rawArtifact: string,
): StateDaemonPreflightIssue[] {
  if (env.STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED !== '1') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArtifact)
  } catch {
    return [{ code: 'all_agent_manifest_json_invalid', message: 'Ordinary manifest file must contain valid JSON.' }]
  }
  let manifest
  try {
    manifest = parseAllAgentCommunicationManifest(parsed)
  } catch (error) {
    return [{ code: 'all_agent_manifest_artifact_invalid', message: (error as Error).message }]
  }
  const expected: Array<[string, string, string]> = [
    ['manifest_id', manifest.manifest_id, env.STATE_DAEMON_ALL_AGENT_MANIFEST_ID ?? ''],
    ['revision', String(manifest.revision), env.STATE_DAEMON_ALL_AGENT_MANIFEST_REVISION ?? ''],
    ['artifact_digest', manifest.artifact_digest, env.STATE_DAEMON_ALL_AGENT_MANIFEST_ARTIFACT_DIGEST ?? ''],
    ['target_sha256', manifest.target_sha256, env.STATE_DAEMON_ALL_AGENT_MANIFEST_TARGET_SHA256 ?? ''],
    ['owner_decision_ref', manifest.owner_decision_ref, env.STATE_DAEMON_ALL_AGENT_MANIFEST_OWNER_DECISION_REF ?? ''],
  ]
  return expected
    .filter(([, actual, pinned]) => actual !== pinned)
    .map(([field]) => ({
      code: 'all_agent_manifest_env_artifact_mismatch',
      message: `Ordinary manifest ${field} does not match the pinned LaunchAgent environment.`,
    }))
}

export function validateShirubeD1LaunchAgentEnv(env: Record<string, string>): StateDaemonPreflightIssue[] {
  const issues: StateDaemonPreflightIssue[] = []
  const enabled = env.SHIRUBE_D1_ENABLED
  const killSwitch = env.SHIRUBE_D1_KILL_SWITCH
  const activationMode = env.SHIRUBE_D1_ACTIVATION_MODE ?? 'canary'
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') {
    issues.push({ code: 'shirube_d1_enabled_invalid', message: 'SHIRUBE_D1_ENABLED must be 0 or 1.' })
  }
  if (killSwitch !== undefined && killSwitch !== '0' && killSwitch !== '1') {
    issues.push({ code: 'shirube_d1_kill_switch_invalid', message: 'SHIRUBE_D1_KILL_SWITCH must be 0 or 1.' })
  }
  if (activationMode !== 'canary' && activationMode !== 'fleet') {
    issues.push({ code: 'shirube_d1_activation_mode_invalid', message: 'SHIRUBE_D1_ACTIVATION_MODE must be canary or fleet.' })
  }
  if (enabled !== '1') return issues
  if (killSwitch !== '0') {
    issues.push({ code: 'shirube_d1_kill_switch_active', message: 'Enabled Shirube D1 requires SHIRUBE_D1_KILL_SWITCH=0.' })
  }
  let targets: ShirubeD1RuntimeTarget[] = []
  try {
    const parsed = JSON.parse(env.SHIRUBE_D1_TARGET_ALLOWLIST ?? '')
    if (!Array.isArray(parsed)) throw new Error('not an array')
    targets = parsed as ShirubeD1RuntimeTarget[]
  } catch {
    issues.push({ code: 'shirube_d1_target_allowlist_invalid', message: 'SHIRUBE_D1_TARGET_ALLOWLIST must be a JSON array.' })
  }
  if (activationMode === 'canary' && targets.length !== 1) {
    issues.push({ code: 'shirube_d1_target_allowlist_not_exact', message: 'Protected Shirube D1 canary activation requires exactly one target tuple.' })
  } else {
    for (const target of targets as unknown as Record<string, unknown>[]) {
      if (!target || typeof target !== 'object' || ['repository', 'agent_id', 'control_source'].some((key) => typeof target[key] !== 'string' || !(target[key] as string).trim())) {
        issues.push({ code: 'shirube_d1_target_allowlist_invalid', message: 'The Shirube D1 target tuple requires repository, agent_id, and control_source.' })
        break
      }
    }
  }
  if (activationMode === 'fleet' && !isExactShirubeD1Fleet(targets)) {
    issues.push({ code: 'shirube_d1_target_allowlist_not_exact', message: 'Protected Shirube D1 fleet activation requires the exact owner-authorized five target tuples.' })
  }
  if (activationMode === 'fleet' && env.SHIRUBE_D1_FLEET_ACTIVATION_REF !== SHIRUBE_D1_FLEET_ACTIVATION_REF) {
    issues.push({ code: 'shirube_d1_fleet_activation_ref_invalid', message: `SHIRUBE_D1_FLEET_ACTIVATION_REF must equal ${SHIRUBE_D1_FLEET_ACTIVATION_REF}.` })
  }
  if (!/^[0-9a-f]{64}$/.test(env.SHIRUBE_D1_AUTHORIZATION_DIGEST ?? '')) {
    issues.push({ code: 'shirube_d1_authorization_digest_invalid', message: 'SHIRUBE_D1_AUTHORIZATION_DIGEST must be 64 lowercase hex.' })
  }
  if (!/^[0-9a-f]{40}$/.test(env.SHIRUBE_D1_ADAPTER_HEAD_SHA ?? '')) {
    issues.push({ code: 'shirube_d1_adapter_head_invalid', message: 'SHIRUBE_D1_ADAPTER_HEAD_SHA must be 40 lowercase hex.' })
  }
  for (const name of ['SHIRUBE_D1_AUDIT_REF', 'SHIRUBE_D1_QA_REF', 'SHIRUBE_D1_CHECK_REF', 'SHIRUBE_D1_CTO_GO_REF']) {
    if (!/^https:\/\/github\.com\/[^\s]+$/.test(env[name] ?? '')) {
      issues.push({ code: `shirube_d1_${name.slice('SHIRUBE_D1_'.length).toLowerCase()}_invalid`, message: `${name} must be a GitHub evidence URL.` })
    }
  }
  return issues
}

export type QueueWorkCanaryResidueRow = {
  id: number | string
  agent_id: string
  message_id: string | null
  payload?: string | null
  status: string
  created_at: string | Date
  claimed_by: string | null
  claimed_at: string | Date | null
  claim_expires_at: string | Date | null
}

export type QueueWorkCanaryResidueDb = {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

export type QueueWorkCanaryResiduePreflightResult = StateDaemonPreflightResult & {
  residues: QueueWorkCanaryResidueRow[]
}

export type QueueWorkResiduePolicyPreflightOptions = {
  limit?: number
  residuePolicy?: QueueWorkResiduePolicy | null
}

export type PathProbe = {
  exists(path: string): boolean
  isDirectory(path: string): boolean
  isFile(path: string): boolean
  isExecutable(path: string): boolean
  readText?(path: string): string
}

export type StateDaemonPruneTarget = {
  path: string
  action: 'delete' | 'keep' | 'protect'
  reason: string
}

export function defaultStateDaemonRestoreRoot(home = homedir()): string {
  return join(home, '.agent-comms', 'state-daemon', 'checkouts')
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

function keyString(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`))
  return match ? xmlUnescape(match[1]) : null
}

function keyDict(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<dict>([\\s\\S]*?)</dict>`))
  return match ? match[1] : null
}

function keyArray(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`))
  return match ? match[1] : null
}

function parseStringArray(body: string | null): string[] {
  if (!body) return []
  return [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]))
}

function parseStringDict(body: string | null): Record<string, string> {
  if (!body) return {}
  const env: Record<string, string> = {}
  const entries = [...body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)]
  for (const [, key, value] of entries) {
    env[xmlUnescape(key)] = xmlUnescape(value)
  }
  return env
}

export function parseStateDaemonLaunchAgentPlist(plist: string): StateDaemonLaunchAgentConfig {
  return {
    label: keyString(plist, 'Label'),
    programArguments: parseStringArray(keyArray(plist, 'ProgramArguments')),
    workingDirectory: keyString(plist, 'WorkingDirectory'),
    standardOutPath: keyString(plist, 'StandardOutPath'),
    standardErrorPath: keyString(plist, 'StandardErrorPath'),
    environmentVariables: parseStringDict(keyDict(plist, 'EnvironmentVariables')),
  }
}

export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent)
  const resolvedChild = resolve(child)
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${sep}`)
}

export function isEphemeralLaunchAgentPath(path: string): boolean {
  const resolved = resolve(path)
  return resolved === '/tmp'
    || resolved === '/private/tmp'
    || resolved.startsWith('/tmp/')
    || resolved.startsWith('/private/tmp/')
}

export function buildStateDaemonRestorePlan(options: {
  commit: string
  restoreRoot?: string
  launchAgentsDir?: string
  bunPath?: string
  databaseUrl?: string
  agentDenylist?: string
  extraEnv?: Record<string, string>
  pid?: number
}): StateDaemonRestorePlan {
  const commit = options.commit.trim()
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`commit must be a git SHA, got ${JSON.stringify(options.commit)}`)
  }
  const restoreRoot = resolve(options.restoreRoot ?? defaultStateDaemonRestoreRoot())
  const checkoutPath = join(restoreRoot, commit)
  const buildArtifactsRoot = join(dirname(restoreRoot), 'build-artifacts', commit)
  const logsDir = join(checkoutPath, 'logs')
  const launchAgentsDir = resolve(options.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents'))
  const plistPath = join(launchAgentsDir, STATE_DAEMON_PLIST_NAME)
  const pid = options.pid ?? process.pid
  return {
    commit,
    restoreRoot,
    checkoutPath,
    entryPath: join(checkoutPath, 'bin', 'state-daemon.ts'),
    logsDir,
    buildOutfile: join(buildArtifactsRoot, 'state-daemon-build.js'),
    plistPath,
    tempPlistPath: join(launchAgentsDir, `.${STATE_DAEMON_PLIST_NAME}.${pid}.tmp`),
    bunPath: options.bunPath ?? DEFAULT_STATE_DAEMON_BUN_PATH,
    databaseUrl: options.databaseUrl ?? DEFAULT_STATE_DAEMON_DATABASE_URL,
    agentDenylist: options.agentDenylist ?? DEFAULT_STATE_DAEMON_DENYLIST,
    extraEnv: options.extraEnv ?? {},
  }
}

export function renderStateDaemonLaunchAgentPlist(plan: StateDaemonRestorePlan, extraEnv: Record<string, string> = {}): string {
  const mergedExtraEnv = { ...plan.extraEnv, ...extraEnv }
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: plan.databaseUrl,
    STATE_DAEMON_CODEX_RUNNER_ENABLED: '1',
    STATE_DAEMON_CODEX_RUNNER_DATABASE_URL: plan.databaseUrl,
    STATE_DAEMON_AGENT_DENYLIST: plan.agentDenylist,
    STATE_DAEMON_ALERT_CHANNEL: '1487368919613444156',
    STATE_DAEMON_RESTORE_MANAGED: '1',
    STATE_DAEMON_RESTORE_COMMIT: plan.commit,
    STATE_DAEMON_RESTORE_ROOT: plan.restoreRoot,
    PGUSER: process.env.PGUSER ?? process.env.USER ?? 'yuji',
    USER: process.env.USER ?? 'yuji',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    ...mergedExtraEnv,
    // The shared listener is never a bot-scoped runtime. Keep the canonical
    // identity last so restore inputs cannot accidentally turn it into one.
    AGENT_ID: DEFAULT_STATE_DAEMON_LISTENER_AGENT_ID,
  }
  if (!mergedExtraEnv.STATE_DAEMON_AGENT_ALLOWLIST) {
    delete env.STATE_DAEMON_AGENT_ALLOWLIST
    for (const key of STATE_DAEMON_CANARY_OVERLAY_ENV_KEYS) delete env[key]
  }

  const envXml = Object.entries(env)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(STATE_DAEMON_LAUNCH_AGENT_LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(plan.bunPath)}</string>
    <string>${xmlEscape(plan.entryPath)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(plan.checkoutPath)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(join(plan.logsDir, 'state-daemon.out.log'))}</string>

  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(plan.logsDir, 'state-daemon.err.log'))}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

function normalizeCsvValues(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean)
}

function parseCsvValue(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export type StateDaemonCanaryOverlayValidation = {
  active: boolean
  target: string | null
  expiresAt: string | null
  issues: StateDaemonPreflightIssue[]
}

export function validateStateDaemonCanaryOverlayEnv(
  env: Record<string, string>,
  now = new Date(),
): StateDaemonCanaryOverlayValidation {
  const allowlist = parseCsvValue(env.STATE_DAEMON_AGENT_ALLOWLIST)
  const target = allowlist.length === 1 ? allowlist[0] : null
  const issues: StateDaemonPreflightIssue[] = []
  const populatedOverlayKeys = STATE_DAEMON_CANARY_OVERLAY_ENV_KEYS
    .filter((key) => Boolean(env[key]?.trim()))

  if (allowlist.length === 0) {
    if (populatedOverlayKeys.length > 0) {
      issues.push({
        code: 'state_daemon_canary_overlay_without_target',
        message: 'Canary overlay metadata must not remain when STATE_DAEMON_AGENT_ALLOWLIST is absent.',
      })
    }
    return { active: false, target: null, expiresAt: null, issues }
  }

  if (allowlist.length !== 1) {
    issues.push({
      code: 'state_daemon_canary_overlay_target_not_exact',
      message: 'A temporary DB-SSOT canary overlay requires exactly one STATE_DAEMON_AGENT_ALLOWLIST target.',
    })
  }

  for (const key of STATE_DAEMON_CANARY_OVERLAY_ENV_KEYS) {
    if (!env[key]?.trim()) {
      issues.push({
        code: 'state_daemon_canary_overlay_identity_incomplete',
        message: `${key} is required whenever STATE_DAEMON_AGENT_ALLOWLIST is present.`,
      })
    }
  }

  if (target === STATE_DAEMON_DB_SSOT_RETIRED_AGENT_ID) {
    issues.push({
      code: 'state_daemon_canary_overlay_retired_target',
      message: `${STATE_DAEMON_DB_SSOT_RETIRED_AGENT_ID} is retired; the canonical agent id is aun.`,
    })
  } else if (target && !STATE_DAEMON_DB_SSOT_CANARY_TARGETS.includes(target as typeof STATE_DAEMON_DB_SSOT_CANARY_TARGETS[number])) {
    issues.push({
      code: 'state_daemon_canary_overlay_target_outside_cohort',
      message: `Canary overlay target ${target} is outside the owner-authorized four-agent cohort.`,
    })
  }

  for (const key of ['STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF', 'STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF'] as const) {
    const value = env[key]?.trim()
    if (value && !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+#issuecomment-\d+$/.test(value)) {
      issues.push({
        code: 'state_daemon_canary_overlay_ref_invalid',
        message: `${key} must be an immutable GitHub issue or pull-request comment URL.`,
      })
    }
  }
  const controlRef = env.STATE_DAEMON_CANARY_OVERLAY_CONTROL_REF?.trim()
  const ownerDecisionRef = env.STATE_DAEMON_CANARY_OVERLAY_OWNER_DECISION_REF?.trim()
  if (controlRef && ownerDecisionRef && controlRef === ownerDecisionRef) {
    issues.push({
      code: 'state_daemon_canary_overlay_refs_not_distinct',
      message: 'Canary control handoff and owner activation decision must cite separate immutable comments.',
    })
  }

  const expiresAt = env.STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT?.trim() || null
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt)
    if (!Number.isFinite(expiresAtMs)) {
      issues.push({
        code: 'state_daemon_canary_overlay_expiry_invalid',
        message: 'STATE_DAEMON_CANARY_OVERLAY_EXPIRES_AT must be a valid timestamp.',
      })
    } else if (expiresAtMs <= now.getTime()) {
      issues.push({
        code: 'state_daemon_canary_overlay_expired',
        message: 'The temporary state-daemon canary overlay has expired and must be removed before processing.',
      })
    }
  }

  const priorPlistDigest = env.STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256?.trim()
  if (priorPlistDigest && !/^[0-9a-f]{64}$/.test(priorPlistDigest)) {
    issues.push({
      code: 'state_daemon_canary_overlay_prior_plist_digest_invalid',
      message: 'STATE_DAEMON_CANARY_OVERLAY_PRIOR_PLIST_SHA256 must be 64 lowercase hex.',
    })
  }

  const observedStateDestination = env.STATE_DAEMON_CANARY_OVERLAY_OBSERVED_STATE_DESTINATION?.trim()
  if (observedStateDestination
    && !observedStateDestination.startsWith('/')
    && !/^https:\/\/github\.com\/[^\s]+$/.test(observedStateDestination)) {
    issues.push({
      code: 'state_daemon_canary_overlay_observed_state_destination_invalid',
      message: 'Observed-state destination must be an absolute path or immutable GitHub URL.',
    })
  }

  const subjectDigest = env.STATE_DAEMON_CANARY_OVERLAY_SUBJECT_DIGEST?.trim()
  if (subjectDigest && subjectDigest !== STATE_DAEMON_DB_SSOT_DESIGN_SUBJECT_DIGEST) {
    issues.push({
      code: 'state_daemon_canary_overlay_subject_digest_mismatch',
      message: 'Canary overlay subject digest does not match the admitted Issue #917 DesignPack.',
    })
  }

  return { active: true, target, expiresAt, issues }
}

function isCanaryLabel(label: string): boolean {
  return label.trim().toLowerCase().startsWith('canary:')
}

export function queueWorkSchedulerLaunchAgentEnabled(env: Record<string, string>): boolean {
  const value = env.STATE_DAEMON_QUEUE_WORK_SCHEDULER_ENABLED
  return value === '1' || value?.toLowerCase() === 'true'
}

export function buildGithubWorkPullerLaunchAgentEnv(
  options: StateDaemonGithubWorkPullerActivationOptions,
): Record<string, string> {
  if (!options.enabled) return {}
  const repos = normalizeCsvValues(options.repos)
  const labels = normalizeCsvValues(options.labels)
  const ownerAllowlist = normalizeCsvValues(options.ownerAllowlist)
  const tokenFile = options.tokenFile?.trim()
  if (repos.length !== 1) {
    throw new Error('bounded GitHub work puller activation requires exactly one repo')
  }
  if (labels.length !== 1 || !isCanaryLabel(labels[0])) {
    throw new Error('bounded GitHub work puller activation requires exactly one canary:* label')
  }
  if (ownerAllowlist.length !== 1) {
    throw new Error('bounded GitHub work puller activation requires exactly one owner allowlist entry')
  }
  if (!tokenFile) {
    throw new Error('bounded GitHub work puller activation requires --github-token-file')
  }
  const env: Record<string, string> = {
    STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED: '1',
    STATE_DAEMON_GITHUB_WORK_REPOS: repos.join(','),
    STATE_DAEMON_GITHUB_WORK_LABELS: labels.join(','),
    STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST: ownerAllowlist.join(','),
    STATE_DAEMON_GITHUB_TOKEN_FILE: resolve(tokenFile),
  }
  if (options.intervalMs !== undefined) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error('bounded GitHub work puller activation requires a positive interval')
    }
    env.STATE_DAEMON_GITHUB_WORK_INTERVAL_MS = String(Math.round(options.intervalMs))
  }
  if (options.writebackEnabled) {
    env.STATE_DAEMON_GITHUB_WORK_WRITEBACK_ENABLED = '1'
  }
  return env
}

export function validateStateDaemonLaunchAgentConfig(
  config: StateDaemonLaunchAgentConfig,
  options: {
    probe?: PathProbe
    allowRestoreOwnedTemp?: boolean
    restoreRoot?: string | null
    now?: () => Date
  } = {},
): StateDaemonPreflightResult {
  const probe = options.probe ?? {
    exists: existsSync,
    isDirectory: (path: string) => {
      try { return statSync(path).isDirectory() } catch { return false }
    },
    isFile: (path: string) => {
      try { return statSync(path).isFile() } catch { return false }
    },
    isExecutable: (path: string) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    },
    readText: (path: string) => readFileSync(path, 'utf8'),
  }
  const errors: StateDaemonPreflightIssue[] = []
  const warnings: StateDaemonPreflightIssue[] = []
  const entry = config.programArguments[1] ?? null
  const workingDirectory = config.workingDirectory
  const restoreRoot = options.restoreRoot ?? config.environmentVariables.STATE_DAEMON_RESTORE_ROOT ?? null
  const restoreOwned = config.environmentVariables.STATE_DAEMON_RESTORE_MANAGED === '1'
  const env = config.environmentVariables

  if (config.label !== STATE_DAEMON_LAUNCH_AGENT_LABEL) {
    errors.push({
      code: 'state_daemon_label_mismatch',
      message: `LaunchAgent label must be ${STATE_DAEMON_LAUNCH_AGENT_LABEL}`,
    })
  }
  if (config.programArguments.length < 2) {
    errors.push({
      code: 'program_arguments_entry_missing',
      message: 'ProgramArguments[1] must point to bin/state-daemon.ts or a verified state-daemon artifact',
    })
  }
  const executable = config.programArguments[0] ?? null
  if (!executable || !probe.exists(executable)) {
    errors.push({
      code: 'bun_path_missing',
      message: 'ProgramArguments[0] does not exist; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable ?? undefined,
    })
  } else if (!probe.isFile(executable)) {
    errors.push({
      code: 'bun_path_not_file',
      message: 'ProgramArguments[0] must be a regular executable file; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable,
    })
  } else if (!probe.isExecutable(executable)) {
    errors.push({
      code: 'bun_path_not_executable',
      message: 'ProgramArguments[0] is not executable; refusing launchd load/kickstart because launchd cannot exec bun',
      path: executable,
    })
  }
  if (!entry || !probe.exists(entry)) {
    errors.push({
      code: 'state_daemon_entry_missing',
      message: 'ProgramArguments[1] does not exist; refusing launchd load/kickstart to avoid Module not found crash-loop',
      path: entry ?? undefined,
    })
  }
  if (!workingDirectory || !probe.exists(workingDirectory) || !probe.isDirectory(workingDirectory)) {
    errors.push({
      code: 'working_directory_missing',
      message: 'WorkingDirectory does not exist; refusing launchd load/kickstart',
      path: workingDirectory ?? undefined,
    })
  }

  for (const path of [entry, workingDirectory]) {
    if (!path || !isEphemeralLaunchAgentPath(path)) continue
    const restoreOwnedTemp = Boolean(
      options.allowRestoreOwnedTemp
      && restoreOwned
      && restoreRoot
      && isPathInside(restoreRoot, path),
    )
    if (!restoreOwnedTemp) {
      errors.push({
        code: 'ephemeral_launchagent_path',
        message: 'LaunchAgent target must not point at an unowned /tmp or /private/tmp checkout',
        path,
      })
    }
  }

  if (entry && workingDirectory && !isPathInside(workingDirectory, entry)) {
    warnings.push({
      code: 'entry_outside_working_directory',
      message: 'ProgramArguments[1] is outside WorkingDirectory; verify the artifact/check-out ownership contract',
      path: entry,
    })
  }

  if (env.STATE_DAEMON_GITHUB_TOKEN || env.GITHUB_TOKEN) {
    errors.push({
      code: 'github_token_embedded_in_launchagent',
      message: 'LaunchAgent must not embed raw GitHub token values; use STATE_DAEMON_GITHUB_TOKEN_FILE',
    })
  }

  errors.push(...validateShirubeD1LaunchAgentEnv(env))
  errors.push(...validateAllAgentCommunicationManifestLaunchAgentEnv(env))
  errors.push(...validateStateDaemonCanaryOverlayEnv(env, options.now?.() ?? new Date()).issues)
  errors.push(...validateProviderEffectsZeroActivationConfig(env, {
    nowMs: options.now?.().getTime() ?? Date.now(),
  }).issues)
  const allAgentManifestPath = env.STATE_DAEMON_ALL_AGENT_MANIFEST_PATH?.trim()
  if (env.STATE_DAEMON_ALL_AGENT_MANIFEST_ENFORCEMENT_ENABLED === '1' && allAgentManifestPath) {
    if (!probe.exists(allAgentManifestPath)) {
      errors.push({ code: 'all_agent_manifest_file_missing', message: 'Ordinary manifest file does not exist.', path: allAgentManifestPath })
    } else if (!probe.isFile(allAgentManifestPath)) {
      errors.push({ code: 'all_agent_manifest_path_not_file', message: 'Ordinary manifest path must be a regular file.', path: allAgentManifestPath })
    } else if (!probe.readText) {
      errors.push({ code: 'all_agent_manifest_content_unavailable', message: 'Ordinary manifest bytes must be readable during preflight.', path: allAgentManifestPath })
    } else {
      try {
        errors.push(...validateAllAgentCommunicationManifestArtifact(env, probe.readText(allAgentManifestPath)))
      } catch (error) {
        errors.push({ code: 'all_agent_manifest_read_failed', message: (error as Error).message, path: allAgentManifestPath })
      }
    }
  }

  if (env.STATE_DAEMON_GITHUB_WORK_PULLER_ENABLED === '1') {
    const repos = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_REPOS)
    const labels = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_LABELS)
    const ownerAllowlist = parseCsvValue(env.STATE_DAEMON_GITHUB_WORK_OWNER_ALLOWLIST)
    const tokenFile = env.STATE_DAEMON_GITHUB_TOKEN_FILE?.trim()
    if (repos.length !== 1) {
      errors.push({
        code: 'github_work_puller_requires_single_repo',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one repo',
      })
    }
    if (labels.length !== 1 || !isCanaryLabel(labels[0] ?? '')) {
      errors.push({
        code: 'github_work_puller_requires_single_canary_label',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one canary:* label',
      })
    }
    if (ownerAllowlist.length !== 1) {
      errors.push({
        code: 'github_work_puller_requires_single_owner_allowlist',
        message: 'Bounded GitHub work puller LaunchAgent activation requires exactly one owner allowlist entry',
      })
    }
    if (!tokenFile) {
      errors.push({
        code: 'github_work_puller_token_file_required',
        message: 'Bounded GitHub work puller LaunchAgent activation requires STATE_DAEMON_GITHUB_TOKEN_FILE',
      })
    } else if (!probe.exists(tokenFile)) {
      errors.push({
        code: 'github_work_puller_token_file_missing',
        message: 'STATE_DAEMON_GITHUB_TOKEN_FILE does not exist',
        path: tokenFile,
      })
    } else if (!probe.isFile(tokenFile)) {
      errors.push({
        code: 'github_work_puller_token_file_not_file',
        message: 'STATE_DAEMON_GITHUB_TOKEN_FILE must point to a regular file',
        path: tokenFile,
      })
    }
  }

  const queueWorkSchedulerEnabled = queueWorkSchedulerLaunchAgentEnabled(env)
  const expiredClaimRecoveryValue = env.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM?.trim()
  const doneFinalizationResumeValue = env.STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION?.trim()
  const deferNewerPendingValue = env.STATE_DAEMON_QUEUE_WORK_DEFER_NEWER_PENDING?.trim()
  if (expiredClaimRecoveryValue && expiredClaimRecoveryValue !== '1') {
    errors.push({
      code: 'queue_work_expired_claim_recovery_flag_invalid',
      message: 'STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM must be 1 when present.',
    })
  }
  if (expiredClaimRecoveryValue === '1' && !queueWorkSchedulerEnabled) {
    errors.push({
      code: 'queue_work_expired_claim_recovery_requires_scheduler',
      message: 'Expired scheduler claim recovery requires the queue-work scheduler to be enabled.',
    })
  }
  if (doneFinalizationResumeValue && doneFinalizationResumeValue !== '1') {
    errors.push({
      code: 'queue_work_done_finalization_resume_flag_invalid',
      message: 'STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION must be 1 when present.',
    })
  }
  if (doneFinalizationResumeValue === '1' && !queueWorkSchedulerEnabled) {
    errors.push({
      code: 'queue_work_done_finalization_resume_requires_scheduler',
      message: 'Done queue-work finalization resume requires the queue-work scheduler to be enabled.',
    })
  }
  if (deferNewerPendingValue && deferNewerPendingValue !== '1') {
    errors.push({
      code: 'queue_work_defer_newer_pending_flag_invalid',
      message: 'STATE_DAEMON_QUEUE_WORK_DEFER_NEWER_PENDING must be 1 when present.',
    })
  }
  if (deferNewerPendingValue === '1' && !queueWorkSchedulerEnabled) {
    errors.push({
      code: 'queue_work_defer_newer_pending_requires_scheduler',
      message: 'Serial pending deferral requires the queue-work scheduler to be enabled.',
    })
  }
  const activationModes = [
    expiredClaimRecoveryValue === '1',
    doneFinalizationResumeValue === '1',
    deferNewerPendingValue === '1',
  ].filter(Boolean).length
  if (activationModes > 1) {
    errors.push({
      code: 'queue_work_activation_mode_conflict',
      message: 'Expired-claim recovery, done finalization resume, and serial pending deferral are mutually exclusive.',
    })
  }
  if (queueWorkSchedulerEnabled) {
    // Fleet mode (owner ruling 6 amended, iyasaka-arc#24 comment 4921804733):
    // after the fenced single-seat canary has a terminal PASS + audit PASS,
    // the scheduler may run for the whole fleet without a fence. Fail-closed
    // conditions: fleet mode must cite the authorizing decision URL and must
    // carry a governed residue policy file (unclassified non-terminal rows
    // stay protected per row instead of per fence).
    const fleetMode = env.STATE_DAEMON_QUEUE_WORK_FLEET_MODE?.trim() === '1'
    const fleetDecisionRef = env.STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF?.trim() ?? ''
    if (fleetMode) {
      if (!/^https:\/\/github\.com\//.test(fleetDecisionRef)) {
        errors.push({
          code: 'queue_work_fleet_mode_requires_decision_ref',
          message: 'Fleet-mode scheduler activation must cite the authorizing owner decision as a GitHub URL in STATE_DAEMON_QUEUE_WORK_FLEET_DECISION_REF.',
        })
      }
      if (!env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()) {
        errors.push({
          code: 'queue_work_fleet_mode_requires_residue_policy',
          message: 'Fleet-mode scheduler activation must carry a governed residue policy file (STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE).',
        })
      }
    }

    const allowlist = (env.STATE_DAEMON_AGENT_ALLOWLIST ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    if (allowlist.length > 1) {
      errors.push({
        code: 'queue_work_scheduler_requires_single_agent_allowlist',
        message: 'Queue-work scheduler activation may use at most one temporary STATE_DAEMON_AGENT_ALLOWLIST overlay; broad persistent host allowlists are not authoritative.',
      })
    }

    const fenceQueueIds = (env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const fenceMessageIds = (env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
    if (
      expiredClaimRecoveryValue === '1'
      && (
        fleetMode
        || allowlist.length !== 1
        || fenceQueueIds.length !== 1
        || fenceMessageIds.length > 1
        || !fenceCreatedAfter
        || !Number.isFinite(Date.parse(fenceCreatedAfter))
      )
    ) {
      errors.push({
        code: 'queue_work_expired_claim_recovery_requires_exact_fence',
        message: 'Expired scheduler claim recovery requires single-agent, single-queue, non-fleet fencing with a valid created-after timestamp.',
      })
    }
    if (!fleetMode && fenceQueueIds.length === 0 && fenceMessageIds.length === 0 && !fenceCreatedAfter) {
      errors.push({
        code: 'queue_work_scheduler_requires_canary_fence',
        message: 'Queue-work scheduler activation must specify a queue-work fence so existing non-terminal rows cannot be processed by a bounded canary.',
      })
    }
    if (fenceQueueIds.some((item) => !/^[1-9]\d*$/.test(item))) {
      errors.push({
        code: 'queue_work_fence_queue_ids_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS must contain positive integer queue ids.',
      })
    }
    if (fenceCreatedAfter && !Number.isFinite(Date.parse(fenceCreatedAfter))) {
      errors.push({
        code: 'queue_work_fence_created_after_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER must be a valid timestamp.',
      })
    }
    const residuePolicyFile = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()
    if (residuePolicyFile) {
      if (!probe.exists(residuePolicyFile)) {
        errors.push({
          code: 'queue_work_residue_policy_file_missing',
          message: 'STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE does not exist.',
          path: residuePolicyFile,
        })
      } else if (!probe.isFile(residuePolicyFile)) {
        errors.push({
          code: 'queue_work_residue_policy_file_not_file',
          message: 'STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE must point to a regular file.',
          path: residuePolicyFile,
        })
      }
    }

    const runtime = env.STATE_DAEMON_QUEUE_WORK_RUNTIME ?? env.AUN_QUEUE_WORK_RUNTIME
    const command = env.STATE_DAEMON_QUEUE_WORK_COMMAND ?? env.AUN_QUEUE_WORK_COMMAND
    const effectiveRuntime = runtime ?? (command ? 'command-json' : null)
    const handoffContract = env.STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT
      ?? env.AUN_QUEUE_WORK_HANDOFF_CONTRACT
      ?? null
    const githubWritebackMode = env.STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? env.AUN_QUEUE_WORK_GITHUB_WRITEBACK_MODE
      ?? null
    const mediatedPostingCommand = env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND
      ?? env.AUN_QUEUE_WORK_MEDIATED_POSTING_COMMAND
      ?? null
    if (!effectiveRuntime) {
      errors.push({
        code: 'queue_work_runtime_unconfigured',
        message: 'Queue-work scheduler activation requires STATE_DAEMON_QUEUE_WORK_RUNTIME or STATE_DAEMON_QUEUE_WORK_COMMAND before launch.',
      })
    }
    if (effectiveRuntime === 'command-json' && !command) {
      errors.push({
        code: 'queue_work_command_missing',
        message: 'STATE_DAEMON_QUEUE_WORK_RUNTIME=command-json requires STATE_DAEMON_QUEUE_WORK_COMMAND.',
      })
    }
    if (effectiveRuntime === 'codex-exec') {
      const schemaPath = env.STATE_DAEMON_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
        ?? env.AUN_QUEUE_WORK_CODEX_OUTPUT_SCHEMA
        ?? (workingDirectory ? join(workingDirectory, 'schemas', 'queue-work-result-v1.schema.json') : null)
      if (!schemaPath || !probe.exists(schemaPath) || !probe.isFile(schemaPath)) {
        errors.push({
          code: 'queue_work_codex_schema_missing',
          message: 'STATE_DAEMON_QUEUE_WORK_RUNTIME=codex-exec requires a readable queue_work_result_v1 schema file.',
          path: schemaPath ?? undefined,
        })
      }
    }
    if (handoffContract && !['plain_queue_work', 'github_backed_role_handoff'].includes(handoffContract)) {
      errors.push({
        code: 'queue_work_handoff_contract_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_HANDOFF_CONTRACT must be plain_queue_work or github_backed_role_handoff.',
      })
    }
    if (githubWritebackMode && !['none', 'mediated'].includes(githubWritebackMode)) {
      errors.push({
        code: 'queue_work_github_writeback_mode_invalid',
        message: 'STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE must be none or mediated.',
      })
    }
    if (handoffContract === 'github_backed_role_handoff') {
      if (githubWritebackMode !== 'mediated') {
        errors.push({
          code: 'queue_work_github_handoff_requires_mediated_posting',
          message: 'GitHub-backed queue-work handoffs require STATE_DAEMON_QUEUE_WORK_GITHUB_WRITEBACK_MODE=mediated before activation.',
        })
      }
      if (!mediatedPostingCommand) {
        errors.push({
          code: 'queue_work_mediated_posting_command_missing',
          message: 'GitHub-backed mediated queue-work handoffs require STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND.',
        })
      } else if (!probe.exists(mediatedPostingCommand)) {
        errors.push({
          code: 'queue_work_mediated_posting_command_not_found',
          message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND does not exist.',
          path: mediatedPostingCommand,
        })
      } else if (!probe.isFile(mediatedPostingCommand)) {
        errors.push({
          code: 'queue_work_mediated_posting_command_not_file',
          message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND must point to a regular file.',
          path: mediatedPostingCommand,
        })
      } else if (!probe.isExecutable(mediatedPostingCommand)) {
        errors.push({
          code: 'queue_work_mediated_posting_command_not_executable',
          message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_COMMAND must be executable.',
          path: mediatedPostingCommand,
        })
      }
      const postingArgsJson = env.STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
        ?? env.AUN_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON
      if (postingArgsJson) {
        try {
          const parsed = JSON.parse(postingArgsJson)
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error('not string array')
          }
        } catch {
          errors.push({
            code: 'queue_work_mediated_posting_args_invalid',
            message: 'STATE_DAEMON_QUEUE_WORK_MEDIATED_POSTING_ARGS_JSON must be a JSON string array.',
          })
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function queueWorkFenceConditionsFromEnv(env: Record<string, string>, params: unknown[], alias: string): string[] {
  const conditions: string[] = []
  const fenceQueueIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS)
  const fenceMessageIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
  if (fenceQueueIds.length > 0) {
    params.push(fenceQueueIds.map((item) => Number.parseInt(item, 10)))
    conditions.push(`COALESCE(${alias}.id = ANY($${params.length}::bigint[]), false)`)
  }
  if (fenceMessageIds.length > 0) {
    params.push(fenceMessageIds)
    conditions.push(`COALESCE(${alias}.message_id = ANY($${params.length}::text[]), false)`)
  }
  if (fenceCreatedAfter) {
    params.push(fenceCreatedAfter)
    conditions.push(`COALESCE(${alias}.created_at >= $${params.length}::timestamptz, false)`)
  }
  return conditions
}

export function loadQueueWorkResiduePolicyFromEnv(env: Record<string, string>): QueueWorkResiduePolicy | null {
  const policyFile = env.STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE?.trim()
  return policyFile ? loadQueueWorkResiduePolicyFile(policyFile) : null
}

export async function validateQueueWorkCanaryResiduePreflight(
  db: QueueWorkCanaryResidueDb,
  env: Record<string, string>,
  options: QueueWorkResiduePolicyPreflightOptions = {},
): Promise<QueueWorkCanaryResiduePreflightResult> {
  const errors: StateDaemonPreflightIssue[] = []
  const warnings: StateDaemonPreflightIssue[] = []
  if (!queueWorkSchedulerLaunchAgentEnabled(env)) {
    return { ok: true, errors, warnings, residues: [] }
  }

  const allowlist = parseCsvValue(env.STATE_DAEMON_AGENT_ALLOWLIST)
  const fenceQueueIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_QUEUE_IDS)
  const fenceMessageIds = parseCsvValue(env.STATE_DAEMON_QUEUE_WORK_FENCE_MESSAGE_IDS)
  const fenceCreatedAfter = env.STATE_DAEMON_QUEUE_WORK_FENCE_CREATED_AFTER?.trim()
  const expiredClaimRecovery = env.STATE_DAEMON_QUEUE_WORK_RECOVER_EXPIRED_SCHEDULER_CLAIM?.trim() === '1'
  const doneFinalizationResume = env.STATE_DAEMON_QUEUE_WORK_RESUME_DONE_FINALIZATION?.trim() === '1'
  const deferNewerPending = env.STATE_DAEMON_QUEUE_WORK_DEFER_NEWER_PENDING?.trim() === '1'
  const exactResume = expiredClaimRecovery || doneFinalizationResume
  const exactSerial = exactResume || deferNewerPending
  if (
    exactSerial
    && (
      allowlist.length !== 1
      || fenceQueueIds.length !== 1
      || fenceMessageIds.length > 1
      || !fenceCreatedAfter
      || !Number.isFinite(Date.parse(fenceCreatedAfter))
    )
  ) {
    errors.push({
      code: doneFinalizationResume
        ? 'queue_work_done_finalization_resume_requires_exact_fence'
        : expiredClaimRecovery
          ? 'queue_work_expired_claim_recovery_requires_exact_fence'
          : 'queue_work_defer_newer_pending_requires_exact_fence',
      message: `${doneFinalizationResume
        ? 'Done finalization resume'
        : expiredClaimRecovery
          ? 'Expired scheduler claim recovery'
          : 'Serial pending deferral'} residue preflight requires one agent, one queue id, at most one message id, and a valid created-after timestamp.`,
    })
    return { ok: false, errors, warnings, residues: [] }
  }
  if (
    allowlist.length !== 1
    || (fenceQueueIds.length === 0 && fenceMessageIds.length === 0 && !fenceCreatedAfter)
    || fenceQueueIds.some((item) => !/^[1-9]\d*$/.test(item))
    || (fenceCreatedAfter && !Number.isFinite(Date.parse(fenceCreatedAfter)))
  ) {
    return { ok: true, errors, warnings, residues: [] }
  }

  const params: unknown[] = [allowlist[0]]
  const fenceConditions = queueWorkFenceConditionsFromEnv(env, params, 'mq')
  if (fenceConditions.length === 0) {
    return { ok: true, errors, warnings, residues: [] }
  }
  const limit = options.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit >= Number.MAX_SAFE_INTEGER) {
    errors.push({
      code: 'queue_work_canary_residue_preflight_limit_invalid',
      message: 'Queue-work scheduler canary residue preflight requires a positive safe row limit.',
    })
    return { ok: false, errors, warnings, residues: [] }
  }
  // Fetch one sentinel row beyond the bounded validation set. A plain
  // LIMIT would otherwise let an unsafe claimed/executed row hide just
  // beyond the scan and incorrectly produce an activation GO.
  params.push(limit + 1)
  try {
    const result = await db.query<QueueWorkCanaryResidueRow>(
      `SELECT mq.id, mq.agent_id, mq.message_id, mq.payload, mq.status, mq.created_at,
              mq.claimed_by, mq.claimed_at, mq.claim_expires_at
         FROM message_queue mq
        WHERE mq.agent_id = $1
          AND mq.status IN ('pending', 'received', 'in_progress')
          AND NOT (${fenceConditions.join(' AND ')})
        ORDER BY mq.created_at ASC, mq.id ASC
        LIMIT $${params.length}`,
      params,
    )
    const residues = result.rows ?? []
    if (residues.length > limit) {
      const sentinel = residues[limit]
      errors.push({
        code: 'queue_work_canary_residue_preflight_truncated',
        message: `Queue-work scheduler canary residue preflight found more than ${limit} non-fenced non-terminal row(s); validation is not exhaustive (first unvalidated row ${sentinel?.id ?? '(unknown)'}:${sentinel?.status ?? '(unknown)'}:${sentinel?.message_id ?? '(no-message-id)'}). Refusing activation.`,
      })
      return { ok: false, errors, warnings, residues }
    }
    if (residues.length > 0) {
      if (exactSerial) {
        const governedQueueIds = new Set<number>()
        if (options.residuePolicy) {
          for (const row of residues) {
            const queueId = Number(row.id)
            const entry = options.residuePolicy.entries.find((item) => item.queue_id === queueId)
            if (!entry) continue
            const classification = matchQueueWorkResiduePolicyEntry(entry, row)
            if (classification.matched) {
              governedQueueIds.add(queueId)
            } else {
              errors.push({
                code: 'queue_work_residue_policy_mismatch',
                message: `queue ${queueId} does not match governed residue policy: ${classification.mismatches.join('; ')}`,
              })
            }
          }
        }
        const serialResidues = residues.filter((row) => !governedQueueIds.has(Number(row.id)))
        const targetCreatedAtMs = Date.parse(fenceCreatedAfter!)
        const unsafeResidues = serialResidues.filter((row) => {
          const createdAtMs = row.created_at instanceof Date
            ? row.created_at.getTime()
            : Date.parse(row.created_at)
          let payload: Record<string, unknown> = {}
          try {
            const parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : {}
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
            payload = parsed as Record<string, unknown>
          } catch {
            return true
          }
          const untouched = payload.receive_claim == null
            && payload.queue_work_execution == null
            && payload.runner_error == null
          return row.agent_id !== allowlist[0]
            || row.status !== 'pending'
            || !Number.isFinite(createdAtMs)
            || createdAtMs <= targetCreatedAtMs
            || row.claimed_by !== null
            || row.claimed_at !== null
            || row.claim_expires_at !== null
            || !untouched
        })
        if (unsafeResidues.length > 0) {
          errors.push({
            code: doneFinalizationResume
              ? 'queue_work_done_finalization_resume_unsafe_residue'
              : expiredClaimRecovery
                ? 'queue_work_expired_claim_recovery_unsafe_residue'
                : 'queue_work_defer_newer_pending_unsafe_residue',
            message: `${doneFinalizationResume
              ? 'Done finalization resume'
              : expiredClaimRecovery
                ? 'Expired scheduler claim recovery'
                : 'Serial pending deferral'} found ${unsafeResidues.length} non-fenced row(s) that are not newer untouched pending work: ${
              unsafeResidues.map((row) => `${row.id}:${row.status}:${row.message_id ?? '(no-message-id)'}`).join(', ')
            }. Refusing activation.`,
          })
        } else if (serialResidues.length > 0) {
          warnings.push({
            code: doneFinalizationResume
              ? 'queue_work_done_finalization_resume_newer_pending_deferred'
              : expiredClaimRecovery
                ? 'queue_work_expired_claim_recovery_newer_pending_deferred'
                : 'queue_work_serial_pending_newer_pending_deferred',
            message: `${serialResidues.length} newer untouched pending row(s) remain deferred behind the exact queue fence.`,
          })
        }
        if (governedQueueIds.size > 0) {
          warnings.push({
            code: 'queue_work_governed_residue_deferred',
            message: `${governedQueueIds.size} policy-classified non-fenced row(s) remain deferred to their authorized lifecycle.`,
          })
        }
      } else if (!options.residuePolicy) {
        errors.push({
          code: 'queue_work_residue_policy_missing',
          message: `Queue-work scheduler activation found ${residues.length} non-fenced non-terminal row(s) for ${allowlist[0]} but no STATE_DAEMON_QUEUE_WORK_RESIDUE_POLICY_FILE was provided: ${
            residues.map((row) => `${row.id}:${row.status}:${row.message_id ?? '(no-message-id)'}`).join(', ')
          }. Provide an exact-row governed residue policy or close/rework under separate authorization before LaunchAgent mutation.`,
        })
      } else {
        const policyReport = classifyQueueWorkResidueRows(
          options.residuePolicy,
          residues as QueueWorkResidueRow[],
        )
        for (const blocker of policyReport.blockers) {
          errors.push({
            code: blocker.code,
            message: `${blocker.message}${blocker.mismatches?.length ? `: ${blocker.mismatches.join('; ')}` : ''}`,
          })
        }
      }
    }
    return { ok: errors.length === 0, errors, warnings, residues }
  } catch (err) {
    errors.push({
      code: 'queue_work_canary_residue_preflight_db_error',
      message: `Queue-work scheduler canary residue preflight failed; refusing LaunchAgent mutation: ${err instanceof Error ? err.message : String(err)}`,
    })
    return { ok: false, errors, warnings, residues: [] }
  }
}

export function protectedPathsFromLaunchAgentPlists(plists: string[]): string[] {
  const protectedPaths = new Set<string>()
  for (const plist of plists) {
    const config = parseStateDaemonLaunchAgentPlist(plist)
    if (config.label !== STATE_DAEMON_LAUNCH_AGENT_LABEL) continue
    const entry = config.programArguments[1]
    if (entry) {
      protectedPaths.add(resolve(entry))
      protectedPaths.add(resolve(dirname(dirname(entry))))
    }
    if (config.workingDirectory) {
      protectedPaths.add(resolve(config.workingDirectory))
    }
  }
  return [...protectedPaths].sort()
}

function pathIntersectsProtected(candidate: string, protectedPath: string): boolean {
  return isPathInside(candidate, protectedPath) || isPathInside(protectedPath, candidate)
}

export function planStateDaemonRestorePrune(input: {
  restoreRoot: string
  checkoutDirs: string[]
  activeLaunchAgentPlists?: string[]
  keep?: number
}): StateDaemonPruneTarget[] {
  const restoreRoot = resolve(input.restoreRoot)
  const keep = Number.isFinite(input.keep) && input.keep !== undefined && input.keep >= 0
    ? Math.floor(input.keep)
    : 3
  const protectedPaths = protectedPathsFromLaunchAgentPlists(input.activeLaunchAgentPlists ?? [])
  const dirs = [...input.checkoutDirs]
    .map((path) => resolve(path))
    .filter((path) => isPathInside(restoreRoot, path) && path !== restoreRoot)

  return dirs.map((path, index) => {
    if (protectedPaths.some((protectedPath) => pathIntersectsProtected(path, protectedPath))) {
      return { path, action: 'protect', reason: 'referenced_by_active_launchagent' }
    }
    if (index >= Math.max(0, dirs.length - keep)) {
      return { path, action: 'keep', reason: `within_keep_last_${keep}` }
    }
    return { path, action: 'delete', reason: 'older_than_keep_window' }
  })
}

export function listStateDaemonRestoreCheckouts(restoreRoot: string): string[] {
  try {
    return readdirSync(restoreRoot)
      .map((name) => join(restoreRoot, name))
      .filter((path) => {
        try { return statSync(path).isDirectory() } catch { return false }
      })
  } catch {
    return []
  }
}
