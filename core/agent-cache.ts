/**
 * Pure helper for agent_id cache logic + mentions auto-fill (Issue #118 PR-B).
 *
 * All functions are pure with injected dependencies so tests can exercise
 * the logic without touching module-level state or a real DB.
 */

export interface AgentCacheEntry {
  ids: string[]
  ts: number
}

/** Query function type: returns agent_id list from DB. */
export type QueryFn = () => Promise<string[]>

/**
 * Refresh the agent cache, respecting TTL.
 *
 * @param cache      current cache state (null = no cache yet)
 * @param ttlMs      cache TTL in milliseconds
 * @param queryFn    DB query function; null when DB is unavailable
 * @returns updated  new cache entry to persist (null = cache unchanged, use existing)
 * @returns ids      the agent_id list to use for this call
 *
 * Behaviour matrix:
 *   cache fresh (within TTL) + any queryFn  → return cache.ids, no DB call
 *   cache stale/null + queryFn available    → call queryFn, update cache
 *   cache stale/null + queryFn null (DB ↓) → return stale cache ids or [] (fail-loud via validateMentionOrError)
 */
export async function refreshAgentCacheWith(
  cache: AgentCacheEntry | null,
  ttlMs: number,
  queryFn: QueryFn | null,
): Promise<{ updated: AgentCacheEntry | null; ids: string[] }> {
  // Cache hit: TTL not expired
  if (cache && Date.now() - cache.ts < ttlMs) {
    return { updated: null, ids: cache.ids }
  }
  // Cache miss or expired: try DB
  if (!queryFn) {
    // DB unavailable: return stale ids (may be []), caller's validateMentionOrError handles fail-loud
    return { updated: null, ids: cache?.ids ?? [] }
  }
  const ids = await queryFn()
  const updated: AgentCacheEntry = { ids, ts: Date.now() }
  return { updated, ids }
}

/**
 * Apply mentions auto-fill when mentions is empty and reply_to context is available.
 *
 * If mentions is already provided (non-empty), returns null (no change needed).
 * If mentions is empty and origAuthorId is known, returns [origAuthorId] as the
 * auto-filled mentions list.
 *
 * @param mentions      current mentions array (may be empty/null/undefined)
 * @param replyTo       reply_to message UUID (null/undefined = no reply context)
 * @param origAuthorId  author_id of the original message (null if lookup failed)
 * @returns             new mentions array if auto-filled, null if no change
 */
export function applyMentionsAutoFill(
  mentions: string[] | null | undefined,
  replyTo: string | null | undefined,
  origAuthorId: string | null | undefined,
): string[] | null {
  // Already has explicit mentions → respect them, no override
  if (mentions && mentions.length > 0) return null
  // Can auto-fill: reply_to present and original author known
  if (replyTo && origAuthorId) return [origAuthorId]
  // Cannot auto-fill
  return null
}
