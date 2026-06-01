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

describe('CP-70 control-plane doctor', () => {
  test('scans message_queue payload and agent_messages content/metadata for legacy TUI wake prompts', async () => {
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
        if (sql.includes("'agent_messages.content'")) {
          return {
            rows: [
              queueRow({
                source_table: 'agent_messages.content',
                record_id: 'msg-content',
                queue_id: null,
                evidence: 'Start processing the agent-comms message you just received...',
              }),
            ],
          }
        }
        if (sql.includes("'agent_messages.metadata'")) {
          return {
            rows: [
              queueRow({
                source_table: 'agent_messages.metadata',
                record_id: 'msg-meta',
                queue_id: null,
                evidence: '{"wake":"processing tool for its queue_id"}',
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
    const prompt = byCode(report.findings).TUI_WAKE_PROMPT_PRESENT

    expect(prompt.severity).toBe('blocker')
    expect(prompt.count).toBe(3)
    expect(prompt.samples.map((sample) => sample.source).sort()).toEqual([
      'agent_messages.content',
      'agent_messages.metadata',
      'message_queue.payload',
    ])
    expect(report.queue_backlog.status_counts).toEqual({ pending: 2, received: 1 })
    expect(report.policy.no_fifo_drain).toBe(true)
    expect(report.policy.no_prompt_driven_processing).toBe(true)
    expect(report.non_goals).toContain('codex_session_transcript_scan')

    const payloadScan = seenSql.find((sql) => sql.includes("'message_queue.payload'")) ?? ''
    const metadataScan = seenSql.find((sql) => sql.includes("'agent_messages.metadata'")) ?? ''
    expect(payloadScan).toContain('mq.payload')
    expect(payloadScan).not.toContain("payload->>'content'")
    expect(metadataScan).toContain("coalesce(am.metadata::text, '')")
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
    const preflight = buildCp70Preflight(report)

    expect(findings.TUI_WAKE_PROMPT_PRESENT.samples.some((sample) => sample.source === 'launchagent.plist')).toBe(true)
    expect(findings.STATE_DAEMON_LAUNCHAGENT_MISMATCH.count).toBe(1)
    expect(findings.STATE_DAEMON_CHECKOUT_PATH_SUSPECT.count).toBeGreaterThanOrEqual(2)
    expect(preflight.ok).toBe(false)
    expect(preflight.failed_blocker_codes).toContain('TUI_WAKE_PROMPT_PRESENT')
    expect(preflight.failed_blocker_codes).toContain('STATE_DAEMON_LAUNCHAGENT_MISMATCH')
    expect(preflight.failed_blocker_codes).toContain('STATE_DAEMON_CHECKOUT_PATH_SUSPECT')
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
    expect(report.repair_plan.find((item) => item.finding_code === 'TUI_WAKE_PROMPT_PRESENT')?.exact_ids).toEqual([201])
    expect(report.repair_plan.find((item) => item.finding_code === 'STALE_ACTIVE_QUEUE_ROWS')?.exact_ids).toEqual([301])
    expect(report.repair_plan.find((item) => item.finding_code === 'DUPLICATE_ACTIVE_BATON')?.exact_ids).toEqual(['401', '402'])
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
