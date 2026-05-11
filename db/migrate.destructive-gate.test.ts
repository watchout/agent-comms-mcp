import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  DESTRUCTIVE_GATE_ENV,
  DestructiveMigrationBlockedError,
  assertDestructiveMigrationAllowed,
  detectDestructivePatterns,
} from './destructive-migration-gate'

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

  test('T14: sqlite path — DROP COLUMN via migrateSqlite gate → blocked', async () => {
    // §2.4 anchor: sqlite path must use the SAME gate before db.exec.
    // We simulate by running the gated wrapper that migrate-sqlite.ts uses.
    const db = new Database(':memory:', { create: true })
    const gatedExec = (sql: string): void => {
      assertDestructiveMigrationAllowed(sql)
      db.exec(sql)
    }
    let thrown: unknown
    try {
      gatedExec('ALTER TABLE agent_messages DROP COLUMN failed_reason')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(DestructiveMigrationBlockedError)
    db.close()
  })

  test('T15: sqlite path — CREATE INDEX → no-throw (regression)', () => {
    const db = new Database(':memory:', { create: true })
    db.exec('CREATE TABLE foo (id INTEGER)')
    const gatedExec = (sql: string): void => {
      assertDestructiveMigrationAllowed(sql)
      db.exec(sql)
    }
    expect(() =>
      gatedExec('CREATE INDEX IF NOT EXISTS idx_x ON foo(id)'),
    ).not.toThrow()
    db.close()
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
