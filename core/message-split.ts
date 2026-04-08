/**
 * Platform-aware message splitter.
 *
 * CEO 指摘 (2026-04-08 × 3): Discord 2000-char hard limit truncates long bot
 * replies. LLM-side self-split is unreliable — enforce in code.
 *
 * Pure, dependency-free, codepoint-safe (Japanese multi-byte safe).
 *
 * Usage:
 *   import { splitMessage, PLATFORM_LIMITS } from './core/message-split'
 *   const parts = splitMessage(longContent, 'discord')
 *   // parts: [(1/3) ..., (2/3) ..., (3/3) ...]
 */

// Per-platform hard message limit in codepoints.
// Values are the "safe" bound — i.e., the limit we'll split to — not the raw
// platform maximum. Discord is hard 2000, we split at 1900 so the (N/M) prefix
// and any adapter additions still fit. Telegram 4096 → 4000. Slack 3000 → 3000.
export const PLATFORM_LIMITS: Record<string, number> = {
  discord: 1900,
  telegram: 4000,
  slack: 3000,
}

// Max prefix length we ever emit: `(99/99) ` = 8 chars. Reserve 10 for safety.
const PREFIX_BUDGET = 10

/**
 * Split `content` into an ordered list of parts, each ≤ platform limit.
 *
 * Contract:
 *  - If content (in codepoints) ≤ limit, returns `[content]` as-is (no prefix).
 *  - Otherwise, returns `N` parts, each prefixed with `(i/N) `.
 *  - Each returned part (prefix + body) fits within the platform limit.
 *  - Splits prefer, in order: paragraph break (\n\n) → line break (\n) →
 *    Japanese sentence end (。！？) → Latin sentence end (. ! ?) →
 *    whitespace → hard codepoint boundary.
 *  - Trailing whitespace on each part is stripped; leading whitespace on the
 *    next part is stripped (avoids leading spaces/newlines after a split).
 *  - Content is never reflowed — only divided.
 *  - Empty parts are never produced.
 *
 * @param content  Original message content (UTF-8, may include multi-byte)
 * @param platform Key into PLATFORM_LIMITS. Unknown → defaults to Discord.
 */
export function splitMessage(content: string, platform: string = 'discord'): string[] {
  const limit = PLATFORM_LIMITS[platform] ?? PLATFORM_LIMITS.discord
  const codepoints = Array.from(content)

  if (codepoints.length <= limit) {
    return [content]
  }

  // Budget for one part's body (before the prefix is added).
  const budget = limit - PREFIX_BUDGET
  if (budget <= 0) {
    // Pathological platform limit — fall back to raw chunking.
    return hardChunk(codepoints, limit)
  }

  // Iteratively peel off parts from the front until remaining fits.
  const parts: string[] = []
  let remaining = codepoints

  while (remaining.length > budget) {
    const splitAt = findBestSplit(remaining, budget)
    const head = trimEnd(remaining.slice(0, splitAt))
    if (head.length === 0) {
      // Avoid infinite loop on pathological inputs (e.g. budget=1 all spaces):
      // take one codepoint and move on.
      parts.push(remaining.slice(0, 1).join(''))
      remaining = dropLeadingWhitespace(remaining.slice(1))
      continue
    }
    parts.push(head.join(''))
    remaining = dropLeadingWhitespace(remaining.slice(splitAt))
  }

  if (remaining.length > 0) {
    parts.push(remaining.join(''))
  }

  const total = parts.length
  return parts.map((p, i) => `(${i + 1}/${total}) ${p}`)
}

/**
 * Choose a split index `k ∈ [1, maxIdx]` such that `codepoints[0..k)` ends at
 * the most semantically graceful boundary we can find within the window.
 *
 * Returns a count, not a position — the caller slices `[0..k)`.
 *
 * Search window look-back: up to 500 codepoints back from `maxIdx`. This keeps
 * us from collapsing multiple paragraphs into one tiny part while still
 * allowing a hard boundary on very dense text.
 */
function findBestSplit(codepoints: string[], maxIdx: number): number {
  const lookback = Math.min(500, maxIdx)
  const lower = maxIdx - lookback

  // 1. Paragraph break: two consecutive newlines. Split AFTER the second.
  for (let i = maxIdx; i > lower; i--) {
    if (i < codepoints.length && codepoints[i] === '\n' && i > 0 && codepoints[i - 1] === '\n') {
      return i + 1
    }
  }

  // 2. Single newline. Split AFTER the newline so the current part ends with
  //    the complete line.
  for (let i = maxIdx; i > lower; i--) {
    if (i < codepoints.length && codepoints[i] === '\n') {
      return i + 1
    }
  }

  // 3. Japanese sentence terminator (。！？). Split AFTER the terminator.
  for (let i = maxIdx; i > lower; i--) {
    const c = codepoints[i]
    if (c === '。' || c === '！' || c === '？') {
      return i + 1
    }
  }

  // 4. Latin sentence terminator followed by whitespace/newline/EOF. Avoids
  //    splitting "v1.2.3" or URLs mid-token.
  for (let i = maxIdx; i > lower; i--) {
    const c = codepoints[i]
    if (c === '.' || c === '!' || c === '?') {
      const next = codepoints[i + 1]
      if (next === undefined || next === ' ' || next === '\n' || next === '\t') {
        return i + 1
      }
    }
  }

  // 5. Plain whitespace (space / tab).
  for (let i = maxIdx; i > lower; i--) {
    const c = codepoints[i]
    if (c === ' ' || c === '\t') {
      return i + 1
    }
  }

  // 6. Fallback: hard cut at maxIdx so we make forward progress even on
  //    delimiter-free text (e.g. base64 blob, CJK without punctuation).
  return maxIdx
}

/**
 * Strip trailing whitespace codepoints (space, tab, newline) from a slice.
 */
function trimEnd(slice: string[]): string[] {
  let end = slice.length
  while (end > 0) {
    const c = slice[end - 1]
    if (c === ' ' || c === '\t' || c === '\n') {
      end--
    } else {
      break
    }
  }
  return slice.slice(0, end)
}

/**
 * Skip leading whitespace on the next segment so split points don't leak a
 * space/newline onto the next part's prefix.
 */
function dropLeadingWhitespace(slice: string[]): string[] {
  let start = 0
  while (start < slice.length) {
    const c = slice[start]
    if (c === ' ' || c === '\t' || c === '\n') {
      start++
    } else {
      break
    }
  }
  return slice.slice(start)
}

/**
 * Last-resort chunker for pathological platform limits (limit ≤ PREFIX_BUDGET).
 * Produces parts by raw codepoint count with no semantic preference. Kept in a
 * separate function so the main path stays linear and readable.
 */
function hardChunk(codepoints: string[], limit: number): string[] {
  const parts: string[] = []
  let i = 0
  while (i < codepoints.length) {
    parts.push(codepoints.slice(i, i + limit).join(''))
    i += limit
  }
  return parts
}
