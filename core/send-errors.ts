/**
 * Pure helper functions for send tool error messages and reply context.
 * Extracted for testability (Issue #118 PR-A).
 *
 * All functions are pure — DB/network calls happen in server.ts; results are
 * passed in as plain values so tests can exercise the logic without mocks.
 */

/** Group keywords that are always valid mentions (bypass agent_id validation).
 *
 * `everyone` / `here` were added in #527 as broadcast escape hatches for
 * inbound posts when `channel.primary` is set — without them in this
 * allowlist, `extractDiscordMentions()` filters them out before routing
 * and `@everyone` / `@here` silently degrade to primary-only.
 */
export const GROUP_KEYWORDS = new Set(['all', 'dev', 'org', 'everyone', 'here'])

/**
 * Build the NOT_MENTIONED error message body.
 *
 * @param authorId  agent_id of the original message author, or null if unknown/no reply_to
 * @param knownAgents  list of registered agent_ids fetched from DB; empty array when DB unavailable
 */
export function buildNotMentionedErrorMsg(
  authorId: string | null,
  knownAgents: string[],
): string {
  const authorHint = authorId ? ` Original message author: ${authorId}.` : ''
  const agentListStr = knownAgents.length > 0 ? ` Known agents: [${knownAgents.join(', ')}].` : ''
  return `Error [NOT_MENTIONED]: mentions is required and must not be empty.${authorHint}${agentListStr}`
}

/**
 * Validate a single mention against the known agent list.
 * Group keywords (all/dev/org) always pass.
 *
 * @returns error string if invalid, null if valid
 */
export function validateMentionOrError(
  mention: string,
  knownAgents: string[],
): string | null {
  if (GROUP_KEYWORDS.has(mention)) return null
  if (knownAgents.length === 0) {
    return `Error [MENTION_VALIDATION_UNAVAILABLE]: agent一覧を取得できません。しばらく待ってから再送してください`
  }
  if (!knownAgents.includes(mention)) {
    return `Error [INVALID_MENTION_FORMAT]: '${mention}' は登録されていません。Known agents: [${knownAgents.join(', ')}]`
  }
  return null
}

/**
 * Build the reply_context suffix appended to send success responses.
 *
 * @param orig  original message (author_id + content), or null if not found
 * @param channelId  resolved destination channel id
 */
export function buildReplyContextSuffix(
  orig: { author_id: string; content: string } | null,
  channelId: string,
): string {
  if (!orig) return ''
  const snippet = orig.content.length > 60 ? orig.content.slice(0, 60) + '…' : orig.content
  return ` | reply_context: {author: ${orig.author_id}, channel: ${channelId}, snippet: "${snippet}"}`
}
