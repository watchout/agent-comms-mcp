import { describe, expect, test } from 'bun:test'
import {
  buildCp70DoctorReport,
  buildCp70Preflight,
  formatCp70DoctorText,
  type Cp70Finding,
} from '../core/cp70-doctor'
import type { StateDaemonRuntimeReadiness } from '../core/state-daemon-readiness'

function queueRow(overrides: Record<string, unknown>) {
  return {
    record_id: 1,
    queue_id: 1,
    agent_id: 'codex-aun',
    status: 'pending',
    created_at: new Date('2026-06-01T00:00:00Z'),
    evidence: 'sample',
    total_count: 1,
    ...overrides,
  }
}

function emptyRuntime(overrides: Partial<StateDaemonRuntimeReadiness>): StateDaemonRuntimeReadiness {
  return {
    label: 'com.agent-comms.state-daemon',
    status: 'ok',
    checked_at: '2026-06-01T00:00:00.000Z',
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
      command: 'bun bin/state-daemon.ts',
      cwd: '/Users/yuji/Developer/agent-comms-mcp',
    },
    paths: {
      program: '/opt/homebrew/bin/bun',
      script: '/Users/yuji/Developer/agent-comms-mcp/bin/state-daemon.ts',
      working_directory: '/Users/yuji/Developer/agent-comms-mcp',
      stdout_path: '/tmp/state-daemon.out.log',
      stderr_path: '/tmp/state-daemon.err.log',
      plist_path: '/Users/yuji/Library/LaunchAgents/com.agent-comms.state-daemon.plist',
    },
    environment: {
      database_url: 'postgresql://localhost/agent_comms',
      agent_allowlist: null,
      agent_denylist: null,
    },
    stderr: {
      path: '/tmp/state-daemon.err.log',
      exists: true,
      fatal_fingerprint: null,
    },
    ...overrides,
  }
}

function byCode(findings: Cp70Finding[]): Record<string, Cp70Finding> {
  return Object.fromEntries(findings.map((finding) => [finding.code, finding]))
}

function allByCode(findings: Cp70Finding[], code: string): Cp70Finding[] {
  return findings.filter((finding) => finding.code === code)
}

describe('CP-70 control-plane doctor', () => {
  test('scans only active message_queue payload for legacy TUI wake prompt backlog', async () => {
    const seenSql: string[] = []
    const db = {
      async query(sql: string) {
        seenSql.push(sql)
        if (sql.includes('GROUP BY mq.status') && !sql.includes('mq.agent_id')) {
          return { rows: [{ status: 'pending', count: 2 }, { status: 'received', count: 1 }] }
        }
        if (sql.includes('GROUP BY mq.agent_id, mq.status')) {
          return { rows: [{ agent_id: 'codex-aun', status: 'pending', count: 2 }] }
        }
        if (sql.includes("'message_queue.payload'")) {
          return {
            rows: [
              queueRow({
                source_table: 'message_queue.payload',
                record_id: 101,
                queue_id: 101,
                evidence: 'Call the agent-comms next tool now. Do not call inbox.',
              }),
            ],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildCp70DoctorReport(db, {
      inspectLaunchAgent: false,
      now: () => new Date('2026-06-01T00:00:00.000Z'),
    })
    const prompts = allByCode(report.findings, 'LOOP_PROMPT_BACKLOG')

    expect(prompts.every((finding) => finding.severity === 'blocker')).toBe(true)
    expect(prompts.map((finding) => finding.samples[0]?.source)).toEqual(['message_queue.payload'])
    expect(prompts[0]).toMatchObject({
      code: 'LOOP_PROMPT_BACKLOG',
      gate: 'runtime',
      subject_type: 'queue',
      subject_id: '101',
      queue_id: '101',
      evidence: {
        source: 'message_queue.payload',
      },
      recommended_repair: {
        requires_exact_subject: true,
        requires_execute_flag: true,
      },
    })
    expect(prompts.find((finding) => finding.subject_type === 'message')).toBeUndefined()
    expect(report.queue_backlog.status_counts).toEqual({ pending: 2, received: 1 })
    expect(report.policy.no_fifo_drain).toBe(true)
    expect(report.policy.no_prompt_driven_processing).toBe(true)
    expect(report.non_goals).toContain('codex_session_transcript_scan')

    const payloadScan = seenSql.find((sql) => sql.includes("'message_queue.payload'")) ?? ''
    expect(payloadScan).toContain('mq.payload')
    expect(payloadScan).toContain("mq.status IN ('pending', 'received', 'in_progress')")
    expect(payloadScan).not.toContain("payload->>'content'")
    expect(seenSql.some((sql) => sql.includes('agent_messages'))).toBe(false)
  })

  test('reports LaunchAgent prompt, installed/running mismatch, and tmp checkout path evidence', async () => {
    const db = { async query() { return { rows: [] } } }
    const runtime = emptyRuntime({
      status: 'not_running',
      launchd: {
        available: true,
        loaded: true,
        running: false,
        state: 'waiting',
        pid: null,
        last_exit_status: 1,
      },
      process: {
        pid: null,
        command: null,
        cwd: null,
      },
      paths: {
        program: '/opt/homebrew/bin/bun',
        script: '/private/tmp/agent-comms-disable-tui-wake/bin/state-daemon.ts',
        working_directory: '/private/tmp/agent-comms-disable-tui-wake',
        stdout_path: '/tmp/state-daemon-build-disable-tui-wake/out.log',
        stderr_path: '/tmp/state-daemon-build-disable-tui-wake/err.log',
        plist_path: '/Users/yuji/Library/LaunchAgents/com.agent-comms.state-daemon.plist',
      },
    })

    const report = await buildCp70DoctorReport(db, {
      launchAgent: runtime,
      launchAgentPlistText: 'Start processing the agent-comms message you just received. Call the agent-comms processing tool for its queue_id.',
    })
    const findings = byCode(report.findings)
    const loopPrompts = allByCode(report.findings, 'LOOP_PROMPT_BACKLOG')
    const launchMismatch = allByCode(report.findings, 'CP70_LAUNCHAGENT_MISMATCH')
    const checkoutPath = allByCode(report.findings, 'CP70_CHECKOUT_PATH_SUSPECT')
    const preflight = buildCp70Preflight(report)

    expect(loopPrompts.some((finding) => finding.samples[0]?.source === 'launchagent.plist')).toBe(true)
    expect(launchMismatch).toHaveLength(1)
    expect(launchMismatch[0]).toMatchObject({ severity: 'info', code: 'CP70_LAUNCHAGENT_MISMATCH' })
    expect(checkoutPath.length).toBeGreaterThanOrEqual(2)
    expect(checkoutPath.every((finding) => finding.severity === 'info')).toBe(true)
    expect(preflight.ok).toBe(false)
    expect(preflight.failed_blocker_codes).toEqual(['LOOP_PROMPT_BACKLOG'])
    expect(findings.CP70_LAUNCHAGENT_MISMATCH.severity).toBe('info')
  })

  test('repair plan is dry-run only and exact-id scoped for prompt and stale active rows', async () => {
    const db = {
      async query(sql: string) {
        if (sql.includes("'message_queue.payload'")) {
          return {
            rows: [
              queueRow({
                source_table: 'message_queue.payload',
                record_id: 201,
                queue_id: 201,
                agent_id: 'codex-aun',
                status: 'pending',
                evidence: 'Call the agent-comms next tool now. Do not call inbox.',
              }),
            ],
          }
        }
        if (sql.includes("'message_queue.active'")) {
          return {
            rows: [
              queueRow({
                source_table: 'message_queue.active',
                record_id: 301,
                queue_id: 301,
                agent_id: 'devauditor',
                status: 'received',
                evidence: 'claim_expires_at=2026-05-31T23:00:00.000Z',
              }),
            ],
          }
        }
        if (sql.includes("'message_queue.baton'")) {
          return {
            rows: [
              queueRow({
                source_table: 'message_queue.baton',
                record_id: 'baton-1',
                baton_key: 'baton-1',
                queue_id: 401,
                agent_id: 'devauditor',
                status: 'received',
                evidence: 'baton-1',
              }),
              queueRow({
                source_table: 'message_queue.baton',
                record_id: 'baton-1',
                baton_key: 'baton-1',
                queue_id: 402,
                agent_id: 'devauditor',
                status: 'in_progress',
                evidence: 'baton-1',
              }),
            ],
          }
        }
        return { rows: [] }
      },
    }

    const report = await buildCp70DoctorReport(db, { inspectLaunchAgent: false })

    expect(report.repair_plan.length).toBe(3)
    for (const item of report.repair_plan) {
      expect(item.dry_run_only).toBe(true)
      expect(item.mutation_allowed).toBe(false)
      expect(item.exact_ids.length).toBeGreaterThan(0)
      expect(item.commands.every((command) => command.includes('--dry-run') || command.includes('diagnose-delivery'))).toBe(true)
      expect(item.commands.every((command) => !command.includes('--execute'))).toBe(true)
    }
    expect(report.repair_plan.find((item) => item.finding_code === 'LOOP_PROMPT_BACKLOG')?.exact_ids).toEqual([201])
    expect(report.repair_plan.find((item) => item.finding_code === 'STUCK_ACTIVE_QUEUE_ROW')?.exact_ids).toEqual([301])
    expect(report.repair_plan.find((item) => item.finding_code === 'DUPLICATE_ACTIVE_BATON')?.exact_ids).toEqual(['401', '402'])
    expect(byCode(report.findings).STUCK_ACTIVE_QUEUE_ROW).toMatchObject({
      gate: 'runtime',
      subject_type: 'queue',
      subject_id: '301',
      queue_id: '301',
      recommended_repair: {
        command: "agent-com diagnose-delivery --queue-id '301'",
        requires_exact_subject: true,
        requires_active_override: true,
      },
    })
  })

  test('formats CP-70 text with preflight result and transcript scan non-goal', async () => {
    const db = { async query() { return { rows: [] } } }
    const report = await buildCp70DoctorReport(db, { inspectLaunchAgent: false })
    const text = formatCp70DoctorText(report, buildCp70Preflight(report))

    expect(text).toContain('CP-70 Control-Plane Doctor')
    expect(text).toContain('Policy: read-only, no FIFO drain')
    expect(text).toContain('Repair plan:')
    expect(text).toContain('Non-goals: codex_session_transcript_scan')
    expect(text).toContain('Preflight(control-plane): ok')
  })
})
