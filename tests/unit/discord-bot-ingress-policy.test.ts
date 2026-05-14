import { describe, test, expect } from 'bun:test'
import {
  decideDiscordBotIngress,
  parseDiscordBotBridgeIds,
} from '../../core/discord-bot-ingress-policy'

describe('discord bot ingress policy', () => {
  test('human Discord messages are accepted as normal discord ingress', () => {
    expect(decideDiscordBotIngress(
      { author: { id: 'human-1', isBot: false } },
      new Set(),
    )).toEqual({ accept: true, source: 'discord', reason: 'human' })
  })

  test('bot-authored Discord messages are blocked by default', () => {
    expect(decideDiscordBotIngress(
      { author: { id: 'bot-1', isBot: true } },
      new Set(),
    )).toEqual({ accept: false, source: 'discord', reason: 'bot_echo_blocked' })
  })

  test('allowlisted bot-authored messages enter as discord-bot-bridge', () => {
    expect(decideDiscordBotIngress(
      { author: { id: 'bot-1', isBot: true } },
      new Set(['bot-1']),
    )).toEqual({ accept: true, source: 'discord-bot-bridge', reason: 'allowlisted_bot_bridge' })
  })

  test('allowlist parser trims blanks and comma-separated ids', () => {
    expect([...parseDiscordBotBridgeIds(' bot-1,bot-2, ,bot-3 ')]).toEqual(['bot-1', 'bot-2', 'bot-3'])
  })
})
