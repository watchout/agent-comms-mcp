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

function stripDiscordMentions(value: string): string {
  return normalizeText(
    value
      .replace(/<@!?\d+>/g, ' ')
      .replace(/[、。，．・:：;；!！?？()[\]{}「」『』"']/g, ' '),
  )
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) return trimmed.slice(1, -1)
  return trimmed
}

function isShirubeSchema(value: unknown): boolean {
  return typeof value === 'string' && /^shirube-v3\/[a-z0-9][a-z0-9_-]*\/v[0-9]+$/i.test(value.trim())
}

function recordBlockingSignal(value: unknown, matchedPrefix: string): string | null {
  const record = recordValue(value)
  if (!record || !isShirubeSchema(record.schema_version)) return null
  const nextAction = recordValue(record.next_action)
  return nextAction?.blocking === true ? `${matchedPrefix}.next_action.blocking` : null
}

function yamlBlockingSignal(content: string): string | null {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const schemaLine = lines.find(line => /^\s*schema_version\s*:/i.test(line))
  if (!schemaLine) return null
  const schemaMatch = schemaLine.match(/^\s*schema_version\s*:\s*(.+?)\s*$/i)
  if (!schemaMatch || !isShirubeSchema(unquoteScalar(schemaMatch[1]))) return null

  for (let index = 0; index < lines.length; index += 1) {
    const nextAction = lines[index].match(/^(\s*)next_action\s*:\s*(.*?)\s*$/i)
    if (!nextAction) continue
    const parentIndent = nextAction[1].length
    if (/\bblocking\s*:\s*(?:true|"true"|'true')(?=\s*(?:[,}]|$))/i.test(nextAction[2])) {
      return 'content.next_action.blocking'
    }
    let directChildIndent: number | null = null
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex]
      if (child.trim() === '' || child.trimStart().startsWith('#')) continue
      const childIndent = child.match(/^\s*/)?.[0].length ?? 0
      if (childIndent <= parentIndent) break
      directChildIndent ??= childIndent
      if (childIndent !== directChildIndent) continue
      if (/^\s*blocking\s*:\s*(?:true|"true"|'true')\s*(?:#.*)?$/i.test(child)) {
        return 'content.next_action.blocking'
      }
    }
  }
  return null
}

function structuredBlockingSignal(payload: Record<string, unknown>, content: string | null): string | null {
  const payloadSignal = recordBlockingSignal(payload, 'payload')
  if (payloadSignal) return payloadSignal
  if (!content) return null
  try {
    const parsed = JSON.parse(content)
    const jsonSignal = recordBlockingSignal(parsed, 'content')
    if (jsonSignal) return jsonSignal
  } catch {
    // Canonical GitHub/AUN requests are commonly YAML-shaped rather than JSON.
  }
  return yamlBlockingSignal(content)
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
  const content = stringValue(input.content, payload.content, input.storedContent)
  const blockingSignal = structuredBlockingSignal(payload, content)
  if (blockingSignal) {
    return {
      no_reply_required: false,
      reason: 'structured_blocking_request_requires_reply',
      matched: blockingSignal,
    }
  }

  const baton = existingNoReplyBaton(payload)
  if (baton) {
    return {
      no_reply_required: true,
      reason: baton.reason,
      matched: 'terminal_baton.no_reply_required',
    }
  }
  if (payload.no_reply_required === true) {
    return {
      no_reply_required: true,
      reason: 'payload_no_reply_required',
      matched: 'payload.no_reply_required',
    }
  }

  if (!content) return { no_reply_required: false, reason: null, matched: null }

  const text = normalizeText(content)
  if (text === '') return { no_reply_required: false, reason: null, matched: null }

  if (payload.legacy_direct_mention_no_reply === true && /<@!?\d+>/.test(text)) {
    const withoutMentions = stripDiscordMentions(text).toLowerCase()
    const directMentionSmokeTexts = new Set([
      'test',
      'smoke',
      'smoke test',
      'テスト',
      '疎通テスト',
      '疎通 test',
      '接続テスト',
      '動作テスト',
    ])
    if (directMentionSmokeTexts.has(withoutMentions)) {
      return {
        no_reply_required: true,
        reason: 'direct_mention_smoke_completed_without_substantive_reply',
        matched: 'direct_mention_smoke_text',
      }
    }
  }

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
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const currentObject = current as Record<string, unknown>
    if (currentObject.no_reply_required === true) {
      return { ...payload, terminal_baton: currentObject }
    }
  }
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
