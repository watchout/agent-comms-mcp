/**
 * ConfigPort (X1, incident #339 series cleanup).
 *
 * Single point that production code goes through for environment- and
 * config-derived facts. Direct `process.env` reads and `'TUI'` /
 * `'claude-code'` literal comparisons in production code are forbidden by
 * spec §3.1-§3.2; callers route through this port instead. Tests can
 * substitute their own implementation via the exported interface.
 *
 * Spec: iyasaka-arc/agent-comms-mcp/specs/draft/2026-05-12-X1-config-port-bot-inventory-abstraction-instruction.md
 * (HEAD `d0e2f4b`, auditor cycle 2 LGTM 7/7, CEO directive `ac60550a` option A)
 */

export const DESTRUCTIVE_GATE_ENV = 'AGENT_COMMS_DESTRUCTIVE_MIGRATIONS_ALLOWED'
export const RUNTIME_ENV = 'AGENT_RUNTIME'
export const DEFAULT_RUNTIME = 'TUI' as const

export type RuntimeIdentifier = 'TUI' | 'claude-code'

export interface ConfigPort {
  /**
   * Reads the destructive-migration env flag. Throw-free; an unset or
   * unrecognised value resolves to `{ allowed: false, rawValue: null/<raw> }`,
   * preserving PR #340's fail-closed default.
   */
  getDestructiveMigrationFlagState(): { allowed: boolean; rawValue: string | null }

  /**
   * Identifier of the current process's runtime. Throw-free; any unset /
   * unrecognised value resolves to `DEFAULT_RUNTIME`.
   */
  getRuntimeIdentifier(): RuntimeIdentifier

  /** Always returns `DEFAULT_RUNTIME` (PR #341 anchor). */
  getDefaultRuntime(): 'TUI'
}

function readDestructiveFlag(envValue: string | undefined): {
  allowed: boolean
  rawValue: string | null
} {
  if (envValue === undefined) return { allowed: false, rawValue: null }
  return { allowed: envValue === '1', rawValue: envValue }
}

function readRuntimeIdentifier(envValue: string | undefined): RuntimeIdentifier {
  if (envValue === 'TUI' || envValue === 'claude-code') return envValue
  return DEFAULT_RUNTIME
}

export function createDefaultConfigPort(): ConfigPort {
  return {
    getDestructiveMigrationFlagState() {
      return readDestructiveFlag(process.env[DESTRUCTIVE_GATE_ENV])
    },
    getRuntimeIdentifier() {
      return readRuntimeIdentifier(process.env[RUNTIME_ENV])
    },
    getDefaultRuntime() {
      return DEFAULT_RUNTIME
    },
  }
}

/**
 * Production singleton — convenient for callers that do not need to inject a
 * test double. Reads `process.env` at every call (no internal cache) so tests
 * that mutate the env between assertions still observe the new state.
 */
export const defaultConfigPort: ConfigPort = createDefaultConfigPort()
