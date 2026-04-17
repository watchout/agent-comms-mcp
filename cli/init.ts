#!/usr/bin/env bun
/**
 * agent-comms-mcp init — interactive setup wizard
 * Creates .env file + SQLite DB (if selected)
 */

import { createInterface } from 'node:readline'
import { existsSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string, defaultVal?: string): Promise<string> {
  return new Promise(resolve => {
    const suffix = defaultVal ? ` [${defaultVal}]` : ''
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '')
    })
  })
}

/**
 * Generate .env content from collected values.
 * Exported for testability.
 */
export function generateEnv(opts: {
  agentId: string
  discordToken: string
  dbType: 'sqlite' | 'postgres'
  databaseUrl?: string
  sqlitePath?: string
}): string {
  const lines: string[] = [
    `AGENT_ID=${opts.agentId}`,
    `DISCORD_TOKEN=${opts.discordToken}`,
    `AGENT_COM_DB=${opts.dbType}`,
    `AGENT_COM_SQLITE_PATH=${opts.sqlitePath ?? './agent-com.db'}`,
  ]
  if (opts.dbType === 'postgres' && opts.databaseUrl) {
    lines.push(`DATABASE_URL=${opts.databaseUrl}`)
  } else {
    lines.push(`# DATABASE_URL=postgresql://localhost/agent_comms`)
  }
  lines.push(
    `AGENT_COM_POLL_INTERVAL_MS=3000`,
    `AGENT_COM_REPLY_CHAIN_DEPTH=10`,
    '', // trailing newline
  )
  return lines.join('\n')
}

async function main() {
  const envPath = join(process.cwd(), '.env')

  // Step 1: Check for existing .env
  if (existsSync(envPath)) {
    const overwrite = await ask('.env already exists. Overwrite? (y/N)', 'N')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.')
      rl.close()
      return
    }
  }

  // Step 2: Discord bot token
  const discordToken = await ask('Discord bot token (required)')
  if (!discordToken) {
    console.error('Error: Discord bot token is required.')
    rl.close()
    process.exit(1)
  }

  // Step 3: Agent ID
  const defaultAgentId = basename(process.cwd())
  const agentId = await ask('Agent ID', defaultAgentId)

  // Step 4: DB type
  const dbType = await ask('DB type (sqlite/postgres)', 'sqlite')
  if (dbType !== 'sqlite' && dbType !== 'postgres') {
    console.error('Error: DB type must be "sqlite" or "postgres".')
    rl.close()
    process.exit(1)
  }

  // Step 5: If postgres, ask for DATABASE_URL
  let databaseUrl: string | undefined
  if (dbType === 'postgres') {
    databaseUrl = await ask('DATABASE_URL', 'postgresql://localhost/agent_comms')
  }

  rl.close()

  // Step 6: Generate .env
  const envContent = generateEnv({
    agentId,
    discordToken,
    dbType: dbType as 'sqlite' | 'postgres',
    databaseUrl,
  })
  writeFileSync(envPath, envContent, 'utf-8')
  console.log(`\n.env created at ${envPath}`)

  // Step 7: If sqlite, run migration
  if (dbType === 'sqlite') {
    const { migrateSqlite } = await import('../db/migrate-sqlite')
    migrateSqlite()
  }

  // Step 8: Success message
  console.log(`
Setup complete! Next steps:
  npx agent-comms-mcp start    # start the daemon + MCP server
  npx agent-comms-mcp status   # check health
`)
}

if (import.meta.main) {
  main()
}
