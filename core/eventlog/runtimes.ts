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

/** Spawn seam — production uses Bun.spawn; fixtures inject canned results. */
export interface HeadlessInvoker {
  run(cmd: string[], opts?: { timeoutMs?: number }): Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

export const bunInvoker: HeadlessInvoker = {
  async run(cmd, opts) {
    const proc = Bun.spawn({ cmd, stdout: 'pipe', stderr: 'pipe' })
    const timeoutMs = opts?.timeoutMs ?? 180_000
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
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
  if (typeof v.ok !== 'boolean') return null
  if (v.outcome !== 'replied' && v.outcome !== 'no_reply') return null
  if (v.reply !== null && typeof v.reply !== 'string') return null
  if (v.outcome === 'replied' && (v.reply === null || v.reply.trim() === '')) return null
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
}): TurnRuntime {
  const invoker = opts.invoker ?? bunInvoker
  return {
    async runTurn({ seatId, turn, payload }) {
      const envelope = await envelopeFor(opts.db, turn, payload)
      const prompt = buildTurnPrompt(seatId, envelope)
      const r = await invoker.run([
        opts.codexBin ?? 'codex', 'exec',
        '--output-schema', opts.schemaPath,
        '--sandbox', opts.sandbox ?? 'read-only',
        '--ephemeral',
        prompt,
      ], { timeoutMs: opts.timeoutMs })
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
}): TurnRuntime {
  const invoker = opts.invoker ?? bunInvoker
  return {
    async runTurn({ seatId, turn, payload }) {
      const envelope = await envelopeFor(opts.db, turn, payload)
      const prompt = buildTurnPrompt(seatId, envelope)
      const r = await invoker.run([
        opts.claudeBin ?? 'claude', '-p', prompt,
        '--output-format', 'json',
      ], { timeoutMs: opts.timeoutMs })
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
