import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { buildReceivePlan } from '../../bin/aun/receive'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const AUN_CLI = join(REPO_ROOT, 'bin', 'aun.ts')

describe('test_aun_receive_wrapper — stable next wrapper', () => {
  test('buildReceivePlan pins repo cwd, AGENT_ID, expected lock, and next argv', () => {
    const plan = buildReceivePlan({
      agentId: 'codex-audit',
      env: {
        PATH: process.env.PATH,
        AGENT_ID: 'wrong-agent',
        DATABASE_URL: 'postgresql:///agent_comms?host=/tmp',
      } as NodeJS.ProcessEnv,
    })

    expect(plan.repoRoot).toBe(REPO_ROOT)
    expect(plan.argv).toEqual(['bun', 'cli/index.ts', 'next'])
    expect(plan.env.AGENT_ID).toBe('codex-audit')
    expect(plan.env.AGENT_COM_EXPECTED_AGENT_ID).toBe('codex-audit')
    expect(plan.databaseUrlCandidates).toEqual([
      'postgresql:///agent_comms?host=/tmp',
      'postgresql:///agent_comms?host=/private/tmp',
    ])
  })

  test('default database candidates prefer /tmp then /private/tmp', () => {
    const plan = buildReceivePlan({
      agentId: 'agent-com-dev',
      env: { PATH: process.env.PATH } as NodeJS.ProcessEnv,
    })
    expect(plan.env.DATABASE_URL).toBe('postgresql:///agent_comms?host=/tmp')
    expect(plan.databaseUrlCandidates).toEqual([
      'postgresql:///agent_comms?host=/tmp',
      'postgresql:///agent_comms?host=/private/tmp',
    ])
  })

  test('dry-run subprocess exposes deterministic receive plan without touching DB', () => {
    const r = spawnSync('bun', ['run', AUN_CLI, 'receive', '--agent-id', 'codex-audit', '--dry-run'], {
      cwd: '/',
      encoding: 'utf-8',
      env: {
        ...process.env,
        AGENT_ID: 'wrong-agent',
        DATABASE_URL: 'postgresql:///agent_comms?host=/tmp',
      },
      timeout: 15_000,
    })

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      cwd: REPO_ROOT,
      argv: ['bun', 'cli/index.ts', 'next'],
      agent_id: 'codex-audit',
      expected_agent_id: 'codex-audit',
      database_url_candidates: [
        'postgresql:///agent_comms?host=/tmp',
        'postgresql:///agent_comms?host=/private/tmp',
      ],
    })
  })

  test('next alias shares the same dry-run receive wrapper', () => {
    const r = spawnSync('bun', ['run', AUN_CLI, 'next', '--agent-id', 'agent-com-dev', '--dry-run'], {
      cwd: '/tmp',
      encoding: 'utf-8',
      env: { ...process.env, DATABASE_URL: '' },
      timeout: 15_000,
    })

    expect(r.status).toBe(0)
    const body = JSON.parse(r.stdout)
    expect(body.agent_id).toBe('agent-com-dev')
    expect(body.expected_agent_id).toBe('agent-com-dev')
    expect(body.argv).toEqual(['bun', 'cli/index.ts', 'next'])
  })
})
