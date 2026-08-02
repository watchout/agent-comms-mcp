const DEFAULT_POSTGRES_TEST_DATABASE_URL = 'postgresql:///postgres?host=/tmp'
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/

type PostgresTestEnvironment = Record<string, string | undefined>

export interface PostgresTestDatabaseUrls {
  maintenanceUrl: string
  databaseUrl: string
}

export interface PostgresTestDatabase {
  databaseName: string
  databaseUrl: string
  drop(): void
}

function validateDatabaseName(databaseName: string): void {
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`unsafe PostgreSQL test database name: ${databaseName}`)
  }
}

function configuredBaseUrl(env: PostgresTestEnvironment): URL {
  const value = env.AGENT_COM_TEST_DATABASE_URL
    ?? env.DATABASE_URL
    ?? DEFAULT_POSTGRES_TEST_DATABASE_URL
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('invalid PostgreSQL test database base URL')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('PostgreSQL test database base URL must use postgres or postgresql')
  }
  return parsed
}

export function derivePostgresTestDatabaseUrls(
  databaseName: string,
  env: PostgresTestEnvironment = process.env,
): PostgresTestDatabaseUrls {
  validateDatabaseName(databaseName)
  const base = configuredBaseUrl(env)
  const maintenance = new URL(base.href)
  maintenance.pathname = '/postgres'
  const database = new URL(base.href)
  database.pathname = `/${databaseName}`
  return { maintenanceUrl: maintenance.href, databaseUrl: database.href }
}

function redactedPostgresError(value: string): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:/@\s]+):[^@\s]+@/gi, '$1:[REDACTED]@')
    .replace(/(\bpassword=)[^\s]+/gi, '$1[REDACTED]')
    .trim()
}

function runDatabaseCommand(
  command: 'createdb' | 'dropdb',
  maintenanceUrl: string,
  databaseName: string,
): void {
  const args = command === 'dropdb'
    ? [`--maintenance-db=${maintenanceUrl}`, '--if-exists', databaseName]
    : [`--maintenance-db=${maintenanceUrl}`, databaseName]
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const detail = redactedPostgresError(result.stderr.toString())
    throw new Error(`${command} failed for PostgreSQL test database ${databaseName} (${result.exitCode})${detail ? `: ${detail}` : ''}`)
  }
}

export function createPostgresTestDatabase(
  databaseName: string,
  env: PostgresTestEnvironment = process.env,
): PostgresTestDatabase {
  const { maintenanceUrl, databaseUrl } = derivePostgresTestDatabaseUrls(databaseName, env)
  runDatabaseCommand('createdb', maintenanceUrl, databaseName)
  let dropped = false
  return {
    databaseName,
    databaseUrl,
    drop() {
      if (dropped) return
      runDatabaseCommand('dropdb', maintenanceUrl, databaseName)
      dropped = true
    },
  }
}
