/**
 * Per-agent LLM adapter profile selection.
 *
 * Maps runtime_engine_preference values to RuntimeInvocationProfile so the
 * state-daemon can dispatch each agent through the correct headless runtime
 * (Codex, Claude Code, or future runtimes) without hardcoding provider logic
 * in the scheduling loop.
 *
 * Capability boundary (from llm-runtime-adapter-boundary.md):
 *   - Adapters expose capabilities, not assumptions
 *   - Queue state transitions stay in the runner, not the adapter
 *   - Profile config comes from env; no DB reads here
 */

import type { RuntimeInvocationProfile } from './host-runtime-invocation'

const CLAUDE_CODE_RUNTIME_KEYS = new Set([
  'claude-code', 'claude', 'CLAUDE', 'CLAUDE_CODE',
])

const CODEX_RUNTIME_KEYS = new Set([
  'codex', 'codex-runner', 'CODEX', 'CODEX_RUNNER',
])

function envInt(key: string, fallback: number): number {
  const v = process.env[key]
  if (!v) return fallback
  const n = parseInt(v, 10)
  return isNaN(n) ? fallback : n
}

function envList(key: string, fallback: string[]): string[] {
  const v = process.env[key]
  if (!v) return fallback
  return v.split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Build a RuntimeInvocationProfile for the Claude Code headless runtime.
 *
 * Required env (at least one should be set for real invocations):
 *   STATE_DAEMON_CLAUDE_BIN          — path to claude binary (default: 'claude')
 *   STATE_DAEMON_CLAUDE_CWD          — working directory (default: process.cwd())
 *   STATE_DAEMON_CLAUDE_ALLOWED_DIRS — comma-separated dirs (default: cwd only)
 *   STATE_DAEMON_CLAUDE_TIMEOUT_MS   — timeout in ms (default: 120000)
 *   STATE_DAEMON_CLAUDE_MCP_CONFIG   — path to .mcp.json (optional)
 *   STATE_DAEMON_CLAUDE_ALLOWED_TOOLS — comma-separated tool allowlist (optional)
 *   STATE_DAEMON_CLAUDE_PERMISSION_MODE — permission mode (default: 'default')
 */
function buildClaudeCodeProfile(): RuntimeInvocationProfile {
  const cwd = process.env.STATE_DAEMON_CLAUDE_CWD ?? process.cwd()
  return {
    profile_id: 'claude-code-agent',
    runtime: 'claude',
    cwd,
    allowed_dirs: envList('STATE_DAEMON_CLAUDE_ALLOWED_DIRS', [cwd]),
    prompt_delivery: 'prompt-arg',
    output_stream: 'json',
    sandbox: 'workspace-write',
    approval_mode: process.env.STATE_DAEMON_CLAUDE_PERMISSION_MODE ?? 'default',
    allowed_tools: envList('STATE_DAEMON_CLAUDE_ALLOWED_TOOLS', []),
    mcp_config_ref: process.env.STATE_DAEMON_CLAUDE_MCP_CONFIG,
    env_allowlist: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'HOME',
      'PATH',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'DATABASE_URL',
      'AGENT_ID',
    ],
    secret_policy: 'none',
    timeout_ms: envInt('STATE_DAEMON_CLAUDE_TIMEOUT_MS', 120_000),
    degraded_tui_fallback_allowed: false,
  }
}

/**
 * Build a RuntimeInvocationProfile for the Codex headless runtime.
 * Codex agents are handled by the legacy bun codex-runner path when
 * hostRuntimeAdapterEnabled is false, so this profile is used only when
 * the host-runtime adapter is enabled for Codex too.
 */
function buildCodexProfile(): RuntimeInvocationProfile {
  const cwd = process.env.STATE_DAEMON_CODEX_CWD ?? process.cwd()
  return {
    profile_id: 'codex-agent',
    runtime: 'codex',
    cwd,
    allowed_dirs: envList('STATE_DAEMON_CODEX_ALLOWED_DIRS', [cwd]),
    prompt_delivery: 'stdin-json',
    output_stream: 'jsonl',
    sandbox: 'workspace-write',
    env_allowlist: [
      'OPENAI_API_KEY',
      'HOME',
      'PATH',
      'TMPDIR',
      'DATABASE_URL',
      'AGENT_ID',
    ],
    secret_policy: 'none',
    timeout_ms: envInt('STATE_DAEMON_CODEX_TIMEOUT_MS', 120_000),
    degraded_tui_fallback_allowed: false,
  }
}

export type AdapterKind = 'claude-code' | 'codex' | 'none'

export interface AgentAdapterSelection {
  kind: AdapterKind
  /** Set for claude-code and codex (host-runtime path); null for legacy bun runner */
  profile: RuntimeInvocationProfile | null
}

/**
 * Select the appropriate adapter profile for an agent based on its
 * runtime_engine_preference value.
 *
 * Returns `kind: 'none'` for unknown or unset preferences, which causes
 * the caller to fall through to the legacy codex-runner bun path.
 */
export function selectAgentAdapter(runtimeEnginePreference: string | null | undefined): AgentAdapterSelection {
  const pref = runtimeEnginePreference?.trim() ?? null
  if (!pref) return { kind: 'none', profile: null }

  if (CLAUDE_CODE_RUNTIME_KEYS.has(pref)) {
    return { kind: 'claude-code', profile: buildClaudeCodeProfile() }
  }
  if (CODEX_RUNTIME_KEYS.has(pref)) {
    return { kind: 'codex', profile: buildCodexProfile() }
  }
  return { kind: 'none', profile: null }
}
