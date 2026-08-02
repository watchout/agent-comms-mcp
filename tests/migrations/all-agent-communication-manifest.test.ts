import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createPostgresTestDatabase,
  derivePostgresTestDatabaseUrls,
  type PostgresTestDatabase,
} from '../helpers/postgres-test-database'

const upPath = join(import.meta.dir, '../../db/migrations/2026-07-26-all-agent-communication-manifest.up.sql')
const downPath = join(import.meta.dir, '../../db/migrations/2026-07-26-all-agent-communication-manifest.down.sql')
const database = `acm_manifest_${randomUUID().replace(/-/g, '')}`
let fixture: PostgresTestDatabase | null = null
let url = ''

function run(command: string, args: string[]) {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (${result.exitCode}): ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

describe('ordinary all-agent manifest PostgreSQL migration', () => {
  beforeAll(() => {
    fixture = createPostgresTestDatabase(database)
    url = fixture.databaseUrl
  })
  afterAll(() => fixture?.drop())

  test('test database URLs preserve configured transport and prefer the explicit test base', () => {
    const urls = derivePostgresTestDatabaseUrls('acm_transport_fixture', {
      AGENT_COM_TEST_DATABASE_URL: 'postgresql://fixture_user:s3cr%40t@db.example.test:55432/base?sslmode=require&application_name=layer0',
      DATABASE_URL: 'postgresql://ignored.example.test/ignored',
    })
    const maintenance = new URL(urls.maintenanceUrl)
    const target = new URL(urls.databaseUrl)
    expect(maintenance.pathname).toBe('/postgres')
    expect(target.pathname).toBe('/acm_transport_fixture')
    expect(target.host).toBe('db.example.test:55432')
    expect(target.username).toBe('fixture_user')
    expect(target.password).toBe('s3cr%40t')
    expect(target.searchParams.get('sslmode')).toBe('require')
    expect(target.searchParams.get('application_name')).toBe('layer0')

    const fallback = new URL(derivePostgresTestDatabaseUrls('acm_socket_fixture', {}).databaseUrl)
    expect(fallback.pathname).toBe('/acm_socket_fixture')
    expect(fallback.searchParams.get('host')).toBe('/tmp')
    expect(() => derivePostgresTestDatabaseUrls('../unsafe', {})).toThrow('unsafe PostgreSQL test database name')
    expect(() => derivePostgresTestDatabaseUrls('acm_invalid_url', { DATABASE_URL: 'https://example.test/db' }))
      .toThrow('must use postgres or postgresql')
  })

  test('up/up/down/up is isolated, idempotent, and preserves unrelated tables', () => {
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE unrelated_history(id integer primary key); INSERT INTO unrelated_history VALUES (1);'])
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', upPath])
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', upPath])
    const tables = run('psql', [url, '-At', '-c', "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"])
    expect(tables).toContain('all_agent_communication_manifest_revisions')
    expect(tables).toContain('all_agent_communication_manifest_targets')
    expect(tables).toContain('all_agent_communication_manifest_projections')
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', downPath])
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', downPath])
    expect(run('psql', [url, '-At', '-c', 'SELECT count(*) FROM unrelated_history'])).toBe('1\n')
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', upPath])
  })

  test('down migration refuses to destroy durable manifest history', () => {
    run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', `
      INSERT INTO all_agent_communication_manifest_revisions
        (manifest_id, revision, schema_version, issued_at, not_before, expires_at,
         owner_decision_ref, owner_pinned_digest, target_count, target_sha256,
         release_commit, release_tree, artifact_digest, policy_digest, canonical_manifest)
      VALUES ('m1', 1, 'all-agent-communication-manifest/v1', now(), now(), now() + interval '1 hour',
        'https://github.com/watchout/agent-comms-mcp/issues/887', repeat('a',64), 1, repeat('b',64),
        repeat('c',40), repeat('d',40), repeat('e',64), repeat('f',64), '{}'::jsonb)`])
    const result = Bun.spawnSync(['psql', url, '-v', 'ON_ERROR_STOP=1', '-f', downPath], { stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain('durable manifest history is not empty')
    expect(run('psql', [url, '-At', '-c', 'SELECT count(*) FROM all_agent_communication_manifest_revisions'])).toBe('1\n')
  })

  test('SQL never touches protected D1 or queue history tables', () => {
    const sql = `${readFileSync(upPath, 'utf8')}\n${readFileSync(downPath, 'utf8')}`
    expect(sql).not.toMatch(/shirube_d1_(claims|invocations|effect_deliveries)/)
    expect(sql).not.toMatch(/\bmessage_queue\b/)
  })
})
