import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import type {
  BootstrapCommandResult,
  BootstrapMutation,
  BootstrapRuntimeAdapter,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from './bootstrap-types'

export type BootstrapAdapterCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<BootstrapCommandResult>

export type BootstrapAdapterDependencies = {
  run: BootstrapAdapterCommandRunner
  bunPath: string
  serverEntry: string
}

export type BootstrapMcpTuple = {
  name: 'aun'
  enabled: true
  transport: 'stdio'
  command: string
  argv: string[]
  environment: Record<string, string>
  scope: 'user'
}

function realpathOrResolve(path: string): string {
  if (path && !path.includes('/')) return Bun.which(path) ?? path
  try { return realpathSync(path) } catch { return resolve(path) }
}

export function expectedBootstrapMcpTuple(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): BootstrapMcpTuple {
  const sqlite = context.env.AGENT_COM_DB?.trim().toLowerCase() === 'sqlite'
  const databaseEnvironment = sqlite
    ? {
        AGENT_COM_DB: 'sqlite',
        AGENT_COM_SQLITE_PATH: realpathOrResolve(context.env.AGENT_COM_SQLITE_PATH || `${context.repoRoot}/agent-com.db`),
      }
    : { DATABASE_URL: context.env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp' }
  const port = context.env.AUN_BOOTSTRAP_CHANNEL_PORT
  return {
    name: 'aun',
    enabled: true,
    transport: 'stdio',
    command: realpathOrResolve(deps.bunPath),
    argv: ['run', '--cwd', realpathOrResolve(context.repoRoot), deps.serverEntry],
    environment: {
      AGENT_ID: context.agentId,
      AGENT_COM_EXPECTED_AGENT_ID: context.agentId,
      ...databaseEnvironment,
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      ...(port ? { AUN_WEBHOOK_PORT: port } : {}),
    },
    scope: 'user',
  }
}

function registrationArgs(tuple: BootstrapMcpTuple): string[] {
  return [
    'mcp', 'add', 'aun',
    ...Object.entries(tuple.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--', tuple.command, ...tuple.argv,
  ]
}

function parseJson(result: BootstrapCommandResult): any | null {
  if (result.exitCode !== 0) return null
  try { return JSON.parse(result.stdout) } catch { return null }
}

function nativeAbsence(result: BootstrapCommandResult): boolean {
  return result.exitCode !== 0 && /(?:not found|no mcp server named)/i.test(result.stderr)
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, item]) => typeof item !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

export function codexTupleMatches(value: any, expected: BootstrapMcpTuple): boolean {
  const transport = value?.transport
  const environment = stringRecord(transport?.env)
  return value?.name === expected.name
    && value?.enabled === true
    && transport?.type === expected.transport
    && realpathOrResolve(String(transport?.command ?? '')) === expected.command
    && Array.isArray(transport?.args)
    && bootstrapDigest(transport.args) === bootstrapDigest(expected.argv)
    && environment !== null
    && bootstrapDigest(environment) === bootstrapDigest(expected.environment)
}

function codexListState(value: any): { count: number; enabled: boolean } {
  if (!Array.isArray(value)) return { count: -1, enabled: false }
  const entries = value.filter((item) => item?.name === 'aun')
  return { count: entries.length, enabled: entries.length === 1 && entries[0]?.enabled === true }
}

async function exactReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const get = parseJson(getResult)
  const list = codexListState(parseJson(listResult))
  const expected = expectedBootstrapMcpTuple(context, deps)
  const ok = getResult.exitCode === 0
    && listResult.exitCode === 0
    && list.count === 1
    && list.enabled
    && codexTupleMatches(get, expected)
  return ok
    ? {
        ok: true,
        evidenceRefs: [`codex-mcp-exact-tuple:${bootstrapDigest(expected)}`],
        readinessPredicates: { mcp_registered: true, mcp_native_get_exact: true, mcp_native_list_exact: true },
        readbackDigest: bootstrapDigest(expected),
      }
    : {
        ok: false,
        reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'],
        evidenceRefs: [`codex-mcp-mismatch:${bootstrapDigest({ get_exit: getResult.exitCode, list_exit: listResult.exitCode, list })}`],
        readinessPredicates: { mcp_registered: false, mcp_native_get_exact: false, mcp_native_list_exact: false },
      }
}

async function exactAbsenceReadback(
  context: BootstrapStageContext,
  deps: BootstrapAdapterDependencies,
): Promise<BootstrapStageOutcome> {
  const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
  const [getResult, listResult] = await Promise.all([
    deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
    deps.run('codex', ['mcp', 'list', '--json'], options),
  ])
  const list = codexListState(parseJson(listResult))
  const digest = bootstrapDigest({ absent: true, get_exit: getResult.exitCode, list_exit: listResult.exitCode, list_count: list.count })
  return nativeAbsence(getResult) && listResult.exitCode === 0 && list.count === 0
    ? { ok: true, evidenceRefs: [`codex-mcp-native-absence:${digest}`], readbackDigest: digest }
    : { ok: false, reasonCodes: ['NO_GO_POST_MUTATION_READBACK'], evidenceRefs: [`codex-mcp-native-absence-unresolved:${digest}`] }
}

export function createCodexBootstrapAdapter(deps: BootstrapAdapterDependencies): BootstrapRuntimeAdapter {
  return {
    runtime: 'codex',

    async dependencyPreflight(context): Promise<BootstrapStageOutcome> {
      const result = await deps.run('codex', ['--version'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal })
      return result.exitCode === 0
        ? {
            ok: true,
            evidenceRefs: [`codex-cli:${bootstrapDigest(result.stdout.trim())}`],
            readinessPredicates: { codex_cli_available: true },
            readbackDigest: bootstrapDigest({ executable: realpathOrResolve('codex'), version: result.stdout.trim(), config_scope: 'native-default' }),
          }
        : { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'], readinessPredicates: { codex_cli_available: false } }
    },

    async planMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const tuple = expectedBootstrapMcpTuple(context, deps)
      return {
        ok: true,
        evidenceRefs: [`codex-mcp-plan:${bootstrapDigest(tuple)}`],
        readinessPredicates: { provider_cli_owns_config: true, secrets_excluded_from_state: true },
      }
    },

    async applyMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
      const beforeGet = await deps.run('codex', ['mcp', 'get', 'aun', '--json'], options)
      if (beforeGet.exitCode === 0) return exactReadback(context, deps)
      if (!nativeAbsence(beforeGet)) return { ok: false, reasonCodes: ['NO_GO_MCP_READBACK'] }

      const beforeList = await deps.run('codex', ['mcp', 'list', '--json'], options)
      const listState = codexListState(parseJson(beforeList))
      if (beforeList.exitCode !== 0 || listState.count !== 0) {
        return { ok: false, reasonCodes: ['NO_GO_PROVIDER_ADAPTER_MISMATCH'] }
      }

      const tuple = expectedBootstrapMcpTuple(context, deps)
      const args = registrationArgs(tuple)
      const applied = await deps.run('codex', args, { ...options, timeoutMs: 120_000 })
      const mutation = {
        kind: 'mcp_registration' as const,
        owner_key: `codex:aun:${context.runId}`,
        before_digest: bootstrapDigest({ absent: true }),
        intended_after_digest: bootstrapDigest(tuple),
        actual_after_digest: null,
        rollback_action: 'codex mcp remove aun; verify native get absence and list absence',
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
              evidenceRefs: [...(readback.evidenceRefs ?? []), `codex-mcp-add-nonzero-after-mutation:${applied.exitCode}`],
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
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'codex'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_RUNTIME_RECEIPT'], readinessPredicates: { current_runtime_verified: ok } }
    },

    async verifyRuntimeIdentity(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'codex'
      return { ok, reasonCodes: ok ? [] : ['NO_GO_IDENTITY_MISMATCH'], readinessPredicates: { runtime_identity_matches: ok } }
    },

    async rollbackRuntimeRegistration(context, mutation: BootstrapMutation): Promise<BootstrapStageOutcome> {
      if (mutation.kind !== 'mcp_registration'
        || mutation.owner_key !== `codex:aun:${context.runId}`
        || mutation.rollback_payload?.created_by_run !== true) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const options = { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000, signal: context.abortSignal }
      const removed = await deps.run('codex', ['mcp', 'remove', 'aun'], options)
      if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      const [getResult, listResult] = await Promise.all([
        deps.run('codex', ['mcp', 'get', 'aun', '--json'], options),
        deps.run('codex', ['mcp', 'list', '--json'], options),
      ])
      const listState = codexListState(parseJson(listResult))
      const readbackDigest = bootstrapDigest({
        absent: true,
        get_exit: getResult.exitCode,
        list_exit: listResult.exitCode,
        list_count: listState.count,
      })
      return nativeAbsence(getResult) && listResult.exitCode === 0 && listState.count === 0
        ? {
            ok: true,
            readinessPredicates: { rollback_verified: true },
            evidenceRefs: [`codex-mcp-native-absence:${readbackDigest}`],
            readbackDigest,
          }
        : { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
    },
  }
}
