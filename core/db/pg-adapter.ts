import { Client, type ClientConfig } from 'pg'
import type { DbAdapter } from './adapter'

export class PgAdapter implements DbAdapter {
  private client: Client
  private connected = false

  constructor(configOrUrl?: string | ClientConfig) {
    const config = typeof configOrUrl === 'string'
      ? { connectionString: configOrUrl }
      : configOrUrl ?? { connectionString: process.env.DATABASE_URL }
    this.client = new Client(config)
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.client.connect()
      this.connected = true
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    await this.ensureConnected()
    const result = await this.client.query(sql, params)
    return result.rows as T[]
  }

  async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async execute(sql: string, params?: any[]): Promise<{ rowCount: number }> {
    await this.ensureConnected()
    const result = await this.client.query(sql, params)
    return { rowCount: result.rowCount ?? 0 }
  }

  async transaction<T>(fn: (tx: DbAdapter) => Promise<T>): Promise<T> {
    await this.ensureConnected()
    await this.client.query('BEGIN')
    try {
      const result = await fn(this)
      await this.client.query('COMMIT')
      return result
    } catch (err) {
      await this.client.query('ROLLBACK')
      throw err
    }
  }

  async listen(channel: string, callback: (payload: string) => void): Promise<void> {
    await this.ensureConnected()
    this.client.on('notification', (msg) => {
      if (msg.channel === channel && msg.payload) {
        callback(msg.payload)
      }
    })
    await this.client.query(`LISTEN ${channel}`)
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.ensureConnected()
    await this.client.query(`SELECT pg_notify($1, $2)`, [channel, payload])
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.end()
      this.connected = false
    }
  }
}
