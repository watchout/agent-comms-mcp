import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export type GitCheckoutEvidence = {
  readonly checkout_path: string
  readonly commit_sha: string | null
  readonly dirty: boolean | null
  readonly status_short: string | null
  readonly source: 'env' | 'git' | 'missing'
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function fullGitSha(value: string | null): string | null {
  return value && /^[0-9a-f]{40}$/i.test(value) ? value : null
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
  const gitCommit = text(runGit(resolvedCheckoutPath, ['rev-parse', 'HEAD']))
  // The selected checkout's actual HEAD is authoritative. The environment is
  // only a full-SHA fallback for packaged/non-Git deployments; it must never
  // let a different clean checkout masquerade as an approved commit.
  const envCommitFallback = gitCommit === null
    ? fullGitSha(text(env.AGENT_COM_COMMIT_SHA))
    : null
  const commitSha = gitCommit ?? envCommitFallback
  const statusShort = runGit(resolvedCheckoutPath, ['status', '--short'])
  return Object.freeze({
    checkout_path: resolvedCheckoutPath,
    commit_sha: commitSha,
    dirty: statusShort === null ? null : statusShort.length > 0,
    status_short: statusShort,
    source: gitCommit ? 'git' : envCommitFallback ? 'env' : 'missing',
  })
}

/**
 * Collect the server runtime's checkout identity from exactly one root.
 *
 * The explicit runtime checkout wins when supplied. Otherwise callers pass
 * the immutable server root; process.cwd() is deliberately not consulted.
 */
export function collectRuntimeCheckoutEvidence(
  serverRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): GitCheckoutEvidence {
  return collectGitCheckoutEvidence(text(env.AGENT_COM_CHECKOUT_PATH) ?? serverRoot, env)
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
