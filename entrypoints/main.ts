#!/usr/bin/env bun
/**
 * Unified entry point (Phase C I5 + I6).
 *
 * Subcommands:
 *   init    — interactive setup wizard (.env + DB)
 *   start   — load .env and start the unified server
 *   status  — query the health endpoint
 *   (none)  — auto-detect: .env exists → start, else → init
 *
 * Usage:
 *   npx agent-comms-mcp          # auto-detect
 *   npx agent-comms-mcp init     # interactive setup
 *   npx agent-comms-mcp start    # start daemon + MCP
 *   npx agent-comms-mcp status   # health check
 */

const arg = process.argv[2]

if (arg === 'init') {
  await import('../cli/init')
} else if (arg === 'start') {
  await import('../cli/start')
} else if (arg === 'status') {
  // Quick status check via health endpoint
  const port = process.env.WEBHOOK_PORT || process.env.AGENT_COMMS_PORT || '8795'
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    const data = await res.json()
    console.log(JSON.stringify(data, null, 2))
  } catch {
    console.log('Not running')
  }
} else {
  // Auto-detect: .env exists → start, else → init
  const { existsSync } = await import('node:fs')
  if (existsSync('.env')) {
    await import('../cli/start')
  } else {
    console.log('No .env found — starting interactive setup...\n')
    await import('../cli/init')
  }
}
