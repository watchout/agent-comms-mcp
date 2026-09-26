import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Exercise the exact exported function's source without starting an MCP.
// SC-2 startup acquisition is intentionally fatal for an unleased import.
const SERVER = resolve(import.meta.dir, '..', '..', 'server.ts')
const definitions=[...readFileSync(SERVER,'utf8').matchAll(/^export function parseLegacyGatewayEnv\([^]*?^}/gm)]
if(definitions.length!==1)throw new Error('LEGACY_GATEWAY_FUNCTION_SOURCE_AMBIGUOUS')

const SNIPPET = `
${definitions[0][0]}
const raw = process.env.PARSE_RAW === '__UNDEFINED__' ? undefined : process.env.PARSE_RAW
const result = parseLegacyGatewayEnv(raw)
process.stdout.write('<<RESULT>>' + JSON.stringify({ result }) + '<<END>>')
process.exit(0)
`

async function runCase(raw: string | undefined): Promise<{ result: boolean; stderr: string }> {
  const proc = Bun.spawn(['bun', '-e', SNIPPET], {
    env: {
      ...process.env,
      PARSE_RAW: raw === undefined ? '__UNDEFINED__' : raw,
      DISCORD_TOKEN: '',
      DISCORD_BOT_TOKEN: '',
      AGENT_COM_PG_NOTIFY: 'false',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  const match = stdout.match(/<<RESULT>>(.+?)<<END>>/s)
  if (!match) throw new Error(`no result marker in stdout:\n${stdout}\nstderr:\n${stderr}`)
  const { result } = JSON.parse(match[1])
  return { result, stderr }
}

const WARN_PREFIX = 'agent-comms: WARN invalid AGENT_COM_LEGACY_DISCORD_GATEWAY='

describe('parseLegacyGatewayEnv (6 case, spec v3 §3 / ADR-001 / PR #1)', () => {
  it('undefined → true, no WARN', async () => {
    const { result, stderr } = await runCase(undefined)
    expect(result).toBe(true)
    expect(stderr).not.toContain(WARN_PREFIX)
  }, 30_000)

  it("'1' → true, no WARN", async () => {
    const { result, stderr } = await runCase('1')
    expect(result).toBe(true)
    expect(stderr).not.toContain(WARN_PREFIX)
  }, 30_000)

  it("'0' → false, no WARN", async () => {
    const { result, stderr } = await runCase('0')
    expect(result).toBe(false)
    expect(stderr).not.toContain(WARN_PREFIX)
  }, 30_000)

  it("'true' → true (fallback), WARN stderr emitted", async () => {
    const { result, stderr } = await runCase('true')
    expect(result).toBe(true)
    expect(stderr).toContain(`${WARN_PREFIX}"true"`)
    expect(stderr).toContain('defaulting to 1 (enabled)')
  }, 30_000)

  it("'' (empty) → true (fallback), WARN stderr emitted", async () => {
    const { result, stderr } = await runCase('')
    expect(result).toBe(true)
    expect(stderr).toContain(`${WARN_PREFIX}""`)
    expect(stderr).toContain('defaulting to 1 (enabled)')
  }, 30_000)

  it("'2' → true (fallback), WARN stderr emitted", async () => {
    const { result, stderr } = await runCase('2')
    expect(result).toBe(true)
    expect(stderr).toContain(`${WARN_PREFIX}"2"`)
    expect(stderr).toContain('defaulting to 1 (enabled)')
  }, 30_000)
})
