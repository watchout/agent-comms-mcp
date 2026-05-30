export interface NoReplyDecision {
  no_reply_required: boolean
  reason: string | null
  matched: string | null
}

export interface TerminalBaton {
  no_reply_required: true
  reason: string
  set_by: string
  set_at: string
  source: 'deterministic_no_reply_policy' | 'record_no_reply_command'
}

export interface BuildTerminalBatonOptions {
  reason: string
  setBy: string
  source: TerminalBaton['source']
  now?: () => Date
}

export function parseQueuePayload(payload: unknown): Record<string, unknown> {
  if (!payload) return {}
  if (typeof payload === 'object' && !Array.isArray(payload)) return payload as Record<string, unknown>
  if (typeof payload !== 'string' || payload.trim() === '') return {}
  try {
    const parsed = JSON.parse(payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export function existingNoReplyBaton(payload: Record<string, unknown>): TerminalBaton | null {
  const raw = payload.terminal_baton
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const baton = raw as Record<string, unknown>
  if (baton.no_reply_required !== true) return null
  return {
    no_reply_required: true,
    reason: typeof baton.reason === 'string' && baton.reason.trim()
      ? baton.reason
      : 'terminal_baton.no_reply_required',
    set_by: typeof baton.set_by === 'string' && baton.set_by.trim()
      ? baton.set_by
      : 'unknown',
    set_at: typeof baton.set_at === 'string' && baton.set_at.trim()
      ? baton.set_at
      : new Date(0).toISOString(),
    source: baton.source === 'record_no_reply_command'
      ? 'record_no_reply_command'
      : 'deterministic_no_reply_policy',
  }
}

export function detectNoReplyIntent(input: {
  payload?: Record<string, unknown>
  content?: unknown
  storedContent?: unknown
}): NoReplyDecision {
  const payload = input.payload ?? {}
  const baton = existingNoReplyBaton(payload)
  if (baton) {
    return {
      no_reply_required: true,
      reason: baton.reason,
      matched: 'terminal_baton.no_reply_required',
    }
  }

  const content = stringValue(input.content, payload.content, input.storedContent)
  if (!content) return { no_reply_required: false, reason: null, matched: null }

  const text = normalizeText(content)
  if (text === '') return { no_reply_required: false, reason: null, matched: null }

  const explicitPatterns: Array<[RegExp, string]> = [
    [/\bno\s+(reply|response)\s+(is\s+)?required\b/i, 'explicit_no_reply_required'],
    [/\bdo\s+not\s+reply\b/i, 'explicit_do_not_reply'],
    [/\bno\s+further\s+action\s+(is\s+)?required\b/i, 'explicit_no_further_action_required'],
    [/\bno\s+further\s+action\s+on\s+this\s+acknowledg?ement\b/i, 'explicit_no_further_action_acknowledgement'],
    [/\bno\s+action\s+(is\s+)?required\b/i, 'explicit_no_action_required'],
  ]
  for (const [pattern, reason] of explicitPatterns) {
    if (pattern.test(text)) {
      return { no_reply_required: true, reason, matched: pattern.source }
    }
  }

  const acknowledgementPatterns: Array<[RegExp, string]> = [
    [/^ack(?:nowledged)?[:.\s-].*\b(received|recorded|noted|accepted)\b/i, 'acknowledgement_recorded'],
    [/\b(pass|result)\b.*\b(received\s+and\s+recorded|accepted|noted)\b/i, 'pass_acknowledgement_recorded'],
  ]
  for (const [pattern, reason] of acknowledgementPatterns) {
    if (pattern.test(text)) {
      return { no_reply_required: true, reason, matched: pattern.source }
    }
  }

  return { no_reply_required: false, reason: null, matched: null }
}

export function buildTerminalBaton(options: BuildTerminalBatonOptions): TerminalBaton {
  return {
    no_reply_required: true,
    reason: options.reason,
    set_by: options.setBy,
    set_at: (options.now ?? (() => new Date()))().toISOString(),
    source: options.source,
  }
}

export function withTerminalBaton(
  payload: Record<string, unknown>,
  baton: TerminalBaton,
): Record<string, unknown> {
  const current = payload.terminal_baton
  const currentObject = current && typeof current === 'object' && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {}
  return {
    ...payload,
    terminal_baton: {
      ...currentObject,
      ...baton,
    },
  }
}
