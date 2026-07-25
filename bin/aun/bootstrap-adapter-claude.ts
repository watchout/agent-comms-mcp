import { bootstrapDigest } from '../../core/aun-bootstrap-state'
import type {
  BootstrapMutation,
  BootstrapRuntimeAdapter,
  BootstrapStageContext,
  BootstrapStageOutcome,
} from './bootstrap-types'
import type { BootstrapAdapterDependencies } from './bootstrap-adapter-codex'
import { buildClaudeMcpAddArgs } from './init'

function registered(output: string): boolean {
  return output.split(/\r?\n/).some((line) => /^aun(?:\s|:|$)/i.test(line.trim()))
}

function registrationArgs(context: BootstrapStageContext, deps: BootstrapAdapterDependencies): string[] {
  const databaseUrl = context.env.DATABASE_URL || 'postgresql:///agent_comms?host=/tmp'
  const port = context.env.AUN_BOOTSTRAP_CHANNEL_PORT
  return buildClaudeMcpAddArgs({
    bunPath: deps.bunPath,
    serverArgs: ['run', '--cwd', context.repoRoot, deps.serverEntry],
    environment: {
      AGENT_ID: context.agentId,
      AGENT_COM_EXPECTED_AGENT_ID: context.agentId,
      DATABASE_URL: databaseUrl,
      AGENT_COM_PG_NOTIFY: 'false',
      AGENT_COMMS_TTL_SWEEP_DISABLED: '1',
      ...(port ? { AUN_WEBHOOK_PORT: port } : {}),
    },
  })
}

export function createClaudeBootstrapAdapter(deps: BootstrapAdapterDependencies): BootstrapRuntimeAdapter {
  return {
    runtime: 'claude',

    async dependencyPreflight(context): Promise<BootstrapStageOutcome> {
      const result = await deps.run('claude', ['--version'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000 })
      return result.exitCode === 0
        ? { ok: true, evidenceRefs: [`claude-cli:${bootstrapDigest(result.stdout.trim())}`], readinessPredicates: { claude_cli_available: true } }
        : { ok: false, reasonCodes: ['NO_GO_DEPENDENCY_MISSING'], readinessPredicates: { claude_cli_available: false } }
    },

    async planMcpRegistration(context): Promise<BootstrapStageOutcome> {
      return {
        ok: true,
        evidenceRefs: [`claude-mcp-plan:${bootstrapDigest(registrationArgs(context, deps))}`],
        readinessPredicates: { provider_cli_owns_config: true, existing_aun_init_contract_reused: true },
      }
    },

    async applyMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const before = await deps.run('claude', ['mcp', 'list'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000 })
      if (before.exitCode === 0 && registered(before.stdout)) {
        return {
          ok: true,
          evidenceRefs: [`claude-mcp-existing:${bootstrapDigest(before.stdout)}`],
          readinessPredicates: { mcp_registered: true },
        }
      }
      const args = registrationArgs(context, deps)
      const applied = await deps.run('claude', args, { cwd: context.repoRoot, env: context.env, timeoutMs: 120_000 })
      if (applied.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_MCP_REGISTRATION'] }
      const readback = await this.readbackMcpRegistration(context)
      if (!readback.ok) return readback
      return {
        ...readback,
        mutation: {
          kind: 'mcp_registration',
          owner_key: `claude:aun:${context.agentId}`,
          before_digest: bootstrapDigest(before.stdout),
          intended_after_digest: bootstrapDigest(args),
          actual_after_digest: bootstrapDigest(readback.evidenceRefs ?? []),
          rollback_action: 'claude mcp remove --scope user aun',
        },
      }
    },

    async readbackMcpRegistration(context): Promise<BootstrapStageOutcome> {
      const result = await deps.run('claude', ['mcp', 'list'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000 })
      const ok = result.exitCode === 0 && registered(result.stdout)
      return ok
        ? { ok: true, evidenceRefs: [`claude-mcp-readback:${bootstrapDigest(result.stdout)}`], readinessPredicates: { mcp_registered: true } }
        : { ok: false, reasonCodes: ['NO_GO_MCP_READBACK'], readinessPredicates: { mcp_registered: false } }
    },

    async planRuntimeStart(context): Promise<BootstrapStageOutcome> {
      return {
        ok: context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude',
        reasonCodes: context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude' ? [] : ['NO_GO_RUNTIME_RECEIPT'],
        readinessPredicates: { current_runtime_verified: context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude' },
      }
    },

    async verifyRuntimeIdentity(context): Promise<BootstrapStageOutcome> {
      const ok = context.env.AUN_BOOTSTRAP_PROCESS_RUNTIME === 'claude'
      return {
        ok,
        reasonCodes: ok ? [] : ['NO_GO_IDENTITY_MISMATCH'],
        readinessPredicates: { runtime_identity_matches: ok },
      }
    },

    async rollbackRuntimeRegistration(context, mutation: BootstrapMutation): Promise<BootstrapStageOutcome> {
      if (mutation.kind !== 'mcp_registration' || mutation.owner_key !== `claude:aun:${context.agentId}`) {
        return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      }
      const removed = await deps.run('claude', ['mcp', 'remove', '--scope', 'user', 'aun'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000 })
      if (removed.exitCode !== 0) return { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
      const after = await deps.run('claude', ['mcp', 'list'], { cwd: context.repoRoot, env: context.env, timeoutMs: 30_000 })
      return registered(after.stdout)
        ? { ok: false, reasonCodes: ['NO_GO_ROLLBACK_UNVERIFIED'] }
        : { ok: true, readinessPredicates: { rollback_verified: true } }
    },
  }
}
