/**
 * Destructive migration gate (incident #339, route:fast-merge).
 *
 * Backend-neutral policy module. Both db/migrate.ts (postgres) and
 * db/migrate-sqlite.ts (sqlite) import the same helper, error type, and
 * detection table per spec §1.5 adapter-symmetry invariant.
 *
 * Origin: PR #338 m1 commit `ebba871` ran `DROP COLUMN failed_reason` on the
 * production DB (2026-05-11 09:18-09:22 JST cascade incident). This gate is
 * fail-closed: env flag unset = block, explicit `=1` = allow.
 */

import { defaultConfigPort, DESTRUCTIVE_GATE_ENV as PORT_DESTRUCTIVE_GATE_ENV } from '../core/ports/config-port'

// Re-exported for callers (tests, error.envName) that need the env name
// string directly. The source of truth lives in the ConfigPort module.
export const DESTRUCTIVE_GATE_ENV = PORT_DESTRUCTIVE_GATE_ENV

const DESTRUCTIVE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'DROP COLUMN', regex: /\bDROP\s+COLUMN\b/i },
  { name: 'DROP CONSTRAINT', regex: /\bDROP\s+CONSTRAINT\b/i },
  { name: 'ALTER COLUMN', regex: /\bALTER\s+COLUMN\b/i },
  { name: 'RENAME', regex: /\bRENAME\b/i },
  { name: 'TRUNCATE', regex: /\bTRUNCATE\b/i },
  { name: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/i },
]

// Char-by-char state machine that returns SQL code with quoted literals,
// dollar-quoted bodies, and SQL comments redacted to spaces. The state machine
// preserves positions (replaces redacted bytes with spaces) so multi-statement
// whole-string regex matching still works on the cleaned output.
//
// cycle-3 auditor (msg 6bf799cf) flagged that a regex-only strip would let
// `SELECT '-- harmless'; DROP TABLE users;` bypass the gate because the
// line-comment strip would swallow everything from the `--` inside the string
// through end of line, including the real DROP TABLE.
//
// Handled states: single-quote with '' escape, double-quote with "" escape
// (postgres identifier quoting), dollar-quote $tag$...$tag$ (postgres function
// bodies, empty tag $$ ok), line comment -- to newline, block comment (non-
// nested; postgres supports nesting but the in-tree migrations do not).
function redactSqlLiteralsAndComments(sql: string): string {
  const out: string[] = []
  let i = 0
  const n = sql.length

  const matchDollarTag = (pos: number): { tag: string; len: number } | null => {
    if (sql[pos] !== '$') return null
    // tag is letters/digits/underscores between two `$` (empty tag = `$$`)
    let j = pos + 1
    while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++
    if (sql[j] !== '$') return null
    return { tag: sql.slice(pos + 1, j), len: j - pos + 1 }
  }

  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]

    // line comment
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i)
      const stop = eol === -1 ? n : eol
      out.push(' '.repeat(stop - i))
      i = stop
      continue
    }

    // block comment
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2)
      const stop = close === -1 ? n : close + 2
      out.push(' '.repeat(stop - i))
      i = stop
      continue
    }

    // single-quote literal
    if (c === "'") {
      out.push(' ')
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            // `''` escape -> consume both
            out.push('  ')
            i += 2
            continue
          }
          out.push(' ')
          i++
          break
        }
        out.push(' ')
        i++
      }
      continue
    }

    // double-quote identifier
    if (c === '"') {
      out.push(' ')
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out.push('  ')
            i += 2
            continue
          }
          out.push(' ')
          i++
          break
        }
        out.push(' ')
        i++
      }
      continue
    }

    // dollar-quoted body
    const open = matchDollarTag(i)
    if (open) {
      const closeMark = `$${open.tag}$`
      out.push(' '.repeat(open.len))
      i += open.len
      const closeAt = sql.indexOf(closeMark, i)
      const stop = closeAt === -1 ? n : closeAt + closeMark.length
      out.push(' '.repeat(stop - i))
      i = stop
      continue
    }

    out.push(c)
    i++
  }

  return out.join('')
}

export function detectDestructivePatterns(sql: string): string[] {
  const cleaned = redactSqlLiteralsAndComments(sql)
  const found: string[] = []
  for (const { name, regex } of DESTRUCTIVE_PATTERNS) {
    if (regex.test(cleaned)) found.push(name)
  }
  return found
}

export class DestructiveMigrationBlockedError extends Error {
  readonly name = 'DestructiveMigrationBlockedError'
  readonly patterns: string[]
  readonly envName: string = DESTRUCTIVE_GATE_ENV
  constructor(patterns: string[], message: string) {
    super(message)
    this.patterns = patterns
  }
}

export const PRODUCTION_DESTRUCTIVE_GATE_ENV =
  'AGENT_COMMS_PRODUCTION_DESTRUCTIVE_MIGRATIONS_ALLOWED'
export const TEST_DATABASE_URL_ENV = 'AGENT_COM_TEST_DATABASE_URL'

export class ProductionDatabaseDestructiveMigrationBlockedError extends Error {
  readonly name = 'ProductionDatabaseDestructiveMigrationBlockedError'
  readonly databaseName: string | null
  readonly envName: string = PRODUCTION_DESTRUCTIVE_GATE_ENV
  constructor(databaseName: string | null, message: string) {
    super(message)
    this.databaseName = databaseName
  }
}

function databaseNameFromUrl(databaseUrl: string): string | null {
  try {
    const parsed = new URL(databaseUrl)
    const path = decodeURIComponent(parsed.pathname ?? '').replace(/^\/+/, '')
    if (!path) return null
    return path.split('/').filter(Boolean).at(-1) ?? null
  } catch {
    return null
  }
}

function productionDatabaseNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.AGENT_COM_PRODUCTION_DATABASE_NAMES ?? 'agent_comms'
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

export function isProductionDatabaseUrl(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dbName = databaseNameFromUrl(databaseUrl)
  return dbName !== null && productionDatabaseNames(env).has(dbName)
}

export function assertDestructiveMigrationTestDatabase(
  databaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!databaseUrl) {
    throw new ProductionDatabaseDestructiveMigrationBlockedError(
      null,
      `${TEST_DATABASE_URL_ENV} or DATABASE_URL is required for destructive migration tests.`,
    )
  }
  const dbName = databaseNameFromUrl(databaseUrl)
  if (env[TEST_DATABASE_URL_ENV] && databaseUrl === env[TEST_DATABASE_URL_ENV]) {
    if (!isProductionDatabaseUrl(databaseUrl, env)) return
  }
  if (dbName?.endsWith('_test')) return
  throw new ProductionDatabaseDestructiveMigrationBlockedError(
    dbName,
    `Destructive migration tests require ${TEST_DATABASE_URL_ENV} or a *_test database. ` +
      `Refusing target database ${dbName ?? '<unknown>'}.`,
  )
}

export function assertDestructiveMigrationAllowed(sql: string): void {
  const patterns = detectDestructivePatterns(sql)
  if (patterns.length === 0) return
  if (defaultConfigPort.getDestructiveMigrationFlagState().allowed) return
  throw new DestructiveMigrationBlockedError(
    patterns,
    `Destructive migration blocked: [${patterns.map(p => `'${p}'`).join(', ')}]. ` +
      `Set ${DESTRUCTIVE_GATE_ENV}=1 to proceed (production deploy only). ` +
      `incident #339 anchor.`,
  )
}

export function assertNoProductionDestructiveMigration(
  sql: string,
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const patterns = detectDestructivePatterns(sql)
  if (patterns.length === 0) return
  if (!isProductionDatabaseUrl(databaseUrl, env)) return
  if (env[PRODUCTION_DESTRUCTIVE_GATE_ENV] === '1') return
  throw new ProductionDatabaseDestructiveMigrationBlockedError(
    databaseNameFromUrl(databaseUrl),
    `Destructive migration targets production database '${databaseNameFromUrl(databaseUrl) ?? '<unknown>'}'. ` +
      `Set ${PRODUCTION_DESTRUCTIVE_GATE_ENV}=1 only for an operator-approved production migration. ` +
      `Tests must use ${TEST_DATABASE_URL_ENV} or a *_test database.`,
  )
}

export function destructiveGateLogLine(): string {
  return defaultConfigPort.getDestructiveMigrationFlagState().allowed
    ? '[migrate] destructive migrations: ALLOWED (env)'
    : '[migrate] destructive migrations: BLOCKED (default, dev-bot safe)'
}
