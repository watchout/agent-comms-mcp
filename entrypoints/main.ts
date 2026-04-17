#!/usr/bin/env bun
/**
 * Unified entry point (Phase C I5).
 *
 * All transport modes have been merged into server.ts. This single
 * entry point replaces the previous TRANSPORT_MODE branching
 * (stdio / daemon / sse / receiver).
 *
 * server.ts now unconditionally:
 *   1. Starts multi-bot SSE HTTP server (only if EXPECTED_BOTS or AGENT_COMMS_PORT is set)
 *   2. Starts polling, pg_notify listener, and Discord adapter
 *   3. Connects stdio MCP transport
 *
 * Usage:
 *   bun entrypoints/main.ts
 */
import '../server'
