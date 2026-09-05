import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DESTRUCTIVE_GATE_ENV,
  DestructiveMigrationBlockedError,
  ProductionDatabaseDestructiveMigrationBlockedError,
  PRODUCTION_DESTRUCTIVE_GATE_ENV,
  TEST_DATABASE_URL_ENV,
  assertDestructiveMigrationAllowed,
  assertDestructiveMigrationTestDatabase,
  assertNoProductionDestructiveMigration,
  detectDestructivePatterns,
} from './destructive-migration-gate'
import { migrateSqlite } from './migrate-sqlite'

const ENV = DESTRUCTIVE_GATE_ENV

function clearEnv() {
  delete process.env[ENV]
}

function setEnv(value: string) {
  process.env[ENV] = value
}

function expectBlocked(sql: string, expectedPatterns: string[]) {
  let thrown: unknown
  try {
    assertDestructiveMigrationAllowed(sql)
  } catch (e) {
    thrown = e
  }
  expect(thrown).toBeInstanceOf(DestructiveMigrationBlockedError)
  const err = thrown as DestructiveMigrationBlockedError
  expect(err.name).toBe('DestructiveMigrationBlockedError')
  expect(err.envName).toBe(ENV)
  expect(err.patterns).toEqual(expectedPatterns)
  expect(err.message).toContain(ENV)
}

describe('destructive-migration-gate (spec §4.2)', () => {
  beforeEach(() => clearEnv())
  afterEach(() => clearEnv())

  test('T1: DROP COLUMN unset → blocked', () => {
    expectBlocked(
      'ALTER TABLE agent_messages DROP COLUMN failed_reason;',
      ['DROP COLUMN'],
    )
  })

  test('T2: ALTER COLUMN unset → blocked', () => {
    expectBlocked('ALTER TABLE x ALTER COLUMN y TYPE int;', ['ALTER COLUMN'])
  })

  test('T2b: DROP CONSTRAINT unset → blocked', () => {
    expectBlocked(
      'ALTER TABLE message_queue DROP CONSTRAINT message_queue_status_check;',
      ['DROP CONSTRAINT'],
    )
  })

  test('T3: RENAME unset → blocked', () => {
    expectBlocked('ALTER TABLE x RENAME COLUMN a TO b;', ['RENAME'])
  })

  test('T4: TRUNCATE unset → blocked', () => {
    expectBlocked('TRUNCATE agent_messages;', ['TRUNCATE'])
  })

  test('T5: DROP TABLE unset → blocked', () => {
    expectBlocked('DROP TABLE legacy_queue;', ['DROP TABLE'])
  })

  test('T6: DROP COLUMN + env=1 → allowed (no-throw, returns undefined)', () => {
    setEnv('1')
    expect(
      assertDestructiveMigrationAllowed(
        'ALTER TABLE agent_messages DROP COLUMN failed_reason;',
      ),
    ).toBeUndefined()
  })

  test('T7: CREATE TABLE unset → no-throw (non-destructive regression)', () => {
    expect(
      assertDestructiveMigrationAllowed('CREATE TABLE IF NOT EXISTS foo (id int);'),
    ).toBeUndefined()
  })

  test('T8: ADD COLUMN unset → no-throw (non-destructive regression)', () => {
    expect(
      assertDestructiveMigrationAllowed(
        'ALTER TABLE x ADD COLUMN IF NOT EXISTS y int;',
      ),
    ).toBeUndefined()
  })

  test('T9: CREATE INDEX unset → no-throw (non-destructive regression)', () => {
    expect(
      assertDestructiveMigrationAllowed(
        'CREATE INDEX IF NOT EXISTS idx_x ON foo(id);',
      ),
    ).toBeUndefined()
  })

  test('T10: DROP COLUMN inside comment → no-throw (comment stripped)', () => {
    expect(
      assertDestructiveMigrationAllowed(
        '/* DROP COLUMN foo */ CREATE TABLE bar (id int);',
      ),
    ).toBeUndefined()
    // Also confirm `-- DROP COLUMN ...` line comment is stripped.
    expect(
      assertDestructiveMigrationAllowed(
        '-- DROP COLUMN x\nCREATE TABLE bar (id int);',
      ),
    ).toBeUndefined()
  })

  test('T11: lowercase drop column → blocked (case-insensitive)', () => {
    expectBlocked('drop column foo', ['DROP COLUMN'])
  })

  test("T12: env='true' (not '1') → blocked (strict '1' compare)", () => {
    setEnv('true')
    expectBlocked(
      'ALTER TABLE agent_messages DROP COLUMN failed_reason;',
      ['DROP COLUMN'],
    )
  })

  test('T13: multi-statement DROP COLUMN + CREATE INDEX → blocked on whole-string', () => {
    expectBlocked(
      'ALTER TABLE x DROP COLUMN y; CREATE INDEX idx_y ON x(z);',
      ['DROP COLUMN'],
    )
  })

  test('T14: sqlite path — migrateSqlite() integration: env unset + destructive line → blocked', () => {
    // §2.4 + §4.2 T14 integration contract: exercise the real
    // migrateSqlite() entry point (db/migrate-sqlite.ts:7), not a local
    // wrapper. Pre-seed a temp DB with `agents.current_message_id` so the
    // existing `ALTER TABLE agents DROP COLUMN current_message_id` upgrade
    // line fires; the gate must throw before db.exec runs it.
    const tmpDir = mkdtempSync(join(tmpdir(), 'gate-t14-'))
    const tmpPath = join(tmpDir, 't14.db')
    try {
      const seed = new Database(tmpPath, { create: true })
      seed.exec(
        'CREATE TABLE agents (agent_id TEXT PRIMARY KEY, current_message_id TEXT)',
      )
      seed.close()

      let thrown: unknown
      try {
        migrateSqlite(tmpPath)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(DestructiveMigrationBlockedError)
      const err = thrown as DestructiveMigrationBlockedError
      expect(err.patterns).toContain('DROP COLUMN')
      expect(err.envName).toBe(ENV)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('T15: sqlite path — migrateSqlite() integration: fresh DB has no destructive → no-throw', () => {
    // §4.2 T15 regression: a fresh sqlite DB has no `current_message_id`
    // column on `agents`, so the upgrade DROP block is skipped and the
    // gate must let the full migration through.
    const tmpDir = mkdtempSync(join(tmpdir(), 'gate-t15-'))
    const tmpPath = join(tmpDir, 't15.db')
    try {
      expect(() => migrateSqlite(tmpPath)).not.toThrow()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('destructive-migration-gate (cycle 3 quote/comment awareness)', () => {
  beforeEach(() => clearEnv())
  afterEach(() => clearEnv())

  test('T16: RENAME inside a quoted literal → no-throw (Axis 5 false-positive)', () => {
    // `INSERT INTO logs VALUES ('RENAME requested')` must not trip the gate.
    expect(
      assertDestructiveMigrationAllowed(
        "INSERT INTO logs(msg) VALUES ('RENAME requested')",
      ),
    ).toBeUndefined()
    expect(
      detectDestructivePatterns(
        "INSERT INTO logs(msg) VALUES ('RENAME requested')",
      ),
    ).toEqual([])
  })

  test('T17: quoted `--` followed by real DROP TABLE → throw (Axis 6 bypass)', () => {
    // Regex-only strip would consume from the `--` inside the string through
    // EOL, hiding the DROP TABLE. The state machine must keep it visible.
    expectBlocked(
      "SELECT '-- harmless'; DROP TABLE users;",
      ['DROP TABLE'],
    )
  })

  test('T18: dollar-quoted body then ALTER ... DROP COLUMN → throw', () => {
    expectBlocked(
      "DO $$ BEGIN RAISE NOTICE '--'; END $$; ALTER TABLE x DROP COLUMN y;",
      ['DROP COLUMN'],
    )
  })

  test('T19: destructive-looking double-quoted identifier → no-throw', () => {
    // postgres treats `"DROP TABLE ..."` as a quoted identifier, not a
    // statement. The gate should not treat its inside as SQL code.
    expect(
      assertDestructiveMigrationAllowed(
        'SELECT "DROP TABLE not_destructive" FROM t',
      ),
    ).toBeUndefined()
  })

  test("T20: doubled-quote escape '' inside string literal -> no-throw", () => {
    // `'''DROP COLUMN escaped'''` is a single literal whose value contains
    // `'DROP COLUMN escaped'`. Nothing escapes into SQL code.
    expect(
      assertDestructiveMigrationAllowed("SELECT '''DROP COLUMN escaped'''"),
    ).toBeUndefined()
  })

  test("tagged dollar-quote $foo$...$foo$ is fully redacted", () => {
    expect(
      assertDestructiveMigrationAllowed(
        "DO $foo$ DROP COLUMN inner $foo$; SELECT 1;",
      ),
    ).toBeUndefined()
  })

  test('multi-statement: real ALTER COLUMN after a quoted decoy → throw', () => {
    expectBlocked(
      "INSERT INTO logs VALUES ('ALTER COLUMN imaginary'); ALTER TABLE x ALTER COLUMN y TYPE int;",
      ['ALTER COLUMN'],
    )
  })
})

describe('destructive-migration-gate / detectDestructivePatterns', () => {
  test('returns empty array for non-destructive SQL', () => {
    expect(detectDestructivePatterns('SELECT 1')).toEqual([])
  })

  test('returns multiple patterns when several are present', () => {
    const found = detectDestructivePatterns(
      'TRUNCATE x; ALTER TABLE y DROP COLUMN z',
    )
    expect(found.sort()).toEqual(['DROP COLUMN', 'TRUNCATE'].sort())
  })
})

describe('destructive-migration-gate / production DB guard', () => {
  let previousEnvironment: Array<[string, string | undefined]> = []

  beforeEach(() => {
    previousEnvironment = [PRODUCTION_DESTRUCTIVE_GATE_ENV, TEST_DATABASE_URL_ENV]
      .map((key): [string, string | undefined] => [key, process.env[key]])
  })

  afterEach(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('blocks destructive SQL against production agent_comms even when the base gate is enabled', () => {
    let thrown: unknown
    try {
      assertNoProductionDestructiveMigration(
        'ALTER TABLE message_queue DROP COLUMN failed_reason;',
        'postgresql:///agent_comms?host=/tmp',
        { [DESTRUCTIVE_GATE_ENV]: '1' } as NodeJS.ProcessEnv,
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ProductionDatabaseDestructiveMigrationBlockedError)
    expect((thrown as Error).message).toContain(PRODUCTION_DESTRUCTIVE_GATE_ENV)
  })

  test('allows destructive SQL against an explicit test database', () => {
    expect(
      assertNoProductionDestructiveMigration(
        'ALTER TABLE message_queue DROP COLUMN failed_reason;',
        'postgresql:///agent_comms_test?host=/tmp',
      ),
    ).toBeUndefined()
  })

  test('destructive migration tests require AGENT_COM_TEST_DATABASE_URL or *_test', () => {
    expect(
      assertDestructiveMigrationTestDatabase(
        'postgresql:///agent_comms_test?host=/tmp',
      ),
    ).toBeUndefined()

    let thrown: unknown
    try {
      assertDestructiveMigrationTestDatabase(
        'postgresql:///agent_comms?host=/tmp',
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ProductionDatabaseDestructiveMigrationBlockedError)
  })
})
