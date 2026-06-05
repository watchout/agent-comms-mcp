import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodexRunnerInvocation, CodexRunnerInvoker, CodexRunnerResult } from './types'
import {
  buildRuntimeRunnerInvocation,
  parseRuntimeRunnerStdout,
  type RuntimeRunnerInvocation,
} from './runtime-runner-contract'

const execFileAsync = promisify(execFile)

export interface CodexRunnerCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

function bunExecutable(): string {
  return process.env.STATE_DAEMON_BUN_EXECUTABLE?.trim() || process.execPath
}

function toRuntimeInvocation(input: CodexRunnerInvocation): RuntimeRunnerInvocation {
  return buildRuntimeRunnerInvocation({
    runtimeKind: 'codex',
    agentId: input.agentId,
    queueId: input.queueId,
    messageId: input.messageId,
    requester: input.requester,
    databaseUrl: input.databaseUrl,
    ackContent: input.ackContent,
    payload: input.payload,
  })
}

export function buildCodexRunnerCommand(input: CodexRunnerInvocation): CodexRunnerCommand {
  const runtimeInput = toRuntimeInvocation(input)
  const args = [
    'bin/aun.ts',
    'codex-runner',
    '--agent-id', runtimeInput.agent_id,
    '--queue-id', runtimeInput.queue_id,
    '--limit', '1',
  ]
  if (runtimeInput.requester && !input.autoFinalReply) {
    args.push('--ack-mentions', runtimeInput.requester)
    args.push('--ack-content', runtimeInput.ack_content)
  }
  if (input.completeNoReply) {
    args.push('--complete-no-reply')
    if (input.completionReason?.trim()) {
      args.push('--completion-reason', input.completionReason.trim())
    }
  }
  if (input.autoFinalReply) {
    args.push('--auto-final-reply')
  }
  return {
    command: bunExecutable(),
    args,
    env: {
      AGENT_ID: runtimeInput.agent_id,
      AGENT_COM_EXPECTED_AGENT_ID: runtimeInput.agent_id,
      DATABASE_URL: runtimeInput.database_url,
    },
  }
}

export function buildCodexRuntimeRunnerInvocation(input: CodexRunnerInvocation): RuntimeRunnerInvocation {
  return toRuntimeInvocation(input)
}

export class ExecFileCodexRunnerInvoker implements CodexRunnerInvoker {
  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly timeoutMs: number = 30_000,
  ) {}

  async invoke(input: CodexRunnerInvocation): Promise<CodexRunnerResult> {
    const plan = buildCodexRunnerCommand(input)
    try {
      const { stdout, stderr } = await execFileAsync(plan.command, plan.args, {
        cwd: this.cwd,
        env: { ...process.env, ...plan.env },
        timeout: this.timeoutMs,
      })
      return { ok: true, code: 0, stdout, stderr, typed_result: parseRuntimeRunnerStdout(stdout) }
    } catch (err) {
      const e = err as Error & { code?: number; stdout?: string; stderr?: string }
      return {
        ok: false,
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout,
        stderr: e.stderr ?? e.message,
        typed_result: parseRuntimeRunnerStdout(e.stdout),
      }
    }
  }
}
