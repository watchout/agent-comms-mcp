#!/usr/bin/env bun
/**
 * Thin CLI wrapper around `detectLoop` so `scripts/run-bot.sh` can call
 * the helper without re-implementing the algorithm in shell. Reads one
 * JSON object from stdin and writes the `LoopVerdict` to stdout.
 *
 * Input shape (caller assembles via `jq`):
 *   {
 *     "chain":   [{"from": "...", ...}, ...],   // ReplyChainEntry[]
 *     "current": "lead-ama",                    // current agent id
 *     "env": {                                  // LoopDetectorEnv
 *       "maxReplyChainDepth": 10,
 *       "maxPairBounce": 3,
 *       "maxSelfInChain": 3
 *     }
 *   }
 *
 * Output: a `LoopVerdict` JSON object on stdout. Stderr stays clean
 * unless an unrecoverable parse / contract error occurs (in which
 * case the caller's `|| echo '{"ok":true}'` fall-through preserves
 * fail-open semantics — the legacy `MAX_SELF_IN_CHAIN` block also
 * fell through silently on jq failure, so this matches existing
 * fail-open behavior for runner-level errors).
 *
 * Spec: docs/B8-loop-detection-spec-amendment-v0.md §2.5 (caller
 * layer responsibilities).
 */
import { detectLoop, type ReplyChainEntry, type LoopDetectorEnv } from './loop-detector'

async function readStdin(): Promise<string> {
  let body = ''
  for await (const chunk of process.stdin) {
    body += chunk
  }
  return body
}

;(async () => {
  let parsed: unknown
  try {
    const raw = await readStdin()
    parsed = JSON.parse(raw || '{}')
  } catch (err) {
    process.stderr.write(`loop-detector-cli: invalid JSON on stdin: ${err}\n`)
    process.stdout.write('{"ok":true}\n')
    process.exit(0)
  }
  const obj = parsed as {
    chain?: ReplyChainEntry[]
    current?: string
    env?: Partial<LoopDetectorEnv>
  }
  const chain = Array.isArray(obj?.chain) ? obj.chain : []
  const current = typeof obj?.current === 'string' ? obj.current : ''
  // Normalize env per §1 pre-conditions: clamp to spec minima so a
  // mis-set env cannot disable detection. Caller (run-bot.sh) is the
  // stable home for the default values; this clamp is the safety net
  // when the caller drifts.
  const env: LoopDetectorEnv = {
    maxReplyChainDepth: Math.max(1, Number(obj?.env?.maxReplyChainDepth ?? 10)),
    maxPairBounce: Math.max(2, Number(obj?.env?.maxPairBounce ?? 3)),
    maxSelfInChain: Math.max(2, Number(obj?.env?.maxSelfInChain ?? 3)),
  }
  const verdict = detectLoop(chain, current, env)
  process.stdout.write(JSON.stringify(verdict) + '\n')
})()
