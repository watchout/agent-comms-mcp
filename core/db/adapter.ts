export interface DbAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>
  execute(sql: string, params?: any[]): Promise<{ rowCount: number }>
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>
  listen?(channel: string, callback: (payload: string) => void): Promise<void>
  close(): Promise<void>
}

export interface LegacyDbAdapter {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>
}

export function toLegacy(adapter: DbAdapter): LegacyDbAdapter {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
      const rows = await adapter.query<T>(sql, params)
      return { rows }
    },
  }
}
