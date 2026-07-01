import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION,
  buildAunConnectorChannelAccessDiscovery,
  type AunConnectorChannelAccessDiscovery,
} from '../core/aun-connector-channel-access-discovery'
import type { DbAdapter } from '../core/db'

const NOW = new Date('2026-06-30T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeChannelAccessDb implements DbAdapter {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly agents: any[] = [],
    private readonly connectors: any[] = [],
    private readonly credentials: any[] = [],
    private readonly identities: any[] = [],
    private readonly bindings: any[] = [],
    private readonly accessRows: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(sql)) {
      throw new Error(`mutation SQL is forbidden in channel access discovery test: ${sql}`)
    }
    const agentId = params?.[0]
    const matchesAgent = (row: any) => row.agent_id === agentId
    if (sql.includes('FROM agents')) return this.agents.filter(matchesAgent) as T[]
    if (sql.includes('FROM connector_instances') && !sql.includes('channel_connector_bindings') && !sql.includes('provider_channel_access')) {
      return this.connectors.filter(matchesAgent) as T[]
    }
    if (sql.includes('FROM connector_credentials')) return this.credentials.filter(matchesAgent) as T[]
    if (sql.includes('FROM agent_provider_identities')) return this.identities.filter(matchesAgent) as T[]
    if (sql.includes('FROM channel_connector_bindings')) {
      const connectorIds = new Set(this.connectors.filter(matchesAgent).map((row) => row.connector_instance_id))
      return this.bindings
        .filter((row) => connectorIds.has(row.connector_instance_id))
        .map((row) => ({ ...row, provider_channel_id: row.provider_channel_id ?? row.channel_id })) as T[]
    }
    if (sql.includes('FROM provider_channel_access')) {
      const connectorIds = new Set(this.connectors.filter(matchesAgent).map((row) => row.connector_instance_id))
      return this.accessRows.filter((row) => connectorIds.has(row.connector_instance_id)) as T[]
    }
    throw new Error(`unexpected SQL in channel access discovery fake: ${sql}`)
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(): Promise<{ rowCount: number }> {
    throw new Error('unexpected execute in channel access discovery fake')
  }

  async transaction<T>(): Promise<T> {
    throw new Error('unexpected transaction in channel access discovery fake')
  }

  async close(): Promise<void> {}
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: 'kodama',
    provider_token_source_ref: 'env:KODAMA_DISCORD_TOKEN',
    expected_provider_identity: JSON.stringify({
      provider: 'discord',
      subject_id: '123456789012345678',
    }),
    profile_enabled: true,
    disabled_at: null,
    ...overrides,
  }
}

function connector(overrides: Record<string, unknown> = {}) {
  return {
    connector_instance_id: 'connector-kodama',
    agent_id: 'kodama',
    provider: 'discord',
    connector_uri: 'discord://agents/kodama',
    status: 'active',
    trust_status: 'local',
    runtime_instance_id: 'runtime-kodama',
    disabled_at: null,
    ...overrides,
  }
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'credential-kodama',
    agent_id: 'kodama',
    provider: 'discord',
    connector_instance_id: 'connector-kodama',
    secret_ref: 'env:KODAMA_DISCORD_TOKEN',
    token_fingerprint: 'fp-kodama',
    status: 'active',
    trust_status: 'local',
    last_verified_at: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    provider_identity_id: 'identity-kodama',
    agent_id: 'kodama',
    provider_subject_id: '123456789012345678',
    provider_handle: 'kodama-bot',
    status: 'verified',
    trust_status: 'local',
    source: 'operator',
    last_verified_at: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
    channel_binding_id: 'binding-kodama',
    channel_id: 'hotel-kanri',
    channel_name: 'hotel-kanri',
    provider_channel_id: '1487368919613444156',
    connector_instance_id: 'connector-kodama',
    binding_role: 'outbound',
    priority: 10,
    ordering_scope: 'thread',
    status: 'active',
    policy_source: 'db',
    ...overrides,
  }
}

function access(overrides: Record<string, unknown> = {}) {
  return {
    provider_channel_access_id: 'access-kodama',
    provider: 'discord',
    provider_channel_id: '1487368919613444156',
    connector_instance_id: 'connector-kodama',
    agent_id: 'kodama',
    capabilities: { message_create: true, view_channel: true },
    status: 'active',
    trust_status: 'local',
    source: 'provider_discovery',
    discovered_at: '2026-06-30T00:00:00.000Z',
    expires_at: null,
    ...overrides,
  }
}

async function discover(db: FakeChannelAccessDb): Promise<AunConnectorChannelAccessDiscovery> {
  return buildAunConnectorChannelAccessDiscovery(db, {
    agentId: 'kodama',
    provider: 'discord',
    dryRun: true,
    now: () => NOW,
  })
}

describe('AUN connector channel access discovery', () => {
  test('builds a Discord channel access dry-run plan without mutation or live provider calls', async () => {
    const db = new FakeChannelAccessDb([agent()], [connector()], [credential()], [identity()], [binding()], [access()])
    const result = await discover(db)

    expect(result).toMatchObject({
      schema_version: AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION,
      generated_at: '2026-06-30T00:00:00.000Z',
      dry_run: true,
      provider: 'discord',
      agent_id: 'kodama',
      discovery_plan: {
        live_provider_call: false,
        expected_provider_subject_id: '123456789012345678',
      },
      summary: {
        blockers: 0,
        live_provider_calls: 0,
        channel_bindings_scanned: 1,
        provider_channel_access_scanned: 1,
      },
      applied_mutations: [],
    })
    expect(result.channel_access_plan[0]).toMatchObject({
      channel_id: 'hotel-kanri',
      provider_channel_id: '1487368919613444156',
      connector_instance_id: 'connector-kodama',
      provider_channel_access_id: 'access-kodama',
      message_create_capability: true,
      live_provider_call: false,
    })
    expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(call.sql))).toBe(true)
  })

  test('redacts raw-secret-like token refs in discovery output', async () => {
    const raw = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const db = new FakeChannelAccessDb(
      [agent({ provider_token_source_ref: raw })],
      [connector()],
      [credential({ secret_ref: raw })],
      [identity()],
      [binding()],
      [access()],
    )

    const result = await discover(db)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(raw)
    expect(result.agent_profile?.token_source_ref).toMatchObject({
      display: '[redacted:raw-secret-like]',
      raw_secret_like: true,
    })
    expect(result.credential_evidence[0].secret_ref).toMatchObject({
      display: '[redacted:raw-secret-like]',
      raw_secret_like: true,
    })
  })

  test('reports missing provider channel access evidence without performing live provider calls', async () => {
    const db = new FakeChannelAccessDb([agent()], [connector()], [credential()], [identity()], [binding()], [])
    const result = await discover(db)

    expect(result.summary.live_provider_calls).toBe(0)
    expect(result.applied_mutations).toEqual([])
    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'provider_channel_access_evidence_missing',
      channel_id: 'hotel-kanri',
      connector_instance_id: 'connector-kodama',
    }))
    expect(result.channel_access_plan[0]).toMatchObject({
      provider_channel_access_id: null,
      message_create_capability: false,
      live_provider_call: false,
    })
  })

  test('CLI emits JSON from an existing sqlite DB in read-only dry-run mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-channel-access-'))
    const dbPath = join(dir, 'agent-com.db')
    try {
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          agent_type TEXT,
          provider_token_source_ref TEXT,
          expected_provider_identity TEXT,
          profile_enabled INTEGER,
          disabled_at TEXT
        );
        CREATE TABLE connector_instances (
          connector_instance_id TEXT PRIMARY KEY,
          agent_id TEXT,
          provider TEXT,
          connector_uri TEXT,
          status TEXT,
          trust_status TEXT,
          runtime_instance_id TEXT,
          disabled_at TEXT
        );
        CREATE TABLE connector_credentials (
          credential_id TEXT PRIMARY KEY,
          agent_id TEXT,
          provider TEXT,
          connector_instance_id TEXT,
          credential_kind TEXT,
          secret_ref TEXT,
          token_fingerprint TEXT,
          status TEXT,
          trust_status TEXT,
          last_verified_at TEXT
        );
        CREATE TABLE agent_provider_identities (
          provider_identity_id TEXT PRIMARY KEY,
          agent_id TEXT,
          provider TEXT,
          provider_subject_id TEXT,
          provider_handle TEXT,
          status TEXT,
          trust_status TEXT,
          source TEXT,
          last_verified_at TEXT
        );
        CREATE TABLE channels (
          id TEXT PRIMARY KEY,
          name TEXT
        );
        CREATE TABLE channel_adapters (
          channel_id TEXT,
          platform TEXT,
          external_id TEXT
        );
        CREATE TABLE channel_connector_bindings (
          channel_binding_id TEXT PRIMARY KEY,
          channel_id TEXT,
          provider TEXT,
          connector_instance_id TEXT,
          binding_role TEXT,
          priority INTEGER,
          ordering_scope TEXT,
          status TEXT,
          policy_source TEXT
        );
        CREATE TABLE provider_channel_access (
          provider_channel_access_id TEXT PRIMARY KEY,
          provider TEXT,
          provider_channel_id TEXT,
          connector_instance_id TEXT,
          agent_id TEXT,
          capabilities TEXT,
          status TEXT,
          trust_status TEXT,
          source TEXT,
          discovered_at TEXT,
          expires_at TEXT
        );
        INSERT INTO agents VALUES (
          'kodama',
          'dev',
          'env:KODAMA_DISCORD_TOKEN',
          '{"provider":"discord","subject_id":"123456789012345678"}',
          1,
          NULL
        );
        INSERT INTO connector_instances VALUES (
          'connector-kodama',
          'kodama',
          'discord',
          'discord://agents/kodama',
          'active',
          'local',
          'runtime-kodama',
          NULL
        );
        INSERT INTO connector_credentials VALUES (
          'credential-kodama',
          'kodama',
          'discord',
          'connector-kodama',
          'bot_token',
          'env:KODAMA_DISCORD_TOKEN',
          'fp-kodama',
          'active',
          'local',
          '2026-06-30T00:00:00.000Z'
        );
        INSERT INTO agent_provider_identities VALUES (
          'identity-kodama',
          'kodama',
          'discord',
          '123456789012345678',
          'kodama-bot',
          'verified',
          'local',
          'operator',
          '2026-06-30T00:00:00.000Z'
        );
        INSERT INTO channels VALUES ('hotel-kanri', 'hotel-kanri');
        INSERT INTO channel_adapters VALUES ('hotel-kanri', 'discord', '1487368919613444156');
        INSERT INTO channel_connector_bindings VALUES (
          'binding-kodama',
          'hotel-kanri',
          'discord',
          'connector-kodama',
          'outbound',
          10,
          'thread',
          'active',
          'db'
        );
        INSERT INTO provider_channel_access VALUES (
          'access-kodama',
          'discord',
          '1487368919613444156',
          'connector-kodama',
          'kodama',
          '{"message_create":true,"view_channel":true}',
          'active',
          'local',
          'provider_discovery',
          '2026-06-30T00:00:00.000Z',
          NULL
        );
      `)
      db.close()

      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'discover-channel-access',
        '--agent-id',
        'kodama',
        '--dry-run',
        '--json',
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload).toMatchObject({
        schema_version: AUN_CONNECTOR_CHANNEL_ACCESS_DISCOVERY_VERSION,
        dry_run: true,
        summary: {
          blockers: 0,
          live_provider_calls: 0,
        },
        channel_access_plan: [
          {
            channel_id: 'hotel-kanri',
            provider_channel_id: '1487368919613444156',
            message_create_capability: true,
            live_provider_call: false,
          },
        ],
        applied_mutations: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI requires --dry-run before opening or creating sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-channel-access-no-dry-run-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'discover-channel-access',
        '--agent-id',
        'kodama',
        '--json',
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(2)
      expect(existsSync(dbPath)).toBe(false)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'invalid_arguments',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI requires --json before opening or creating sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-channel-access-no-json-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'discover-channel-access',
        '--agent-id',
        'kodama',
        '--dry-run',
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(2)
      expect(existsSync(dbPath)).toBe(false)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'invalid_arguments',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI rejects unsupported provider channel access targets before opening sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-channel-access-provider-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'discover-channel-access',
        '--agent-id',
        'kodama',
        '--provider',
        'slack',
        '--dry-run',
        '--json',
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(2)
      expect(existsSync(dbPath)).toBe(false)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'invalid_arguments',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI rejects unsupported channel access subcommands before opening sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-channel-access-unsupported-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'discover-slack-channel-access',
        '--agent-id',
        'kodama',
        '--dry-run',
        '--json',
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(2)
      expect(existsSync(dbPath)).toBe(false)
      expect(result.stderr).toContain('AUN_CONNECTOR_INVALID')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
