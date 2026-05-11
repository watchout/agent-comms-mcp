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

export const DESTRUCTIVE_GATE_ENV = 'AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED'

const DESTRUCTIVE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'DROP COLUMN', regex: /\bDROP\s+COLUMN\b/i },
  { name: 'ALTER COLUMN', regex: /\bALTER\s+COLUMN\b/i },
  { name: 'RENAME', regex: /\bRENAME\b/i },
  { name: 'TRUNCATE', regex: /\bTRUNCATE\b/i },
  { name: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/i },
]

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

export function detectDestructivePatterns(sql: string): string[] {
  const stripped = stripSqlComments(sql)
  const found: string[] = []
  for (const { name, regex } of DESTRUCTIVE_PATTERNS) {
    if (regex.test(stripped)) found.push(name)
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

export function assertDestructiveMigrationAllowed(sql: string): void {
  const patterns = detectDestructivePatterns(sql)
  if (patterns.length === 0) return
  if (process.env[DESTRUCTIVE_GATE_ENV] === '1') return
  throw new DestructiveMigrationBlockedError(
    patterns,
    `Destructive migration blocked: [${patterns.map(p => `'${p}'`).join(', ')}]. ` +
      `Set ${DESTRUCTIVE_GATE_ENV}=1 to proceed (production deploy only). ` +
      `incident #339 anchor.`,
  )
}

export function destructiveGateLogLine(): string {
  return process.env[DESTRUCTIVE_GATE_ENV] === '1'
    ? '[migrate] destructive migrations: ALLOWED (env)'
    : '[migrate] destructive migrations: BLOCKED (default, dev-bot safe)'
}
