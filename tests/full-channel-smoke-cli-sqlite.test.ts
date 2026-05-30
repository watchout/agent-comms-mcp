import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { migrateSqlite } from '../db/migrate-sqlite'

const REPO_ROOT = join(import.meta.dir, '..')
const CLI = join(REPO_ROOT, 'cli', 'index.ts')

function tableCounts(dbPath: string): Record<string, number> {
  const db = new Database(dbPath)
  try {
    return {
      agent_messages: (db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as any).n,
      message_queue: (db.prepare('SELECT COUNT(*) AS n FROM message_queue').get() as any).n,
      outbound_queue: (db.prepare('SELECT COUNT(*) AS n FROM outbound_queue').get() as any).n,
      audit_log: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as any).n,
    }
  } finally {
    db.close()
  }
}

function runSmokeCli(dbPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bun', [CLI, 'smoke', 'run', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      AGENT_COM_DB: 'sqlite',
      AGENT_COM_SQLITE_PATH: dbPath,
      AGENT_COM_PG_NOTIFY: 'false',
      DATABASE_URL: '',
      AGENT_ID: 'hotel-dev',
    },
  })
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function seedHealthyEvidence(dbPath: string): { inboundId: string; replyId: string } {
  const runtimeId = randomUUID()
  const connectorId = randomUUID()
  const inboundId = randomUUID()
  const replyId = randomUUID()
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.prepare(
      `INSERT INTO agents (agent_id, display_name, agent_type, status, profile_enabled, metadata)
       VALUES ('hotel-dev', 'hotel-dev', 'dev', 'idle', 1, '{}')`,
    ).run()
    db.prepare(`INSERT INTO channels (id, name, members) VALUES ('hotel-kanri', 'hotel-kanri', ?)`).run(
      JSON.stringify(['hotel-dev']),
    )
    db.prepare(
      `INSERT INTO channel_adapters (channel_id, platform, external_id, metadata)
       VALUES ('hotel-kanri', 'discord', 'EID1', '{}')`,
    ).run()
    db.prepare(
      `INSERT INTO channel_routing_policy (channel_id, primary_agent_id, adapter_owner_agent_id, outbound_allowlist)
       VALUES ('hotel-kanri', 'hotel-dev', 'hotel-dev', ?)`,
    ).run(JSON.stringify(['hotel-dev']))
    db.prepare(
      `INSERT INTO agent_runtime_instances (runtime_instance_id, agent_id, runtime_engine, status, last_seen_at, metadata)
       VALUES (?, 'hotel-dev', 'codex', 'active', datetime('now'), '{}')`,
    ).run(runtimeId)
    db.prepare(
      `INSERT INTO agent_endpoints (endpoint_id, agent_id, endpoint_uri, status, metadata)
       VALUES (?, 'hotel-dev', 'local://hotel-dev', 'active', '{}')`,
    ).run(randomUUID())
    db.prepare(
      `INSERT INTO connector_instances (connector_instance_id, agent_id, runtime_instance_id, provider, status, metadata)
       VALUES (?, 'hotel-dev', ?, 'discord', 'active', '{}')`,
    ).run(connectorId, runtimeId)
    db.prepare(
      `INSERT INTO channel_connector_bindings (channel_binding_id, channel_id, provider, connector_instance_id, binding_role, status, metadata)
       VALUES (?, 'hotel-kanri', 'discord', ?, 'outbound', 'active', '{}')`,
    ).run(randomUUID(), connectorId)
    db.prepare(
      `INSERT INTO agent_messages (
         id, channel_id, author_id, content, metadata, discord_message_id, input_mentions,
         source, direction, role, created_at
       ) VALUES (?, 'hotel-kanri', 'ceo-discord', 'please inspect', ?, 'D1', ?, 'discord', 'inbound', 'user', datetime('now'))`,
    ).run(
      inboundId,
      JSON.stringify({ discord_channel_id: 'EID1', discord_message_id: 'D1' }),
      JSON.stringify(['hotel-dev']),
    )
    db.prepare(
      `INSERT INTO agent_messages (id, channel_id, author_id, content, metadata, source, direction, role, created_at)
       VALUES (?, 'hotel-kanri', 'hotel-dev', 'done', '{}', 'agent-comms', 'outbound', 'agent', datetime('now'))`,
    ).run(replyId)
    db.prepare(
      `INSERT INTO message_queue (agent_id, message_id, payload, status, claimed_by, claimed_at, replied_at, replied_with)
       VALUES ('hotel-dev', ?, ?, 'replied', 'hotel-dev', datetime('now'), datetime('now'), ?)`,
    ).run(inboundId, JSON.stringify({ channel_id: 'hotel-kanri', content: 'please inspect' }), replyId)
    db.prepare(
      `INSERT INTO outbound_queue (
         message_id, agent_id, consumer_agent_id, consumer_source,
         projection_source, projection_fallback_reason,
         delivery_fallback_reason, delivery_diagnostics,
         channel_external_id, content, status, sent_at
       )
       VALUES (?, 'hotel-dev', 'hotel-dev', 'recipient_token_evidence',
               'recipient_default_projection', NULL,
               NULL, ?, 'EID1', 'done', 'sent', datetime('now'))`,
    ).run(replyId, JSON.stringify([{ source: 'recipient_token_evidence', agent_id: 'hotel-dev' }]))
    db.prepare(
      `INSERT INTO audit_log (event_type, agent_id, target, detail)
       VALUES ('smoke.fixture_terminal', 'hotel-dev', 'EID1', '{}')`,
    ).run()
    return { inboundId, replyId }
  } finally {
    db.close()
  }
}

describe('NORM-060 full-channel smoke CLI (SQLite)', () => {
  test('smoke run dry-run reports lifecycle evidence without writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comms-full-smoke-cli-'))
    const dbPath = join(dir, 'agent-comms.db')
    try {
      migrateSqlite(dbPath)
      const { inboundId, replyId } = seedHealthyEvidence(dbPath)

      const before = tableCounts(dbPath)
      const result = runSmokeCli(dbPath, ['--format', 'json', '--window-hours', '24'])
      expect(result.status).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.ok).toBe(true)
      expect(report.policy.read_only).toBe(true)
      expect(report.summary).toMatchObject({
        target_channels: 1,
        passed: 1,
        failure_count: 0,
      })
      const target = report.channels[0].targets[0]
      expect(target.lifecycle.inbound_message_id).toBe(inboundId)
      expect(target.lifecycle.reply_message_id).toBe(replyId)
      expect(target.lifecycle.outbound_message_id).toBe(replyId)
      expect(target.lifecycle.outbound_terminal).toBe(true)
      expect(target.lifecycle.audit_event_types).toContain('smoke.fixture_terminal')
      expect(tableCounts(dbPath)).toEqual(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('smoke run execute injects a bounded probe in SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-comms-full-smoke-cli-'))
    const dbPath = join(dir, 'agent-comms.db')
    try {
      migrateSqlite(dbPath)
      seedHealthyEvidence(dbPath)

      const dry = runSmokeCli(dbPath, ['--format', 'json', '--window-hours', '24'])
      expect(dry.status).toBe(0)
      const planHash = JSON.parse(dry.stdout).plan_hash

      const executed = runSmokeCli(dbPath, [
        '--format', 'json',
        '--window-hours', '24',
        '--execute',
        '--confirm', planHash,
        '--timeout-ms', '1',
      ])
      expect(executed.status).toBe(2)
      const report = JSON.parse(executed.stdout)
      expect(report.execute.injected_targets).toHaveLength(1)
      expect(report.execute.timed_out_targets).toHaveLength(1)
      expect(report.summary.failures_by_class.timeout).toBe(1)

      const db = new Database(dbPath)
      try {
        const probe = db.prepare(
          `SELECT id, role, content, input_mentions, metadata
             FROM agent_messages
            WHERE json_extract(metadata, '$.smoke_run_id') = ?`,
        ).get(report.run_id) as any
        expect(probe.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(probe.role).toBe('user')
        expect(probe.content).toContain('no reply is required')
        expect(probe.content).toContain('processing tool')
        expect(probe.content).toContain('done tool')
        expect(probe.content).toContain('Do not send a reply')
        expect(JSON.parse(probe.input_mentions)).toEqual(['hotel-dev'])
        expect(JSON.parse(probe.metadata)).toMatchObject({
          synthetic: true,
          no_reply_required: true,
          expected_terminal_state: 'done',
        })
        const queue = db.prepare(
          `SELECT payload FROM message_queue WHERE message_id = ?`,
        ).get(probe.id) as any
        const queuePayload = JSON.parse(queue.payload)
        expect(queuePayload).toMatchObject({
          author_id: 'codex-aun',
          no_reply_required: true,
          expected_terminal_state: 'done',
        })
        expect(queuePayload.content).toBe(probe.content)
        const audit = db.prepare(
          `SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'smoke.full_channel_execute' AND target = 'hotel-kanri'`,
        ).get() as any
        expect(audit.n).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
