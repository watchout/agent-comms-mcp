#!/usr/bin/env bun
/**
 * agent-comms-mcp start — load .env and start the unified server
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const envPath = join(process.cwd(), '.env')
if (!existsSync(envPath)) {
  console.error('No .env found. Run `agent-comms-mcp init` first.')
  process.exit(1)
}

// Bun auto-loads .env from cwd
await import('../server')
