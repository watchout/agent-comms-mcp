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

// Max prefix length we ever emit in the legacy (no-mentions) path:
// `(99/99) ` = 8 chars. Reserve 10 for safety.
const PREFIX_BUDGET = 10

// Continuation-marker overhead reserve for the new (with-mentions) path.
// Markers in use: `(N/M)` (Part 1), `(N/M ↳ 続き)` (middle), `(N/M ↳ 続き、最後)` (last).
// `(99/99 ↳ 続き、最後)` is the longest, ~16 codepoints. Reserve 20 for safety.
const CONTINUATION_MARKER_BUDGET = 20

/**
 * Split `content` into an ordered list of parts, each ≤ platform limit.
 *
 * Contract:
 *  - If content (in codepoints) ≤ limit, returns `[content]` as-is (no prefix).
 *  - Otherwise, returns `N` parts. Format depends on whether `mentions` is set.
 *
 *  Legacy path (no `mentions` arg, or empty array):
 *    - Each part prefixed with `(i/N) `.
 *
 *  Mentions path (CEO directive 2026-04-09, ARC Option B + subject_line rule):
 *    - Each part prefixed with `${mention_block} ${marker}` where:
 *        - mention_block = `mentions.join(' ')` (caller pre-resolves to `<@DISCORD_ID>`)
 *        - marker = `(1/N)` for Part 1, `(N/M ↳ 続き)` for middle parts,
 *          `(M/M ↳ 続き、最後)` for the final part.
 *    - For Part 2..M, the subject_line of the original content is appended after
 *      the marker (so a reader who sees only one part still knows what topic).
 *    - Part 1 omits the subject_line because the original content's natural
 *      subject is the first line of the body.
 *    - The leading mention block is stripped from the input content before
 *      splitting, so the same mentions are not duplicated inside Part 1's body.
 *
 * Common to both paths:
 *  - Each returned part (prefix + body) fits within the platform limit (codepoints).
 *  - Splits prefer, in order: paragraph break (\n\n) → line break (\n) →
 *    Japanese sentence end (。！？) → Latin sentence end (. ! ?) →
 *    whitespace → hard codepoint boundary.
 *  - Trailing whitespace per part is stripped; leading whitespace on the next
 *    part is stripped.
 *  - Empty parts are never produced.
 *  - Content is never reflowed — only divided.
 *
 * @param content  Original message content (UTF-8, may include multi-byte)
 * @param platform Key into PLATFORM_LIMITS. Unknown → defaults to Discord.
 * @param mentions Optional array of pre-resolved Discord mention strings
 *                 (e.g. `["<@1485599598259994635>", "<@1227059781265653783>"]`).
 *                 When provided AND a split occurs, every part is prefixed with
 *                 the mention block + continuation marker + subject_line.
 *                 When omitted or empty, the legacy `(N/M) `-only path runs.
 */
export function splitMessage(
  content: string,
  platform: string = 'discord',
  mentions?: string[],
): string[] {
  const limit = PLATFORM_LIMITS[platform] ?? PLATFORM_LIMITS.discord
  const codepoints = Array.from(content)

  // Single-part: never modify the input. This holds for both paths and
  // preserves the original PR-B.2 message-split behavior for short messages.
  if (codepoints.length <= limit) {
    return [content]
  }

  const hasMentions = Array.isArray(mentions) && mentions.length > 0

  // ─── Legacy path: no mentions argument ─────────────────────────────────
  if (!hasMentions) {
    const budget = limit - PREFIX_BUDGET
    if (budget <= 0) {
      return hardChunk(codepoints, limit)
    }

    const parts: string[] = []
    let remaining = codepoints
    while (remaining.length > budget) {
      const splitAt = findBestSplit(remaining, budget)
      const head = trimEnd(remaining.slice(0, splitAt))
      if (head.length === 0) {
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

  // ─── Mentions path (CEO directive 2026-04-09 + ARC Option B) ───────────
  // Build the mention block and pre-strip any leading mentions from the
  // input content so the same mentions don't appear twice in Part 1.
  const mentionBlock = (mentions as string[]).join(' ')
  const mentionBlockLen = Array.from(mentionBlock).length
  const strippedContent = stripLeadingMentions(content)
  const strippedCp = Array.from(strippedContent)

  // Extract the subject line for Parts 2..M.
  const subjectLine = extractSubjectLine(strippedContent)
  const subjectLineLen = Array.from(subjectLine).length

  // Per-part overhead = mention_block + space + marker + (space + subject)? + newline
  // We use the worst-case overhead so the body never overflows the platform limit.
  const overhead =
    mentionBlockLen +
    1 + // space between mention block and marker
    CONTINUATION_MARKER_BUDGET +
    (subjectLineLen > 0 ? subjectLineLen + 1 : 0) + // space + subject (Part 2..M only — worst case)
    1 // newline between header and body
  const budget = limit - overhead
  if (budget <= 0) {
    // Pathological case: mention block + subject + marker already exceeds the
    // platform limit. Fall back to the legacy path so we still produce
    // something rather than hanging.
    return splitMessage(content, platform)
  }

  // Iteratively peel off body parts from the (mention-stripped) content.
  const bodies: string[] = []
  let remaining = strippedCp
  while (remaining.length > budget) {
    const splitAt = findBestSplit(remaining, budget)
    const head = trimEnd(remaining.slice(0, splitAt))
    if (head.length === 0) {
      bodies.push(remaining.slice(0, 1).join(''))
      remaining = dropLeadingWhitespace(remaining.slice(1))
      continue
    }
    bodies.push(head.join(''))
    remaining = dropLeadingWhitespace(remaining.slice(splitAt))
  }
  if (remaining.length > 0) {
    bodies.push(remaining.join(''))
  }

  const total = bodies.length
  return bodies.map((body, i) => {
    const partNum = i + 1
    let marker: string
    if (i === 0) {
      marker = `(${partNum}/${total})`
    } else if (i === total - 1) {
      marker = `(${partNum}/${total} ↳ 続き、最後)`
    } else {
      marker = `(${partNum}/${total} ↳ 続き)`
    }

    if (i === 0) {
      // Part 1 — mention_block + marker + body. The body still starts with
      // the original content's subject (since we stripped only the mentions),
      // so there's no need for an extra subject_line on Part 1.
      return `${mentionBlock} ${marker}\n${body}`
    }
    // Part 2..M — mention_block + marker + subject_line + body, so a reader
    // who only sees this single part still knows what topic it continues.
    if (subjectLine.length === 0) {
      return `${mentionBlock} ${marker}\n${body}`
    }
    return `${mentionBlock} ${marker} ${subjectLine}\n${body}`
  })
}

/**
 * Strip a leading run of `<@DISCORD_ID>` mention tokens (and the whitespace
 * between/after them) from the start of `content`. Mention tokens elsewhere
 * in the body are preserved.
 *
 * Used in the mentions-aware split path to avoid duplicating the mention
 * block on Part 1 when the caller's content already starts with the same
 * mentions that they passed via the `mentions` argument.
 */
function stripLeadingMentions(content: string): string {
  return content.replace(/^(?:<@\d{17,}>\s*)+/, '')
}

/**
 * Extract a subject line from the (already mention-stripped) content per
 * the ARC Option B rules from the splitMessage delegation file:
 *
 *   1. Take everything up to the first newline (or the entire string if no
 *      newline exists).
 *   2. Strip a leading markdown header marker (`#`, `##`, `###` etc.) +
 *      the following whitespace.
 *   3. If longer than 80 codepoints, slice to 80 and append `…`.
 *
 * Returns an empty string when the input has no usable subject (i.e. it
 * begins with a newline). Callers must handle the empty case.
 */
function extractSubjectLine(strippedContent: string): string {
  const firstNl = strippedContent.indexOf('\n')
  let raw = firstNl >= 0 ? strippedContent.slice(0, firstNl) : strippedContent
  raw = raw.replace(/^#{1,6}\s+/, '').trim()
  if (raw.length === 0) return ''
  const cp = Array.from(raw)
  if (cp.length > 80) {
    return cp.slice(0, 80).join('') + '…'
  }
  return raw
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
