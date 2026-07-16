export interface DbClaimCapabilities {
  /** Production-safe arbitration for concurrent workers. */
  productionMultiWorker: boolean
  /** Candidate rows can be locked without waiting on another worker. */
  skipLocked: boolean
  /** Lease timestamps are allocated and compared by the database clock. */
  transactionLeaseClock: boolean
}

export interface DbAdapter {
  /** SQL dialect hint for dialect-sensitive readers (e.g. json extraction). */
  dialect?: 'sqlite' | 'postgres'
  /** Explicit claim capability fence; absence is treated as unsupported. */
  claimCapabilities?: DbClaimCapabilities
  query<T = any>(sql: string, params?: any[]): Promise<T[]>
  queryOne<T = any>(sql: string, params?: any[]): Promise<T | null>
  execute(sql: string, params?: any[]): Promise<{ rowCount: number }>
  transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T>
  listen?(channel: string, callback: (payload: string) => void): Promise<void>
  notify?(channel: string, payload: string): Promise<void>
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
