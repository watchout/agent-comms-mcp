import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildStateDaemonLaunchAgentReadinessReport,
  formatStateDaemonLaunchAgentReadinessText,
} from '../core/state-daemon-launchagent-readiness'
import type { StateDaemonRuntimeReadiness } from '../core/state-daemon-readiness'
import type { PathProbe } from '../core/state-daemon/launchagent'

const REPO = join(import.meta.dir, '..')
const APPROVED_COMMIT = '540764dbc78bcd1bd9e12b11915f9b63d08de23b'
const OTHER_COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function plist(options: {
  program?: string
  entry?: string
  workingDirectory?: string
  label?: string
	  agentId?: string | null
	  stderrPath?: string
	  restoreCommit?: string | null
	} = {}): string {
  const program = options.program ?? '/opt/homebrew/bin/bun'
  const entry = options.entry ?? '/opt/agent-comms/bin/state-daemon.ts'
  const cwd = options.workingDirectory ?? '/opt/agent-comms'
  const label = options.label ?? 'com.agent-comms.state-daemon'
	  const agentId = options.agentId === undefined ? null : options.agentId
	  const agentEnv = agentId ? `<key>AGENT_ID</key><string>${agentId}</string>` : ''
	  const restoreEnv = options.restoreCommit === undefined
	    ? ''
	    : options.restoreCommit === null
	      ? ''
	      : `<key>STATE_DAEMON_RESTORE_COMMIT</key><string>${options.restoreCommit}</string>`
	  const stderrPath = options.stderrPath ?? `${cwd}/logs/state-daemon.err.log`
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>StandardErrorPath</key>
  <string>${stderrPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
	    <key>DATABASE_URL</key><string>postgresql:///agent_comms?host=/tmp</string>
	    <key>STATE_DAEMON_AGENT_DENYLIST</key><string>ceo,test</string>
	    ${agentEnv}
	    ${restoreEnv}
	  </dict>
</dict>
</plist>`
}

function runtime(overrides: Partial<StateDaemonRuntimeReadiness> = {}): StateDaemonRuntimeReadiness {
  const base: StateDaemonRuntimeReadiness = {
    label: 'com.agent-comms.state-daemon',
    status: 'ok',
    checked_at: '2026-06-02T00:00:00.000Z',
    launchd: {
      available: true,
      loaded: true,
      running: true,
      state: 'running',
      pid: 123,
      last_exit_status: 0,
    },
    process: {
      pid: 123,
      command: '/opt/homebrew/bin/bun /opt/agent-comms/bin/state-daemon.ts',
      cwd: '/opt/agent-comms',
    },
    paths: {
      program: '/opt/homebrew/bin/bun',
      script: '/opt/agent-comms/bin/state-daemon.ts',
      working_directory: '/opt/agent-comms',
      stdout_path: '/opt/agent-comms/logs/state-daemon.out.log',
      stderr_path: '/opt/agent-comms/logs/state-daemon.err.log',
      plist_path: '/launch/com.agent-comms.state-daemon.plist',
    },
    environment: {
      database_url: 'postgresql:///agent_comms?host=/tmp',
      agent_allowlist: null,
      agent_denylist: 'ceo,test',
    },
    stderr: {
      path: '/opt/agent-comms/logs/state-daemon.err.log',
      exists: true,
      fatal_fingerprint: null,
    },
  }
  return {
    ...base,
    ...overrides,
    launchd: { ...base.launchd, ...(overrides.launchd ?? {}) },
    process: { ...base.process, ...(overrides.process ?? {}) },
    paths: { ...base.paths, ...(overrides.paths ?? {}) },
    environment: { ...base.environment, ...(overrides.environment ?? {}) },
    stderr: { ...base.stderr, ...(overrides.stderr ?? {}) },
  }
}

function probe(options: {
  missing?: string[]
  executable?: string[]
  directories?: string[]
} = {}): PathProbe {
  const missing = new Set(options.missing ?? [])
  const executable = new Set(options.executable ?? ['/opt/homebrew/bin/bun'])
  const directories = new Set(options.directories ?? ['/opt/agent-comms'])
  return {
    exists: (path) => !missing.has(path),
    isDirectory: (path) => directories.has(path) && !missing.has(path),
    isFile: (path) => !directories.has(path) && !missing.has(path),
    isExecutable: (path) => executable.has(path) && !missing.has(path),
  }
}

function build(options: {
  plistText?: string
  runtime?: StateDaemonRuntimeReadiness
  pathProbe?: PathProbe
  plistExists?: boolean
  requireRunning?: boolean
	  expectedAgentId?: string | null
	  expectedWorkingDirectory?: string | null
	  expectedCheckoutRoot?: string | null
	  expectedCommit?: string | null
	} = {}) {
  const plistPath = '/launch/com.agent-comms.state-daemon.plist'
  const text = options.plistText ?? plist()
  return buildStateDaemonLaunchAgentReadinessReport({
    plistPath,
    now: () => new Date('2026-06-02T00:00:00.000Z'),
    requireRunning: options.requireRunning,
	    expectedAgentId: options.expectedAgentId,
	    expectedWorkingDirectory: options.expectedWorkingDirectory,
	    expectedCheckoutRoot: options.expectedCheckoutRoot,
	    expectedCommit: options.expectedCommit,
    inspectRuntime: () => options.runtime ?? runtime(),
    pathProbe: options.pathProbe ?? probe(),
    existsSync: ((path: string) => {
      if (path === plistPath) return options.plistExists !== false
      return path === '/opt/agent-comms/logs/state-daemon.err.log'
    }) as any,
    readFileSync: ((path: string) => {
      if (path === plistPath) return text
      return ''
    }) as any,
  })
}

describe('#603 state-daemon LaunchAgent readiness diagnostic', () => {
  test('valid persistent path produces GO without mutation or restart', () => {
    const report = build()

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.issue_ref).toBe('#603')
    expect(report.mutation_performed).toBe(false)
    expect(report.restart_performed).toBe(false)
    expect(report.paths.program).toMatchObject({
      path: '/opt/homebrew/bin/bun',
      exists: true,
      is_executable: true,
      volatile_tmp: false,
    })
    expect(report.paths.program_arguments_entry).toMatchObject({
      path: '/opt/agent-comms/bin/state-daemon.ts',
      exists: true,
      volatile_tmp: false,
    })
    expect(report.identity).toMatchObject({
      runtime_kind: 'state_daemon',
      agent_id: null,
      database_url_present: true,
    })
    expect(formatStateDaemonLaunchAgentReadinessText(report)).toContain('Result: GO')
  })

  test('private tmp ProgramArguments or WorkingDirectory is a blocker', () => {
    const text = plist({
      entry: '/private/tmp/agent-comms-state-daemon/bin/state-daemon.ts',
      workingDirectory: '/private/tmp/agent-comms-state-daemon',
      stderrPath: '/private/tmp/agent-comms-state-daemon/logs/state-daemon.err.log',
    })
    const report = build({
      plistText: text,
      runtime: runtime({
        process: {
          pid: 123,
          command: '/opt/homebrew/bin/bun /private/tmp/agent-comms-state-daemon/bin/state-daemon.ts',
          cwd: '/private/tmp/agent-comms-state-daemon',
        },
        paths: {
          program: '/opt/homebrew/bin/bun',
          script: '/private/tmp/agent-comms-state-daemon/bin/state-daemon.ts',
          working_directory: '/private/tmp/agent-comms-state-daemon',
          stdout_path: '/private/tmp/agent-comms-state-daemon/logs/state-daemon.out.log',
          stderr_path: '/private/tmp/agent-comms-state-daemon/logs/state-daemon.err.log',
          plist_path: '/launch/com.agent-comms.state-daemon.plist',
        },
      }),
      pathProbe: probe({
        directories: ['/private/tmp/agent-comms-state-daemon'],
      }),
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((item) => item.code)).toContain('EPHEMERAL_LAUNCHAGENT_PATH')
    expect(report.paths.working_directory.volatile_tmp).toBe(true)
  })

  test('missing ProgramArguments target is a blocker', () => {
    const report = build({
      pathProbe: probe({ missing: ['/opt/agent-comms/bin/state-daemon.ts'] }),
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((item) => item.code)).toContain('STATE_DAEMON_ENTRY_MISSING')
  })

  test('missing WorkingDirectory is a blocker', () => {
    const report = build({
      pathProbe: probe({ missing: ['/opt/agent-comms'] }),
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((item) => item.code)).toContain('WORKING_DIRECTORY_MISSING')
  })

  test('wrong AGENT_ID/listener identity is a blocker', () => {
    const report = build({
      plistText: plist({ agentId: 'codex-cto' }),
      expectedAgentId: 'state-daemon',
    })

    expect(report.ok).toBe(false)
    expect(report.blockers.map((item) => item.code)).toContain('AGENT_ID_MISMATCH')
    expect(report.identity.agent_id).toBe('codex-cto')
	  expect(report.identity.expected_agent_id).toBe('state-daemon')
	})

  test('expected commit drift is a blocker without changing LaunchAgent state', () => {
    const driftPath = `/Users/yuji/.agent-comms/state-daemon/checkouts/${OTHER_COMMIT}`
    const report = build({
      plistText: plist({
        workingDirectory: driftPath,
        restoreCommit: OTHER_COMMIT,
      }),
      runtime: runtime({
        process: {
          pid: 123,
          command: `/opt/homebrew/bin/bun ${driftPath}/bin/state-daemon.ts`,
          cwd: driftPath,
        },
        paths: {
          program: '/opt/homebrew/bin/bun',
          script: `${driftPath}/bin/state-daemon.ts`,
          working_directory: driftPath,
          stdout_path: `${driftPath}/logs/state-daemon.out.log`,
          stderr_path: `${driftPath}/logs/state-daemon.err.log`,
          plist_path: '/launch/com.agent-comms.state-daemon.plist',
        },
      }),
      pathProbe: probe({
        directories: [driftPath],
      }),
      expectedCheckoutRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      expectedCommit: APPROVED_COMMIT,
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.scope.expected_commit).toBe(APPROVED_COMMIT)
    expect(report.blockers.map((item) => item.code)).toContain('RESTORE_COMMIT_MISMATCH')
    expect(report.blockers.map((item) => item.code)).toContain('WORKING_DIRECTORY_COMMIT_MISMATCH')
    expect(report.restart_performed).toBe(false)
  })

  test('expected commit does not accept a short restore commit prefix', () => {
    const shortCommit = APPROVED_COMMIT.slice(0, 3)
    const shortPath = `/Users/yuji/.agent-comms/state-daemon/checkouts/${shortCommit}`
    const report = build({
      plistText: plist({
        workingDirectory: shortPath,
        restoreCommit: shortCommit,
      }),
      runtime: runtime({
        process: {
          pid: 123,
          command: `/opt/homebrew/bin/bun ${shortPath}/bin/state-daemon.ts`,
          cwd: shortPath,
        },
        paths: {
          program: '/opt/homebrew/bin/bun',
          script: `${shortPath}/bin/state-daemon.ts`,
          working_directory: shortPath,
          stdout_path: `${shortPath}/logs/state-daemon.out.log`,
          stderr_path: `${shortPath}/logs/state-daemon.err.log`,
          plist_path: '/launch/com.agent-comms.state-daemon.plist',
        },
      }),
      pathProbe: probe({
        directories: [shortPath],
      }),
      expectedCheckoutRoot: '/Users/yuji/.agent-comms/state-daemon/checkouts',
      expectedCommit: APPROVED_COMMIT,
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((item) => item.code)).toContain('RESTORE_COMMIT_MISMATCH')
    expect(report.blockers.map((item) => item.code)).toContain('WORKING_DIRECTORY_COMMIT_MISMATCH')
  })

  test('unloaded or not running is report-only by default', () => {
    const report = build({
      runtime: runtime({
        status: 'unloaded',
        launchd: {
          available: true,
          loaded: false,
          running: false,
          state: null,
          pid: null,
          last_exit_status: 1,
        },
        process: { pid: null, command: null, cwd: null },
      }),
    })

    expect(report.ok).toBe(true)
    expect(report.go_no_go).toBe('GO')
    expect(report.launchd.loaded).toBe(false)
    expect(report.restart_performed).toBe(false)
  })

  test('require-running turns unloaded evidence into NO_GO without restart', () => {
    const report = build({
      requireRunning: true,
      runtime: runtime({
        status: 'unloaded',
        launchd: {
          available: true,
          loaded: false,
          running: false,
          state: null,
          pid: null,
          last_exit_status: 1,
        },
        process: { pid: null, command: null, cwd: null },
      }),
    })

    expect(report.ok).toBe(false)
    expect(report.go_no_go).toBe('NO_GO')
    expect(report.blockers.map((item) => item.code)).toContain('STATE_DAEMON_UNLOADED')
    expect(report.restart_performed).toBe(false)
  })

  test('diagnostic path has no restart, bootstrap, Discord, or queue-drain calls', () => {
    const coreSrc = readFileSync(join(REPO, 'core/state-daemon-launchagent-readiness.ts'), 'utf8')
    const cliSrc = readFileSync(join(REPO, 'cli/index.ts'), 'utf8')
    const start = cliSrc.indexOf('async function stateDaemonCommand')
    const end = cliSrc.indexOf('async function repairQueue')
    const executablePath = `${coreSrc}\n${cliSrc.slice(start, end)}`

    expect(executablePath).not.toMatch(/launchctl['"`\],\s*\[[\s\S]*?['"`](?:bootstrap|kickstart)['"`]/)
    for (const forbidden of [
      'restartSession',
      'sendProjectedDiscordMessage',
      'createDiscordClient',
      'Discord.Client',
      '.login(',
      'nextMessage',
      'inbox(',
      'agent-com next',
      'agent-com inbox',
      'send-keys',
    ]) {
      expect(executablePath).not.toContain(forbidden)
    }
    expect(executablePath).toContain('mutation_performed: false')
    expect(executablePath).toContain('restart_performed: false')
  })
})
