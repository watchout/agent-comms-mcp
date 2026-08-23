import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8')
const cliSource = readFileSync(join(root, 'cli', 'index.ts'), 'utf8')

describe('runtime registration site contract', () => {
  test('server marks process-derived session and checkout as ambient observations', () => {
    expect(serverSource).toContain('ambientSessionName: ambientRuntimeSessionName')
    expect(serverSource).toContain('ambientCheckoutPath: ambientRuntimeCheckoutPath')
    expect(serverSource).not.toContain('checkoutPath: process.env.AGENT_COM_CHECKOUT_PATH ?? process.cwd()')
    expect(serverSource).not.toContain('sessionName: runtimeSessionName')
  })

  test('server logs incomplete registered profiles as typed records', () => {
    expect(serverSource).toContain('err instanceof RuntimeRegistrationProfileError')
    expect(serverSource).toContain('JSON.stringify(err.toJSON())')
  })

  test('CLI heartbeat also marks local environment values as ambient observations', () => {
    expect(cliSource).toContain("ambientSessionName: flags['session-name'] ?? inferRuntimeSessionName()")
    expect(cliSource).toContain('ambientCheckoutPath: process.env.AGENT_COM_CHECKOUT_PATH ?? process.cwd()')
  })
})
