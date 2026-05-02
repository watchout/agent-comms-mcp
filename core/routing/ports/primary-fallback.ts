/**
 * Phase 5 §1.7 Port B — PrimaryFallback.
 *
 * Responsibility: given a `channel_id`, return the configured primary
 * recipient (`channel.primary` from bot-routing.json) or null if absent.
 *
 * §2.3: when `routeInbound` receives no `mention`, fall back to primary.
 * If neither mention nor primary is available, the message is skipped with
 * a warning log (§4.5 ARC §3.5: alert + skip, not enqueue).
 */
import { getChannelPolicy, type AgentId } from '../../channel-policy'

export interface PrimaryFallback {
  lookup(channel_id: string): AgentId | null
}

export function createPrimaryFallback(): PrimaryFallback {
  return {
    lookup(channel_id: string): AgentId | null {
      return getChannelPolicy(channel_id).primary
    },
  }
}
