import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  frozenEnabledSetSha256,
  runtimeSnapshotSha256,
  type V2NativeMeshFrozenAgentV1,
  type V2NativeMeshScopeV1,
} from '../../core/eventlog/v2-native-ingress'

const HEAD = 'e325d1e6607360a67d337a9b2a77d5df8dd11477'
const agents: V2NativeMeshFrozenAgentV1[] = ['alpha', 'beta'].map((agent, index) => ({
  agent_id: agent,
  profile_revision: '1',
  runtime_engine: 'deterministic-s0',
  runtime_instance_id: `runtime-${agent}`,
  runtime_checkout_root: `/fixture/${agent}`,
  runtime_checkout_sha: String(index + 1).repeat(40),
}))

let dir: string
let scopePath: string
let scope: V2NativeMeshScopeV1

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aun-v2-native-cli-'))
  scopePath = join(dir, 'scope.json')
  scope = {
    schema_version: 'aun-v2-native-mesh-scope/v1',
    run_id: 's0-cli-run',
    stage_id: 'S0_IMPLEMENTATION',
    repository: 'watchout/agent-comms-mcp',
    exact_implementation_head: HEAD,
    database_identity: 'sqlite:isolated:s0-cli',
    frozen_enabled_set: agents,
    frozen_enabled_set_sha256: frozenEnabledSetSha256(agents),
    runtime_snapshot_sha256: runtimeSnapshotSha256(agents),
    provider_dispatch: 'disabled',
    V1_mode: 'observe_only_no_traversal',
    deadline_ms: Date.now() + 30_000,
  }
  writeFileSync(scopePath, JSON.stringify(scope))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function invoke(extra: string[] = []) {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'bin/aun.ts', 'v2-native-mesh', 'validate',
      '--scope-file', scopePath,
      '--expected-head', HEAD,
      '--database-identity', scope.database_identity,
      '--runtime-snapshot-sha256', scope.runtime_snapshot_sha256,
      '--json',
      ...extra],
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode, body: JSON.parse(stdout) as Record<string, unknown> }
}

describe('aun v2-native-mesh S0 CLI', () => {
  test('validates exact frozen scope without mutation or activation', async () => {
    const result = await invoke()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.body.ok).toBe(true)
    expect(result.body.mode).toBe('S0_VALIDATE_ONLY')
    expect(result.body.mutation_performed).toBe(false)
    expect(result.body.activation_performed).toBe(false)
    expect(result.body.provider_invocations).toBe(0)
    expect(result.body.V1_invocations).toBe(0)
  })

  test('head drift and activation requests fail closed', async () => {
    const drifted = await invoke(['--expected-head', 'f'.repeat(40)])
    expect(drifted.exitCode).toBe(2)
    expect(drifted.body.ok).toBe(false)
    expect(drifted.body.mutation_performed).toBe(false)

    const activate = await invoke(['--activate'])
    expect(activate.exitCode).toBe(2)
    expect(activate.body.activation_performed).toBe(false)
  })
})
