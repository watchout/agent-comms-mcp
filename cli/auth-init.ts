#!/usr/bin/env bun
/**
 * Generate shared secret for bot-to-bot HMAC authentication.
 * Usage: bun agent-com auth init
 *
 * Creates ~/.agent-com/secret (32 bytes random, hex-encoded).
 * All bots in the same organization share this secret.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const secretDir = join(homedir(), '.agent-com')
const secretPath = join(secretDir, 'secret')

if (existsSync(secretPath)) {
  console.log(`Secret already exists at ${secretPath}`)
  console.log('To regenerate, delete the file first:')
  console.log(`  rm ${secretPath}`)
  process.exit(1)
}

mkdirSync(secretDir, { recursive: true, mode: 0o700 })
const secret = randomBytes(32).toString('hex')
writeFileSync(secretPath, secret, { mode: 0o600 })

console.log(`Secret generated at ${secretPath}`)
console.log('Share this file (or set AGENT_COMMS_SECRET env var) with all bots in your organization.')
