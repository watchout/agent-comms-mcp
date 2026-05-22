/**
 * Phase 5 — routing module entrypoint.
 *
 * Wires the 4 ports (§1.7) into a single `routeInbound` + outbound validate +
 * body decoration pipeline. Both server.ts (canonical enforcement) and
 * cli/index.ts (best-effort client warning) import from here so they share
 * exactly one expression of the routing contract (§1.8).
 */
export { createInboundResolver } from './ports/inbound-resolver'
export type {
  InboundResolver,
  InboundResolveInput,
  InboundResolveResult,
  InboundResolveOk,
  InboundResolveErr,
  InboundResolveError,
} from './ports/inbound-resolver'

export { createPrimaryFallback } from './ports/primary-fallback'
export type { PrimaryFallback } from './ports/primary-fallback'

export { createOutboundPolicyValidator } from './ports/outbound-policy-validator'
export type { OutboundPolicyValidator } from './ports/outbound-policy-validator'

export { createMessageBodyDecorator } from './ports/message-body-decorator'
export type { MessageBodyDecorator } from './ports/message-body-decorator'

export { getChannelPolicy, refreshChannelPolicyDbSnapshot, resetChannelPolicyCache } from '../channel-policy'
export type { AgentId, ChannelPolicyEntry } from '../channel-policy'
