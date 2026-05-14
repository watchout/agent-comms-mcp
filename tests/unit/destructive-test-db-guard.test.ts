import { describe, expect, test } from 'bun:test'
import {
  assertDestructiveMigrationTestDatabaseUrl,
  parsePostgresDatabaseName,
} from '../helpers/destructive-test-db-guard'

describe('destructive migration test DB guard', () => {
  test('parses Unix-socket and host-based PostgreSQL URLs', () => {
    expect(parsePostgresDatabaseName('postgresql:///agent_comms_test?host=/tmp')).toBe(
      'agent_comms_test',
    )
    expect(parsePostgresDatabaseName('postgres://user:pass@example.com:5432/agent_comms_test')).toBe(
      'agent_comms_test',
    )
  })

  test('accepts dedicated *_test databases', () => {
    expect(
      assertDestructiveMigrationTestDatabaseUrl('postgresql:///agent_comms_test?host=/tmp'),
    ).toBe('postgresql:///agent_comms_test?host=/tmp')
  })

  test('rejects absent, production, non-test, and non-PostgreSQL targets', () => {
    expect(() => assertDestructiveMigrationTestDatabaseUrl(undefined)).toThrow(
      'AGENT_COM_TEST_DATABASE_URL is required',
    )
    expect(() =>
      assertDestructiveMigrationTestDatabaseUrl('postgresql:///agent_comms?host=/tmp'),
    ).toThrow("Refusing to run destructive migration tests against database 'agent_comms'")
    expect(() =>
      assertDestructiveMigrationTestDatabaseUrl('postgresql:///agent_comms_dev?host=/tmp'),
    ).toThrow('must point at a dedicated *_test database')
    expect(() =>
      assertDestructiveMigrationTestDatabaseUrl('sqlite:///tmp/agent_comms_test.sqlite'),
    ).toThrow('must be a PostgreSQL URL')
  })
})
