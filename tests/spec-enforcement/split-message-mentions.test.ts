#!/usr/bin/env bun
/**
 * Spec-enforcement tests for splitMessage mention re-injection
 * + subject_line preservation (CEO directive 2026-04-09).
 *
 * Background:
 *   PR#98 shipped `core/message-split.ts` with a `(N/M) `-only prefix. Long
 *   bot replies were correctly split into multiple Discord messages, but the
 *   original `<@DISCORD_ID>` mention syntax only existed in the body of Part 1.
 *   Discord native push notifications fire only when the mention is present,
 *   so recipients on Part 2/3/N never saw the message in their notification
 *   tray and silently dropped half of every long reply.
 *
 *   CEO discovered this on 2026-04-09 when lead-ama (a brand-new sprint-lead
 *   bot) sent multi-part coordination messages and CEO only ever saw Part 1.
 *   CEO refined the requirement to also preserve a "subject line" header so
 *   each part can be read in isolation and still convey context.
 *
 * Fix shape (per ARC Option B + lead-ama delegation file):
 *   - splitMessage now takes a 3rd `mentions?: string[]` argument of pre-resolved
 *     `<@DISCORD_ID>` strings (caller-resolved via the existing D7 helper).
 *   - When set AND a split occurs, every part is prefixed with
 *     `${mention_block} ${marker}` where marker is one of:
 *       - `(1/M)` for Part 1
 *       - `(N/M ↳ 続き)` for Parts 2..M-1
 *       - `(M/M ↳ 続き、最後)` for the last part
 *   - For Parts 2..M, the original content's subject_line is appended after
 *     the marker so a reader who only sees one part still knows the topic.
 *   - The leading mention block is stripped from the input before splitting,
 *     so the Part 1 body is not double-mentioned.
 *
 * Each test below cites the regression class it guards. The tests MUST stay
 * green or the bug is back.
 *
 * See:
 *   - core/message-split.ts                                       (the fix)
 *   - server.ts send handler around the splitMessage call          (caller wiring)
 *   - tests/spec-enforcement/anti-regression-pr98.test.ts          (similar style)
 *   - ~/Developer/lead-ama/DELEGATE-splitmessage-2026-04-09.md     (full spec)
 */
import { describe, test, expect } from 'bun:test'
import { splitMessage, PLATFORM_LIMITS } from '../../core/message-split'

const cpLen = (s: string) => Array.from(s).length

// Build long content that is guaranteed to split into >= 3 parts.
// Uses paragraph breaks so the splitter has natural boundaries.
function makeLongContent(opts: {
  leadingMentions?: string
  subject?: string
  bodyParagraphs?: number
  paragraphLength?: number
}): string {
  const mentions = opts.leadingMentions ? opts.leadingMentions + ' ' : ''
  const subject = opts.subject ?? 'CEO 承認 ✅ 3-gate プロトコルの最終版を merge します'
  const para = 'a'.repeat(opts.paragraphLength ?? 800)
  const paragraphs = Array.from({ length: opts.bodyParagraphs ?? 5 }, () => para).join('\n\n')
  return `${mentions}${subject}\n\n${paragraphs}`
}

// ─────────────────────────────────────────────────────────────────────────
// T1: every part receives the mention block at the start
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: prior to this fix, only Part 1 contained `<@111>` and
// `<@222>` because the input was naively split without re-injecting the
// header. Discord native push fired only on Part 1.
describe('T1 — mention re-injection on every part', () => {
  test('all parts contain every mention from the mentions argument', () => {
    const mentions = ['<@1485599598259994635>', '<@1227059781265653783>']
    const content = makeLongContent({
      leadingMentions: mentions.join(' '),
      bodyParagraphs: 6,
      paragraphLength: 800,
    })

    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)

    for (const p of parts) {
      for (const m of mentions) {
        expect(p).toContain(m)
      }
    }
  })

  test('mention block appears at the very start of every part (before any marker)', () => {
    const mentions = ['<@1485599598259994635>']
    const content = makeLongContent({
      leadingMentions: mentions[0],
      bodyParagraphs: 6,
      paragraphLength: 800,
    })

    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)

    for (const p of parts) {
      expect(p.startsWith(mentions[0])).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// T2: continuation marker rules
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: without explicit markers a reader cannot tell whether the
// message they are looking at is the first, middle, or last part of a split.
// CEO directive 2026-04-09 09:37 (msg 1491598010574962709) requires the
// continuity to be visible. ARC Option B settled on 「↳ 続き」/「↳ 続き、最後」.
describe('T2 — continuation marker rules', () => {
  const mentions = ['<@1485599598259994635>']

  test('Part 1 has the (1/M) marker but no 続き label', () => {
    const content = makeLongContent({
      leadingMentions: mentions[0],
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts[0]).toContain(`(1/${parts.length})`)
    expect(parts[0]).not.toContain('↳ 続き')
  })

  test('middle parts have the (N/M ↳ 続き) marker (not the 最後 variant)', () => {
    const content = makeLongContent({
      leadingMentions: mentions[0],
      bodyParagraphs: 12,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord', mentions)
    // Force a 3+ part split for this test to be meaningful.
    expect(parts.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < parts.length - 1; i++) {
      expect(parts[i]).toContain(`(${i + 1}/${parts.length} ↳ 続き)`)
      expect(parts[i]).not.toContain('↳ 続き、最後')
    }
  })

  test('the last part has the (M/M ↳ 続き、最後) marker', () => {
    const content = makeLongContent({
      leadingMentions: mentions[0],
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    const last = parts[parts.length - 1]
    expect(last).toContain(`(${parts.length}/${parts.length} ↳ 続き、最後)`)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// T3: subject_line preservation in Parts 2..N
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: a reader who jumps directly to Part 2 of 5 has no way to
// know what the topic is. ARC Option B requires Parts 2..N to repeat the
// extracted subject_line in their header so the message is comprehensible
// when read in isolation.
describe('T3 — subject_line preservation', () => {
  const mentions = ['<@1485599598259994635>']
  const subject = 'CEO 承認 ✅ 3-gate プロトコルの最終版を merge します'

  test('the subject_line appears in Parts 2..N (extracted from the original first line)', () => {
    const content = makeLongContent({
      leadingMentions: mentions[0],
      subject,
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)

    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]).toContain(subject)
    }
  })

  test('Part 1 does NOT add an extra subject_line (the original body already starts with it)', () => {
    const content = makeLongContent({
      leadingMentions: mentions[0],
      subject,
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord', mentions)

    // Part 1 should contain the subject string exactly once: once because it's
    // the first line of the original body. The mention header in Part 1 has
    // the form `${mentions} (1/M)\n${original_body}` — no separate subject
    // injection, so the subject string occurs exactly once.
    const occurrences = parts[0].split(subject).length - 1
    expect(occurrences).toBe(1)
  })

  test('subject_line strips leading markdown header markers (#, ##, ### …)', () => {
    const content = `<@1485599598259994635> ## 重要な決定: routing fix\n\n${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n\n${'c'.repeat(800)}\n\n${'d'.repeat(800)}\n\n${'e'.repeat(800)}`
    const parts = splitMessage(content, 'discord', ['<@1485599598259994635>'])
    expect(parts.length).toBeGreaterThanOrEqual(2)

    // Parts 2..N should reference the cleaned-up subject WITHOUT the leading `## `.
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]).toContain('重要な決定: routing fix')
      // The bare `## ` should not appear next to the marker (would imply we
      // failed to strip the markdown header).
      expect(parts[i]).not.toMatch(/↳ 続き(?:、最後)?\)\s+##\s/)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// T4: subject_line truncates at 80 codepoints with ellipsis
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: an overly long subject_line could blow the per-part
// budget and either truncate the body or push it over the platform limit.
// ARC Option B sets a hard 80-codepoint cap with ellipsis.
describe('T4 — subject_line 80-codepoint truncate + ellipsis', () => {
  const mentions = ['<@1485599598259994635>']

  test('a 100-codepoint subject is truncated to 80 + …', () => {
    const longSubject = 'こ'.repeat(100) // 100 Japanese codepoints
    const content = `${mentions[0]} ${longSubject}\n\n${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n\n${'c'.repeat(800)}\n\n${'d'.repeat(800)}\n\n${'e'.repeat(800)}`
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)

    // Parts 2..N should contain the truncated subject with ellipsis.
    for (let i = 1; i < parts.length; i++) {
      // The exact truncated subject is 80 こ + …
      const expectedTruncated = 'こ'.repeat(80) + '…'
      expect(parts[i]).toContain(expectedTruncated)
      // The full 100-cp subject should NOT appear in Parts 2..N.
      const fullSubject = 'こ'.repeat(100)
      // Part 1 may contain the full subject (it's part of the original body),
      // but Parts 2..N must only have the truncated version.
      expect(parts[i].includes(fullSubject)).toBe(false)
    }
  })

  test('a short subject (≤80 cp) is preserved verbatim with no ellipsis', () => {
    const shortSubject = 'short subject 30 chars only'
    const content = `${mentions[0]} ${shortSubject}\n\n${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n\n${'c'.repeat(800)}\n\n${'d'.repeat(800)}\n\n${'e'.repeat(800)}`
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)

    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]).toContain(shortSubject)
      // No ellipsis in the part-2+ header for short subjects.
      // (We check the prefix specifically, not the body — the body might
      //  legitimately contain `…` if the original content did.)
      const headerEnd = parts[i].indexOf('\n')
      const header = headerEnd >= 0 ? parts[i].slice(0, headerEnd) : parts[i]
      expect(header).not.toContain('…')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// T5: backward compatibility — `mentions` undefined / empty falls through
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: callers that haven't been migrated to the new signature
// (or callers that legitimately have no mentions, e.g. broadcasts) must keep
// the original PR#98 behavior of `(N/M) `-only prefixes.
describe('T5 — mentions undefined / empty: legacy behavior preserved', () => {
  test('mentions undefined yields the legacy (N/M) prefix and no continuation marker', () => {
    const content = makeLongContent({
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)

    parts.forEach((p, i) => {
      expect(p).toMatch(new RegExp(`^\\(${i + 1}/${parts.length}\\)\\s`))
      expect(p).not.toContain('↳ 続き')
    })
  })

  test('mentions=[] yields the same legacy behavior as undefined', () => {
    const content = makeLongContent({
      bodyParagraphs: 6,
      paragraphLength: 800,
    })
    const partsUndef = splitMessage(content, 'discord')
    const partsEmpty = splitMessage(content, 'discord', [])
    expect(partsEmpty).toEqual(partsUndef)
  })

  test('content ≤ limit returns [content] unchanged regardless of mentions', () => {
    const short = '<@1485599598259994635> short message that fits in one part'
    expect(splitMessage(short, 'discord')).toEqual([short])
    expect(splitMessage(short, 'discord', ['<@1485599598259994635>'])).toEqual([short])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// T6: every part fits within the platform limit (mention + subject + body)
// ─────────────────────────────────────────────────────────────────────────
// REGRESSION CLASS: it would be a silent regression to inject mention headers
// + subject_line + continuation marker into each part and accidentally push
// the part over the Discord 1900-codepoint limit, causing the adapter to
// truncate. The new path's overhead computation must keep us strictly under.
describe('T6 — platform limit guard with mention + subject + marker overhead', () => {
  test('every part is at or below PLATFORM_LIMITS.discord even with the new headers', () => {
    const mentions = [
      '<@1485599598259994635>',
      '<@1227059781265653783>',
      '<@1488361927846658098>',
    ]
    const longSubject = 'a'.repeat(80) // worst-case subject length
    const content = `${mentions.join(' ')} ${longSubject}\n\n${'b'.repeat(1500)}\n\n${'c'.repeat(1500)}\n\n${'d'.repeat(1500)}\n\n${'e'.repeat(1500)}`
    const parts = splitMessage(content, 'discord', mentions)

    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
  })

  test('a single very-large mention block + content stays within the limit', () => {
    // 5 mentions ≈ 110 cp + spaces
    const mentions = Array.from({ length: 5 }, (_, i) => `<@149999999999999999${i}>`)
    const content = `${mentions.join(' ')} subject text\n\n${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n\n${'c'.repeat(800)}\n\n${'d'.repeat(800)}`
    const parts = splitMessage(content, 'discord', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
  })

  test('Telegram (4000 limit) parts stay under the Telegram limit too', () => {
    const mentions = ['<@1485599598259994635>']
    const content = `${mentions[0]} subject text\n\n${'a'.repeat(2000)}\n\n${'b'.repeat(2000)}\n\n${'c'.repeat(2000)}`
    const parts = splitMessage(content, 'telegram', mentions)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.telegram)
    }
  })
})
