export const DISCORD_BOT_BRIDGE_ENV = 'AGENT_COM_DISCORD_BOT_BRIDGE_IDS'

export type DiscordBotIngressDecision =
  | { accept: true; source: 'discord' | 'discord-bot-bridge'; reason: 'human' | 'allowlisted_bot_bridge' }
  | { accept: false; source: 'discord'; reason: 'bot_echo_blocked' }

export function parseDiscordBotBridgeIds(raw: string | undefined = process.env[DISCORD_BOT_BRIDGE_ENV]): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

export function decideDiscordBotIngress(
  msg: { author: { id: string; isBot: boolean } },
  allowlistedBotIds: Set<string> = parseDiscordBotBridgeIds(),
): DiscordBotIngressDecision {
  if (!msg.author.isBot) {
    return { accept: true, source: 'discord', reason: 'human' }
  }
  if (allowlistedBotIds.has(msg.author.id)) {
    return { accept: true, source: 'discord-bot-bridge', reason: 'allowlisted_bot_bridge' }
  }
  return { accept: false, source: 'discord', reason: 'bot_echo_blocked' }
}
