import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PgAdapter } from '../../../core/db/pg-adapter'

const ROOT = resolve(import.meta.dir, '../../..')
const UP = resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.up.sql')
const DOWN = resolve(ROOT, 'db/migrations/2026-07-16-aun-k1-event-projection-claim.down.sql')

export function isK1PostgresFixtureEnabled(): boolean {
  return process.env.AUN_K1_DB_SCOPE === 'isolated_disposable_fixture'
}

function guardedDatabaseUrl(): { url: string; databaseName: string } {
  if (process.env.AUN_K1_DB_SCOPE !== 'isolated_disposable_fixture') {
    throw new Error('AUN_K1_DB_SCOPE must equal isolated_disposable_fixture before K1 PostgreSQL DDL or DML')
  }
  const url = process.env.DATABASE_URL ?? process.env.AUN_K1_TEST_DATABASE_URL
  if (!url) throw new Error('DATABASE_URL or AUN_K1_TEST_DATABASE_URL is required')
  const parsed = new URL(url)
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  if (!databaseName.startsWith('aun_k1_fixture_')) {
    throw new Error(`K1 PostgreSQL fixture database must begin with aun_k1_fixture_: ${databaseName}`)
  }
  return { url, databaseName }
}

function schemaName(label: string): string {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `k1_${normalized}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

function quotedSchema(schema: string): string {
  if (!/^[a-z0-9_]+$/.test(schema)) throw new Error(`unsafe fixture schema: ${schema}`)
  return `"${schema}"`
}

const EVENT_LOG_DDL = `
  CREATE TABLE event_log (
    seq BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    seat_id TEXT,
    seat_instance_id TEXT,
    conversation_id TEXT,
    causation_id TEXT,
    correlation_id TEXT,
    turn_id TEXT,
    reply_id TEXT,
    claim_epoch INTEGER,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE OR REPLACE FUNCTION event_log_append_only() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'event_log is append-only: % forbidden', TG_OP;
  END;
  $$ LANGUAGE plpgsql;
  CREATE TRIGGER event_log_no_update BEFORE UPDATE ON event_log
    FOR EACH ROW EXECUTE FUNCTION event_log_append_only();
  CREATE TRIGGER event_log_no_delete BEFORE DELETE ON event_log
    FOR EACH ROW EXECUTE FUNCTION event_log_append_only();
  CREATE UNIQUE INDEX uq_el_turn_claim
    ON event_log(turn_id, claim_epoch) WHERE event_type='turn.claimed';
  CREATE UNIQUE INDEX uq_el_turn_completed
    ON event_log(turn_id) WHERE event_type='turn.completed';
  CREATE UNIQUE INDEX uq_el_delivery_claim
    ON event_log(reply_id, claim_epoch) WHERE event_type='reply.delivery_claimed';
  CREATE UNIQUE INDEX uq_el_reply_delivered
    ON event_log(reply_id) WHERE event_type='reply.delivered';
  CREATE INDEX idx_el_type_turn ON event_log(event_type, turn_id);
  CREATE INDEX idx_el_type_reply ON event_log(event_type, reply_id);
  CREATE INDEX idx_el_conversation ON event_log(conversation_id, seq);
  CREATE INDEX idx_el_seat_type ON event_log(seat_id, event_type);
  CREATE INDEX idx_el_causation ON event_log(causation_id);
`

export async function adapterForK1Schema(url: string, schema: string): Promise<PgAdapter> {
  const db = new PgAdapter(url)
  await db.execute(`SET search_path TO ${quotedSchema(schema)}, public`)
  return db
}

export async function applyK1Migration(db: PgAdapter, direction: 'up' | 'down'): Promise<void> {
  await db.execute(readFileSync(direction === 'up' ? UP : DOWN, 'utf8'))
}

export interface K1PostgresFixture {
  db: PgAdapter
  databaseName: string
  databaseUrl: string
  schema: string
  connect(): Promise<PgAdapter>
  migrate(direction: 'up' | 'down'): Promise<void>
  cleanup(): Promise<void>
}

export async function createK1PostgresFixture(label: string): Promise<K1PostgresFixture> {
  const { url, databaseName } = guardedDatabaseUrl()
  const schema = schemaName(label)
  const bootstrap = new PgAdapter(url)
  await bootstrap.execute(`CREATE SCHEMA ${quotedSchema(schema)}`)
  await bootstrap.execute(`SET search_path TO ${quotedSchema(schema)}, public`)
  await bootstrap.execute(EVENT_LOG_DDL)
  await applyK1Migration(bootstrap, 'up')
  return {
    db: bootstrap,
    databaseName,
    databaseUrl: url,
    schema,
    connect: () => adapterForK1Schema(url, schema),
    migrate: direction => applyK1Migration(bootstrap, direction),
    async cleanup() {
      await bootstrap.execute(`DROP SCHEMA IF EXISTS ${quotedSchema(schema)} CASCADE`)
      await bootstrap.close()
    },
  }
}

export function requireK1PostgresGuard(): { databaseName: string } {
  return guardedDatabaseUrl()
}
