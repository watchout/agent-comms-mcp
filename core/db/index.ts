export type { DbAdapter, LegacyDbAdapter } from './adapter'
export { toLegacy } from './adapter'
export { PgAdapter } from './pg-adapter'
export { SqliteAdapter } from './sqlite-adapter'

import { PgAdapter } from './pg-adapter'
import { SqliteAdapter } from './sqlite-adapter'
import type { DbAdapter } from './adapter'

export function createDbAdapter(databaseUrl = process.env.DATABASE_URL): DbAdapter {
  const dbType = process.env.AGENT_COM_DB || (databaseUrl ? 'postgres' : 'sqlite')
  if (dbType === 'postgres' || dbType === 'postgresql') {
    return new PgAdapter(databaseUrl)
  }
  return new SqliteAdapter()
}
