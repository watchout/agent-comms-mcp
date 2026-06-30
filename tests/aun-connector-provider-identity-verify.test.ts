import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION,
  buildAunConnectorProviderIdentityVerify,
  type AunConnectorProviderIdentityVerify,
} from '../core/aun-connector-provider-identity-verify'
import type { DbAdapter } from '../core/db'

const NOW = new Date('2026-06-30T00:00:00.000Z')
const REPO_ROOT = resolve(import.meta.dir, '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

class FakeIdentityVerifyDb implements DbAdapter {
  calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly agents: any[] = [],
    private readonly credentials: any[] = [],
    private readonly identities: any[] = [],
  ) {}

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    this.calls.push({ sql, params })
    if (/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(sql)) {
      throw new Error(`mutation SQL is forbidden in identity verify test: ${sql}`)
    }
    const agentId = params?.[0]
    const matchesAgent = (row: any) => row.agent_id === agentId
    if (sql.includes('FROM agents')) return this.agents.filter(matchesAgent) as T[]
    if (sql.includes('FROM connector_credentials')) return this.credentials.filter(matchesAgent) as T[]
    if (sql.includes('FROM agent_provider_identities')) return this.identities.filter(matchesAgent) as T[]
    throw new Error(`unexpected SQL in identity verify fake: ${sql}`)
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(): Promise<{ rowCount: number }> {
    throw new Error('unexpected execute in identity verify fake')
  }

  async transaction<T>(): Promise<T> {
    throw new Error('unexpected transaction in identity verify fake')
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

async function verify(db: FakeIdentityVerifyDb): Promise<AunConnectorProviderIdentityVerify> {
  return buildAunConnectorProviderIdentityVerify(db, {
    agentId: 'kodama',
    provider: 'discord',
    dryRun: true,
    now: () => NOW,
  })
}

describe('AUN connector provider identity verify', () => {
  test('builds a Discord identity dry-run plan without mutation or live provider calls', async () => {
    const db = new FakeIdentityVerifyDb([agent()], [credential()], [identity()])
    const result = await verify(db)

    expect(result).toMatchObject({
      schema_version: AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION,
      generated_at: '2026-06-30T00:00:00.000Z',
      dry_run: true,
      provider: 'discord',
      agent_id: 'kodama',
      verification_plan: {
        live_provider_call: false,
        expected_provider_subject_id: '123456789012345678',
      },
      summary: {
        blockers: 0,
        live_provider_calls: 0,
      },
      applied_mutations: [],
    })
    expect(result.credential_evidence[0]).toMatchObject({
      credential_id: 'credential-kodama',
      token_fingerprint_present: true,
    })
    expect(result.provider_identity_evidence[0]).toMatchObject({
      provider_subject_id: '123456789012345678',
      matches_expected_subject: true,
    })
    expect(db.calls.every((call) => !/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|MERGE|VACUUM)\b/iu.test(call.sql))).toBe(true)
  })

  test('redacts raw-secret-like refs in dry-run evidence', async () => {
    const raw = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const db = new FakeIdentityVerifyDb(
      [agent({ provider_token_source_ref: raw })],
      [credential({ secret_ref: raw })],
      [identity()],
    )

    const result = await verify(db)
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

  test('reports blockers when expected Discord subject does not match existing identity evidence', async () => {
    const db = new FakeIdentityVerifyDb(
      [agent()],
      [credential()],
      [identity({ provider_subject_id: '999999999999999999' })],
    )

    const result = await verify(db)

    expect(result.summary.blockers).toBe(1)
    expect(result.findings).toContainEqual(expect.objectContaining({
      severity: 'blocker',
      code: 'expected_discord_subject_mismatch',
      agent_id: 'kodama',
    }))
    expect(result.applied_mutations).toEqual([])
  })

  test('CLI emits JSON from an existing sqlite DB in read-only dry-run mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-identity-verify-'))
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
        INSERT INTO agents VALUES (
          'kodama',
          'dev',
          'env:KODAMA_DISCORD_TOKEN',
          '{"provider":"discord","subject_id":"123456789012345678"}',
          1,
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
      `)
      db.close()

      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'verify-discord-identity',
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
        schema_version: AUN_CONNECTOR_PROVIDER_IDENTITY_VERIFY_VERSION,
        dry_run: true,
        summary: {
          blockers: 0,
          live_provider_calls: 0,
        },
        applied_mutations: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CLI requires --dry-run before opening or creating sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-identity-verify-no-dry-run-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'verify-discord-identity',
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
    const dir = mkdtempSync(join(tmpdir(), 'aun-identity-verify-no-json-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'verify-discord-identity',
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

  test('CLI rejects unsupported provider identity targets before opening sqlite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aun-identity-verify-unsupported-'))
    const dbPath = join(dir, 'missing-agent-com.db')
    try {
      const result = spawnSync('bun', [
        AUN_CLI,
        'connector',
        'verify-slack-identity',
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
