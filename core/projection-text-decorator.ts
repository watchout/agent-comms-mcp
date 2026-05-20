export interface ProjectionTextDecorationInput {
  content: string
  authorAgentId: string
  consumerAgentId?: string | null
  recipients?: string[]
}

function uniqueNonEmpty(values: string[] | undefined): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values ?? []) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function decorateProjectedContent(input: ProjectionTextDecorationInput): string {
  const consumer = input.consumerAgentId?.trim()
  if (!consumer || consumer === input.authorAgentId) return input.content

  const recipients = uniqueNonEmpty(input.recipients).filter(id => id !== input.authorAgentId)
  const route = recipients.length > 0
    ? `${input.authorAgentId} -> ${recipients.join(', ')}`
    : `${input.authorAgentId} via ${consumer}`
  const prefix = `[${route}]`

  if (input.content.startsWith(prefix)) return input.content
  return `${prefix}\n${input.content}`
}
