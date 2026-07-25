import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import type {
  BootstrapMutation,
  BootstrapRuntimeAdapter,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from './bootstrap-types'
import type { BootstrapAdapterDependencies, BootstrapMcpTuple } from './bootstrap-adapter-codex'
import { expectedBootstrapMcpTuple } from './bootstrap-adapter-codex'
import { buildClaudeMcpAddArgs } from './init'

function realpathOrResolve(path: string): string {
  if (path && !path.includes('/')) return Bun.which(path) ?? path
  try { return realpathSync(path) } catch { return resolve(path) }
}

function registrationArgs(tuple: BootstrapMcpTuple): string[] {
  return buildClaudeMcpAddArgs({
    bunPath: tuple.command,
    serverArgs: tuple.argv,
    environment: tuple.environment,
  })
}

type ClaudeNativeTuple = {
  scope: string
  status: string
  type: string
  command: string
  args: string[]
  environment: Record<string, string>
}

/** Strict parser for the stable `claude mcp get <name>` labeled output. */
export function parseClaudeMcpGet(output: string): ClaudeNativeTuple | null {
  const lines = output.split(/\r?\n/)
  const field = (name: string): string | null => {
    const matches = lines
      .map((line) => line.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'i'))?.[1] ?? null)
      .filter((value): value is string => value !== null)
    return matches.length === 1 ? matches[0] : null
  }
  const scope = field('Scope')
  const status = field('Status')
  const type = field('Type') ?? field('Transport')
  const command = field('Command')
  const argsRaw = field('Args')
  if (!scope || !status || !type || !command || argsRaw === null) return null
  const environment: Record<string, string> = {}
  const envHeader = lines.findIndex((line) => /^\s*Environment:\s*$/i.test(line))
  if (envHeader < 0) return null
  for (let index = envHeader + 1; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    const match = line.match(/^\s{2,}([A-Z][A-Z0-9_]*)=(.*)$/)
    if (!match) break
    if (environment[match[1]] !== undefined) return null
    environment[match[1]] = match[2]
  }
  return {
    scope,
    status,
    type,
    command,
    args: argsRaw.trim() ? argsRaw.trim().split(/\s+/) : [],
    environment,
  }
}

function claudeTupleMatches(actual: ClaudeNativeTuple | null, expected: BootstrapMcpTuple): boolean {
  return actual !== null
    && /^user(?:\s+config)?$/i.test(actual.scope)
    && /(?:^|\s)(?:connected|✔\s*connected|✓\s*connected)(?:\s|$)/i.test(actual.status)
    && actual.type.toLowerCase() === expected.transport
    && realpathOrResolve(actual.command) === expected.command
    && bootstrapDigest(actual.args) === bootstrapDigest(expected.argv)
    && bootstrapDigest(actual.environment) === bootstrapDigest(expected.environment)
}

function claudeListState(output: string): { count: number; connected: boolean } {
  const entries = output.split(/\r?\n/).filter((line) => /^\s*aun:\s*/i.test(line))
  return { count: entries.length, connected: entries.length === 1 && /(?:✔|✓)?\s*Connected\s*$/i.test(entries[0]) }
}

function nativeAbsence(result: { exitCode: number; stderr: string }): boolean {
  return result.exitCode !== 0 && /(?:not found|no mcp server named)/i.test(result.stderr)
}

async function exactReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
  const [getResult, listResult] = await Promise.all([
    deps.run('claude', ['mcp', 'get', 'aun'], options),
    deps.run('claude', ['mcp', 'list'], options),
  ])
  const tuple = parseClaudeMcpGet(getResult.stdout)
  const list = claudeListState(listResult.stdout)
  const expected = expectedBootstrapMcpTuple(context, deps)
  const ok = getResult.exitCode === 0
    && listResult.exitCode === 0
    && list.count === 1
    && list.connected
    && claudeTupleMatches(tuple, expected)
  return ok
    ? {
        ok: true,
        evidenceRefs: [`claude-mcp-exact-tuple:${bootstrapDigest(expected)}`],
        readinessPredicates: { mcp_registered: true, mcp_native_get_exact: true, mcp_native_list_exact: true },
        readbackDigest: bootstrapDigest(expected),
      }
    : {
        ok: false,
        reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'],
        evidenceRefs: [`claude-mcp-mismatch:${bootstrapDigest({ get_exit: getResult.exitCode, list_exit: listResult.exitCode, list })}`],
        readinessPredicates: { mcp_registered: false, mcp_native_get_exact: false, mcp_native_list_exact: false },
      }
}

async function exactAbsenceReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
  const [getResult, listResult] = await Promise.all([
    deps.run('claude', ['mcp', 'get', 'aun'], options),
    deps.run('claude', ['mcp', 'list'], options),
  ])
  const list = claudeListState(listResult.stdout)
  const digest = bootstrapDigest({ absent: true, get_exit: getResult.exitCode, list_exit: listResult.exitCode, list_count: list.count })
  return nativeAbsence(getResult) && listResult.exitCode === 0 && list.count === 0
    ? { ok: true, evidenceRefs: [`claude-mcp-native-absence:${digest}`], readbackDigest: digest }
    : { ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'], evidenceRefs: [`claude-mcp-native-absence-unresolved:${digest}`] }
}

export function createClaudeBootstrapAdapter(deps: BootstrapAdapterDependencies): BootstrapRuntimeAdapter {
  return {
    runtime: 'claude',

    async dependencyPreflight(context): Promise<BootstrapStageOutcome> {
      const result = await deps.run('claude', ['--version'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal })
      return result.exitCode === 0
        ? {
            ok: true,
            evidenceRefs: [`claude-cli:${bootstrapDigest(result.stdout.trim())}`],
            readinessPredicates: { claude_cli_available: true },
            readbackDigest: bootstrapDigest({ executable: realpathOrResolve('claude'), version: result.stdout.trim(), config_scope: 'user' }),
          }
        : { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'], readinessPredicates: { claude_cli_available: false } }
    },

    async planMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const tuple = expectedBootstrapMcpTuple(context, deps)
      return {
        ok: true,
        evidenceRefs: [`claude-mcp-plan:${bootstrapDigest(tuple)}`],
        readinessPredicates: { provider_cli_owns_config: true, existing_aun_init_contract_reused: true },
      }
    },

    async applyMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
      const beforeGet = await deps.run('claude', ['mcp', 'get', 'aun'], options)
      if (beforeGet.exitCode === 0) return exactReadback(context, deps)
      if (!nativeAbsence(beforeGet)) return { ok: false, reasonCodes: ['NO_GO_MCP_READBACK'] }
      const beforeList = await deps.run('claude', ['mcp', 'list'], options)
      const listState = claudeListState(beforeList.stdout)
      if (beforeList.exitCode !== 0 || listState.count !== 0) {
        return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'] }
      }

      const tuple = expectedBootstrapMcpTuple(context, deps)
      const applied = await deps.run('claude', registrationArgs(tuple), { ...options, timeoutMs: 120_000 })
      const mutation = {
        kind: 'mcp_registration' as const,
        owner_key: `claude:aun:${context.runId}`,
        before_digest: bootstrapDigest({ absent: true }),
        intended_after_digest: bootstrapDigest(tuple),
        actual_after_digest: null,
        rollback_action: 'claude mcp remove --scope user aun; verify native get absence and list absence',
        rollback_payload: { created_by_run: true, tuple_digest: bootstrapDigest(tuple) },
      }
      const readback = await exactReadback(context, deps)
      if (readback.ok) {
        const observed = { ...mutation, actual_after_digest: bootstrapDigest(tuple) }
        return applied.exitCode === 0
          ? { ...readback, mutation: observed }
          : {
              ...readback,
              ok: false,
              reasonCodes: ['NO_GO_POST_MUTATION_READBACK'],
              evidenceRefs: [...(readback.evidenceRefs ?? []), `claude-mcp-add-nonzero-after-mutation:${applied.exitCode}`],
              mutation: observed,
            }
      }
      const absence = await exactAbsenceReadback(context, deps)
      if (absence.ok) {
        return {
          ...absence,
          ok: false,
          reasonCodes: [applied.exitCode === 0 ? 'NO_GO_MCP_READBACK' : 'NO_GO_MCP_REGISTRATION'],
        }
      }
      return { ...readback, ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'] }
    },

    readbackMcpRegistration(context): Promise<BootstrapStageOutcome> {
      return exactReadback(context, deps)
    },

    async planRuntimeStart(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_RUNTIME_RECEIPT'], readinessPredicates: { current_runtime_verified: ok } }
    },

    async verifyRuntimeIdentity(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_IDENTITY_MISMATCH'], readinessPredicates: { runtime_identity_matches: ok } }
    },

    async rollbackRuntimeRegistration(context, mutation: BootstrapMutation): Promise<BootstrapStageOutcome> {
      if (mutation.kind !== 'mcp_registration'
        || mutation.owner_key !== `claude:aun:${context.runId}`
        || mutation.rollback_payload?.created_by_run !== true) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
      const removed = await deps.run('claude', ['mcp', 'remove', '--scope', 'user', 'aun'], options)
      if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      const [getResult, listResult] = await Promise.all([
        deps.run('claude', ['mcp', 'get', 'aun'], options),
        deps.run('claude', ['mcp', 'list'], options),
      ])
      const list = claudeListState(listResult.stdout)
      const readbackDigest = bootstrapDigest({
        absent: true,
        get_exit: getResult.exitCode,
        list_exit: listResult.exitCode,
        list_count: list.count,
      })
      return nativeAbsence(getResult) && listResult.exitCode === 0 && list.count === 0
        ? {
            ok: true,
            readinessPredicates: { rollback_verified: true },
            evidenceRefs: [`claude-mcp-native-absence:${readbackDigest}`],
            readbackDigest,
          }
        : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    },
  }
}
