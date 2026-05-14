import type { Client } from 'pg'

export const DESTRUCTIVE_TEST_DATABASE_URL_ENV = 'AGENT_COM_TEST_DATABASE_URL'
export const PRODUCTION_DATABASE_NAMES = new Set(['agent_comms'])

const FORWARD_COMPATIBLE_MESSAGE_QUEUE_STATUSES = [
  'pending',
  'read',
  'received',
  'in_progress',
  'done',
  'replied',
  'skipped',
  'failed',
]

export function parsePostgresDatabaseName(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl)
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null
    const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    return dbName || null
  } catch {
    return null
  }
}

export function assertDestructiveMigrationTestDatabaseUrl(
  databaseUrl: string | undefined | null,
): string {
  if (!databaseUrl) {
    throw new Error(
      `${DESTRUCTIVE_TEST_DATABASE_URL_ENV} is required for destructive migration tests. ` +
        `Do not use DATABASE_URL; use a dedicated database such as agent_comms_test.`,
    )
  }

  const dbName = parsePostgresDatabaseName(databaseUrl)
  if (!dbName) {
    throw new Error(
      `${DESTRUCTIVE_TEST_DATABASE_URL_ENV} must be a PostgreSQL URL with an explicit database name.`,
    )
  }

  if (PRODUCTION_DATABASE_NAMES.has(dbName) || !dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run destructive migration tests against database '${dbName}'. ` +
        `${DESTRUCTIVE_TEST_DATABASE_URL_ENV} must point at a dedicated *_test database.`,
    )
  }

  return databaseUrl
}

export function getDestructiveMigrationTestDatabaseUrl(): string | null {
  const databaseUrl = process.env[DESTRUCTIVE_TEST_DATABASE_URL_ENV]
  if (!databaseUrl) return null
  return assertDestructiveMigrationTestDatabaseUrl(databaseUrl)
}

export function installDestructiveMigrationTestDatabaseUrl(databaseUrl: string): string | undefined {
  const priorDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = assertDestructiveMigrationTestDatabaseUrl(databaseUrl)
  return priorDatabaseUrl
}

export function restoreDatabaseUrl(priorDatabaseUrl: string | undefined): void {
  if (priorDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL
  } else {
    process.env.DATABASE_URL = priorDatabaseUrl
  }
}

export async function restoreForwardCompatibleMessageQueueStatusConstraint(
  client: Client,
): Promise<void> {
  const statuses = FORWARD_COMPATIBLE_MESSAGE_QUEUE_STATUSES
    .map(status => `'${status}'`)
    .join(', ')

  await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS failed_reason TEXT`)
  await client.query(`ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ`)
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'message_queue_status_check'
           AND conrelid = 'message_queue'::regclass
      ) THEN
        ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;
      END IF;
      ALTER TABLE message_queue
        ADD CONSTRAINT message_queue_status_check
        CHECK (status IN (${statuses}));
    END $$;
  `)
}
