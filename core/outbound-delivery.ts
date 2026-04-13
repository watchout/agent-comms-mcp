/**
 * core/outbound-delivery.ts — pure classifiers for outbound_queue consumer.
 *
 * Phase C Step 1 PR-A cycle 2 (PR #168) extracted these helpers so the
 * consumer's idempotency decision can be unit-tested without a live
 * Discord client or Postgres. The consumer in server.ts imports both
 * helpers; test coverage lives in tests/outbound-delivery.test.ts.
 *
 * Contract:
 *   - `isDuplicateNonceError(err)` returns true for the two shapes Discord
 *     surfaces when a retry collides with enforceNonce inside the ~5 min
 *     dedup window: a DiscordAPIError with numeric code 40062, or a plain
 *     Error whose message carries "40062" / "using that nonce" / "nonce …
 *     already" etc.
 *   - The classifier is **conservative**: any ambiguity falls through as
 *     "not a duplicate-nonce", preserving the existing transient / permanent
 *     classification. False positives (mark sent when Discord did not
 *     accept) are worse than false negatives (retry and eventually fail
 *     permanently) because the former produces silent message loss.
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §7.4 (outbound consumer)
 *   - docs/design/core/SSOT-5_CROSS_CUTTING.md §1 adapter nonce contract
 */

const DISCORD_DUPLICATE_NONCE_CODE = 40062

/** Extract the numeric Discord error code from an unknown thrown value. */
function extractDiscordErrorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { code?: unknown; rawError?: { code?: unknown } }
  if (typeof e.code === 'number') return e.code
  if (typeof e.rawError?.code === 'number') return e.rawError.code
  return null
}

/**
 * Identify the "Discord rejected a retry because the nonce matches a
 * recently-sent message" case. Consumer treats this as idempotent success.
 */
export function isDuplicateNonceError(err: unknown, message?: string): boolean {
  if (extractDiscordErrorCode(err) === DISCORD_DUPLICATE_NONCE_CODE) return true
  const text = message ?? (err instanceof Error ? err.message : String(err ?? ''))
  if (!text) return false
  if (text.includes(String(DISCORD_DUPLICATE_NONCE_CODE))) return true
  if (/using that nonce/i.test(text)) return true
  if (/nonce.*(already|duplicat)/i.test(text)) return true
  return false
}
