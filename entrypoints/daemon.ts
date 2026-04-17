#!/usr/bin/env bun
/**
 * Daemon entrypoint (FEAT-005, SSOT §1 line 39).
 *
 * Phase C I4 removed the dual embedded/standalone mode. Every process
 * is now daemon-mode; there is no `isDaemonRuntime()` gate. server.ts
 * unconditionally starts the outbound consumer after Discord connect,
 * so this entrypoint simply loads server.ts (which handles consumer
 * startup).
 *
 * Responsibilities (inherited from server.ts):
 *   1. Register the agent, wire the Discord client, start the
 *      pg_notify listener + polling, and bring the MCP transport up.
 *   2. Start the outbound consumer tick + orphan-reclaim tick
 *      (done inside server.ts after discordClients.set).
 *
 * Usage:
 *   bun entrypoints/daemon.ts
 *
 * Spec refs:
 *   - docs/agent-com-message-queue-spec.md §1 line 39
 *   - docs/plans/outbound-forwarder-unification.md v5 §3
 */
import '../server'
