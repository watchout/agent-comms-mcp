#!/usr/bin/env bun
/**
 * Phase 1 #410 smoke diagnostic.
 *
 * Wrapper around `agent-com diagnose-delivery` so operators have a stable,
 * script-driven path for both bot-to-bot receive gaps and chat projection gaps.
 */
process.argv = [process.argv[0] ?? 'bun', 'cli/index.ts', 'diagnose-delivery', ...process.argv.slice(2)]
await import('../cli/index')
