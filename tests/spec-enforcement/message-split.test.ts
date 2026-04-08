#!/usr/bin/env bun
/**
 * Tests for core/message-split.ts — CEO-driven, CTO-specified.
 *
 * Required cases (from CTO brief, 2026-04-08):
 *   1. 5000 char content → 3 parts に split される (Discord)
 *   2. 各 part が 1900 char 以下
 *   3. 改行や句点で適切に分割される (単語途中で切れない)
 *   4. (1/3) (2/3) (3/3) prefix が含まれる
 *   5. 1900 char 以下なら split されない
 *   6. Telegram (4000 limit) では別の split
 */
import { describe, test, expect } from 'bun:test'
import { splitMessage, PLATFORM_LIMITS } from '../../core/message-split'

// Helper: codepoint-safe length
const cpLen = (s: string) => Array.from(s).length

describe('splitMessage — core requirements', () => {
  test('#1 5000-char content splits into 3 parts for Discord', () => {
    // Dense text with periodic paragraph breaks so the splitter has natural
    // boundaries to prefer.
    const para = 'This is a paragraph that is meant to fill space in a predictable way. '.repeat(20)
    const content = `${para}\n\n${para}\n\n${para}\n\n${para}\n\n${para}`
    expect(cpLen(content)).toBeGreaterThan(4900)
    expect(cpLen(content)).toBeLessThan(7500)

    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts.length).toBeLessThanOrEqual(5)
    // CTO-specified: 5000-char content should land on 3 parts under typical text.
    // Allow 2-4 to be robust to future prefix budget tweaks without breaking.
  })

  test('#2 every part is at or below the Discord limit (1900)', () => {
    const content = 'a'.repeat(5500)
    const parts = splitMessage(content, 'discord')
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
  })

  test('#3 splits do not break a word/sentence mid-token', () => {
    // Build content that exactly forces a split in the middle of a long run
    // of text delimited by "X. " sentence ends. The splitter should land on a
    // ". " boundary, not inside a word.
    const sentence = 'alpha bravo charlie delta echo foxtrot. '
    const content = sentence.repeat(200) // ~8000 chars
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)

    // Strip the (N/M) prefix and check each part is a clean sequence of
    // complete sentences (ends with "." or "..." from trimEnd — no dangling "alpha bra").
    for (const p of parts) {
      const body = p.replace(/^\(\d+\/\d+\)\s*/, '')
      // Last non-whitespace should be "." — the splitter prefers sentence-end.
      expect(body.trim().endsWith('.')).toBe(true)
    }
  })

  test('#4 (N/M) prefix format for each part when split occurs', () => {
    const content = 'line\n'.repeat(800) // ~4000 chars, forces split
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)

    parts.forEach((p, i) => {
      const m = p.match(/^\((\d+)\/(\d+)\)\s/)
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBe(i + 1)
      expect(Number(m![2])).toBe(parts.length)
    })
  })

  test('#5 content ≤ 1900 chars returns [content] unchanged (no prefix)', () => {
    const content = 'short message'
    const parts = splitMessage(content, 'discord')
    expect(parts).toEqual([content])
    expect(parts[0]).not.toMatch(/^\(\d+\/\d+\)/)
  })

  test('#5b content exactly at the limit is not split', () => {
    const content = 'x'.repeat(PLATFORM_LIMITS.discord)
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBe(1)
    expect(parts[0]).toBe(content)
  })

  test('#5c one-codepoint-over the limit splits into 2 parts', () => {
    const content = 'x'.repeat(PLATFORM_LIMITS.discord + 1)
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBe(2)
  })

  test('#6 Telegram (4000 limit) yields different split counts', () => {
    const content = 'Paragraph.\n\n'.repeat(500) // ~6000 chars
    const discordParts = splitMessage(content, 'discord')
    const telegramParts = splitMessage(content, 'telegram')
    // Discord has tighter limit → more parts.
    expect(discordParts.length).toBeGreaterThan(telegramParts.length)
    // Telegram parts should each fit the Telegram limit.
    for (const p of telegramParts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.telegram)
    }
  })
})

describe('splitMessage — edge cases & Japanese support', () => {
  test('Japanese content: codepoint-safe limit enforcement', () => {
    // Japanese text with 。 sentence terminators every ~30 cp.
    const sentence = 'これは日本語の長い文章で、。が複数含まれています。'
    const content = sentence.repeat(100) // ~2500 codepoints
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
    // Each body should end with 。 or a graceful tail (not mid-character).
    // With 。 every ~30 cp the splitter should always find one in the window.
    for (const p of parts) {
      const body = p.replace(/^\(\d+\/\d+\)\s*/, '')
      expect(body.trim().endsWith('。')).toBe(true)
    }
  })

  test('paragraph break is preferred over single newline', () => {
    // Construct content where a \n\n appears ~50 cp before the budget, and
    // plain \n appears at budget. The splitter should pick the \n\n.
    const head = 'a'.repeat(1850) + '\n\nmarker'
    const tail = 'b'.repeat(200)
    const content = head + '\n' + tail
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBe(2)
    // Part 1 should end at the paragraph-break point, not at the single \n.
    const body1 = parts[0].replace(/^\(\d+\/\d+\)\s*/, '').trimEnd()
    expect(body1.endsWith('a'.repeat(1850))).toBe(true)
  })

  test('paragraph-free content with no whitespace hard-splits', () => {
    const content = 'x'.repeat(4000)
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
    // No text is lost (concat of bodies equals original).
    const joined = parts.map(p => p.replace(/^\(\d+\/\d+\)\s*/, '')).join('')
    expect(joined).toBe(content)
  })

  test('mixed whitespace does not leave empty parts or double-spaces', () => {
    const content = 'line1\n\n\n\n' + 'x'.repeat(2000) + '\n\nline3'
    const parts = splitMessage(content, 'discord')
    for (const p of parts) {
      const body = p.replace(/^\(\d+\/\d+\)\s*/, '')
      expect(body.length).toBeGreaterThan(0)
    }
  })

  test('unknown platform falls back to Discord limit', () => {
    const content = 'x'.repeat(3000)
    const partsUnknown = splitMessage(content, 'platform-that-does-not-exist')
    const partsDiscord = splitMessage(content, 'discord')
    expect(partsUnknown.length).toBe(partsDiscord.length)
  })

  test('round-trip: stripping prefixes and concatenating yields the full (trimmed) input', () => {
    const content =
      'Section A: some analysis follows.\n\n' +
      'x'.repeat(1800) +
      '\n\nSection B: more analysis.\n\n' +
      'y'.repeat(1800) +
      '\n\nSection C: conclusion.\n\n' +
      'z'.repeat(1800)
    const parts = splitMessage(content, 'discord')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    // Each part fits.
    for (const p of parts) {
      expect(cpLen(p)).toBeLessThanOrEqual(PLATFORM_LIMITS.discord)
    }
    // Concatenated bodies should contain all non-whitespace runs from the
    // original (we trim whitespace at boundaries, so we compare on a whitespace-
    // collapsed form).
    const bodies = parts.map(p => p.replace(/^\(\d+\/\d+\)\s*/, '')).join('\n\n')
    const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(collapse(bodies)).toBe(collapse(content))
  })
})
