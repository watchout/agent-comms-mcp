import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CodexRunnerInvocation, CodexRunnerInvoker, CodexRunnerResult } from './types'

const execFileAsync = promisify(execFile)

export interface CodexRunnerCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

export function buildCodexRunnerCommand(input: CodexRunnerInvocation): CodexRunnerCommand {
  const args = [
    'bin/aun.ts',
    'codex-runner',
    '--agent-id', input.agentId,
    '--limit', '1',
  ]
  if (input.requester) {
    args.push('--ack-mentions', input.requester)
    args.push('--ack-content', input.ackContent)
  }
  return {
    command: 'bun',
    args,
    env: {
      AGENT_ID: input.agentId,
      AGENT_COM_EXPECTED_AGENT_ID: input.agentId,
      DATABASE_URL: input.databaseUrl,
    },
  }
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
      return { ok: true, code: 0, stdout, stderr }
    } catch (err) {
      const e = err as Error & { code?: number; stdout?: string; stderr?: string }
      return {
        ok: false,
        code: typeof e.code === 'number' ? e.code : 1,
        stdout: e.stdout,
        stderr: e.stderr ?? e.message,
      }
    }
  }
}
