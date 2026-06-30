import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION,
  buildAunConnectorCredentialDiagnostic,
  type AunConnectorCredentialDiagnostic,
} from '../core/aun-connector-credential-diagnostic'
import type { DbAdapter } from '../core/db'

const NOW = new Date('2026-06-30T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeCredentialDb implements DbAdapter {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly agents: any[] = [],
    private readonly connectors: any[] = [],
    private readonly credentials: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(sql)) {
      throw new Error(`mutation SQL is forbidden in credential diagnostic test: ${sql}`)
    }
    const agentFilter = params?.[0]
    const providerFilter = params?.[params.length - 1]
    const hasProviderFilter = sql.includes('.provider =')
    const matchesAgent = (row: any) => agentFilter === undefined || row.agent_id === agentFilter
    const matchesProvider = (row: any) => !hasProviderFilter || row.provider === providerFilter
    if (sql.includes('FROM agents')) {
      return this.agents.filter(matchesAgent) as T[]
    }
    if (sql.includes('FROM connector_instances ci') && !sql.includes('connector_credentials')) {
      return this.connectors.filter(matchesAgent).filter(matchesProvider) as T[]
    }
    if (sql.includes('FROM connector_credentials cc')) {
      return this.credentials
        .filter(matchesAgent)
        .filter(matchesProvider)
        .map((credential) => {
          const connector = this.connectors.find((item) => item.connector_instance_id === credential.connector_instance_id)
          return {
            ...credential,
            connector_agent_id: connector?.agent_id ?? null,
            connector_status: connector?.status ?? null,
          }
        }) as T[]
    }
    throw new Error(`unexpected SQL in credential diagnostic fake: ${sql}`)
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(): Promise<{ rowCount: number }> {
    throw new Error('unexpected execute in credential diagnostic fake')
  }

  async transaction<T>(): Promise<T> {
    throw new Error('unexpected transaction in credential diagnostic fake')
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
    ...overrides,
  }
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    credential_id: 'credential-kodama',
    agent_id: 'kodama',
    provider: 'discord',
    connector_instance_id: 'connector-kodama',
    credential_kind: 'bot_token',
    secret_ref: 'env:KODAMA_DISCORD_TOKEN',
    token_fingerprint: 'fp-kodama',
    status: 'active',
    trust_status: 'local',
    last_verified_at: '2026-06-30T00:00:00.000Z',
    ...overrides,
  }
}

async function diagnostic(db: FakeCredentialDb): Promise<AunConnectorCredentialDiagnostic> {
  return buildAunConnectorCredentialDiagnostic(db, { now: () => NOW })
}

describe('AUN connector credential diagnostic', () => {
  test('reports healthy connector credential evidence without mutation', async () => {
    const db = new FakeCredentialDb([agent()], [connector()], [credential()])
    const result = await diagnostic(db)

    expect(result).toMatchObject({
      schema_version: AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION,
      generated_at: '2026-06-30T00:00:00.000Z',
      summary: {
        agents_scanned: 1,
        connectors_scanned: 1,
        credentials_scanned: 1,
        active_credentials: 1,
        blockers: 0,
      },
      applied_mutations: [],
    })
    expect(result.credentials[0]).toMatchObject({
      credential_id: 'credential-kodama',
      token_fingerprint_present: true,
      owner_matches_connector: true,
    })
    expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(call.sql))).toBe(true)
  })

  test('redacts raw-secret-like token material and reports blockers', async () => {
    const raw = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const db = new FakeCredentialDb(
      [agent({ provider_token_source_ref: raw })],
      [connector()],
      [credential({ secret_ref: raw })],
    )

    const result = await diagnostic(db)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(raw)
    expect(result.summary.blockers).toBeGreaterThanOrEqual(2)
    expect(result.findings.map((item) => item.code)).toContain('raw_secret_like_agent_token_source_ref')
    expect(result.findings.map((item) => item.code)).toContain('raw_secret_like_credential_secret_ref')
    expect(result.agents[0].token_source_ref).toMatchObject({
      display: '[redacted:raw-secret-like]',
      redacted: true,
      raw_secret_like: true,
    })
  })

  test('detects duplicate active secret refs across agents without printing raw token values', async () => {
    const db = new FakeCredentialDb(
      [
        agent({ agent_id: 'kodama', provider_token_source_ref: 'env:SHARED_TOKEN' }),
        agent({ agent_id: 'aun', provider_token_source_ref: 'env:SHARED_TOKEN' }),
      ],
      [
        connector({ connector_instance_id: 'connector-kodama', agent_id: 'kodama' }),
        connector({ connector_instance_id: 'connector-aun', agent_id: 'aun', connector_uri: 'discord://agents/aun' }),
      ],
      [
        credential({ credential_id: 'credential-kodama', agent_id: 'kodama', connector_instance_id: 'connector-kodama', secret_ref: 'env:SHARED_TOKEN' }),
        credential({ credential_id: 'credential-aun', agent_id: 'aun', connector_instance_id: 'connector-aun', secret_ref: 'env:SHARED_TOKEN' }),
      ],
    )

    const result = await diagnostic(db)

    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: 'blocker',
      code: 'duplicate_active_secret_ref',
      provider: 'discord',
    }))
    expect(JSON.stringify(result)).toContain('env:SHARED_TOKEN')
  })

  test('CLI emits JSON from an existing sqlite DB in read-only mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-connector-diagnostic-'))
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
          runtime_instance_id TEXT
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
          'runtime-kodama'
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
      `)
      db.close()

      const result = spawnSync('bun', [AUN_CLI, 'connector', 'credential-diagnostic', '--json'], {
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
        schema_version: AUN_CONNECTOR_CREDENTIAL_DIAGNOSTIC_VERSION,
        summary: {
          blockers: 0,
          credentials_scanned: 1,
        },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI requires --json before opening or creating sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-connector-diagnostic-no-json-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [AUN_CLI, 'connector', 'credential-diagnostic'], {
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

  test('CLI rejects unsupported providers before opening sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-connector-diagnostic-provider-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [AUN_CLI, 'connector', 'credential-diagnostic', '--provider', 'slack', '--json'], {
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

  test('CLI fails closed when sqlite DB is missing with --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-connector-diagnostic-missing-db-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [AUN_CLI, 'connector', 'credential-diagnostic', '--json'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          AGENT_COM_DB: 'sqlite',
          AGENT_COM_SQLITE_PATH: dbPath,
        },
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(existsSync(dbPath)).toBe(false)
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: 'db_unreachable',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
