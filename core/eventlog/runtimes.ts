// EventLogCore/v1 — headless LLM runtime adapters for the V2 seat worker
// (cutover M3.5). Engine symmetry by construction: codex (`codex exec`)
// and Claude Code (`claude -p`) bind to the SAME TurnRuntime seam with the
// SAME strict result contract. Which engine a seat uses is configuration
// (agents.metadata runtime_engine), not architecture — the runtime-switch
// continuity fixture is the proof the log does not care.
//
// Fail-closed rule: an adapter NEVER fabricates a reply. Any invocation
// failure, timeout, or contract-violating output becomes outcome 'failed'
// with the diagnostic in summary — the turn terminal-closes and the log
// shows exactly what happened.

import type { TurnRuntime, TurnRuntimeResult } from './worker'
import { parseEventPayload, type QueueViewRow } from './types'
import type { DbAdapter } from '../db/adapter'
import { turnInboundPayload } from './worker'
import { decodeV2NativeInboundPayload } from './v2-native-ingress'
import {
  resolveRuntimeBinding,
  RuntimeBindingResolutionError,
  type ResolvedRuntimeBindingV1,
} from './runtime-binding'

export interface RuntimeSpawnOptions {
  timeoutMs?: number
  cwd: string
  env: Record<string, string>
  allowedTools: readonly string[]
  sandboxProfile: string
  signal?: AbortSignal
}

export class RuntimeTimeoutError extends Error {
  readonly code = 'RUNTIME_TIMEOUT' as const
}

export class UnknownRuntimeEngineError extends Error {
  readonly code = 'RUNTIME_ENGINE_UNADMITTED' as const
}

/** Spawn seam — production uses Bun.spawn; fixtures inject canned results. */
export interface HeadlessInvoker {
  run(cmd: string[], opts?: RuntimeSpawnOptions): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

interface BunRuntimeProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal: string): void
}

interface BunRuntime {
  spawn(options: {
    cmd: string[]
    cwd: string
    env: Record<string, string>
    stdout: 'pipe'
    stderr: 'pipe'
  }): BunRuntimeProcess
}

export const bunInvoker: HeadlessInvoker = {
  async run(cmd, opts) {
    if (!opts?.cwd || !opts.env || !opts.sandboxProfile) {
      throw new Error('runtime spawn requires explicit cwd, env and sandbox profile')
    }
    const runtime = (globalThis as unknown as { Bun?: BunRuntime }).Bun
    if (!runtime) throw new Error('Bun runtime is required for production child invocation')
    const proc = runtime.spawn({ cmd, cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' })
    const timeoutMs = opts?.timeoutMs ?? 180_000
    let timedOut = false
    let aborted = false
    const abort = () => {
      aborted = true
      proc.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
    })
    if (timedOut) throw new RuntimeTimeoutError(`runtime exceeded ${timeoutMs}ms and was killed`)
    if (aborted) throw new RuntimeTimeoutError('runtime was cancelled by the seat supervision fence')
    return { exitCode, stdout, stderr }
  },
}

/**
 * The per-turn result contract, strict-structured-output compliant
 * (every key required; optionality via null — the invalid_json_schema
 * lesson from the CP80 canary, #846).
 */
export const V2_TURN_RESULT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'AUN v2_turn_result_v1',
  type: 'object',
  required: ['ok', 'outcome', 'reply'],
  properties: {
    ok: { type: 'boolean' },
    outcome: { type: 'string', enum: ['replied', 'no_reply'] },
    reply: { type: ['string', 'null'] },
  },
  additionalProperties: false,
} as const

export interface TurnResultShape {
  ok: boolean
  outcome: 'replied' | 'no_reply'
  reply: string | null
}

/** Strict fail-closed parse of the model's final message. */
export function parseTurnResult(text: string): TurnResultShape | null {
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const keys = Object.keys(v).sort()
  if (keys.join(',') !== 'ok,outcome,reply') return null
  // ok !== true is the model asserting failure — fail closed (audit
  // 4930621767): an ok:false result must NEVER become a replied turn or
  // enqueue a reply, regardless of the rest of the shape.
  if (v.ok !== true) return null
  if (v.outcome !== 'replied' && v.outcome !== 'no_reply') return null
  const reply = v.reply
  if (v.outcome === 'replied') {
    if (typeof reply !== 'string' || reply.trim() === '') return null
  } else if (reply !== null) {
    return null
  }
  return v as unknown as TurnResultShape
}

export function buildTurnPrompt(seatId: string, envelope: Record<string, unknown>): string {
  const author = envelope.author_id ?? envelope.author_name ?? 'unknown'
  const channel = envelope.thread_id ?? envelope.channel_id ?? 'unknown'
  const content = typeof envelope.content === 'string' ? envelope.content : JSON.stringify(envelope)
  return [
    `You are agent seat "${seatId}" processing ONE inbound message from your work queue.`,
    `Channel/thread: ${channel}`,
    `From: ${author}`,
    `Message:`,
    content,
    ``,
    `Decide whether a reply is needed. Do not perform any external actions.`,
    `Respond with ONLY a JSON object of this exact shape (no prose, no markdown fence):`,
    `{"ok": true, "outcome": "replied" | "no_reply", "reply": "<reply text>" | null}`,
  ].join('\n')
}

function failed(summary: string): TurnRuntimeResult {
  return { outcome: 'failed', summary: summary.slice(0, 2000) }
}

function toRuntimeResult(parsed: TurnResultShape, envelope: Record<string, unknown>): TurnRuntimeResult {
  if (parsed.outcome === 'no_reply') return { outcome: 'no_reply' }
  return {
    outcome: 'replied',
    replies: [{
      content: parsed.reply!,
      channelExternalId: (envelope.thread_id as string | null) ?? (envelope.channel_id as string | null) ?? null,
    }],
  }
}

async function envelopeFor(db: DbAdapter, turn: QueueViewRow, payload: Record<string, unknown>) {
  // worker passes {message_id}; the full inbound envelope rides on the
  // receive event written by the M1 dual-write
  const full = await turnInboundPayload(db, turn)
  return { ...payload, ...parseEventPayload<Record<string, unknown>>(full) }
}

/**
 * Codex engine: `codex exec` with a schema-constrained final message
 * (the CP80-proven invocation shape).
 */
export function codexExecRuntime(opts: {
  db: DbAdapter
  invoker?: HeadlessInvoker
  codexBin?: string
  schemaPath: string
  sandbox?: string
  timeoutMs?: number
  spawnOptions?: Omit<RuntimeSpawnOptions, 'timeoutMs'>
}): TurnRuntime {
  const invoker = opts.invoker ?? bunInvoker
  return {
    async runTurn({ seatId, turn, payload, signal }) {
      const envelope = await envelopeFor(opts.db, turn, payload)
      const prompt = buildTurnPrompt(seatId, envelope)
      const exactCodexTools = ['apply_patch', 'exec_command'] as const
      if (!opts.spawnOptions && invoker === bunInvoker) {
        throw new RuntimeBindingResolutionError(
          'RUNTIME_POLICY_UNVERIFIED',
          'production Codex invocation requires a signed RuntimeSpawnOptions tool binding',
        )
      }
      // Compatibility-only fake invokers used by pre-K2 deterministic tests
      // have no production child. A real bunInvoker must always arrive through
      // runtimeForBinding with the signed exact list above.
      const allowedTools = opts.spawnOptions?.allowedTools ?? exactCodexTools
      if (
        allowedTools.length !== exactCodexTools.length ||
        exactCodexTools.some((tool, index) => allowedTools[index] !== tool)
      ) {
        throw new RuntimeBindingResolutionError(
          'RUNTIME_POLICY_UNVERIFIED',
          `Codex tool restriction is unrepresented: expected ${exactCodexTools.join(',')}, received ${allowedTools.join(',')}`,
        )
      }
      const r = await invoker.run([
        opts.codexBin ?? 'codex', 'exec',
        '--strict-config',
        '--ignore-user-config',
        '-c', 'web_search="disabled"',
        '-c', 'mcp_servers={}',
        '-c', 'plugins={}',
        '--disable', 'apps',
        '--disable', 'auth_elicitation',
        '--disable', 'browser_use',
        '--disable', 'browser_use_external',
        '--disable', 'browser_use_full_cdp_access',
        '--disable', 'computer_use',
        '--disable', 'goals',
        '--disable', 'guardian_approval',
        '--disable', 'hooks',
        '--disable', 'image_generation',
        '--disable', 'in_app_browser',
        '--disable', 'multi_agent',
        '--disable', 'multi_agent_v2',
        '--disable', 'plugins',
        '--disable', 'remote_plugin',
        '--disable', 'request_permissions_tool',
        '--disable', 'shell_tool',
        '--disable', 'skill_mcp_dependency_install',
        '--disable', 'tool_call_mcp_elicitation',
        '--disable', 'tool_suggest',
        '--disable', 'workspace_dependencies',
        '--enable', 'unified_exec',
        '--cd', opts.spawnOptions?.cwd ?? process.cwd(),
        '--output-schema', opts.schemaPath,
        '--sandbox', opts.sandbox ?? 'read-only',
        '--ephemeral',
        prompt,
      ], {
        timeoutMs: opts.timeoutMs,
        cwd: opts.spawnOptions?.cwd ?? process.cwd(),
        env: opts.spawnOptions?.env ?? {},
        allowedTools,
        sandboxProfile: opts.spawnOptions?.sandboxProfile ?? opts.sandbox ?? 'read-only',
        signal,
      })
      if (r.exitCode !== 0) {
        return failed(`codex exec exited ${r.exitCode}: ${r.stderr || r.stdout}`)
      }
      // codex exec prints the final message as the last non-empty stdout line
      const lines = r.stdout.trim().split('\n').filter(l => l.trim() !== '')
      const parsed = parseTurnResult(lines[lines.length - 1] ?? '')
      if (!parsed) return failed(`codex exec output violated v2_turn_result_v1: ${lines[lines.length - 1] ?? '(empty)'}`)
      return toRuntimeResult(parsed, envelope)
    },
  }
}

/**
 * Claude Code engine: `claude -p --output-format json`. The wrapper JSON's
 * `result` field carries the model's final text, which must itself be the
 * strict v2_turn_result_v1 object. Invocation layer verified on this host
 * 2026-07-09 (smoke: exact round-trip, is_error=false).
 */
export function claudeCodeRuntime(opts: {
  db: DbAdapter
  invoker?: HeadlessInvoker
  claudeBin?: string
  timeoutMs?: number
  spawnOptions?: Omit<RuntimeSpawnOptions, 'timeoutMs'>
}): TurnRuntime {
  const invoker = opts.invoker ?? bunInvoker
  return {
    async runTurn({ seatId, turn, payload, signal }) {
      const envelope = await envelopeFor(opts.db, turn, payload)
      const prompt = buildTurnPrompt(seatId, envelope)
      const r = await invoker.run([
        opts.claudeBin ?? 'claude', '-p', prompt,
        '--output-format', 'json',
        '--no-session-persistence',
        '--safe-mode',
        '--strict-mcp-config',
        '--mcp-config', '{}',
        '--permission-mode', opts.spawnOptions?.sandboxProfile ?? 'dontAsk',
        '--tools', (opts.spawnOptions?.allowedTools ?? []).join(','),
        '--allowedTools', (opts.spawnOptions?.allowedTools ?? []).join(','),
      ], {
        timeoutMs: opts.timeoutMs,
        cwd: opts.spawnOptions?.cwd ?? process.cwd(),
        env: opts.spawnOptions?.env ?? {},
        allowedTools: opts.spawnOptions?.allowedTools ?? [],
        sandboxProfile: opts.spawnOptions?.sandboxProfile ?? 'dontAsk',
        signal,
      })
      if (r.exitCode !== 0) {
        return failed(`claude -p exited ${r.exitCode}: ${r.stderr || r.stdout}`)
      }
      let wrapper: any
      try {
        wrapper = JSON.parse(r.stdout.trim())
      } catch {
        return failed(`claude -p emitted non-JSON wrapper: ${r.stdout.slice(0, 300)}`)
      }
      if (wrapper?.is_error === true || typeof wrapper?.result !== 'string') {
        return failed(`claude -p wrapper error: ${JSON.stringify(wrapper).slice(0, 300)}`)
      }
      const parsed = parseTurnResult(wrapper.result)
      if (!parsed) return failed(`claude -p result violated v2_turn_result_v1: ${wrapper.result.slice(0, 300)}`)
      return toRuntimeResult(parsed, envelope)
    },
  }
}

/** Engine selection by seat configuration — symmetry is one switch, not code. */
export function runtimeForEngine(
  engine: string | null | undefined,
  deps: { db: DbAdapter; schemaPath: string; invoker?: HeadlessInvoker },
): TurnRuntime {
  if ((engine ?? '').toLowerCase().includes('claude')) {
    return claudeCodeRuntime({ db: deps.db, invoker: deps.invoker })
  }
  return codexExecRuntime({ db: deps.db, schemaPath: deps.schemaPath, invoker: deps.invoker })
}

function allowlistedEnvironment(
  binding: ResolvedRuntimeBindingV1,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of binding.allowed_env_keys) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Strict K2 runtime selection from an already resolved exact binding. */
export function runtimeForBinding(
  binding: ResolvedRuntimeBindingV1,
  deps: {
    db: DbAdapter
    schemaPath: string
    invoker?: HeadlessInvoker
    parentEnv?: Record<string, string | undefined>
    timeoutMs?: number
    codexBin?: string
    claudeBin?: string
  },
): TurnRuntime {
  if (binding.model_adapter !== 'codex' && binding.model_adapter !== 'claude_code') {
    throw new UnknownRuntimeEngineError(`model adapter ${(binding as { model_adapter?: unknown }).model_adapter} is not admitted`)
  }
  const resolved = resolveRuntimeBinding({ binding })
  const admittedProfiles = resolved.model_adapter === 'codex'
    ? ['read-only', 'workspace-write']
    : ['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']
  if (!admittedProfiles.includes(resolved.sandbox_profile)) {
    throw new RuntimeBindingResolutionError(
      'RUNTIME_POLICY_UNVERIFIED',
      `${resolved.model_adapter} sandbox_profile ${resolved.sandbox_profile} is not mechanically admitted`,
    )
  }
  const spawnOptions: Omit<RuntimeSpawnOptions, 'timeoutMs'> = {
    cwd: resolved.workspace_realpath,
    env: allowlistedEnvironment(resolved, deps.parentEnv ?? process.env),
    allowedTools: resolved.allowed_tools,
    sandboxProfile: resolved.sandbox_profile,
  }
  if (resolved.model_adapter === 'codex') {
    return codexExecRuntime({
      db: deps.db,
      schemaPath: deps.schemaPath,
      invoker: deps.invoker,
      codexBin: deps.codexBin,
      sandbox: resolved.sandbox_profile,
      timeoutMs: deps.timeoutMs,
      spawnOptions,
    })
  }
  if (resolved.model_adapter === 'claude_code') {
    return claudeCodeRuntime({
      db: deps.db,
      invoker: deps.invoker,
      claudeBin: deps.claudeBin,
      timeoutMs: deps.timeoutMs,
      spawnOptions,
    })
  }
  throw new UnknownRuntimeEngineError(`model adapter ${(resolved as { model_adapter?: unknown }).model_adapter} is not admitted`)
}

/**
 * S0 deterministic runtime fixture.  It can choose only typed outcome and
 * content; recipient resolution remains in the internal-handoff adapter.
 */
export function deterministicV2NativeMeshRuntime(
  render: (input: { seatId: string; sourceAgentId: string; content: string }) => string | null,
): TurnRuntime {
  return {
    async runTurn({ seatId, payload }) {
      const inbound = decodeV2NativeInboundPayload(payload)
      const content = render({
        seatId,
        sourceAgentId: inbound.source_agent_id,
        content: inbound.content,
      })
      if (content === null) return { outcome: 'no_reply' }
      return { outcome: 'replied', replies: [{ content, channelExternalId: null }] }
    },
  }
}
