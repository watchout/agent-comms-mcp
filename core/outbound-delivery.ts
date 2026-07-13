/**
 * core/outbound-delivery.ts — pure classifiers for outbound_queue consumer.
 *
 * Phase C Step 1 PR-A cycle 2 (PR #168) extracted these helpers so the
 * consumer's idempotency decision can be unit-tested without a live
 * Discord client or Postgres. The consumer in server.ts imports both
 * helpers; test coverage lives in tests/outbound-delivery.test.ts.
 *
 * Transport-Neutral Contract r1.1.4 correction:
 *   - numeric Discord code 40062 is service-resource rate limiting;
 *   - it is never prior-message evidence and never idempotent success;
 *   - only a returned, fully validated original receipt can converge a
 *     duplicate attempt to delivered.
 *
 * See:
 *   - docs/agent-com-message-queue-spec.md §7.4 (outbound consumer)
 *   - docs/design/core/SSOT-5_CROSS_CUTTING.md §1 adapter nonce contract
 */

const DISCORD_RESOURCE_RATE_LIMIT_CODE = 40062

/** Extract the numeric Discord error code from an unknown thrown value. */
function extractDiscordErrorCode(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { code?: unknown; rawError?: { code?: unknown } }
  if (typeof e.code === 'number') return e.code
  if (typeof e.rawError?.code === 'number') return e.rawError.code
  return null
}

/**
 * Retained compatibility export. No thrown error shape is delivery evidence.
 */
export function isDuplicateNonceError(_err: unknown, _message?: string): boolean {
  return false
}

/** Numeric 40062 is retry/rate-limit classification, not success truth. */
export function isDiscord40062RateLimit(err: unknown, message?: string): boolean {
  if (extractDiscordErrorCode(err) === DISCORD_RESOURCE_RATE_LIMIT_CODE) return true
  const text = message ?? (err instanceof Error ? err.message : String(err ?? ''))
  return text.includes(String(DISCORD_RESOURCE_RATE_LIMIT_CODE))
}
