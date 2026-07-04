import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReadOnlyGateCommands,
  buildSummary,
  defaultScope,
  runReport,
  type GatePackOptions,
  type GateReportName,
} from '../scripts/recovery-readonly-gate-pack'

const REPORTS: GateReportName[] = [
  'cp70-preflight',
  'recovery-readiness',
  'activation-plan',
  'discord-projection',
  'state-daemon-readiness',
  'runtime-inventory',
  'fleet-readiness',
  'queue-processing-readiness',
  'install-plan',
]

function options(overrides: Partial<GatePackOptions> = {}): GatePackOptions {
  return {
    outputDir: '/tmp/aun-readonly-gate-evidence',
    databaseUrl: 'postgresql:///agent_comms?host=/tmp',
    agentId: 'codex-cto',
    recipientAgentId: 'ceo',
    channelId: '1487368919613444156',
    scopeId: 'cp80-recovery-canary-602',
    installPlanCommit: '34f035bb84b569135f54ead2635009b118a5e39f',
    includeInstallPlan: true,
    repoRoot: '/repo',
    approvedCommit: null,
    approvedCheckoutRoots: [],
    driftExclusionFile: null,
    ...overrides,
  }
}

function goReports(overrides: Partial<Record<GateReportName, unknown>> = {}): Record<GateReportName, unknown> {
  const base = Object.fromEntries(REPORTS.map((name) => [name, {
    ok: true,
    go_no_go: 'GO',
    mutation_performed: false,
    restart_performed: false,
  }])) as Record<GateReportName, unknown>
  base['cp70-preflight'] = {
    ok: true,
    go_no_go: 'GO',
    mutation_performed: false,
    restart_performed: false,
    preflight: {
      ok: true,
      failed_blocker_count: 0,
      failed_blocker_codes: [],
    },
  }
  return { ...base, ...overrides }
}

function summary(overrides: Partial<Record<GateReportName, unknown>> = {}) {
  return buildSummary({
    evidenceDir: '/tmp/aun-readonly-gate-evidence',
    scopeFile: '/tmp/aun-readonly-gate-evidence/recovery-scope.json',
    currentMainSha: '34f035bb84b569135f54ead2635009b118a5e39f',
    repoHeadSha: '34f035bb84b569135f54ead2635009b118a5e39f',
    prDependencies: {
      pr_671_local_supervisor_adapter: { available: true, state: 'OPEN' },
      pr_672_install_plan: { available: true, state: 'OPEN' },
    },
    reports: goReports(overrides),
    now: new Date('2026-06-02T00:00:00.000Z'),
  })
}

describe('#602 recovery read-only gate pack', () => {
  test('default scope is exact canary-first recovery scope', () => {
    const scope = defaultScope({
      scopeId: 'cp80-recovery-canary-602',
      agentId: 'codex-cto',
      recipientAgentId: 'ceo',
      channelId: '1487368919613444156',
    })

    expect(scope).toMatchObject({
      scope_id: 'cp80-recovery-canary-602',
      issue: '#602',
      max_canary_count: 1,
      agents: ['codex-cto'],
      channels: ['1487368919613444156'],
      fallback_allowed: false,
    })
    expect(scope.projection_checks).toEqual([{
      name: 'codex-cto-to-ceo-direct',
      channel_id: '1487368919613444156',
      sender_agent_id: 'codex-cto',
      recipient_agent_ids: ['ceo'],
      expected_consumer_agent_id: 'codex-cto',
      expected_consumer_source: 'sender_token_evidence',
      allow_fallback: false,
    }])
    expect(scope.prohibited).toEqual(expect.arrayContaining([
      'fifo_drain',
      'prompt_driven_next',
      'prompt_driven_inbox',
      'tui_prompt_injection',
      'automatic_retry_loop',
    ]))
  })

  test('runner commands are read-only report collection commands', () => {
    const commands = buildReadOnlyGateCommands(options())
    expect(commands.map((c) => c.report)).toEqual([
      'cp70-preflight',
      'discord-projection',
      'state-daemon-readiness',
      'runtime-inventory',
      'fleet-readiness',
      'queue-processing-readiness',
      'recovery-readiness',
      'activation-plan',
    ])

    expect(commands.map((c) => [c.command, ...c.args])).toEqual([
      ['bun', 'cli/index.ts', 'queue', 'cp70-preflight', '--agent-id', 'codex-cto', '--format', 'json'],
      ['bun', 'cli/index.ts', 'diagnose-projection', '--channel-id', '1487368919613444156', '--from-agent', 'codex-cto', '--to', 'ceo', '--format', 'json'],
      ['bun', 'cli/index.ts', 'state-daemon', 'readiness', '--format', 'json'],
      ['bun', 'cli/index.ts', 'runtime', 'inventory', '--format', 'json'],
      ['bun', 'cli/index.ts', 'fleet', 'readiness', '--format', 'json', '--operator-agent-id', 'codex-cto'],
      ['bun', 'cli/index.ts', 'state-daemon', 'queue-readiness', '--agent-id', 'codex-cto', '--format', 'json'],
      ['bun', 'cli/index.ts', 'recovery', 'readiness', '--scope-file', '/tmp/aun-readonly-gate-evidence/recovery-scope.json', '--format', 'json'],
      ['bun', 'cli/index.ts', 'recovery', 'activation-plan', '--scope-file', '/tmp/aun-readonly-gate-evidence/recovery-scope.json', '--readiness-report', '/tmp/aun-readonly-gate-evidence/recovery-readiness.json', '--format', 'json'],
    ])

    const executableTokens = commands.flatMap((c) => [c.command, ...c.args])
    expect(executableTokens).not.toContain('next')
    expect(executableTokens).not.toContain('inbox')
    expect(executableTokens).not.toContain('launchctl')
    expect(executableTokens).not.toContain('bootstrap')
    expect(executableTokens).not.toContain('kickstart')
  })

  test('runner commands pass approved fleet checkout policy without mutation', () => {
    const commands = buildReadOnlyGateCommands(options({
      approvedCommit: '51d0524853e7c47ba374d42bb07b3bab8af9ad82',
      approvedCheckoutRoots: ['/Users/yuji/.agent-comms/state-daemon/checkouts'],
      driftExclusionFile: '/tmp/fleet-drift-exclusions.json',
    }))

    expect(commands.find((c) => c.report === 'state-daemon-readiness')?.args).toEqual([
      'cli/index.ts',
      'state-daemon',
      'readiness',
      '--format',
      'json',
      '--expected-commit',
      '51d0524853e7c47ba374d42bb07b3bab8af9ad82',
      '--expected-checkout-root',
      '/Users/yuji/.agent-comms/state-daemon/checkouts',
    ])
    expect(commands.find((c) => c.report === 'runtime-inventory')?.args).toEqual([
      'cli/index.ts',
      'runtime',
      'inventory',
      '--format',
      'json',
      '--expected-commit',
      '51d0524853e7c47ba374d42bb07b3bab8af9ad82',
      '--approved-checkout-root',
      '/Users/yuji/.agent-comms/state-daemon/checkouts',
    ])
    expect(commands.find((c) => c.report === 'fleet-readiness')?.args).toEqual([
      'cli/index.ts',
      'fleet',
      'readiness',
      '--format',
      'json',
      '--operator-agent-id',
      'codex-cto',
      '--approved-commit',
      '51d0524853e7c47ba374d42bb07b3bab8af9ad82',
      '--approved-checkout-root',
      '/Users/yuji/.agent-comms/state-daemon/checkouts',
      '--drift-exclusion-file',
      '/tmp/fleet-drift-exclusions.json',
    ])
  })

  test('summary is GO only when every report is GO and non-mutating', () => {
    const result = summary()
    expect(result.ok).toBe(true)
    expect(result.go_no_go).toBe('GO')
    expect(result.blockers).toEqual([])
    expect(result.mutation_performed).toBe(false)
    expect(result.restart_performed).toBe(false)
    for (const name of REPORTS) {
      expect(result.reports[name]).toMatchObject({
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: false,
      })
    }
  })

  test('summary fails closed when a report lacks positive GO evidence', () => {
    const result = summary({
      'activation-plan': {},
    })

    expect(result.ok).toBe(false)
    expect(result.go_no_go).toBe('NO_GO')
    expect(result.blockers).toContainEqual({
      source_report: 'activation-plan',
      code: 'REPORT_NOT_GO',
    })
  })

  test('summary fails closed when a required report is missing', () => {
    const reports = goReports()
    delete (reports as Partial<Record<GateReportName, unknown>>)['install-plan']
    const result = buildSummary({
      evidenceDir: '/tmp/aun-readonly-gate-evidence',
      scopeFile: '/tmp/aun-readonly-gate-evidence/recovery-scope.json',
      currentMainSha: '34f035bb84b569135f54ead2635009b118a5e39f',
      repoHeadSha: '34f035bb84b569135f54ead2635009b118a5e39f',
      prDependencies: {
        pr_671_local_supervisor_adapter: { available: true, state: 'OPEN' },
        pr_672_install_plan: { available: true, state: 'OPEN' },
      },
      reports,
      now: new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(result.ok).toBe(false)
    expect(result.blockers).toContainEqual({
      source_report: 'install-plan',
      code: 'REPORT_NOT_GO',
    })
  })

  test('child command failure is NO_GO even when stdout is parseable GO JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aun-readonly-gate-pack-'))
    try {
      const outputFile = join(tmp, 'cp70-preflight.json')
      const report = runReport({
        report: 'cp70-preflight',
        outputFile,
        command: 'bun',
        args: [
          '-e',
          'console.log(JSON.stringify({ ok: true, go_no_go: "GO", mutation_performed: false, restart_performed: false })); process.exit(7)',
        ],
      }, process.cwd()) as Record<string, unknown>
      const stored = JSON.parse(readFileSync(outputFile, 'utf8'))

      expect(report).toMatchObject({
        ok: false,
        go_no_go: 'NO_GO',
        report: 'cp70-preflight',
        command_error: true,
        exit_code: 7,
        mutation_performed: false,
        restart_performed: false,
        blockers: [{ code: 'REPORT_COMMAND_FAILED' }],
        parsed_stdout: {
          ok: true,
          go_no_go: 'GO',
        },
      })
      expect(stored).toMatchObject(report)

      const result = buildSummary({
        evidenceDir: tmp,
        scopeFile: join(tmp, 'recovery-scope.json'),
        currentMainSha: 'a57d3c5d237ded23dc5e2d84bbe3bd5a7740e6fb',
        repoHeadSha: 'a57d3c5d237ded23dc5e2d84bbe3bd5a7740e6fb',
        prDependencies: {
          pr_671_local_supervisor_adapter: { available: true, state: 'MERGED' },
          pr_672_install_plan: { available: true, state: 'MERGED' },
        },
        reports: goReports({ 'cp70-preflight': report }),
        now: new Date('2026-06-02T00:00:00.000Z'),
      })

      expect(result.ok).toBe(false)
      expect(result.go_no_go).toBe('NO_GO')
      expect(result.reports['cp70-preflight']).toMatchObject({
        ok: false,
        go_no_go: 'NO_GO',
        blocker_codes: ['REPORT_COMMAND_FAILED'],
      })
      expect(result.blockers).toContainEqual({
        source_report: 'cp70-preflight',
        code: 'REPORT_COMMAND_FAILED',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('diagnostic NO-GO JSON with exit 1 is preserved as report evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aun-readonly-gate-pack-'))
    try {
      const outputFile = join(tmp, 'state-daemon-readiness.json')
      const report = runReport({
        report: 'state-daemon-readiness',
        outputFile,
        command: 'bun',
        args: [
          '-e',
          'console.log(JSON.stringify({ ok: false, go_no_go: "NO_GO", mutation_performed: false, restart_performed: false, blockers: [{ code: "STATE_DAEMON_UNLOADED" }] })); process.exit(1)',
        ],
      }, process.cwd()) as Record<string, unknown>
      const stored = JSON.parse(readFileSync(outputFile, 'utf8'))

      expect(report).toMatchObject({
        ok: false,
        go_no_go: 'NO_GO',
        mutation_performed: false,
        restart_performed: false,
        blockers: [{ code: 'STATE_DAEMON_UNLOADED' }],
      })
      expect(report.command_error).toBeUndefined()
      expect(stored).toMatchObject(report)

      const result = buildSummary({
        evidenceDir: tmp,
        scopeFile: join(tmp, 'recovery-scope.json'),
        currentMainSha: '86c06cde8c4dae59276e47255bf28f377e8552b4',
        repoHeadSha: '86c06cde8c4dae59276e47255bf28f377e8552b4',
        prDependencies: {
          pr_671_local_supervisor_adapter: { available: true, state: 'MERGED' },
          pr_672_install_plan: { available: true, state: 'MERGED' },
        },
        reports: goReports({ 'state-daemon-readiness': report }),
        now: new Date('2026-06-02T00:00:00.000Z'),
      })

      expect(result.ok).toBe(false)
      expect(result.go_no_go).toBe('NO_GO')
      expect(result.blockers).toContainEqual({
        source_report: 'state-daemon-readiness',
        code: 'STATE_DAEMON_UNLOADED',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('summary preserves exact blocker codes and source reports', () => {
    const result = summary({
      'cp70-preflight': {
        ok: false,
        go_no_go: 'NO_GO',
        mutation_performed: false,
        restart_performed: false,
        preflight: {
          ok: false,
          failed_blocker_count: 1,
          failed_blocker_codes: ['LOOP_PROMPT_BACKLOG'],
        },
      },
      'state-daemon-readiness': {
        ok: false,
        go_no_go: 'NO_GO',
        mutation_performed: false,
        restart_performed: false,
        launchagent: {
          validation: {
            errors: [{ code: 'STATE_DAEMON_VOLATILE_PATH' }],
          },
        },
      },
      'install-plan': {
        ok: false,
        go_no_go: 'NO_GO',
        dependency_unavailable: true,
        mutation_performed: false,
        restart_performed: false,
        preflight: {
          ok: false,
          errors: [{ code: 'state_daemon_entry_missing' }],
        },
        blockers: [{ code: 'INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING' }],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.go_no_go).toBe('NO_GO')
    expect(result.blockers).toEqual(expect.arrayContaining([
      { source_report: 'cp70-preflight', code: 'LOOP_PROMPT_BACKLOG' },
      { source_report: 'state-daemon-readiness', code: 'STATE_DAEMON_VOLATILE_PATH' },
      { source_report: 'install-plan', code: 'INSTALL_PLAN_UNAVAILABLE_PR_672_PENDING' },
      { source_report: 'install-plan', code: 'state_daemon_entry_missing' },
    ]))
  })

  test('credential status contract drift forces NO_GO even when projection report is otherwise GO', () => {
    const result = summary({
      'discord-projection': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: false,
        contract: {
          runtime_delivery_status_contract: 'drift',
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.go_no_go).toBe('NO_GO')
    expect(result.blockers).toContainEqual({
      source_report: 'discord-projection',
      code: 'CREDENTIAL_STATUS_CONTRACT_DRIFT',
    })
  })

  test('separate runtime login and active delivery contracts do not force projection NO_GO', () => {
    const result = summary({
      'discord-projection': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: false,
        contract: {
          runtime_login_credential_statuses: ['active', 'registered'],
          delivery_credential_statuses: ['active'],
          runtime_login_delivery_status_policy: 'separate',
          runtime_delivery_status_contract: 'aligned',
          selected_delivery_credential_status: 'active',
          selected_delivery_status_contract: 'satisfied',
          selected_delivery_evidence_complete: true,
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(result.go_no_go).toBe('GO')
    expect(result.blockers).not.toContainEqual({
      source_report: 'discord-projection',
      code: 'CREDENTIAL_STATUS_CONTRACT_DRIFT',
    })
  })

  test('runtime and fleet string blockers force NO_GO with source reports', () => {
    const result = summary({
      'runtime-inventory': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: false,
        blockers: ['agent-com-dev:runtime_checkout_path_unapproved'],
      },
      'fleet-readiness': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: false,
        blockers: ['agent-com-dev:runtime_commit_mismatch'],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.go_no_go).toBe('NO_GO')
    expect(result.blockers).toEqual(expect.arrayContaining([
      { source_report: 'runtime-inventory', code: 'agent-com-dev:runtime_checkout_path_unapproved' },
      { source_report: 'fleet-readiness', code: 'agent-com-dev:runtime_commit_mismatch' },
    ]))
  })

  test('mutation or restart evidence forces NO_GO', () => {
    const result = summary({
      'recovery-readiness': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: true,
        restart_performed: false,
      },
      'state-daemon-readiness': {
        ok: true,
        go_no_go: 'GO',
        mutation_performed: false,
        restart_performed: true,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.blockers).toEqual(expect.arrayContaining([
      { source_report: 'recovery-readiness', code: 'MUTATION_PERFORMED' },
      { source_report: 'state-daemon-readiness', code: 'RESTART_PERFORMED' },
    ]))
  })
})
