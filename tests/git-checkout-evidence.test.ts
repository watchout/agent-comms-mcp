import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  collectRuntimeCheckoutEvidence,
  gitCheckoutMetadata,
} from '../core/git-checkout-evidence'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function createCleanCheckout(parent: string, name: string): { path: string; commit: string } {
  const path = join(parent, name)
  mkdirSync(path)
  git(path, ['init', '--quiet'])
  git(path, ['config', 'user.name', 'agent-comms-test'])
  git(path, ['config', 'user.email', 'test@example.invalid'])
  writeFileSync(join(path, 'README.md'), `${name}\n`)
  git(path, ['add', 'README.md'])
  git(path, ['commit', '--quiet', '-m', 'seed'])
  return { path, commit: git(path, ['rev-parse', 'HEAD']) }
}

describe('runtime checkout evidence', () => {
  test('uses the server root HEAD when cwd and an env-approved SHA differ', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-comms-checkout-evidence-'))
    try {
      const serverCheckout = createCleanCheckout(root, 'server-checkout')
      const differentCheckout = createCleanCheckout(root, 'different-checkout')
      expect(resolve(process.cwd())).not.toBe(resolve(serverCheckout.path))
      expect(differentCheckout.commit).not.toBe(serverCheckout.commit)

      const evidence = collectRuntimeCheckoutEvidence(serverCheckout.path, {
        AGENT_COM_COMMIT_SHA: differentCheckout.commit,
      })
      const metadata = gitCheckoutMetadata(evidence)

      expect(Object.isFrozen(evidence)).toBe(true)
      expect(evidence).toMatchObject({
        checkout_path: resolve(serverCheckout.path),
        commit_sha: serverCheckout.commit,
        dirty: false,
        source: 'git',
      })
      expect(metadata).toMatchObject({
        git_checkout_path: evidence.checkout_path,
        git_commit_sha: evidence.commit_sha,
        git_dirty: evidence.dirty,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('uses explicit checkout HEAD despite a mismatched server-root env SHA', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-comms-explicit-checkout-'))
    try {
      const serverCheckout = createCleanCheckout(root, 'server-checkout')
      const explicitCheckout = createCleanCheckout(root, 'explicit-checkout')
      writeFileSync(join(explicitCheckout.path, 'untracked.txt'), 'dirty\n')

      const evidence = collectRuntimeCheckoutEvidence(serverCheckout.path, {
        AGENT_COM_CHECKOUT_PATH: explicitCheckout.path,
        AGENT_COM_COMMIT_SHA: serverCheckout.commit,
      })
      const metadata = gitCheckoutMetadata(evidence)

      expect(evidence).toMatchObject({
        checkout_path: resolve(explicitCheckout.path),
        commit_sha: explicitCheckout.commit,
        dirty: true,
        source: 'git',
      })
      expect(evidence.commit_sha).not.toBe(serverCheckout.commit)
      expect(metadata).toMatchObject({
        git_checkout_path: evidence.checkout_path,
        git_commit_sha: evidence.commit_sha,
        git_dirty: evidence.dirty,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('accepts only a full-SHA env fallback when Git HEAD is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-comms-env-fallback-'))
    const fallbackCommit = 'a'.repeat(40)
    try {
      const packagedRoot = join(root, 'packaged-runtime')
      mkdirSync(packagedRoot)

      expect(collectRuntimeCheckoutEvidence(packagedRoot, {
        AGENT_COM_COMMIT_SHA: fallbackCommit,
      })).toMatchObject({
        checkout_path: resolve(packagedRoot),
        commit_sha: fallbackCommit,
        dirty: null,
        source: 'env',
      })
      expect(collectRuntimeCheckoutEvidence(packagedRoot, {
        AGENT_COM_COMMIT_SHA: 'approved-prefix',
      })).toMatchObject({
        commit_sha: null,
        source: 'missing',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('server root conversion is decode-safe for file URLs', () => {
    const serverSource = readFileSync(join(import.meta.dir, '..', 'server.ts'), 'utf8')
    expect(serverSource).toContain("import { fileURLToPath } from 'node:url'")
    expect(serverSource).toContain('dirname(fileURLToPath(import.meta.url))')
    expect(serverSource).not.toContain('new URL(import.meta.url).pathname')
  })
})
