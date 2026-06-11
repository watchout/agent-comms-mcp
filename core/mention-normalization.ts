/**
 * Canonical mention normalization.
 *
 * Chat adapters, MCP tools, and routing ports all converge on agent_id[] before
 * queue routing. External ids and UI labels are display/input syntax only.
 */

export const GROUP_KEYWORDS = new Set(['all', 'dev', 'org', 'everyone', 'here'])

export const DEFAULT_AGENT_ID_ALIASES: Record<string, string> = {
  cto: 'codex-cto',
}

export type MentionNormalizeError = 'INVALID_MENTION' | 'UNKNOWN_AGENT'

export type MentionNormalizeResult =
  | { ok: true; mentions: string[]; warnings: string[] }
  | { ok: false; error: MentionNormalizeError; detail?: string }

export interface MentionNormalizeOptions {
  aliases?: Record<string, string | null | undefined>
  groupKeywords?: ReadonlySet<string>
  isKnownAgent?: (agentId: string) => boolean
  allowGroupKeywords?: boolean
  requireKnown?: boolean
}

function mergedAliases(aliases?: Record<string, string | null | undefined>): Record<string, string | null | undefined> {
  return { ...DEFAULT_AGENT_ID_ALIASES, ...(aliases ?? {}) }
}

function stripAgentMention(raw: string): string {
  return raw.trim().replace(/^@+/, '')
}

export function normalizeAgentId(raw: string, aliases?: Record<string, string | null | undefined>): string {
  const trimmed = stripAgentMention(raw)
  return mergedAliases(aliases)[trimmed] ?? trimmed
}

function normalizeAgentIdForKnownCheck(raw: string, opts: MentionNormalizeOptions): string {
  const stripped = stripAgentMention(raw)
  const aliased = mergedAliases(opts.aliases)[stripped] ?? stripped

  // Preserve an explicitly known agent_id when a built-in alias target is not
  // registered in the caller's current agent set. This keeps role aliases such
  // as "cto" canonical where codex-cto exists, without making a real cto row
  // fail UNKNOWN_AGENT in older/local fixtures.
  if (
    opts.requireKnown &&
    opts.isKnownAgent &&
    aliased !== stripped &&
    !opts.isKnownAgent(aliased) &&
    opts.isKnownAgent(stripped)
  ) {
    return stripped
  }

  return aliased
}

export function parseNativeAgentMentions(
  content: unknown,
  aliases?: Record<string, string | null | undefined>,
): string[] {
  if (typeof content !== 'string' || content.length === 0) return []
  const mentions: string[] = []
  const regex = /@([a-zA-Z0-9_-]+)/g
  let match
  try {
    while ((match = regex.exec(content)) !== null) {
      const captured = match[1]
      if (!captured) continue
      if (/^\d+$/.test(captured)) continue
      mentions.push(normalizeAgentId(captured, aliases))
    }
  } catch {
    return []
  }
  return [...new Set(mentions)]
}

function pushMentionValue(target: string[], value: unknown): MentionNormalizeResult | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    target.push(value)
    return null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, error: 'INVALID_MENTION' }
      target.push(item)
    }
    return null
  }
  return { ok: false, error: 'INVALID_MENTION' }
}

export function normalizeAgentMentions(
  input: { mention?: unknown; mentions?: unknown },
  opts: MentionNormalizeOptions = {},
): MentionNormalizeResult {
  const raw: string[] = []
  const mentionErr = pushMentionValue(raw, input.mention)
  if (mentionErr) return mentionErr
  const mentionsErr = pushMentionValue(raw, input.mentions)
  if (mentionsErr) return mentionsErr

  const warnings: string[] = []
  const out: string[] = []
  const seen = new Set<string>()
  const groupKeywords = opts.groupKeywords ?? GROUP_KEYWORDS
  for (const item of raw) {
    const normalized = normalizeAgentIdForKnownCheck(item, opts)
    if (!normalized) return { ok: false, error: 'INVALID_MENTION' }
    const isGroup = groupKeywords.has(normalized)
    if (opts.requireKnown && !isGroup && opts.isKnownAgent && !opts.isKnownAgent(normalized)) {
      return { ok: false, error: 'UNKNOWN_AGENT', detail: normalized }
    }
    if (!opts.allowGroupKeywords && isGroup) {
      return { ok: false, error: 'UNKNOWN_AGENT', detail: normalized }
    }
    if (!seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }

  return { ok: true, mentions: out, warnings }
}
