/**
 * Issue #277 (B 部分) — server-side auto-skip patterns.
 *
 * Messages whose content matches one of these patterns (or whose sender
 * equals the recipient — bot self-echo) are queued with `status='skipped'`
 * and `failed_reason='AUTO_SKIP_PATTERN'` instead of `status='pending'`.
 * The push (delivery via `next`) is suppressed; the row remains for audit.
 *
 * `agent_messages` history is unaffected (always saved upstream).
 *
 * Forbidden anti-patterns (per Issue spec):
 *   - LLM judgment in match decisions (regex / equality only)
 *   - Pattern over-expansion that drops real mentions (false negative)
 *
 * Initial pattern set is verbatim from Issue #277 §採用方針 / §2:
 *   1. lead-ama "no-mention" warning echo
 *   2. heartbeat broadcast lines (introduced in this PR)
 *   3. message_type='system_info'
 *   4. sender == recipient (bot self-echo)
 *
 * `AUTO_SKIP_PATTERNS_CONFIG` env var (JSON array of `{ name, pattern }`)
 * appends additional patterns at startup without code change.
 */

export interface AutoSkipPattern {
  /** Stable id used in `failed_reason` audit and tests. */
  name: string
  /** Regex applied to message content. Match → skip. */
  pattern: RegExp
  /** Optional message_type filter; when set, the regex only fires for matching types. */
  messageType?: string
}

export interface AutoSkipMatchInput {
  content: string
  messageType: string
  authorAgentId: string | null
  recipientAgentId: string
}

export interface AutoSkipMatchResult {
  matched: boolean
  reason?: string
}

const DEFAULT_PATTERNS: AutoSkipPattern[] = [
  // 1. lead-ama posts a sanitiser warning when a Discord author forgets to
  //    mention any bot. The warning itself should never be queued for the bots
  //    that *do* read the channel — it's noise.
  { name: 'lead_ama_no_mention_warning', pattern: /^⚠️ メンションがないため/ },
  // 2. Heartbeat broadcast lines (introduced by this PR) start with `[hb `.
  //    They are observability metadata and must not loop back into per-bot queues.
  { name: 'heartbeat_broadcast', pattern: /^\[hb / },
  // 3. message_type='system_info' is reserved for non-actionable bookkeeping.
  { name: 'system_info_type', pattern: /^/, messageType: 'system_info' },
]

function loadConfiguredPatterns(): AutoSkipPattern[] {
  const raw = process.env.AUTO_SKIP_PATTERNS_CONFIG
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as Array<{ name: string; pattern: string; messageType?: string }>
    return parsed.map((p) => ({
      name: p.name,
      pattern: new RegExp(p.pattern),
      messageType: p.messageType,
    }))
  } catch (err) {
    process.stderr.write(`auto-skip-patterns: AUTO_SKIP_PATTERNS_CONFIG parse failed (ignored): ${err}\n`)
    return []
  }
}

let cachedPatterns: AutoSkipPattern[] | null = null

export function getAutoSkipPatterns(): AutoSkipPattern[] {
  if (cachedPatterns === null) {
    cachedPatterns = [...DEFAULT_PATTERNS, ...loadConfiguredPatterns()]
  }
  return cachedPatterns
}

/** Test-only — reset the cache so env var changes take effect. */
export function resetAutoSkipPatternsCache(): void {
  cachedPatterns = null
}

function isTerminalNoopContinuation(input: AutoSkipMatchInput): boolean {
  if (input.messageType !== 'report') return false
  if (!/^Processed queue \d+\.\n\nAcknowledged:/.test(input.content)) return false
  if (!/\bNo (?:additional|further)\b[\s\S]*\b(?:action|changes)\b[\s\S]*\bcontinuation\b/i.test(input.content)) return false
  return /\bResidual gates remain unchanged:/i.test(input.content)
}

export function matchesAutoSkipPattern(input: AutoSkipMatchInput): AutoSkipMatchResult {
  // Bot self-echo: the recipient is the same agent that authored the message.
  // routeInbound already self-skips push, but we additionally tag this so the
  // skipped row's audit trail is explicit rather than silently empty.
  if (input.authorAgentId && input.authorAgentId === input.recipientAgentId) {
    return { matched: true, reason: 'self_echo' }
  }
  // Queue continuation reports that explicitly say no further work is
  // required and leave residual gates unchanged are protocol-close
  // messages. Treat them as audit-visible terminal rows instead of
  // actionable work, regardless of which two bots exchanged them.
  if (isTerminalNoopContinuation(input)) {
    return { matched: true, reason: 'terminal_noop_continuation' }
  }
  for (const p of getAutoSkipPatterns()) {
    if (p.messageType && p.messageType !== input.messageType) continue
    if (p.pattern.test(input.content)) {
      return { matched: true, reason: p.name }
    }
  }
  return { matched: false }
}
