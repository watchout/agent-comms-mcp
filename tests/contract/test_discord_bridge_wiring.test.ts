import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')

const serverSource = readFileSync(join(REPO_ROOT, 'server.ts'), 'utf-8')
const inboundReceiverSource = readFileSync(join(REPO_ROOT, 'adapters/inbound-receiver.ts'), 'utf-8')

describe('Discord bridge wiring', () => {
  test('server gates bot-authored Discord ingress through bridge policy', () => {
    expect(serverSource).toContain("import { decideDiscordBotIngress } from './core/discord-bot-ingress-policy'")
    expect(serverSource).toContain('const botIngress = decideDiscordBotIngress(msg)')
    expect(serverSource).toContain('discord inbound bot echo blocked')
    expect(serverSource).toContain('source: botIngress.source')
  })

  test('inbound receiver persists source override', () => {
    expect(inboundReceiverSource).toContain('source?: string')
    expect(inboundReceiverSource).toContain('const source = params.source ?? platform')
    expect(inboundReceiverSource).toMatch(/source,\s*\n\s*thread_id/)
    expect(inboundReceiverSource).toMatch(/source,\s*\n\s*ts:/)
  })
})
