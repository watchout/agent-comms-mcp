import { existsSync } from 'node:fs'
import { PgAdapter, SqliteAdapter, type DbAdapter } from '../../core/db'
import {
  buildAunConnectorCredentialDiagnostic,
  type AunConnectorCredentialDiagnostic,
} from '../../core/aun-connector-credential-diagnostic'
import {
  buildAunConnectorProviderIdentityVerify,
  type AunConnectorProviderIdentityVerify,
} from '../../core/aun-connector-provider-identity-verify'

export interface ConnectorCredentialDiagnosticCliOptions {
  format?: 'json'
  agentId?: string
  provider?: string
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export interface ConnectorCredentialDiagnosticCliResult {
  ok: boolean
  code: number
  result: AunConnectorCredentialDiagnostic | {
    error: 'invalid_arguments' | 'db_unreachable'
    message: string
  }
}

export interface ConnectorProviderIdentityVerifyCliOptions {
  format?: 'json'
  agentId?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  now?: () => Date
}

export interface ConnectorProviderIdentityVerifyCliResult {
  ok: boolean
  code: number
  result: AunConnectorProviderIdentityVerify | {
    error: 'invalid_arguments' | 'db_unreachable'
    message: string
  }
}

const MUTATION_SQL = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|CALL|DO)\b/i

function createReadOnlyDbAdapter(env: NodeJS.ProcessEnv): DbAdapter {
  const dbType = env.AGENT_COM_DB || (env.DATABASE_URL ? 'postgres' : 'sqlite')
  if (dbType === 'postgres' || dbType === 'postgresql') {
    return new PgAdapter(env.DATABASE_URL)
  }
  const dbPath = env.AGENT_COM_SQLITE_PATH ?? './agent-com.db'
  if (!existsSync(dbPath)) {
    throw new Error(`sqlite database not found: ${dbPath}`)
  }
  return new SqliteAdapter(dbPath, { readonly: true, create: false })
}

function toGuardedReadOnlyDb(db: DbAdapter): DbAdapter {
  return {
    async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
      if (MUTATION_SQL.test(sql)) {
        throw new Error(`connector credential diagnostic attempted non-read SQL: ${sql.trim().slice(0, 80)}`)
      }
      return db.query<T>(sql, params)
    },
    async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
      const rows = await this.query<T>(sql, params)
      return rows[0] ?? null
    },
    async execute(): Promise<{ rowCount: number }> {
      throw new Error('connector credential diagnostic is read-only')
    },
    async transaction<T>(): Promise<T> {
      throw new Error('connector credential diagnostic is read-only')
    },
    async close(): Promise<void> {
      return db.close()
    },
  }
}

export async function connectorCredentialDiagnostic(
  opts: ConnectorCredentialDiagnosticCliOptions = {},
): Promise<ConnectorCredentialDiagnosticCliResult> {
  const env = opts.env ?? process.env
  const provider = opts.provider?.trim() || undefined
  if (opts.format !== 'json') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun connector credential-diagnostic requires --json',
      },
    }
  }
  if (provider !== undefined && provider !== 'discord') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun connector credential-diagnostic currently supports --provider discord only',
      },
    }
  }

  let db: DbAdapter
  try {
    db = createReadOnlyDbAdapter(env)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: {
        error: 'db_unreachable',
        message: (err as Error).message ?? String(err),
      },
    }
  }

  const guarded = toGuardedReadOnlyDb(db)
  try {
    const result = await buildAunConnectorCredentialDiagnostic(guarded, {
      agentId: opts.agentId,
      provider,
      now: opts.now,
    })
    return {
      ok: result.summary.blockers === 0,
      code: 0,
      result,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: {
        error: 'db_unreachable',
        message: (err as Error).message ?? String(err),
      },
    }
  } finally {
    await guarded.close()
  }
}

export async function connectorProviderIdentityVerify(
  opts: ConnectorProviderIdentityVerifyCliOptions = {},
): Promise<ConnectorProviderIdentityVerifyCliResult> {
  const env = opts.env ?? process.env
  const agentId = opts.agentId?.trim()
  if (opts.format !== 'json') {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun connector verify-discord-identity requires --json',
      },
    }
  }
  if (opts.dryRun !== true) {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun connector verify-discord-identity requires --dry-run',
      },
    }
  }
  if (!agentId) {
    return {
      ok: false,
      code: 2,
      result: {
        error: 'invalid_arguments',
        message: 'aun connector verify-discord-identity requires --agent-id <id>',
      },
    }
  }

  let db: DbAdapter
  try {
    db = createReadOnlyDbAdapter(env)
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: {
        error: 'db_unreachable',
        message: (err as Error).message ?? String(err),
      },
    }
  }

  const guarded = toGuardedReadOnlyDb(db)
  try {
    const result = await buildAunConnectorProviderIdentityVerify(guarded, {
      agentId,
      provider: 'discord',
      dryRun: true,
      now: opts.now,
    })
    return {
      ok: result.summary.blockers === 0,
      code: 0,
      result,
    }
  } catch (err) {
    return {
      ok: false,
      code: 1,
      result: {
        error: 'db_unreachable',
        message: (err as Error).message ?? String(err),
      },
    }
  } finally {
    await guarded.close()
  }
}
