import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** A memory namespace is a seat/project, never a provider, session or cwd. */
export type SeatMemoryIdentity = { agentId: string; project: string }
export type SeatMemoryTransport = { command: string; args: string[]; env: Record<string, string> }
export type SeatHostRuntime = 'codex' | 'claude'
export type SeatHostContext = {
  context_id: string
  pack_id: string
  target_runtime: SeatHostRuntime
  delivery_mode: string
  trusted_instruction: string
  untrusted_context_policy: 'quote-as-data-only'
  schema_ref: string
  context_data: {
    pack_id: string
    project: string
    generated_at: string
    items: Array<{ item_id: string; kind: string; source_ref: string; summary: string; [key: string]: unknown }>
    missing_context: string[]
    [key: string]: unknown
  }
}

export type SeatContextReceipt = {
  schema_version: 'seat-context-consumption/v1'
  agent_id: string
  project: string
  runtime_instance_id: string
  target_runtime: SeatHostRuntime
  pack_id: string
  response_digest: string
  work_digest: string
  invocation_digest: string
  transport_binding_digest: string
  completed_at: string
  native_delivery?: NativeSeatContextDelivery
  consumption: { runtime_instance_id: string; invocation_digest: string; consumer: string }
}

export class SeatContextRecoveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SeatContextRecoveryError' }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export function seatContextDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function assertIdentity(identity: SeatMemoryIdentity): void {
  // Colon delimits the existing Wasurezu restart_pack identity. Reject ambiguous
  // identifiers instead of interpreting a foreign pack as this seat's context.
  if (![identity.agentId, identity.project].every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && !/[:\r\n\0]/.test(value))) {
    throw new SeatContextRecoveryError('MEMORY_TARGET_IDENTITY_INVALID')
  }
}

export function bindSeatMemoryTransport(transport: SeatMemoryTransport, identity: SeatMemoryIdentity): SeatMemoryTransport {
  assertIdentity(identity)
  if (!transport.command?.trim() || !Array.isArray(transport.args) || transport.args.some(arg => typeof arg !== 'string')) {
    throw new SeatContextRecoveryError('MEMORY_TRANSPORT_INVALID')
  }
  return {
    command: transport.command,
    args: [...transport.args],
    env: { ...transport.env, AGENT_MEMORY_AGENT_ID: identity.agentId, AGENT_MEMORY_PROJECT: identity.project },
  }
}

export function validateSeatHostContext(value: unknown, identity: SeatMemoryIdentity, targetRuntime: SeatHostRuntime): SeatHostContext {
  assertIdentity(identity)
  const context = value as SeatHostContext | null
  const pack = context?.context_data
  if (!context || typeof context !== 'object' || !pack || !Array.isArray(pack.items)
    || !Array.isArray(pack.missing_context) || !Number.isFinite(Date.parse(pack.generated_at))) {
    throw new SeatContextRecoveryError('MEMORY_RECOVERY_SCHEMA_INVALID')
  }
  const prefix = `restart_pack:${identity.agentId}:${identity.project}:`
  if (pack.project !== identity.project || !pack.pack_id?.startsWith(prefix)
    || !/^\d+$/.test(pack.pack_id.slice(prefix.length)) || context.pack_id !== pack.pack_id
    || context.context_id !== `host_context:${pack.pack_id}`) {
    throw new SeatContextRecoveryError('MEMORY_RECOVERY_IDENTITY_MISMATCH')
  }
  if (context.target_runtime !== targetRuntime || context.untrusted_context_policy !== 'quote-as-data-only'
    || typeof context.trusted_instruction !== 'string' || !context.trusted_instruction.trim()
    || !['stdin-json', 'system-prompt-fragment', 'append-system-prompt-fragment', 'session-start-hook'].includes(context.delivery_mode)
    || typeof context.schema_ref !== 'string' || !context.schema_ref.includes('host-invocation-context')) {
    throw new SeatContextRecoveryError('MEMORY_HOST_INVOCATION_MISMATCH')
  }
  if (pack.items.some(item => !item || typeof item.item_id !== 'string' || !item.item_id
    || typeof item.source_ref !== 'string' || !item.source_ref || typeof item.summary !== 'string')) {
    throw new SeatContextRecoveryError('MEMORY_RECOVERY_SCHEMA_INVALID')
  }
  // The existing structured contract carries objective/progress/next action in
  // current_task.summary. Empty or text-only recovery cannot mark a working seat
  // ready. A seat with no durable objective has an explicit recovery step.
  const tasks = pack.items.filter(item => item.kind === 'current_task')
  if (tasks.length === 0 || !tasks.some(item => item.summary.trim() && /\bNext:\s*\S/.test(item.summary))) {
    throw new SeatContextRecoveryError('MEMORY_CONTINUATION_INCOMPLETE')
  }
  if (pack.missing_context.some(item => /objective|next.action|current.task|identity|project/i.test(String(item)))) {
    throw new SeatContextRecoveryError('MEMORY_CONTINUATION_INCOMPLETE')
  }
  return context
}

export function validateSeatContextReceipt(value: unknown, expected: SeatMemoryIdentity & { runtimeInstanceId: string }): boolean {
  const receipt = value as SeatContextReceipt | null
  const digest = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input)
  return !!receipt && receipt.schema_version === 'seat-context-consumption/v1'
    && receipt.agent_id === expected.agentId && receipt.project === expected.project
    && receipt.runtime_instance_id === expected.runtimeInstanceId
    && ['codex', 'claude'].includes(receipt.target_runtime)
    && typeof receipt.pack_id === 'string' && receipt.pack_id.startsWith(`restart_pack:${expected.agentId}:${expected.project}:`)
    && [receipt.response_digest, receipt.work_digest, receipt.invocation_digest, receipt.transport_binding_digest].every(digest)
    && Number.isFinite(Date.parse(receipt.completed_at))
    && receipt.consumption?.runtime_instance_id === expected.runtimeInstanceId
    && receipt.consumption.invocation_digest === receipt.invocation_digest
    && typeof receipt.consumption.consumer === 'string' && receipt.consumption.consumer.trim().length > 0
}

export type SeatContextConsumer = (input: {
  context: SeatHostContext
  runtimeInstanceId: string
  invocationDigest: string
}) => Promise<{ runtime_instance_id: string; invocation_digest: string; consumer: string }>

export type SeatMemoryClient = {
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

export type SeatContextRecoveryInput = SeatMemoryIdentity & {
  transport: SeatMemoryTransport
  runtimeInstanceId: string
  targetRuntime: SeatHostRuntime
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** Test seam; production uses the configured local MCP stdio transport. */
  connect?: (transport: SeatMemoryTransport, options: { cwd: string; env: Record<string, string> }) => Promise<SeatMemoryClient>
}

export type PreparedSeatContext = {
  context: SeatHostContext
  identity: SeatMemoryIdentity
  runtimeInstanceId: string
  targetRuntime: SeatHostRuntime
  responseDigest: string
  workDigest: string
  transportBindingDigest: string
  toolCount: number
  contentCount: number
}

export async function prepareSeatContext(input: SeatContextRecoveryInput): Promise<PreparedSeatContext> {
  if (input.signal?.aborted) throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED')
  const transport = bindSeatMemoryTransport(input.transport, input)
  if (!input.runtimeInstanceId?.trim() || !['codex', 'claude'].includes(input.targetRuntime)) throw new SeatContextRecoveryError('MEMORY_RUNTIME_IDENTITY_INVALID')
  const env = { ...input.env, ...transport.env }
  let client: SeatMemoryClient | undefined
  let closed = false
  const close = async () => { closed = true; await client?.close().catch(() => {}) }
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const deadlineMs = Math.min(Math.max(input.timeoutMs ?? 30_000, 1), 30_000)
  const operation = async () => {
    const connected = input.connect
      ? await input.connect(transport, { cwd: input.cwd, env })
      : await connectMemoryClient(transport, input.cwd, env, connected => { client = connected })
    client = connected
    if (closed) { await connected.close(); throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED') }
    const tools = await client.listTools()
    if (!['recover_context', 'restart_pack'].every(name => tools.tools.some(tool => tool.name === name))) throw new SeatContextRecoveryError('MEMORY_RECOVERY_TOOLS_MISSING')
    const recovered = await client.callTool({ name: 'recover_context', arguments: { project: input.project } }) as any
    if (recovered?.isError || !Array.isArray(recovered?.content) || recovered.content.length === 0) throw new SeatContextRecoveryError('MEMORY_RECOVERY_FAILED')
    const response = await client.callTool({ name: 'restart_pack', arguments: {
      project: input.project, format: 'host-invocation-context-v1', target_runtime: input.targetRuntime,
      untrusted_context_policy: 'quote-as-data-only',
    } }) as any
    if (response?.isError || !Array.isArray(response?.content)) throw new SeatContextRecoveryError('MEMORY_RECOVERY_FAILED')
    const texts = response.content.filter((item: any) => item.type === 'text' && typeof item.text === 'string')
    if (texts.length !== 1) throw new SeatContextRecoveryError('MEMORY_RECOVERY_SCHEMA_INVALID')
    let value: unknown
    try { value = JSON.parse(texts[0].text) } catch { throw new SeatContextRecoveryError('MEMORY_RECOVERY_SCHEMA_INVALID') }
    const context = validateSeatHostContext(value, input, input.targetRuntime)
    if (closed) throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED')
    return {
      context, identity: { agentId: input.agentId, project: input.project },
      runtimeInstanceId: input.runtimeInstanceId, targetRuntime: input.targetRuntime,
      responseDigest: seatContextDigest(response),
      workDigest: seatContextDigest(context.context_data.items.map(item => ({ id: item.item_id, kind: item.kind, source_ref: item.source_ref, summary: item.summary })).sort((a, b) => a.id.localeCompare(b.id))),
      // Credentials are never emitted in a recovery receipt.
      transportBindingDigest: seatContextDigest({ command: transport.command, args: transport.args, agent_id: input.agentId, project: input.project }),
      toolCount: tools.tools.length, contentCount: response.content.length,
    }
  }
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      const stop = (code: string) => { void close(); reject(new SeatContextRecoveryError(code)) }
      timer = setTimeout(() => stop('MEMORY_RECOVERY_TIMEOUT'), deadlineMs)
      abort = () => stop('MEMORY_RECOVERY_ABORTED')
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
    })])
  } catch (error) {
    if (error instanceof SeatContextRecoveryError) throw error
    throw new SeatContextRecoveryError('MEMORY_RECOVERY_FAILED')
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) input.signal?.removeEventListener('abort', abort)
    await close()
  }
}

/** Finalize only after the actual host input adapter accepted these exact bytes. */
export function consumePreparedSeatContext(prepared: PreparedSeatContext, consumption: SeatContextReceipt['consumption']): SeatContextReceipt {
  validateSeatHostContext(prepared.context, prepared.identity, prepared.targetRuntime)
  const currentWorkDigest = seatContextDigest(prepared.context.context_data.items.map(item => ({ id: item.item_id, kind: item.kind, source_ref: item.source_ref, summary: item.summary })).sort((a, b) => a.id.localeCompare(b.id)))
  if (currentWorkDigest !== prepared.workDigest) throw new SeatContextRecoveryError('MEMORY_PREPARED_CONTEXT_CHANGED')
  const receipt: SeatContextReceipt = {
    schema_version: 'seat-context-consumption/v1', agent_id: prepared.identity.agentId,
    project: prepared.identity.project, runtime_instance_id: prepared.runtimeInstanceId,
    target_runtime: prepared.targetRuntime, pack_id: prepared.context.pack_id,
    response_digest: prepared.responseDigest, work_digest: prepared.workDigest,
    invocation_digest: seatContextDigest(prepared.context), transport_binding_digest: prepared.transportBindingDigest,
    completed_at: new Date().toISOString(), consumption,
  }
  if (!validateSeatContextReceipt(receipt, { ...prepared.identity, runtimeInstanceId: prepared.runtimeInstanceId })) {
    throw new SeatContextRecoveryError('MEMORY_CONTEXT_CONSUMPTION_MISMATCH')
  }
  return receipt
}

export async function recoverSeatContext(input: SeatContextRecoveryInput & { consume: SeatContextConsumer }): Promise<{
  context: SeatHostContext; receipt: SeatContextReceipt; toolCount: number; contentCount: number
}> {
  if (typeof input.consume !== 'function') throw new SeatContextRecoveryError('MEMORY_CONTEXT_CONSUMER_REQUIRED')
  const prepared = await prepareSeatContext(input)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const consumption = await Promise.race([
      input.consume({ context: prepared.context, runtimeInstanceId: prepared.runtimeInstanceId, invocationDigest: seatContextDigest(prepared.context) }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SeatContextRecoveryError('MEMORY_CONSUMPTION_TIMEOUT')), Math.min(input.timeoutMs ?? 30_000, 30_000)) }),
    ])
    if (input.signal?.aborted) throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED')
    const receipt = consumePreparedSeatContext(prepared, consumption)
    return { context: prepared.context, receipt, toolCount: prepared.toolCount, contentCount: prepared.contentCount }
  } finally { if (timer) clearTimeout(timer) }
}

async function connectMemoryClient(transport: SeatMemoryTransport, cwd: string, env: Record<string, string>, register: (client: SeatMemoryClient) => void): Promise<SeatMemoryClient> {
  const stdio = new StdioClientTransport({ command: transport.command, args: transport.args, cwd, env, stderr: 'pipe' })
  const client = new Client({ name: 'aun-seat-context-recovery', version: '1.0.0' })
  register(client as SeatMemoryClient)
  // Drain privately; errors exposed by this module contain typed codes only.
  stdio.stderr?.on('data', () => {})
  try { await client.connect(stdio) } catch {
    await stdio.close().catch(() => {})
    throw new SeatContextRecoveryError('MEMORY_TRANSPORT_UNAVAILABLE')
  }
  return client as SeatMemoryClient
}


export type NativeSeatContextDelivery = {
  attempt_id: string; attempt_started_at: string
  schema_version: 'native-context-delivery/v1'; status: 'accepted'; agent_id: string; project: string
  target_runtime: SeatHostRuntime; host_session_id: string; provider_pid: number; provider_started_at: string
  provider_executable_sha256: string; workspace_sha256: string; pipe_sha256: string; input_sha256: string
  work_sha256: string; pack_ref: string; delivered_at: string
}

/** Read durable native input evidence. This does not produce or acknowledge context. */
export async function readNativeSeatContextReceipt(input: SeatContextRecoveryInput & {
  providerPid: number; providerStartedAt: string; hostSessionId?: string
}): Promise<SeatContextReceipt> {
  const transport = bindSeatMemoryTransport(input.transport, input)
  if (!Number.isInteger(input.providerPid) || input.providerPid < 2 || !Number.isFinite(Date.parse(input.providerStartedAt))
    || !input.runtimeInstanceId || !['codex', 'claude'].includes(input.targetRuntime)) throw new SeatContextRecoveryError('MEMORY_RUNTIME_IDENTITY_INVALID')
  const env = { ...input.env, ...transport.env }
  let client: SeatMemoryClient | undefined
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = async () => { closed = true; await client?.close().catch(() => {}) }
  try {
    return await Promise.race([(async () => {
      client = input.connect ? await input.connect(transport, { cwd: input.cwd, env })
        : await connectMemoryClient(transport, input.cwd, env, value => { client = value })
      if (closed) throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED')
      const response = await client.callTool({ name: 'native_context_delivery', arguments: {
        project: input.project, target_runtime: input.targetRuntime, provider_pid: input.providerPid,
        provider_started_at: new Date(input.providerStartedAt).toISOString(),
        workspace_sha256: createHash('sha256').update(input.cwd).digest('hex'),
        ...(input.hostSessionId ? { host_session_id: input.hostSessionId } : {}),
      } }) as any
      const texts = response?.content?.filter((entry: any) => entry.type === 'text' && typeof entry.text === 'string')
      if (response?.isError || !texts || texts.length !== 1) throw new SeatContextRecoveryError('MEMORY_NATIVE_CONTEXT_UNAVAILABLE')
      let native: NativeSeatContextDelivery
      try { native = JSON.parse(texts[0].text) } catch { throw new SeatContextRecoveryError('MEMORY_NATIVE_CONTEXT_UNAVAILABLE') }
      if (!/^[a-f0-9-]{36}$/.test(native.attempt_id) || !Number.isFinite(Date.parse(native.attempt_started_at))
        || Date.parse(native.attempt_started_at) < Date.parse(native.provider_started_at)
        || Date.parse(native.attempt_started_at) > Date.parse(native.delivered_at)
        || native.schema_version !== 'native-context-delivery/v1' || native.status !== 'accepted'
        || native.agent_id !== input.agentId || native.project !== input.project || native.target_runtime !== input.targetRuntime
        || native.provider_pid !== input.providerPid || native.provider_started_at !== new Date(input.providerStartedAt).toISOString()
        || native.workspace_sha256 !== createHash('sha256').update(input.cwd).digest('hex')
        || !native.host_session_id || (input.hostSessionId && native.host_session_id !== input.hostSessionId)
        || ![native.provider_executable_sha256, native.pipe_sha256, native.input_sha256, native.work_sha256].every(v => /^[a-f0-9]{64}$/.test(v))
        || !Number.isFinite(Date.parse(native.delivered_at)) || Date.parse(native.delivered_at) < Date.parse(native.provider_started_at)
        || Date.parse(native.delivered_at) > Date.now() || !native.pack_ref?.startsWith(`restart_pack:${input.agentId}:${input.project}:`)) {
        throw new SeatContextRecoveryError('MEMORY_NATIVE_CONTEXT_IDENTITY_MISMATCH')
      }
      if (closed || input.signal?.aborted) throw new SeatContextRecoveryError('MEMORY_RECOVERY_ABORTED')
      return {
        schema_version: 'seat-context-consumption/v1' as const, agent_id: input.agentId, project: input.project,
        runtime_instance_id: input.runtimeInstanceId, target_runtime: input.targetRuntime, pack_id: native.pack_ref,
        response_digest: seatContextDigest(native), work_digest: native.work_sha256, invocation_digest: native.input_sha256,
        transport_binding_digest: seatContextDigest({ command: transport.command, args: transport.args, agent_id: input.agentId, project: input.project }),
        // Completion belongs to the original delivery, not this later read.
        completed_at: new Date(native.delivered_at).toISOString(), native_delivery: native,
        consumption: { runtime_instance_id: input.runtimeInstanceId, invocation_digest: native.input_sha256, consumer: 'native-session-start:stored-pipe-receipt' },
      }
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { void close(); reject(new SeatContextRecoveryError('MEMORY_RECOVERY_TIMEOUT')) }, Math.min(input.timeoutMs ?? 10_000, 30_000)) })])
  } catch (error) {
    if (error instanceof SeatContextRecoveryError) throw error
    throw new SeatContextRecoveryError('MEMORY_NATIVE_CONTEXT_UNAVAILABLE')
  } finally { if (timer) clearTimeout(timer); await close() }
}
