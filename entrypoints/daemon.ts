#!/usr/bin/env bun
/**
 * Daemon entrypoint (legacy alias for main.ts).
 *
 * Phase C I5 unified all transport modes into server.ts. This entrypoint
 * is kept for backward compatibility with existing scripts (restart-bot.sh,
 * watchdog.sh) that may reference it. It simply loads server.ts, which
 * runs the unified flow unconditionally.
 *
 * Prefer `entrypoints/main.ts` for new deployments.
 *
 * Usage:
 *   bun entrypoints/daemon.ts
 */
import '../server'
