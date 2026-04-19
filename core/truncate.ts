/**
 * Discord message length cap (spec §5.3 エラーハンドリング, v2.1.0).
 *
 * Discord's hard limit is 2000 characters; we clamp at 1900 to leave headroom
 * for mentions, reply markers, or server-side reformatting that Discord may
 * inject. The 20-char `... [truncated]` suffix fits inside the 100-char buffer.
 */
export const DISCORD_MAX = 1900
const TRUNCATED_SUFFIX = '... [truncated]'

/**
 * Truncate a message to fit within Discord's character cap.
 *
 * JavaScript `String.prototype.slice` is multibyte-safe (it indexes by UTF-16
 * code unit, not raw byte), matching the existing Discord adapter's
 * Array.from-based clamp on the outbound path (discord-adapter.ts). Under the
 * cap this is an identity function.
 */
export function truncateForDiscord(content: string): string {
  if (content.length <= DISCORD_MAX) return content
  return content.slice(0, DISCORD_MAX - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
}
