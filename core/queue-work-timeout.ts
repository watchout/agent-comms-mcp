/**
 * Shared queue-work runner timeout resolver (PR #958 L2 cycle-3 F1).
 *
 * Before this module the runner adapters and the state-daemon slot budget
 * each parsed timeout envs with different precedence (Codex read AUN vars
 * only, Claude read AUN-then-STATE, the daemon read STATE vars only). An
 * operator setting `AUN_QUEUE_WORK_CODEX_TIMEOUT_MS=2400000` gave the child
 * a 40-minute budget while the daemon believed 10 minutes — and the
 * self-liveness slot wedge would exit(1) killing healthy children
 * (GR-DEVAUDITOR-958-POSTIMPL-L2-20260830-003, dynamic probe).
 *
 * This resolver is the single source of truth for both sides:
 *   - runner adapters take their child timeout from resolveEngineTimeoutMs
 *   - the daemon slot-wedge budget takes maxLegitimateRunnerTimeoutMs
 * so the two cannot structurally diverge.
 *
 * Canonical precedence, per engine (documented in spec §13.5.5):
 *   engine-specific beats generic; within each tier AUN beats STATE:
 *   AUN_<ENGINE> > STATE_<ENGINE> > AUN_generic > STATE_generic > default.
 *
 * Fail-closed contract: a value that is set but not a positive integer is a
 * typed error — never a silent default. The daemon rejects it at startup
 * (before DB connect); a standalone runner surfaces it as a typed
 * configuration failure instead of running with a wrong budget.
 */

export const QUEUE_WORK_DEFAULT_TIMEOUT_MS = 600_000

export type QueueWorkEngine = 'codex' | 'claude' | 'generic'

export interface QueueWorkTimeoutResolution {
  codexMs: number
  claudeMs: number
  genericMs: number
  /** The largest legitimate child lifetime — the daemon slot-wedge budget. */
  maxLegitimateRunnerTimeoutMs: number
  /** Typed parse failures (env name + offending value). Empty when clean. */
  errors: string[]
}

function parseStrictPositiveInt(name: string, raw: string | undefined, errors: string[]): number | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  const value = Number(trimmed)
  if (
    trimmed === ''
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value <= 0
    || String(value) !== trimmed
  ) {
    errors.push(`${name} must be a positive integer (got ${JSON.stringify(raw)})`)
    return null
  }
  return value
}

/** Resolve every engine budget plus the daemon slot budget from one env. */
export function resolveQueueWorkTimeouts(env: NodeJS.ProcessEnv): QueueWorkTimeoutResolution {
  const errors: string[] = []
  const read = (name: string) => parseStrictPositiveInt(name, env[name], errors)

  const aunCodex = read('AUN_QUEUE_WORK_CODEX_TIMEOUT_MS')
  const stateCodex = read('STATE_DAEMON_QUEUE_WORK_CODEX_TIMEOUT_MS')
  const aunClaude = read('AUN_QUEUE_WORK_CLAUDE_TIMEOUT_MS')
  const stateClaude = read('STATE_DAEMON_QUEUE_WORK_CLAUDE_TIMEOUT_MS')
  const aunGeneric = read('AUN_QUEUE_WORK_TIMEOUT_MS')
  const stateGeneric = read('STATE_DAEMON_QUEUE_WORK_TIMEOUT_MS')

  const genericMs = aunGeneric ?? stateGeneric ?? QUEUE_WORK_DEFAULT_TIMEOUT_MS
  const codexMs = aunCodex ?? stateCodex ?? genericMs
  const claudeMs = aunClaude ?? stateClaude ?? genericMs

  return {
    codexMs,
    claudeMs,
    genericMs,
    maxLegitimateRunnerTimeoutMs: Math.max(codexMs, claudeMs, genericMs),
    errors,
  }
}

/**
 * Child-side accessor. Throws a typed error on malformed configuration so a
 * runner never executes against a budget the daemon cannot have validated.
 */
export function resolveEngineTimeoutMs(env: NodeJS.ProcessEnv, engine: QueueWorkEngine): number {
  const resolution = resolveQueueWorkTimeouts(env)
  if (resolution.errors.length > 0) {
    throw new Error(`QUEUE_WORK_TIMEOUT_CONFIG_INVALID: ${resolution.errors.join('; ')}`)
  }
  if (engine === 'codex') return resolution.codexMs
  if (engine === 'claude') return resolution.claudeMs
  return resolution.genericMs
}
