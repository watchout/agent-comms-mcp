/**
 * Phase 5 §1.7 Port C — OutboundPolicyValidator.
 *
 * Responsibility: enforce DB `channels.members` for every sender/recipient.
 *
 * #917 Phase 1: `channel_routing_policy.outbound_allowlist` remains readable
 * compatibility data, but it has zero authorization effect.
 *
 * §1.4: server-side enforcement is canonical; client-side warning is
 * best-effort (UX only, not a gate). In production, missing DB policy becomes
 * empty membership so routing fails closed instead of reading static config.
 */
import { getChannelPolicy, type AgentId } from '../../channel-policy'
import { evaluateCommunicationAuthority } from '../../communication-authority'

export interface OutboundPolicyValidator {
  /**
   * Validates that `sender` may post to `channel_id` with the given recipients.
   * Returns `{ ok: true }` on pass, `{ ok: false, violations: AgentId[] }` on
   * reject — `violations` lists the sender or recipients (in `[sender, ...recipients]`
   * order) that are absent from channel membership.
   */
  validate(sender: AgentId, channel_id: string, recipients: AgentId[]):
    | { ok: true }
    | { ok: false, violations: AgentId[] }
}

export function createOutboundPolicyValidator(): OutboundPolicyValidator {
  return {
    validate(sender, channel_id, recipients) {
      const verdict = evaluateCommunicationAuthority({
        sender,
        recipients,
        members: getChannelPolicy(channel_id).members,
      })
      if (!verdict.ok) return { ok: false, violations: verdict.violations }
      return { ok: true }
    },
  }
}
