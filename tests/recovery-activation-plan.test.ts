import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRecoveryActivationPlan,
  formatRecoveryActivationPlanText,
  type RecoveryActivationPhaseCode,
} from '../core/recovery-activation-plan'
import type { RecoveryReadinessReport, RecoveryReadinessScope } from '../core/recovery-readiness'

const REPO = join(import.meta.dir, '..')
const SCOPE_PATH = `/tmp/recovery-activation-scope-${process.pid}-${Date.now()}.json`
const REPORT_PATH = `/tmp/recovery-activation-report-${process.pid}-${Date.now()}.json`

afterEach(() => {
  for (const path of [SCOPE_PATH, REPORT_PATH]) {
    try { if (existsSync(path)) unlinkSync(path) } catch {}
  }
})

function scope(overrides: Partial<RecoveryReadinessScope> = {}): RecoveryReadinessScope {
  return {
    scope_id: 'cp80-602-603',
    agents: ['codex-cto', 'ceo'],
    channels: ['1487368919613444156'],
    state_daemon: {
      expected: true,
      plist_path: '/launch/com.agent-comms.state-daemon.plist',
    },
    projection_checks: [{
      name: 'codex-cto-to-ceo-discord-direct',
      channel_id: '1487368919613444156',
      sender_agent_id: 'codex-cto',
      recipient_agent_ids: ['ceo'],
      expected_consumer_agent_id: 'codex-cto',
      expected_consumer_source: 'sender_token_evidence',
    }],
    ...overrides,
  }
}

function readinessReport(overrides: Partial<RecoveryReadinessReport> = {}): RecoveryReadinessReport {
  return {
    ok: true,
    go_no_go: 'GO',
    generated_at: '2026-06-02T00:00:00.000Z',
    scope: {
      scope_id: 'cp80-602-603',
      agents: ['ceo', 'codex-cto'],
      channels: ['1487368919613444156'],
      state_daemon_expected: true,
      projection_checks: [{
        name: 'codex-cto-to-ceo-discord-direct',
        channel_id: '1487368919613444156',
        sender_agent_id: 'codex-cto',
        recipient_agent_ids: ['ceo'],
      }],
    },
    policy: {
      read_only: true,
      dry_run_default: true,
      no_db_mutation: true,
      no_queue_cleanup_apply: true,
      no_state_daemon_restart: true,
      no_discord_activation: true,
      no_live_codex_or_claude_calls: true,
      no_next_inbox_fifo_drain: true,
      no_prompt_driven_processing: true,
      exact_activation_scope_required: true,
    },
    cp70: {
      reports: [],
      failed_blocker_codes: [],
    },
    launchagent: {
      expected: true,
      require_running: true,
      allow_private_tmp: false,
      runtime: {
        label: 'com.agent-comms.state-daemon',
        status: 'ok',
        checked_at: '2026-06-02T00:00:00.000Z',
        launchd: {
          available: true,
          loaded: true,
          running: true,
          state: 'running',
          pid: 4242,
          last_exit_status: 0,
        },
        process: {
          pid: 4242,
          command: '/usr/local/bin/bun /repo/bin/state-daemon.ts',
          cwd: '/repo',
        },
        paths: {
          program: '/usr/local/bin/bun',
          script: '/repo/bin/state-daemon.ts',
          working_directory: '/repo',
          stdout_path: '/repo/logs/out.log',
          stderr_path: '/repo/logs/err.log',
          plist_path: '/launch/com.agent-comms.state-daemon.plist',
        },
        environment: {
          database_url: 'postgresql:///agent_comms?host=/tmp',
          agent_allowlist: null,
          agent_denylist: null,
        },
        stderr: {
          path: '/repo/logs/err.log',
          exists: true,
          fatal_fingerprint: null,
        },
      },
      plist_path: '/launch/com.agent-comms.state-daemon.plist',
      config: null,
      validation: { ok: true, errors: [], warnings: [] },
      prompt_artifacts: [],
    },
    queue_readiness: {
      scope_agent_ids: ['codex-cto', 'ceo'],
      pending_backlog: {
        total: 0,
        by_agent_status: [],
      },
      stale_active_rows: [],
      duplicate_active_baton_rows: [],
    },
    projection_readiness: [{
      name: 'codex-cto-to-ceo-discord-direct',
      channel_id: '1487368919613444156',
      thread_id: null,
      sender_agent_id: 'codex-cto',
      recipient_agent_ids: ['ceo'],
      expected_consumer_agent_id: 'codex-cto',
      expected_consumer_source: 'sender_token_evidence',
      allow_fallback: false,
      ok: true,
      blocker_codes: [],
      decision: {
        platform: 'discord',
        channelExternalId: '1487368919613444156',
        consumerAgentId: 'codex-cto',
        consumerSource: 'sender_token_evidence',
        consumerEvidence: {
          source_table: 'channel_connector_bindings',
          provider: 'discord',
          channel_id: '1487368919613444156',
          provider_channel_id: '1487368919613444156',
          agent_id: 'codex-cto',
          connector_instance_id: 'connector-codex-cto',
          credential_id: 'credential-codex-cto',
          credential_status: 'registered',
          channel_binding_id: 'binding-codex-cto',
          provider_channel_access_id: null,
        },
        projectionIdentityId: 'codex-cto',
        intendedProjectionIdentityId: 'ceo',
        projectionSource: 'fallback_adapter_owner',
        projectionFallbackReason: 'recipient_projection_human',
        deliveryFallbackReason: 'recipient_direct_unavailable',
        deliveryDiagnostics: [],
      },
    }],
    blockers: [],
    recommended_next_commands: [],
    mutation_performed: false,
    ...overrides,
  }
}

describe('CP-80 activation plan', () => {
  test('missing readiness report is rejected', () => {
    const plan = buildRecoveryActivationPlan(scope(), null, {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(plan.ok).toBe(false)
    expect(plan.go_no_go).toBe('NO_GO')
    expect(plan.blockers.map((b) => b.code)).toContain('READINESS_REPORT_REQUIRED')
    expect(plan.phases).toEqual([])
    expect(plan.mutation_performed).toBe(false)
  })

  test('NO_GO readiness report is rejected', () => {
    const plan = buildRecoveryActivationPlan(scope(), readinessReport({
      ok: false,
      go_no_go: 'NO_GO',
      blockers: [{
        code: 'STATE_DAEMON_UNLOADED',
        component: 'launchagent',
        subject_type: 'launchagent',
        subject_id: 'com.agent-comms.state-daemon',
        queue_ids: [],
        message_ids: [],
        evidence: {},
      }],
    }), {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(plan.ok).toBe(false)
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'READINESS_REPORT_NO_GO',
        evidence: expect.objectContaining({ blocker_codes: ['STATE_DAEMON_UNLOADED'] }),
      }),
    ]))
  })

  test('scope mismatch is rejected', () => {
    const plan = buildRecoveryActivationPlan(scope({ channels: ['different-channel'] }), readinessReport(), {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(plan.ok).toBe(false)
    expect(plan.blockers.map((b) => b.code)).toContain('READINESS_SCOPE_MISMATCH')
  })

  test('implicit default projection is not enough for exact activation scope', () => {
    const plan = buildRecoveryActivationPlan({
      scope_id: 'cp80-602-603',
      agents: ['codex-cto', 'ceo'],
      channels: ['1487368919613444156'],
      state_daemon: { expected: true },
    }, readinessReport(), {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    expect(plan.ok).toBe(false)
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ACTIVATION_SCOPE_REQUIRED',
        evidence: { missing: ['projection_checks'] },
      }),
    ]))
  })

  test('GO readiness report produces ordered canary-first phases and exact evidence requirements', () => {
    const plan = buildRecoveryActivationPlan(scope(), readinessReport(), {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })
    const phaseCodes = plan.phases.map((phase) => phase.code)

    expect(plan.ok).toBe(true)
    expect(plan.go_no_go).toBe('GO')
    expect(phaseCodes).toEqual([
      'cp70_preflight_evidence_check',
      'state_daemon_launchagent_readiness_check',
      'queue_receive_process_canary_plan',
      'completion_outcome_evidence_plan',
      'discord_projection_evidence_plan',
      'audit_evidence_plan',
      'rollback_trigger_list',
    ] satisfies RecoveryActivationPhaseCode[])
    expect(plan.phases.every((phase, index) => phase.order === index + 1 && phase.execution_allowed === false && phase.canary_first_only)).toBe(true)
    expect(plan.required_evidence?.discord_projection[0]).toMatchObject({
      channel_id: '1487368919613444156',
      expected_consumer_agent_id: 'codex-cto',
      expected_consumer_source: 'sender_token_evidence',
      connector_instance_id: 'connector-codex-cto',
      channel_binding_id: 'binding-codex-cto',
      expected_no_aun_router_fallback: true,
    })
    expect(plan.required_evidence?.audit_events).toEqual([
      'recovery.activation.canary_started',
      'state_daemon.canary.queue_received',
      'state_daemon.canary.queue_completed',
      'discord.projection.sent',
      'recovery.activation.canary_completed',
    ])
    expect(plan.rollback_triggers.map((trigger) => trigger.code)).toEqual([
      'FIFO_DRAIN_DETECTED',
      'LOOP_PROMPT_DETECTED',
      'DUPLICATE_ACTIVE_WORK',
      'PROJECTION_FALLBACK_UNEXPECTED',
      'SEND_FAILURE_IS_PROJECTION_FAILURE',
      'STATE_DAEMON_WRONG_PATH_OR_AGENT_ID',
      'DISCORD_CREDENTIAL_OR_WRITE_EVIDENCE_MISSING',
    ])
  })

  test('JSON output is stable enough for audit and text output is readable', () => {
    const plan = buildRecoveryActivationPlan(scope(), readinessReport(), {
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })
    const parsed = JSON.parse(JSON.stringify(plan, null, 2))
    const text = formatRecoveryActivationPlanText(plan)

    expect(parsed).toMatchObject({
      ok: true,
      go_no_go: 'GO',
      scope: {
        scope_id: 'cp80-602-603',
        channels: ['1487368919613444156'],
      },
      mutation_performed: false,
    })
    expect(text).toContain('CP-80 Activation Plan')
    expect(text).toContain('Result: GO')
    expect(text).toContain('rollback_trigger_list')
  })

  test('CLI missing readiness report exits before DB access', () => {
    writeFileSync(SCOPE_PATH, JSON.stringify(scope()), 'utf8')
    const result = spawnSync('bun', ['cli/index.ts', 'recovery', 'activation-plan', '--scope-file', SCOPE_PATH], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage: agent-com recovery activation-plan --scope-file <json> --readiness-report <json>')
  })

  test('CLI activation-plan emits JSON without opening the DB', () => {
    writeFileSync(SCOPE_PATH, JSON.stringify(scope()), 'utf8')
    writeFileSync(REPORT_PATH, JSON.stringify(readinessReport()), 'utf8')
    const result = spawnSync('bun', [
      'cli/index.ts',
      'recovery',
      'activation-plan',
      '--scope-file',
      SCOPE_PATH,
      '--readiness-report',
      REPORT_PATH,
      '--format',
      'json',
    ], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      go_no_go: 'GO',
      mutation_performed: false,
    })
  })

  test('activation-plan executable path has no runtime activation calls', () => {
    const coreSrc = readFileSync(join(REPO, 'core', 'recovery-activation-plan.ts'), 'utf8')
    const cli = readFileSync(join(REPO, 'cli', 'index.ts'), 'utf8')
    const activationBranch = cli.match(/if \(subcommand === 'activation-plan'\)[\s\S]*?return\n  \}/)?.[0] ?? ''

    expect(coreSrc).not.toMatch(/execFileSync|spawnSync|createDbAdapter|getDb|resolveOutboundProjectionDecision/)
    expect(activationBranch).not.toMatch(/getDb\(|nextMessage\(|inbox\(|restartSession|launchctl|bootstrap\(|kickstart|Discord\.Client|\.login\(/)
    expect(activationBranch).toMatch(/buildRecoveryActivationPlan/)
  })
})
