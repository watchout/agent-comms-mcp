#!/usr/bin/env bun
/**
 * Check Discord plugin for correct bot filter pattern.
 * Usage: bun agent-com check-plugin
 *
 * Verifies that the Discord channel plugin uses:
 *   msg.author.id === client.user?.id  (correct — only skip own messages)
 * instead of:
 *   msg.author.bot  (wrong — skips all bot messages including other agents)
 *
 * Approach: Read the installed Discord plugin source and check via regex.
 * This is a diagnostic tool, not a runtime patch — agent-com is an MCP server
 * and cannot modify the marketplace Discord plugin at runtime.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Common locations for the Discord channel plugin
const STATIC_PATHS = [
  join(homedir(), '.claude', 'plugins', 'discord', 'server.ts'),
  join(homedir(), '.claude', 'plugins', 'discord', 'server.js'),
  join(homedir(), '.claude', 'channels', 'discord', 'server.ts'),
  join(homedir(), '.claude', 'channels', 'discord', 'server.js'),
]

// Marketplace cache: ~/.claude/plugins/cache/claude-plugins-official/discord/*/server.ts
function findMarketplacePaths(): string[] {
  const cacheDir = join(homedir(), '.claude', 'plugins', 'cache', 'claude-plugins-official', 'discord')
  if (!existsSync(cacheDir)) return []
  try {
    return readdirSync(cacheDir)
      .map(ver => join(cacheDir, ver, 'server.ts'))
      .filter(p => existsSync(p))
  } catch {
    return []
  }
}

const PLUGIN_PATHS = [...STATIC_PATHS, ...findMarketplacePaths()]

const CORRECT_PATTERN = /msg\.author\.id\s*===\s*client\.user\?\.id/
const WRONG_PATTERN = /msg\.author\.bot/

let found = false
let hasError = false

for (const p of PLUGIN_PATHS) {
  if (!existsSync(p)) continue
  found = true
  const source = readFileSync(p, 'utf-8')

  console.log(`Checking: ${p}`)

  if (WRONG_PATTERN.test(source)) {
    console.log('  ❌ WRONG: Uses msg.author.bot — this filters ALL bots including agents')
    console.log('  Fix: Replace with msg.author.id === client.user?.id')
    hasError = true
  } else if (CORRECT_PATTERN.test(source)) {
    console.log('  ✅ CORRECT: Uses msg.author.id === client.user?.id')
  } else {
    console.log('  ⚠️  Could not detect bot filter pattern. Manual review recommended.')
  }
}

if (!found) {
  console.log('No Discord plugin found at known paths.')
  console.log('Checked:', PLUGIN_PATHS.join('\n  '))
}

if (hasError) process.exit(1)
