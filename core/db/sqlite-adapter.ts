import { Database } from 'bun:sqlite'
import type { DbAdapter } from './adapter'

const PG_PARAM_RE = /\$(\d+)/g

function pgToSqliteParams(sql: string): string {
  return sql.replace(PG_PARAM_RE, '?')
}

function adaptSql(sql: string): string {
  let s = pgToSqliteParams(sql)
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')")
  s = s.replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
  s = s.replace(/\bJSONB\b/gi, 'TEXT')
  s = s.replace(/\bBIGSERIAL\b/gi, 'INTEGER')
  s = s.replace(/\bSERIAL\b/gi, 'INTEGER')
  s = s.replace(/\bBOOLEAN\b/gi, 'INTEGER')
  s = s.replace(/\bDEFAULT\s+(true)\b/gi, 'DEFAULT 1')
  s = s.replace(/\bDEFAULT\s+(false)\b/gi, 'DEFAULT 0')
  s = s.replace(/\bFOR\s+UPDATE\s+SKIP\s+LOCKED\b/gi, '')
  s = s.replace(/->>'\s*(\w+)'\s*/g, (_, key) => `json_extract($&, '$.${key}') `)
  // Fix json_extract: metadata->>'to' → json_extract(metadata, '$.to')
  s = s.replace(/(\w+)->>'\s*(\w+)'/g, (_, col, key) => `json_extract(${col}, '$.${key}')`)
  return s
}

export class SqliteAdapter implements DbAdapter {
  private db: Database

  constructor(path?: string) {
    const dbPath = path ?? process.env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const adapted = adaptSql(sql)
    const safeParams = (params ?? []).map(p =>
      p === true ? 1 : p === false ? 0 : p
    )
    try {
      return this.db.prepare(adapted).all(...safeParams) as T[]
    } catch (err: any) {
      if (err.message?.includes('not authorized') || err.message?.includes('LISTEN')) {
        return []
      }
      throw err
    }
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(sql: string, params?: any[]): Promise<{ rowCount: number }> {
    const adapted = adaptSql(sql)
    const safeParams = (params ?? []).map(p =>
      p === true ? 1 : p === false ? 0 : p
    )
    try {
      const stmt = this.db.prepare(adapted)
      const result = stmt.run(...safeParams)
      return { rowCount: result.changes }
    } catch (err: any) {
      if (err.message?.includes('not authorized') || err.message?.includes('LISTEN')) {
        return { rowCount: 0 }
      }
      throw err
    }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
