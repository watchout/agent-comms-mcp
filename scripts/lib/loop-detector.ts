/**
 * B8 runaway loop detection — pure helper for `scripts/run-bot.sh`.
 *
 * Spec: docs/B8-loop-detection-spec-amendment-v0.md (DRAFT v0.2)
 *
 * The 2026-05-07 SIGUSR1 incident (arc ↔ adf-lead bounce) showed that
 * the existing `MAX_SELF_IN_CHAIN` guard catches only same-agent
 * self-loops; a different-agent A↔B bounce slips through entirely.
 * This module replaces the inline self-count detection in
 * `run-bot.sh:147-158` with a 3-layer defense-in-depth check:
 *
 *   - Layer 1 (depth_exceeded): hard cap on the resolved chain length.
 *   - Layer 2 (pair_bounce):    ordered (from[i], from[i+1]) pair count
 *                               with self pairs excluded — Layer 3's
 *                               territory.
 *   - Layer 3 (self_chain):     occurrence count of the receiving bot's
 *                               own `agent_id` in the resolved chain,
 *                               the legacy `MAX_SELF_IN_CHAIN` semantic
 *                               (run-bot.sh:152 pre-B8: `jq | length`).
 *
 * Layer evaluation order is L1 → L2 → L3; the first layer to trip
 * short-circuits and its `subReason` is returned. The companion
 * helper `scripts/lib/send-error-log.ts` is the symmetric module
 * boundary on the logging side (auditor A2 — both sides ride at the
 * same abstraction; the shell is a thin caller for both).
 *
 * Pure function: zero I/O, no replyChain mutation, no time / random
 * dependence. Caller owns logging the verdict (subReason + detail).
 */

export type ReplyChainEntry = {
  /** agent_id of the message author (e.g. `"lead-ama"`). Required, but
   *  the helper tolerates a missing or empty value by skipping the
   *  entry — see §2 (a)-(b) skip rule. Other fields (id / parent_id /
   *  created_at / ...) are parser-dependent and not consulted. */
  from?: string
}

export type LoopDetectorEnv = {
  /** Hard cap on resolved chain length. >= 1; caller normalizes. */
  maxReplyChainDepth: number
  /** Ordered-pair occurrence cap (Layer 2). >= 2; caller normalizes. */
  maxPairBounce: number
  /** Consecutive same-from cap (Layer 3, legacy MAX_SELF_IN_CHAIN).
   *  >= 2; caller normalizes. */
  maxSelfInChain: number
}

export type LoopVerdict =
  | { ok: true }
  | {
      ok: false
      /** Closed taxonomy — the spec's `failed_reason='LOOP_DETECTED'`
       *  stays unchanged; this finer subReason lands only in the log
       *  file (see §11 of agent-com-message-queue-spec.md). */
      subReason: 'depth_exceeded' | 'pair_bounce' | 'self_chain'
      /** Human-readable, log-only. Not for machine parsing. */
      detail: string
    }

/**
 * Decide whether the resolved reply chain shows a runaway pattern.
 *
 * @param replyChain   The `next` tool's `reply_chain` payload as
 *                     received from the queue. Entries with a missing
 *                     or empty `from` are skipped before evaluation
 *                     (the parser cannot identify the author, so the
 *                     entry contributes nothing to bounce detection).
 * @param currentAgent The receiving bot's `agent_id`. Layer 3 counts
 *                     its occurrences in the resolved chain to preserve
 *                     the legacy `MAX_SELF_IN_CHAIN` guard (single-agent
 *                     self-loop fail-safe).
 * @param env          Threshold env, already normalized by the caller.
 */
export function detectLoop(
  replyChain: ReplyChainEntry[],
  currentAgent: string,
  env: LoopDetectorEnv,
): LoopVerdict {
  // Skip entries the parser could not attribute to an agent. The
  // resolved valid chain is what the layers consume.
  const valid: string[] = []
  for (const entry of replyChain) {
    if (entry && typeof entry.from === 'string' && entry.from.length > 0) {
      valid.push(entry.from)
    }
  }

  // Layer 1 — depth_exceeded (hard cap).
  if (valid.length >= env.maxReplyChainDepth) {
    return {
      ok: false,
      subReason: 'depth_exceeded',
      detail: `chain length ${valid.length} >= maxReplyChainDepth ${env.maxReplyChainDepth}`,
    }
  }

  // Layer 2 — pair_bounce. Ordered adjacent pairs; self pairs excluded
  // (the spec leaves consecutive same-from to Layer 3 to avoid double
  // counting). Pair `(a, b)` and `(b, a)` are tracked separately —
  // a strict back-and-forth between two agents trips L2 in
  // `2 * (maxPairBounce - 1) + 2` entries (e.g. `MAX_PAIR_BOUNCE=3`
  // ⇒ depth 6 when A↔B alternates exactly).
  const pairCounts = new Map<string, number>()
  for (let i = 0; i + 1 < valid.length; i++) {
    const a = valid[i]
    const b = valid[i + 1]
    if (a === b) continue
    const key = a + '\x00' + b
    const next = (pairCounts.get(key) ?? 0) + 1
    pairCounts.set(key, next)
    if (next >= env.maxPairBounce) {
      return {
        ok: false,
        subReason: 'pair_bounce',
        detail: `pair (${a},${b}) seen ${next} times >= maxPairBounce ${env.maxPairBounce}`,
      }
    }
  }

  // Layer 3 — self_chain. Count of `currentAgent` occurrences in the
  // resolved chain. spec §3 Layer 3 + §2 (f): preserves the legacy
  // `MAX_SELF_IN_CHAIN` guard bit-exact (run-bot.sh:152 pre-B8 was
  // `jq '[.reply_chain[]? | select(.from==$a)] | length'` against the
  // bot's own agent_id) — the single-agent self-loop fail-safe.
  let selfCount = 0
  for (const from of valid) {
    if (from === currentAgent) selfCount++
  }
  if (selfCount >= env.maxSelfInChain) {
    return {
      ok: false,
      subReason: 'self_chain',
      detail: `agent ${currentAgent} appears ${selfCount} times >= maxSelfInChain ${env.maxSelfInChain}`,
    }
  }

  return { ok: true }
}
