import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION,
  buildAunConnectorUiBindingsMaterializer,
  type AunConnectorUiBindingsMaterializer,
} from '../core/aun-connector-ui-bindings-materializer'
import type { DbAdapter } from '../core/db'

const NOW = new Date('2026-07-01T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeUiBindingsDb implements DbAdapter {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly agents: any[] = [],
    private readonly connectors: any[] = [],
    private readonly credentials: any[] = [],
    private readonly identities: any[] = [],
    private readonly bindings: any[] = [],
    private readonly accessRows: any[] = [],
    private readonly uiBindings: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(sql)) {
      throw new Error(`mutation SQL is forbidden in UI bindings materializer test: ${sql}`)
    }
    const agentId = params?.[0]
    const matchesAgent = (row: any) => row.agent_id === agentId
    if (sql.includes('FROM agents')) return this.agents.filter(matchesAgent) as T[]
    if (sql.includes('FROM agent_ui_bindings')) return this.uiBindings.filter(matchesAgent) as T[]
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
    throw new Error(`unexpected SQL in UI bindings materializer fake: ${sql}`)
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(): Promise<{ rowCount: number }> {
    throw new Error('unexpected execute in UI bindings materializer fake')
  }

  async transaction<T>(): Promise<T> {
    throw new Error('unexpected transaction in UI bindings materializer fake')
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
    last_verified_at: '2026-07-01T00:00:00.000Z',
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
    last_verified_at: '2026-07-01T00:00:00.000Z',
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
    discovered_at: '2026-07-01T00:00:00.000Z',
    expires_at: null,
    ...overrides,
  }
}

function uiBinding(overrides: Record<string, unknown> = {}) {
  return {
    agent_ui_binding_id: 'ui-binding-kodama',
    agent_id: 'kodama',
    ui_type: 'discord',
    ui_id: '123456789012345678',
    ui_handle: 'kodama-bot',
    ui_token_ref: 'env:KODAMA_DISCORD_TOKEN',
    connector_instance_id: 'connector-kodama',
    credential_id: 'credential-kodama',
    provider_identity_id: 'identity-kodama',
    surface_role: 'primary',
    status: 'registered',
    trust_status: 'local',
    metadata: '{"source":"fixture"}',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

async function materialize(db: FakeUiBindingsDb): Promise<AunConnectorUiBindingsMaterializer> {
  return buildAunConnectorUiBindingsMaterializer(db, {
    agentId: 'kodama',
    provider: 'discord',
    dryRun: true,
    now: () => NOW,
  })
}

function createSqliteFixture(dbPath: string): void {
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
    CREATE TABLE agent_ui_bindings (
      agent_ui_binding_id TEXT PRIMARY KEY,
      agent_id TEXT,
      ui_type TEXT,
      ui_id TEXT,
      ui_handle TEXT,
      ui_token_ref TEXT,
      connector_instance_id TEXT,
      credential_id TEXT,
      provider_identity_id TEXT,
      surface_role TEXT,
      status TEXT,
      trust_status TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
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
      '2026-07-01T00:00:00.000Z'
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
      '2026-07-01T00:00:00.000Z'
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
      '2026-07-01T00:00:00.000Z',
      NULL
    );
  `)
  db.close()
}

describe('AUN connector UI bindings materializer', () => {
  test('builds a dry-run UI binding materialization plan without mutation or live provider calls', async () => {
    const db = new FakeUiBindingsDb([agent()], [connector()], [credential()], [identity()], [binding()], [access()])
    const result = await materialize(db)

    expect(result).toMatchObject({
      schema_version: AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION,
      generated_at: '2026-07-01T00:00:00.000Z',
      dry_run: true,
      provider: 'discord',
      agent_id: 'kodama',
      materialization_plan: {
        live_provider_call: false,
        target_table: 'agent_ui_bindings',
        target_table_available: true,
      },
      summary: {
        blockers: 0,
        planned_ui_bindings: 1,
        live_provider_calls: 0,
      },
      applied_mutations: [],
    })
    expect(result.ui_bindings[0]).toMatchObject({
      operation: 'upsert_agent_ui_binding',
      target_table: 'agent_ui_bindings',
      would_mutate: false,
      mutation_authorized: false,
      ui_type: 'discord',
      ui_id: '123456789012345678',
      connector_instance_id: 'connector-kodama',
      credential_id: 'credential-kodama',
      provider_identity_id: 'identity-kodama',
      source_evidence: {
        write_capable_channel_count: 1,
      },
    })
    expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(call.sql))).toBe(true)
  })

  test('keeps existing matching UI binding as a noop dry-run plan', async () => {
    const db = new FakeUiBindingsDb(
      [agent()],
      [connector()],
      [credential()],
      [identity()],
      [binding()],
      [access()],
      [uiBinding()],
    )
    const result = await materialize(db)

    expect(result.summary.blockers).toBe(0)
    expect(result.summary.existing_ui_bindings_scanned).toBe(1)
    expect(result.existing_ui_bindings[0]).toMatchObject({
      agent_ui_binding_id: 'ui-binding-kodama',
      metadata_keys: ['source'],
    })
    expect(result.ui_bindings[0]).toMatchObject({
      operation: 'noop_existing_binding_matches',
      would_mutate: false,
      mutation_authorized: false,
    })
    expect(result.applied_mutations).toEqual([])
  })

  test('redacts raw-secret-like token refs in materialization output', async () => {
    const raw = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const db = new FakeUiBindingsDb(
      [agent({ provider_token_source_ref: raw })],
      [connector()],
      [credential({ secret_ref: raw })],
      [identity()],
      [binding()],
      [access()],
      [uiBinding({ ui_token_ref: raw })],
    )

    const result = await materialize(db)
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
    expect(result.existing_ui_bindings[0].ui_token_ref).toMatchObject({
      display: '[redacted:raw-secret-like]',
      raw_secret_like: true,
    })
  })

  test('blocks materialization plan when write-capable channel access evidence is missing', async () => {
    const db = new FakeUiBindingsDb([agent()], [connector()], [credential()], [identity()], [binding()], [])
    const result = await materialize(db)

    expect(result.summary.live_provider_calls).toBe(0)
    expect(result.applied_mutations).toEqual([])
    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: 'blocker',
      code: 'write_capable_channel_access_evidence_missing',
    }))
  })

  test('CLI emits JSON from an existing sqlite DB in read-only dry-run mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-ui-bindings-'))
    const dbPath = join(dir, 'agent-com.db')
    try {
      createSqliteFixture(dbPath)

      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'materialize-ui-bindings',
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
        schema_version: AUN_CONNECTOR_UI_BINDINGS_MATERIALIZER_VERSION,
        dry_run: true,
        summary: {
          blockers: 0,
          live_provider_calls: 0,
          planned_ui_bindings: 1,
        },
        ui_bindings: [
          {
            ui_id: '123456789012345678',
            would_mutate: false,
            mutation_authorized: false,
          },
        ],
        applied_mutations: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI requires --dry-run before opening or creating sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-ui-bindings-no-dry-run-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'materialize-ui-bindings',
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
    const dir = mkdtempSync(join(tmpdir(), 'aun-ui-bindings-no-json-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'materialize-ui-bindings',
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

  test('CLI rejects unsupported provider before opening sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-ui-bindings-provider-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'materialize-ui-bindings',
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
})
