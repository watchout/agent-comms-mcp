import { Database } from 'bun:sqlite'
import type { DbAdapter } from './adapter'

function adaptSql(sql: string): string {
  let s = sql
  // ->> → json_extract (must run before $n replacement to avoid collision)
  s = s.replace(/(\w+)->>'\s*(\w+)'/g, (_, col, key) => `json_extract(${col}, '$.${key}')`)
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')")
  s = s.replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
  s = s.replace(/\bJSONB\b/gi, 'TEXT')
  s = s.replace(/\bBIGSERIAL\b/gi, 'INTEGER')
  s = s.replace(/\bSERIAL\b/gi, 'INTEGER')
  s = s.replace(/\bBOOLEAN\b/gi, 'INTEGER')
  s = s.replace(/\bDEFAULT\s+(true)\b/gi, 'DEFAULT 1')
  s = s.replace(/\bDEFAULT\s+(false)\b/gi, 'DEFAULT 0')
  // Covers FOR UPDATE [OF <table>] [SKIP LOCKED] — SQLite has no row locks.
  s = s.replace(/\bFOR\s+UPDATE(\s+OF\s+\w+)?(\s+SKIP\s+LOCKED)?\b/gi, '')
  // PostgreSQL INTERVAL literals — map to SQLite-compatible datetime modifier
  //   `NOW() - INTERVAL '15 minutes'` → `datetime('now', '-15 minutes')`
  //   must run after the NOW()→datetime('now') replacement above to catch
  //   the pattern pre-substitution as well.
  s = s.replace(/\bnow\(\)\s*-\s*INTERVAL\s+'(\d+)\s*(\w+)'/gi, (_m, n, unit) => `datetime('now', '-${n} ${unit}')`)
  s = s.replace(/datetime\('now'\)\s*-\s*INTERVAL\s+'(\d+)\s*(\w+)'/gi, (_m, n, unit) => `datetime('now', '-${n} ${unit}')`)
  // PostgreSQL type casts `expr::type` — SQLite ignores types for arithmetic
  // (all integer arithmetic returns INTEGER). Strip common numeric casts; the
  // caller inspects by shape (count/integer comparisons) so removing the cast
  // is harmless.
  s = s.replace(/::\s*(int|integer|bigint|smallint|text|float|numeric|decimal|boolean|bool|timestamptz|timestamp|date|uuid|jsonb)\b/gi, '')
  return s
}

function reorderParams(sql: string, params: any[]): { sql: string; params: any[] } {
  if (!/\$\d+/.test(sql)) return { sql, params }
  const indices: number[] = []
  const converted = sql.replace(/\$(\d+)/g, (_, n) => {
    indices.push(parseInt(n, 10) - 1)
    return '?'
  })
  return { sql: converted, params: indices.map(i => params[i]) }
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

  private prepare(sql: string, params?: any[]): { sql: string; params: any[] } {
    const adapted = adaptSql(sql)
    const rawParams = (params ?? []).map(p =>
      p === true ? 1 : p === false ? 0 : p
    )
    return reorderParams(adapted, rawParams)
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const p = this.prepare(sql, params)
    try {
      return this.db.prepare(p.sql).all(...p.params) as T[]
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
    const p = this.prepare(sql, params)
    try {
      const result = this.db.prepare(p.sql).run(...p.params)
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
