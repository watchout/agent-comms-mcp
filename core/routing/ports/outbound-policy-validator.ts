/**
 * Phase 5 §1.7 Port C — OutboundPolicyValidator.
 *
 * Responsibility: enforce `channel.outboundAllowlist` on the SENDER side.
 *
 * §2.4 (AMEND-2 reject 一本化):
 *   - send で `mention` / `cc` のいずれかが allowlist 違反 →
 *     server-side reject with `OUTBOUND_ACL_VIOLATION`.
 *   - cc[] strip is a separate concern (legacy v1 §4.5) and is REMOVED.
 *   - allowlist 不在 channel (entry 自体無し) → 全 sender 許可 (legacy compat).
 *
 * §1.4: server-side enforcement is canonical; client-side warning is
 * best-effort (UX only, not a gate). In production, missing DB policy becomes
 * an empty allowlist so routing fails closed instead of reading static config.
 */
import { getChannelPolicy, type AgentId } from '../../channel-policy'

export interface OutboundPolicyValidator {
  /**
   * Validates that `sender` may post to `channel_id` with the given recipients.
   * Returns `{ ok: true }` on pass, `{ ok: false, violations: AgentId[] }` on
   * reject — `violations` lists the sender or recipients (in `[sender, ...recipients]`
   * order) that fail the allowlist.
   */
  validate(sender: AgentId, channel_id: string, recipients: AgentId[]):
    | { ok: true }
    | { ok: false, violations: AgentId[] }
}

export function createOutboundPolicyValidator(): OutboundPolicyValidator {
  return {
    validate(sender, channel_id, recipients) {
      const policy = getChannelPolicy(channel_id)
      // §2.4 — explicit compatibility entries with no allowlist allow all.
      // Missing production DB policy resolves to [] and rejects all.
      if (policy.outboundAllowlist === null) return { ok: true }
      const allow = new Set(policy.outboundAllowlist)
      const violations: AgentId[] = []
      if (!allow.has(sender)) violations.push(sender)
      for (const r of recipients) {
        if (!allow.has(r)) violations.push(r)
      }
      if (violations.length > 0) return { ok: false, violations }
      return { ok: true }
    },
  }
}
