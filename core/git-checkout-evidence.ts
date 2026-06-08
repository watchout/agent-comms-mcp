import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export type GitCheckoutEvidence = {
  checkout_path: string
  commit_sha: string | null
  dirty: boolean | null
  status_short: string | null
  source: 'env' | 'git' | 'missing'
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function runGit(checkoutPath: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', checkoutPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export function collectGitCheckoutEvidence(
  checkoutPath: string,
  env: NodeJS.ProcessEnv = process.env,
): GitCheckoutEvidence {
  const resolvedCheckoutPath = resolve(checkoutPath)
  const envCommit = text(env.AGENT_COM_COMMIT_SHA)
  const gitCommit = envCommit ?? text(runGit(resolvedCheckoutPath, ['rev-parse', 'HEAD']))
  const statusShort = runGit(resolvedCheckoutPath, ['status', '--short'])
  return {
    checkout_path: resolvedCheckoutPath,
    commit_sha: gitCommit,
    dirty: statusShort === null ? null : statusShort.length > 0,
    status_short: statusShort,
    source: envCommit ? 'env' : gitCommit ? 'git' : 'missing',
  }
}

export function gitCheckoutMetadata(evidence: GitCheckoutEvidence): Record<string, unknown> {
  return {
    git_checkout_path: evidence.checkout_path,
    git_commit_sha: evidence.commit_sha,
    git_dirty: evidence.dirty,
    git_status_short: evidence.status_short,
    git_evidence_source: evidence.source,
  }
}
