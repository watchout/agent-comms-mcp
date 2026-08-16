import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECKER = join(import.meta.dir, '..', 'scripts', 'cell-conformance-check.mjs')
const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'cell-conformance-'))
  roots.push(root)
  return root
}

const CONFIG = {
  schema_version: 'cell-conformance-config/v1',
  protected_globs: ['.github/workflows/**', 'db/migrations/**', 'config/launchd/**'],
  src_globs: ['core/**', 'cli/**'],
  test_globs: ['tests/**'],
  required_body_sections: ['CELL-ID:', 'Allowed paths'],
}

type RunResult = { exitCode: number; verdict: string; byCheck: Record<string, { status: string; evidence?: string[] }> }

async function run(options: {
  changed: string[]
  scope: Record<string, unknown>
  config?: Record<string, unknown>
  body?: string
}): Promise<RunResult> {
  const root = workspace()
  const configPath = join(root, 'config.json')
  const scopePath = join(root, 'scope.json')
  const changedPath = join(root, 'changed.txt')
  writeFileSync(configPath, JSON.stringify(options.config ?? CONFIG))
  writeFileSync(scopePath, JSON.stringify(options.scope))
  writeFileSync(changedPath, options.changed.join('\n'))

  const args = [CHECKER, '--config', configPath, '--changed-files', changedPath, '--scope', scopePath, '--format', 'json']
  if (options.body !== undefined) {
    const bodyPath = join(root, 'body.md')
    writeFileSync(bodyPath, options.body)
    args.push('--pr-body', bodyPath)
  }

  const proc = Bun.spawn(['node', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  const parsed = JSON.parse(stdout)
  const byCheck: RunResult['byCheck'] = {}
  for (const result of parsed.results) byCheck[result.check] = { status: result.status, evidence: result.evidence }
  return { exitCode, verdict: parsed.verdict, byCheck }
}

const scopeOf = (allowed?: string[]) => ({
  schema_version: 'cell-scope/v1',
  cell_id: 'CELL-TEST-001',
  control_source: 'https://github.com/watchout/agent-comms-mcp/issues/1',
  ...(allowed ? { allowed_paths: allowed } : {}),
})

describe('cell conformance: scope comes from the control source and fails closed', () => {
  test('a control source with no declared allowed_paths fails rather than passing', async () => {
    const result = await run({ changed: ['core/a.ts', 'tests/a.test.ts'], scope: scopeOf() })
    expect(result.byCheck.scope.status).toBe('FAIL')
    expect(result.verdict).toBe('FAIL')
    expect(result.exitCode).toBe(1)
  })

  test('an empty changed-file list fails rather than vacuously passing', async () => {
    const result = await run({ changed: [], scope: scopeOf(['core/**']) })
    expect(result.byCheck.scope.status).toBe('FAIL')
  })

  test('paths inside the declared scope pass', async () => {
    const result = await run({ changed: ['core/a.ts', 'core/x/y/z.ts', 'tests/a.test.ts'], scope: scopeOf(['core/**', 'tests/**']) })
    expect(result.byCheck.scope.status).toBe('PASS')
  })

  test('paths outside the declared scope are reported individually', async () => {
    const result = await run({ changed: ['core/a.ts', 'cli/index.ts', 'docs/x.md'], scope: scopeOf(['core/**']) })
    expect(result.byCheck.scope.status).toBe('FAIL')
    expect(result.byCheck.scope.evidence).toEqual(['cli/index.ts', 'docs/x.md'])
  })

  test('a single-segment glob does not silently span directories', async () => {
    const result = await run({ changed: ['core/nested/deep.ts'], scope: scopeOf(['core/*.ts']) })
    expect(result.byCheck.scope.status).toBe('FAIL')
  })
})

describe('cell conformance: protected surfaces', () => {
  test('a workflow change is routed to owner review', async () => {
    const result = await run({ changed: ['.github/workflows/ci.yml'], scope: scopeOf(['.github/**']) })
    expect(result.byCheck.protected_surfaces.status).toBe('FAIL')
    expect(result.byCheck.protected_surfaces.evidence).toEqual(['.github/workflows/ci.yml'])
  })

  test('a launchd plist change is protected, which PR #918 showed was previously unclassified', async () => {
    const result = await run({
      changed: ['config/launchd/com.agent-comms.state-daemon.plist'],
      scope: scopeOf(['config/**']),
    })
    expect(result.byCheck.protected_surfaces.status).toBe('FAIL')
  })

  test('ordinary source paths touch no protected surface', async () => {
    const result = await run({ changed: ['core/a.ts', 'tests/a.test.ts'], scope: scopeOf(['core/**', 'tests/**']) })
    expect(result.byCheck.protected_surfaces.status).toBe('PASS')
  })

  test('a config declaring no protected_globs cannot determine the answer and fails', async () => {
    const config = { ...CONFIG, protected_globs: undefined }
    const result = await run({ changed: ['core/a.ts'], scope: scopeOf(['core/**']), config })
    expect(result.byCheck.protected_surfaces.status).toBe('FAIL')
  })
})

describe('cell conformance: test co-change is a file-level signal only', () => {
  test('changing source without touching any test fails', async () => {
    const result = await run({ changed: ['core/a.ts'], scope: scopeOf(['core/**']) })
    expect(result.byCheck.test_cochange.status).toBe('FAIL')
  })

  test('changing only documentation requires no test co-change', async () => {
    const result = await run({ changed: ['docs/a.md'], scope: scopeOf(['docs/**']) })
    expect(result.byCheck.test_cochange.status).toBe('PASS')
  })

  test('touching any test satisfies it, which is exactly why it is a weak signal', async () => {
    const result = await run({ changed: ['core/a.ts', 'tests/unrelated.test.ts'], scope: scopeOf(['core/**', 'tests/**']) })
    expect(result.byCheck.test_cochange.status).toBe('PASS')
  })
})

describe('cell conformance: body shape checks presence and emptiness, never substance', () => {
  test('a missing section fails', async () => {
    const result = await run({
      changed: ['core/a.ts', 'tests/a.test.ts'],
      scope: scopeOf(['core/**', 'tests/**']),
      body: 'CELL-ID: CELL-TEST-001\n\nsome text\n',
    })
    expect(result.byCheck.body_shape.status).toBe('FAIL')
  })

  test('a heading present but empty fails, which a plain includes() check cannot see', async () => {
    const result = await run({
      changed: ['core/a.ts', 'tests/a.test.ts'],
      scope: scopeOf(['core/**', 'tests/**']),
      body: 'CELL-ID: CELL-TEST-001\n\n## Allowed paths\n\n',
    })
    expect(result.byCheck.body_shape.status).toBe('FAIL')
    expect(result.byCheck.body_shape.evidence?.some((e) => e.startsWith('empty:'))).toBe(true)
  })

  test('sections present with content pass', async () => {
    const result = await run({
      changed: ['core/a.ts', 'tests/a.test.ts'],
      scope: scopeOf(['core/**', 'tests/**']),
      body: 'CELL-ID: CELL-TEST-001\n\n## Allowed paths\n\ncore/**, tests/**\n',
    })
    expect(result.byCheck.body_shape.status).toBe('PASS')
  })

  test('body_shape is skipped, not assumed, when no body is supplied', async () => {
    const result = await run({ changed: ['core/a.ts', 'tests/a.test.ts'], scope: scopeOf(['core/**', 'tests/**']) })
    expect(result.byCheck.body_shape.status).toBe('SKIP')
  })
})

describe('cell conformance: a fully conformant cell passes', () => {
  test('in scope, no protected surface, tests co-changed, body shaped', async () => {
    const result = await run({
      changed: ['core/a.ts', 'tests/a.test.ts'],
      scope: scopeOf(['core/**', 'tests/**']),
      body: 'CELL-ID: CELL-TEST-001\n\n## Allowed paths\n\ncore/**, tests/**\n',
    })
    expect(result.verdict).toBe('PASS')
    expect(result.exitCode).toBe(0)
  })
})

describe('standing authorization waiver: every condition must hold, undeterminable refuses', () => {
  const ID = 'OD-AUN-602-STANDING-MERGE-AND-NO-DRIFT-20260816-001'
  const URL = 'https://github.com/watchout/agent-comms-mcp/issues/602#issuecomment-5306783646'
  const citing = `Refs ${ID} published at ${URL}`

  const evaluate = async (over: Partial<{
    config: unknown; changedFiles: string[]; labels: Set<string>; body: string
  }> = {}) => {
    const { evaluateStandingAuthorization } = await import('../scripts/lib/cell-conformance.mjs')
    return evaluateStandingAuthorization({
      config: 'config' in over ? over.config : CONFIG,
      changedFiles: over.changedFiles ?? ['core/a.ts', 'tests/a.test.ts'],
      labels: over.labels ?? new Set<string>(),
      body: over.body ?? citing,
      decisionId: ID,
      decisionUrl: URL,
    })
  }

  test('a conformant, non-protected, non-breaking PR that cites the decision is waived', async () => {
    expect((await evaluate()).applies).toBe(true)
  })

  test('touching a protected surface refuses the waiver', async () => {
    const result = await evaluate({ changedFiles: ['.github/workflows/ci.yml'] })
    expect(result.applies).toBe(false)
    expect(result.reason).toContain('protected surface')
  })

  test('a launchd plist refuses the waiver', async () => {
    const result = await evaluate({ changedFiles: ['config/launchd/com.agent-comms.state-daemon.plist'] })
    expect(result.applies).toBe(false)
  })

  test('a breaking change refuses the waiver even when nothing protected is touched', async () => {
    const result = await evaluate({ labels: new Set(['breaking-change-verified']) })
    expect(result.applies).toBe(false)
    expect(result.reason).toContain('breaking-change-verified')
  })

  test('not citing the decision id refuses the waiver', async () => {
    const result = await evaluate({ body: `published at ${URL}` })
    expect(result.applies).toBe(false)
  })

  test('citing the id without the published URL refuses the waiver', async () => {
    const result = await evaluate({ body: `Refs ${ID}` })
    expect(result.applies).toBe(false)
  })

  test('an absent config refuses rather than assuming nothing is protected', async () => {
    const result = await evaluate({ config: null })
    expect(result.applies).toBe(false)
    expect(result.reason).toContain('absent')
  })

  test('a config with no protected_globs refuses rather than assuming', async () => {
    const result = await evaluate({ config: { ...CONFIG, protected_globs: undefined } })
    expect(result.applies).toBe(false)
  })
})
