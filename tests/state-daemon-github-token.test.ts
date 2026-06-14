import { describe, expect, test } from 'bun:test'
import { resolveGithubTokenFromEnv } from '../bin/state-daemon'

describe('state-daemon GitHub token resolution', () => {
  test('prefers STATE_DAEMON_GITHUB_TOKEN_FILE and trims file contents', () => {
    const token = resolveGithubTokenFromEnv(
      {
        STATE_DAEMON_GITHUB_TOKEN_FILE: '/run/secrets/github-token',
        STATE_DAEMON_GITHUB_TOKEN: 'env-token',
      },
      (path) => {
        expect(path).toBe('/run/secrets/github-token')
        return ' file-token \n'
      },
    )

    expect(token).toBe('file-token')
  })

  test('falls back to direct env tokens only when no token file is configured', () => {
    expect(resolveGithubTokenFromEnv({ STATE_DAEMON_GITHUB_TOKEN: ' state-daemon-token\n' })).toBe('state-daemon-token')
    expect(resolveGithubTokenFromEnv({ GITHUB_TOKEN: ' github-token ' })).toBe('github-token')
    expect(resolveGithubTokenFromEnv({ STATE_DAEMON_GITHUB_TOKEN: '   ' })).toBeUndefined()
  })
})
