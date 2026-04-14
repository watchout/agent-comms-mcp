#!/usr/bin/env bun
/**
 * Daemon entrypoint — daemon-owns-outbound (FEAT-005, SSOT §1 line 39).
 *
 * A single process running this entrypoint owns the outbound_queue
 * consumer for its AGENT_ID. stdio / MCP-plugin processes run
 * server.ts directly and intentionally do NOT bootstrap the consumer,
 * which is how we stopped the 19-bot parallel-consumer race that
 * caused the 2026-04-12 identity-misattribution incident and the
 * 2026-04-13 drain stall.
 *
 * 2026-04-14 phasing note (CEO directive Task 1, post-PR-#172 hotfix):
 * current production launch path is `claude server:agent-comms` →
 * server.ts (stdio MCP) with AGENT_COM_RUNTIME=daemon set in the
 * shell. This entrypoint is not yet wrapped by a supervise layer, so
 * until that ships, server.ts ALSO bootstraps the consumer — gated on
 * isDaemonRuntime() and placed after `discordClients.set(AGENT_ID,
 * discord)` so the first tick can resolve a client. This entrypoint
 * remains the canonical single call site; server.ts is the phasing
 * revival path and will be removed when the supervise base lands,
 * restoring the daemon-only invariant described above.
 *
 * Responsibilities added on top of loading server.ts:
 *   1. Start the outbound consumer tick + orphan-reclaim tick
 *      exactly once. The consumer's own `isDaemonRuntime()` gate
 *      stays in place as belt-and-braces; the single call site here
 *      is the primary gate.
 *   2. Rely on server.ts to register the agent, wire the Discord
 *      client (stdio self-register into discordClients), start the
 *      pg_notify listener + polling, and bring the MCP transport
 *      up. Nothing else needs daemon-specific branching.
 *
 * Usage:
 *   AGENT_COM_RUNTIME=daemon bun entrypoints/daemon.ts
 *
 * Spec refs:
 *   - docs/agent-com-message-queue-spec.md §1 line 39 (daemon owns
 *     PollingDriver + outbound_queue consumption)
 *   - docs/plans/outbound-forwarder-unification.md v5 §3
 *   - tests/spec-enforcement/adapter-rewrite-feat-005.test.ts #3
 *     (pins exactly-one call + the runtime gate)
 */
import '../server'
import { startOutboundConsumer } from '../adapters/outbound-consumer'

startOutboundConsumer()
